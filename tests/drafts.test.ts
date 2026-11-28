import test from 'node:test';
import assert from 'node:assert/strict';
import { clearDrafts, readDraft, writeDraft } from '../src/drafts.ts';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; }, keys: () => [...data.keys()] };
}
test('drafts are kept per server and session, and removed when emptied', () => {
  const local = storage(); Object.defineProperty(globalThis, 'localStorage', { value: new Proxy(local, { ownKeys: () => local.keys(), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }), configurable: true });
  writeDraft('https://a', 's1', '你好'); writeDraft('https://a', 's2', '第二个'); writeDraft('https://b', 's1', '另一台');
  assert.equal(readDraft('https://a', 's1'), '你好'); assert.equal(readDraft('https://a', 's2'), '第二个'); assert.equal(readDraft('https://b', 's1'), '另一台');
  writeDraft('https://a', 's1', '   '); assert.equal(readDraft('https://a', 's1'), '', 'blank text removes the draft');
  clearDrafts('https://a'); assert.equal(readDraft('https://a', 's2'), ''); assert.equal(readDraft('https://b', 's1'), '另一台', 'other servers keep theirs');
  writeDraft('https://a', 's3', 'x'.repeat(30000)); assert.equal(readDraft('https://a', 's3').length, 20000);
  clearDrafts(); assert.equal(readDraft('https://b', 's1'), '');
});
test('a blocked storage never throws', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }, configurable: true });
  assert.equal(readDraft('o', 'i'), ''); assert.doesNotThrow(() => writeDraft('o', 'i', 'text')); assert.doesNotThrow(() => clearDrafts());
});
