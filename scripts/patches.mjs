#!/usr/bin/env node
/**
 * 补丁生成与校验（发布期工具，服务端运行时不加载）。
 *
 *   node scripts/patches.mjs rebuild --rv 1 [--targets <id,...>] [--max-bases 5]
 *   node scripts/patches.mjs verify  --rv 1
 *
 * 也导出 generatePatchesForRelease / generatePatchPairs 给 publish.mjs 与
 * register-embedded.mjs 复用。
 */
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  embeddedBundlePath,
  maxBases,
  minSaving,
  patchFileName,
  patchIndexPath,
  patchKey,
  patchesDir,
  readEmbeddedRecords,
  readPatchIndex,
  runtimeRoot,
  updatePatchIndex,
} from '../services/ota/src/patch-store.mjs';
import { listReleaseIds, releaseDir } from '../services/ota/src/release-store.mjs';
import { readJson, sha256Hex } from '../services/ota/src/lib.mjs';
import {
  BsdiffUnavailableError,
  buildPatch,
  verifyPatch,
} from './lib/bsdiff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** 一个 release 的各平台 launchAsset 描述。 */
export async function describeRelease(runtimeVersion, releaseId) {
  const dir = releaseDir(runtimeVersion, releaseId);
  const metadata = await readJson(path.join(dir, 'metadata.json'), null);
  if (!metadata?.launchAssets) return null;
  const platforms = [];
  for (const [platform, file] of Object.entries(metadata.launchAssets)) {
    const hash = metadata.assetIndex?.[file]?.hash;
    if (!hash) continue;
    const absolute = path.join(dir, file);
    try {
      const stat = await fsp.stat(absolute);
      let gzipSize = 0;
      try {
        gzipSize = (await fsp.stat(`${absolute}.gz`)).size;
      } catch {
        // 已压缩资产没有 .gz 副本，用原始大小做基准
      }
      platforms.push({
        platform,
        file,
        path: absolute,
        hash,
        size: stat.size,
        gzipSize,
        updateId: String(metadata.id || '').toLowerCase(),
      });
    } catch {
      // 产物缺失，跳过该平台
    }
  }
  return { releaseId, metadata, platforms };
}

/** 已注册内置包的 launchAsset 描述。 */
export function describeEmbedded(runtimeVersion, record) {
  return {
    updateId: String(record.updateId).toLowerCase(),
    kind: 'embedded',
    platform: record.platform,
    hash: record.hash,
    size: Number(record.size || 0),
    path: embeddedBundlePath(runtimeVersion, record),
  };
}

/** 历史 release + 内置包，作为新版本的差分 base。 */
export async function collectBases(runtimeVersion, options = {}) {
  const {
    excludeReleaseId = null,
    limit = maxBases(),
    includeEmbedded = true,
  } = options;
  const bases = [];
  const ids = (await listReleaseIds(runtimeVersion))
    .filter((id) => id !== excludeReleaseId)
    .slice(0, limit);
  for (const releaseId of ids) {
    const release = await describeRelease(runtimeVersion, releaseId);
    for (const item of release?.platforms || []) {
      bases.push({ ...item, kind: 'release', releaseId });
    }
  }
  if (includeEmbedded) {
    for (const record of await readEmbeddedRecords(runtimeVersion)) {
      bases.push(describeEmbedded(runtimeVersion, record));
    }
  }
  return bases;
}

/**
 * 按 (base, target) 组合生成补丁，最后一次性加锁写索引。
 * 单个组合失败不影响其它组合；缺 bsdiff 时整体降级为「仅全量」。
 */
