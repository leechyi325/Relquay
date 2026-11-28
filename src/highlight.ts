import type { HLJSApi } from 'highlight.js';

// Loaded on the first code block that names a language, so the chat bundle stays small.
const languages: Record<string, () => Promise<{ default: Parameters<HLJSApi['registerLanguage']>[1] }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'), typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'), bash: () => import('highlight.js/lib/languages/bash'),
  python: () => import('highlight.js/lib/languages/python'), css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'), yaml: () => import('highlight.js/lib/languages/yaml'),
  markdown: () => import('highlight.js/lib/languages/markdown'), diff: () => import('highlight.js/lib/languages/diff'),
  go: () => import('highlight.js/lib/languages/go'), rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'), sql: () => import('highlight.js/lib/languages/sql'),
  ini: () => import('highlight.js/lib/languages/ini'), kotlin: () => import('highlight.js/lib/languages/kotlin'),
};
const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python', html: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', md: 'markdown', patch: 'diff', toml: 'ini', kt: 'kotlin', golang: 'go', rs: 'rust' };
export const languageOf = (name?: string) => { const value = (name ?? '').toLowerCase(); const id = aliases[value] ?? value; return id in languages ? id : undefined; };

let engine: HLJSApi | undefined, loading: Promise<HLJSApi> | undefined;
/** Highlights synchronously once loaded; returns undefined (plain text) until then or for unknown languages. */
export function highlighted(code: string, language?: string) {
  const id = languageOf(language);
  if (!engine || !id || code.length > 60000 || !engine.getLanguage(id)) return undefined;
  try { return engine.highlight(code, { language: id, ignoreIllegals: true }).value; } catch { return undefined; }
}
export function loadHighlighter() {
  return loading ??= (async () => {
    const [{ default: core }, ...modules] = await Promise.all([import('highlight.js/lib/core'), ...Object.values(languages).map(load => load())]);
    Object.keys(languages).forEach((id, index) => core.registerLanguage(id, modules[index].default));
    engine = core; return core;
  })();
}
export const highlighterReady = () => !!engine;
