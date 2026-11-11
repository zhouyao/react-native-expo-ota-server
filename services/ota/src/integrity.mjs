import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SYSTEM_CHANNEL,
  appendAudit,
  auditEntry,
  listReleaseIds,
  releaseDir,
  runtimeDir,
  runtimeLockFile,
} from './release-store.mjs';
import {
  embeddedDir,
  patchesDir,
  readEmbeddedRecords,
  readPatchIndex,
} from './patch-store.mjs';
import { readJson } from './lib.mjs';
import { withLock } from './locks.mjs';

/**
 * 孤儿文件体检：找出「没有任何版本 / 补丁 / 内置包引用」的文件。
 *
 * 为什么会有孤儿：发布中断、`--touch` 复制完成前进程被杀、补丁重建后旧补丁残留、
 * 手工删过 metadata。资产文件名是内容寻址的，同内容会共享同一个文件名（甚至硬链接），
 * 因此判断依据必须是「所有 release 的 metadata」这一全局引用集，不能逐目录判断。
 *
 * 只读：不删除任何文件。任何 release 的 metadata 缺失或没有 assetIndex 时，
 * 整体标记 `safe: false`（无法确知引用关系），调用方不得据此清理。
 */
export async function scanOrphans(runtimeVersion) {
  const releases = await listReleaseIds(runtimeVersion);
  const referenced = new Set();
  const unreadable = [];

  for (const id of releases) {
    const meta = await readJson(
      path.join(releaseDir(runtimeVersion, id), 'metadata.json'),
      null,
    );
    // 没有 assetIndex 的旧目录无法判断哪些资产属于它，整轮体检降级为不可清理。
    if (!meta || !meta.assetIndex) {
      unreadable.push(id);
      continue;
    }
    const files = new Set();
    for (const file of Object.values(meta.launchAssets || {})) {
      if (file) files.add(file);
    }
    for (const file of meta.assets || []) {
      if (file) files.add(file);
    }
    for (const file of Object.keys(meta.assetIndex)) files.add(file);
    for (const file of files) {
      referenced.add(`${id}/${file}`);
      // .gz 副本跟随原始文件存在，不写入 metadata。
      referenced.add(`${id}/${file}.gz`);
    }
  }

  const walk = async (dir, prefix, out) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, key, out);
        continue;
      }
      if (!entry.isFile()) continue;
      if (referenced.has(key)) continue;
      let bytes = 0;
      try {
        bytes = (await fsp.stat(full)).size;
      } catch {
        continue;
      }
      out.push({ file: key, path: full, bytes });
    }
  };

  const releaseOrphans = [];
  for (const id of releases) {
    // 无法解析的版本跳过，避免把它的资产误判成孤儿。
    if (unreadable.includes(id)) continue;
    for (const sub of ['bundles', 'assets']) {
      await walk(path.join(releaseDir(runtimeVersion, id), sub), `${id}/${sub}`, releaseOrphans);
    }
  }

  const patchOrphans = [];
  const index = await readPatchIndex(runtimeVersion);
  const patchFiles = new Set(
    Object.values(index.entries || {})
      .map((entry) => entry.file)
      .filter(Boolean),
  );
  let patchNames = [];
  try {
    patchNames = await fsp.readdir(patchesDir(runtimeVersion));
  } catch {
    patchNames = [];
  }
  for (const name of patchNames) {
    if (!name.endsWith('.bsdiff') || patchFiles.has(name)) continue;
    const full = path.join(patchesDir(runtimeVersion), name);
    let bytes = 0;
    try {
      bytes = (await fsp.stat(full)).size;
    } catch {
      continue;
    }
    patchOrphans.push({ file: `patches/${name}`, path: full, bytes });
  }

  const embeddedOrphans = [];
  const embeddedRefs = new Set(
    (await readEmbeddedRecords(runtimeVersion))
      .map((record) => record.bundle)
      .filter(Boolean),
  );
  let embeddedNames = [];
  try {
    embeddedNames = await fsp.readdir(path.join(embeddedDir(runtimeVersion), 'bundles'));
  } catch {
    embeddedNames = [];
  }
  for (const name of embeddedNames) {
    if (embeddedRefs.has(`bundles/${name}`)) continue;
    const full = path.join(embeddedDir(runtimeVersion), 'bundles', name);
    let bytes = 0;
    try {
      bytes = (await fsp.stat(full)).size;
    } catch {
      continue;
    }
    embeddedOrphans.push({ file: `embedded/bundles/${name}`, path: full, bytes });
  }

  const all = [...releaseOrphans, ...patchOrphans, ...embeddedOrphans];
  return {
    runtimeVersion: String(runtimeVersion),
    scannedAt: new Date().toISOString(),
    scannedReleases: releases.length,
    safe: unreadable.length === 0,
    unreadableReleases: unreadable,
    releaseOrphans,
    patchOrphans,
    embeddedOrphans,
    totalFiles: all.length,
    totalBytes: all.reduce((sum, item) => sum + item.bytes, 0),
  };
}

/**
 * 清理孤儿文件。持 runtimeVersion 级锁（与发布 / GC 互斥），
 * 且只接受 `safe` 的扫描结果：引用关系不确定时宁可留着。
 */
export async function pruneOrphans(
  runtimeVersion,
  report,
  { operator = 'cli', via = 'cli', requestId = null, source = null } = {},
) {
  if (!report || report.safe !== true) {
    const detail = report?.unreadableReleases?.join(', ') || '(未知)';
    throw new Error(
      `存在无法解析 metadata 的版本目录（${detail}），引用关系不确定，已拒绝清理孤儿文件`,
    );
  }

  return withLock(
    `${runtimeVersion}:runtime`,
    runtimeLockFile(runtimeVersion),
    async () => {
      const removed = [];
      const failed = [];
      for (const item of [
        ...(report.releaseOrphans || []),
        ...(report.patchOrphans || []),
        ...(report.embeddedOrphans || []),
      ]) {
        try {
          await fsp.rm(item.path, { force: true });
          removed.push(item);
        } catch (error) {
          failed.push({ file: item.file, error: error.message });
        }
      }
      const bytes = removed.reduce((sum, item) => sum + item.bytes, 0);
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
              orphansRemoved: removed.length,
              orphanBytes: bytes,
              orphansFailed: failed.length,
              files: removed.slice(0, 50).map((item) => item.file),
            },
            source,
          }),
        );
      }
      return { removed, failed, bytes };
    },
  );
}
