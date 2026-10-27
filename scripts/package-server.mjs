import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(app);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid package version');
// Git limits source delivery to reviewed files. Never copy a whole working directory or live dist.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const roots = ['.github/', 'server/', 'shared/', 'src/', 'public/', 'docs/', 'scripts/', 'upstream/'];
const top = new Set(['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', '.env.example']);
const files = new Set(tracked.filter(file => path.basename(file) !== 'AGENTS.md' && (top.has(file) || roots.some(root => file.startsWith(root)))));
files.add('scripts/package-server.mjs');
for (const file of ['AGENTS.md', 'CHANGELOG.md']) files.delete(file);
await mkdir('.runtime', { recursive: true });
await mkdir('artifacts', { recursive: true });
const stage = await mkdtemp(path.join(app, '.runtime/server-package-'));
const name = `relquay-server-${version}`, bundle = path.join(stage, name);
try {
  for (const file of files) {
    if (path.isAbsolute(file) || file.split('/').includes('..')) throw new Error('Invalid source path');
    const source = path.join(app, file);
    if (!(await lstat(source)).isFile()) throw new Error(`Package source is not a regular file: ${file}`);
    await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
    await cp(source, path.join(bundle, file));
  }
  execFileSync('npm', ['run', 'typecheck'], { stdio: 'inherit' });
  execFileSync('npm', ['exec', 'vite', '--', 'build', '--outDir', path.join(bundle, 'dist')], { stdio: 'inherit' });
  const artifact = path.join(app, 'artifacts', `${name}.tar.gz`);
  execFileSync('tar', ['--no-xattrs', '-czf', artifact, '-C', stage, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const checksum = createHash('sha256').update(await readFile(artifact)).digest('hex');
  await writeFile(artifact + '.sha256', `${checksum}  ${name}.tar.gz\n`);
  console.log(`Server bundle: ${artifact}\nSHA-256: ${checksum}\nDependencies are installed on the target host; see README.md.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
