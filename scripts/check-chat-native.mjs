import { _android } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile), credentials = JSON.parse(await readFile('private/access.json', 'utf8'));
const sshTarget = process.env.STUDIO_SSH_TARGET;
if (!sshTarget) throw new Error('Set STUDIO_SSH_TARGET for own test-directory cleanup');
const device = (await _android.devices()).find(item => item.serial() === 'emulator-5554'); assert.ok(device, 'Project emulator required');
const records = [], checks = []; let token;
const originalIme = (await device.shell('settings get secure show_ime_with_hard_keyboard')).toString().trim();
const call = async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(credentials.url + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.ok(response.ok, 'HTTP ' + response.status); return data;
};
const keyboardShown = async () => /mInputShown=true|isInputViewShown=true/.test((await device.shell('dumpsys input_method')).toString());
const hideKeyboard = async page => { if (await keyboardShown()) await device.shell('input keyevent KEYCODE_BACK'); else await page.evaluate(() => document.activeElement?.blur()); };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  await device.shell('settings put secure show_ime_with_hard_keyboard 1');
  ({ token } = await call('/api/login', credentials));
  await device.shell('am force-stop xyz.leechyi.compileverse'); await device.shell('am start -n xyz.leechyi.compileverse/.MainActivity');
  const page = await (await device.webView({ pkg: 'xyz.leechyi.compileverse' })).page();
  page.setDefaultTimeout(25000); await page.getByRole('heading', { name: '工作，随时接续。' }).waitFor();
  for (const group of await page.locator('.provider-card-group').all()) assert.ok(await group.evaluate(node => { const box = node.getBoundingClientRect(), button = node.querySelector('.provider-settings').getBoundingClientRect(); return Math.abs((box.top + box.bottom - button.top - button.bottom) / 2) < 1; }));
  checks.push('agent settings vertically centered');
  for (const provider of ['claude', 'codex']) {
    const name = '会话验收-' + Date.now() + '-' + provider;
    const item = await call('/api/conversations', { provider, projectName: name, title: name, cwd: { root: 'inputs', path: '' }, createDirectory: true }); records.push(item);
    const details = await call('/api/cloud/providers/sessions/' + item.sessionId); item.projectId = details.data.project.projectId;
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await page.locator('.conversation-open').filter({ hasText: name }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('已连接', { exact: false }).first().waitFor();
    assert.equal(await page.getByRole('navigation', { name: '主导航' }).count(), 0);
    assert.equal(await page.locator('.composer-wrap .session-token-button').count(), 0);
    assert.equal(await page.locator('.chat-heading .session-token-button').count(), 1);
    const draft = '保留草稿-' + provider;
    await page.getByLabel('给 AI 的消息').fill(draft);
    await device.shell('uiautomator dump /data/local/tmp/roamdeck-chat-ui.xml');
    const hierarchy = (await device.shell('cat /data/local/tmp/roamdeck-chat-ui.xml')).toString();
    const webview = hierarchy.match(/<node[^>]+class="android.webkit.WebView"[^>]+>/)?.[0];
    const bounds = webview?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    assert.ok(bounds, 'Native WebView bounds missing');
    const fieldPoint = await page.getByLabel('给 AI 的消息').evaluate((node, coordinates) => { const box = node.getBoundingClientRect(), [left, top, right] = coordinates; const scale = (right - left) / innerWidth; return { x: Math.round(left + (box.left + box.width / 2) * scale), y: Math.round(top + (box.top + box.height / 2) * scale) }; }, bounds.slice(1).map(Number));
    await device.shell(`input tap ${fieldPoint.x} ${fieldPoint.y}`);
    for (let attempt = 0; attempt < 20 && !await keyboardShown(); attempt++) await page.waitForTimeout(100);
    assert.equal(await keyboardShown(), true, 'Android keyboard did not actually open');
    await page.waitForTimeout(350);
    const visible = await page.locator('.composer').evaluate(node => { const box = node.getBoundingClientRect(), v = visualViewport; return box.bottom <= (v?.height ?? innerHeight) + (v?.offsetTop ?? 0) + 2; });
    assert.equal(visible, true, 'Composer is covered by keyboard');
    await hideKeyboard(page);
    await page.getByRole('button', { name: '会话信息', exact: true }).click();
    await page.getByRole('button', { name: '重命名 / 管理会话', exact: true }).click();
    await page.getByRole('button', { name: '重命名会话', exact: true }).click();
    const renamed = name + '-新名称';
    await page.getByLabel('会话名称', { exact: true }).fill(renamed);
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('heading', { name: renamed, exact: true }).waitFor();
    assert.equal(await page.getByLabel('给 AI 的消息').inputValue(), draft);
    await hideKeyboard(page);
    await page.getByRole('button', { name: '查看本会话 Token 与额度', exact: true }).click();
    await page.getByRole('dialog', { name: '额度与 Token' }).waitFor();
    await page.getByRole('dialog', { name: '额度与 Token' }).getByRole('button', { name: '关闭', exact: true }).click();
    await device.screenshot({ path: 'artifacts/native-chat-' + provider + '-revision10.png' });
    const saved = await call('/api/conversations/' + item.sessionId); assert.equal(saved.sessionTitle, renamed); assert.equal(saved.projectPath, item.projectPath);
    if (provider === 'codex') {
      await call('/api/cloud/providers/sessions/' + item.sessionId + '?force=true&deletedFromDisk=true', undefined, 'DELETE');
      assert.equal((await call('/api/conversations/' + item.sessionId)).sessionTitle, renamed);
      checks.push('owned Codex resolves after its upstream test catalog row is removed');
    }
    await device.shell('input keyevent KEYCODE_BACK');
    await page.getByRole('navigation', { name: '主导航' }).waitFor();
    checks.push(provider + ': no chat nav/footer quota row; keyboard fit; rename keeps draft/ID/path; header usage; back restores nav');
  }
  const report = { passed: true, platform: 'Android16 ARM64 emulator / real server metadata; no model inference', checks, realPhoneTested: false };
  await writeFile('artifacts/chat-revision10-native-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  await device.shell('am force-stop xyz.leechyi.compileverse').catch(() => {});
  for (const item of records) {
    await call('/api/conversations/' + item.sessionId, undefined, 'DELETE').catch(() => {});
    if (item.projectId) await call('/api/cloud/projects/' + encodeURIComponent(item.projectId), undefined, 'DELETE').catch(() => {});
    if (/\/会话验收-[0-9]+-(claude|codex)$/.test(item.projectPath)) await exec('ssh', ['-o', 'BatchMode=yes', sshTarget, 'rmdir -- ' + quote(item.projectPath)]).catch(() => {});
  }
  await device.shell('rm -f /data/local/tmp/roamdeck-chat-ui.xml').catch(() => {});
  if (['0', '1'].includes(originalIme)) await device.shell('settings put secure show_ime_with_hard_keyboard ' + originalIme).catch(() => {});
  else await device.shell('settings delete secure show_ime_with_hard_keyboard').catch(() => {});
  await device.close();
}
