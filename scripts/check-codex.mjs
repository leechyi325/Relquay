import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
let sequence = 0; const waiting = new Map();
const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; waiting.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  try { const frame = JSON.parse(line), pending = waiting.get(frame.id); if (!pending) return; waiting.delete(frame.id); if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result); } catch {}
});
child.stderr.resume();
const timeout = setTimeout(() => { child.kill(); console.error('Codex handshake timeout'); process.exitCode = 1; }, 15000);
try {
  await request('initialize', { clientInfo: { name: 'roamdeck_check', version: JSON.parse(readFileSync('package.json', 'utf8')).version } });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  const result = await request('thread/start', { cwd: process.env.STUDIO_CHECK_PROJECT ?? process.cwd(), approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.equal(typeof result.thread.id, 'string');
  await request('thread/archive', { threadId: result.thread.id });
  console.log(JSON.stringify({ passed: true, transport: 'local stdio', threadCreated: true, threadArchived: true, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, modelInference: false }));
} finally { clearTimeout(timeout); child.kill('SIGTERM'); lines.close(); }
