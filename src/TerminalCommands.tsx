import { useState } from 'react';
import { Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { origin } from './api';
import { Sheet } from './Files';
import { savedCommands, type TerminalCommand } from '../shared/terminal';

export function TerminalCommands({ choose, toast }: { choose: (command: string) => void; toast: (text: string) => void }) {
  const [commands, setCommands] = useState(() => savedCommands(localStorage.getItem('studio.shortcuts:' + origin)));
  const [draft, setDraft] = useState<TerminalCommand>(), [removing, setRemoving] = useState(false);
  const existing = commands.some(item => item.id === draft?.id);
  function save(next: TerminalCommand[]) {
    try { localStorage.setItem('studio.shortcuts:' + origin, JSON.stringify(next)); setCommands(next); setDraft(undefined); }
    catch { toast('无法保存快捷命令，请检查设备存储空间'); }
  }
  return <div className="terminal-shortcuts">
    <div className="section-heading small"><h2>快捷命令</h2><button className="icon-button" aria-label="添加快捷命令" disabled={commands.length >= 50} onClick={() => { setRemoving(false); setDraft({ id: crypto.randomUUID(), name: '', command: '' }); }}><Plus size={18}/></button></div>
    <p className="inline-note">按服务器保存在此设备。点击填入编辑器，检查后执行。</p>
    {commands.length ? <div className="shortcut-list">{commands.map(item => <div className="shortcut-row" key={item.id}><button className="shortcut-use" onClick={() => choose(item.command)}><SquareTerminal size={17}/><span><strong>{item.name}</strong><code>{item.command}</code></span></button><button className="icon-button" aria-label={'编辑快捷命令 ' + item.name} onClick={() => { setRemoving(false); setDraft({ ...item }); }}><Pencil size={16}/></button></div>)}</div> : <p className="inline-note">还没有快捷命令，添加常用操作随手调用。</p>}
    {draft && <Sheet title={existing ? '编辑快捷命令' : '添加快捷命令'} close={() => setDraft(undefined)}><form onSubmit={e => { e.preventDefault(); save(existing ? commands.map(item => item.id === draft.id ? { ...draft, name: draft.name.trim() } : item) : [...commands, { ...draft, name: draft.name.trim() }]); }}><label className="field">命令名称<input aria-label="快捷命令名称" maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：检查服务状态"/></label><label className="field">命令内容<textarea aria-label="快捷命令内容" rows={5} maxLength={16000} value={draft.command} onChange={e => setDraft({ ...draft, command: e.target.value })} placeholder="支持多行命令" spellCheck={false}/></label><div className="interaction-actions">{existing && <button type="button" className="danger" onClick={() => { if (removing) save(commands.filter(item => item.id !== draft.id)); else setRemoving(true); }}><Trash2 size={16}/>{removing ? '确认删除' : '删除命令'}</button>}<button className="primary" disabled={!draft.name.trim() || !draft.command.trim()}>保存命令</button></div></form></Sheet>}
  </div>;
}
