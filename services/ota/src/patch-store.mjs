/**
 * 增量差分补丁索引（A-IM / bsdiff 内容协商）。
 *
 * 服务端只读：根据客户端上报的 updateId 找到本地已有的 launchAsset，
 * 查补丁索引并返回 BSDIFF40 补丁；发布脚本负责生成补丁与写索引。
 * manifest 本身完全不变，因此代码签名、灰度分桶都不受影响。
 *
 * 目录布局（rv = runtimeVersion）：
 *   updates/<rv>/patches/index.json            补丁索引
 *   updates/<rv>/patches/<hash>.bsdiff         标准 BSDIFF40 补丁
 *   updates/<rv>/embedded/<updateId>.json      内置包注册记录
 *   updates/<rv>/embedded/bundles/<hash>.hbc   内置包 launchAsset 副本
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPDATES_DIR } from './config.mjs';
import {
  readJson,
  safeJoin,
  sha256Hex,
  writeJsonAtomic,
} from './lib.mjs';
import { listReleaseIds, releaseDir } from './release-store.mjs';
import { withLock } from './locks.mjs';

export const PATCH_INDEX_VERSION = 1;
const MAGIC = 'BSDIFF40';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VARY = 'a-im, expo-current-update-id, accept-encoding';

export function runtimeRoot(runtimeVersion) {
  return safeJoin(UPDATES_DIR, String(runtimeVersion));
}

export function patchesDir(runtimeVersion) {
  return path.join(runtimeRoot(runtimeVersion), 'patches');
}

export function embeddedDir(runtimeVersion) {
  return path.join(runtimeRoot(runtimeVersion), 'embedded');
}

export function patchIndexPath(runtimeVersion) {
  return path.join(patchesDir(runtimeVersion), 'index.json');
}

export function patchKey(baseHash, targetHash) {
  return `${baseHash}:${targetHash}`;
}

/** 内容寻址文件名：与 updateId 无关，--touch / --release 提升后可复用同一补丁。 */
export function patchFileName(baseHash, targetHash) {
  return `${sha256Hex(Buffer.from(`${baseHash}:${targetHash}`)).slice(0, 32)}.bsdiff`;
}

export function emptyPatchIndex() {
  return { version: PATCH_INDEX_VERSION, updatedAt: null, entries: {} };
}

