import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../shared/config.json' with { type: 'json' };
const root = process.env.STUDIO_BASE ?? process.env.COMPILEVERSE_ROOT ?? '/home/ubuntu/compileverse';
const file = process.env.STUDIO_ACCESS_FILE ?? path.join(root, 'studio/access.json');
const username = process.env.STUDIO_OWNER_USERNAME ?? 'ubuntu';
const origin = new URL(process.env.STUDIO_ORIGIN ?? `https://${config.hostname}:${config.httpsPort}`);
const cloud = new URL(process.env.CLOUDCLI_URL ?? 'http://127.0.0.1:3001');
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('STUDIO_ORIGIN must be an HTTP(S) origin');
if (cloud.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(cloud.hostname) || cloud.username || cloud.password || cloud.pathname !== '/' || cloud.search || cloud.hash) throw new Error('Owner setup requires a loopback CLOUDCLI_URL');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(username)) throw new Error('Invalid owner username');
const request = async (endpoint, options = {}) => {
  const response = await fetch(cloud.origin + '/api/auth' + endpoint, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Owner setup request failed: ' + response.status);
  return response.json();
};
const status = await request('/status');
if (status.needsSetup === true) {
  const password = crypto.randomBytes(24).toString('base64url');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Persist first and refuse overwrite: even an ambiguous network failure must not lose the new password.
  await writeFile(file, JSON.stringify({ url: origin.origin, username, password }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  console.log('Owner created; credentials stored in protected access.json (not printed).');
} else if (status.needsSetup === false) {
  const existing = JSON.parse(await readFile(file, 'utf8')); existing.url = origin.origin;
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  console.log('Owner already configured; existing credentials retained.');
} else throw new Error('Unexpected owner setup status');
