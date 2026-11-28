import { Children, createContext, isValidElement, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { highlighted, highlighterReady, languageOf, loadHighlighter } from './highlight';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, X } from 'lucide-react';
import { openExternal } from './api';
import { codePath, fileLine, linkPath, urlTransform } from './file-links';

export type OpenPath = (path: string, line?: number) => void;

const InBlock = createContext(false);

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(value => typeof value === 'string' || typeof value === 'number' ? String(value) : isValidElement<{ children?: ReactNode }>(value) ? textOf(value.props.children) : '').join('');
}
/** Copies text and shows a short confirmation; the clipboard can refuse (no permission), which is reported instead of ignored. */
export function CopyButton({ text, label, className, plain }: { text: string | (() => string); label: string; className?: string; plain?: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle'), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    let next: 'done' | 'failed' = 'done';
    try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); } catch { next = 'failed'; }
    setState(next); clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 1600);
  }
  return <button type="button" className={className} aria-label={label} onClick={() => void copy()}>{state === 'done' ? <Check size={14}/> : <Copy size={14}/>}{!plain && (state === 'done' ? ' 已复制' : state === 'failed' ? ' 复制失败' : ' ' + label)}</button>;
}
/** Tapping an image opens it full screen; tapping it again zooms in and the picture can be dragged around. */
function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false), [zoomed, setZoomed] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (failed) return <span className="doc-missing-image">[图片未能加载：{alt || src}]</span>;
  return <>
    <button type="button" className="img-open" aria-label={'放大图片' + (alt ? '：' + alt : '')} onClick={() => { setZoomed(false); setOpen(true); }}><img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)}/></button>
    {open && createPortal(<div className="img-zoom" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setOpen(false)}>
      <button type="button" className="img-zoom-close" aria-label="关闭图片预览" onClick={() => setOpen(false)}><X size={22}/></button>
      <div className={'img-zoom-stage' + (zoomed ? ' zoomed' : '')}><img src={src} alt={alt} onClick={event => { event.stopPropagation(); setZoomed(value => !value); }}/></div>
    </div>, document.body)}
  </>;
}
function TableBlock({ children }: { children?: ReactNode }) {
  const table = useRef<HTMLTableElement>(null);
  const tsv = () => [...(table.current?.rows ?? [])].map(row => [...row.cells].map(cell => (cell.innerText ?? cell.textContent ?? '').replace(/\s+/g, ' ').trim()).join('\t')).join('\n');
  return <div className="table-block"><div className="table-tools"><CopyButton text={tsv} label="复制表格"/></div><table ref={table}>{children}</table></div>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState<string>(), [error, setError] = useState(false);
  const code = Children.toArray(children).find(isValidElement);
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.replace('language-', '') : '';
  const source = textOf(children).replace(/\n$/, ''), isCopied = copied === source;
  const known = !!languageOf(language), [, loaded] = useState(highlighterReady());
  useEffect(() => { if (known && !highlighterReady()) void loadHighlighter().then(() => loaded(true)).catch(() => {}); }, [known]);
  const html = known ? highlighted(source, language) : undefined;
  async function copy() { try { await navigator.clipboard.writeText(source); setCopied(source); setError(false); } catch { setError(true); } }
  return <div className="chat-code"><div className="code-heading"><span>{language || '代码'}</span><button aria-label="复制代码" onClick={() => void copy()}>{isCopied ? <Check size={14}/> : <Copy size={14}/>} {isCopied ? '已复制' : '复制'}</button></div><InBlock.Provider value={true}>{html !== undefined ? <pre><code className={'hljs language-' + language} dangerouslySetInnerHTML={{ __html: html }}/></pre> : <pre>{children}</pre>}</InBlock.Provider>{error && <span role="status">复制未成功，请长按代码选择复制。</span>}</div>;
}
// 文件预览用：相对路径的图片经文件预览票据加载；开头的 YAML 元数据折叠显示。
function assetUrl(base: string, src: string) {
  if (/^https:\/\//i.test(src)) return src;
  if (!base || /^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(src)) return '';
  return base + src.split(/[?#]/)[0].split('/').map(part => encodeURIComponent(decodeURIComponent(part))).join('/');
}
function InlineCode({ children, className, open }: { children?: ReactNode; className?: string; open?: OpenPath }) {
  const block = useContext(InBlock), path = !block && open && typeof children === 'string' ? codePath(children) : null;
  return path ? <button type="button" className="file-link code" title={'打开 ' + path} onClick={() => open!(path, fileLine(children as string))}><code>{children}</code></button> : <code className={className}>{children}</code>;
}
/** Re-parsing Markdown is the costliest part of a chat render, so unchanged messages skip it. */
export const ChatMarkdown = memo(function ChatMarkdown({ content, assetBase, document, openPath }: { content: string; assetBase?: string; document?: boolean; openPath?: OpenPath }) {
  const meta = document ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content) : null, body = meta ? content.slice(meta[0].length) : content;
  return <div className={'markdown' + (document ? ' doc' : '')}>{meta && <details className="doc-meta"><summary>文档元数据</summary><pre>{meta[1]}</pre></details>}<Markdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} skipHtml urlTransform={urlTransform} components={{
    pre: CodeBlock,
    table: TableBlock,
    code: ({ children, className }) => <InlineCode className={className} open={openPath}>{children}</InlineCode>,
    img: ({ src, alt }) => { const address = typeof src === 'string' ? assetUrl(assetBase ?? '', src) : ''; return address ? <ZoomImage src={address} alt={alt ?? ''}/> : <span className="doc-missing-image">[图片：{alt || src}]</span>; },
    a: ({ href, children }) => {
      if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void openExternal(href); }}>{children}</a>;
      const path = href && openPath && !document ? linkPath(href) : null;
      return path ? <button type="button" className="file-link" title={'打开 ' + path} onClick={() => openPath!(path, fileLine(href!))}>{children}</button> : <span>{children}</span>;
    }
  }}>{body}</Markdown></div>;
});
