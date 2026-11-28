// CloudCLI parses a session's whole transcript on every history request (0.5–0.7s for a 60–80MB conversation),
// even when nothing changed. A page is reused for as long as its transcript file is byte-for-byte the same size
// and modification time; any change at all (a running turn, the CLI used elsewhere) makes the next request miss.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type TranscriptPath = (sessionId: string) => string | undefined | Promise<string | undefined>;
type Entry = { stamp: string; body: string };

export class HistoryCache {
  private entries = new Map<string, Entry>(); private bytes = 0; private inflight = new Map<string, Promise<string>>();
  hits = 0; misses = 0;
  constructor(private transcript: TranscriptPath, private budget = 64 * 1024 * 1024, private limit = 64) {}

  /** Returns the JSON text of the page, from memory when the transcript has not changed since it was built. */
  async get(sessionId: string, page: string, load: () => Promise<unknown>): Promise<string> {
    let stamp: string | undefined;
    try {
      const file = await this.transcript(sessionId);
      if (file) { const stat = await fs.stat(file); stamp = `${stat.mtimeMs}:${stat.size}`; }
    } catch { stamp = undefined; }
    // The stamp is taken before the upstream read, so a write during the read can only cause a later miss, never a stale hit.
    if (!stamp) { this.misses++; return JSON.stringify(await load()); }
    const key = sessionId + '|' + page, hit = this.entries.get(key);
    if (hit && hit.stamp === stamp) { this.entries.delete(key); this.entries.set(key, hit); this.hits++; return hit.body; }
    const flight = key + '|' + stamp, running = this.inflight.get(flight);
    if (running) return running;
    this.misses++;
    const work = (async () => {
      const value = await load(), body = JSON.stringify(value);
      // An error or empty answer is passed on but never remembered.
      if ((value as { data?: unknown } | null)?.data) this.store(key, { stamp: stamp!, body });
      return body;
    })().finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, work);
    return work;
  }
  private store(key: string, entry: Entry) {
    const old = this.entries.get(key); if (old) { this.bytes -= old.body.length; this.entries.delete(key); }
    if (entry.body.length > this.budget / 2) return;
    this.entries.set(key, entry); this.bytes += entry.body.length;
    for (const [oldest, value] of this.entries) { if (this.bytes <= this.budget && this.entries.size <= this.limit) break; this.entries.delete(oldest); this.bytes -= value.body.length; }
  }
  forget(sessionId: string) { for (const key of [...this.entries.keys()]) if (key.startsWith(sessionId + '|')) { this.bytes -= this.entries.get(key)!.body.length; this.entries.delete(key); } }
}

/** Looks up a conversation's transcript file in CloudCLI's own database; any failure just turns the cache off for that call. */
export function cloudTranscripts(db = process.env.CLOUDCLI_DB ?? path.join(os.homedir(), '.cloudcli', 'auth.db')): TranscriptPath {
  const known = new Map<string, { file: string; at: number }>();
  return async id => {
    const seen = known.get(id);
    if (seen && Date.now() - seen.at < 5 * 60_000) return seen.file;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const connection = new DatabaseSync(db, { readOnly: true });
      try {
        const row = connection.prepare("select jsonl_path as file from sessions where session_id = ? and provider = 'claude'").get(id) as { file?: unknown } | undefined;
        if (typeof row?.file !== 'string') return undefined;
        known.set(id, { file: row.file, at: Date.now() }); return row.file;
      } finally { connection.close(); }
    } catch { return undefined; }
  };
}
