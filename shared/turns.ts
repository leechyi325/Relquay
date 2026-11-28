import type { ChatEvent } from './protocol.ts';

/** One question and the agent's reply, for the question index. */
export type Turn = { key: string; question: string; answer: string; tools: number; time?: string; attachments: number };

/** Plain text for previews: Markdown markers removed, whitespace collapsed. */
export function plain(text: string) {
  return text.replace(/```[^\n]*\n?/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '').replace(/(\*\*|__|~~)/g, '').replace(/\s+/g, ' ').trim();
}

/** Splits the rendered messages into question-and-answer turns, oldest first. Events before the first loaded question are skipped. */
export function buildTurns(messages: ChatEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined, replies: string[] = [];
  const finish = () => { if (current) current.answer = replies.at(-1) ?? ''; };
  for (const event of messages) {
    const text = (event.content ?? event.text ?? '').trim();
    if (event.kind === 'text' && event.role === 'user') {
      const key = event.renderKey ?? event.id;
      if (!text || typeof key !== 'string' && typeof key !== 'number') continue;
      finish(); replies = [];
      current = { key: String(key), question: text, answer: '', tools: 0, time: event.timestamp, attachments: Array.isArray(event.attachments) ? event.attachments.length : 0 };
      turns.push(current);
    } else if (!current) continue;
    else if ((event.kind === 'text' || event.kind === 'stream_delta') && text) replies.push(text);
    else if (event.kind === 'tool_use') current.tools++;
  }
  finish();
  return turns;
}
