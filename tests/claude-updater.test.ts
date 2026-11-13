import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TransientError, managedVersion, readStatus, rollbackClaude, updateClaude } from '../server/claude-updater.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relquay-updater-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { versions: path.join(root, 'versions'), link: path.join(root, 'bin', 'claude'), status: path.join(root, 'state', 'claude-update.json') };
}
const download = async (version: string, target: string) => fs.writeFileSync(path.join(target, 'claude'), '#!/bin/sh\necho ' + version);

test('updater installs, verifies and switches only after the smoke test passes', async t => {
  const paths = setup(t); fs.mkdirSync(paths.versions, { recursive: true });
  let status = await updateClaude(paths, { latest: async () => '2.1.323', download, smoke: async () => {} });
  assert.equal(status.ok, true); assert.equal(managedVersion(paths), '2.1.323');
  status = await updateClaude(paths, { latest: async () => '2.1.323', download: async () => assert.fail('不应重复下载'), smoke: async () => assert.fail('不应重复验证') });
  assert.equal(status.message, '已是最新版本');
  status = await updateClaude(paths, { latest: async () => '2.1.330', download, smoke: async () => {} });
  assert.equal(managedVersion(paths), '2.1.330'); assert.equal(status.previous, '2.1.323');
  assert.equal(rollbackClaude(paths).current, '2.1.323'); assert.equal(managedVersion(paths), '2.1.323');
  assert.ok(readStatus(paths.status).rejected?.['2.1.330']);
});

test('a version that fails verification is rejected, removed, and not retried without --force', async t => {
  const paths = setup(t); fs.mkdirSync(paths.versions, { recursive: true });
  await updateClaude(paths, { latest: async () => '2.1.323', download, smoke: async () => {} });
  let status = await updateClaude(paths, { latest: async () => '2.1.400', download, smoke: async () => { throw new Error('SDK 协议不兼容'); } });
  assert.equal(status.ok, false); assert.match(status.message ?? '', /2\.1\.400 验证失败.*2\.1\.323/);
  assert.equal(managedVersion(paths), '2.1.323'); assert.equal(fs.existsSync(path.join(paths.versions, '2.1.400')), false);
  let tried = false;
  status = await updateClaude(paths, { latest: async () => '2.1.400', download, smoke: async () => { tried = true; } });
  assert.equal(tried, false); assert.equal(managedVersion(paths), '2.1.323');
  status = await updateClaude(paths, { latest: async () => '2.1.400', download, smoke: async () => {} }, true);
  assert.equal(managedVersion(paths), '2.1.400'); assert.equal(readStatus(paths.status).rejected?.['2.1.400'], undefined);
});

test('a link to the native install is taken over, and registry errors leave the link untouched', async t => {
  const paths = setup(t); fs.mkdirSync(paths.versions, { recursive: true }); fs.mkdirSync(path.dirname(paths.link), { recursive: true });
  const native = path.join(path.dirname(paths.versions), 'native-claude'); fs.writeFileSync(native, ''); fs.symlinkSync(native, paths.link);
  assert.equal(managedVersion(paths), undefined);
  const failed = await updateClaude(paths, { latest: async () => { throw new Error('网络不可用'); }, download, smoke: async () => {} });
  assert.equal(failed.ok, false); assert.equal(fs.readlinkSync(paths.link), native);
  await updateClaude(paths, { latest: async () => '2.1.323', download, smoke: async () => {} });
  assert.equal(managedVersion(paths), '2.1.323');
});

test('transient verification failures are not remembered, and a relative link is still recognised', async t => {
  const paths = setup(t); fs.mkdirSync(paths.versions, { recursive: true });
  await updateClaude(paths, { latest: async () => '2.1.323', download, smoke: async () => {} });
  let status = await updateClaude(paths, { latest: async () => '2.1.400', download, smoke: async () => { throw new TransientError('429 rate limit'); } });
  assert.equal(status.ok, false); assert.equal(readStatus(paths.status).rejected?.['2.1.400'], undefined);
  status = await updateClaude(paths, { latest: async () => '2.1.400', download, smoke: async () => {} });
  assert.equal(managedVersion(paths), '2.1.400');
  fs.rmSync(paths.link); fs.symlinkSync(path.relative(path.dirname(paths.link), path.join(paths.versions, '2.1.323', 'claude')), paths.link);
  assert.equal(managedVersion(paths), '2.1.323');
});
