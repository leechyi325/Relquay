// The last page of each conversation, kept on the phone so reopening a long one shows it at once while the
// server re-reads the transcript. Always replaced by the server's answer; never trusted as the source of truth.
import type { ChatEvent } from '../shared/protocol';

const prefix = 'relquay.history:', indexKey = 'relquay.history.index', KEEP = 12, EVENTS = 40, BUDGET = 150_000;
const shown = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'error']);

function trim(event: ChatEvent): ChatEvent {
  const { toolResult: _output, optimistic: _unsent, ...rest } = event as ChatEvent & { toolResult?: unknown; optimistic?: unknown };
  const copy: ChatEvent = { ...rest };
  for (const field of ['content', 'text'] as const) if (typeof copy[field] === 'string' && copy[field].length > 6000) copy[field] = copy[field].slice(0, 6000);
  if (copy.toolInput !== undefined && JSON.stringify(copy.toolInput).length > 2000) copy.toolInput = {};
  return copy;
}
const read = <T,>(key: string, fallback: T): T => { try { const text = localStorage.getItem(key); return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };

export function readHistory(origin: string, sessionId: string): ChatEvent[] | undefined {
  const events = read<ChatEvent[] | null>(prefix + origin + ':' + sessionId, null);
  return Array.isArray(events) && events.length ? events : undefined;
}

export function writeHistory(origin: string, sessionId: string, events: ChatEvent[]) {
  const kept = events.filter(event => shown.has(event.kind) && !(event as { optimistic?: boolean }).optimistic).slice(-EVENTS).map(trim);
  if (!kept.length) return;
  let text = JSON.stringify(kept);
  while (text.length > BUDGET && kept.length > 4) { kept.shift(); text = JSON.stringify(kept); }
  const key = prefix + origin + ':' + sessionId;
  try {
    localStorage.setItem(key, text);
    const index = [key, ...read<string[]>(indexKey, []).filter(item => item !== key)];
    for (const old of index.splice(KEEP)) localStorage.removeItem(old);
    localStorage.setItem(indexKey, JSON.stringify(index));
  } catch { /* Storage full or unavailable: the conversation simply loads from the server. */ }
}

/** Removes cached conversations of one server, or of all servers. */
export function clearHistory(origin?: string) {
  try {
    const index = read<string[]>(indexKey, []), match = origin === undefined ? prefix : prefix + origin + ':';
    for (const key of index) if (key.startsWith(match)) localStorage.removeItem(key);
    localStorage.setItem(indexKey, JSON.stringify(index.filter(key => !key.startsWith(match))));
  } catch { /* Nothing to clear. */ }
}
