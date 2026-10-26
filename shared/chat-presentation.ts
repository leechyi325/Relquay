import type { ChatEvent } from './protocol';

const hidden = new Set(['complete', 'token_usage', 'stream_end', 'permission_request', 'permission_resolved', 'permission_cancelled', 'session_created', 'interaction_error', 'chat_subscribed']);
/** Reconcile stream fragments and final snapshots using provider item identity. */
export function presentEvents(events: ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = [], seen = new Set<string>(), items = new Map<string, ChatEvent>();
  let turn = 0, outputTurn = -1;
  let pendingText: ChatEvent | undefined;
  for (const event of events) {
    if (event.id && seen.has(event.id)) continue;
    if (event.id) seen.add(event.id);
    if (event.kind === 'complete' || event.kind === 'text' && event.role === 'user') { turn++; pendingText = undefined; }
    if (hidden.has(event.kind) || event.kind === 'status' && event.tokenBudget) continue;
    const content = event.content ?? event.text ?? '';
    if (event.kind === 'thinking' || event.kind === 'stream_delta' || event.kind === 'text' && event.role !== 'user') {
      const thinking = event.kind === 'thinking';
      const item = typeof event.itemId === 'string' ? event.itemId : undefined;
      const key = item ? `${turn}:${thinking ? 'thinking' : 'text'}:${item}:${thinking ? event.channel ?? 'summary' : ''}` : undefined;
      const previous = key ? items.get(key) : !thinking && pendingText ? pendingText : outputTurn === turn ? out.at(-1) : undefined;
      const delta = event.kind === 'stream_delta' || thinking && (event.mode === 'delta' || event.provider === 'codex' && !event.mode);
      const compatible = previous && (thinking ? previous.kind === 'thinking' && (key || delta) : previous.kind === 'stream_delta' || key && previous.kind === 'text');
      if (compatible) {
        const current = previous.content ?? previous.text ?? '';
        // A snapshot is authoritative only for its matching item; legacy text
        // replaces a pending stream only when it contains that stream prefix.
        if (delta) {
          const boundary = thinking && previous.partIndex !== undefined && event.partIndex !== previous.partIndex ? '\n\n' : '';
          previous.content = current + boundary + content; previous.partIndex = event.partIndex;
        } else if (key || content.startsWith(current)) { previous.content = content; previous.kind = event.kind; if (!thinking) pendingText = undefined; }
        else { const row = { ...event, content }; out.push(row); }
        continue;
      }
      const row = { ...event, content };
      out.push(row); outputTurn = turn; if (key) items.set(key, row); else if (event.kind === 'stream_delta') pendingText = row;
    } else { out.push({ ...event }); outputTurn = turn; }
  }
  return out;
}
