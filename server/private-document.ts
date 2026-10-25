import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './files.ts';
export type PrivateDocument = { path: string; content: string; revision: string; exists: boolean };
export async function readPrivate(filename: string, limit = 2 * 1024 * 1024): Promise<PrivateDocument> {
  let content = '', exists = true;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(403, '配置必须是普通文件，不能是符号链接');
    if (stat.size > limit) throw new HttpError(413, '文件过大，无法管理');
    content = await fs.readFile(filename, 'utf8');
  } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; exists = false; }
  return { path: filename, content, exists, revision: createHash('sha256').update(JSON.stringify([exists, content])).digest('hex') };
}
export async function writePrivate(before: PrivateDocument, content: string) {
  const filename = before.path, temp = filename + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    if ((await readPrivate(filename)).revision !== before.revision) throw new HttpError(409, '文件已被其他操作修改，请重新读取');
    await fs.rename(temp, filename);
  } finally { await fs.rm(temp, { force: true }); }
}
