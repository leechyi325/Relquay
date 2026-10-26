import { _android } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const pkg = 'xyz.leechyi.compileverse', device = (await _android.devices()).find(item => item.serial() === 'emulator-5554');
assert.ok(device, 'Dedicated project emulator required');
const credentials = JSON.parse(await readFile('private/access.json', 'utf8')), checks = [], jobs = [];
const login = await fetch(credentials.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
assert.equal(login.status, 200); const { token } = await login.json();
const api = async (url, body, method = body ? 'POST' : 'GET') => { const res = await fetch(credentials.url + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.ok(res.ok, 'Fixture API ' + res.status); return res.json(); };
async function poll(test, timeout = 50000) { const end = Date.now() + timeout; do { const result = await test(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 700)); } while (Date.now() < end); throw new Error('Native status timeout'); }
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let page;
const start = async () => { await device.shell(`am start -n ${pkg}/.MainActivity`); page = await (await device.webView({ pkg })).page(); page.setDefaultTimeout(20000); await page.getByRole('button', { name: '打开提醒中心', exact: true }).waitFor(); };
const status = () => page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.status());
const configure = enabled => page.evaluate(({ enabled, origin }) => window.Capacitor.Plugins.StudioNotifications.configure({ enabled, approvals: true, completions: true, servers: [{ origin, name: 'Oracle 工作机' }] }), { enabled, origin: credentials.url });
async function setChannel(enabled) {
  if ((await status()).alertsPermission === enabled) return;
  await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.openAlertSettings());
  await new Promise(resolve => setTimeout(resolve, 500));
  await device.shell('uiautomator dump /data/local/tmp/roamdeck-health.xml');
  const xml = (await device.shell('cat /data/local/tmp/roamdeck-health.xml')).toString();
  const toggle = xml.match(/<node[^>]+>/g)?.find(node => node.includes('checkable="true"') && node.includes('checked="' + !enabled + '"'));
  assert.ok(toggle, 'Current notification channel system switch');
  const bounds = toggle.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
  await device.shell(`input tap ${Math.round((bounds[0]+bounds[2])/2)} ${Math.round((bounds[1]+bounds[3])/2)}`);
  await device.shell('input keyevent KEYCODE_BACK');
  await poll(async () => (await status()).alertsPermission === enabled);
}

try {
  await start(); await setChannel(true); await configure(true); await poll(async () => (await status()).running);
  await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.testNotification());
  assert.ok((await device.shell('dumpsys notification')).toString().includes('tag=roamdeck.test'));
  checks.push('test notification posted through the same task/approval channel');
  await device.shell(`am force-stop ${pkg}`); await start();
  await poll(async () => (await status()).running); checks.push('previously user-enabled monitoring resumes on explicit App reopen after process stop');
  await page.getByRole('button', { name: '打开提醒中心', exact: true }).click();
  await page.getByRole('button', { name: '后台提醒设置', exact: true }).click();
  await setChannel(false);
  assert.equal((await status()).permission, true); assert.equal((await status()).running, true);
  await page.getByText('常驻监听与任务提醒是两个频道，当前任务提醒已关闭。').waitFor();
  let rejected = false; try { await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.testNotification()); } catch { rejected = true; }
  assert.ok(rejected); checks.push('blocked alert channel detected while global permission and ongoing monitor remain enabled; test action reports error');
  await setChannel(true);
  await configure(false); await poll(async () => !(await status()).running); await device.shell(`am force-stop ${pkg}`);
  // Reproduce a completion between user enabling and the first successful sync.
  // Only this isolated emulator's metadata preferences are changed, never tokens.
  let prefs = (await device.shell(`run-as ${pkg} cat shared_prefs/studio_notifications.xml`)).toString();
  prefs = prefs.replace(/\s*<long name="(?:cursor|since):[^\"]*" value="[^\"]*"\s*\/>/g, '').replace('<boolean name="enabled" value="false" />', '<boolean name="enabled" value="true" />');
  prefs = prefs.replace('</map>', `<long name="since:${credentials.url}" value="${Date.now() - 1000}" /></map>`);
  const encoded = Buffer.from(prefs).toString('base64');
  await device.shell(`run-as ${pkg} sh -c ${quote('echo ' + encoded + ' | base64 -d > shared_prefs/studio_notifications.xml')}`);
  const oldCompletions = (await api('/api/notifications')).items.filter(item => !['approval', 'question'].includes(item.type)).map(item => item.id);
  const job = await api('/api/jobs', { title: '首次同步提醒回归 ' + Date.now(), command: 'echo roamdeck-first-sync', cwd: { root: 'inputs', path: '' } }); jobs.push(job.id);
  await poll(async () => (await api('/api/jobs')).find(item => item.id === job.id)?.status === 'succeeded');
  const notice = (await api('/api/notifications')).items.find(item => item.jobId === job.id); assert.ok(notice);
  await start();
  await poll(async () => (await status()).alerts.some(item => item.eventId === notice.id));
  assert.ok(!(await status()).alerts.some(item => oldCompletions.includes(item.eventId)));
  checks.push('completion after enable but before first sync is delivered; old completion backlog stays suppressed');
  await device.screenshot({ path: 'artifacts/native-notification-health.png' });
  await configure(false); await poll(async () => !(await status()).running);
  await device.shell(`am force-stop ${pkg}`); await start(); assert.equal((await status()).running, false);
  checks.push('explicitly paused monitor stays paused after App restart');
  await writeFile('artifacts/native-notification-health-report.json', JSON.stringify({ passed: true, checks, device: 'Dedicated Android16 ARM64 emulator; public HTTPS; own job only; no AI inference' }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  if (page && !page.isClosed()) { await setChannel(true).catch(() => {}); await configure(false).catch(() => {}); }
  for (const id of jobs) {
    const notices = await api('/api/notifications').catch(() => ({ items: [] }));
    for (const item of notices.items.filter(item => item.jobId === id)) await api('/api/notifications/' + item.id + '/read', {}).catch(() => {});
    await api('/api/jobs/' + id, undefined, 'DELETE').catch(() => {});
  }
  await device.shell('rm -f /data/local/tmp/roamdeck-health.xml'); await device.close();
}
