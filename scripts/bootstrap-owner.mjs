import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import config from '../shared/config.json' with { type: 'json' };
const root = process.env.STUDIO_BASE ?? process.env.COMPILEVERSE_ROOT ?? '/home/ubuntu/compileverse';
const file = `${root}/studio/access.json`;
const address = 'http://127.0.0.1:3001/api/auth';
const status = await (await fetch(address + '/status')).json();
if (status.needsSetup) {
  const password = crypto.randomBytes(24).toString('base64url');
  const response = await fetch(address + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ubuntu', password }) });
  if (!response.ok) throw new Error('Owner bootstrap failed: ' + response.status);
  await writeFile(file, JSON.stringify({ url: `https://${config.hostname}:${config.httpsPort}`, username: 'ubuntu', password }, null, 2), { mode: 0o600 });
  console.log('Owner created; credentials stored in protected access.json (not printed).');
} else {
  const existing = JSON.parse(await readFile(file)); existing.url = `https://${config.hostname}:${config.httpsPort}`;
  await writeFile(file, JSON.stringify(existing, null, 2), { mode: 0o600 }); console.log('Owner already configured; existing credentials retained.');
}
