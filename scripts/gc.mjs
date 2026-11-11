import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_OPERATOR } from '../services/ota/src/config.mjs';
import { runtimeVersions } from '../services/ota/src/release-store.mjs';
import { applyGc, planGc } from '../services/ota/src/gc.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..');
const MOBILE_DIR = path.join(ROOT, 'apps', 'mobile');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {
    runtimeVersion: null,
    keepDays: null,
    keepLast: null,
    patchBases: null,
    apply: false,
    json: false,
    releaseIds: [],
    operator: process.env.OTA_OPERATOR || CLI_OPERATOR || 'cli',
    via: 'cli',
    requestId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--rv' || key === '--runtime-version') {
      args.runtimeVersion = next();
    } else if (key === '--keep-days') {
      args.keepDays = Number(next());
    } else if (key === '--keep-last') {
      args.keepLast = Number(next());
    } else if (key === '--patch-bases') {
      args.patchBases = Number(next());
    } else if (key === '--release') {
      args.releaseIds.push(String(next()));
    } else if (key === '--apply') {
      args.apply = true;
    } else if (key === '--dry-run') {
      args.apply = false;
    } else if (key === '--json') {
      args.json = true;
    } else if (key === '--operator') {
      args.operator = next() || args.operator;
    } else if (key === '--via') {
      args.via = next() || 'cli';
    } else if (key === '--request-id') {
      args.requestId = next() || null;
    } else if (key === '--help' || key === '-h') {
      console.log(`用法: npm run ota:gc -- [选项]

  --rv <rv>               只处理指定 runtimeVersion（默认遍历全部）
  --keep-days <n>         保留最近 n 天（默认 14，0 表示不按天数保留）
  --keep-last <n>         至少保留最近 n 个版本（默认 10，最小 1）
  --patch-bases <n>       额外保留最近 n 个差分 base（默认 OTA_PATCH_MAX_BASES）
  --release <id>          只回收指定版本，可重复；受保护版本会被拒绝
  --dry-run               只输出计划（默认行为）
  --apply                 真正删除文件
  --json                  输出结构化结果，供 CI / 控制台消费
  --operator <name>       审计操作人（默认 $OTA_OPERATOR 或 cli）
  --via <source>          审计来源（cli / dashboard / ci）

保护集：各通道 current / previous、最近 keep-last 个版本、keep-days 内的版本、
最近 patch-bases 个版本。删除后不可恢复。`);
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${key}`);
    }
  }
  return args;
}

/** 未显式指定时按数据目录里的 runtimeVersion 逐个处理；没有数据则回落到 app.config.js。 */
async function resolveRuntimeVersions(explicit) {
  if (explicit) return [String(explicit)];
  const versions = await runtimeVersions();
  if (versions.length) return versions;
  try {
    const config = require(path.join(MOBILE_DIR, 'app.config.js'));
    const runtimeVersion = config.expo?.runtimeVersion;
    if (typeof runtimeVersion === 'string') return [runtimeVersion];
    if (runtimeVersion?.policy === 'appVersion') return [config.expo.version];
  } catch {
    // 没有移动端依赖时忽略，最终返回空列表
  }
  return [];
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function optionsOf(args) {
  return {
    keepDays: args.keepDays ?? undefined,
    keepLast: args.keepLast ?? undefined,
    patchBases: args.patchBases ?? undefined,
  };
}

/** 把 plan 收敛到 --release 指定的版本；受保护 / 不存在都直接报错，便于控制台给出准确提示。 */
function narrowToTargets(plan, targets) {
  if (!targets.length) return plan;
  const protectedMap = new Map(
    plan.protected.map((item) => [item.releaseId, item.reasons]),
  );
  const blocked = targets.filter((id) => protectedMap.has(id));
  if (blocked.length) {
    const detail = blocked
      .map((id) => `${id}（${protectedMap.get(id).join(', ')}）`)
      .join('；');
    throw new Error(`以下版本受保护，不能回收：${detail}`);
  }
  const candidateIds = new Set(plan.candidates.map((item) => item.releaseId));
  const unknown = targets.filter((id) => !candidateIds.has(id));
  if (unknown.length) {
    throw new Error(`以下版本不存在或已回收：${unknown.join(', ')}`);
  }
  const wanted = new Set(targets);
  const candidates = plan.candidates.filter((item) => wanted.has(item.releaseId));
  return {
    ...plan,
    candidates,
    reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
  };
}

function printPlan(plan, dryRun) {
  console.log(
    `[gc] runtimeVersion ${plan.runtimeVersion}${dryRun ? '（dry-run）' : ''}` +
      ` · 共 ${plan.total} 个版本 · keep-days ${plan.keepDays}d / keep-last ${plan.keepLast} / patch-base ${plan.patchBases}`,
  );
  console.log(`[gc] 保留 ${plan.protected.length} 个：`);
  for (const item of plan.protected.slice(0, 20)) {
    console.log(`  ${item.releaseId}  ${item.reasons.join(', ')}`);
  }
  if (plan.protected.length > 20) {
    console.log(`  ... 其余 ${plan.protected.length - 20} 个已省略`);
  }
  console.log(
    `[gc] 待回收 ${plan.candidates.length} 个 / ${formatBytes(plan.reclaimableBytes)}：`,
  );
  for (const item of plan.candidates) {
    console.log(
      `  ${item.releaseId}  ${item.createdAt || '无时间'}  ${formatBytes(item.bytes)}  ${item.files} 个文件`,
    );
  }
  if (plan.patch.entriesToDrop.length || plan.patch.filesToDrop.length) {
    console.log(
      `[gc] 补丁联动：索引条目 ${plan.patch.entriesToDrop.length} 条，补丁文件 ${plan.patch.filesToDrop.length} 个`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const versions = await resolveRuntimeVersions(args.runtimeVersion);
  if (!versions.length) {
    throw new Error('没有找到任何 runtimeVersion 数据目录，请用 --rv 指定');
  }

  const dryRun = !args.apply;
  const results = [];
  let failedCount = 0;

  for (const runtimeVersion of versions) {
    const options = optionsOf(args);
    let plan = await planGc(runtimeVersion, options);
    plan = narrowToTargets(plan, args.releaseIds);

    if (!args.json) printPlan(plan, dryRun);

    if (dryRun) {
      results.push({ dryRun: true, plan });
      if (!args.json) {
        console.log('[gc] dry-run：未删除任何文件（加 --apply 执行）');
      }
      continue;
    }

    if (plan.candidates.length === 0) {
      results.push({ dryRun: false, plan, result: null });
      if (!args.json) console.log('[gc] 没有需要回收的版本');
      continue;
    }

    const result = await applyGc(runtimeVersion, plan, {
      operator: args.operator,
      via: args.via,
      requestId: args.requestId,
    });
    failedCount += result.failed.length;
    results.push({ dryRun: false, plan, result });
    if (!args.json) {
      console.log(
        `[gc] 已回收 ${result.removed.length} 个 / ${formatBytes(result.reclaimedBytes)}` +
          `，补丁条目 ${result.patch.droppedEntries} 条 / 文件 ${result.patch.droppedFiles} 个`,
      );
      for (const item of result.failed) {
        console.error(`[gc] 删除失败: ${item.releaseId} -> ${item.error}`);
      }
      for (const item of result.skipped) {
        console.log(`[gc] 跳过 ${item.releaseId}：${item.reason}`);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: failedCount === 0, dryRun, results }, null, 2));
  }
  if (failedCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[gc] 失败: ${error.message}`);
  process.exitCode = 1;
});
