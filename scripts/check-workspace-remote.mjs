import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const studio = process.env.STUDIO_CHECK_HOME ?? '/home/ubuntu/compileverse/studio', base = process.env.STUDIO_CHECK_URL ?? 'http://127.0.0.1:3080';
const credentials = JSON.parse(await fs.readFile(path.join(studio, 'access.json'), 'utf8'));
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
assert.equal(login.status, 200); const { token } = await login.json();
const call = async (url, value, method = 'POST') => {
  const response = await fetch(base + url, { method: value === undefined ? 'GET' : method, headers: { Authorization: 'Bearer ' + token, ...(value instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: value instanceof FormData ? value : JSON.stringify(value) }) });
  assert.ok(response.ok, `${url} ${response.status}: ${response.ok ? '' : await response.text()}`); return response.json();
};
const roots = await call('/api/roots'), inputRoot = roots.find(root => root.id === 'inputs') ?? roots[0];
const prefix = 'roamdeck-check-' + crypto.randomUUID(), folder = path.join(inputRoot.path, prefix), id = 'module_' + crypto.randomUUID();
await fs.mkdir(folder); let uploadId;
try {
  for (const name of ['one', 'two']) { await fs.mkdir(path.join(folder, name)); await fs.writeFile(path.join(folder, name, '结果.txt'), name); }
  const module = { id, name: '模块验收', folders: [{ id: 'folder_' + crypto.randomUUID(), name: '目录一', path: path.join(folder, 'one') }, { id: 'folder_' + crypto.randomUUID(), name: '目录二', path: path.join(folder, 'two') }] };
  await call('/api/file-modules/' + id, module, 'PUT');
  const modules = await call('/api/file-modules'); assert.equal(modules.find(item => item.id === id).folders.length, 2);
  assert.ok((await call('/api/files?root=' + module.folders[1].id)).some(item => item.name === '结果.txt'));
  const preview = await call('/api/files/preview', { root: module.folders[0].id, path: '结果.txt' }); assert.equal(await (await fetch(base + preview.url)).text(), 'one');
  module.name = '重命名后的模块'; module.folders[0].path = path.join(folder, 'two'); await call('/api/file-modules/' + id, module, 'PUT');
  assert.equal((await fetch(base + preview.url)).status, 410);
  const modelCounts = {};
  for (const provider of ['claude', 'codex']) { const { models } = await call('/api/agents/' + provider + '/models'); assert.ok(models.length > 0); assert.ok(models.some(model => model.efforts.length)); modelCounts[provider] = models.length; }
  const form = new FormData(); form.append('file', new Blob(['# 中文附件上传\nOracle ARM 接收验收']), '手机资料.md'); const attachment = await call('/api/chat/attachments', form); uploadId = attachment.reference.uploadId; assert.equal(attachment.name, '手机资料.md');
  await call('/api/file-modules/' + id, {}, 'DELETE'); assert.equal(await fs.readFile(path.join(folder, 'one/结果.txt'), 'utf8'), 'one');
  const report = { passed: true, version: (await call('/api/health')).version, modelCounts, checks: ['multi-folder module', 'rename and remap', 'old preview invalidated', 'source retained after removing module', 'Claude/Codex live model and effort catalogs', 'real Chinese chat upload'], modelInference: false };
  await fs.writeFile(path.join(studio, 'state/workspace-acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  await fetch(base + '/api/file-modules/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  await fs.rm(folder, { recursive: true, force: true });
  if (uploadId) await fs.rm(path.join(studio, 'state/attachments', uploadId), { recursive: true, force: true });
}
