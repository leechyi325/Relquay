import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const credentials = JSON.parse(await readFile('private/access.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  const response = await context.request.post(credentials.url + '/api/login', { data: credentials });
  const { token } = await response.json();
  const link = await context.request.post(credentials.url + '/api/filebrowser-link', { data: {}, headers: { Authorization: 'Bearer ' + token } });
  const { url } = await link.json();
  const navigation = await page.goto(credentials.url + url);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'artifacts/filebrowser-inspection.png' });
  console.log(JSON.stringify({ status: navigation.status(), path: new URL(page.url()).pathname, title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 900), errors }));
} finally { await browser.close(); }
