import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Folder, FolderOpen, LoaderCircle, Pencil, Trash2 } from 'lucide-react';
import { api, cloud, params, post } from './api';
import { Sheet } from './Files';
import { useRootNames } from './file-roots';
import type { Conversation, ConversationCreate, FileEntry, FileLocation, Provider } from '../shared/protocol';

export function NewSession({ provider, setProvider, initialCwd, created, close }: { provider: Provider; setProvider: (value: Provider) => void; initialCwd: FileLocation; created: (value: Conversation) => void; close: () => void }) {
  const rootNames = useRootNames();
  const [cwd, setCwd] = useState<FileLocation>(rootNames[initialCwd.root] ? initialCwd : { root: Object.keys(rootNames)[0] ?? 'project', path: '' }), [name, setName] = useState('默认项目'), [title, setTitle] = useState(''), [createDirectory, setCreateDirectory] = useState(false), [picker, setPicker] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [directories, setDirectories] = useState<{ id: string; path: string }[]>([]);
  const [projects, setProjects] = useState<{ fullPath: string; displayName: string }[]>([]), [loaded, setLoaded] = useState(false);
  const editedName = useRef(false);
  const submitting = useRef(false);
  useEffect(() => { let live = true; void Promise.all([api<{ id: string; path: string }[]>('/api/roots'), cloud<{ fullPath: string; displayName: string }[]>('/projects?skipSync=1')]).then(([roots, known]) => { if (live) { setDirectories(roots); setProjects(known); setLoaded(true); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  const base = directories.find(value => value.id === cwd.root)?.path ?? rootNames[cwd.root];
  const directory = [base, cwd.path].filter(Boolean).join('/');
  useEffect(() => { if (!editedName.current && !createDirectory && loaded) setName(projects.find(project => project.fullPath === directory)?.displayName ?? (cwd.path.split('/').filter(Boolean).at(-1) || '默认项目')); }, [directory, loaded, projects, createDirectory]);
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    const body: ConversationCreate = { provider, projectName: name, title, cwd, createDirectory };
    try { created(await post<Conversation>('/api/conversations', body)); }
    catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { submitting.current = false; setBusy(false); }
  }
  return <Sheet title="新建会话" close={busy ? () => {} : close}>
    <div className="provider-choice">{(['claude', 'codex'] as const).map(id => <button className={provider === id ? 'selected' : ''} disabled={busy} onClick={() => setProvider(id)} key={id}>{id === 'claude' ? 'Claude Code' : 'Codex'}{provider === id && <Check size={17}/>}</button>)}</div>
    <label className="field">项目名称<input value={name} maxLength={100} disabled={busy} onChange={e => { editedName.current = true; setName(e.target.value); }} placeholder="例如：个人网站"/></label>
    <div className="session-location"><span>{createDirectory ? '项目文件夹放在' : '项目工作目录'}</span><button className="directory-button" aria-label="选择项目目录" disabled={busy} onClick={() => setPicker(true)}><FolderOpen size={19}/><code>{directory}</code><ChevronRight size={17}/></button></div>
    <label className="folder-option"><input type="checkbox" checked={createDirectory} disabled={busy} onChange={e => setCreateDirectory(e.target.checked)}/><span>在所选位置新建同名项目文件夹</span></label>
    {createDirectory ? <p className="inline-note">将创建：<code>{directory}/{name.trim() || '项目名称'}</code></p> : <p className="inline-note">直接使用所选目录，项目名称会保存到该目录对应的项目。</p>}
    <label className="field">会话名称（可选）<input value={title} maxLength={200} disabled={busy} onChange={e => setTitle(e.target.value)} placeholder="例如：实现登录页面"/></label>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <button className="primary full" disabled={busy || !name.trim() || !loaded} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>} {busy ? '正在创建…' : '创建会话'}</button>
    {picker && <DirectoryPicker value={cwd} choose={value => { setCwd(value); setPicker(false); }} close={() => setPicker(false)}/>}
  </Sheet>;
}

function DirectoryPicker({ value, choose, close }: { value: FileLocation; choose: (value: FileLocation) => void; close: () => void }) {
  const rootNames = useRootNames();
  const [current, setCurrent] = useState(value), [entries, setEntries] = useState<FileEntry[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    void api<FileEntry[]>('/api/files?' + params(current)).then(values => { if (live) setEntries(values.filter(entry => entry.directory)); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [current.root, current.path]);
  return <Sheet title="选择服务器目录" close={close}>
    <div className="root-tabs">{Object.entries(rootNames).map(([id, label]) => <button className={id === current.root ? 'active' : ''} key={id} onClick={() => setCurrent({ root: id as FileLocation['root'], path: '' })}>{label}</button>)}</div>
    <p className="directory-current">{rootNames[current.root]} / {current.path || '根目录'}</p>
    {current.path && <button className="parent-folder" onClick={() => setCurrent({ ...current, path: current.path.split('/').slice(0, -1).join('/') })}><ArrowLeft size={16}/>上一级目录</button>}
    <div className="directory-list">{error ? <div className="error-banner">{error}</div> : loading ? <div className="empty"><LoaderCircle className="spin"/></div> : entries.length ? entries.map(entry => <button key={entry.path} onClick={() => setCurrent({ root: entry.root, path: entry.path })}><Folder size={20}/><span>{entry.name}</span><ChevronRight size={16}/></button>) : <p className="muted">此目录没有子文件夹，可以直接选择。</p>}</div>
    <button className="primary full" disabled={loading || !!error} onClick={() => choose(current)}><Check size={17}/>使用此目录</button>
  </Sheet>;
}

export function SessionActions({ conversation, updated, deleted, close }: { conversation: Conversation; updated: (value: Conversation) => void; deleted: () => void; close: () => void }) {
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(conversation.sessionTitle);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function remove() {
    setBusy(true); setError('');
    try { await api('/api/conversations/' + encodeURIComponent(conversation.sessionId), { method: 'DELETE' }); deleted(); }
    catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function rename() {
    setBusy(true); setError('');
    try { updated(await api<Conversation>('/api/conversations/' + encodeURIComponent(conversation.sessionId), { method: 'PUT', body: JSON.stringify({ title }) })); }
    catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <Sheet title={editing ? '重命名会话' : confirm ? '确认删除会话' : '会话操作'} close={busy ? () => {} : close}>
    <h3>{conversation.sessionTitle}</h3><p className="muted">{conversation.projectDisplayName} · {conversation.provider === 'codex' ? 'Codex' : 'Claude Code'}</p>
    {editing ? <form onSubmit={e => { e.preventDefault(); void rename(); }}><label className="field">会话名称<input aria-label="会话名称" value={title} maxLength={200} disabled={busy} onChange={e => setTitle(e.target.value)}/></label>{error && <div className="error-banner" role="alert">{error}</div>}<div className="interaction-actions"><button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button className="primary" disabled={busy || !title.trim()}>{busy ? '正在保存…' : '保存名称'}</button></div></form> : confirm ? <><p className="delete-explanation">这会删除这段会话及其对话记录。项目目录、代码和素材会保留。运行中的会话需要先停止。</p>{error && <div className="error-banner" role="alert">{error}</div>}<div className="session-confirm-actions"><button disabled={busy} onClick={() => setConfirm(false)}>取消</button><button className="primary danger-action" disabled={busy} onClick={() => void remove()}>{busy ? <LoaderCircle className="spin" size={17}/> : <Trash2 size={17}/>}确认删除</button></div></> : <div className="action-list"><button onClick={() => { setError(''); setEditing(true); }}><Pencil size={18}/>重命名会话</button><button className="danger-text" onClick={() => setConfirm(true)}><Trash2 size={18}/>删除会话</button></div>}
  </Sheet>;
}

export function useConversationPath(conversation: Conversation) {
  const [directory, setDirectory] = useState(conversation.projectPath ?? '');
  useEffect(() => { let live = true; void api<Conversation>(`/api/conversations/${conversation.sessionId}`).then(value => { if (live) setDirectory(value.projectPath ?? conversation.projectPath ?? ''); }).catch(() => {}); return () => { live = false; }; }, [conversation.sessionId]);
  return directory;
}
