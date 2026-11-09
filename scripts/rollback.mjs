import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHANNEL, normalizeChannel, readChannel } from '../services/ota/src/release-store.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..');
const MOBILE_DIR = path.join(ROOT, 'apps', 'mobile');
const PUBLISH_SCRIPT = path.join(scriptsDir, 'publish.mjs');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {
    channel: DEFAULT_CHANNEL,
    runtimeVersion: null,
    release: null,
    operator: process.env.OTA_OPERATOR || 'cli',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--channel') args.channel = normalizeChannel(argv[++i]);
    else if (key === '--runtime-version') args.runtimeVersion = argv[++i];
    else if (key === '--release') args.release = argv[++i];
    else if (key === '--operator') args.operator = argv[++i] || args.operator;
    else if (key === '--help' || key === '-h') {
      console.log(`用法: node scripts/rollback.mjs [选项]
  --channel <name>        目标通道（默认 production）
  --runtime-version <rv>  指定 runtimeVersion
  --release <id>          回滚到指定版本（缺省回滚到通道 previous）`);
      process.exit(0);
    }
  }
  return args;
}

function resolveRuntimeVersion(explicit) {
  if (explicit) return String(explicit);
  const config = require(path.join(MOBILE_DIR, 'app.config.js'));
  const runtimeVersion = config.expo?.runtimeVersion;
  if (typeof runtimeVersion === 'string') return runtimeVersion;
  if (runtimeVersion?.policy === 'appVersion') return config.expo.version;
  throw new Error('无法从 app.config.js 推导 runtimeVersion，请显式传 --runtime-version');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeVersion = resolveRuntimeVersion(args.runtimeVersion);
  const channel = await readChannel(runtimeVersion, args.channel);

  const target = args.release || channel?.previous?.releaseId;
  if (!target) {
    throw new Error(`通道 ${args.channel} 没有可回滚的版本`);
  }

  console.log(
    `[rollback] 通道 ${args.channel}：${channel?.releaseId || '-'} → ${target}`,
  );
  const result = spawnSync(
    process.execPath,
    [
      PUBLISH_SCRIPT,
      '--release',
      target,
      '--channel',
      args.channel,
      '--runtime-version',
      runtimeVersion,
      '--operator',
      `${args.operator}:rollback`,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`回滚失败（退出码 ${result.status}）`);
  }
  console.log('[rollback] 完成（已重新发布并刷新 createdAt）');
}

main().catch((error) => {
  console.error(`[rollback] 失败: ${error.message}`);
  process.exitCode = 1;
});
