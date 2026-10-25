import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
const exec = promisify(execFile), credentials = JSON.parse(await readFile('private/access.json', 'utf8'));
const target = process.env.STUDIO_SSH_TARGET;
if (!target) throw new Error('Set STUDIO_SSH_TARGET for isolated terminal verification');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'", pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let i = 0; i < 80; i++) { if (check()) return; await pause(100); } throw new Error('Terminal verification timeout'); };
let token;
const call = async (route, body) => {
  const response = await fetch(credentials.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  assert.ok(response.ok, 'HTTP ' + response.status); return response.json();
};
({ token } = await call('/api/login', credentials));
const name = 'terminal-negotiation-' + Date.now(), session = 'cv-negotiation-' + Date.now();
await call('/api/files/folder', { root: 'inputs', path: name });
const { path, terminalRc } = await call('/api/files/resolve', { root: 'inputs', path: name });
const results = [];
let firstPid;
try {
  for (const delayedReply of [0, 1800, 5000]) {
    const { ticket } = await call('/api/socket-ticket', { channel: 'terminal' });
    const ws = new WebSocket(credentials.url.replace(/^http/, 'ws') + '/ws/terminal?ticket=' + ticket);
    let output = '', queryCount = 0;
    const timers = [];
    ws.on('open', () => {
      // Deliberately use a pre-0.4.1 init. Server must protect old bundled clients.
      ws.send(JSON.stringify({ type: 'init', projectPath: path, sessionId: session, provider: 'plain-shell', isPlainShell: true, forceRestart: false, initialCommand: `tmux new-session -A -s ${session} -c ${quote(path)} ${quote('bash --rcfile ' + quote(terminalRc) + ' -i')}`, cols: 45, rows: 24 }));
      // Simulate an automatic reply already queued by an old/backgrounded app.
      timers.push(setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: '\x1b[>0;276;0c' })); }, delayedReply));
    });
    ws.on('message', raw => {
      const value = JSON.parse(raw); if (value.type !== 'output') return;
      output += value.data;
      for (const ignored of value.data.matchAll(/\x1b\[>0*c/g)) {
        void ignored; queryCount++;
        timers.push(setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: '\x1b[>0;276;0c' })); }, delayedReply));
      }
    });
    try {
      await until(() => output.includes('\x1b[?2004h'));
      await pause(delayedReply + 400);
      const { stdout } = await exec('ssh', ['-o', 'BatchMode=yes', target, `tmux display-message -p -t ${session} '#{pane_pid}'`]);
      const pid = stdout.trim(); firstPid ??= pid; assert.equal(pid, firstPid, 'Shell PID changed');
      const capture = await exec('ssh', ['-o', 'BatchMode=yes', target, `tmux capture-pane -p -t ${session}`]);
      assert.ok(!capture.stdout.includes('0;276;0c'), 'A stale response entered the input line');
      assert.equal(queryCount, 0, 'Phone received a query that must be negotiated on loopback');
      assert.ok(!output.includes('[Reconnected'), 'Old raw buffer was replayed');
      output = '';
      const command = (results.length ? '' : 'ROAMDECK_NEGOTIATION_STATE=preserved; ') + "printf '\\n<%s>\\n' \"$ROAMDECK_NEGOTIATION_STATE\"\r";
      ws.send(JSON.stringify({ type: 'input', data: command }));
      await until(() => output.includes('<preserved>'));
      results.push({ delayedReplyMs: delayedReply, phoneDeviceQueries: queryCount, staleResponseInInput: false, shellPidPreserved: true, shellVariablePreserved: true, oldClientCompatible: true });
    } finally { for (const timer of timers) clearTimeout(timer); ws.close(); }
    await pause(200);
  }
  const report = { passed: true, results, checkedOnlyOwnSession: true };
  await writeFile('artifacts/terminal-negotiation-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  await exec('ssh', ['-o', 'BatchMode=yes', target, 'tmux kill-session -t ' + session]).catch(() => {});
  await exec('ssh', ['-o', 'BatchMode=yes', target, 'rmdir -- ' + quote(path)]).catch(() => {});
}
