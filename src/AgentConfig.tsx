import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { api } from './api';

import type { AgentConfig } from '../shared/agent-config';

export function AgentConfigEditor({ guard, toast, provider }: { guard: (check: (() => boolean) | undefined) => void; toast: (text: string) => void; provider: 'claude' | 'codex' }) {
  const [file, setFile] = useState<AgentConfig>(), [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const dirty = !!file && draft !== (!file.exists && file.provider === 'claude' ? '{}' : file.content);
  const discard = () => !dirty || confirm('配置修改尚未保存，确定放弃？');
  useEffect(() => { guard(() => !busy && (!dirty || confirm('配置修改尚未保存，确定放弃？'))); return () => guard(undefined); }, [busy, dirty, guard]);
  useEffect(() => {
    let live = true; setFile(undefined); setError(''); setBusy(true);
    void api<AgentConfig>('/api/agents/' + provider + '/config').then(value => { if (live) { setFile(value); setDraft(!value.exists && value.provider === 'claude' ? '{}' : value.content); } }).catch(e => { if (live) setError(String(e)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [provider, reload]);
  async function save() {
    if (!file) return; setBusy(true); setError('');
    try { const value = await api<AgentConfig>('/api/agents/' + provider + '/config', { method: 'PUT', body: JSON.stringify({ content: draft, revision: file.revision }) }); setFile(value); setDraft(!value.exists && value.provider === 'claude' ? '{}' : value.content); toast('配置已保存；如未生效，请重启对应代理'); }
    catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <div className="agent-config-section"><p className="inline-note">编辑当前服务器用户的全局配置。保存时校验 JSON/TOML 格式；生效时机取决于代理，必要时需重启。配置可能包含敏感值，请勿截图分享。</p>{error && <div className="error-banner">{error}</div>}{file && <><div className="config-path"><code>{file.path}</code><span>{file.exists ? '服务器文件' : '尚未创建，保存后创建'}</span></div><label className="field">{provider === 'codex' ? 'TOML 配置' : 'JSON 配置'}<textarea className="agent-config-editor" aria-label="代理配置内容" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={provider === 'codex' ? '# Codex config.toml' : '{}'} /></label></>}<div className="interaction-actions"><button disabled={busy} onClick={() => { if (discard()) setReload(value => value + 1); }}><RefreshCw size={16}/>重新读取</button><button className="primary" disabled={busy || !file || (!dirty && file.exists)} onClick={() => void save()}><Check size={16}/>{busy ? '处理中…' : '保存配置'}</button></div><p className="inline-note">仅编辑 config.toml / settings.json。项目级配置仍可通过文件模块编辑。</p></div>;
}
