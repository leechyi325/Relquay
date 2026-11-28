// Recognises file references in agent replies so they can open the server file.
// The accepted shapes follow Agents Anywhere's session-file-link rules (Apache-2.0):
// `file://` URIs, absolute / `~/` / relative paths, percent-encoded names and the
// `:12`, `:12:3` and `#L12` line suffixes agents append.
import { defaultUrlTransform } from 'react-markdown';

const lineAnchor = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, lineSuffix = /:\d+(?:-\d+)?(?::\d+)?$/;
const scheme = /^([a-z][a-z0-9+.-]+):/i, shellSyntax = /[|&;<>`*?"$]|(?:^|\s)-{1,2}[a-z]/i;
const commandWords = new Set(['bash', 'cat', 'cd', 'code', 'cp', 'echo', 'git', 'head', 'less', 'ls', 'mv', 'nano', 'node', 'npm', 'npx', 'open', 'pnpm', 'python', 'python3', 'rm', 'sh', 'tail', 'touch', 'vi', 'vim', 'yarn']);
// Bare names (no folder) only count for documents and media an agent hands over, so `console.log` stays code.
const standalone = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'tsv', 'html', 'htm', 'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'zip', 'mp3', 'mp4', 'mov', 'wav', 'm4a', 'apk']);

/** Keeps `file:` links, which react-markdown's default transform empties, and still strips unsafe schemes. */
export function urlTransform(value: string) { return /^file:/i.test(value) ? value : defaultUrlTransform(value); }

function decode(value: string) { try { return /%[0-9a-f]{2}/i.test(value) ? decodeURIComponent(value) : value; } catch { return value; } }
function clean(value: string) { const path = value.trim().replace(lineAnchor, '').replace(lineSuffix, ''); return path && path !== '/' ? path : null; }

/** A Markdown link destination that is not a web address, as a server path. */
export function linkPath(href: string): string | null {
  let value = href.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return null;
  const match = scheme.exec(value);
  if (match) {
    if (match[1].toLowerCase() !== 'file') return null;
    value = value.slice(5).replace(/^\/\/(localhost)?(?=\/)/i, '').split(/[?#]/)[0];
  }
  return clean(decode(value));
}

/** An inline code span such as `src/App.tsx:12`, or null when it reads as a command or plain code. */
export function codePath(code: string): string | null {
  const text = code.trim();
  if (!text || text.length > 400 || text.includes('\n')) return null;
  if (/^file:/i.test(text)) return linkPath(text);
  if (text.includes('://') || shellSyntax.test(text) || /\s/.test(text) && commandWords.has(text.split(/\s/)[0].toLowerCase())) return null;
  const candidate = text.replace(lineAnchor, '').replace(lineSuffix, ''), name = candidate.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const folder = candidate.includes('/');
  // Folders count when written with an explicit root (`~/dev/app/`, `./docs`), files when they carry an extension.
  if (!extension || !/^[a-z0-9]{1,10}$/.test(extension)) return folder && /^(\/|~\/|\.{1,2}\/)/.test(candidate) && !/\s/.test(candidate) ? clean(candidate) : null;
  if (!folder && !standalone.has(extension)) return null;
  if (/\s/.test(candidate) && !standalone.has(extension)) return null;
  return clean(candidate);
}

/** The line number an agent appended (`a.ts:12`, `a.ts:12:3`, `a.ts#L12`). */
export function fileLine(raw: string) { const match = /(?:#L|:)(\d+)(?:[-:C]L?\d+)*$/.exec(raw.trim()); return match ? Number(match[1]) || undefined : undefined; }

/** File paths named by a tool call (Read, Write, Edit, apply_patch …). */
export function toolPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = input as Record<string, unknown>, found = [value.file_path, value.notebook_path, value.path].filter((item): item is string => typeof item === 'string' && !!item.trim());
  return [...new Set(found)].slice(0, 3);
}
