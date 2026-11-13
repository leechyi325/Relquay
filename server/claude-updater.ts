import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type UpdaterPaths = { versions: string; link: string; status: string };
export type UpdaterStatus = { checkedAt?: string; current?: string; previous?: string; latest?: string; ok?: boolean; message?: string; rejected?: Record<string, string> };
export type UpdaterDeps = {
  latest: () => Promise<string>;
  download: (version: string, target: string) => Promise<void>;
  smoke: (executable: string, version: string) => Promise<void>;
  now?: () => Date;
};
const KEEP = 3;

export function readStatus(file: string): UpdaterStatus { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeStatus(file: string, status: UpdaterStatus) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(status, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }

/** 当前软链接指向的受管版本；指向原生安装或不存在时返回 undefined，下次检查会接管。 */
export function managedVersion(paths: UpdaterPaths) {
  try {
    const target = fs.readlinkSync(paths.link), relative = path.relative(paths.versions, path.dirname(target));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(target) ? relative : undefined;
  } catch { return undefined; }
}
/** 先建临时软链接再 rename，切换是原子的，正在启动的会话不会读到半成品。 */
export function pointLink(paths: UpdaterPaths, version: string) {
  const temporary = paths.link + '.next';
  fs.mkdirSync(path.dirname(paths.link), { recursive: true }); fs.rmSync(temporary, { force: true });
  fs.symlinkSync(path.join(paths.versions, version, 'claude'), temporary); fs.renameSync(temporary, paths.link);
}
function prune(paths: UpdaterPaths, keep: string[]) {
  const all = fs.readdirSync(paths.versions).filter(name => /^\d+\.\d+\.\d+/.test(name)).sort((a, b) => fs.statSync(path.join(paths.versions, b)).mtimeMs - fs.statSync(path.join(paths.versions, a)).mtimeMs);
  for (const name of all.filter(name => !keep.includes(name)).slice(Math.max(0, KEEP - keep.length))) fs.rmSync(path.join(paths.versions, name), { recursive: true, force: true });
}

/** 下载最新版到独立目录，用 CloudCLI 同一个 Agent SDK 跑一轮真实对话，通过后才切换；失败的版本记下原因，之后不再重试。 */
export async function updateClaude(paths: UpdaterPaths, deps: UpdaterDeps, force = false): Promise<UpdaterStatus> {
  const status = readStatus(paths.status), now = deps.now ?? (() => new Date()), current = managedVersion(paths);
  status.checkedAt = now().toISOString(); status.current = current; status.rejected ??= {};
  try {
    const latest = await deps.latest(); status.latest = latest;
    if (current === latest) { status.ok = true; status.message = '已是最新版本'; return status; }
    if (status.rejected[latest] && !force) { status.ok = false; status.message = `${latest} 之前验证失败，继续使用 ${current ?? '原有版本'}`; return status; }
    const directory = path.join(paths.versions, latest), executable = path.join(directory, 'claude');
    if (!fs.existsSync(executable)) {
      const staging = directory + '.partial'; fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
      await deps.download(latest, staging);
      fs.chmodSync(path.join(staging, 'claude'), 0o755); fs.rmSync(directory, { recursive: true, force: true }); fs.renameSync(staging, directory);
    }
    try { await deps.smoke(executable, latest); }
    catch (e) {
      status.rejected[latest] = (e instanceof Error ? e.message : String(e)).slice(0, 300); status.ok = false;
      status.message = `${latest} 验证失败，继续使用 ${current ?? '原有版本'}：${status.rejected[latest]}`;
      if (current !== latest) fs.rmSync(directory, { recursive: true, force: true });
      return status;
    }
    pointLink(paths, latest); delete status.rejected[latest];
    status.previous = current; status.current = latest; status.ok = true; status.message = `已从 ${current ?? '原有版本'} 更新到 ${latest}`;
    prune(paths, [latest, ...(current ? [current] : [])]);
    return status;
  } catch (e) { status.ok = false; status.message = '检查更新失败：' + (e instanceof Error ? e.message : String(e)).slice(0, 300); return status; }
  finally { writeStatus(paths.status, status); }
}
export function rollbackClaude(paths: UpdaterPaths): UpdaterStatus {
  const status = readStatus(paths.status), previous = status.previous;
  if (!previous || !fs.existsSync(path.join(paths.versions, previous, 'claude'))) throw new Error('没有可回退的版本');
  const current = managedVersion(paths); pointLink(paths, previous);
  if (current) { status.rejected = { ...status.rejected, [current]: '手动回退' }; }
  Object.assign(status, { current: previous, previous: current, ok: true, message: `已回退到 ${previous}` }); writeStatus(paths.status, status); return status;
}

export async function npmLatest(registry = 'https://registry.npmjs.org') {
  const response = await fetch(`${registry}/@anthropic-ai/claude-code/latest`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('npm 返回 ' + response.status);
  const version = String(((await response.json()) as { version?: unknown }).version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无法识别的版本号 ' + version); return version;
}
/** 只取当前平台的原生包；npm pack 会按注册表的 integrity 校验下载内容。 */
export async function npmDownload(version: string, target: string) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relquay-claude-'));
  try {
    const name = `@anthropic-ai/claude-code-${process.platform}-${process.arch}@${version}`;
    const { stdout } = await run('npm', ['pack', name, '--pack-destination', temporary, '--silent'], { timeout: 600000, maxBuffer: 1 << 20 });
    await run('tar', ['xzf', path.join(temporary, stdout.trim().split('\n').at(-1)!), '-C', temporary, 'package/claude'], { timeout: 300000 });
    fs.renameSync(path.join(temporary, 'package', 'claude'), path.join(target, 'claude'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
type Query = (input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
/** 与 CloudCLI 相同的流式输入方式跑一轮 Haiku 对话，并确认 /compact 等命令仍然可用。 */
export function sdkSmoke(sdkEntry: string) {
  return async (executable: string, version: string) => {
    const { stdout } = await run(executable, ['--version'], { timeout: 30000 });
    if (!stdout.includes(version)) throw new Error('版本号不符：' + stdout.trim());
    const { query } = await import(sdkEntry) as { query: Query };
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
    async function* prompt() { yield { type: 'user', message: { role: 'user', content: 'Reply with exactly: ok' }, parent_tool_use_id: null }; await done; }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relquay-smoke-')), timer = setTimeout(finish, 120000);
    let commands: unknown[] = [], result: Record<string, unknown> | undefined;
    try {
      for await (const message of query({ prompt: prompt(), options: { pathToClaudeCodeExecutable: executable, cwd, model: 'haiku', maxTurns: 1, persistSession: false, permissionMode: 'default' } })) {
        if (message.type === 'system' && message.subtype === 'init') commands = Array.isArray(message.slash_commands) ? message.slash_commands : [];
        if (message.type === 'result') { result = message; finish(); break; }
      }
    } finally { clearTimeout(timer); finish(); fs.rmSync(cwd, { recursive: true, force: true }); }
    if (!result) throw new Error('120 秒内没有完成测试对话');
    if (result.subtype !== 'success' || result.is_error) throw new Error('测试对话失败：' + String(result.result ?? result.subtype).slice(0, 200));
    if (!commands.includes('compact')) throw new Error('初始化信息里缺少 /compact');
  };
}
