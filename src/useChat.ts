import { useEffect, useRef, useState } from 'react';
import { cloud, socket } from './api';
import { decodeEvent, emptyChat, reduceChat, type ChatState, type ChatEvent, type ChatAttachment } from '../shared/protocol';

export function useChat(sessionId?: string, provider?: string) {
  const [state, setState] = useState<ChatState>(emptyChat), [connected, setConnected] = useState(false);
  const [hasMore, setHasMore] = useState(false), [loadingHistory, setLoadingHistory] = useState(false);
  const historyOffset = useRef(0), historyBusy = useRef(false), activeSession = useRef(sessionId); activeSession.current = sessionId;
  const ws = useRef<WebSocket | null>(null), snapshot = useRef(state); snapshot.current = state;
  useEffect(() => {
    setState(emptyChat); snapshot.current = emptyChat; setConnected(false); setHasMore(false); historyOffset.current = 0;
    if (!sessionId) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>, delay = 1000;
    const connect = async () => {
      try {
        const connection = await socket('chat');
        if (disposed) { connection.close(); return; }
        ws.current = connection;
        connection.onopen = () => {
          setConnected(true); delay = 1000;
          connection.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: snapshot.current.lastSeq }] }));
        };
        connection.onmessage = ({ data }) => {
          try {
            const event = decodeEvent(JSON.parse(data));
            if (event && (!event.sessionId || event.sessionId === sessionId)) setState(s => reduceChat(s, event));
          } catch { setState(s => ({ ...s, error: '收到无法识别的会话消息' })); }
        };
        connection.onclose = () => { setConnected(false); if (!disposed) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000); } };
        connection.onerror = () => connection.close();
      } catch(e) { if (!disposed) { setState(s => ({ ...s, error: String(e) })); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000); } }
    };
    void cloud<{ messages: unknown[]; hasMore?: boolean; nextOffset?: number }>(`/providers/sessions/${sessionId}/messages?limit=100`).then(history => {
      if (disposed) return;
      const events = history.messages.map(decodeEvent).filter((e): e is ChatEvent => !!e);
      historyOffset.current = history.nextOffset ?? history.messages.length; setHasMore(history.hasMore === true);
      const initial = { ...emptyChat, events, lastSeq: Math.max(0, ...events.map(e => e.seq ?? 0)) };
      snapshot.current = initial; setState(initial);
    }).catch(e => { if (!disposed) setState(s => ({ ...s, error: String(e) })); }).finally(() => { if (!disposed) void connect(); });
    const wake = () => { if (document.visibilityState === 'visible' && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: snapshot.current.lastSeq }] })); };
    document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; clearTimeout(timer); ws.current?.close(); ws.current = null; document.removeEventListener('visibilitychange', wake); };
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
  return { ...state, connected, message, send, hasMore, loadingHistory, loadEarlier };
}
