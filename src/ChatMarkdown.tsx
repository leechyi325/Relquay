import { Children, createContext, isValidElement, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import { highlighted, highlighterReady, languageOf, loadHighlighter } from './highlight';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { openExternal } from './api';
import { codePath, fileLine, linkPath, urlTransform } from './file-links';

export type OpenPath = (path: string, line?: number) => void;

const InBlock = createContext(false);

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(value => typeof value === 'string' || typeof value === 'number' ? String(value) : isValidElement<{ children?: ReactNode }>(value) ? textOf(value.props.children) : '').join('');
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
    code: ({ children, className }) => <InlineCode className={className} open={openPath}>{children}</InlineCode>,
    img: ({ src, alt }) => { const address = typeof src === 'string' ? assetUrl(assetBase ?? '', src) : ''; return address ? <img src={address} alt={alt ?? ''} loading="lazy"/> : <span className="doc-missing-image">[图片：{alt || src}]</span>; },
    a: ({ href, children }) => {
      if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void openExternal(href); }}>{children}</a>;
      const path = href && openPath && !document ? linkPath(href) : null;
      return path ? <button type="button" className="file-link" title={'打开 ' + path} onClick={() => openPath!(path, fileLine(href!))}>{children}</button> : <span>{children}</span>;
    }
  }}>{body}</Markdown></div>;
});