export async function generatePatchPairs(runtimeVersion, pairs, options = {}) {
  const log = options.log || (() => {});
  const root = runtimeRoot(runtimeVersion);
  const dir = patchesDir(runtimeVersion);
  const existing = await readPatchIndex(runtimeVersion);
  const created = {};
  const result = { generated: 0, skipped: 0, failed: 0, unavailable: false, notBeneficial: 0 };

  for (const { base, target } of pairs) {
    if (!base || !target || base.platform !== target.platform) continue;
    if (!base.hash || !target.hash || base.hash === target.hash) {
      result.skipped += 1;
      continue;
    }
    const key = patchKey(base.hash, target.hash);
    if (created[key]) continue;
    const previous = existing.entries[key];
    if (previous) {
      try {
        await fsp.stat(path.join(dir, previous.file));
        result.skipped += 1;
        continue;
      } catch {
        // 索引里有记录但文件丢了，重新生成
      }
    }

    const outputFile = path.join(dir, patchFileName(base.hash, target.hash));
    try {
      await fsp.stat(base.path);
      const info = await buildPatch({
        baseFile: base.path,
        targetFile: target.path,
        outputFile,
        expectedHash: target.hash,
      });
      const baseline = target.gzipSize || target.size;
      const beneficial = info.patchSize <= baseline * (1 - minSaving());
      if (!beneficial) result.notBeneficial += 1;
      created[key] = {
        file: path.basename(outputFile),
        baseHash: base.hash,
        targetHash: target.hash,
        baseUpdateId: base.updateId,
        targetUpdateId: target.updateId,
        platform: target.platform,
        baseKind: base.kind || 'release',
        basePath: path.relative(root, base.path),
        targetPath: path.relative(root, target.path),
        baseSize: base.size,
        targetSize: target.size,
        targetGzipSize: target.gzipSize || 0,
        patchSize: info.patchSize,
        sha256: info.sha256,
        beneficial,
        createdAt: new Date().toISOString(),
      };
      result.generated += 1;
      log(
        `  [patch] ${base.platform} ${sha256Hex(Buffer.from(base.hash)).slice(0, 8)}` +
          ` → ${sha256Hex(Buffer.from(target.hash)).slice(0, 8)}` +
          ` ${info.patchSize}B / ${baseline}B${beneficial ? '' : '（收益不足，回退全量）'}`,
      );
    } catch (error) {
      await fsp.rm(outputFile, { force: true }).catch(() => {});
      if (error instanceof BsdiffUnavailableError) {
        result.unavailable = true;
        log(`  [patch] ${error.message}`);
        break;
      }
      result.failed += 1;
      log(`  [patch] 生成失败 ${base.platform}: ${error.message}`);
    }
  }

  if (Object.keys(created).length > 0) {
    await updatePatchIndex(runtimeVersion, (index) => {
      Object.assign(index.entries, created);
      return index;
    });
  }
  return result;
}

/** 发布新版本时：以最近 N 个历史版本 + 全部内置包为 base。 */
export async function generatePatchesForRelease(runtimeVersion, releaseId, options = {}) {
  const target = await describeRelease(runtimeVersion, releaseId);
  if (!target?.platforms.length) {
    return { generated: 0, skipped: 0, failed: 0, unavailable: false, notBeneficial: 0 };
  }
  const bases = await collectBases(runtimeVersion, {
    excludeReleaseId: releaseId,
    limit: options.maxBases || maxBases(),
    includeEmbedded: options.includeEmbedded !== false,
  });
  const pairs = [];
  for (const base of bases) {
    const matched = target.platforms.find((item) => item.platform === base.platform);
    if (matched) pairs.push({ base, target: matched });
  }
  return generatePatchPairs(runtimeVersion, pairs, options);
}

/** 注册内置包时：以该内置包为 base，覆盖最近的 release。 */
export async function generatePatchesFromEmbedded(runtimeVersion, record, options = {}) {
  const base = describeEmbedded(runtimeVersion, record);
  const ids = (await listReleaseIds(runtimeVersion)).slice(0, options.maxBases || maxBases());
  const pairs = [];
  for (const releaseId of ids) {
    const release = await describeRelease(runtimeVersion, releaseId);
    const matched = release?.platforms.find((item) => item.platform === base.platform);
    if (matched) pairs.push({ base, target: matched });
  }
  return generatePatchPairs(runtimeVersion, pairs, options);
}

