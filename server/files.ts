import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { roots, type FileLocation, type FileEntry } from '../shared/protocol.ts';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const mimeTypes: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.md': 'text/plain', '.txt': 'text/plain',
  '.py': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain', '.sh': 'text/plain', '.log': 'text/plain', '.srt': 'text/plain',
};
export const mime = (name: string) => mimeTypes[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
export function assertInside(root: string, target: string) {
  if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(403, '路径超出工作目录');
}
export class Files {
  constructor(public base: string, private rootPath: (id: string) => string = id => { if (!roots.includes(id as typeof roots[number])) throw new HttpError(400, '无效目录'); return path.join(base, id); }) {}
  async resolve(location: FileLocation, allowMissing = false): Promise<string> {
    if (location.path.includes('\0') || path.isAbsolute(location.path)) throw new HttpError(400, '无效路径');
    const root = await fs.realpath(this.rootPath(location.root));
    const target = path.resolve(root, location.path);
    assertInside(root, target);
    try { assertInside(root, await fs.realpath(target)); }
    catch (e: unknown) {
      if (allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') assertInside(root, await fs.realpath(path.dirname(target)));
      else throw e;
    }
    return target;
  }
  async list(location: FileLocation): Promise<FileEntry[]> {
    const folder = await this.resolve(location);
    const items = await fs.readdir(folder, { withFileTypes: true });
    return (await Promise.all(items.filter(e => !e.name.startsWith('.')).map(async entry => {
      const item = { root: location.root, path: path.posix.join(location.path, entry.name) };
      try {
        const checked = await this.resolve(item);
        const stat = await fs.stat(checked);
        return { ...item, name: entry.name, directory: stat.isDirectory(), size: stat.size, modified: stat.mtimeMs, mime: mime(entry.name) };
      } catch { return null; }
    }))).filter((e): e is FileEntry => e !== null).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'));
  }
  async read(location: FileLocation) {
    const filename = await this.resolve(location), stat = await fs.stat(filename);
    if (stat.size > 2 * 1024 * 1024) throw new HttpError(413, '编辑器支持 2MB 以下文本，请下载大文件');
    const bytes = await fs.readFile(filename);
    if (bytes.includes(0)) throw new HttpError(415, '该文件不是可编辑文本');
    return { content: bytes.toString('utf8'), modified: stat.mtimeMs };
  }
  async write(location: FileLocation, content: string, modified: number) {
    const filename = await this.resolve(location), stat = await fs.stat(filename);
    if (stat.mtimeMs !== modified) throw new HttpError(409, '文件已被其他操作修改，请重新打开后保存');
    const temp = path.join(path.dirname(filename), `.studio-${randomUUID()}`);
    try { await fs.writeFile(temp, content, { mode: stat.mode }); await fs.rename(temp, filename); }
    finally { await fs.rm(temp, { force: true }); }
    return { modified: (await fs.stat(filename)).mtimeMs };
  }
  async move(from: FileLocation, to: FileLocation) {
    const source = await this.resolve(from), target = await this.resolve(to, true);
    if (!from.path || !to.path) throw new HttpError(400, '不能移动根目录');
    try { await fs.lstat(target); throw new HttpError(409, '目标已存在'); }
    catch(e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await fs.rename(source, target);
  }
}
export async function streamFile(res: Response, filename: string, range?: string, download = false) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new HttpError(400, '请选择文件');
  res.set({ 'Content-Type': mime(filename), 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  if (download) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}`);
  let start = 0, end = stat.size - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2])) { res.set('Content-Range', `bytes */${stat.size}`).sendStatus(416); return; }
    if (!m[1]) { start = Math.max(0, stat.size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start < 0 || start >= stat.size) { res.set('Content-Range', `bytes */${stat.size}`).sendStatus(416); return; }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  res.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (!stat.size) { res.end(); return; }
  const stream = createReadStream(filename, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
