import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, Check, LoaderCircle, Pencil, Plus, RefreshCw, SquareSlash, Trash2 } from 'lucide-react';
import { api } from './api';
import type { AgentProvider, DocEntry, DocKind } from '../shared/extensions';
const labels = { agents: { title: '子代理', empty: '还没有用户级子代理。', file: '~/.claude/agents/<名称>.md', help: '子代理是带独立提示词的专用助手。主代理会按 description 判断何时委派，也可以在对话里点名调用。' }, commands: { title: '命令', empty: '还没有自定义命令。', file: '', help: '自定义命令是一段可重复使用的提示词，在对话里用 /名称 触发，正文中的 $ARGUMENTS 会替换为你输入的参数。' } };
const template = (kind: DocKind, name: string) => kind === 'agents'
  ? `---\nname: ${name}\ndescription: 说明何时应该使用这个子代理\ntools: Read, Grep, Glob\n---\n\n你是一名……\n在这里写这个子代理的角色、步骤和输出要求。\n`
  : `---\ndescription: 一句话说明这个命令做什么\nargument-hint: [参数提示]\n---\n\n在这里写提示词，用 $ARGUMENTS 引用用户输入的参数。\n`;
export function AgentDocs({ provider, kind, guard, toast }: { provider: AgentProvider; kind: DocKind; guard: (check: (() => boolean) | undefined) => void; toast: (text: string) => void }) {
  const base = `/api/agents/${provider}/docs/${kind}`, text = labels[kind];
  const [items, setItems] = useState<DocEntry[]>([]), [busy, setBusy] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<{ entry?: DocEntry }>(), [name, setName] = useState(''), [content, setContent] = useState(''), [removing, setRemoving] = useState<DocEntry>();
  const baseline = useRef('');
  const dirty = editing !== undefined && JSON.stringify([name, content]) !== baseline.current;
  useEffect(() => { guard(() => !dirty || confirm('修改尚未保存，确定放弃？')); return () => guard(undefined); }, [dirty, guard]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    void api<DocEntry[]>(base, { signal: controller.signal }).then(setItems).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [base, reload]);
  const open = useCallback((entry?: DocEntry) => { const nextName = entry?.name ?? '', nextContent = entry?.content ?? template(kind, 'my-' + (kind === 'agents' ? 'agent' : 'command')); setName(nextName); setContent(nextContent); baseline.current = JSON.stringify([nextName, nextContent]); setEditing({ entry }); setError(''); }, [kind]);
  async function run(work: () => Promise<unknown>, message: string) { setBusy(true); setError(''); try { await work(); setEditing(undefined); setRemoving(undefined); setReload(value => value + 1); toast(message); } catch(e) { setError(String(e)); } finally { setBusy(false); } }
  function save() { const entry = editing?.entry; void run(() => api(entry ? `${base}/${encodeURIComponent(entry.name)}` : base, { method: entry ? 'PUT' : 'POST', body: JSON.stringify({ name, content, revision: entry?.revision }) }), text.title + '已保存'); }
  const Icon = kind === 'agents' ? Bot : SquareSlash;
  if (editing) return <>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <button className="extension-back" disabled={busy} onClick={() => { if (!dirty || confirm('修改尚未保存，确定放弃？')) setEditing(undefined); }}><ArrowLeft size={16}/>返回列表</button>
    <label className="field">{kind === 'agents' ? '子代理文件名' : '命令名（对话中输入 /' + (name || '名称') + '）'}<input aria-label="名称" disabled={busy} readOnly={!!editing.entry} value={name} onChange={e => setName(e.target.value)} placeholder="my-name" autoCapitalize="none" autoCorrect="off"/></label>
    <label className="field">Markdown 内容<textarea aria-label="内容" className="skill-editor" disabled={busy} rows={16} value={content} onChange={e => setContent(e.target.value)} spellCheck={false}/></label>
    <button className="primary full" disabled={busy || !name.trim() || !content.trim()} onClick={save}>{busy ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>} 保存</button>
  </>;
  if (removing) return <div className="extension-confirm"><h3>删除{text.title}</h3><p>确认删除「{removing.name}」？对应的 Markdown 文件会被删除。</p><div className="interaction-actions"><button disabled={busy} onClick={() => setRemoving(undefined)}>保留</button><button className="danger-text" disabled={busy} onClick={() => void run(() => api(`${base}/${encodeURIComponent(removing.name)}`, { method: 'DELETE', body: JSON.stringify({ revision: removing.revision }) }), '已删除')}>删除</button></div></div>;
  return <>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="extension-toolbar"><span>{items.length} 个{text.title}</span><div><button className="icon-button" aria-label="刷新" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={17} className={busy ? 'spin' : ''}/></button><button className="icon-button" aria-label={'新建' + text.title} disabled={busy} onClick={() => open()}><Plus size={18}/></button></div></div>
    {busy && !items.length ? <div className="empty"><LoaderCircle className="spin"/><p>正在读取…</p></div> : <div className="extension-list">
      {items.map(item => <div className="extension-row" key={item.name}><button className="extension-main" disabled={!item.editable} onClick={() => open(item)}><Icon size={21}/><span><strong>{kind === 'commands' ? '/' : ''}{item.name}{item.hint ? ' ' + item.hint : ''}</strong><small>{item.description || '无描述'}</small></span><Pencil size={16}/></button><button className="icon-button danger-text" aria-label={'删除 ' + item.name} disabled={!item.editable} onClick={() => setRemoving(item)}><Trash2 size={17}/></button></div>)}
      {!error && !items.length && !busy && <div className="empty"><Icon size={30}/><p>{text.empty}</p><span>点击上方加号新建。</span></div>}
    </div>}
    <p className="inline-note">{text.help} 保存在当前服务器的此代理用户目录；新建会话后生效。</p>
  </>;
}
