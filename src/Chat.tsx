import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, File, FolderOpen, LoaderCircle, MoreHorizontal, Paperclip, Server, Settings2, ShieldCheck, ShieldOff, Sparkles, Square, SquareTerminal, Upload, X } from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';
import { presentEvents } from '../shared/chat-presentation';
import { api, origin } from './api';
import { useChat } from './useChat';
import { Sheet, bytes } from './Files';
import { useConversationPath } from './Sessions';
import { SessionTokenButton } from './Usage';
import { Interactions } from './Interactions';
import { ServerFilePicker } from './ChatFiles';
import type { DocEntry } from '../shared/extensions';
import type { AgentModel, ChatAttachment, ChatEvent, Conversation, FileEntry } from '../shared/protocol';
const names = { claude: 'Claude Code', codex: 'Codex' };
const permissionLabels = {
  default: { name: '每次询问', short: '', detail: () => '执行命令、改文件前都等你批准（推荐）' },
  acceptEdits: { name: '自动批准编辑', short: '免批准', detail: (provider: string) => provider === 'codex' ? '不再询问；仍限制在工作区沙箱内，越界操作会直接失败' : '文件编辑自动通过，其余操作仍需你批准' },
  bypassPermissions: { name: '完全免审批', short: '免审批', detail: (provider: string) => provider === 'codex' ? '不询问且取消沙箱，AI 可访问服务器任意位置' : '跳过所有批准，AI 可直接执行任何命令' }
};
const effortNames: Record<string, string> = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultracode: 'Ultracode' };
export function Chat({ conversation, back, reference, clearReference, toast, manage }: { conversation: Conversation; back: () => void; reference?: FileEntry; clearReference: () => void; toast: (s: string) => void; manage: () => void }) {
  const projectPath = useConversationPath(conversation), chat = useChat(conversation.sessionId, conversation.provider);
  const key = 'roamdeck.model:' + origin + ':' + conversation.sessionId;
  const [draft, setDraft] = useState(''), [details, setDetails] = useState(false), [model, setModel] = useState(''), [effort, setEffort] = useState(''), [models, setModels] = useState<AgentModel[]>([]), [modelError, setModelError] = useState(''), [configuration, setConfiguration] = useState(false), [filesMenu, setFilesMenu] = useState(false), [serverFiles, setServerFiles] = useState(false), [attachments, setAttachments] = useState<ChatAttachment[]>([]), [uploading, setUploading] = useState('');
  const upload = useRef<HTMLInputElement>(null), abort = useRef<AbortController>(null), bottom = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), pinned = useRef(true);
  const selected = models.find(item => item.id === model) ?? models.find(item => item.isDefault);
  const modeKey = 'relquay-permission-' + conversation.provider, [permission, setPermission] = useState<'default' | 'acceptEdits' | 'bypassPermissions'>(() => { const value = localStorage.getItem(modeKey); return value === 'acceptEdits' || value === 'bypassPermissions' ? value : 'default'; }), [permissionSheet, setPermissionSheet] = useState(false);
  const [commands, setCommands] = useState<DocEntry[]>([]);
  useEffect(() => { let live = true; void api<DocEntry[]>(`/api/agents/${conversation.provider}/docs/commands`).then(list => { if (live) setCommands(list); }).catch(() => {}); return () => { live = false; }; }, [conversation.provider]);
  const slash = /^\/([\w.-]*)$/.exec(draft), suggestions = slash ? commands.filter(item => item.name.toLowerCase().startsWith(slash[1].toLowerCase())).slice(0, 6) : [];
  async function loadModels() { try { const data = await api<{ models: AgentModel[] }>(`/api/agents/${conversation.provider}/models`); setModels(data.models); setModelError(''); } catch(e) { setModelError(String(e)); } }
  useEffect(() => { let live = true; void api<{ models: AgentModel[] }>(`/api/agents/${conversation.provider}/models`).then(data => { if (live) { setModels(data.models); setModelError(''); try { const saved = JSON.parse(localStorage.getItem(key) ?? '{}'); const selected = saved.model ? data.models.find(item => item.id === saved.model) : data.models.find(item => item.isDefault); if (selected) { setModel(saved.model || ''); if (selected.efforts.includes(saved.effort)) setEffort(saved.effort); } } catch { /* Default settings remain usable. */ } } }).catch(e => { if (live) setModelError(String(e)); }); return () => { live = false; abort.current?.abort(); }; }, [conversation.provider, key]);
  useEffect(() => { if (pinned.current) bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat.events.length, chat.processing, chat.permissions.length]);
  function addFiles(files: ChatAttachment[]) { setAttachments(current => { const combined = [...current, ...files.filter(file => !current.some(item => item.id === file.id))]; if (combined.length > 10) toast('每条消息最多添加 10 个附件'); return combined.slice(0, 10); }); }
  useEffect(() => { if (reference) { addFiles([{ id: reference.root + ':' + reference.path, name: reference.name, size: reference.size, mime: reference.mime, reference: { root: reference.root, path: reference.path }, source: 'server' }]); clearReference(); } }, [reference]);
  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const controller = new AbortController(); abort.current = controller;
    try {
      const list = Array.from(files); if (list.length + attachments.length > 10) throw new Error('每条消息最多添加 10 个附件');
      for (const file of list) {
        if (file.size > 512 * 1024 * 1024) throw new Error(file.name + ' 超过 512MB');
        setUploading(file.name); const body = new FormData(); body.append('file', file);
        const timeout = AbortSignal.timeout(600000), signal = AbortSignal.any([controller.signal, timeout]);
        const attachment = await api<ChatAttachment>('/api/chat/attachments', { method: 'POST', body, signal });
        if (!controller.signal.aborted) addFiles([attachment]);
      }
    } catch(e) { toast(controller.signal.aborted ? '已取消上传，已完成的附件会保留' : String(e)); }
    finally { setUploading(''); if (upload.current) upload.current.value = ''; }
  }
  function send() {
    if ((!draft.trim() && !attachments.length) || uploading) return;
    try { chat.message(draft.trim() || '请查看所附文件。', { permissionMode: permission, ...(model ? { model } : {}), ...(effort ? { effort } : {}), attachments: attachments.map(file => file.reference) }, attachments); localStorage.setItem(key, JSON.stringify({ model, effort })); setDraft(''); setAttachments([]); pinned.current = true; }
    catch(e) { toast(String(e)); }
  }
  const messages = presentEvents(chat.events), failure = chat.events.findLast(event => event.kind === 'interaction_error');
  return <div className="chat-page"><div className="chat-heading"><button className="icon-button" aria-label="返回工作台" onClick={back}><ArrowLeft size={20}/></button><div><h2>{conversation.sessionTitle}</h2><span>{names[conversation.provider]} <i/> {chat.connected ? chat.permissions.length ? '等待你的回应' : chat.processing ? '正在工作' : '已连接' : '正在重连'}</span></div><SessionTokenButton sessionId={conversation.sessionId} changed={chat.events.filter(event => event.kind === 'complete' || event.kind === 'token_usage' || event.tokenBudget).length}/><button className="icon-button" aria-label="会话信息" onClick={() => setDetails(true)}><MoreHorizontal size={21}/></button></div>
    <div className="chat-scroll" ref={scroll} onScroll={() => { if (scroll.current) pinned.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100; }}>
      {chat.hasMore && <button className="history-more" disabled={chat.loadingHistory} onClick={() => { pinned.current = false; const node = scroll.current, height = node?.scrollHeight ?? 0, top = node?.scrollTop ?? 0; void chat.loadEarlier().then(() => requestAnimationFrame(() => { if (node) node.scrollTop = top + node.scrollHeight - height; })); }}>{chat.loadingHistory ? '正在读取…' : '加载更早的消息'}</button>}
      {!messages.length && <div className="chat-welcome"><div className={'welcome-symbol ' + conversation.provider}>{conversation.provider === 'claude' ? '✳' : '⌘'}</div><span className="eyebrow">LET'S GET TO WORK</span><h2>这次，想完成什么？</h2><p>描述目标，或添加手机和服务器上的文件。</p><div className="prompt-chips">{['检查项目，说明当前结构与状态', '帮我规划并实现一个新功能', '检查代码，提出修复与改进建议'].map(prompt => <button key={prompt} onClick={() => setDraft(prompt)}>{prompt}<ArrowUpRight size={15}/></button>)}</div></div>}
      {groupTools(messages).map((entry, index) => Array.isArray(entry) ? <ToolGroup key={entry[0].id ?? 'g' + index} events={entry}/> : <Message key={entry.id ?? index} message={entry}/>)}
      {chat.processing && !chat.permissions.length && <div className="working-state"><span className="thinking-dots"><i/><i/><i/></span><span>正在处理，离开页面后任务继续。</span></div>}
      {chat.error && <div className="error-banner">{chat.error}</div>}<div ref={bottom}/>
    </div>
    <Interactions permissions={chat.permissions} connected={chat.connected} send={chat.send} toast={toast} failure={failure}/>
    <div className="composer-wrap"><div className="attachment-chips">{attachments.map(file => <div className="attachment-chip" key={file.id}><span>{file.source === 'phone' ? <Upload size={16}/> : <Server size={16}/>}</span><span><strong>{file.name}</strong><small>{file.source === 'phone' ? '手机已上传' : '服务器文件'} · {bytes(file.size)}</small></span><button className="icon-button" aria-label={'移除附件 ' + file.name} onClick={() => setAttachments(current => current.filter(item => item.id !== file.id))}><X size={15}/></button></div>)}</div>{uploading && <div className="uploading-state" role="status"><LoaderCircle size={16} className="spin"/><span>正在上传 {uploading}</span><button onClick={() => abort.current?.abort()}>取消上传</button></div>}
      {suggestions.length > 0 && <div className="slash-menu" role="listbox" aria-label="自定义命令">{suggestions.map(item => <button key={item.name} role="option" aria-selected="false" onClick={() => setDraft('/' + item.name + ' ')}><strong>/{item.name}{item.hint ? ' ' + item.hint : ''}</strong><small>{item.description}</small></button>)}</div>}
      <div className="composer"><textarea aria-label="给 AI 的消息" placeholder="描述任务，或添加文件…" value={draft} onChange={e => setDraft(e.target.value)} rows={2} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}/><footer><button className="composer-attach" aria-label="添加对话附件" disabled={!!uploading || attachments.length >= 10} onClick={() => setFilesMenu(true)}><Paperclip size={20}/></button><button className="model-config-button" aria-label="模型与思考设置" onClick={() => setConfiguration(true)}><Settings2 size={14}/><span>{model ? selected?.name ?? model : '服务器默认'}{effort ? ' · ' + (effortNames[effort] ?? effort) : ''}</span><ChevronDown size={12}/></button><button className={'permission-button ' + permission} aria-label={'审批模式：' + permissionLabels[permission].name} onClick={() => setPermissionSheet(true)}>{permission === 'default' ? <ShieldCheck size={15}/> : <ShieldOff size={15}/>}{permission !== 'default' && <span>{permissionLabels[permission].short}</span>}</button>{chat.processing ? <button className="send-button stop" aria-label="停止 AI" onClick={() => { try { chat.send({ type: 'chat.abort', sessionId: conversation.sessionId }); } catch(e) { toast(String(e)); } }}><Square size={16} fill="currentColor"/></button> : <button className="send-button" aria-label="发送消息" disabled={(!draft.trim() && !attachments.length) || !chat.connected || !!uploading} onClick={send}><ArrowUp size={21}/></button>}</footer></div><p className="composer-note"><FolderOpen size={11}/>{conversation.projectDisplayName} · AI 在当前服务器上工作</p><input ref={upload} hidden type="file" multiple onChange={e => void uploadFiles(e.target.files)}/>
    </div>
    {permissionSheet && <Sheet title="审批模式" close={() => setPermissionSheet(false)}><div className="permission-choices">{(Object.keys(permissionLabels) as (keyof typeof permissionLabels)[]).map(id => <button key={id} className={permission === id ? 'selected ' + id : id} onClick={() => { setPermission(id); localStorage.setItem(modeKey, id); setPermissionSheet(false); toast('审批模式：' + permissionLabels[id].name + '，从下一条消息生效'); }}><strong>{permissionLabels[id].name}{permission === id && <Check size={15}/>}</strong><small>{permissionLabels[id].detail(conversation.provider)}</small></button>)}</div><p className="inline-note">选择只对此代理在本机生效，下一条消息起使用。运行中的一轮不受影响，已弹出的批准仍需处理。免审批时 AI 可直接执行命令和改文件，请只在可信项目里使用。</p></Sheet>}
    {filesMenu && <Sheet title="添加对话文件" close={() => setFilesMenu(false)}><div className="action-list"><button onClick={() => { setFilesMenu(false); upload.current?.click(); }}><Upload size={20}/><span>从手机上传<small>系统文件选择器 · 每个文件最多 512MB</small></span><ChevronRight size={17}/></button><button onClick={() => { setFilesMenu(false); setServerFiles(true); }}><Server size={20}/><span>选择服务器文件<small>从当前服务器的文件模块选择</small></span><ChevronRight size={17}/></button></div><p className="inline-note">PNG、JPEG、WebP、GIF 可作为图片输入，图片最多 20MB；其他文件提供服务器路径，由代理按任务读取。</p></Sheet>}
    {serverFiles && <ServerFilePicker close={() => setServerFiles(false)} choose={files => { addFiles(files); setServerFiles(false); }}/>}
    {configuration && <Sheet title="模型与思考程度" close={() => setConfiguration(false)}><p className="inline-note">选项来自当前服务器。变更从下一条消息生效，运行中请先等待或停止。</p>{modelError && <div className="error-banner">{modelError}<button onClick={() => void loadModels()}>重新读取</button></div>}<fieldset className="model-choices" disabled={chat.processing}><legend>选择模型</legend><div role="group" aria-label="选择模型">{[{ id: '', name: '服务器默认模型', description: '沿用当前服务器的默认设置' }, ...models].map(item => <button type="button" key={item.id} aria-pressed={model === item.id} className={model === item.id ? 'selected' : ''} onClick={() => { setModel(item.id); setEffort(''); }}><span><strong>{item.name}</strong><small>{item.description || item.id}</small></span><span className="answer-indicator">{model === item.id && <Check size={14}/>}</span></button>)}</div></fieldset>{selected?.description && <p className="model-description">{selected.description}</p>}{selected?.efforts.length ? <fieldset className="effort-choices" disabled={chat.processing}><legend>思考程度</legend><div><button type="button" aria-pressed={!effort} className={!effort ? 'selected' : ''} onClick={() => setEffort('')}>默认{selected.defaultEffort ? ` · ${effortNames[selected.defaultEffort] ?? selected.defaultEffort}` : ''}</button>{selected.efforts.map(value => <button type="button" key={value} aria-pressed={effort === value} className={effort === value ? 'selected' : ''} onClick={() => setEffort(value)}>{effortNames[value] ?? value}</button>)}</div></fieldset> : <p className="muted">此模型未提供可调的思考程度。</p>}<button className="primary full" onClick={() => { localStorage.setItem(key, JSON.stringify({ model, effort })); setConfiguration(false); }}><Check size={17}/>完成设置</button><p className="inline-note">目录展示不代表账号已获模型使用权限，实际调用结果以服务器返回为准。</p></Sheet>}
    {details && <Sheet title="会话信息" close={() => setDetails(false)}><dl className="session-info"><dt>代理</dt><dd>{names[conversation.provider]}</dd><dt>会话</dt><dd>{conversation.sessionId}</dd><dt>服务器</dt><dd>{origin}</dd><dt>模型</dt><dd>{model ? selected?.name ?? model : '服务器默认'}</dd><dt>思考程度</dt><dd>{effortNames[effort] ?? (effort || '模型默认')}</dd><dt>工作区</dt><dd>{projectPath || '读取目录…'}</dd></dl><div className="action-list"><button onClick={() => { setDetails(false); manage(); }}>重命名 / 管理会话<ChevronRight size={16}/></button></div></Sheet>}
  </div>;
}
const isTool = (event: ChatEvent) => event.kind === 'tool_use' || event.kind === 'tool_result';
/** 连续的工具调用/结果合并成一组，避免长任务刷屏。 */
function groupTools(messages: ChatEvent[]): (ChatEvent | ChatEvent[])[] {
  const out: (ChatEvent | ChatEvent[])[] = [];
  for (const message of messages) {
    if (!isTool(message)) { out.push(message); continue; }
    const last = out.at(-1);
    if (Array.isArray(last)) last.push(message); else out.push([message]);
  }
  return out;
}
function toolSummary(event: ChatEvent) {
  const input = event.toolInput && typeof event.toolInput === 'object' ? event.toolInput as Record<string, unknown> : {};
  const text = [input.command, input.file_path, input.path, input.pattern, input.url, input.description].find(value => typeof value === 'string') as string | undefined;
  return (text ?? event.content ?? event.text ?? '').split('\n')[0].slice(0, 80);
}
function ToolGroup({ events }: { events: ChatEvent[] }) {
  const calls = events.filter(event => event.kind === 'tool_use');
  if (events.length === 1) return <Message message={events[0]}/>;
  const names = [...new Set(calls.map(event => event.toolName ?? '工具'))].slice(0, 3).join('、');
  return <details className="tool-event tool-group"><summary><span><SquareTerminal size={15}/></span>{calls.length || events.length} 次工具调用{names && ` · ${names}`}<ChevronDown size={14}/></summary><div className="tool-group-list">{events.map((event, index) => event.kind === 'tool_use'
    ? <details key={event.id ?? index} className="tool-row"><summary><strong>{event.toolName ?? '工具调用'}</strong><span>{toolSummary(event)}</span></summary><pre>{JSON.stringify(event.toolInput ?? event, null, 2)}</pre></details>
    : <details key={event.id ?? index} className="tool-row result"><summary><strong>结果</strong><span>{toolSummary(event)}</span></summary><pre>{event.content ?? event.text ?? JSON.stringify(event.toolResult ?? event, null, 2)}</pre></details>)}</div></details>;
}
function Message({ message }: { message: ChatEvent }) {
  if (['text', 'stream_delta'].includes(message.kind)) return <article className={'message ' + (message.role === 'user' ? 'user-message' : 'assistant-message')}><span className="message-author">{message.role === 'user' ? '你' : 'AI 助手'}</span><ChatMarkdown content={message.content ?? message.text ?? ''}/>{Array.isArray(message.attachments) && <div className="message-attachments">{message.attachments.map((file, i) => <span key={i}><File size={13}/>{String(file.name ?? '附件')}</span>)}</div>}</article>;
  if (message.kind === 'thinking') return <details className="thinking-event"><summary><Sparkles size={16}/><strong>{message.channel === 'reasoning' ? '思考过程' : '思考摘要'}</strong><span>{(message.content ?? '').length.toLocaleString()} 字</span><ChevronDown size={15}/></summary><div className="thinking-content"><ChatMarkdown content={message.content ?? message.text ?? ''}/><p className="thinking-source">显示代理实际返回的思考内容</p></div></details>;
  const label = message.kind === 'tool_use' ? message.toolName ?? '工具调用' : message.kind === 'tool_result' ? '工具结果' : message.kind === 'error' ? '运行出错' : message.kind === 'status' ? '运行状态' : message.kind;
  return <details className={'tool-event ' + (message.kind === 'error' ? 'error-event' : '')}><summary><span>{message.kind === 'thinking' ? <Sparkles size={15}/> : <SquareTerminal size={15}/>}</span>{label}<ChevronDown size={14}/></summary><pre>{message.content ?? message.text ?? JSON.stringify(message.toolInput ?? message.toolResult ?? message, null, 2)}</pre></details>;
}
