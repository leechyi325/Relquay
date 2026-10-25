import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Maximize2, Minimize2, Minus, Play, Plus, RefreshCw, SquareTerminal } from 'lucide-react';
import { socket, openExternal, post, origin } from './api';
import { useFileModules } from './file-roots';
import type { FileLocation, ServerStatus } from '../shared/protocol';
import '@xterm/xterm/css/xterm.css';
export function Terminal({ cwd, status, toast }: { cwd: FileLocation; status?: ServerStatus; toast: (s: string) => void }) {
  const { roots } = useFileModules();
  const effectiveRoot = roots.some(root => root.id === cwd.root) ? cwd.root : roots[0]?.id ?? cwd.root;
  const host = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), term = useRef<XTerm>(null), connection = useRef<WebSocket>(null);
  const resize = useRef<() => void>(() => {}), width = useRef('fit'), size = useRef(12);
  const [mode, setMode] = useState('fit'), [fontSize, setFontSize] = useState(12), [fullscreen, setFullscreen] = useState(false), [editor, setEditor] = useState(true);
  const [dimensions, setDimensions] = useState({ cols: 0, rows: 0 }), [pan, setPan] = useState({ value: 0, max: 0 });
  const ctrl = useRef(false), [control, setControl] = useState(false), [ready, setReady] = useState(false), [command, setCommand] = useState(''), [reconnect, setReconnect] = useState(0);
  const [history, setHistory] = useState<string[]>(() => JSON.parse(localStorage.getItem('studio.commands:' + origin) ?? '[]'));
  const write = (data: string) => { if (connection.current?.readyState === WebSocket.OPEN) connection.current.send(JSON.stringify({ type: 'input', data })); else toast('终端尚未连接'); };
  useEffect(() => {
    if (!host.current || !viewport.current || !status) return;
    const surface = host.current, scroller = viewport.current;
    let disposed = false, timer: ReturnType<typeof setTimeout>, delay = 1000, frame = 0;
    const terminal = new XTerm({ fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 12, lineHeight: 1.3, cursorBlink: true, scrollback: 5000, theme: { background: '#142833', foreground: '#e5e4da', cursor: '#dfae80', selectionBackground: '#506876' }, allowProposedApi: false });
    const fit = new FitAddon(); terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => { void openExternal(uri).catch(e => toast(String(e))); }));
    terminal.open(surface); term.current = terminal;
    const layout = () => {
      if (disposed || scroller.clientWidth < 1 || scroller.clientHeight < 1) return;
      terminal.options.fontSize = size.current;
      // FitAddon measures the direct parent; keep this surface free of padding.
      surface.style.width = '100%';
      const proposed = fit.proposeDimensions();
      const screen = surface.querySelector('.xterm-screen');
      const cell = screen ? screen.getBoundingClientRect().width / terminal.cols : 0;
      if (!proposed || !cell) return;
      const cols = width.current === 'fit' ? proposed.cols : Number(width.current);
      surface.style.width = width.current === 'fit' ? '100%' : Math.ceil(cols * cell + 16) + 'px';
      terminal.resize(cols, Math.max(2, proposed.rows));
      surface.dataset.cols = String(terminal.cols); surface.dataset.rows = String(terminal.rows);
      setDimensions({ cols: terminal.cols, rows: terminal.rows });
      if (connection.current?.readyState === WebSocket.OPEN) connection.current.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      if (width.current === 'fit') scroller.scrollLeft = 0;
      setPan({ value: scroller.scrollLeft, max: Math.max(0, scroller.scrollWidth - scroller.clientWidth) });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    resize.current = schedule;
    const observer = new ResizeObserver(schedule); observer.observe(scroller);
    window.addEventListener('resize', schedule); window.visualViewport?.addEventListener('resize', schedule);
    void document.fonts.ready.then(schedule);
    let touch: { x: number; y: number; left: number } | undefined;
    const touchStart = (event: TouchEvent) => { const point = event.touches[0]; touch = { x: point.clientX, y: point.clientY, left: scroller.scrollLeft }; };
    const touchMove = (event: TouchEvent) => {
      if (!touch || width.current === 'fit' || event.touches.length !== 1) return;
      const point = event.touches[0], dx = point.clientX - touch.x, dy = point.clientY - touch.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) { scroller.scrollLeft = touch.left - dx; event.preventDefault(); event.stopPropagation(); }
    };
    scroller.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    scroller.addEventListener('touchmove', touchMove, { capture: true, passive: false });
    terminal.onData(data => {
      if (ctrl.current && data.length === 1) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); ctrl.current = false; setControl(false); }
      write(data);
    });
    const connect = async () => {
      try {
        const ws = await socket('terminal'); if (disposed) { ws.close(); return; } connection.current = ws;
        ws.onopen = async () => {
          try {
          delay = 1000; layout();
          const resolved = await post<{ path: string; terminalRc: string }>('/api/files/resolve', { root: effectiveRoot, path: effectiveRoot === cwd.root ? cwd.path : '' });
          const projectPath = resolved.path;
          const encoded = new TextEncoder().encode(cwd.root + '/' + cwd.path);
          const digest = await crypto.subtle.digest('SHA-256', encoded);
          if (disposed || ws.readyState !== WebSocket.OPEN) return;
          const legacy = btoa(unescape(encodeURIComponent(cwd.root + '/' + cwd.path))).replace(/[^a-zA-Z0-9]/g, '');
          const session = 'cv-' + (legacy.length <= 32 ? legacy : Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('').slice(0, 32));
          const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
          const rc = resolved.terminalRc;
          const shell = `bash --rcfile ${quote(rc)} -i`;
          ws.send(JSON.stringify({ type: 'init', projectPath, sessionId: session, provider: 'plain-shell', isPlainShell: true, initialCommand: `tmux new-session -A -s ${session} -c ${quote(projectPath)} ${quote(shell)} \\; set-option -t ${session} status off \\; set-window-option -t ${session} window-size latest`, cols: terminal.cols, rows: terminal.rows, colorScheme: 'dark' }));
          } catch(e) { if (!disposed) toast(String(e)); ws.close(); }
        };
        ws.onmessage = e => { try { const value = JSON.parse(e.data); if (value.type === 'output') { terminal.write(value.data); setReady(true); } } catch {} };
        ws.onclose = () => { setReady(false); if (!disposed) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000); } };
        ws.onerror = () => ws.close();
      } catch(e) { if (!disposed) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000); } }
    };
    void connect();
    return () => {
      disposed = true; clearTimeout(timer); cancelAnimationFrame(frame); resize.current = () => {};
      connection.current?.close(); observer.disconnect(); window.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('resize', schedule);
      scroller.removeEventListener('touchstart', touchStart, true); scroller.removeEventListener('touchmove', touchMove, true); terminal.dispose(); term.current = null;
    };
  }, [effectiveRoot, cwd.root, cwd.path, status?.projectPath, reconnect]);
  useEffect(() => { width.current = mode; size.current = fontSize; resize.current(); }, [mode, fontSize, fullscreen, editor]);
  useEffect(() => {
    if (!fullscreen) return;
    const update = () => { host.current?.closest<HTMLElement>('.terminal-page')?.style.setProperty('--visual-height', `${window.visualViewport?.height ?? innerHeight}px`); resize.current(); };
    update(); window.visualViewport?.addEventListener('resize', update);
    return () => window.visualViewport?.removeEventListener('resize', update);
  }, [fullscreen]);
  function run(text: string) {
    if (!ready) { toast('终端尚未连接'); return; }
    write(text + '\r'); setCommand('');
    if (fullscreen) { (document.activeElement as HTMLElement | null)?.blur(); setEditor(false); }
    const next = [text, ...history.filter(e => e !== text)].slice(0, 12); setHistory(next); localStorage.setItem('studio.commands:' + origin, JSON.stringify(next));
  }
  return <div className={'terminal-page ' + (fullscreen ? 'is-fullscreen' : '')}>
    <div className="section-heading"><div><span className="eyebrow">SERVER TERMINAL</span><h1>随手掌控。</h1></div><button className="icon-button" aria-label="重新连接终端" onClick={() => setReconnect(v => v + 1)}><RefreshCw size={19}/></button></div>
    <p className="muted terminal-intro">适应屏宽，或固定列数后左右滑动查看。</p>
    <div className="quick-actions"><button onClick={() => run('pwd')}>当前目录</button><button onClick={() => run('df -h')}>磁盘空间</button><button onClick={() => run('free -h')}>内存</button><button onClick={() => run('codex login --device-auth')}>登录 Codex</button><button onClick={() => run('claude auth login')}>登录 Claude</button></div>
    <div className="terminal-controls"><label>宽度<select aria-label="终端宽度" value={mode} onChange={e => setMode(e.target.value)}><option value="fit">适应屏宽</option><option value="80">80 列</option><option value="120">120 列</option></select></label><div><button aria-label="缩小终端字号" disabled={fontSize <= 9} onClick={() => setFontSize(v => v - 1)}><Minus size={15}/></button><span>{fontSize}</span><button aria-label="增大终端字号" disabled={fontSize >= 20} onClick={() => setFontSize(v => v + 1)}><Plus size={15}/></button></div><span className="terminal-dimensions" aria-label="终端尺寸">{dimensions.cols} × {dimensions.rows}</span><button aria-label={fullscreen ? '退出终端全屏' : '终端全屏'} onClick={() => { setFullscreen(!fullscreen); setEditor(fullscreen); }}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div>
    <section className="terminal-card"><header><span className={'dot ' + (ready ? 'green' : '')}/><span>ubuntu · {cwd.root}{cwd.path ? '/' + cwd.path : ''}</span><span className="terminal-badge">{ready ? '已连接' : '正在连接'}</span></header><div className="terminal-scroll" ref={viewport} onScroll={e => setPan({ value: e.currentTarget.scrollLeft, max: Math.max(0, e.currentTarget.scrollWidth - e.currentTarget.clientWidth) })}><div ref={host} className="terminal-screen"/></div>
      {mode !== 'fit' && pan.max > 0 && <label className="terminal-pan"><span>左右查看</span><input aria-label="终端横向位置" type="range" min={0} max={pan.max} value={pan.value} onChange={e => { if (viewport.current) viewport.current.scrollLeft = Number(e.target.value); }}/><span>{Math.round(pan.value / pan.max * 100)}%</span></label>}
      <div className="key-bar">{[['Esc', '\u001b'], ['Tab', '\t']].map(([label, data]) => <button key={label} onClick={() => { write(data); term.current?.focus(); }}>{label}</button>)}<button className={control ? 'selected' : ''} onClick={() => { ctrl.current = !ctrl.current; setControl(ctrl.current); term.current?.focus(); }}>Ctrl</button><button onClick={() => write('\u0003')}>^C</button>{[[ArrowLeft, '\u001b[D'], [ArrowDown, '\u001b[B'], [ArrowUp, '\u001b[A'], [ArrowRight, '\u001b[C']].map(([Icon, data], i) => { const KeyIcon = Icon as typeof ArrowUp; return <button key={i} aria-label={['向左', '向下', '向上', '向右'][i]} onClick={() => write(data as string)}><KeyIcon size={16}/></button>; })}<button aria-label="回车" onClick={() => write('\r')}><CornerDownLeft size={16}/></button></div>
    </section>
    <div className="command-box"><button className="command-toggle" aria-expanded={editor} onClick={() => setEditor(!editor)}>命令编辑器 <span>{editor ? '收起' : '展开'}</span></button>{editor && <><label htmlFor="command" className="sr-only">命令编辑器，支持粘贴与多行输入</label><textarea id="command" value={command} onChange={e => setCommand(e.target.value)} placeholder="输入命令，编辑好后再执行…" rows={fullscreen ? 2 : 3}/><button className="primary" disabled={!command.trim() || !ready} onClick={() => run(command)}><Play size={15}/>执行命令</button></>}</div>
    {!fullscreen && history.length > 0 && <div className="command-history"><span className="eyebrow">最近使用</span>{history.slice(0, 4).map(text => <button key={text} onClick={() => { setCommand(text); setEditor(true); }}><SquareTerminal size={15}/><code>{text}</code></button>)}</div>}
  </div>;
}
