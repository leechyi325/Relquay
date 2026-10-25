/** Restore logical lines without inserting newlines at viewport soft wraps. */
export function terminalText(buffer: { length: number; getLine(index: number): { isWrapped: boolean; length?: number; getCell?(index: number): { getCode(): number; getWidth(): number } | undefined; translateToString(trimRight?: boolean, start?: number, end?: number): string } | undefined }, cols?: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const row = buffer.getLine(i);
    if (!row) continue;
    // Preserve spaces at a wrap boundary; only trim right-side screen padding.
    const continues = !!buffer.getLine(i + 1)?.isWrapped;
    let end = cols ?? row.length;
    // A wide glyph can leave an unused cell before wrapping; omit that padding,
    // while retaining actual U+0020 spaces and wide-character continuation cells.
    if (continues && end !== undefined && row.getCell) {
      while (end > 0) {
        const cell = row.getCell(end - 1);
        if (!cell || cell.getCode() !== 0 || cell.getWidth() !== 1) break;
        end--;
      }
    }
    const text = row.translateToString(!continues, 0, end);
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n').replace(/\u00a0/g, ' ');
}

export interface TerminalCommand { id: string; name: string; command: string }
export const defaultCommands: TerminalCommand[] = [
  ['directory', '当前目录', 'pwd'], ['disk', '磁盘空间', 'df -h'], ['memory', '内存', 'free -h'],
  ['codex', '登录 Codex', 'codex login --device-auth'], ['claude', '登录 Claude', 'claude auth login'],
].map(([id, name, command]) => ({ id, name, command }));

export function savedCommands(raw: string | null): TerminalCommand[] {
  if (raw === null) return defaultCommands.map(value => ({ ...value }));
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return defaultCommands.map(value => ({ ...value }));
    const ids = new Set<string>();
    return items.filter((item): item is TerminalCommand => {
      if (!item || typeof item !== 'object') return false;
      const v = item as TerminalCommand;
      if (typeof v.id !== 'string' || !v.id || ids.has(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 60 || typeof v.command !== 'string' || !v.command.trim() || v.command.length > 16000) return false;
      ids.add(v.id); return true;
    }).slice(0, 50);
  } catch { return defaultCommands.map(value => ({ ...value })); }
}

export function commandHistory(raw: string | null): string[] {
  try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()).slice(0, 12) : []; } catch { return []; }
}
