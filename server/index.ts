import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './app.ts';
import { defaultOrigin } from '../shared/config.ts';
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = createStudio({
  base: process.env.STUDIO_BASE ?? process.env.COMPILEVERSE_ROOT ?? '/home/ubuntu/compileverse',
  state: process.env.STUDIO_STATE ?? path.join(appDir, '.state'),
  cloud: process.env.CLOUDCLI_URL ?? 'http://127.0.0.1:3001',
  dist: path.join(appDir, 'dist'), origin: process.env.STUDIO_ORIGIN ?? defaultOrigin,
  filebrowser: process.env.FILEBROWSER_URL, envFile: process.env.STUDIO_ENV_FILE,
});
studio.server.listen(Number(process.env.STUDIO_PORT ?? 3080), process.env.STUDIO_HOST ?? '127.0.0.1', () => console.log('RoamDeck ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { studio.close(); setTimeout(() => process.exit(0), 4000).unref(); });
