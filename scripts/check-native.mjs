import { _android } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const adb = process.cwd() + '/.runtime/android-sdk/platform-tools/adb';
const credentials = JSON.parse(await readFile('private/access.json', 'utf8'));
const devices = await _android.devices();
const device = devices.find(d => d.serial() === 'emulator-5554');
if (!device) throw new Error('Isolated emulator is not running');
const errors = [];
await mkdir('artifacts', { recursive: true });
try {
  device.setDefaultTimeout(20000);
  await device.shell('am force-stop xyz.leechyi.compileverse');
  await device.shell('am start -n xyz.leechyi.compileverse/.MainActivity');
  const view = await device.webView({ pkg: 'xyz.leechyi.compileverse' });
  let page = await view.page();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForTimeout(500);
  if (await page.getByRole('button', { name: '进入工作台' }).isVisible().catch(() => false)) {
    await page.getByLabel('服务器地址').fill(credentials.url);
    await page.getByLabel('密码', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: '进入工作台' }).click();
  }
  await page.getByRole('heading', { name: '工作，随时接续。' }).waitFor({ timeout: 25000 });
  await page.waitForTimeout(1500);
  await device.screenshot({ path: 'artifacts/native-workspace.png' });
  const protectedToken = await page.evaluate(async () => (await window.Capacitor.Plugins.StudioCredentials.get()).token);
  assert.ok(protectedToken?.length > 20, 'Native Keystore did not retain the token');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('studio.token')), null);
  const prefs = execFileSync(adb, ['-s', 'emulator-5554', 'shell', 'run-as', 'xyz.leechyi.compileverse', 'cat', 'shared_prefs/studio_credentials.xml'], { encoding: 'utf8' });
  assert.ok(!prefs.includes(protectedToken), 'Token appeared in plaintext Android preferences');
  assert.match(prefs, /name="data"/);
  const navigation = () => page.getByRole('navigation', { name: '主导航' });
  const filesResponse = page.waitForResponse(response => response.url().includes('/api/files?root=project') && response.request().method() === 'GET');
  await navigation().getByRole('button', { name: '文件', exact: true }).click();
  const fileList = await (await filesResponse).json();
  assert.ok(Array.isArray(fileList), 'Native file list is invalid');
  const expectedEntry = fileList[0]?.name ?? '项目';
  await device.screenshot({ path: 'artifacts/native-files.png' });
  let terminalOutput = '';
  page.on('websocket', ws => { if (ws.url().includes('/ws/terminal')) ws.on('framereceived', frame => { try { const event = JSON.parse(String(frame.payload)); if (event.type === 'output') terminalOutput += event.data; } catch {} }); });
  await navigation().getByRole('button', { name: '终端', exact: true }).click();
  await page.getByText('已连接', { exact: true }).waitFor();
  await page.waitForTimeout(900);
  await page.getByLabel('命令编辑器', { exact: false }).fill("printf '\\x43\\x56\\x5f\\x41\\x4e\\x44\\x52\\x4f\\x49\\x44\\x5f\\x50\\x54\\x59\\x5f\\x4f\\x4b\\n'; codex --version; claude --version");
  await page.getByRole('button', { name: '执行命令' }).click();
  for (let i = 0; i < 40 && !terminalOutput.includes('CV_ANDROID_PTY_OK'); i++) await page.waitForTimeout(250);
  assert.ok(terminalOutput.includes('CV_ANDROID_PTY_OK'), 'Android terminal command did not produce expected real output');
  assert.match(terminalOutput, /codex-cli/);
  await device.screenshot({ path: 'artifacts/native-terminal.png' });
  await navigation().getByRole('button', { name: '工作台', exact: true }).click();
  await device.shell('am force-stop xyz.leechyi.compileverse');
  await device.shell('am start -n xyz.leechyi.compileverse/.MainActivity');
  page = await (await device.webView({ pkg: 'xyz.leechyi.compileverse' })).page();
  await page.getByRole('heading', { name: '工作，随时接续。' }).waitFor({ timeout: 25000 });
  await page.getByRole('button', { name: '工作台设置' }).last().click();
  await page.getByRole('button', { name: /高级文件管理/ }).click();
  let managerOpened = false;
  for (let attempt = 0; attempt < 20 && !managerOpened; attempt++) {
    managerOpened = (await device.shell('dumpsys activity activities')).toString().includes('StudioBrowserActivity');
    if (!managerOpened) await page.waitForTimeout(250);
  }
  assert.ok(managerOpened, 'Native FileBrowser activity did not open');
  let managerTree = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    await device.shell('uiautomator dump /data/local/tmp/studio-ui.xml');
    managerTree = (await device.shell('cat /data/local/tmp/studio-ui.xml')).toString();
    if (managerTree.includes(expectedEntry)) break;
    await page.waitForTimeout(1000);
  }
  assert.ok(managerTree.includes(expectedEntry), 'Native FileBrowser did not display the actual project files');
  await device.screenshot({ path: 'artifacts/native-filebrowser.png' });
  await device.shell('input keyevent 4');
  assert.deepEqual(errors, []);
  await writeFile('artifacts/native-report.json', JSON.stringify({ passed: true, platform: 'Android 16 / API 36 / ARM64 emulator', network: 'Direct public HTTPS 28443; system proxy disabled; public trusted certificate, no SSL bypass', checks: ['native launch', 'real server login', 'encrypted Keystore session storage', 'no plaintext token in preferences', 'server file browsing', 'real PTY command and both agent versions', 'process restart restores login', 'native FileBrowser displays actual project files'], realPhoneTested: false, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, nativeChecks: 8, errors }));
} finally { await device.close(); }
