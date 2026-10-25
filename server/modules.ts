import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileModuleSchema, roots, type FileModule, type FileRoot } from '../shared/protocol.ts';
import { HttpError } from './files.ts';

const defaults = { project: '项目', inputs: '输入文件', outputs: '输出文件', logs: '运行日志' };
export class FileModules {
  modules: FileModule[];
  readonly boundaries: string[];
  private file: string;
  constructor(base: string, state: string, allowed = [base, os.homedir()]) {
    this.boundaries = [...new Set(allowed.map(dir => fs.realpathSync(dir)))];
    this.file = path.join(state, 'file-modules.json');
    this.modules = fs.existsSync(this.file) ? fileModuleSchema.array().parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))) : roots.map(id => ({ id, name: defaults[id], folders: [{ id, name: defaults[id], path: path.join(base, id) }] }));
  }
  listRoots(): FileRoot[] { return this.modules.flatMap(module => module.folders.map(folder => ({ ...folder, moduleId: module.id, moduleName: module.name }))); }
  root(id: string) { const root = this.listRoots().find(folder => folder.id === id); if (!root) throw new HttpError(404, '文件夹映射已移除，请重新选择'); return root.path; }
  async directory(input: string) {
    if (!path.isAbsolute(input) || input.includes('\0')) throw new HttpError(400, '请输入服务器上的绝对目录');
    const real = await fs.promises.realpath(input);
    if (!this.boundaries.some(base => real === base || real.startsWith(base + path.sep))) throw new HttpError(403, '目录不在服务器允许的范围内');
    if (!(await fs.promises.stat(real)).isDirectory()) throw new HttpError(400, '请选择文件夹');
    return real;
  }
  async browse(input?: string) {
    if (!input) return { path: '', entries: this.boundaries.map(folder => ({ name: folder, path: folder })) };
    const folder = await this.directory(input), entries = await fs.promises.readdir(folder, { withFileTypes: true });
    const directories = (await Promise.all(entries.filter(item => !item.name.startsWith('.')).map(async item => { try { const checked = await this.directory(path.join(folder, item.name)); return { name: item.name, path: checked }; } catch { return null; } }))).filter(item => item !== null).sort((a, b) => a.name.localeCompare(b.name));
    return { path: folder, entries: directories };
  }
  async save(input: FileModule, activeRoots: () => Set<string>) {
    const module = fileModuleSchema.parse(input), existing = this.modules.find(item => item.id === module.id);
    const used = new Set(this.listRoots().filter(root => root.moduleId !== module.id).map(root => root.id));
    for (const folder of module.folders) {
      if (used.has(folder.id)) throw new HttpError(409, '文件夹标识重复'); used.add(folder.id);
      folder.path = await this.directory(folder.path);
      // Existing IDs may only be carried by their original module.
      if (!existing?.folders.some(old => old.id === folder.id) && !folder.id.startsWith('folder_')) throw new HttpError(400, '新文件夹需要独立标识');
    }
    for (const old of existing?.folders ?? []) if (activeRoots().has(old.id) && module.folders.find(folder => folder.id === old.id)?.path !== old.path) throw new HttpError(409, '该文件夹有排队或运行中的任务，请完成后再修改');
    const next = existing ? this.modules.map(item => item.id === module.id ? module : item) : [...this.modules, module];
    if (next.length > 40) throw new HttpError(400, '最多添加 40 个模块');
    this.persist(next); return module;
  }
  remove(id: string, activeRoots: Set<string>) {
    const module = this.modules.find(item => item.id === id); if (!module) throw new HttpError(404, '模块不存在');
    if (this.modules.length < 2) throw new HttpError(409, '请至少保留一个文件模块');
    if (module.folders.some(folder => activeRoots.has(folder.id))) throw new HttpError(409, '模块中有排队或运行中的任务');
    this.persist(this.modules.filter(item => item.id !== id));
  }
  fingerprint(id: string) { return crypto.createHash('sha256').update(fs.realpathSync(this.root(id))).digest('hex'); }
  private persist(next: FileModule[]) {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); this.modules = next;
  }
}
