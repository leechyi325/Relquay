import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentConfigs } from '../server/agent-config.ts';
import { Jobs } from '../server/jobs.ts';
import { Files } from '../server/files.ts';
import { fixture, until } from './helpers.ts';

test('agent configuration validates format, preserves concurrent changes and excludes symlinks', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'roamdeck-config-'));
  const configs = new AgentConfigs({ codex: path.join(temp, 'codex'), claude: path.join(temp, 'claude') });
  try {
    const missing = await configs.read('codex'); assert.equal(missing.exists, false);
    await assert.rejects(configs.write('codex', '#' + 'a'.repeat(512 * 1024), missing.revision), /512KB/);
    const saved = await configs.write('codex', 'model = "test"\n', missing.revision);
    assert.equal(saved.content, 'model = "test"\n');
    assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
    await assert.rejects(configs.write('codex', 'model = [', saved.revision), /TOML/);
    await assert.rejects(configs.write('codex', 'model = "stale"', missing.revision), /其他操作/);
    await fs.writeFile(saved.path, '# external change\n');
    await assert.rejects(configs.write('codex', '# overwrite', saved.revision), /其他操作/);
    assert.equal((await configs.read('codex')).content, '# external change\n');
    const claude = await configs.read('claude');
    await assert.rejects(configs.write('claude', '[]', claude.revision), /JSON/);
    await configs.write('claude', '{"permissions":{"defaultMode":"default"}}', claude.revision);
    await fs.rm(saved.path); await fs.symlink((await configs.read('claude')).path, saved.path);
    await assert.rejects(configs.read('codex'), /符号链接/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('job edits respect execution history; deleting queued jobs prevents execution and retains outputs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'roamdeck-job-edit-'));
  await fs.mkdir(path.join(temp, 'project')); const jobs = new Jobs(path.join(temp, 'state'), new Files(temp));
  try {
    const first = await jobs.add('running', 'sleep 10', { root: 'project', path: '' });
    await until(() => !!jobs.child?.pid);
    const queued = await jobs.add('queued', 'touch must-not-run', { root: 'project', path: '' });
    jobs.update(queued.id, 'edited', 'echo edited'); assert.equal(queued.command, 'echo edited');
    assert.throws(() => jobs.update(first.id, 'bad', 'echo replacement'), /排队/);
    jobs.update(first.id, 'running renamed'); assert.equal(first.title, 'running renamed');
    assert.throws(() => jobs.remove(first.id), /取消/);
    await fs.writeFile(path.join(temp, 'project/output.txt'), 'keep');
    jobs.remove(queued.id); assert.ok(!jobs.records.some(job => job.id === queued.id));
    jobs.cancel(first.id); await until(() => first.status === 'cancelled');
    jobs.remove(first.id);
    assert.equal(await fs.readFile(path.join(temp, 'project/output.txt'), 'utf8'), 'keep');
    assert.equal(new Jobs(path.join(temp, 'state'), new Files(temp)).records.length, 0);
  } finally { jobs.stop(); await fs.rm(temp, { recursive: true, force: true }); }
});

test('settings and task mutation routes require login and persist actual changes', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + '/api/agents/codex/config')).status, 401);
    assert.equal((await fetch(f.base + '/api/jobs/missing', { method: 'DELETE' })).status, 401);
    const config = await (await f.call('/api/agents/codex/config')).json();
    const save = await f.call('/api/agents/codex/config', { method: 'PUT', body: JSON.stringify({ content: '# hello\n', revision: config.revision }) });
    assert.equal(save.status, 200); assert.equal(save.headers.get('cache-control'), 'no-store');
    assert.equal((await (await f.call('/api/agents/codex/config')).json()).content, '# hello\n');
    assert.equal((await f.call('/api/agents/other/config')).status, 400);
    const job = await f.studio.jobs.add('original', 'echo done', { root: 'project', path: '' });
    await until(() => job.status === 'succeeded');
    assert.equal((await f.call('/api/jobs/' + job.id, { method: 'PUT', body: JSON.stringify({ title: 'renamed' }) })).status, 200);
    assert.equal((await f.call('/api/jobs/' + job.id, { method: 'PUT', body: JSON.stringify({ title: 'renamed', command: 'echo changed' }) })).status, 409);
    assert.equal((await f.call('/api/jobs/' + job.id, { method: 'DELETE' })).status, 200);
    assert.equal((await f.call('/api/jobs/' + job.id + '/log')).status, 404);
  } finally { await f.close(); }
});
