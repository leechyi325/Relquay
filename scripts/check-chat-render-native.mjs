import { _android } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const credentials = JSON.parse(await readFile('private/access.json', 'utf8')), exec = promisify(execFile), pkg = 'xyz.leechyi.compileverse';
assert.ok(process.env.STUDIO_SSH_TARGET, 'Own directory cleanup requires STUDIO_SSH_TARGET');
const device = (await _android.devices()).find(value => value.serial() === 'emulator-5554'); assert.ok(device, 'Dedicated emulator required');
const login = await fetch(credentials.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
assert.equal(login.status, 200); const { token } = await login.json();
const call = async (url, body, method = body ? 'POST' : 'GET') => { const response = await fetch(credentials.url + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.ok(response.ok, 'Own fixture API ' + response.status); return response.json(); };
const name = '界面回归-' + Date.now(); let item, projectId;
try {
  item = await call('/api/conversations', { provider: 'codex', title: name, projectName: name, cwd: { root: 'inputs', path: '' }, createDirectory: true });
  projectId = (await call('/api/cloud/providers/sessions/' + item.sessionId)).data.project.projectId;
  await device.shell(`am start -n ${pkg}/.MainActivity`);
  const page = await (await device.webView({ pkg })).page(); page.setDefaultTimeout(20000);
  // Intercept only our disposable session's history on this test WebView.
  // The public gateway/socket are real; transcript fixtures are explicitly not AI inference.
  const markdown = '# 移动端排版测试\n\n**重点**\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 已显示 |\n\n- [x] 检查完成\n\n```bash\necho "中文复制"\nprintf "第二行"\n```';
  await page.route('**/api/cloud/providers/sessions/' + item.sessionId + '/messages?*', async route => {
    const earlier = new URL(route.request().url()).searchParams.has('offset');
    const messages = earlier ? [{ id: 'older', kind: 'text', role: 'assistant', content: '这是更早消息测试' }] : [
      { id: 'reason-start', kind: 'thinking', itemId: 'r1', mode: 'delta', content: '思考开头。\n\n' },
      { id: 'reason-end', kind: 'thinking', itemId: 'r1', mode: 'delta', content: '完整中间内容。'.repeat(180) + '\n\n思考末尾。' },
      { id: 'text', kind: 'text', role: 'assistant', content: markdown },
    ];
    await route.fulfill({ headers: { 'access-control-allow-origin': route.request().headers().origin || 'https://localhost', 'access-control-allow-credentials': 'true' }, contentType: 'application/json', body: JSON.stringify({ success: true, data: { messages, hasMore: !earlier, nextOffset: earlier ? 4 : 3 } }) });
  });
  await page.getByRole('button', { name: '刷新工作台', exact: true }).click();
  await page.locator('.conversation-open').filter({ hasText: name }).click();
  await page.getByRole('heading', { name: '移动端排版测试', exact: true }).waitFor();
  await page.locator('.chat-heading').getByText('已连接', { exact: false }).waitFor();
  assert.equal(await page.locator('.chat-scroll table tbody tr').count(), 1);
  assert.equal(await page.locator('.chat-scroll input[type=checkbox]:checked').count(), 1);
  const thinking = page.locator('.thinking-event'); assert.equal(await thinking.count(), 1); assert.equal(await thinking.getAttribute('open'), null);
  await thinking.locator('summary').click(); assert.match(await thinking.innerText(), /思考开头/); assert.match(await thinking.innerText(), /思考末尾/);
  assert.equal(await thinking.locator('.thinking-content').evaluate(node => node.scrollHeight === node.clientHeight), true);
  await thinking.locator('summary').click();
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await page.getByRole('button', { name: '复制代码', exact: true }).filter({ hasText: '已复制' }).waitFor();
  await page.locator('.chat-code').scrollIntoViewIfNeeded(); await device.screenshot({ path: 'artifacts/native-chat-markdown-revision11.png' });
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await page.getByText('这是更早消息测试', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '加载更早的消息', exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await writeFile('artifacts/native-chat-render-revision11-report.json', JSON.stringify({ passed: true, checks: ['native GFM heading/table/task list', 'long thinking folds without clipping either end', 'code copy reports success', 'earlier transcript loads without resetting conversation', 'no horizontal page overflow'], source: 'Android16 ARM64 WebView, real public session/socket, explicitly intercepted fixture transcript; no model inference' }, null, 2));
  console.log('Native Markdown/thinking/history fixture passed');
} finally {
  if (item) {
    await call('/api/conversations/' + item.sessionId, undefined, 'DELETE').catch(() => {});
    if (projectId) await call('/api/cloud/projects/' + encodeURIComponent(projectId), undefined, 'DELETE').catch(() => {});
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    if (item.projectPath.endsWith('/' + name)) await exec('ssh', ['-o', 'BatchMode=yes', process.env.STUDIO_SSH_TARGET, 'rmdir -- ' + quote(item.projectPath)]).catch(() => {});
  }
  await device.close();
}
