import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, Bell, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Clock3, Cpu, FolderOpen, GitBranch, HardDrive, Layers3, LoaderCircle, LogOut, MessageSquare, MoreHorizontal, Play, Plus, RefreshCw, Server, Settings2, ShieldCheck, Square, SquareTerminal } from 'lucide-react';
import { api, cloud, isNative, origin, openManager, post, restoreToken, saveToken, setOrigin } from './api';
import { UsagePanel } from './Usage';
import { Notifications, useInbox } from './Notifications';
import { nativeNotices } from './native-notices';
import type { Notice, NoticeTarget } from '../shared/notifications';
import { AgentManager } from './AgentManager';
import { Chat } from './Chat';
import { FilesPage, Sheet, bytes } from './Files';
import { Terminal } from './Terminal';
import { NewSession, SessionActions } from './Sessions';
import { appVersion, productName, productNameZh } from '../shared/config';
import { FileRootsProvider, useFileModules } from './file-roots';
import { Servers, useServers } from './Servers';
import type { ServerProfile } from '../shared/servers';
import { type Conversation, type FileEntry, type FileLocation, type Job, type Provider, type ServerStatus } from '../shared/protocol';

type Tab = 'work' | 'jobs' | 'files' | 'terminal';
const tabs = [{ id: 'work', label: '工作台', icon: MessageSquare }, { id: 'jobs', label: '任务', icon: Layers3 }, { id: 'files', label: '文件', icon: FolderOpen }, { id: 'terminal', label: '终端', icon: SquareTerminal }] as const;
const providerNames = { claude: 'Claude Code', codex: 'Codex' };
const statusNames: Record<Job['status'], string> = { queued: '等待中', running: '运行中', cancelling: '正在取消', cancelled: '已取消', succeeded: '已完成', failed: '失败', interrupted: '已中断' };

