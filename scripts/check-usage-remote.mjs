import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const studio = '/home/ubuntu/compileverse/studio', base = process.env.STUDIO_CHECK_URL ?? 'http://127.0.0.1:3080';
const credentials = JSON.parse(await fs.readFile(studio + '/access.json', 'utf8'));
assert.equal((await fetch(base + '/api/usage/accounts')).status, 401); assert.equal((await fetch(base + '/api/notifications')).status, 401);
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }); assert.equal(login.status, 200); const { token } = await login.json();
const call = async (url, value) => { const response = await fetch(base + url, { method: value === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); assert.equal(response.ok, true, url + ' ' + response.status); return response.json(); };
const accounts = (await call('/api/usage/accounts')).accounts;
assert.equal(accounts.length, 2); assert.ok(accounts.every(account => ['available', 'partial', 'unavailable'].includes(account.status))); assert.ok(!JSON.stringify(accounts).includes('accessToken'));
const before = await call('/api/notifications');
const job = await call('/api/jobs', { title: 'RoamDeck 提醒失败态验收', command: 'printf "roamdeck-notice-failure-fixture\\n"; exit 2', cwd: { root: 'inputs', path: '' } });
let page;
for (let i = 0; i < 30; i++) { page = await call('/api/notifications?after=' + before.cursor); if (page.items.some(item => item.jobId === job.id)) break; await new Promise(resolve => setTimeout(resolve, 300)); }
const notice = page.items.find(item => item.jobId === job.id); assert.ok(notice); assert.equal(notice.type, 'job-failed'); assert.ok(!JSON.stringify(notice).includes('printf'));
assert.match((await call('/api/jobs/' + job.id + '/log')).log, /roamdeck-notice-failure-fixture/);
await call('/api/notifications/' + notice.id + '/read', {}); assert.ok((await call('/api/notifications/' + notice.id)).readAt);
const report = { passed: true, version: (await call('/api/health')).version, accounts: accounts.map(account => ({ provider: account.provider, status: account.status, windows: account.windows.length, lifetimeReported: account.lifetimeTokens !== undefined })), checks: ['quota and notification authentication', 'actual installed account APIs without inference', 'background failure notice', 'cursor catchup', 'metadata excludes commands', 'exact task target', 'own notice marked read'], modelInference: false };
await fs.writeFile(studio + '/state/usage-notifications-acceptance.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
