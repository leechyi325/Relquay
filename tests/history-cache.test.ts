import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryCache } from '../server/history-cache.ts';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relquay-hist-')), file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, '{"a":1}\n');
  let calls = 0; const load = (n = 1) => async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { success: true, data: { messages: [n] } }; };
  return { dir, file, load, calls: () => calls };
}

test('an unchanged transcript is served from memory; any change makes it parse again', async () => {
  const { dir, file, load, calls } = await setup();
  const cache = new HistoryCache(id => id === 'a' ? file : undefined);
  const first = await cache.get('a', '100|', load(1)); assert.equal(JSON.parse(first).data.messages[0], 1);
  assert.equal(await cache.get('a', '100|', load(2)), first, 'second request reuses the first page'); assert.equal(calls(), 1);
  await cache.get('a', '100|100', load(3)); assert.equal(calls(), 2, 'a different page is a different entry');
  await fs.appendFile(file, '{"b":2}\n');
  assert.equal(JSON.parse(await cache.get('a', '100|', load(4))).data.messages[0], 4, 'the file grew: parsed again'); assert.equal(calls(), 3);
  await fs.rm(dir, { recursive: true });
});

test('sessions without a known transcript, errors and concurrent identical requests', async () => {
  const { dir, file, load, calls } = await setup();
  const cache = new HistoryCache(id => id === 'a' ? file : undefined);
  await cache.get('other', 'p', load()); await cache.get('other', 'p', load()); assert.equal(calls(), 2, 'no transcript, no caching');
  await cache.get('a', 'e', async () => { calls(); return { success: false }; }); await cache.get('a', 'e', load()); assert.equal(calls(), 3, 'an empty answer is not remembered');
  const before = calls(); const [x, y] = await Promise.all([cache.get('a', 'c', load()), cache.get('a', 'c', load())]);
  assert.equal(x, y); assert.equal(calls() - before, 1, 'two simultaneous requests share one parse');
  await assert.rejects(cache.get('a', 'f', async () => { throw new Error('upstream down'); }), /upstream down/);
  await cache.get('a', 'f', load()); assert.equal(calls(), before + 2, 'a failure is not remembered');
  await fs.rm(dir, { recursive: true });
});

test('the cache stays inside its entry budget', async () => {
  const { dir, file, load } = await setup();
  const cache = new HistoryCache(() => file, 1_000_000, 3); let parsed = 0;
  const counted = async () => { parsed++; return { data: { messages: ['x'] } }; };
  for (const page of ['1', '2', '3', '4']) await cache.get('a', page, counted);
  assert.equal(parsed, 4); await cache.get('a', '4', counted); assert.equal(parsed, 4, 'most recent stays');
  await cache.get('a', '1', counted); assert.equal(parsed, 5, 'oldest was evicted');
  void load; await fs.rm(dir, { recursive: true });
});
