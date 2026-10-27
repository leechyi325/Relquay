import { _android } from 'playwright';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const pkg = 'xyz.leechyi.compileverse', baseline = process.env.STUDIO_IME_BASELINE === '1';
const device = (await _android.devices()).find(item => item.serial() === 'emulator-5554'); assert.ok(device, 'Dedicated emulator required');
device.setDefaultTimeout(25000);
const imeSetting = (await device.shell('settings get secure show_ime_with_hard_keyboard')).toString().trim();
const checks = [], measures = [], writes = [];
const longSource = '# source-editor fixture\n' + Array.from({ length: 60 }, (_, i) => '# line ' + (i + 1) + ' 仅作键盘回归').join('\n') + '\nmodel = "native-source-fixture"\n';
let content = '# initial fixture\nmodel = "initial-configuration"\n', revision = 'a'.repeat(64), page;
const keyboardShown = async () => /mInputShown=true|isInputViewShown=true/.test((await device.shell('dumpsys input_method')).toString());
async function poll(test, timeout = 20000) { const end = Date.now() + timeout; do { const result = await test(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 300)); } while (Date.now() < end); throw new Error('Native predicate timed out'); }
const hideKeyboard = async () => { if (await keyboardShown()) await device.shell('input keyevent KEYCODE_BACK'); else await page.evaluate(() => document.activeElement?.blur()); };
async function showKeyboard(input) {
  await input.scrollIntoViewIfNeeded(); await input.focus();
  try { await poll(keyboardShown, 2500); return; } catch { /* Native tap fallback for WebView focus without IME. */ }
  await device.shell('uiautomator dump /data/local/tmp/roamdeck-config-keyboard.xml');
  const xml = (await device.shell('cat /data/local/tmp/roamdeck-config-keyboard.xml')).toString();
  await writeFile('.runtime/config-keyboard-ui.xml', xml);
  const webview = xml.match(/<node[^>]+class="android.webkit.WebView"[^>]+>/)?.[0];
  const bounds = webview?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/); assert.ok(bounds);
  const point = await input.evaluate((node, bounds) => { const box = node.getBoundingClientRect(), [left, top, right] = bounds, scale = (right - left) / innerWidth; return { x: Math.round(left + (box.left + box.width/2)*scale), y: Math.round(top + (box.top + box.height/2)*scale) }; }, bounds.slice(1).map(Number));
  await device.shell(`input tap ${point.x} ${point.y}`); await poll(keyboardShown); await page.waitForTimeout(350);
}
async function measure(input, label) {
  const value = await input.evaluate(node => { const input = node.getBoundingClientRect(), actions = document.querySelector('.agent-config-section .interaction-actions').getBoundingClientRect(), v = visualViewport; return { keyboardViewport: v.height, editorTop: input.top, editorBottom: input.bottom, actionsTop: actions.top, actionsBottom: actions.bottom, overlap: Math.max(0, Math.min(input.bottom, actions.bottom, v.height + v.offsetTop) - Math.max(input.top, actions.top, v.offsetTop)), position: getComputedStyle(document.querySelector('.agent-config-section .interaction-actions')).position }; });
  measures.push({ label, ...value }); return value;
}
try {
  console.log('native-check: starting');
  await device.shell('settings put secure show_ime_with_hard_keyboard 1');
  await device.shell(`am force-stop ${pkg}`); await device.shell(`am start -n ${pkg}/.MainActivity`);
  console.log('native-check: activity launched');
  page = await (await device.webView({ pkg })).page();
  console.log('native-check: webview attached'); page.setDefaultTimeout(25000);
  await page.route('**/api/agents/codex/config', async route => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); content = body.content; revision = 'b'.repeat(64); writes.push(body.content); }
    await route.fulfill({ headers: { 'access-control-allow-origin': route.request().headers().origin || 'https://localhost', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, PUT, OPTIONS' }, contentType: 'application/json', body: JSON.stringify({ provider: 'codex', path: '/home/ubuntu/.codex/config.toml', content, revision, exists: true }) });
  });
  // All config traffic in this test WebView is intercepted; no real AI config is read or written.
  await page.getByRole('button', { name: 'Codex 设置', exact: true }).click(); console.log('native-check: config opened');
  if (!baseline) {
    const model = page.getByLabel('默认模型 ID'); await model.fill('native-guided-fixture'); await showKeyboard(model);
    assert.equal((await measure(model, 'guided with actual IME')).overlap, 0);
    assert.equal(await model.inputValue(), 'native-guided-fixture'); await device.screenshot({ path: 'artifacts/native-config-guided-keyboard.png' });
    await hideKeyboard(); await page.getByRole('button', { name: '源码编辑', exact: true }).click();
  }
  const editor = page.getByLabel('代理配置内容'); await editor.fill(longSource); await showKeyboard(editor); await editor.press('Control+End');
  const measured = await measure(editor, baseline ? '0.4.4 sticky baseline' : '0.4.5 source IME');
  await page.locator('.sheet').evaluate(node => { node.scrollTop = Math.max(0, node.scrollTop - 100); });
  const scrolled = await measure(editor, baseline ? '0.4.4 after scrolling up while editing' : '0.4.5 after scrolling up while editing');
  await device.screenshot({ path: 'artifacts/native-config-source-keyboard' + (baseline ? '-baseline' : '') + '.png' });
  if (!baseline) {
    assert.equal(measured.overlap, 0); assert.equal(scrolled.overlap, 0); assert.equal(measured.position, 'static'); assert.equal(await editor.inputValue(), longSource);
    checks.push('real Android IME shown in guided and source editors; actions do not overlay either input; long draft retained');
    await hideKeyboard(); await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await poll(() => writes.length === 1); await page.getByText('配置已保存；如未生效，请重启对应代理', { exact: true }).waitFor(); assert.equal(writes[0], longSource);
    checks.push('explicit save submits the exact fixture draft; no production configuration writes');
    await page.getByRole('dialog', { name: 'Codex 设置' }).getByRole('button', { name: '关闭', exact: true }).click();
    const snapshots = { 'native-stat-codex': { provider: 'codex', scope: 'thread', totalTokens: 1250, inputTokens: 1000, outputTokens: 250, source: 'Native fixture', updatedAt: new Date().toISOString() }, 'native-stat-claude': { provider: 'claude', scope: 'context', contextTokens: 8500, source: 'Native fixture', updatedAt: new Date().toISOString() } };
    const fulfill = (route, data) => route.fulfill({ headers: { 'access-control-allow-origin': route.request().headers().origin || 'https://localhost', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, PUT, OPTIONS' }, contentType: 'application/json', body: JSON.stringify(data) });
    await page.route('**/api/usage/accounts', route => fulfill(route, { accounts: [{ provider: 'codex', windows: [], status: 'partial', lifetimeTokens: 125000, source: 'Native fixture', updatedAt: new Date().toISOString() }] }));
    await page.route('**/api/usage/sessions**', route => {
      const url = new URL(route.request().url()), id = url.pathname.split('/').at(-1);
      if (id !== 'sessions') return fulfill(route, { snapshot: snapshots[id] ?? null });
      return fulfill(route, { total: 2, hasMore: false, items: Object.entries(snapshots).map(([sessionId, snapshot]) => ({ sessionId, provider: snapshot.provider, title: snapshot.provider + ' 原生统计测试', projectName: '测试项目', snapshot })) });
    });
    await page.getByRole('button', { name: '工作台设置', exact: true }).last().click();
    await page.getByRole('button', { name: '额度与 Token', exact: true }).click();
    const usage = page.getByRole('dialog', { name: '额度与 Token' });
    await usage.locator('.account-token-details').waitFor(); assert.equal(await usage.locator('details[open]').count(), 0); assert.equal(await usage.getByText('125,000', { exact: true }).isVisible(), false);
    await usage.locator('.session-usage-disclosure>summary').click(); await usage.getByRole('group', { name: '选择统计会话' }).getByRole('button', { name: /codex 原生统计测试/ }).click();
    await usage.getByRole('region', { name: '所选会话统计' }).getByText('1,250', { exact: true }).waitFor();
    await usage.getByRole('group', { name: '选择统计会话' }).getByRole('button', { name: /claude 原生统计测试/ }).click();
    await usage.getByRole('region', { name: '所选会话统计' }).getByText('8,500', { exact: true }).waitFor();
    checks.push('native default-collapsed Token sections and per-session cumulative/context selection');
    await device.screenshot({ path: 'artifacts/native-session-usage.png' });
  }
  await writeFile('artifacts/config-usage-native' + (baseline ? '-baseline' : '') + '-report.json', JSON.stringify({ passed: true, baseline, checks, measures, device: 'Dedicated Android16 ARM64 emulator; intercepted fixture config and usage only; no inference or personal-phone claim' }, null, 2));
  console.log(JSON.stringify({ passed: true, baseline, checks, measures }));
} finally {
  await device.shell(`am force-stop ${pkg}`).catch(() => {});
  if (['0', '1'].includes(imeSetting)) await device.shell('settings put secure show_ime_with_hard_keyboard ' + imeSetting); else await device.shell('settings delete secure show_ime_with_hard_keyboard');
  await device.shell('rm -f /data/local/tmp/roamdeck-config-keyboard.xml'); await device.close();
}
