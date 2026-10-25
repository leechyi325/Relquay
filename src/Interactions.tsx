import { useEffect, useState } from 'react';
import { Check, ChevronRight, LoaderCircle, MessageSquare, ShieldCheck, X } from 'lucide-react';
import Markdown from 'react-markdown';
import { interactionInput, interactionQuestions, interactionResponse } from '../shared/interactions';
import type { ChatEvent } from '../shared/protocol';
import { Sheet } from './Files';

export function Interactions({ permissions, connected, send, toast, failure }: { permissions: ChatEvent[]; connected: boolean; send: (value: Record<string, unknown>) => void; toast: (value: string) => void; failure?: ChatEvent }) {
  const [selected, setSelected] = useState<string>(), [folded, setFolded] = useState(false);
  useEffect(() => { if (!permissions.some(event => event.requestId === selected)) { setSelected(permissions[0]?.requestId); setFolded(false); } }, [permissions, selected]);
  if (!permissions.length) return null;
  const event = permissions.find(item => item.requestId === selected) ?? permissions[0];
  return <><button className="interaction-banner" onClick={() => setFolded(false)}><ShieldCheck size={19}/><span><strong>等待你的回应</strong><small>{permissions.length} 项批准或问题 · 点击处理</small></span><ChevronRight size={19}/></button>{!folded && <Sheet title={interactionQuestions(event).length ? 'AI 需要你的选择' : '审阅这次操作'} close={() => setFolded(true)}><div className="interaction-tabs">{permissions.map((item, i) => <button key={item.requestId} className={item.requestId === event.requestId ? 'selected' : ''} onClick={() => setSelected(item.requestId)}>{i + 1}. {interactionQuestions(item).length ? '问题' : item.toolName ?? '批准'}</button>)}</div><Interaction key={event.requestId} event={event} connected={connected} send={send} toast={toast} failure={failure}/></Sheet>}</>;
}
function Interaction({ event, connected, send, toast, failure }: { event: ChatEvent; connected: boolean; send: (value: Record<string, unknown>) => void; toast: (value: string) => void; failure?: ChatEvent }) {
  const questions = interactionQuestions(event), input = interactionInput(event), isQuestion = questions.length > 0;
  const unknownQuestion = !isQuestion && (event.interaction === 'questions' || event.toolName === 'AskUserQuestion');
  const [answers, setAnswers] = useState<Record<string, string[]>>({}), [custom, setCustom] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (failure && failure.requestId === event.requestId) { setBusy(false); setError(failure.content ?? '回应未被接受，请重新连接后核对'); } }, [failure, event.requestId]);
  useEffect(() => { if (!connected) { setBusy(false); setError('连接已断开，重连后会核对请求状态'); } else setError(''); }, [connected]);
  async function respond(allow: boolean) {
    try {
      const values = Object.fromEntries(questions.map(question => [question.id, [...(answers[question.id] ?? []), ...(custom[question.id]?.trim() ? [custom[question.id].trim()] : [])]]));
      const extra = isQuestion && allow ? interactionResponse(event, values) : {};
      send({ type: 'chat.permission-response', sessionId: event.sessionId, requestId: event.requestId, allow, ...extra }); setBusy(true); setError('');
    } catch(e) { setError(String(e)); toast(String(e)); }
  }
  const command = typeof input.command === 'string' ? input.command : undefined, cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const reason = typeof input.reason === 'string' ? input.reason : typeof input.description === 'string' ? input.description : undefined;
  const plan = typeof input.plan === 'string' ? input.plan : undefined;
  const patch = typeof input.patch === 'string' ? input.patch : typeof input.diff === 'string' ? input.diff : typeof input.new_string === 'string' ? `--- 原内容\n${String(input.old_string ?? '')}\n+++ 新内容\n${input.new_string}` : typeof input.content === 'string' ? input.content : undefined;
  return <div className="interaction-review">
    {isQuestion ? <>{questions.map(question => <fieldset key={question.id} className="interaction-question" disabled={busy || !connected}><legend><MessageSquare size={17}/>{question.title}</legend><p>{question.question}</p>{question.multiple && <small className="muted">可选择多项</small>}<div className="answer-options">{question.options.map(option => { const selected = answers[question.id]?.includes(option.label) ?? false; return <button type="button" key={option.label} className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => { if (!question.multiple) setCustom(current => ({ ...current, [question.id]: '' })); setAnswers(current => ({ ...current, [question.id]: question.multiple ? selected ? current[question.id].filter(value => value !== option.label) : [...(current[question.id] ?? []), option.label] : selected ? [] : [option.label] })); }}><span className="answer-indicator">{selected && <Check size={14}/>}</span><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></button>; })}</div><label className="field">{question.options.length ? '补充或自定义回答' : '你的回答'}<input type={question.secret ? 'password' : 'text'} value={custom[question.id] ?? ''} autoComplete="off" onChange={e => { setCustom(current => ({ ...current, [question.id]: e.target.value })); if (!question.multiple && e.target.value) setAnswers(current => ({ ...current, [question.id]: [] })); }}/></label></fieldset>)}</> : <><div className="approval-title"><span><ShieldCheck size={24}/></span><div><strong>{event.toolName ?? '工具操作'}</strong><small>审阅后允许本次或拒绝</small></div></div>{reason && <p className="approval-reason">{reason}</p>}{cwd && <dl className="approval-location"><dt>工作目录</dt><dd>{cwd}</dd></dl>}{typeof input.file_path === 'string' && <dl className="approval-location"><dt>文件</dt><dd>{input.file_path}</dd></dl>}{command && <div className="approval-code"><span>将执行的命令</span><pre>{command}</pre></div>}{patch && <div className="approval-code"><span>文件变更</span><pre>{patch}</pre></div>}{Array.isArray(input.changes) && <div className="approval-code"><span>文件变更</span><pre>{JSON.stringify(input.changes, null, 2)}</pre></div>}{plan && <article className="markdown approval-plan"><Markdown>{plan}</Markdown></article>}<details className="approval-raw"><summary>完整请求详情</summary><pre>{JSON.stringify(input, null, 2)}</pre></details></>}
    {unknownQuestion && <div className="error-banner">问题格式暂不支持，请在终端继续；也可拒绝本次请求。</div>}{error && <div className="error-banner" role="alert">{error}</div>}{busy && <p className="interaction-pending" role="status"><LoaderCircle size={16} className="spin"/>已发送，等待服务器确认…</p>}<div className="interaction-actions"><button disabled={busy || !connected} onClick={() => void respond(false)}><X size={16}/>{isQuestion ? '跳过本组问题' : '拒绝本次'}</button><button className="primary" disabled={busy || !connected || unknownQuestion} onClick={() => void respond(true)}><Check size={16}/>{isQuestion ? '提交回答' : '允许本次'}</button></div>
  </div>;
}
