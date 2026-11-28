import { useEffect, useRef, useState } from 'react';
import { socket } from './api';

export type Topic = 'jobs' | 'notifications' | 'running' | 'sessions' | 'queue';
const everything: Topic[] = ['jobs', 'notifications', 'running', 'sessions'];

/**
 * Server change hints. While connected, the app refetches only what changed and the periodic polls slow
 * down to a fallback; after a reconnect everything is refetched once, since hints may have been missed.
 */
export function useLive(enabled: boolean, changed: (topics: Topic[]) => void) {
  const [live, setLive] = useState(false), handler = useRef(changed); handler.current = changed;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, connecting = false, dropped = false, current: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined, delay = 1000;
    const retry = () => { clearTimeout(timer); timer = setTimeout(() => void connect(), delay); delay = Math.min(delay * 2, 30000); };
    const connect = async () => {
      if (connecting || disposed) return; connecting = true; clearTimeout(timer);
      try {
        const connection = await socket('events');
        if (disposed) { connection.close(); return; }
        current = connection;
        connection.onopen = () => { setLive(true); delay = 1000; if (dropped) handler.current(everything); dropped = false; };
        connection.onmessage = ({ data }) => { try { const message = JSON.parse(data); if (message.type === 'changed' && Array.isArray(message.topics)) handler.current(message.topics); } catch { /* Ignore unknown frames. */ } };
        connection.onclose = () => { if (current !== connection) return; current = undefined; dropped = true; setLive(false); if (!disposed) retry(); };
        connection.onerror = () => connection.close();
      } catch { if (!disposed) { dropped = true; retry(); } }
      finally { connecting = false; }
    };
    void connect();
    const wake = () => { if (document.visibilityState === 'visible' && (!current || current.readyState > WebSocket.OPEN)) { delay = 1000; void connect(); } };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    return () => { disposed = true; clearTimeout(timer); const connection = current; current = undefined; connection?.close(); setLive(false); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [enabled]);
  return live;
}
