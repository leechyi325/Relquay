import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { AccountUsage } from '../shared/usage.ts';

export const quotaRefreshSchema = z.object({
  enabled: z.boolean(),
  // 每天固定发送的本地时刻（服务器时区），例如 06:00，用来把 5 小时窗口的起点放到想要的时间。
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(8),
  // 5 小时窗口过期（或还没开始）后立刻发一条，让新窗口尽早开始计时。
  afterReset: z.boolean(),
  message: z.string().trim().min(1).max(40),
});
export type QuotaRefreshSettings = z.infer<typeof quotaRefreshSchema>;
export type QuotaRefreshState = { settings: QuotaRefreshSettings; lastRunAt?: string; lastOk?: boolean; lastMessage?: string; nextAt?: string };
type Sender = (message: string) => Promise<void>;

export const defaultQuotaRefresh: QuotaRefreshSettings = { enabled: false, times: [], afterReset: false, message: '你好' };
const MIN_GAP = 10 * 60 * 1000, STALE = 30 * 60 * 1000;

export function fiveHourWindow(account: AccountUsage) { return account.windows.find(window => window.id === 'five_hour'); }

// 最近一个已经到点的每日时刻；用来判断“这一次该不该发”，服务重启后也不会漏发或重复发。
export function lastDue(times: string[], now: Date) {
  let best: Date | undefined;
  for (const time of times) {
    const [hour, minute] = time.split(':').map(Number), at = new Date(now); at.setHours(hour, minute, 0, 0);
    if (at > now) at.setDate(at.getDate() - 1);
    if (!best || at > best) best = at;
  }
  return best;
}
export function nextDue(times: string[], now: Date) {
  let best: Date | undefined;
  for (const time of times) {
    const [hour, minute] = time.split(':').map(Number), at = new Date(now); at.setHours(hour, minute, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    if (!best || at < best) best = at;
  }
  return best;
}

export function claudeSender(command = 'claude'): Sender {
  return message => new Promise((resolve, reject) => {
    // 在临时目录里跑，且不保留会话记录，不会在项目列表里留下垃圾会话。
    execFile(command, ['-p', message, '--model', 'haiku', '--no-session-persistence'], { cwd: os.tmpdir(), timeout: 90000, env: process.env, maxBuffer: 1 << 20 }, (error, _out, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 200))); else resolve();
    });
  });
}

export class QuotaRefresher {
  private state: QuotaRefreshState; private timer?: NodeJS.Timeout; private busy = false; private file: string;
  constructor(directory: string, private read: () => Promise<AccountUsage>, private send: Sender = claudeSender(), private now = () => new Date()) {
    this.file = path.join(directory, 'quota-refresh.json');
    let saved: Partial<QuotaRefreshState> = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* 首次启动没有配置 */ }
    const settings = quotaRefreshSchema.safeParse(saved.settings);
    this.state = { settings: settings.success ? settings.data : defaultQuotaRefresh, lastRunAt: saved.lastRunAt, lastOk: saved.lastOk, lastMessage: saved.lastMessage };
  }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.tick(), 60000); this.timer.unref(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get() { const { settings, ...rest } = this.state; return { settings, ...rest, nextAt: settings.enabled ? nextDue(settings.times, this.now())?.toISOString() : undefined }; }
  set(settings: QuotaRefreshSettings) { this.state.settings = settings; this.save(); return this.get(); }
  private save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  async trigger(reason: string) {
    if (this.busy) throw new Error('上一次刷新还在进行');
    this.busy = true; const message = this.state.settings.message;
    try { await this.send(message); this.state.lastOk = true; this.state.lastMessage = reason + '：已发送'; }
    catch (e) { this.state.lastOk = false; this.state.lastMessage = reason + '失败：' + (e instanceof Error ? e.message : String(e)); }
    finally { this.state.lastRunAt = this.now().toISOString(); this.busy = false; this.save(); }
    return this.get();
  }
  async tick() {
    const { settings } = this.state, now = this.now();
    if (!settings.enabled || this.busy) return;
    const last = this.state.lastRunAt ? Date.parse(this.state.lastRunAt) : 0;
    if (now.getTime() - last < MIN_GAP) return;
    const due = lastDue(settings.times, now);
    if (due && last < due.getTime() && now.getTime() - due.getTime() < STALE) { await this.trigger('定时 ' + due.toTimeString().slice(0, 5)); return; }
    if (settings.afterReset) {
      const account = await this.read().catch(() => undefined), window = account && fiveHourWindow(account);
      // 接口在窗口未开始时不给重置时间；给了但已过期同样说明窗口已经结束。
      if (window && (!window.resetsAt || Date.parse(window.resetsAt) <= now.getTime())) await this.trigger('5 小时窗口已重置');
    }
  }
}
