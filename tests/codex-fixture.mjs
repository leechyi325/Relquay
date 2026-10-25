import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  if (frame.method === 'thread/start') {
    if (frame.params.approvalPolicy !== 'on-request' || frame.params.sandbox !== 'workspace-write') process.exit(3);
    send({ id: frame.id, result: { thread: { id: 'fixture-thread' } } });
  }
  if (frame.method === 'thread/resume') send({ id: frame.id, result: { thread: { id: 'fixture-thread' } } });
  if (frame.method === 'thread/archive') send({ id: frame.id, result: {} });
  if (frame.method === 'turn/start') {
    send({ id: frame.id, result: { turn: { id: 'fixture-turn' } } });
    send({ method: 'turn/started', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn' } } });
    send({ id: 'approve-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', command: 'echo approved', cwd: '/fixture' } });
  }
  if (frame.id === 'approve-command' && frame.result) {
    const accepted = frame.result.decision === 'accept';
    send({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', itemId: 'reply', delta: accepted ? '已批准' : '已拒绝' } });
    send({ method: 'item/completed', params: { threadId: 'fixture-thread', item: { id: 'reply', type: 'agentMessage', text: accepted ? '已批准' : '已拒绝' } } });
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { status: 'completed' } } });
  }
  if (frame.method === 'turn/interrupt') { send({ id: frame.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { status: 'interrupted' } } }); }
});
