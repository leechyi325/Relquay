import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/brand.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.STUDIO_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${source}`);
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) await page.screenshot({ path: `android/app/src/main/res/mipmap-${density}/${name}.png` });
    await page.close();
  }
} finally { await browser.close(); }
