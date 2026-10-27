import { useState } from 'react';
import { Check, ChevronRight, LoaderCircle, Plus, Server, Trash2 } from 'lucide-react';
import { forgetServer, isNative, setOrigin } from './api';
import { defaultOrigin, productName } from '../shared/config';
import { loadServers, normalizeOrigin, persistServers, type ServerProfile } from '../shared/servers';
import { Sheet } from './Files';

export function useServers() {
  const [catalog, setCatalog] = useState(() => loadServers(localStorage, isNative ? defaultOrigin : location.origin));
  const active = catalog.profiles.find(p => p.id === catalog.active)!;
  const update = (profiles: ServerProfile[], id: string) => { persistServers(localStorage, profiles, id); setCatalog({ profiles, active: id }); };
  function select(profile: ServerProfile) { setOrigin(profile.origin); update(catalog.profiles, profile.id); }
  function save(profile: ServerProfile) {
    if (catalog.profiles.some(p => p.id !== profile.id && p.origin === profile.origin)) throw new Error('该服务器地址已经添加');
    const profiles = catalog.profiles.some(p => p.id === profile.id) ? catalog.profiles.map(p => p.id === profile.id ? profile : p) : [...catalog.profiles, profile];
    if (profile.id === active.id) setOrigin(profile.origin);
    update(profiles, catalog.active);
  }
  async function remove(profile: ServerProfile) {
    if (catalog.profiles.length < 2) throw new Error('请至少保留一台服务器');
    await forgetServer(profile.origin);
    const profiles = catalog.profiles.filter(p => p.id !== profile.id), next = profile.id === active.id ? profiles[0] : active;
    setOrigin(next.origin); update(profiles, next.id);
  }
  return { ...catalog, active, select, save, remove };
}
export function Servers({ store, close }: { store: ReturnType<typeof useServers>; close: () => void }) {
  const [editing, setEditing] = useState<ServerProfile>(), [name, setName] = useState(''), [address, setAddress] = useState(''), [username, setUsername] = useState('ubuntu'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  function edit(profile?: ServerProfile) { setEditing(profile ?? { id: crypto.randomUUID(), name: '', origin: '', username: 'ubuntu' }); setName(profile?.name ?? ''); setAddress(profile?.origin ?? ''); setUsername(profile?.username ?? 'ubuntu'); setError(''); }
  function save(e: React.FormEvent) {
    e.preventDefault();
    try { store.save({ id: editing!.id, name: name.trim(), origin: normalizeOrigin(address), username: username.trim() }); setEditing(undefined); setError(''); }
    catch(e) { setError(String(e)); }
  }
  return <Sheet title={editing ? '服务器配置' : '我的服务器'} close={close}>
    {editing ? <form onSubmit={save}><label className="field">服务器名称<input value={name} onChange={e => setName(e.target.value)} maxLength={60} required placeholder="例如：Oracle 工作机"/></label><label className="field">服务器地址<input type="url" value={address} onChange={e => setAddress(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="https://server.example.com:28443" required/></label><label className="field">默认账号<input value={username} onChange={e => setUsername(e.target.value)} required maxLength={100}/></label><p className="inline-note">填写已部署 {productName} 的 HTTPS 地址。每台服务器单独登录，切换时后台任务继续运行。</p>{error && <div role="alert" className="error-banner">{error}</div>}<div className="session-confirm-actions"><button type="button" onClick={() => setEditing(undefined)}>返回列表</button><button className="primary"><Check size={17}/>保存服务器</button></div></form> : <>
      <div className="server-list">{store.profiles.map(profile => <div className="server-row" key={profile.id}><button className="server-select" onClick={() => { store.select(profile); close(); }}><span className="server-symbol"><Server size={21}/></span><span><strong>{profile.name}</strong><small>{profile.origin}</small></span>{profile.id === store.active.id ? <Check size={18}/> : <ChevronRight size={18}/>}</button><div className="server-row-actions"><button onClick={() => edit(profile)}>编辑</button><button aria-label={'移除服务器 ' + profile.name} disabled={busy || store.profiles.length < 2} onClick={async () => { if (!confirm(`仅移除本机的「${profile.name}」配置和登录信息？服务器上的文件与任务会保留。`)) return; setBusy(true); try { await store.remove(profile); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}><Trash2 size={15}/></button></div></div>)}</div>
      {error && <div role="alert" className="error-banner">{error}</div>}<button className="primary full" onClick={() => edit()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <Plus size={17}/>}添加服务器</button><p className="inline-note">切换后只显示所选服务器的会话、文件和终端。移除配置不卸载服务。</p>
    </>}
  </Sheet>;
}
