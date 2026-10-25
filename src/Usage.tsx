import { useEffect, useState } from 'react';
import { BarChart3, Clock3, LoaderCircle, RefreshCw, ChevronRight } from 'lucide-react';
import { api } from './api';
import { Sheet } from './Files';
import type { AccountUsage, TokenSnapshot } from '../shared/usage';
export const tokenNumber = (value?: number) => value === undefined ? '—' : Intl.NumberFormat('zh-CN').format(value);
const providerNames = { claude: 'Claude Code', codex: 'Codex' };
function windowName(minutes?: number) { return minutes === undefined ? '额度窗口' : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${minutes / 60} 小时` : `${minutes / 1440} 天`; }
export function UsagePanel({ close, sessionId }: { close: () => void; sessionId?: string }) {
  const [accounts, setAccounts] = useState<AccountUsage[]>([]), [snapshot, setSnapshot] = useState<TokenSnapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reason, setReason] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true; setBusy(true); setError('');
    const accounts = api<{ accounts: AccountUsage[] }>('/api/usage/accounts').then(data => { if (live) setAccounts(data.accounts); });
    const usage = sessionId ? api<{ snapshot: TokenSnapshot | null; reason?: string }>('/api/usage/sessions/' + sessionId).then(data => { if (live) { setSnapshot(data.snapshot); setReason(data.reason ?? ''); } }) : Promise.resolve();
    void Promise.allSettled([accounts, usage]).then(results => { if (live) { const failure = results.find(result => result.status === 'rejected'); setError(failure?.status === 'rejected' ? String(failure.reason) : ''); setBusy(false); } });
    return () => { live = false; };
  }, [sessionId, refresh]);
  return <Sheet title="额度与 Token" close={close}><div className="usage-heading"><p>当前服务器上的账号 · 实际返回数据</p><button className="icon-button" aria-label="刷新用量" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={18} className={busy ? 'spin' : ''}/></button></div>{busy && !accounts.length && <div className="empty"><LoaderCircle className="spin"/><p>正在读取账号额度…</p></div>}{error && <div className="error-banner" role="alert">{error}</div>}
    {accounts.map(account => <section className="quota-card" key={account.provider}><div className="quota-title"><span className={'quota-symbol ' + account.provider}>{account.provider === 'claude' ? '✳' : '⌘'}</span><div><h3>{providerNames[account.provider]}</h3><small>{new Date(account.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</small></div><span className={'quota-state ' + account.status}>{account.status === 'unavailable' ? '暂不可用' : account.status === 'partial' ? '部分数据' : '已报告'}</span></div>{account.windows.length ? account.windows.map(window => <div className="quota-window" key={window.id}><div><strong>{window.durationMinutes ? windowName(window.durationMinutes) : window.name}</strong><span>剩余 <b>{Math.max(0, 100 - window.usedPercent).toFixed(0)}%</b></span></div><progress max={100} value={Math.max(0, 100 - window.usedPercent)} className={window.usedPercent >= 90 ? 'low-quota' : ''}/><footer><span>{window.name} · 已用 {window.usedPercent.toFixed(0)}%</span>{window.resetsAt && <span><Clock3 size={11}/>{new Date(window.resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置</span>}</footer></div>) : <p className="quota-unavailable">{account.reason ?? '当前登录方式未提供额度窗口'}</p>}{account.lifetimeTokens !== undefined && <div className="account-token-total"><span>账号累计 Token</span><strong>{tokenNumber(account.lifetimeTokens)}</strong></div>}{account.credits && <p className="usage-footnote">额外额度：{account.credits.unlimited ? '不限量' : account.credits.balance ?? (account.credits.hasCredits ? '有可用额度，余额未提供' : '无可用额外额度')}</p>}{account.daily?.length ? <div className="daily-usage"><span>最近报告的每日 Token</span>{account.daily.slice(-7).map(day => <div key={day.date}><span>{day.date}</span><strong>{tokenNumber(day.tokens)}</strong></div>)}</div> : null}<p className="usage-source">{account.source}</p></section>)}
    {sessionId && <section className="session-token-card"><div className="section-heading small"><h3>本会话 Token</h3><BarChart3 size={19}/></div>{snapshot ? <TokenDetails snapshot={snapshot}/> : <p className="quota-unavailable">{reason || '尚未报告会话用量'}</p>}</section>}
    <p className="inline-note">额度窗口不是 Token 余额。账号接口最多每分钟更新一次；未返回的数据显示「—」。这里不会估算费用，也不会消耗重置额度。</p>
  </Sheet>;
}
function TokenDetails({ snapshot }: { snapshot: TokenSnapshot }) {
  const rows = [['输入', snapshot.inputTokens], ['输出', snapshot.outputTokens], ['缓存命中', snapshot.cachedInputTokens], ['缓存写入', snapshot.cacheWriteTokens], ['思考', snapshot.reasoningTokens]] as const;
  return <><div className="token-total"><span>{snapshot.scope === 'thread' ? '会话累计 Token' : '最近报告的上下文 Token'}</span><strong>{tokenNumber(snapshot.scope === 'thread' ? snapshot.totalTokens : snapshot.contextTokens)}</strong></div><div className="token-breakdown">{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{tokenNumber(value)}</strong></div>)}</div>{snapshot.contextWindow !== undefined && <p className="usage-footnote">模型上下文窗口 {tokenNumber(snapshot.contextWindow)} Token</p>}<p className="usage-footnote">缓存命中包含在输入中，思考 Token 包含在输出中；各项不重复相加。{snapshot.scope === 'context' && 'Claude 当前数据是上下文快照，不能当作累计账单。'}</p><p className="usage-source">{snapshot.source} · {new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN')}</p></>;
}
export function SessionTokenButton({ sessionId, changed }: { sessionId: string; changed: number }) {
  const [snapshot, setSnapshot] = useState<TokenSnapshot | null>(null), [open, setOpen] = useState(false);
  useEffect(() => { let live = true; void api<{ snapshot: TokenSnapshot | null }>('/api/usage/sessions/' + sessionId).then(data => { if (live) setSnapshot(data.snapshot); }).catch(() => {}); return () => { live = false; }; }, [sessionId, changed]);
  return <><button className="session-token-button" aria-label="查看本会话 Token 与额度" onClick={() => setOpen(true)}><BarChart3 size={13}/><span>{snapshot ? `${tokenNumber(snapshot.totalTokens ?? snapshot.contextTokens)} Token${snapshot.scope === 'context' ? ' · 上下文' : ''}` : 'Token 与额度'}</span><ChevronRight size={12}/></button>{open && <UsagePanel sessionId={sessionId} close={() => setOpen(false)}/>}</>;
}
