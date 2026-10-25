import { readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile), credentials = JSON.parse(await readFile('private/access.json', 'utf8'));
const target = process.env.STUDIO_SSH_TARGET;
if (!target) throw new Error('Set STUDIO_SSH_TARGET for the isolated terminal test');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
let token;
const call = async (route, body) => {
  const response = await fetch(credentials.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  assert.ok(response.ok, 'HTTP ' + response.status); return response.json();
};
({ token } = await call('/api/login', credentials));
const directory = 'terminal-replay-' + Date.now(), sessions = [];
await call('/api/files/folder', { root: 'inputs', path: directory });
const { path, terminalRc } = await call('/api/files/resolve', { root: 'inputs', path: directory });
const results = [];
try {
  for (const forceRestart of [false, true]) {
    const session = 'cv-replay-' + Date.now(); sessions.push(session);
    let originalPid;
    for (let i = 0; i < 3; i++) {
      const { ticket } = await call('/api/socket-ticket', { channel: 'terminal' });
      const ws = new WebSocket(credentials.url.replace(/^http/, 'ws') + '/ws/terminal?ticket=' + ticket);
      let output = '', responses = 0;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'init', projectPath: path, sessionId: session, provider: 'plain-shell', isPlainShell: true, forceRestart, initialCommand: `tmux new-session -A -s ${session} -c ${quote(path)} ${quote('bash --rcfile ' + quote(terminalRc) + ' -i')}`, cols: 40, rows: 20, colorScheme: 'dark' })));
      ws.on('message', raw => {
        const value = JSON.parse(raw); if (value.type !== 'output') return;
        output += value.data;
        for (const ignored of value.data.matchAll(/\x1b\[>[0-9;]*c/g)) { void ignored; responses++; ws.send(JSON.stringify({ type: 'input', data: '\x1b[>0;276;0c' })); }
      });
      try {
        await pause(2200);
        const { stdout } = await exec('ssh', ['-o', 'BatchMode=yes', target, `tmux display-message -p -t ${session} '#{pane_pid}'`]);
        const pid = stdout.trim(); originalPid ??= pid;
        assert.equal(pid, originalPid, 'Reattaching must preserve the shell process');
        if (forceRestart) {
          assert.equal((output.match(/0;276;0c/g) ?? []).length, 0, 'A fresh attachment leaked a device response');
          const command = i === 0 ? "ROAMDECK_REPLAY_TEST=persisted; printf '\\n<%s>\\n' \"$ROAMDECK_REPLAY_TEST\"\r" : "printf '\\n<%s>\\n' \"$ROAMDECK_REPLAY_TEST\"\r";
          ws.send(JSON.stringify({ type: 'input', data: command }));
          for (let attempt = 0; attempt < 40 && !output.includes('<persisted>'); attempt++) await pause(250);
          assert.match(output, /<persisted>/, 'Shell state was lost across the attachment');
        }
        results.push({ forceRestart, attempt: i + 1, responses, replayed: output.includes('[Reconnected'), garbage: (output.match(/0;276;0c/g) ?? []).length, shellPidPreserved: pid === originalPid });
        ws.send(JSON.stringify({ type: 'input', data: '\x03' })); await pause(100);
      } finally { ws.close(); }
      await pause(200);
    }
  }
  assert.ok(results.some(value => !value.forceRestart && value.garbage > 0), 'The legacy replay regression did not reproduce');
  await writeFile('artifacts/terminal-replay-report.json', JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  for (const session of sessions) await exec('ssh', ['-o', 'BatchMode=yes', target, 'tmux kill-session -t ' + session]).catch(() => {});
  await exec('ssh', ['-o', 'BatchMode=yes', target, 'rmdir -- ' + quote(path)]).catch(() => {});
}
