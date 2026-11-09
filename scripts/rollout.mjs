import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CHANNEL,
  channelLockFile,
  normalizeChannel,
  readChannel,
  setRollout,
} from '../services/ota/src/release-store.mjs';
import { withLock } from '../services/ota/src/locks.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..');
const MOBILE_DIR = path.join(ROOT, 'apps', 'mobile');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {
    channel: DEFAULT_CHANNEL,
    runtimeVersion: null,
    percentage: null,
    platform: null,
    clearPlatform: false,
    whitelist: null,
    add: [],
    remove: [],
    show: false,
    operator: process.env.OTA_OPERATOR || 'cli',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--channel') args.channel = normalizeChannel(argv[++i]);
    else if (key === '--runtime-version') args.runtimeVersion = argv[++i];
    else if (key === '--percentage') args.percentage = Number(argv[++i]);
    else if (key === '--platform') args.platform = String(argv[++i] || '').toLowerCase();
    else if (key === '--clear-platform') args.clearPlatform = true;
    else if (key === '--whitelist') args.whitelist = argv[++i];
    else if (key === '--whitelist-add') args.add.push(...argv[++i].split(','));
    else if (key === '--whitelist-remove') args.remove.push(...argv[++i].split(','));
    else if (key === '--show') args.show = true;
    else if (key === '--operator') args.operator = argv[++i] || args.operator;
    else if (key === '--help' || key === '-h') {
      console.log(`用法: node scripts/rollout.mjs [选项]
  --channel <name>          目标通道（默认 production）
  --runtime-version <rv>    指定 runtimeVersion
  --percentage <0-100>      放量比例：命中分桶的设备拿 current，其余继续用 previous
  --platform <ios|android>  只调整该平台的放量比例（需配合 --percentage），其余平台保持不变
  --clear-platform          清除平台覆盖，双端都回到统一 percentage
  --whitelist <uid,...>     直接覆盖白名单
  --whitelist-add <uid,...> 追加白名单
  --whitelist-remove <uid>  移除白名单
  --show                    只查看当前 rollout`);
      process.exit(0);
    }
  }
  return args;
}

function formatByPlatform(value) {
  if (!value) return '-';
  return ['ios', 'android']
    .map((platform) =>
      value[platform] === undefined ? null : `${platform}=${value[platform]}%`,
    )
    .filter(Boolean)
    .join(', ') || '-';
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
  if (args.platform && !['ios', 'android'].includes(args.platform)) {
    throw new Error('--platform 只能是 ios 或 android');
  }
  if (args.platform && args.percentage === null) {
    throw new Error('--platform 需要同时指定 --percentage');
  }
  if (
    args.percentage !== null &&
    (!Number.isFinite(args.percentage) || args.percentage < 0 || args.percentage > 100)
  ) {
    throw new Error('--percentage 必须是 0-100 的数字');
  }
  const runtimeVersion = resolveRuntimeVersion(args.runtimeVersion);
  const current = await readChannel(runtimeVersion, args.channel);
  if (!current?.releaseId) {
    throw new Error(`通道 ${args.channel} 尚未发布任何版本`);
  }

  if (args.show || (args.percentage === null && args.whitelist === null && !args.add.length && !args.remove.length && !args.clearPlatform)) {
    console.log(`通道 ${args.channel}（runtime ${runtimeVersion}）`);
    console.log(`  current:  ${current.releaseId}`);
    console.log(`  previous: ${current.previous?.releaseId || '-'}`);
    console.log(`  rollout:  ${current.rollout.percentage}%`);
    console.log(`  byPlatform: ${formatByPlatform(current.rollout.byPlatform)}`);
    console.log(`  whitelist: ${(current.rollout.whitelist || []).join(', ') || '-'}`);
    return;
  }

  // 白名单是「读改写」，整体放锁内，避免并发追加互相覆盖。
  const result = await withLock(
    `${runtimeVersion}:${args.channel}`,
    channelLockFile(runtimeVersion, args.channel),
    async () => {
      const latest = await readChannel(runtimeVersion, args.channel);
      if (!latest?.releaseId) throw new Error(`通道 ${args.channel} 尚未发布任何版本`);
      const base = args.whitelist !== null
        ? args.whitelist.split(',').map((s) => s.trim()).filter(Boolean)
        : [...(latest.rollout.whitelist || [])];
      const added = args.add.map((s) => s.trim()).filter(Boolean);
      const removed = new Set(args.remove.map((s) => s.trim()).filter(Boolean));
      const whitelist = [...new Set([...base, ...added])].filter((uid) => !removed.has(uid));

      // --platform 只改该平台覆盖，不动统一 percentage；--clear-platform 清除全部覆盖。
      let byPlatform;
      if (args.clearPlatform) byPlatform = null;
      else if (args.platform) {
        byPlatform = {
          ...(latest.rollout.byPlatform || {}),
          [args.platform]: args.percentage,
        };
      }

      return setRollout(runtimeVersion, args.channel, {
        percentage: args.platform || args.percentage === null
          ? undefined
          : args.percentage,
        whitelist: args.whitelist === null && !args.add.length && !args.remove.length
          ? undefined
          : whitelist,
        byPlatform,
        operator: args.operator,
        via: 'cli',
      });
    },
  );

  console.log(`[rollout] 通道 ${args.channel} 已更新`);
  console.log(`  current:  ${result.releaseId}`);
  console.log(`  previous: ${result.previous?.releaseId || '-'}`);
  console.log(`  rollout:  ${result.rollout.percentage}%`);
  console.log(`  byPlatform: ${formatByPlatform(result.rollout.byPlatform)}`);
  console.log(`  whitelist: ${(result.rollout.whitelist || []).join(', ') || '-'}`);
}

main().catch((error) => {
  console.error(`[rollout] 失败: ${error.message}`);
  process.exitCode = 1;
});
