import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function fixture(run: (state: { directory: string; cloud: string; registrations: { username: string; password: string }[] }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roamdeck-owner-')), registrations: { username: string; password: string }[] = [];
  let ready = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/status') { res.end(JSON.stringify({ needsSetup: !ready })); return; }
    if (req.url === '/api/auth/register' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      registrations.push(JSON.parse(body)); ready = true; res.end(JSON.stringify({ success: true })); return;
    }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run({ directory, cloud: `http://127.0.0.1:${(server.address() as { port: number }).port}`, registrations }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}
async function bootstrap(environment: Record<string, string>) {
  const env = { ...process.env };
  for (const key of ['STUDIO_BASE', 'COMPILEVERSE_ROOT', 'STUDIO_ACCESS_FILE', 'STUDIO_OWNER_USERNAME', 'STUDIO_ORIGIN', 'CLOUDCLI_URL']) delete env[key];
  const child = spawn(process.execPath, ['scripts/bootstrap-owner.mjs'], { env: { ...env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const [code] = await once(child, 'exit'); return { code, output };
}

test('portable owner setup uses loopback, explicit origin/user/private path; rerun retains credentials and private mode', async () => fixture(async ({ directory, cloud, registrations }) => {
  const file = path.join(directory, 'private', 'access.json'), env = { CLOUDCLI_URL: cloud, STUDIO_ACCESS_FILE: file, STUDIO_OWNER_USERNAME: 'owner', STUDIO_ORIGIN: 'https://workspace.example.com:28443' };
  const first = await bootstrap(env); assert.equal(first.code, 0, first.output); assert.equal(registrations.length, 1);
  const credentials = JSON.parse(await readFile(file, 'utf8')); assert.equal(credentials.url, env.STUDIO_ORIGIN); assert.equal(credentials.username, 'owner'); assert.equal(credentials.password, registrations[0].password); assert.ok(credentials.password.length >= 32);
  assert.equal(first.output.includes(credentials.password), false); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const second = await bootstrap({ ...env, STUDIO_ORIGIN: 'https://second.example.com' }); assert.equal(second.code, 0, second.output);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...credentials, url: 'https://second.example.com' }); assert.equal(registrations.length, 1); assert.equal((await stat(file)).mode & 0o777, 0o600);
}));

test('owner setup never overwrites existing credentials during fresh setup or registers against a remote origin', async () => fixture(async ({ directory, cloud, registrations }) => {
  const file = path.join(directory, 'access.json'); await writeFile(file, 'preserve original');
  const env = { CLOUDCLI_URL: cloud, STUDIO_ACCESS_FILE: file, STUDIO_ORIGIN: 'https://workspace.example.com' };
  assert.notEqual((await bootstrap(env)).code, 0); assert.equal(await readFile(file, 'utf8'), 'preserve original'); assert.equal(registrations.length, 0);
  assert.notEqual((await bootstrap({ ...env, CLOUDCLI_URL: 'https://remote.example.com' })).code, 0); assert.equal(registrations.length, 0);
}));

test('legacy owner setup keeps the existing root/studio/access.json and ubuntu username defaults', async () => fixture(async ({ directory, cloud }) => {
  const result = await bootstrap({ STUDIO_BASE: directory, CLOUDCLI_URL: cloud });
  assert.equal(result.code, 0, result.output);
  const credentials = JSON.parse(await readFile(path.join(directory, 'studio/access.json'), 'utf8'));
  assert.equal(credentials.username, 'ubuntu'); assert.equal(credentials.url, 'https://workspace.example.com:28443');
}));
