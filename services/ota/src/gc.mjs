import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SYSTEM_CHANNEL,
  appendAudit,
  auditEntry,
  channelFile,
  listChannels,
  listReleaseIds,
  readChannel,
  releaseDir,
  runtimeLockFile,
} from './release-store.mjs';
import {
  maxBases,
  patchIndexPath,
  patchesDir,
  readPatchIndex,
  updatePatchIndex,
} from './patch-store.mjs';
import { readJson } from './lib.mjs';
import { withLock } from './locks.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_KEEP_DAYS = 14;
export const DEFAULT_KEEP_LAST = 10;

/** releaseId 是发布时的 `Date.now()`，13 位数字；降到 1e11 仍能覆盖到 1973 年以后。 */
function numericTimestamp(releaseId) {
  const value = Number(releaseId);
  if (!Number.isSafeInteger(value) || value <= 1e11) return null;
  return value;
}

function topSegment(file) {
  return String(file || '').split('/')[0];
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function clampInt(value, fallback, { min = 0, max = 100000 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

/** release 目录的真实文件数与字节数（只统计文件，不含目录项开销）。 */
async function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirUsage(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += (await fsp.stat(full)).size;
        files += 1;
      } catch {
        // 并发删除时文件可能已消失，跳过即可
      }
    }
  }
  return { bytes, files };
}

/**
 * 计算保护集。任何一条规则命中即保留：
 * - 各通道 current / previous（含继承指针）
 * - 最近 keepLast 个版本
 * - createdAt 在 keepDays 内的版本
 * - 最近 patchBases 个版本（保证发布期还能命中差分）
 */