export function patchEnabled() {
  const raw = String(process.env.OTA_PATCH_ENABLED ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** 补丁至少要比全量传输省这么多才下发；达不到就回退完整包。 */
export function minSaving() {
  const raw = Number(process.env.OTA_PATCH_MIN_SAVING ?? 0.1);
  return Number.isFinite(raw) ? Math.max(0, Math.min(0.95, raw)) : 0.1;
}

/** 发布时为每个新版本预生成多少个历史 base。 */
export function maxBases() {
  const raw = Number(process.env.OTA_PATCH_MAX_BASES ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.min(50, Math.trunc(raw)) : 5;
}

export async function readPatchIndex(runtimeVersion) {
  const index = await readJson(patchIndexPath(runtimeVersion), null);
  if (
    !index ||
    index.version !== PATCH_INDEX_VERSION ||
    !index.entries ||
    typeof index.entries !== 'object'
  ) {
    return emptyPatchIndex();
  }
  return index;
}

export async function writePatchIndex(runtimeVersion, index) {
  await writeJsonAtomic(patchIndexPath(runtimeVersion), {
    ...index,
    version: PATCH_INDEX_VERSION,
    updatedAt: new Date().toISOString(),
  });
  invalidatePatchCache(runtimeVersion);
}

/** 读改写索引要跨发布进程互斥；锁文件与索引同目录。 */
export async function updatePatchIndex(runtimeVersion, mutator) {
  return withLock(
    `${runtimeVersion}:patches`,
    path.join(patchesDir(runtimeVersion), '.lock'),
    async () => {
      const index = await readPatchIndex(runtimeVersion);
      const next = (await mutator(index)) || index;
      await writePatchIndex(runtimeVersion, next);
      return next;
    },
  );
}

// ---------- 内置包注册记录 ----------

export async function readEmbeddedRecords(runtimeVersion) {
  const dir = embeddedDir(runtimeVersion);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readJson(path.join(dir, name), null);
    if (record?.updateId && record?.hash && record?.bundle) records.push(record);
  }
  return records;
}

export function embeddedBundlePath(runtimeVersion, record) {
  return safeJoin(embeddedDir(runtimeVersion), record.bundle);
}

/** release metadata → 全部平台的 launchAsset 哈希（去重）。 */
export function releaseLaunchHashes(metadata) {
  const hashes = new Set();
  for (const file of Object.values(metadata?.launchAssets || {})) {
    const hash = metadata?.assetIndex?.[file]?.hash;
    if (hash) hashes.add(hash);
  }
  return [...hashes];
}

// ---------- base 索引：updateId + platform → launchAsset ----------

const baseIndexCache = new Map();

async function statKey(file) {
  try {
    return String((await fsp.stat(file)).mtimeMs);
  } catch {
    return '-';
  }
}

/** runtime 目录 / embedded 目录 / 补丁索引任一变化即重建（新发布、新注册、rebuild）。 */
async function baseIndexKey(runtimeVersion) {
  const parts = await Promise.all(
    [
      runtimeRoot(runtimeVersion),
      embeddedDir(runtimeVersion),
      patchIndexPath(runtimeVersion),
    ].map(statKey),
  );
  return parts.join('|');
}

async function buildBaseIndex(runtimeVersion) {
  const byKey = new Map();
  for (const releaseId of await listReleaseIds(runtimeVersion)) {
    const metadata = await readJson(
      path.join(releaseDir(runtimeVersion, releaseId), 'metadata.json'),
      null,
    );
    if (!metadata?.id || !metadata.launchAssets) continue;
    const updateId = String(metadata.id).toLowerCase();
    for (const [platform, file] of Object.entries(metadata.launchAssets)) {
      const hash = metadata.assetIndex?.[file]?.hash;
      if (!hash) continue;
      const key = `${updateId}:${platform}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        updateId,
        kind: 'release',
        platform,
        releaseId,
        hash,
        file: path.join(releaseDir(runtimeVersion, releaseId), file),
      });
    }
  }
  for (const record of await readEmbeddedRecords(runtimeVersion)) {
    const updateId = String(record.updateId).toLowerCase();
    const key = `${updateId}:${record.platform}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      updateId,
      kind: 'embedded',
      platform: record.platform,
      channel: record.channel || null,
      hash: record.hash,
      file: embeddedBundlePath(runtimeVersion, record),
    });
  }
  return byKey;
}

/** 测试或同进程发布后主动失效；正常发布是独立进程，靠目录 mtime 自动感知。 */
export function invalidateBaseIndex(runtimeVersion) {
  if (runtimeVersion) baseIndexCache.delete(runtimeVersion);
  else baseIndexCache.clear();
}

export async function loadBaseIndex(runtimeVersion) {
  const key = await baseIndexKey(runtimeVersion);
  const hit = baseIndexCache.get(runtimeVersion);
  if (hit && hit.key === key) return hit.index;
  const index = await buildBaseIndex(runtimeVersion);
  baseIndexCache.set(runtimeVersion, { key, index });
  return index;
}

export async function findBase(runtimeVersion, updateId, platform) {
  const id = String(updateId || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return null;
  return (await loadBaseIndex(runtimeVersion)).get(`${id}:${platform}`) || null;
}

// ---------- 补丁查找 ----------

const patchIndexCache = new Map();

export function invalidatePatchCache(runtimeVersion) {
  if (runtimeVersion) patchIndexCache.delete(runtimeVersion);
  else patchIndexCache.clear();
}

async function loadPatchIndex(runtimeVersion) {
  let mtimeMs = 0;
  try {
    mtimeMs = (await fsp.stat(patchIndexPath(runtimeVersion))).mtimeMs;
  } catch {
    // 索引尚未创建
  }
  const hit = patchIndexCache.get(runtimeVersion);
  if (hit && hit.mtimeMs === mtimeMs) return hit.index;
  const index = await readPatchIndex(runtimeVersion);
  patchIndexCache.set(runtimeVersion, { mtimeMs, index });
  return index;
}

export async function findPatch(runtimeVersion, baseHash, targetHash) {
  const index = await loadPatchIndex(runtimeVersion);
  const entry = index.entries[patchKey(baseHash, targetHash)];
  if (!entry) return null;
  const file = path.join(patchesDir(runtimeVersion), entry.file);
  try {
    await fsp.stat(file);
  } catch {
    return null;
  }
  return { ...entry, path: file };
}

/** 全量传输实际是 gzip 大小，用它做收益基准才不会高估节省量。 */
export function fullSizeOf(entry) {
  return Number(entry.targetGzipSize || entry.targetSize || 0);
}

export function isWorthIt(entry) {
  const baseline = fullSizeOf(entry);
  const size = Number(entry.patchSize || 0);
  return baseline > 0 && size > 0 && size <= baseline * (1 - minSaving());
}

/** 看板用：补丁库规模与按目标产物聚合。 */
export async function patchStats(runtimeVersion) {
  const index = await readPatchIndex(runtimeVersion);
  const byTargetHash = {};
  const byPlatform = {};
  let totalCount = 0;
  let totalBytes = 0;
  for (const entry of Object.values(index.entries || {})) {
    totalCount += 1;
    totalBytes += Number(entry.patchSize || 0);
    const target = (byTargetHash[entry.targetHash] ||= { count: 0, bytes: 0 });
    target.count += 1;
    target.bytes += Number(entry.patchSize || 0);
    const platform = (byPlatform[entry.platform] ||= { count: 0, bytes: 0 });
    platform.count += 1;
    platform.bytes += Number(entry.patchSize || 0);
  }
  return { totalCount, totalBytes, byTargetHash, byPlatform };
}

// ---------- 服务端协商 ----------

function full(reason, extra = {}) {
  return { kind: 'full', meta: { hit: false, reason, ...extra } };
}

/**
 * 按 RFC 3229 / expo-updates 的 A-IM 约定决定返回补丁还是完整包。
 * 返回 { kind: 'patch', response, meta } 或 { kind: 'full', meta }。
 * 任何异常条件都回退全量：客户端还有一层自动重试兜底。
 */
export async function negotiatePatch({
  runtimeVersion,
  releaseId,
  file,
  headers = {},
}) {
  if (!patchEnabled()) return full('disabled');
  const aIm = String(headers['a-im'] || '').toLowerCase();
  if (!aIm.split(',').some((value) => value.trim() === 'bsdiff')) {
    return full('no-aim');
  }

  const metadata = await readJson(
    path.join(releaseDir(runtimeVersion, releaseId), 'metadata.json'),
    null,
  );
  const launchAssets = metadata?.launchAssets || {};
  const platform = Object.keys(launchAssets).find((name) => launchAssets[name] === file);
  if (!platform) return full('not-launch-asset');
  const targetHash = metadata.assetIndex?.[file]?.hash;
  if (!targetHash) return full('no-target-hash');

  const targetUpdateId = String(metadata.id || '').toLowerCase();
  const candidates = [
    headers['expo-current-update-id'],
    headers['expo-embedded-update-id'],
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value, index, all) => UUID_RE.test(value) && all.indexOf(value) === index);

  let lastReason = candidates.length ? 'base-missing' : 'invalid-base-id';
  for (const baseId of candidates) {
    if (baseId === targetUpdateId) {
      lastReason = 'same-update';
      continue;
    }
    const base = await findBase(runtimeVersion, baseId, platform);
    if (!base) {
      lastReason = 'base-missing';
      continue;
    }
    const entry = await findPatch(runtimeVersion, base.hash, targetHash);
    if (!entry) {
      lastReason = 'patch-missing';
      continue;
    }
    if (!isWorthIt(entry)) {
      lastReason = 'not-beneficial';
      continue;
    }

    let body;
    try {
      body = await fsp.readFile(entry.path);
    } catch {
      lastReason = 'patch-unreadable';
      continue;
    }
    if (
      body.length < 32 ||
      body.subarray(0, 8).toString('ascii') !== MAGIC ||
      sha256Hex(body) !== entry.sha256
    ) {
      lastReason = 'patch-corrupt';
      continue;
    }

    const fullSize = fullSizeOf(entry);
    const patchSize = body.length;
    return {
      kind: 'patch',
      meta: {
        hit: true,
        reason: 'hit',
        baseUpdateId: baseId,
        baseKind: base.kind,
        targetUpdateId,
        platform,
        releaseId,
        patchSize,
        fullSize,
        savedBytes: Math.max(0, fullSize - patchSize),
      },
      response: {
        status: 226,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(patchSize),
          // 同一 URL 对带 / 不带 A-IM 的请求返回不同字节，绝不能进共享缓存。
          'cache-control': 'private, no-store',
          vary: VARY,
          im: 'bsdiff',
          'expo-base-update-id': baseId,
        },
        body,
      },
    };
  }
  return full(lastReason, { platform, targetUpdateId, releaseId });
}

export const PATCH_VARY = VARY;