/** 逐条校验索引里的补丁：文件哈希 + bspatch 还原结果与目标 hash 一致。 */
export async function verifyAllPatches(runtimeVersion, options = {}) {
  const log = options.log || (() => {});
  const index = await readPatchIndex(runtimeVersion);
  const entries = Object.entries(index.entries || {});
  const result = { total: entries.length, ok: 0, failed: 0, unavailable: false };
  if (entries.length === 0) {
    log('[patch] 索引为空，没有可校验的补丁');
    return result;
  }
  for (const [key, entry] of entries) {
    const patchFile = path.join(patchesDir(runtimeVersion), entry.file);
    const baseFile = path.join(runtimeRoot(runtimeVersion), entry.basePath || '');
    try {
      const patch = await fsp.readFile(patchFile);
      if (sha256Hex(patch) !== entry.sha256) throw new Error('补丁 sha256 与索引不一致');
      await verifyPatch({
        baseFile,
        patchFile,
        expectedHash: entry.targetHash,
      });
      result.ok += 1;
      log(`  [OK] ${key.slice(0, 16)}… ${entry.patchSize}B`);
    } catch (error) {
      if (error instanceof BsdiffUnavailableError) {
        result.unavailable = true;
        log(`  [SKIP] ${error.message}`);
        break;
      }
      result.failed += 1;
      log(`  [FAIL] ${key.slice(0, 16)}… ${error.message}`);
    }
  }
  return result;
}

function resolveRuntimeVersion(explicit) {
  if (explicit) return String(explicit);
  const config = require(path.join(ROOT, 'apps/mobile/app.config.js'));
  const rv = config.expo?.runtimeVersion;
  if (typeof rv === 'string') return rv;
  if (rv?.policy === 'appVersion') return config.expo.version;
  throw new Error('app.config.js 使用了 fingerprint 策略，请显式传入 --rv');
}

function parseArgs(argv) {
  const args = { rv: null, targets: null, maxBases: null, embedded: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--rv') args.rv = argv[++i];
    else if (key === '--targets') args.targets = argv[++i];
    else if (key === '--max-bases') args.maxBases = Number(argv[++i]);
    else if (key === '--no-embedded') args.embedded = false;
    else if (key === '--help' || key === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (args.help || !['rebuild', 'verify'].includes(command)) {
    console.log(`用法: node scripts/patches.mjs <rebuild|verify> --rv <runtimeVersion> [选项]
  rebuild  为指定（默认最近 5 个）release 生成补丁
    --targets <id,...>   只处理这些 releaseId
    --max-bases <N>      每个 target 最多基于多少个历史版本
    --no-embedded        不以内置包为 base
  verify   校验补丁文件哈希并用 bspatch 还原
  --rv <rv>             默认读取 apps/mobile/app.config.js`);
    return;
  }

  const rv = resolveRuntimeVersion(args.rv);
  if (command === 'verify') {
    console.log(`[patch] 校验 runtimeVersion=${rv} 的补丁索引 ${patchIndexPath(rv)}`);
    const result = await verifyAllPatches(rv, { log: console.log });
    console.log(`[patch] 结果: ${result.ok}/${result.total} 通过，失败 ${result.failed}`);
    if (result.failed > 0 || result.unavailable) process.exitCode = 1;
    return;
  }

  const ids = args.targets
    ? args.targets.split(',').map((item) => item.trim()).filter(Boolean)
    : (await listReleaseIds(rv)).slice(0, 5);
  console.log(`[patch] rebuild runtimeVersion=${rv}，目标 ${ids.length} 个版本`);
  for (const id of ids) {
    console.log(`[patch] 处理 release ${id}`);
    const result = await generatePatchesForRelease(rv, id, {
      log: console.log,
      maxBases: args.maxBases || maxBases(),
      includeEmbedded: args.embedded,
    });
    console.log(
      `[patch] 生成 ${result.generated}，跳过 ${result.skipped}，失败 ${result.failed}，` +
        `收益不足 ${result.notBeneficial}${result.unavailable ? '，bsdiff 不可用' : ''}`,
    );
  }
  console.log(`[patch] 索引: ${path.relative(ROOT, patchIndexPath(rv))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[patch] 失败: ${error.message}`);
    process.exitCode = 1;
  });
}
