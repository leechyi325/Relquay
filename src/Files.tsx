import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronRight, Code2, File, FileAudio, FileImage, FileText, Film, Folder, FolderPlus, Grid2X2, List, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, Settings2, Search, Upload, X } from 'lucide-react';
import Markdown from 'react-markdown';
import { api, post, params, origin, downloadFile } from './api';
import { useFileModules, useRootNames } from './file-roots';
import { FileModuleManager } from './FileModules';
import type { FileEntry, FileLocation } from '../shared/protocol';

export { defaultRootNames as rootNames } from './file-roots';
export function bytes(value: number) { return value < 1024 ? value + ' B' : value < 1024 ** 2 ? (value / 1024).toFixed(1) + ' KB' : value < 1024 ** 3 ? (value / 1024 ** 2).toFixed(1) + ' MB' : (value / 1024 ** 3).toFixed(1) + ' GB'; }
function FileIcon({ entry, size = 24 }: { entry: FileEntry; size?: number }) {
  const Icon = entry.directory ? Folder : entry.mime.startsWith('video') ? Film : entry.mime.startsWith('image') ? FileImage : entry.mime.startsWith('audio') ? FileAudio : entry.mime.startsWith('text') || entry.mime.includes('json') ? FileText : File;
  return <Icon size={size} strokeWidth={1.5}/>;
}
export function Sheet({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [close]);
  return <div className="modal-shade" onClick={close}><section role="dialog" aria-modal="true" aria-label={title} className="sheet" onClick={e => e.stopPropagation()}><div className="sheet-handle"/><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={20}/></button></header>{children}</section></div>;
}
export function FilesPage({ location, setLocation, terminal, reference, toast }: { location: FileLocation; setLocation: (v: FileLocation) => void; terminal: (v: FileLocation) => void; reference: (v: FileEntry) => void; toast: (v: string) => void }) {
  const { modules, roots, error: moduleError } = useFileModules(), rootNames = useRootNames();
  const [manager, setManager] = useState(false), [moduleId, setModuleId] = useState<string>();
  const currentModule = modules.find(module => module.id === moduleId) ?? modules.find(module => module.folders.some(folder => folder.id === location.root)) ?? modules[0];
  const showingFolders = currentModule?.folders.length > 1 && !currentModule.folders.some(folder => folder.id === location.root);
  useEffect(() => { if (!roots.some(root => root.id === location.root) && !showingFolders && roots.length) setLocation({ root: roots[0].id, path: '' }); }, [roots, location.root, showingFolders, setLocation]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') setRefresh(v => v + 1); }, 10000); const wake = () => setRefresh(v => v + 1); window.addEventListener('focus', wake); return () => { clearInterval(timer); window.removeEventListener('focus', wake); }; }, []);
  const [entries, setEntries] = useState<FileEntry[]>([]), [search, setSearch] = useState(''), [grid, setGrid] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [selected, setSelected] = useState<FileEntry>(), [view, setView] = useState<FileEntry>(), [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState<'folder' | 'move'>(), [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true; if (showingFolders) { setEntries([]); setLoading(false); return; } setLoading(true); setError(''); setSearch('');
    void api<FileEntry[]>('/api/files?' + params(location)).then(v => { if (live) setEntries(v); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [location.root, location.path, refresh, showingFolders]);
  async function uploadFiles(fileList: FileList | null) {
    if (!fileList) return; setBusy(true);
    try { for (const file of fileList) { const body = new FormData(); body.append('file', file); await api('/api/files/upload?' + params(location), { method: 'POST', body, signal: AbortSignal.timeout(600000) }); } toast('已上传到服务器'); setRefresh(v => v + 1); }
    catch(e) { toast(String(e)); } finally { setBusy(false); if (upload.current) upload.current.value = ''; }
  }
  async function submit() {
    if (!name.trim()) return; setBusy(true);
    try {
      if (form === 'folder') await post('/api/files/folder', { ...location, path: [location.path, name.trim()].filter(Boolean).join('/') });
      else if (selected) await post('/api/files/move', { from: selected, to: { root: location.root, path: name.trim() } });
      setForm(undefined); setSelected(undefined); setRefresh(v => v + 1); toast('文件已更新');
    } catch(e) { toast(String(e)); } finally { setBusy(false); }
  }
  const filtered = entries.filter(e => e.name.toLowerCase().includes(search.toLowerCase()));
  return <div className="files-page">
    <div className="section-heading"><div><span className="eyebrow">YOUR SERVER FILES</span><h1>文件，井然有序。</h1></div></div>
    <p className="muted">浏览服务器上的项目与文件。</p><div className="file-module-tools"><button onClick={() => setManager(true)}><Settings2 size={16}/>管理模块</button><button aria-label="刷新文件" onClick={() => setRefresh(v => v + 1)}><RefreshCw size={16}/></button></div>{moduleError && <div className="error-banner">{moduleError}</div>}
    <div className="root-tabs">{modules.map(module => <button key={module.id} className={currentModule?.id === module.id ? 'active' : ''} onClick={() => { setModuleId(module.id); setLocation({ root: module.folders.length === 1 ? module.folders[0].id : 'module-view', path: '' }); }}>{module.name}</button>)}</div>
    {showingFolders ? <div className="module-folder-picker">{currentModule.folders.map(folder => <button key={folder.id} onClick={() => setLocation({ root: folder.id, path: '' })}><Folder size={23}/><span><strong>{folder.name}</strong><small>{folder.path}</small></span><ChevronRight size={17}/></button>)}</div> : <>
    {currentModule?.folders.length > 1 && <button className="parent-folder" onClick={() => setLocation({ root: 'module-view', path: '' })}><ArrowLeft size={16}/>选择其他绑定文件夹</button>}
    <div className="file-toolbar"><label className="search-box"><Search size={17}/><input aria-label="搜索当前目录" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索当前目录…"/></label><button className="icon-button" aria-label={grid ? '列表视图' : '网格视图'} onClick={() => setGrid(!grid)}>{grid ? <List size={19}/> : <Grid2X2 size={19}/>}</button><button className="upload-button" onClick={() => upload.current?.click()} disabled={busy}>{busy ? <LoaderCircle size={17} className="spin"/> : <Upload size={17}/>}<span>上传</span></button><input hidden ref={upload} type="file" multiple onChange={e => void uploadFiles(e.target.files)}/></div>
    <div className="directory-actions"><span>当前目录操作</span><button disabled={busy || loading || !!error} onClick={() => { setName(''); setForm('folder'); }}><FolderPlus size={17}/>新建文件夹</button></div><div className="breadcrumbs"><button onClick={() => setLocation({ ...location, path: '' })}>{rootNames[location.root]}</button>{location.path.split('/').filter(Boolean).map((part, index, parts) => <span key={index}><ChevronRight size={12}/><button onClick={() => setLocation({ ...location, path: parts.slice(0, index + 1).join('/') })}>{part}</button></span>)}</div>
    {location.path && <button className="parent-folder" onClick={() => setLocation({ ...location, path: location.path.split('/').slice(0, -1).join('/') })}><ArrowLeft size={16}/>返回上一级</button>}
    {error ? <div className="error-banner">{error}<button onClick={() => setRefresh(v => v + 1)}>重试</button></div> : loading ? <div className="empty"><LoaderCircle className="spin"/><p>正在读取服务器目录…</p></div> : !filtered.length ? <div className="empty"><Folder size={38}/><h3>{search ? '没有找到文件' : '这个目录还是空的。'}</h3><p>{search ? '试试其他文件名' : '上传文件，或创建一个文件夹。'}</p></div> : <div className={'file-list ' + (grid ? 'grid-view' : '')}>{filtered.map(entry => <div key={entry.path} className={'file-row ' + (entry.directory ? 'is-folder' : '')}><button className="file-main" onClick={() => { if (entry.directory) setLocation({ root: entry.root, path: entry.path }); else setView(entry); }}><div className="file-icon"><FileIcon entry={entry}/></div><div className="file-label"><strong>{entry.name}</strong><span>{entry.directory ? '文件夹' : bytes(entry.size)} · {new Date(entry.modified).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></div>{entry.directory && <ChevronRight className="file-chevron" size={17}/>}</button><button className="icon-button" aria-label={'操作 ' + entry.name} onClick={() => setSelected(entry)}><MoreHorizontal size={19}/></button></div>)}</div>}
    <div className="folder-footer"><span>{entries.length} 个项目</span><button onClick={() => terminal(location)}><Code2 size={15}/>在此打开终端</button></div>
    </>}
    {manager && <FileModuleManager close={() => setManager(false)} changed={() => { setModuleId(undefined); setRefresh(v => v + 1); }}/>}
    {selected && !form && <Sheet title={selected.name} close={() => setSelected(undefined)}><div className="action-list">{!selected.directory && <><button onClick={() => { setView(selected); setSelected(undefined); }}><FileIcon entry={selected} size={19}/>打开预览</button><button onClick={() => { reference(selected); setSelected(undefined); }}><ArrowUpRight size={19}/>引用到 AI 对话</button><button onClick={() => void downloadFile(selected.root, selected.path).catch(e => toast(e.message))}><ArrowDownToLine size={19}/>下载文件</button></>}<button onClick={() => { setName(selected.path); setForm('move'); }}><Pencil size={19}/>重命名 / 移动</button>{selected.directory && <button onClick={() => { terminal(selected); setSelected(undefined); }}><Code2 size={19}/>在此打开终端</button>}</div></Sheet>}
    {form && <Sheet title={form === 'folder' ? '新建文件夹' : '重命名 / 移动'} close={() => setForm(undefined)}>{form === 'folder' && <p className="inline-note">创建位置：{rootNames[location.root]}{location.path ? '/' + location.path : ''}</p>}<label className="field">{form === 'folder' ? '文件夹名称' : `相对于「${rootNames[location.root]}」的目标路径`}<input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit(); }}/></label><button className="primary full" disabled={busy || !name.trim()} onClick={() => void submit()}><Check size={17}/>保存</button></Sheet>}
    {view && <FileViewer entry={view} close={() => setView(undefined)} reference={() => reference(view)} toast={toast}/>}
  </div>;
}
function FileViewer({ entry, close, reference, toast }: { entry: FileEntry; close: () => void; reference: () => void; toast: (s: string) => void }) {
  const rootNames = useRootNames();
  const [url, setUrl] = useState(''), [text, setText] = useState(''), [modified, setModified] = useState(0), [error, setError] = useState(''), [editing, setEditing] = useState(false), [saved, setSaved] = useState('');
  const kind = entry.mime.startsWith('image') ? 'image' : entry.mime.startsWith('video') ? 'video' : entry.mime.startsWith('audio') ? 'audio' : entry.mime === 'text/html' ? 'html' : entry.mime === 'application/pdf' ? 'pdf' : 'text';
  useEffect(() => {
    let live = true;
    void post<{ url: string }>('/api/files/preview', entry).then(v => { if (live) setUrl(origin + v.url); }).catch(e => { if (live) setError(e.message); });
    if (kind === 'text' || kind === 'html') void api<{ content: string; modified: number }>('/api/files/text?' + params(entry)).then(v => { if (live) { setText(v.content); setSaved(v.content); setModified(v.modified); } }).catch(e => { if (live && kind === 'text') setError(e.message); });
    return () => { live = false; };
  }, [entry.path, entry.root]);
  async function save() {
    try { const v = await api<{ modified: number }>('/api/files/text', { method: 'PUT', body: JSON.stringify({ ...entry, content: text, modified }) }); setModified(v.modified); setSaved(text); toast('已保存到服务器'); }
    catch(e) { toast(String(e)); }
  }
  return <div className="viewer" role="dialog" aria-modal="true" aria-label={'预览 ' + entry.name}><header><button className="icon-button" aria-label="关闭预览" onClick={() => { if (text !== saved && !confirm('修改尚未保存，确定关闭？')) return; close(); }}><X size={21}/></button><div><strong>{entry.name}</strong><span>{bytes(entry.size)} · {rootNames[entry.root]}</span></div><button className="icon-button" aria-label="下载文件" onClick={() => void downloadFile(entry.root, entry.path).catch(e => toast(e.message))}><ArrowDownToLine size={20}/></button></header><div className="viewer-actions"><button onClick={reference}><ArrowUpRight size={16}/>引用到对话</button>{['text', 'html'].includes(kind) && <button onClick={() => setEditing(!editing)}><Pencil size={16}/>{editing ? '预览' : '编辑源码'}</button>}{editing && <button disabled={text === saved} onClick={() => void save()}><Check size={16}/>保存修改</button>}</div><div className={'viewer-body ' + (kind === 'html' || editing ? 'fill' : '')}>
      {error ? <div className="empty"><File size={35}/><p>{error}</p><button className="primary" onClick={() => void downloadFile(entry.root, entry.path)}>下载原文件</button></div> : editing ? <textarea aria-label="文件内容" className="code-editor" value={text} onChange={e => setText(e.target.value)} spellCheck={false}/> : !url ? <LoaderCircle className="spin"/> : kind === 'image' ? <img src={url} alt={entry.name}/> : kind === 'video' ? <video src={url} controls playsInline preload="metadata"/> : kind === 'audio' ? <div className="audio-player"><FileAudio size={70}/><h3>{entry.name}</h3><audio src={url} controls preload="metadata"/></div> : kind === 'html' || kind === 'pdf' ? <iframe title={entry.name} src={url} sandbox="allow-scripts allow-downloads"/> : entry.name.endsWith('.md') ? <article className="markdown"><Markdown>{text}</Markdown></article> : <pre className="text-preview">{text}</pre>}
    </div></div>;
}