export function App() {
  const store = useServers(), [servers, setServers] = useState(false), [target, setTarget] = useState<NoticeTarget>();
  const latest = useRef(store); latest.current = store;
  useEffect(() => {
    if (!isNative) return; let live = true; let cleanup: (() => void) | undefined;
    const open = (value: Partial<NoticeTarget>) => { const profile = latest.current.profiles.find(profile => profile.origin === value.origin); if (live && profile && value.eventId) { latest.current.select(profile); setTarget({ origin: profile.origin, eventId: value.eventId }); void nativeNotices.consumeOpen({ eventId: value.eventId }); } };
    void nativeNotices.addListener('opened', open).then(listener => { if (live) cleanup = () => { void listener.remove(); }; else void listener.remove(); });
    void nativeNotices.getPendingOpen().then(open);
    return () => { live = false; cleanup?.(); };
  }, []);
  const profileKey = JSON.stringify(store.profiles.map(({ origin, name }) => ({ origin, name })));
  useEffect(() => { if (isNative) void nativeNotices.syncServers({ servers: JSON.parse(profileKey) }).catch(() => {}); }, [profileKey]);
  return <><Workspace key={store.active.id + store.active.origin} profile={store.active} profiles={store.profiles} target={target} clearTarget={() => setTarget(undefined)} manageServers={() => setServers(true)}/>{servers && <Servers store={store} close={() => setServers(false)}/>}</>;
}
function Workspace({ profile, profiles, target, clearTarget, manageServers }: { profile: ServerProfile; profiles: ServerProfile[]; target?: NoticeTarget; clearTarget: () => void; manageServers: () => void }) {
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [sessionActions, setSessionActions] = useState<Conversation>();
  const [agentConfig, setAgentConfig] = useState<Provider>();
  const [authenticated, setAuthenticated] = useState(false), [restoring, setRestoring] = useState(true), [tab, setTab] = useState<Tab>('work'), [status, setStatus] = useState<ServerStatus>(), [conversations, setConversations] = useState<Conversation[]>([]), [jobs, setJobs] = useState<Job[]>([]), [current, setCurrent] = useState<Conversation>(), [provider, setProvider] = useState<Provider>('claude'), [location, setLocation] = useState<FileLocation>({ root: 'project', path: '' }), [cwd, setCwd] = useState<FileLocation>({ root: 'project', path: '' }), [settings, setSettings] = useState(false), [newSession, setNewSession] = useState(false), [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({}), [notice, setNotice] = useState(''), [error, setError] = useState(''), [reference, setReference] = useState<FileEntry>(), [refreshing, setRefreshing] = useState(false);
  const [usage, setUsage] = useState(false), [notifications, setNotifications] = useState(false), [jobTarget, setJobTarget] = useState<string>();
  useEffect(() => { if (tab === 'terminal') setTerminalVisited(true); }, [tab]);
  const inbox = useInbox(authenticated);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((message: string) => { setNotice(message); clearTimeout(timer.current); timer.current = setTimeout(() => setNotice(''), 5000); }, []);
  useEffect(() => { const expired = (event: Event) => { if ((event as CustomEvent<string>).detail === origin) { setAuthenticated(false); setCurrent(undefined); } }; const signedIn = (event: Event) => { if ((event as CustomEvent<string>).detail === origin) setAuthenticated(true); }; window.addEventListener('studio:unauthorized', expired); window.addEventListener('studio:login', signedIn); return () => { window.removeEventListener('studio:unauthorized', expired); window.removeEventListener('studio:login', signedIn); }; }, []);
  useEffect(() => { let live = true; void restoreToken().then(async token => { if (live && token) { await api('/api/me'); if (live) setAuthenticated(true); } }).catch(() => { if (live) void saveToken(''); }).finally(() => { if (live) setRestoring(false); }); return () => { live = false; }; }, []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const results = await Promise.allSettled([
      api<ServerStatus>('/api/status').then(setStatus),
      cloud<{ conversations: Conversation[] }>('/providers/sessions/recent?limit=100').then(v => setConversations(v.conversations)),
      api<Job[]>('/api/jobs').then(setJobs),
    ]);
    const failure = results.find(v => v.status === 'rejected');
    setError(failure?.status === 'rejected' ? String(failure.reason) : ''); setRefreshing(false);
  }, []);
  useEffect(() => {
    if (!authenticated) return; void refresh();
    const interval = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 12000);
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', wake); };
  }, [authenticated, refresh]);
  useEffect(() => {
    if (!isNative) return;
    let cleanup: (() => void) | undefined;
    void import('@capacitor/app').then(async ({ App: NativeApp }) => {
      const listener = await NativeApp.addListener('backButton', () => {
        if (document.querySelector('.viewer .icon-button')) (document.querySelector('.viewer .icon-button') as HTMLButtonElement).click();
        else if (document.querySelector('.sheet header .icon-button')) (Array.from(document.querySelectorAll<HTMLButtonElement>('.sheet header .icon-button')).at(-1))?.click();
        else if (document.querySelector('.terminal-page.is-fullscreen')) document.querySelector<HTMLButtonElement>('[aria-label="退出终端全屏"]')?.click();
        else if (current) setCurrent(undefined);
        else if (tab !== 'work') setTab('work');
        else void NativeApp.minimizeApp();
      }); cleanup = () => { void listener.remove(); };
    }); return () => cleanup?.();
  }, [current, tab]);
  async function openNotice(item: Notice) {
    let targetConversation: Conversation | undefined;
    let targetJobs: Job[] | undefined;
    if (item.sessionId) targetConversation = await api<Conversation>('/api/conversations/' + encodeURIComponent(item.sessionId));
    else if (item.jobId) {
      targetJobs = await api<Job[]>('/api/jobs');
      if (!targetJobs.some(job => job.id === item.jobId)) throw new Error('对应任务已删除，请查看其他提醒');
    }
    if (!alive.current) return;
    await post(`/api/notifications/${item.id}/read`, {});
    if (!alive.current) return;
    setNotifications(false); setSettings(false); setUsage(false); setNewSession(false); setSessionActions(undefined);
    if (targetConversation) { setCurrent(targetConversation); setTab('work'); }
    else if (targetJobs) { setJobs(targetJobs); setJobTarget(item.jobId); setTab('jobs'); }
    void inbox.refresh();
  }
  const targetId = target?.origin === profile.origin ? target.eventId : undefined;
  useEffect(() => {
    if (!authenticated || !targetId) return; let live = true;
    void api<Notice>('/api/notifications/' + encodeURIComponent(targetId)).then(item => { if (live) return openNotice(item); }).catch(e => { if (live) { toast(String(e)); setNotifications(true); } }).finally(() => { if (live) clearTarget(); });
    return () => { live = false; };
  }, [authenticated, targetId]);
  function terminal(value: FileLocation) { setCwd(value); setTab('terminal'); }
  if (restoring) return <div className="launch"><img src="/brand.svg" alt={productName}/><span>正在连接工作台…</span></div>;
  if (!authenticated) return <Login profile={profile} manageServers={manageServers} done={() => setAuthenticated(true)}/>;
  return <FileRootsProvider><div className={"app-shell" + (current && tab === "work" ? " has-chat" : "")}>
    <aside className="desktop-rail"><a className="wordmark" href="#" onClick={e => { e.preventDefault(); setCurrent(undefined); setTab('work'); }}><img src="/brand.svg" alt=""/><span>{productName}<small>{productNameZh}</small></span></a><div className="rail-label">你的工作空间</div><nav>{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}><t.icon size={20}/>{t.label}{t.id === 'jobs' && jobs.some(j => j.status === 'running') && <span className="dot green"/>}</button>)}</nav><div className="rail-project"><span className="eyebrow">CURRENT PROJECT</span><h3>远程工作区</h3><p>项目与任务，随处接续。</p><span><GitBranch size={13}/> 服务器工作区</span></div><button className="rail-settings" onClick={() => setSettings(true)}><Settings2 size={19}/>工作台设置</button></aside>
    <main className={'main-content ' + (current && tab === 'work' ? 'chat-main' : '')}>
      <header className="top-bar"><button className="mobile-brand" onClick={() => { setCurrent(undefined); setTab('work'); }}><img src="/brand.svg" alt=""/><span>{productName}</span></button><div className="desktop-breadcrumb">工作空间 <ChevronRight size={13}/> <strong>{current && tab === 'work' ? current.sessionTitle : tabs.find(t => t.id === tab)?.label}</strong></div><div className="top-actions"><button aria-label="切换服务器" onClick={manageServers} className={'connection-pill server-switch ' + (status?.cloudcli ? 'online' : '')}><span className="dot"/>{profile.name}<ChevronDown size={12}/></button><button className="icon-button inbox-button" aria-label="打开提醒中心" onClick={() => setNotifications(true)}><Bell size={19}/>{!!inbox.page?.unread && <i>{inbox.page.unread > 99 ? '99+' : inbox.page.unread}</i>}</button><button className="avatar-button" aria-label="工作台设置" onClick={() => setSettings(true)}>RQ</button></div></header>
      {error && <div className="error-banner compact"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}
      {tab === 'work' && (current ? <Chat key={current.sessionId} conversation={current} back={() => { setCurrent(undefined); void refresh(); }} reference={reference} clearReference={() => setReference(undefined)} toast={toast} manage={() => setSessionActions(current)}/> : <div className="workspace-page">
        <div className="section-heading"><div><span className="eyebrow">YOUR REMOTE WORKSPACE</span><h1>工作，随时接续。</h1></div><button className="icon-button" aria-label="刷新工作台" onClick={() => void refresh()}><RefreshCw size={18} className={refreshing ? 'spin' : ''}/></button></div>
        <p className="muted workspace-subtitle">电脑不在身边，工作依然在线。</p>
        <section className="hero-card"><div className="hero-copy"><span className="hero-tag"><span className="dot"/> {productName.toUpperCase()}</span><h2>你的工作台，<br/>随时在场。</h2><p>连接 AI、文件与终端，继续手头的工作。</p><button onClick={() => setNewSession(true)}>开始新会话 <ArrowUpRight size={18}/></button></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-frame frame-back"/><div className="art-frame frame-mid"/><div className="art-frame frame-front"><img className="art-brand" src="/brand.svg" alt=""/><div className="art-timeline"><span/><span/><span/></div></div><span className="art-caption">AI → CODE → ACTION</span><div className="spark spark-one">✧</div><div className="spark spark-two">+</div></div></section>
        <div className="stats-row"><div><div className="stat-icon"><Server size={18}/></div><div><span>云端环境</span><strong>{status ? `${status.architecture.toUpperCase()} · ${Math.round(status.memoryTotal / 1024 ** 3)} GB` : '正在连接'}</strong></div></div><div><div className="stat-icon"><Activity size={18}/></div><div><span>后台任务</span><strong>{jobs.filter(j => j.status === 'running').length} 个运行中</strong></div></div><div className="stat-disk"><div className="stat-icon"><HardDrive size={18}/></div><div><span>剩余空间</span><strong>{status ? bytes(status.diskFree) : '—'}</strong></div></div></div>
        <div className="section-heading small"><h2>选择 AI 助手</h2><span className="quiet-label">在服务器上运行</span></div>
        <div className="provider-cards">{(['claude', 'codex'] as const).map(id => { const info = status?.providers.find(p => p.id === id); return <div key={id} className={'provider-card-group ' + id}><button onClick={() => { setProvider(id); setNewSession(true); }} className={'provider-card ' + id}><div className="provider-symbol">{id === 'claude' ? <span>✳</span> : <CodeMark/>}</div><div><h3>{providerNames[id]}</h3><p>{id === 'claude' ? '理解任务，协助规划与实现' : '编写代码，检查与执行任务'}</p><span className={info?.authorized ? 'provider-ready' : 'provider-pending'}><span className="dot"/>{!info ? '读取状态…' : !info.installed ? '尚未安装' : info.authorized ? '已授权，可开始' : '已安装，待账号授权'}</span></div><ArrowUpRight size={18}/></button><button className="provider-settings icon-button" aria-label={providerNames[id] + ' 设置'} title={providerNames[id] + ' 设置'} onClick={() => setAgentConfig(id)}><Settings2 size={18}/></button></div>; })}</div>
        <div className="section-heading small recent-heading"><h2>最近会话 <span>{conversations.length.toString().padStart(2, '0')}</span></h2><button className="text-button" onClick={() => setNewSession(true)}><Plus size={15}/>新建会话</button></div>
        {conversations.length ? <div className="conversation-list">{projectGroups(conversations).map((group, index) => { const open = expandedProjects[group.key] ?? index === 0; return <section className="project-group" key={group.key}><button className="project-header" aria-expanded={open} onClick={() => setExpandedProjects(value => ({ ...value, [group.key]: !open }))}><FolderOpen size={17}/><span className="conversation-label"><strong>{group.name}</strong><small>{group.items.length} 个会话{group.path ? ' · ' + group.path : ''}</small></span>{open ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}</button>{open && group.items.map(c => <div className="conversation-row" key={c.sessionId}><button className="conversation-open" onClick={() => { setCurrent(c); setProvider(c.provider); }}><span className={'session-icon ' + c.provider}>{c.provider === 'claude' ? '✳' : <CodeMark/>}</span><span className="conversation-label"><strong>{c.sessionTitle}</strong><small>{providerNames[c.provider]}</small></span><span className="session-time">{c.lastActivity ? new Date(c.lastActivity).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</span><ChevronRight size={16}/></button><button className="icon-button" aria-label={"会话操作 " + c.sessionTitle} onClick={() => setSessionActions(c)}><MoreHorizontal size={19}/></button></div>)}</section>; })}</div> : <div className="empty recent-empty"><MessageSquare size={28}/><h3>从一个新会话开始。</h3><p>让 AI 帮你阅读项目、编写代码或执行任务。</p><button className="text-button" onClick={() => setNewSession(true)}>新建第一个会话 <ArrowRight size={16}/></button></div>}
        <div className="workspace-note"><ShieldCheck size={15}/><span>项目与任务，由你的服务器管理。</span></div>
      </div>)}
      {tab === 'jobs' && <JobsPage target={jobTarget} clearTarget={() => setJobTarget(undefined)} jobs={jobs} refresh={refresh} toast={toast} openOutputs={() => { void api<{ id: string }[]>('/api/roots').then(roots => { setLocation({ root: roots.find(root => root.id === 'outputs')?.id ?? roots[0].id, path: '' }); setTab('files'); }).catch(e => toast(String(e))); }}/>}
      {tab === 'files' && <FilesPage location={location} setLocation={setLocation} terminal={terminal} reference={entry => { setReference(entry); setTab('work'); if (!current) setNewSession(true); }} toast={toast}/>}
      {(terminalVisited || tab === 'terminal') && <div className="terminal-container" hidden={tab !== 'terminal'}><Terminal active={tab === 'terminal'} cwd={cwd} status={status} toast={toast}/></div>}
    </main>
    {!(current && tab === 'work') && <nav className="bottom-nav" aria-label="主导航">{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}><span><t.icon size={21} strokeWidth={tab === t.id ? 2 : 1.6}/>{t.id === 'jobs' && jobs.some(j => j.status === 'running') && <i/>}</span>{t.label}</button>)}</nav>}
    {newSession && <NewSession provider={provider} setProvider={setProvider} initialCwd={location} close={() => setNewSession(false)} created={session => { setCurrent(session); setConversations(list => [session, ...list]); setTab('work'); setNewSession(false); }}/>}
    {sessionActions && <SessionActions conversation={sessionActions} updated={value => { setConversations(list => list.map(item => item.sessionId === value.sessionId ? value : item)); if (current?.sessionId === value.sessionId) setCurrent(value); setSessionActions(undefined); toast('会话名称已更新'); }} close={() => setSessionActions(undefined)} deleted={() => { const id = sessionActions.sessionId; setSessionActions(undefined); setConversations(list => list.filter(item => item.sessionId !== id)); if (current?.sessionId === id) setCurrent(undefined); toast('会话已删除，项目文件已保留'); void refresh(); }}/>}
    {usage && <UsagePanel close={() => setUsage(false)}/>}
    {notifications && <Notifications inbox={inbox} profiles={profiles} close={() => setNotifications(false)} open={openNotice} toast={toast}/>}
    {agentConfig && <AgentManager provider={agentConfig} close={() => setAgentConfig(undefined)} toast={toast}/>}
    {settings && <Sheet title="你的工作台" close={() => setSettings(false)}><div className="settings-server"><Server size={22}/><div><strong>{new URL(origin).hostname}</strong><span>{status?.hostname ?? '读取服务器信息…'}</span></div><span className="dot green"/></div><div className="settings-meters"><label>内存<span>{status ? `${bytes(status.memoryUsed)} / ${bytes(status.memoryTotal)}` : '—'}</span></label><progress max={status?.memoryTotal ?? 1} value={status?.memoryUsed ?? 0}/><label>CPU 负载<span>{status ? (status.cpu * 100).toFixed(0) + '%' : '—'}</span></label><progress max={1} value={status?.cpu ?? 0}/></div><div className="action-list"><button onClick={() => { setSettings(false); setUsage(true); }}><BarChart3 size={18}/>额度与 Token<ChevronRight size={16}/></button><button onClick={() => { setSettings(false); setNotifications(true); }}><Bell size={18}/>提醒与后台通知<ChevronRight size={16}/></button><button onClick={() => { setSettings(false); manageServers(); }}><Server size={18}/>管理与切换服务器<ChevronRight size={16}/></button><button onClick={() => { setSettings(false); setTab('terminal'); }}><SquareTerminal size={18}/>账号登录与服务器终端<ChevronRight size={16}/></button><button onClick={async () => { try { const address = origin; const v = await post<{ url: string }>('/api/filebrowser-link', {}); await openManager(address + v.url); } catch(e) { toast(String(e)); } }}><FolderOpen size={18}/>高级文件管理<ChevronRight size={16}/></button><button className="danger-text" onClick={async () => { const address = origin; try { await post('/api/logout', {}); } finally { await saveToken('', address); setAuthenticated(false); setSettings(false); } }}><LogOut size={18}/>退出登录</button></div><p className="version-note">{productName} · {appVersion}<br/>任务与提醒，随时接续</p></Sheet>}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div></FileRootsProvider>;
}
function projectGroups(items: Conversation[]) {
  const groups = new Map<string, { key: string; name: string; path?: string; items: Conversation[] }>();
  for (const item of items) {
    const key = item.projectPath ?? item.projectId ?? item.projectDisplayName;
    const group = groups.get(key) ?? { key, name: item.projectDisplayName, path: item.projectPath, items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()];
}
function CodeMark() { return <span className="code-mark">{'⌘'}</span>; }
function Login({ done, profile, manageServers }: { done: () => void; profile: ServerProfile; manageServers: () => void }) {
  const address = profile.origin; const [username, setUsername] = useState(profile.username), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setUsername(profile.username); setPassword(''); }, [profile.username]);
  async function login(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { setOrigin(address); const result = await post<{ token: string }>('/api/login', { username, password }); await saveToken(result.token, address); setPassword(''); if (origin === address) done(); }
    catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <div className="login-page"><div className="login-brand"><img src="/brand.svg" alt={`${productName} 标识`}/><strong>{productName}<span>{productNameZh}</span></strong></div><div className="login-card"><span className="eyebrow">YOUR WORKSPACE, ANYWHERE.</span><h1>工作不必等。<br/><span>工作台，随身带。</span></h1><p className="muted">连接你的服务器，继续手头的工作。</p><button className="login-server-button" onClick={manageServers}><Server size={17}/>{profile.name}<ChevronDown size={16}/></button><form onSubmit={e => void login(e)}><label className="field">服务器地址<div className="input-icon"><Server size={17}/><input type="url" autoCapitalize="none" autoCorrect="off" value={address} readOnly required/></div></label><label className="field">工作台账号<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required/></label><label className="field">密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="输入工作台密码" required/></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="primary full" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin"/> : <ArrowRight size={18}/>} {busy ? '正在连接…' : '进入工作台'}</button></form><div className="login-security"><ShieldCheck size={14}/>加密连接 · 每台服务器独立登录</div></div><footer>AI、终端与文件，随时掌握。</footer></div>;
}
function JobsPage({ jobs, refresh, toast, openOutputs, target, clearTarget }: { target?: string; clearTarget: () => void; jobs: Job[]; refresh: () => Promise<void>; toast: (s: string) => void; openOutputs: () => void }) {
  const { roots } = useFileModules();
  const [editing, setEditing] = useState<Job>(), [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState('all'), [selected, setSelected] = useState<Job>(), [log, setLog] = useState(''), [create, setCreate] = useState(false), [title, setTitle] = useState(''), [command, setCommand] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (!target) return; const job = jobs.find(job => job.id === target); if (job) { setSelected(job); setLog(''); } else toast('任务已移除或过期'); clearTarget(); }, [target, jobs]);
  useEffect(() => { if (!selected) return; let active = true; const load = () => void api<{ log: string }>(`/api/jobs/${selected.id}/log`).then(v => { if (active) setLog(v.log); }).catch(e => toast(String(e))); load(); const t = setInterval(load, 2000); return () => { active = false; clearInterval(t); }; }, [selected?.id]);
  useEffect(() => { const t = setInterval(() => void refresh(), 4000); return () => clearInterval(t); }, [refresh]);
  async function submit() {
    if (editing) {
      setBusy(true);
      try { const value = await api<Job>('/api/jobs/' + editing.id, { method: 'PUT', body: JSON.stringify({ title, ...(editing.status === 'queued' ? { command } : {}) }) }); setSelected(value); setCreate(false); setEditing(undefined); await refresh(); toast('任务已更新'); } catch(e) { toast(String(e)); } finally { setBusy(false); }
      return;
    }
    setBusy(true); try { await post('/api/jobs', { title, command, cwd: { root: roots.find(root => root.id === 'project')?.id ?? roots[0]?.id, path: '' } }); setCreate(false); setTitle(''); setCommand(''); await refresh(); toast('任务已加入队列'); } catch(e) { toast(String(e)); } finally { setBusy(false); }
  }
  const visible = jobs.filter(j => filter === 'all' || (filter === 'active' ? ['running', 'queued', 'cancelling'].includes(j.status) : !['running', 'queued', 'cancelling'].includes(j.status)));
  const currentJob = selected ? jobs.find(job => job.id === selected.id) ?? selected : undefined;
  return <div className="jobs-page"><div className="section-heading"><div><span className="eyebrow">GOOD THINGS TAKE A LITTLE TIME</span><h1>任务，在后台继续。</h1></div><button className="icon-button" aria-label="新建任务" onClick={() => { setEditing(undefined); setTitle(''); setCommand(''); setCreate(true); }}><Plus size={22}/></button></div><p className="muted">放下手机，服务器会接着把事情做好。</p><div className="jobs-summary"><div><span className="running-orbit"><Layers3 size={25}/></span><span><strong>{jobs.filter(j => j.status === 'running').length} <small>个任务正在运行</small></strong><p>单任务队列 · 为服务器留出余量</p></span></div><button aria-label="查看输出目录" onClick={openOutputs}><ArrowUpRight size={20}/></button></div><div className="filter-tabs">{[['all', '全部'], ['active', '进行中'], ['done', '已完成']].map(([id, label]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div>
    {visible.length ? <div className="job-list">{visible.map(job => <button className="job-card" key={job.id} onClick={() => { setSelected(job); setLog(''); }}><div className={'job-status-icon ' + job.status}>{job.status === 'running' || job.status === 'cancelling' ? <LoaderCircle className="spin" size={22}/> : job.status === 'succeeded' ? <Check size={22}/> : <Clock3 size={22}/>}</div><div><span className={'job-status ' + job.status}>{statusNames[job.status]}</span><h3>{job.title}</h3><p>{new Date(job.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {job.cwd.root}</p></div><ChevronRight size={17}/></button>)}</div> : <div className="empty jobs-empty"><Layers3 size={37}/><h3>这里还没有任务。</h3><p>提交检查、构建或其他命令，在这里查看进度。</p><button className="primary" onClick={() => { setEditing(undefined); setTitle(''); setCommand(''); setCreate(true); }}><Plus size={16}/>新建后台任务</button></div>}
    {create && <Sheet title={editing ? '编辑后台任务' : '新建后台任务'} close={() => { if (!busy) { setCreate(false); setEditing(undefined); } }}><label className="field">任务名称<input value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：运行项目检查"/></label><label className="field">执行命令<textarea aria-label="执行命令" readOnly={!!editing && editing.status !== 'queued'} value={command} onChange={e => setCommand(e.target.value)} rows={4} placeholder="命令将在项目目录中执行"/></label><button disabled={!!editing} className="recipe-button" onClick={() => { setTitle('检查运行环境'); setCommand('node --version; python3 --version; git --version; df -h .'); }}><Cpu size={16}/>填入环境检查命令</button><p className="inline-note">{editing ? '名称可随时修改；只有排队中的任务可以修改命令，已执行的命令保留为记录。' : '任务独立运行，关闭 App 后继续。日志与状态会保留。'}</p><button className="primary full" disabled={!title.trim() || !command.trim() || busy} onClick={() => void submit()}><Play size={16}/>{editing ? '保存修改' : '加入队列'}</button></Sheet>}
    {deleting && selected && <Sheet title="删除后台任务" close={() => { if (!busy) setDeleting(false); }}><p className="inline-note">删除「{currentJob?.title}」的任务记录与日志？输出文件会保留。排队中的任务删除后不会执行。</p><div className="interaction-actions"><button disabled={busy} onClick={() => setDeleting(false)}>保留任务</button><button disabled={busy} className="primary" onClick={async () => { setBusy(true); try { await api('/api/jobs/' + selected.id, { method: 'DELETE' }); setDeleting(false); setSelected(undefined); await refresh(); toast('任务已删除'); } catch(e) { toast(String(e)); } finally { setBusy(false); } }}>确认删除</button></div></Sheet>}
    {selected && !create && !deleting && <Sheet title={currentJob?.title ?? selected.title} close={() => setSelected(undefined)}><div className="job-detail-meta"><span>{statusNames[jobs.find(j => j.id === selected.id)?.status ?? selected.status]}</span><span>{selected.cwd.root}</span></div><pre className="job-command">$ {selected.command}</pre><pre className="job-log">{log || '等待任务输出…'}</pre><div className="job-detail-actions"><button onClick={() => { const job = currentJob!; setEditing(undefined); setTitle(job.title + ' · 副本'); setCommand(job.command); setCreate(true); }}>复制为新任务</button><button onClick={() => { const job = currentJob!; setEditing(job); setTitle(job.title); setCommand(job.command); setCreate(true); }}>编辑任务</button><button disabled={['running', 'cancelling'].includes(currentJob!.status)} className="danger-text" onClick={() => setDeleting(true)}>删除任务</button><button onClick={openOutputs}><FolderOpen size={16}/>查看输出</button>{['running', 'queued'].includes(jobs.find(j => j.id === selected.id)?.status ?? '') && <button className="danger-text" onClick={async () => { try { await post(`/api/jobs/${selected.id}/cancel`, {}); await refresh(); } catch(e) { toast(String(e)); } }}><Square size={14}/>取消任务</button>}</div></Sheet>}
  </div>;
}
