import { _android } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const credentials = JSON.parse(await readFile('private/access.json', 'utf8'));
const devices = await _android.devices(); let device = devices.find(device => device.serial() === 'emulator-5554');
if (!device) throw new Error('Dedicated Android emulator required');
const pkg = 'xyz.leechyi.compileverse', origin = credentials.url, checks = [];
// Playwright 1.56 waitForFunction treats a Promise as truthy before its value resolves.
// Await native/network predicates in Node so false/undefined really keep waiting.
async function poll(check, timeout = 50000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error('Timed out waiting for the actual native/network state');
}
async function tapSystem(attribute, value, screenshot) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await device.shell('uiautomator dump /data/local/tmp/roamdeck-notification-ui.xml');
    const xml = (await device.shell('cat /data/local/tmp/roamdeck-notification-ui.xml')).toString();
    const node = xml.match(/<node[^>]+>/g)?.find(node => node.includes(`${attribute}="${value}"`));
    const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (bounds) { if (screenshot) await device.screenshot({ path: screenshot }); const [, x1, y1, x2, y2] = bounds.map(Number); await device.shell(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`); return; }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error('System control not visible: ' + value);
}
try {
  device.setDefaultTimeout(25000);
  await device.shell(`am force-stop ${pkg}`); await device.shell(`pm revoke ${pkg} android.permission.POST_NOTIFICATIONS`);
  await device.shell(`am start -n ${pkg}/.MainActivity`);
  const view = await device.webView({ pkg }); let page = await view.page();
  page.setDefaultTimeout(25000); await page.waitForTimeout(700);
  if (await page.getByRole('button', { name: '进入工作台', exact: true }).isVisible()) { await page.getByLabel('密码', { exact: true }).fill(credentials.password); await page.getByRole('button', { name: '进入工作台', exact: true }).click(); }
  await page.getByRole('button', { name: '打开提醒中心', exact: true }).waitFor();
  await poll(() => page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.status().then(value => !value.alerts.length)));
  let status = await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.status()); assert.equal(status.permission, false); assert.equal(status.running, false); checks.push('permission denied state');
  await page.getByRole('button', { name: '打开提醒中心', exact: true }).click(); await page.getByRole('button', { name: '后台提醒设置', exact: true }).click();
  await page.getByRole('button', { name: '开启后台提醒', exact: true }).click();
  await tapSystem('resource-id', 'com.android.permissioncontroller:id/permission_allow_button');
  await page.getByRole('heading', { name: '提醒监听已开启', exact: true }).waitFor();
  await poll(() => page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.status().then(value => value.serversStatus.some(server => server.origin === localStorage.getItem('studio.origin') && server.syncedAt))));
  checks.push('user enabled monitor and Android permission dialog');
  await device.screenshot({ path: 'artifacts/native-notification-settings.png' });
  // Scope all network operations to this logged in server, returning only the fixture job ID.
  const jobId = await page.evaluate(async () => {
    const origin = localStorage.getItem('studio.origin'), { token } = await window.Capacitor.Plugins.StudioCredentials.get({ key: origin });
    const response = await fetch(origin + '/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '通知验收 ' + Date.now(), command: 'sleep 3; echo roamdeck-notification-fixture', cwd: { root: 'inputs', path: '' } }) });
    if (!response.ok) throw new Error('Fixture job submission failed'); return (await response.json()).id;
  });
  await device.shell('input keyevent KEYCODE_HOME');
  // Read only this application's notification metadata via its own diagnostic interface.
  const eventId = await poll(() => page.evaluate(async jobId => {
    const origin = localStorage.getItem('studio.origin'), { token } = await window.Capacitor.Plugins.StudioCredentials.get({ key: origin });
    const page = await (await fetch(origin + '/api/notifications', { headers: { Authorization: 'Bearer ' + token } })).json(); return page.items.find(item => item.jobId === jobId)?.id;
  }, jobId));
  const alert = await poll(() => page.evaluate(id => window.Capacitor.Plugins.StudioNotifications.status().then(value => value.alerts.find(alert => alert.eventId === id) || false), eventId));
  assert.equal(alert.eventId, eventId); assert.equal(alert.origin, origin); checks.push('system task completion notification while app in background');
  await device.shell('cmd statusbar expand-notifications');
  await tapSystem('text', '后台任务已完成', 'artifacts/native-notification-shade.png');
  await page.waitForFunction(() => document.querySelector('.job-log')?.textContent?.includes('roamdeck-notification-fixture')); checks.push('notification tap opens the exact task log');
  const id = await page.evaluate(async (eventId) => { const origin = localStorage.getItem('studio.origin'), { token } = await window.Capacitor.Plugins.StudioCredentials.get({ key: origin }); return (await (await fetch(origin + '/api/notifications/' + eventId, { headers: { Authorization: 'Bearer ' + token } })).json()).jobId; }, alert.eventId);
  assert.equal(id, jobId);
  await device.screenshot({ path: 'artifacts/native-notification-target.png' });
  // Stopping and restarting must retain each cursor, without replaying the completed task.
  await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.configure({ enabled: false, approvals: true, completions: true, servers: [{ origin: localStorage.getItem('studio.origin'), name: '验收服务器' }] }));
  await poll(() => page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.status().then(value => !value.running)));
  await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.configure({ enabled: true, approvals: true, completions: true, servers: [{ origin: localStorage.getItem('studio.origin'), name: '验收服务器' }] }));
  await page.waitForTimeout(18000);
  status = await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.status()); assert.ok(!status.alerts.some(item => item.eventId === alert.eventId)); checks.push('pause/resume cursor survives without repeat notification');
  const coldJob = await page.evaluate(async () => {
    const origin = localStorage.getItem('studio.origin'), { token } = await window.Capacitor.Plugins.StudioCredentials.get({ key: origin });
    const response = await fetch(origin + '/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '冷启动通知验收 ' + Date.now(), command: 'sleep 3; echo roamdeck-cold-open-fixture', cwd: { root: 'inputs', path: '' } }) });
    if (!response.ok) throw new Error('Cold launch fixture failed'); return (await response.json()).id;
  });
  await device.shell('input keyevent KEYCODE_HOME');
  const coldId = await poll(() => page.evaluate(async id => { const origin = localStorage.getItem('studio.origin'), { token } = await window.Capacitor.Plugins.StudioCredentials.get({ key: origin }); const data = await (await fetch(origin + '/api/notifications', { headers: { Authorization: 'Bearer ' + token } })).json(); return data.items.find(item => item.jobId === id)?.id; }, coldJob));
  await poll(() => page.evaluate(id => window.Capacitor.Plugins.StudioNotifications.status().then(value => value.alerts.some(item => item.eventId === id)), coldId));
  // Finish the activity/WebView while the native foreground monitor remains alive.
  await page.evaluate(() => window.Capacitor.Plugins.App.exitApp()).catch(() => {});
  // AndroidWebView.page() caches the old page for the same process; reconnect the test client.
  await device.close(); device = (await _android.devices()).find(device => device.serial() === 'emulator-5554'); device.setDefaultTimeout(25000);
  await device.shell('cmd statusbar expand-notifications');
  await tapSystem('text', '后台任务已完成');
  page = await (await device.webView({ pkg })).page(); page.setDefaultTimeout(25000);
  await page.waitForFunction(() => document.querySelector('.job-log')?.textContent?.includes('roamdeck-cold-open-fixture'));
  checks.push('cold Activity/WebView notification tap restores login and exact task');
  await device.screenshot({ path: 'artifacts/native-notification-cold-target.png' });
  const prefs = (await device.shell(`run-as ${pkg} cat shared_prefs/studio_notifications.xml`)).toString(); assert.ok(!prefs.includes('Bearer') && !prefs.includes(credentials.password)); checks.push('monitor preferences contain no login credentials');
  await page.evaluate(() => window.Capacitor.Plugins.StudioNotifications.configure({ enabled: false, approvals: true, completions: true, servers: [{ origin: localStorage.getItem('studio.origin'), name: 'Oracle 工作机' }] }));
  await writeFile('artifacts/native-notifications-report.json', JSON.stringify({ passed: true, checks, device: 'Isolated Android 16 ARM64 emulator; real HTTPS gateway and fixture job; no model inference', jobId, coldJobId: coldJob }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally { await device.close(); }
