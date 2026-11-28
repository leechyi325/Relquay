import type { ChatEvent } from './protocol';

/** Everything an agent did on the way to its answer: thinking, tool calls and results, and interim remarks. */
export type Fold = { fold: true; key: string; events: ChatEvent[]; thinking: number; tools: number; notes: number; latest?: string };
export type Row = ChatEvent | Fold;
export const isFold = (row: unknown): row is Fold => !!row && !Array.isArray(row) && (row as Fold).fold === true;

const foldable = new Set(['thinking', 'tool_use', 'tool_result']);
const spoken = (event: ChatEvent) => (event.kind === 'text' || event.kind === 'stream_delta') && event.role !== 'user' && !!(event.content ?? event.text ?? '').trim();

/**
 * Per question, the work that led to the answer is gathered into one fold placed before the answer, so a
 * conversation reads as question → answer. While the last turn is still running its trailing text is shown as
 * it streams; once the agent moves on to another step that text becomes part of the work.
 * Errors and anything else that is not part of the work stay where they are.
 */
export function foldProcess(messages: ChatEvent[], running: boolean): Row[] {
  const out: Row[] = []; let segment: ChatEvent[] = [];
  const flush = (last: boolean) => {
    if (!segment.length) return;
    let answer = -1;
    for (let index = segment.length - 1; index >= 0; index--) if (spoken(segment[index])) { answer = index; break; }
    // Still working after that text: it was an interim remark, the answer has not arrived yet.
    if (answer >= 0 && last && running && segment.slice(answer + 1).some(event => foldable.has(event.kind))) answer = -1;
    const work: ChatEvent[] = [], rest: ChatEvent[] = [];
    segment.forEach((event, index) => { (foldable.has(event.kind) || spoken(event) && index !== answer ? work : rest).push(event); });
    if (work.length) {
      const tools = work.filter(event => event.kind === 'tool_use');
      out.push({ fold: true, key: String(work[0].renderKey ?? work[0].id ?? 'w' + out.length), events: work, thinking: work.filter(event => event.kind === 'thinking').length, tools: tools.length, notes: work.filter(spoken).length, latest: tools.at(-1)?.toolName });
    }
    out.push(...rest); segment = [];
  };
  // A finished run ends a segment too: a queued message answered by a second run has no user echo to split on.
  for (const event of messages) {
    if (event.kind === 'text' && event.role === 'user') { flush(false); out.push(event); continue; }
    if (segment.length && typeof event.runTurn === 'number' && event.runTurn !== segment[0].runTurn) flush(false);
    segment.push(event);
  }
  flush(true);
  return out;
}
