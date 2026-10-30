import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaRefresher, lastDue, nextDue } from '../server/quota-refresh.ts';
import type { AccountUsage } from '../shared/usage.ts';

const account = (resetsAt?: string): AccountUsage => ({ provider: 'claude', status: 'available', updatedAt: '', source: '', windows: [{ id: 'five_hour', name: '5 小时窗口', usedPercent: 0, resetsAt }] });
const setup = (read: () => Promise<AccountUsage>, clock: { at: Date }) => {
  const sent: string[] = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-refresh-'));
  return { sent, dir, refresher: new QuotaRefresher(dir, read, async message => { sent.push(message); }, () => clock.at) };
};

test('due times pick the latest passed and next upcoming local time', () => {
  const now = new Date(2026, 9, 30, 7, 0);
  assert.deepEqual(lastDue(['06:00', '12:00'], now), new Date(2026, 9, 30, 6, 0));
  assert.deepEqual(lastDue(['08:00'], now), new Date(2026, 9, 29, 8, 0));
  assert.deepEqual(nextDue(['06:00', '12:00'], now), new Date(2026, 9, 30, 12, 0));
});

test('sends once per scheduled time, not again, and skips a time missed by too long', async () => {
  const clock = { at: new Date(2026, 9, 30, 6, 1) }, { sent, refresher } = setup(async () => account('2099-01-01T00:00:00Z'), clock);
  refresher.set({ enabled: true, times: ['06:00'], afterReset: false, message: '你好' });
  await refresher.tick(); assert.deepEqual(sent, ['你好']);
  clock.at = new Date(2026, 9, 30, 6, 30); await refresher.tick(); assert.equal(sent.length, 1);
  clock.at = new Date(2026, 9, 31, 9, 0); await refresher.tick(); assert.equal(sent.length, 1, '3 hours late: do not fire');
  clock.at = new Date(2026, 9, 31, 6, 2); await refresher.tick(); assert.equal(sent.length, 2);
});

test('after-reset sends when the 5h window is over or not started, but not while it is running', async () => {
  const clock = { at: new Date(2026, 9, 30, 10, 0) };
  let reset: string | undefined = new Date(2026, 9, 30, 12, 0).toISOString();
  const { sent, refresher } = setup(async () => account(reset), clock);
  refresher.set({ enabled: true, times: [], afterReset: true, message: '你好' });
  await refresher.tick(); assert.equal(sent.length, 0);
  reset = undefined; await refresher.tick(); assert.equal(sent.length, 1);
  clock.at = new Date(2026, 9, 30, 10, 5); await refresher.tick(); assert.equal(sent.length, 1, 'min gap');
  clock.at = new Date(2026, 9, 30, 10, 20); await refresher.tick(); assert.equal(sent.length, 2);
});

test('disabled refresher never sends and failures are recorded', async () => {
  const clock = { at: new Date(2026, 9, 30, 6, 1) }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-refresh-'));
  const refresher = new QuotaRefresher(dir, async () => account(), async () => { throw new Error('未登录'); }, () => clock.at);
  refresher.set({ enabled: false, times: ['06:00'], afterReset: true, message: '你好' }); await refresher.tick();
  assert.equal(refresher.get().lastRunAt, undefined);
  const state = await refresher.trigger('手动发送'); assert.equal(state.lastOk, false); assert.match(state.lastMessage!, /未登录/);
  assert.equal(new QuotaRefresher(dir, async () => account()).get().settings.times[0], '06:00', 'settings persist');
});
