import { useState } from 'react';
import { LoaderCircle, Square } from 'lucide-react';
import { socket } from './api';
import { Sheet } from './Files';
import type { Conversation } from '../shared/protocol';

export type RunningTask = { taskId: string; toolUseId?: string; taskType?: string; description?: string; workflowName?: string; startedAt: number; nested?: boolean };
export type RunningSession = { sessionId: string; provider: string; startedAt: number; background?: boolean; canInterrupt?: boolean; tasks?: RunningTask[] };
const taskNames: Record<string, string> = { local_bash: '后台命令', local_agent: '子代理', local_workflow: '工作流', remote_agent: '远程代理' };
const elapsed = (from: number, now: number) => { const s = Math.max(0, Math.floor((now - from) / 1000)); return s < 60 ? s + ' 秒' : s < 3600 ? Math.floor(s / 60) + ' 分钟' : Math.floor(s / 3600) + ' 小时 ' + Math.floor(s % 3600 / 60) + ' 分'; };
export const runningCount = (sessions: RunningSession[]) => sessions.reduce((sum, item) => sum + (item.tasks?.length ?? 0) + (item.background ? 0 : 1), 0);
// 通过会话通道发一条控制消息，并等待网关/CloudCLI 的回复（出错时回复 protocol_error）。
async function control(message: Record<string, unknown>) {
  const connection = await socket('chat');
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { connection.close(); resolve(''); }, 2500);
    connection.onopen = () => connection.send(JSON.stringify(message));
    connection.onmessage = ({ data }) => { try { const frame = JSON.parse(data); if (frame.kind === 'protocol_error') { clearTimeout(timer); connection.close(); resolve(String(frame.error ?? frame.content ?? '操作失败')); } } catch { /* Ignore frames this panel does not understand. */ } };
    connection.onerror = () => { clearTimeout(timer); reject(new Error('无法连接服务器')); };
  });
}
export function BackgroundTasks({ sessions, conversations, refresh, open, close, toast }: { sessions: RunningSession[]; conversations: Conversation[]; refresh: () => Promise<void>; open: (value: Conversation) => void; close: () => void; toast: (value: string) => void }) {
  const [busy, setBusy] = useState(''), now = Date.now();
  const titleOf = (id: string) => conversations.find(item => item.sessionId === id);
  async function stop(key: string, message: Record<string, unknown>, label: string) {
    if (!window.confirm(`停止${label}？已完成的修改会保留，未完成的工作会中断。`)) return;
    setBusy(key);
    try { const failure = await control(message); toast(failure ? failure : '已发送停止请求'); await new Promise(resolve => setTimeout(resolve, 800)); await refresh(); }
    catch(e) { toast(String(e)); } finally { setBusy(''); }
  }
  return <Sheet title="后台任务" close={close}>
    <p className="inline-note">显示 AI 正在进行的回合，以及回合结束后仍在后台运行的子代理、命令和工作流。</p>
    {!sessions.length && <div className="empty-state"><strong>没有正在运行的任务</strong><span>AI 空闲时这里是空的。</span></div>}
    {sessions.map(item => { const conversation = titleOf(item.sessionId), tasks = item.tasks ?? []; return <section className="bg-session" key={item.sessionId}>
      <header><button className="bg-title" onClick={() => { if (conversation) { open(conversation); close(); } }} disabled={!conversation}><strong>{conversation?.sessionTitle ?? '会话 ' + item.sessionId.slice(0, 8)}</strong><small>{item.provider === 'codex' ? 'Codex' : 'Claude Code'} · {item.background ? '回合已结束，后台仍在运行' : '正在处理 · 已运行 ' + elapsed(item.startedAt, now)}</small></button>
        {!item.background && item.canInterrupt !== false && <button className="bg-stop" disabled={!!busy} onClick={() => void stop(item.sessionId, { type: 'chat.abort', sessionId: item.sessionId }, '当前回合')}>{busy === item.sessionId ? <LoaderCircle size={14} className="spin"/> : <Square size={13} fill="currentColor"/>}停止回合</button>}</header>
      {tasks.map(task => <div className="bg-task" key={task.taskId}><span><strong>{task.workflowName ?? task.description ?? task.taskId}</strong><small>{taskNames[task.taskType ?? ''] ?? task.taskType ?? '后台任务'}{task.nested ? ' · 由子代理启动' : ''} · 已运行 {elapsed(task.startedAt, now)}</small>{task.workflowName && task.description && <small>{task.description}</small>}</span>
        <button className="bg-stop" disabled={!!busy} aria-label={'停止 ' + (task.description ?? task.taskId)} onClick={() => void stop(task.taskId, { type: 'chat.stop-task', sessionId: item.sessionId, taskId: task.taskId }, '该任务')}>{busy === task.taskId ? <LoaderCircle size={14} className="spin"/> : <Square size={13} fill="currentColor"/>}停止</button></div>)}
    </section>; })}
  </Sheet>;
}
