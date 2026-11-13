// 由 relquay-claude-update.timer 每周运行：验证通过才切换 Relquay 使用的 Claude Code。
// 用法：tsx scripts/update-claude.ts [--force] [--rollback]
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { npmDownload, npmLatest, rollbackClaude, sdkSmoke, updateClaude } from '../server/claude-updater.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root = process.env.RELQUAY_ROOT ?? path.join(os.homedir(), 'relquay');
const paths = {
  versions: process.env.RELQUAY_CLAUDE_VERSIONS ?? path.join(root, 'claude-versions'),
  link: process.env.RELQUAY_CLAUDE_LINK ?? path.join(root, 'claude-bin', 'claude'),
  status: path.join(process.env.STUDIO_STATE ?? path.join(root, 'state'), 'claude-update.json')
};
const sdk = path.join(app, 'upstream/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const args = process.argv.slice(2);
try {
  const status = args.includes('--rollback') ? rollbackClaude(paths) : await updateClaude(paths, { latest: () => npmLatest(), download: npmDownload, smoke: sdkSmoke(sdk) }, args.includes('--force'));
  console.log(status.message); process.exitCode = status.ok ? 0 : 1;
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
