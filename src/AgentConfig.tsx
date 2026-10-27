import { useEffect, useMemo, useState } from 'react';
import { Check, FileCode2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { api } from './api';
import { GuidedConfigFields } from './ConfigFields';
import { applyConfigFields, readConfigFields, type ConfigFields } from '../shared/config-fields';
import type { AgentConfig } from '../shared/agent-config';

export function AgentConfigEditor({ guard, toast, provider }: { guard: (check: (() => boolean) | undefined) => void; toast: (text: string) => void; provider: 'claude' | 'codex' }) {
  const [file, setFile] = useState<AgentConfig>(), [draft, setDraft] = useState(''), [fields, setFields] = useState<ConfigFields>(), [mode, setMode] = useState<'guided' | 'source'>('guided'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const contentOf = (file: AgentConfig) => !file.exists && file.provider === 'claude' ? '{}' : file.content;
  const baselineFields = useMemo(() => { try { return readConfigFields(provider, draft); } catch { return undefined; } }, [provider, draft]);
  const fieldDirty = mode === 'guided' && !!fields && JSON.stringify(fields) !== JSON.stringify(baselineFields);
  const dirty = !!file && (draft !== contentOf(file) || fieldDirty);
  const discard = () => !dirty || confirm('配置修改尚未保存，确定放弃？');
  useEffect(() => { guard(() => !busy && (!dirty || confirm('配置修改尚未保存，确定放弃？'))); return () => guard(undefined); }, [busy, dirty, guard]);
  useEffect(() => {
    let live = true; setFile(undefined); setError(''); setBusy(true);
    void api<AgentConfig>('/api/agents/' + provider + '/config').then(value => {
      if (!live) return; const source = contentOf(value); setFile(value); setDraft(source);
      try { setFields(readConfigFields(provider, source)); setMode('guided'); } catch { setMode('source'); setFields(undefined); }
    }).catch(e => { if (live) setError(String(e)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [provider, reload]);
  function switchMode(next: 'guided' | 'source') {
    if (next === mode) return;
    try {
      const source = mode === 'guided' && fields ? applyConfigFields(provider, draft, fields) : draft;
      const projected = readConfigFields(provider, source);
      setDraft(source); setFields(projected); setMode(next); setError('');
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function save() {
    if (!file || busy) return; setBusy(true); setError('');
    try {
      const content = mode === 'guided' && fields ? applyConfigFields(provider, draft, fields) : draft;
      const value = await api<AgentConfig>('/api/agents/' + provider + '/config', { method: 'PUT', body: JSON.stringify({ content, revision: file.revision }) });
      setFile(value); setDraft(contentOf(value)); setFields(readConfigFields(provider, contentOf(value)));
      (document.activeElement as HTMLElement | null)?.blur(); toast('配置已保存；如未生效，请重启对应代理');
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <div className="agent-config-section"><p className="inline-note">当前服务器用户的全局配置。填写常用字段或编辑完整源码，点击保存才写入；生效时机取决于代理。</p>{error && <div className="error-banner" role="alert">{error}</div>}{file && <><div className="config-path"><code>{file.path}</code><span>{file.exists ? '服务器文件' : '尚未创建，保存后创建'}</span></div><div className="config-mode-switch" role="group" aria-label="配置编辑方式"><button type="button" aria-pressed={mode === 'guided'} className={mode === 'guided' ? 'selected' : ''} disabled={busy} onClick={() => switchMode('guided')}><SlidersHorizontal size={16}/>引导填写</button><button type="button" aria-pressed={mode === 'source'} className={mode === 'source' ? 'selected' : ''} disabled={busy} onClick={() => switchMode('source')}><FileCode2 size={16}/>源码编辑</button></div>{mode === 'guided' && fields ? <GuidedConfigFields provider={provider} value={fields} change={value => { setFields(value); setError(''); }} disabled={busy}/> : <label className="field">{provider === 'codex' ? 'TOML 配置' : 'JSON 配置'}<textarea className="agent-config-editor" aria-label="代理配置内容" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={provider === 'codex' ? '# Codex config.toml' : '{}'} /></label>}</>}<div className="interaction-actions config-actions"><button disabled={busy} onClick={() => { if (discard()) setReload(value => value + 1); }}><RefreshCw size={16}/>重新读取</button><button className="primary" disabled={busy || !file || (!dirty && file.exists)} onClick={() => void save()}><Check size={16}/>{busy ? '处理中…' : '保存配置'}</button></div><p className="inline-note">保存校验 JSON/TOML 格式，不代表服务商连接可用。这里只编辑 config.toml / settings.json；登录仍由代理完成。</p></div>;
}
