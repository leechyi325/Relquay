import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify(frame) + '\n');
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  if (frame.method === 'model/list') send({ id: frame.id, result: { data: [{ id: 'test', model: 'test-model', displayName: 'Test Model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], inputModalities: ['text', 'image'] }], nextCursor: null } });
  if (frame.method === 'thread/start') {
    if (frame.params.approvalPolicy !== 'on-request' || frame.params.sandbox !== 'workspace-write') process.exit(3);
    send({ id: frame.id, result: { thread: { id: 'fixture-thread' } } });
  }
  if (frame.method === 'thread/resume') send({ id: frame.id, result: { thread: { id: 'fixture-thread' } } });
  if (frame.method === 'thread/archive') send({ id: frame.id, result: {} });
  if (frame.method === 'turn/start') {
    send({ id: frame.id, result: { turn: { id: 'fixture-turn' } } });
    send({ method: 'turn/started', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn' } } });
    if (frame.params.input[0].text.includes('QUESTION_TEST')) send({ id: 'answer-question', method: 'item/tool/requestUserInput', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'question-item', questions: [{ id: 'color', header: '配色', question: '使用哪种配色？', options: [{ label: '深蓝', description: '延续工作台颜色' }, { label: '绿色', description: '另一种配色' }] }] } });
    else send({ id: 'approve-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', command: 'echo approved', cwd: '/fixture' } });
  }
  if (frame.id === 'approve-command' && frame.result) {
    const accepted = frame.result.decision === 'accept';
    send({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', itemId: 'reply', delta: accepted ? '已批准' : '已拒绝' } });
    send({ method: 'item/completed', params: { threadId: 'fixture-thread', item: { id: 'reply', type: 'agentMessage', text: accepted ? '已批准' : '已拒绝' } } });
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { status: 'completed' } } });
  }
  if (frame.id === 'answer-question' && frame.result) {
    send({ method: 'item/completed', params: { threadId: 'fixture-thread', item: { id: 'question-reply', type: 'agentMessage', text: JSON.stringify(frame.result.answers) } } });
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { status: 'completed' } } });
  }
  if (frame.method === 'turn/interrupt') { send({ id: frame.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { status: 'interrupted' } } }); }
});