async function collectProtection(runtimeVersion, { keepDays, keepLast, patchBases }) {
  const reasons = new Map();
  const add = (releaseId, reason) => {
    const id = String(releaseId || '').trim();
    if (!id) return;
    const list = reasons.get(id) || [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(id, list);
  };

  for (const name of await listChannels(runtimeVersion)) {
    // listChannels 总会带上默认通道，但该通道可能还没有任何指针文件；
    // readChannel 对未知通道会回退到 production / 最新版本，这里只认真实文件。
    if (!(await exists(channelFile(runtimeVersion, name)))) continue;
    const record = await readChannel(runtimeVersion, name);
    if (!record || record.rollback) continue;
    if (record.releaseId) add(record.releaseId, `current:${name}`);
    if (record.previous?.releaseId) add(record.previous.releaseId, `previous:${name}`);
  }

  const ids = await listReleaseIds(runtimeVersion);
  ids.slice(0, keepLast).forEach((id) => add(id, 'keep-last'));
  ids.slice(0, patchBases).forEach((id) => add(id, 'patch-base'));

  if (keepDays > 0) {
    const deadline = Date.now() - keepDays * DAY_MS;
    for (const id of ids) {
      // 数字 id 直接换算，避免为了判断保留期去读每个 metadata.json。
      const ts = numericTimestamp(id);
      if (ts !== null) {
        if (ts >= deadline) add(id, 'keep-days');
        continue;
      }
      const meta = await readJson(
        path.join(releaseDir(runtimeVersion, id), 'metadata.json'),
      );
      const parsed = Date.parse(meta?.createdAt || '');
      if (Number.isFinite(parsed) && parsed >= deadline) add(id, 'keep-days');
    }
  }

  return reasons;
}

/**
 * 只读规划：返回保护集、待删候选、补丁索引联动结果。
 * 不落盘，可直接用于控制台预览与 `--dry-run`。
 */
export async function planGc(runtimeVersion, options = {}) {
  // keepLast 至少 1，避免配置写错后把最新版本也回收掉。
  const keepLast = clampInt(options.keepLast, DEFAULT_KEEP_LAST, { min: 1 });
  const keepDays = clampInt(options.keepDays, DEFAULT_KEEP_DAYS, { min: 0 });
  const patchBases = clampInt(options.patchBases, maxBases(), { min: 0 });

  const ids = await listReleaseIds(runtimeVersion);
  const protection = await collectProtection(runtimeVersion, {
    keepDays,
    keepLast,
    patchBases,
  });

  const candidates = [];
  for (const id of ids) {
    if (protection.has(id)) continue;
    const dir = releaseDir(runtimeVersion, id);
    const usage = await dirUsage(dir);
    const ts = numericTimestamp(id);
    const meta = ts === null
      ? await readJson(path.join(dir, 'metadata.json'))
      : null;
    candidates.push({
      releaseId: id,
      createdAt: ts !== null
        ? new Date(ts).toISOString()
        : meta?.createdAt || null,
      updateId: meta?.id || null,
      bytes: usage.bytes,
      files: usage.files,
    });
  }

  const removed = new Set(candidates.map((item) => item.releaseId));
  const index = await readPatchIndex(runtimeVersion);
  const entriesToDrop = [];
  const patchFilesToDrop = [];
  for (const [key, entry] of Object.entries(index.entries || {})) {
    const stale =
      removed.has(topSegment(entry.basePath)) ||
      removed.has(topSegment(entry.targetPath));
    if (stale) {
      entriesToDrop.push(key);
      if (entry.file) patchFilesToDrop.push(entry.file);
    }
  }

  return {
    runtimeVersion: String(runtimeVersion),
    scannedAt: new Date().toISOString(),
    keepDays,
    keepLast,
    patchBases,
    total: ids.length,
    protected: [...protection.entries()]
      .map(([releaseId, reasons]) => ({ releaseId, reasons }))
      .sort((a, b) => Number(b.releaseId) - Number(a.releaseId)),
    candidates,
    reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    patch: { entriesToDrop, filesToDrop: patchFilesToDrop },
  };
}

/**
 * 执行回收。持 runtimeVersion 级锁（与提升 / 重发互斥），并在锁内重新规划，
 * 只删除「规划与执行两次都判定为候选」的版本，避免规划后被 promote 的版本被误删。
 */
export async function applyGc(
  runtimeVersion,
  plan,
  { operator = 'cli', via = 'cli', requestId = null, source = null } = {},
) {
  return withLock(
    `${runtimeVersion}:runtime`,
    runtimeLockFile(runtimeVersion),
    async () => {
      const fresh = await planGc(runtimeVersion, {
        keepDays: plan?.keepDays,
        keepLast: plan?.keepLast,
        patchBases: plan?.patchBases,
      });
      const stillEligible = new Set(fresh.candidates.map((item) => item.releaseId));
      const requested = plan?.candidates || fresh.candidates;
      const removable = requested.filter((item) => stillEligible.has(item.releaseId));
      const skipped = requested
        .filter((item) => !stillEligible.has(item.releaseId))
        .map((item) => ({ releaseId: item.releaseId, reason: 'no-longer-eligible' }));

      const removed = [];
      const failed = [];
      for (const item of removable) {
        try {
          await fsp.rm(releaseDir(runtimeVersion, item.releaseId), {
            recursive: true,
            force: true,
          });
          removed.push(item);
        } catch (error) {
          failed.push({ releaseId: item.releaseId, error: error.message });
        }
      }

      const removedIds = new Set(removed.map((item) => item.releaseId));
      let patchResult = { droppedEntries: 0, droppedFiles: 0 };
      if (removedIds.size > 0) {
        patchResult = await prunePatches(runtimeVersion, removedIds);
      }

      const reclaimedBytes = removed.reduce((sum, item) => sum + item.bytes, 0);
      if (removed.length > 0 || failed.length > 0) {
        await appendAudit(
          runtimeVersion,
          auditEntry({
            action: 'gc',
            channel: SYSTEM_CHANNEL,
            operator,
            via,
            requestId,
            params: {
              releaseIds: removed.map((item) => item.releaseId),
              reclaimedBytes,
              failed: failed.map((item) => item.releaseId),
              keepDays: plan?.keepDays,
              keepLast: plan?.keepLast,
              patchEntriesDropped: patchResult.droppedEntries,
              patchFilesDropped: patchResult.droppedFiles,
            },
            source,
          }),
        );
      }

      return {
        runtimeVersion: String(runtimeVersion),
        removed,
        skipped,
        failed,
        reclaimedBytes,
        patch: patchResult,
      };
    },
  );
}

/**
 * 清掉引用已删版本的补丁索引条目，并回收不再被任何条目引用的 .bsdiff。
 *
 * 顺序很重要：先算好新索引（保留集），只删除「新索引不引用」的文件；
 * 即使随后写盘失败，也只是留下悬空条目（findPatch 会因文件缺失回退全量），
 * 不会出现「索引指向已删除文件」以外的更坏情况。
 */
async function prunePatches(runtimeVersion, removedIds) {
  let droppedEntries = 0;
  let droppedFiles = 0;
  // 从未用过差分的部署没有索引文件，不要为了清理凭空创建 patches/index.json。
  if (!(await exists(patchIndexPath(runtimeVersion)))) {
    return { droppedEntries, droppedFiles };
  }
  try {
    await updatePatchIndex(runtimeVersion, async (index) => {
      const kept = {};
      const usedFiles = new Set();
      for (const [key, entry] of Object.entries(index.entries || {})) {
        const stale =
          removedIds.has(topSegment(entry.basePath)) ||
          removedIds.has(topSegment(entry.targetPath));
        if (stale) {
          droppedEntries += 1;
          continue;
        }
        kept[key] = entry;
        if (entry.file) usedFiles.add(entry.file);
      }

      let names = [];
      try {
        names = await fsp.readdir(patchesDir(runtimeVersion));
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name.endsWith('.bsdiff') || usedFiles.has(name)) continue;
        try {
          await fsp.rm(path.join(patchesDir(runtimeVersion), name), { force: true });
          droppedFiles += 1;
        } catch {
          // 单个文件删除失败不影响索引收敛
        }
      }

      return { ...index, entries: kept };
    });
  } catch {
    // 补丁索引损坏 / 锁超时：不影响 release 目录回收，留待下次 GC 处理
  }
  return { droppedEntries, droppedFiles };
}
