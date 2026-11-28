import { useEffect, useRef, useState } from 'react';
import { api, cloud, origin, socket } from './api';
import { readHistory, writeHistory } from './history-cache';
import { decodeEvent, emptyChat, mergeLatestHistory, reduceChat, type ChatState, type ChatEvent, type ChatAttachment } from '../shared/protocol';

export type QueuedMessage = { id: string; content: string; attachments: { name: string; size: number; mime: string }[]; createdAt: string };
export type MessageQueue = { items: QueuedMessage[]; paused?: string; sending: boolean };
type History = { messages: unknown[]; hasMore?: boolean; nextOffset?: number };

export function useChat(sessionId?: string, provider?: string) {
  const [state, setState] = useState<ChatState>(emptyChat), [connected, setConnected] = useState(false), [reconnecting, setReconnecting] = useState(false), [ready, setReady] = useState(false);
  const [hasMore, setHasMore] = useState(false), [loadingHistory, setLoadingHistory] = useState(false), [queue, setQueue] = useState<MessageQueue>({ items: [], sending: false });
  const historyOffset = useRef(0), historyBusy = useRef(false), activeSession = useRef(sessionId); activeSession.current = sessionId;
  const ws = useRef<WebSocket | null>(null), snapshot = useRef(state); snapshot.current = state;
  useEffect(() => {
    // A conversation opened before shows its last page at once; the server's answer then replaces it in place.
    const cached = sessionId ? readHistory(origin, sessionId) : undefined, first = cached ? { ...emptyChat, events: cached } : emptyChat;
    setState(first); snapshot.current = first; setConnected(false); setReconnecting(false); setReady(false); setHasMore(false); historyOffset.current = 0; setQueue({ items: [], sending: false });
    if (!sessionId) return;
    void api<MessageQueue>(`/api/conversations/${encodeURIComponent(sessionId)}/queue`).then(value => { if (!disposed) setQueue(value); }).catch(() => {});
    let disposed = false, timer: ReturnType<typeof setTimeout>, delay = 1000, connecting = false, probe: ReturnType<typeof setTimeout> | undefined, notice: ReturnType<typeof setTimeout> | undefined;
    // A short reconnect is shown as connected; only an outage longer than a moment changes the header.
    let missed = false, pendingRun: ReturnType<typeof setTimeout> | undefined;
    // Claude numbers each run from 1. Follow the server-started run from its start, but only once the previous
    // run's tail has arrived here (the server may see that completion before this phone does).
    const followNewRun = () => {
      clearTimeout(pendingRun); pendingRun = undefined;
      setState(s => { const next = { ...s, lastSeq: 0, processing: true }; snapshot.current = next; return next; });
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }));
    };
    const offline = () => { missed = true; setConnected(false); clearTimeout(notice); notice = setTimeout(() => { if (!disposed) setReconnecting(true); }, 2000); };
    const retry = () => { clearTimeout(timer); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000); };
    const connect = async () => {
      if (connecting || disposed) return; connecting = true; clearTimeout(timer);
      try {
        const connection = await socket('chat');
        if (disposed) { connection.close(); return; }
        ws.current = connection;
        connection.onopen = () => {
          setConnected(true); setReady(true); clearTimeout(notice); setReconnecting(false); delay = 1000;
          connection.send(JSON.stringify({ type: 'relquay.hello', features: ['queue'] }));
          connection.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: snapshot.current.lastSeq }] }));
        };
        connection.onmessage = ({ data }) => {
          try {
            const event = decodeEvent(JSON.parse(data));
            if (event?.kind === 'relquay_pong') { clearTimeout(probe); probe = undefined; return; }
            if (!event || event.sessionId && event.sessionId !== sessionId) return;
            if (event.kind === 'relquay_queue') {
              setQueue({ items: Array.isArray(event.items) ? event.items as QueuedMessage[] : [], paused: typeof event.paused === 'string' ? event.paused : undefined, sending: event.sending === true });
              if (event.dispatched === true) {
                const previousEnded = !snapshot.current.processing;
                setState(s => { const next = { ...s, processing: true, error: undefined }; snapshot.current = next; return next; });
                if (provider !== 'codex') { if (previousEnded) followNewRun(); else { clearTimeout(pendingRun); pendingRun = setTimeout(followNewRun, 5000); } }
              }
              return;
            }
            // The run ended while this phone was away: its tail was never streamed here, so read it from history.
            if (event.kind === 'chat_subscribed' && event.isProcessing !== true && (missed || snapshot.current.processing)) { missed = false; void catchUp(); }
            setState(s => reduceChat(s, event));
            if (event.kind === 'complete' && pendingRun) followNewRun();
          } catch { setState(s => ({ ...s, error: '收到无法识别的会话消息' })); }
        };
        connection.onclose = () => { if (ws.current !== connection) return; ws.current = null; clearTimeout(probe); probe = undefined; if (!disposed) { offline(); retry(); } };
        connection.onerror = () => connection.close();
      } catch(e) { if (!disposed) { offline(); setState(s => ({ ...s, error: String(e) })); retry(); } }
      finally { connecting = false; }
    };
    const catchUp = async () => {
      try {
        const history = await cloud<History>(`/providers/sessions/${sessionId}/messages?limit=100`);
        if (disposed) return;
        const events = history.messages.map(decodeEvent).filter((e): e is ChatEvent => !!e);
        const merged = mergeLatestHistory(snapshot.current.events, events); if (!merged) return;
        if (merged.restarted) { historyOffset.current = history.nextOffset ?? history.messages.length; setHasMore(history.hasMore === true); }
        setState(s => { const next = { ...s, events: mergeLatestHistory(s.events, events)!.events }; snapshot.current = next; return next; });
      } catch { /* The live stream continues; the next reconnect tries again. */ missed = true; }
    };
    void cloud<History>(`/providers/sessions/${sessionId}/messages?limit=100`).then(history => {
      if (disposed) return;
      const events = history.messages.map(decodeEvent).filter((e): e is ChatEvent => !!e);
      historyOffset.current = history.nextOffset ?? history.messages.length; setHasMore(history.hasMore === true);
      const initial = { ...emptyChat, events, lastSeq: Math.max(0, ...events.map(e => e.seq ?? 0)) };
      snapshot.current = initial; setState(initial);
    }).catch(e => { if (!disposed) setState(s => ({ ...s, error: String(e) })); }).finally(() => { if (!disposed) void connect(); });
    // Back from the background or a network change: a socket that looks open may be dead. Probe it and catch up,
    // reconnecting at once instead of waiting out the backoff.
    const wake = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      const current = ws.current;
      if (!current || current.readyState > WebSocket.OPEN) { delay = 1000; void connect(); return; }
      if (current.readyState !== WebSocket.OPEN) return;
      current.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: snapshot.current.lastSeq }] }));
      if (!probe) { current.send(JSON.stringify({ type: 'relquay.ping' })); probe = setTimeout(() => { probe = undefined; if (ws.current === current) { ws.current = null; current.close(); offline(); delay = 1000; void connect(); } }, 5000); }
    };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(pendingRun); clearTimeout(probe); clearTimeout(notice); const current = ws.current; ws.current = null; current?.close(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [sessionId]);
  // Keep the phone's copy of the latest page current, and flush it when leaving the conversation.
  useEffect(() => {
    if (!sessionId || !state.events.length) return;
    const timer = setTimeout(() => writeHistory(origin, sessionId, state.events), 2000);
    return () => clearTimeout(timer);
  }, [sessionId, state.events]);
  useEffect(() => {
    if (!sessionId) return;
    const flush = () => writeHistory(origin, sessionId, snapshot.current.events), hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); flush(); };
  }, [sessionId]);
  async function loadEarlier() {
    if (!sessionId || historyBusy.current) return;
    const id = sessionId; historyBusy.current = true; setLoadingHistory(true);
    try {
      const history = await cloud<{ messages: unknown[]; hasMore?: boolean; nextOffset?: number }>(`/providers/sessions/${id}/messages?limit=100&offset=${historyOffset.current}`);
      if (activeSession.current !== id) return;
      const events = history.messages.map(decodeEvent).filter((event): event is ChatEvent => !!event);
      historyOffset.current = history.nextOffset ?? historyOffset.current + history.messages.length; setHasMore(history.hasMore === true);
      setState(state => { const ids = new Set(state.events.flatMap(event => event.id ? [event.id] : [])); return { ...state, events: [...events.filter(event => !event.id || !ids.has(event.id)), ...state.events] }; });
    } catch(e) { if (activeSession.current === id) setState(state => ({ ...state, error: String(e) })); }
    finally { historyBusy.current = false; if (activeSession.current === id) setLoadingHistory(false); }
  }
  function send(value: Record<string, unknown>) {
    if (ws.current?.readyState !== WebSocket.OPEN) throw new Error('会话正在重连，请稍后发送');
    ws.current.send(JSON.stringify(value));
  }
  function message(content: string, options: Record<string, unknown> = {}, attachments: ChatAttachment[] = []) {
    send({ type: 'chat.send', sessionId, content, options: { permissionMode: 'default', ...options } });
    setState(s => ({ ...s, lastSeq: provider === 'codex' ? s.lastSeq : 0, processing: true, error: undefined, events: [...s.events, { kind: 'text', role: 'user', content, attachments: attachments.map(({ name, size, mime }) => ({ name, size, mime })), id: crypto.randomUUID(), optimistic: true }] }));
  }
  return { ...state, connected, reconnecting, ready, message, send, hasMore, loadingHistory, loadEarlier, queue };
}
