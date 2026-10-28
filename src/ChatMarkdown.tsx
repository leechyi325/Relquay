import { Children, isValidElement, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { openExternal } from './api';

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(value => typeof value === 'string' || typeof value === 'number' ? String(value) : isValidElement<{ children?: ReactNode }>(value) ? textOf(value.props.children) : '').join('');
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState<string>(), [error, setError] = useState(false);
  const code = Children.toArray(children).find(isValidElement);
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.replace('language-', '') : '';
  const source = textOf(children).replace(/\n$/, ''), isCopied = copied === source;
  async function copy() { try { await navigator.clipboard.writeText(source); setCopied(source); setError(false); } catch { setError(true); } }
  return <div className="chat-code"><div className="code-heading"><span>{language || '代码'}</span><button aria-label="复制代码" onClick={() => void copy()}>{isCopied ? <Check size={14}/> : <Copy size={14}/>} {isCopied ? '已复制' : '复制'}</button></div><pre>{children}</pre>{error && <span role="status">复制未成功，请长按代码选择复制。</span>}</div>;
}
// 文件预览用：相对路径的图片经文件预览票据加载；开头的 YAML 元数据折叠显示。
function assetUrl(base: string, src: string) {
  if (/^https:\/\//i.test(src)) return src;
  if (!base || /^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(src)) return '';
  return base + src.split(/[?#]/)[0].split('/').map(part => encodeURIComponent(decodeURIComponent(part))).join('/');
}
export function ChatMarkdown({ content, assetBase, document }: { content: string; assetBase?: string; document?: boolean }) {
  const meta = document ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content) : null, body = meta ? content.slice(meta[0].length) : content;
  return <div className={'markdown' + (document ? ' doc' : '')}>{meta && <details className="doc-meta"><summary>文档元数据</summary><pre>{meta[1]}</pre></details>}<Markdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} skipHtml components={{
    pre: CodeBlock,
    img: ({ src, alt }) => { const address = typeof src === 'string' ? assetUrl(assetBase ?? '', src) : ''; return address ? <img src={address} alt={alt ?? ''} loading="lazy"/> : <span className="doc-missing-image">[图片：{alt || src}]</span>; },
    a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void openExternal(href); }}>{children}</a> : <span>{children}</span>
  }}>{body}</Markdown></div>;
}
