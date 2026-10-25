import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const base = process.env.STUDIO_CHECK_URL ?? 'http://127.0.0.1:3080';
const credentials = JSON.parse(await fs.readFile('/home/ubuntu/compileverse/studio/access.json', 'utf8'));
assert.equal((await fetch(base + '/api/files')).status, 401);
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
assert.equal(login.status, 200); const { token } = await login.json();
const call = async (url, options = {}) => {
  const response = await fetch(base + url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  assert.ok(response.ok, `${url} ${response.status}: ${response.ok ? '' : await response.text()}`); return response;
};
const post = (url, value) => call(url, { method: 'POST', body: JSON.stringify(value) });
const status = await (await call('/api/status')).json();
assert.equal(status.architecture, 'arm64'); assert.ok(status.cloudcli); assert.ok(status.providers.every(p => p.installed));
const list = await (await call('/api/files?root=project')).json(); assert.ok(Array.isArray(list)); assert.ok(list.every(f => typeof f.name === 'string'));
const upload = new FormData(); const filename = `手机验收-${Date.now()}.md`; upload.append('file', new Blob(['# 初稿\n真实 Oracle 上传测试']), filename);
await call('/api/files/upload?root=inputs', { method: 'POST', body: upload });
const text = await (await call('/api/files/text?root=inputs&path=' + encodeURIComponent(filename))).json(); assert.match(text.content, /初稿/);
await call('/api/files/text', { method: 'PUT', body: JSON.stringify({ root: 'inputs', path: filename, content: '# 修改已保存\nOracle ARM', modified: text.modified }) });
const preview = await (await post('/api/files/preview', { root: 'inputs', path: filename })).json();
const range = await fetch(base + preview.url, { headers: { Range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 4);
const job = await (await post('/api/jobs', { title: 'Oracle ARM 工作台验收', command: 'node --version; uname -m; printf "studio-job-ok\\n"', cwd: { root: 'project', path: '' } })).json();
for (let i = 0; i < 40; i++) { const jobs = await (await call('/api/jobs')).json(); const current = jobs.find(j => j.id === job.id); if (current.status === 'succeeded') break; if (i === 39) throw new Error('Job did not succeed'); await new Promise(r => setTimeout(r, 150)); }
assert.match((await (await call(`/api/jobs/${job.id}/log`)).json()).log, /studio-job-ok/);
const session = await (await post('/api/cloud/providers/sessions', { provider: 'claude', projectPath: status.projectPath, initialMessage: '' })).json(); const sessionId = session.data.sessionId;
const connect = async channel => { const { ticket } = await (await post('/api/socket-ticket', { channel })).json(); return new WebSocket(base.replace(/^http/, 'ws') + `/ws/${channel}?ticket=${ticket}`); };
const chat = await connect('chat');
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Chat subscription timeout')), 12000); chat.on('open', () => chat.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }))); chat.on('message', data => { const event = JSON.parse(data); if (event.kind === 'chat_subscribed') { clearTimeout(timer); resolve(); } }); chat.on('error', reject); }); chat.close();
const terminal = await connect('terminal');
let output = '', initialized = false;
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Real PTY timeout: ' + output.slice(-1000))), 15000);
  terminal.on('open', () => terminal.send(JSON.stringify({ type: 'init', projectPath: status.projectPath, sessionId: 'cv-acceptance', provider: 'plain-shell', isPlainShell: true, initialCommand: 'tmux new-session -A -s cv-acceptance', cols: 80, rows: 24 })));
  terminal.on('message', data => {
    const value = JSON.parse(data); if (value.type !== 'output') return; output += value.data;
    if (!initialized) { initialized = true; setTimeout(() => terminal.send(JSON.stringify({ type: 'input', data: "printf '\\x43\\x56\\x5f\\x50\\x54\\x59\\x5f\\x4f\\x4b\\n'\r" })), 800); }
    if (output.includes('CV_PTY_OK')) { clearTimeout(timeout); resolve(); }
  }); terminal.on('error', reject);
}); terminal.close();
const reconnect = await connect('terminal');
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('PTY reconnect timeout')), 10000);
  reconnect.on('open', () => reconnect.send(JSON.stringify({ type: 'init', projectPath: status.projectPath, sessionId: 'cv-acceptance', provider: 'plain-shell', isPlainShell: true, initialCommand: 'tmux new-session -A -s cv-acceptance', cols: 80, rows: 24 })));
  reconnect.on('message', data => { const value = JSON.parse(data); if (value.type === 'output' && value.data.includes('Reconnected')) { clearTimeout(timeout); resolve(); } }); reconnect.on('error', reject);
}); reconnect.close();
await fs.rm(`/home/ubuntu/compileverse/inputs/${filename}`);
const report = { passed: true, date: new Date().toISOString(), architecture: status.architecture, providers: status.providers, checks: ['unauthenticated rejection', 'real Chinese upload and optimistic save', 'media byte range', 'real background job', 'CloudCLI session create and subscribe', 'real tmux PTY', 'PTY reconnect'], modelInference: 'not run; user authentication required' };
await fs.writeFile('/home/ubuntu/compileverse/studio/state/acceptance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
