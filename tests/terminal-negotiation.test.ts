import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { TerminalNegotiation, secondaryDeviceAttributes } from '../server/terminal.ts';
import { fixture, until } from './helpers.ts';

test('device queries negotiate once locally at every output chunk boundary', () => {
  for (const query of ['\x1b[>c', '\x1b[>0c', '\x1b[>00c', '\x9b>0c']) {
    for (let split = 0; split <= query.length; split++) {
      const replies: string[] = [], terminal = new TerminalNegotiation(value => replies.push(value));
      const output = terminal.serverOutput('before' + query.slice(0, split)) + terminal.serverOutput(query.slice(split) + 'after');
      assert.equal(output, 'beforeafter'); assert.deepEqual(replies, [secondaryDeviceAttributes]);
    }
  }
});

test('other terminal controls, string payloads, literal text and interactive keys stay intact', () => {
  const replies: string[] = [], terminal = new TerminalNegotiation(value => replies.push(value));
  const output = 'literal 0;276;0c\r\n\x1b[?1049h\x1b[2J\x1b[4;8H\x1b[6n\x1b[c\x1b[>1c' + '\x1b]2;title \x1b[>c\x07' + '\x1bPpayload \x1b[>0c\x1b\\' + '\x9dtitle \x1b[>c\x9c';
  assert.equal(Array.from(output, char => terminal.serverOutput(char)).join(''), output);
  assert.deepEqual(replies, []);
  for (const input of ['\x1b', '\x1b[A', '\x03', '\r', 'echo "0;276;0c"\r', '\x1b[200~中文\ntext\x1b[201~']) assert.equal(terminal.clientInput(input), input);
  assert.equal(terminal.clientInput(secondaryDeviceAttributes), '');
  assert.equal(terminal.clientInput('pwd' + secondaryDeviceAttributes + '\r'), 'pwd\r');
  assert.equal(terminal.clientInput('\x1b[>83;40003;0c'), '');
  assert.equal(terminal.serverOutput('\x1b[>c'), '');
  assert.deepEqual(replies, [secondaryDeviceAttributes]);
});

test('gateway protects old phone clients and does not forward delayed duplicate replies', async t => {
  const f = await fixture(); t.after(f.close);
  const { ticket } = await (await f.call('/api/socket-ticket', { method: 'POST', body: '{"channel":"terminal"}' })).json();
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/terminal?ticket=' + ticket);
  const output: string[] = []; ws.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'output') output.push(value.data); });
  await once(ws, 'open'); t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'init', sessionId: 'terminal-negotiation', isPlainShell: true, forceRestart: false }));
  await until(() => f.sentMessages.some(value => value.type === 'init'));
  assert.equal(f.sentMessages.find(value => value.type === 'init')!.forceRestart, true);
  await until(() => output.some(value => value.includes('TERMINAL_READY')));
  for (const chunk of ['before\x1b[', '>0', 'cafter']) f.publishTerminal(chunk);
  await until(() => f.sentMessages.some(value => value.data === secondaryDeviceAttributes));
  await until(() => output.join('').includes('beforeafter'));
  assert.ok(!output.join('').includes('\x1b[>0c'), 'Phone should never be asked to answer this query');
  ws.send(JSON.stringify({ type: 'input', data: secondaryDeviceAttributes }));
  ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
  await until(() => f.sentMessages.some(value => value.data === '\x1b'));
  assert.equal(f.sentMessages.filter(value => value.data === secondaryDeviceAttributes).length, 1);
  ws.send(JSON.stringify({ type: 'input', data: 'echo 0;276;0c\r' }));
  await until(() => f.sentMessages.some(value => value.data === 'echo 0;276;0c\r'));
  f.publishTerminal('\x1b[6n');
  await until(() => output.includes('\x1b[6n'));
});
