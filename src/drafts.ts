// An unsent message is kept per conversation on the phone, so leaving the chat, switching sessions or the OS
// reclaiming the app does not lose what was being typed. Removed as soon as the text is empty (sent or cleared).
const prefix = 'relquay.draft:', LIMIT = 20_000;
const name = (origin: string, id: string) => prefix + origin + ':' + id;

export function readDraft(origin: string, id: string): string {
  try { return localStorage.getItem(name(origin, id)) ?? ''; } catch { return ''; }
}
export function writeDraft(origin: string, id: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(name(origin, id), text.slice(0, LIMIT)); else localStorage.removeItem(name(origin, id));
  } catch { /* storage full or blocked: the draft just is not kept */ }
}
/** Sign-out or removing a server also drops its drafts, like the history cache. */
export function clearDrafts(origin?: string) {
  try {
    const head = origin === undefined ? prefix : prefix + origin + ':';
    for (const key of Object.keys(localStorage)) if (key.startsWith(head)) localStorage.removeItem(key);
  } catch { /* nothing to clear */ }
}
