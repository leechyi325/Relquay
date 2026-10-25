import { WebSocket } from 'ws';
import { decodeEvent, type ChatEvent } from '../shared/protocol.ts';
import type { NotificationStore } from './notifications.ts';

/** A server-owned observer survives browser socket closure. It never starts inference. */
export class CloudObserver {
  private connection?: WebSocket; private timer?: NodeJS.Timeout; private busy = false; private stopped = false;
  private subscribed = new Set<string>();
  private cursors = new Map<string, number>();
  constructor(private cloud: string, private token: () => string | undefined, private notices: NotificationStore, private ownCodex: (id: string) => boolean, private event: (event: ChatEvent) => void) {}
  start() { if (this.timer || this.stopped) return; void this.refresh(); this.timer = setInterval(() => { void this.refresh(); }, 3000); this.timer.unref(); }
  watch(id: string) {
    this.start();
    if (this.connection?.readyState === WebSocket.OPEN && !this.subscribed.has(id)) this.subscribe([id]);
  }
  begin(id: string) { this.cursors.set(id, 0); this.subscribed.delete(id); this.watch(id); }
  private subscribe(ids: string[]) {
    if (!ids.length || this.connection?.readyState !== WebSocket.OPEN) return;
    this.connection.send(JSON.stringify({ type: 'chat.subscribe', sessions: ids.map(sessionId => ({ sessionId, lastSeq: this.cursors.get(sessionId) ?? 0 })) })); for (const id of ids) this.subscribed.add(id);
  }
  private async refresh() {
    if (this.busy || this.stopped) return;
    const token = this.token(); if (!token) { this.connection?.close(); this.connection = undefined; this.subscribed.clear(); return; }
    this.busy = true;
    try {
      const response = await fetch(this.cloud + '/api/providers/sessions/running', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const body = await response.json() as { data: { sessions: { sessionId: string; provider?: string }[] } };
      if (this.stopped) return;
      const ids = body.data.sessions.filter(session => typeof session.sessionId === 'string' && !this.ownCodex(session.sessionId) && (!session.provider || session.provider === 'claude')).map(session => session.sessionId);
      this.notices.running(ids);
      if (!this.connection || this.connection.readyState === WebSocket.CLOSED) {
        const ws = new WebSocket(this.cloud.replace(/^http/, 'ws') + '/ws', { headers: { Authorization: 'Bearer ' + token }, maxPayload: 8 * 1024 * 1024 }); this.connection = ws; this.subscribed.clear();
        ws.on('open', () => { if (this.stopped) { ws.close(); return; } this.subscribe([...new Set([...ids, ...this.notices.watched()])]); });
        ws.on('message', data => { try {
          const event = decodeEvent(JSON.parse(data.toString()));
          if (event && !this.ownCodex(event.sessionId ?? '')) {
            if (event.sessionId) {
              if (event.kind === 'chat_subscribed' && !event.isProcessing || event.kind === 'complete') { this.subscribed.delete(event.sessionId); this.cursors.delete(event.sessionId); }
              else if (event.seq !== undefined) this.cursors.set(event.sessionId, event.seq);
            }
            this.notices.ingest(event, 'claude'); this.event(event);
          }
        } catch { /* Invalid upstream events are not notifications. */ } });
        ws.on('error', () => ws.close()); ws.on('close', () => { if (this.connection === ws) { this.connection = undefined; this.subscribed.clear(); } });
      } else if (this.connection.readyState === WebSocket.OPEN) this.subscribe([...new Set([...ids, ...this.notices.watched()])].filter(id => !this.subscribed.has(id)));
    } catch { /* A temporary outage keeps persisted cursors and active runs. */ }
    finally { this.busy = false; }
  }
  close() { this.stopped = true; clearInterval(this.timer); this.connection?.close(); }
}
