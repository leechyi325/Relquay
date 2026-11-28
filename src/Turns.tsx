import { useMemo, useState } from 'react';
import { ChevronDown, Paperclip, Search, Wrench } from 'lucide-react';
import type { ChatEvent } from '../shared/protocol';
import { buildTurns, plain } from '../shared/turns';
import { Sheet } from './Files';

const clock = (value?: string) => { const date = value ? new Date(value) : undefined; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
const cut = (text: string, length: number) => text.length > length ? text.slice(0, length) + '…' : text;

/** Question index: every question and a preview of its answer; tapping one scrolls the conversation to it. */
export function TurnSheet({ messages, hasMore, loading, loadEarlier, jump, close }: { messages: ChatEvent[]; hasMore: boolean; loading: boolean; loadEarlier: () => void; jump: (key: string) => void; close: () => void }) {
  const [search, setSearch] = useState(''), [open, setOpen] = useState<string>();
  const turns = useMemo(() => buildTurns(messages).reverse(), [messages]);
  const needle = search.trim().toLocaleLowerCase();
  const shown = needle ? turns.filter(turn => (turn.question + ' ' + turn.answer).toLocaleLowerCase().includes(needle)) : turns;
  return <Sheet title="问答目录" close={close}>
    <label className="turn-search"><Search size={16}/><input type="search" aria-label="搜索问答" placeholder="搜索已加载的问答" value={search} onChange={event => setSearch(event.target.value)}/></label>
    <ol className="turn-list">{shown.map(turn => {
      const expanded = open === turn.key;
      return <li key={turn.key} className={expanded ? 'expanded' : ''}>
        <button className="turn-main" onClick={() => { close(); jump(turn.key); }}>
          <span className="turn-meta">{clock(turn.time) && <b>{clock(turn.time)}</b>}{turn.tools > 0 && <small><Wrench size={11}/>{turn.tools}</small>}{turn.attachments > 0 && <small><Paperclip size={11}/>{turn.attachments}</small>}</span>
          <span className="turn-question">{cut(plain(turn.question), 160)}</span>
          <span className="turn-answer">{turn.answer ? cut(plain(turn.answer), 200) : '（暂无回答）'}</span>
        </button>
        <button className="icon-button turn-expand" aria-label={(expanded ? '收起预览：' : '预览问答：') + cut(plain(turn.question), 20)} aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : turn.key)}><ChevronDown size={16}/></button>
        {expanded && <div className="turn-preview"><h4>问</h4><p>{cut(turn.question, 1500)}</p><h4>答</h4><p>{turn.answer ? cut(turn.answer, 2500) : '（暂无回答）'}</p></div>}
      </li>;
    })}</ol>
    {!shown.length && <p className="inline-note">{needle ? '已加载的问答里没有匹配项。' : '还没有问答。'}</p>}
    {hasMore && <button className="secondary turn-more" disabled={loading} onClick={loadEarlier}>{loading ? '正在读取…' : '加载更早的问答'}</button>}
    <p className="inline-note">共 {turns.length} 个已加载的问答{hasMore ? '，更早的需要先加载' : ''}。</p>
  </Sheet>;
}
