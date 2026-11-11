import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ADMIN_ENABLED,
  PUBLIC_BASE_URL,
  gcConfig,
  stopLossConfig,
  webhookOrigin,
} from './config.mjs';
import {
  listChannels,
  listReleaseIds,
  readChannel,
  releaseDir,
  runtimeDir,
  runtimeVersions,
} from './release-store.mjs';
import { readJson } from './lib.mjs';
import { aggregateMetrics, normalizePlatform, recentEvents } from './metrics.mjs';
import { maxBases, patchStats, releaseLaunchHashes } from './patch-store.mjs';
import { evaluateChannels } from './stop-loss.mjs';

const EVENTS_LIMIT_MAX = 200;

const EMPTY_PATCH = {
  requests: 0,
  hits: 0,
  fallbacks: 0,
  hitRate: 0,
  patchBytes: 0,
  fullBytes: 0,
  savedBytes: 0,
  savingRate: 0,
  reasons: {},
  byPlatform: {},
  byChannel: {},
  byDay: [],
};

const EMPTY_TRANSFER = {
  requests: 0,
  bytes: 0,
  rangeRequests: 0,
  uniqueFiles: 0,
  byKind: {},
  byFile: [],
};

const EMPTY_METRICS = {
  windowDays: 7,
  platform: '',
  byPlatform: {},
  total: 0,
  manifests: 0,
  assets: 0,
  clientEvents: 0,
  errors: 0,
  uniqueUids: 0,
  byChannel: {},
  byServed: {},
  byStatus: {},
  byDay: [],
  versions: {},
  running: { byChannel: {} },
  patch: EMPTY_PATCH,
  transfer: EMPTY_TRANSFER,
};

/**
 * 把「设备实际运行版本」与通道指针对齐：
 * current / previous / embedded（内置包）/ other（历史或其他版本）。
 */
function classifyRunning(entry, record) {
  if (!entry) return { devices: 0, versions: [] };
  const currentUpdateId = record?.updateId || null;
  const previousUpdateId = record?.previous?.updateId || null;
  return {
    devices: entry.devices,
    versions: entry.versions.map((version) => ({
      ...version,
      kind: version.embedded
        ? 'embedded'
        : currentUpdateId && version.updateId === currentUpdateId
          ? 'current'
          : previousUpdateId && version.updateId === previousUpdateId
            ? 'previous'
            : 'other',
    })),
  };
}

const EMPTY_CHANNEL_METRICS = {
  total: 0,
  manifests: 0,
  current: 0,
  previous: 0,
  whitelist: 0,
  errors: 0,
  uniqueUids: 0,
};

/** 归一化事件流查询参数（只影响列表，不影响聚合口径）。 */
function pickEventQuery(query = {}) {
  const clamp = (value, fallback, min, max) => {
    // 注意：Number(null) === 0，必须先排除空值，否则缺省 limit 会退化成 1。
    if (value === null || value === undefined || value === '') return fallback;
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(num)));
  };
  return {
    limit: clamp(query.eventsLimit, 30, 1, EVENTS_LIMIT_MAX),
    offset: clamp(query.eventsOffset, 0, 0, Number.MAX_SAFE_INTEGER),
    type: String(query.eventsType || ''),
    channel: String(query.eventsChannel || ''),
    status: String(query.eventsStatus || ''),
    uid: String(query.eventsUid || ''),
    // 事件页专用 eventsPlatform 优先；platform 作为旧 URL 的兼容回退。
    platform: normalizePlatform(query.eventsPlatform || query.platform || ''),
  };
}

/**
 * 统计一个 release 的体积。
 *
 * `size` 是逻辑体积（各文件大小之和），也是这个版本实际下发的字节量；
 * `disk` 只统计首次见到的 inode：提升 / 重发用硬链接复用资产，
 * 不去重会把同一份字节算很多遍，让「磁盘占用」严重虚高。
 */
/**
 * 统计一个 release 的体积。
 *
 * - `rawBytes` 是客户端真正要下载的资产字节（不含 `.gz` 副本）；
 * - `gzipBytes` 是发布时预压缩的 `.gz` 副本体积，只影响磁盘、不影响下发量；
 * - `disk` 按 inode 去重：提升 / 重发用硬链接复用资产，不去重会把同一份字节算很多遍；
 * - `largest` 取最大的几个原始资产，并带上对应 `.gz` 大小，便于定位「哪个文件最占地方」。
 */
async function statsOf(dir, seenInodes = new Set()) {
  const byKind = {};
  let rawBytes = 0;
  let gzipBytes = 0;
  let disk = 0;
  let files = 0;
  const sizes = new Map();

  for (const sub of ['bundles', 'assets']) {
    const kind = (byKind[sub] = { files: 0, rawBytes: 0, gzipBytes: 0 });
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, sub), { withFileTypes: true });
    } catch {
      continue; // 没有 assets 目录属于正常情况
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(path.join(dir, sub, entry.name));
      files += 1;
      kind.files += 1;
      sizes.set(`${sub}/${entry.name}`, stat.size);
      if (entry.name.endsWith('.gz')) {
        gzipBytes += stat.size;
        kind.gzipBytes += stat.size;
      } else {
        rawBytes += stat.size;
        kind.rawBytes += stat.size;
      }
      const inode = `${stat.dev}:${stat.ino}`;
      if (!seenInodes.has(inode)) {
        seenInodes.add(inode);
        disk += stat.size;
      }
    }
  }

  const largest = [...sizes.entries()]
    .filter(([name]) => !name.endsWith('.gz'))
    .map(([file, bytes]) => ({ file, bytes, gzipBytes: sizes.get(`${file}.gz`) || 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  // size 保留为「全部文件字节」，仅用于兼容旧口径；下发表用 rawBytes。
  return { size: rawBytes + gzipBytes, rawBytes, gzipBytes, disk, files, byKind, largest };
}

/** 目录内所有文件的字节数（补丁库 / 内置包 / 日志，不需要 inode 去重）。 */
async function dirBytes(target) {
  let total = 0;
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return 0;
  }
  // 审计日志是单个文件，直接取 size。
  if (stat.isFile()) return stat.size;
  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(full);
      continue;
    }
    try {
      total += (await fsp.stat(full)).size;
    } catch {
      // 并发轮转 / 删除时文件可能已消失
    }
  }
  return total;
}

/**
 * 只读聚合：通道状态、更新列表、指标与事件。
 * 指标与事件是两套查询：指标固定 7 天窗口，事件支持分页与过滤。
 */
export async function buildDashboardState(requested, query = {}, runtime = {}) {
  const versions = await runtimeVersions();
  const rv = requested || versions[0] || '';
  // 顶部工具条的平台选择是全局筛选：指标、通道卡、事件流用同一口径。
  const platform = normalizePlatform(query.platform || '');

  const metrics = rv
    ? await aggregateMetrics(rv, { days: 7, platform })
    : EMPTY_METRICS;
  const byChannel = metrics.byChannel || {};
  const runningByChannel = metrics.running?.byChannel || {};

  const channels = [];
  if (rv) {
    const channelNames = await listChannels(rv);
    // 事件只读一次，按通道分组计算健康度，避免每个通道重复解析 events.jsonl。
    const healthByChannel = await evaluateChannels(rv, channelNames);
    for (const name of channelNames) {
      const record = await readChannel(rv, name);
      channels.push({
        channel: name,
        releaseId: record?.releaseId || null,
        updateId: record?.updateId || null,
        createdAt: record?.createdAt || record?.commitTime || null,
        rollback: Boolean(record?.rollback),
        inheritedFrom: record?.inheritedFrom || null,
        rollout: record?.rollout || { percentage: 100, whitelist: [] },
        rolloutUpdatedAt: record?.rollout?.updatedAt || null,
        previous: record?.previous || null,
        stopLoss: record?.stopLoss || null,
        health: healthByChannel[name] || null,
        // 设备上报的实际运行版本分布（非服务端下发指针）。
        running: classifyRunning(runningByChannel[name], record),
        // 变更审计来自通道记录里已有的 history（最多保留 20 条，看板只取 5 条）
        history: Array.isArray(record?.history) ? record.history.slice(0, 5) : [],
        // 7 天通道维度指标，来自 aggregateMetrics 的 byChannel
        metrics: byChannel[name] || EMPTY_CHANNEL_METRICS,
      });
    }
  }

  const currentBy = new Map();
  const previousBy = new Map();
  for (const channel of channels) {
    if (channel.releaseId) {
      const list = currentBy.get(channel.releaseId) || [];
      list.push(channel.channel);
      currentBy.set(channel.releaseId, list);
    }
    if (channel.previous?.releaseId) {
      const list = previousBy.get(channel.previous.releaseId) || [];
      list.push(channel.channel);
      previousBy.set(channel.previous.releaseId, list);
    }
  }

  const currentUpdateIds = new Set(
    channels.map((channel) => channel.updateId).filter(Boolean),
  );

  const patches = rv
    ? await patchStats(rv)
    : { totalCount: 0, totalBytes: 0, byTargetHash: {}, byPlatform: {} };

  const releases = [];
  let total = 0;
  let gzipTotal = 0;
  let diskTotal = 0;
  // 跨 release 共享同一个 Set：硬链接复用的资产只算一次真实磁盘占用。
  const seenInodes = new Set();
  for (const id of (rv ? await listReleaseIds(rv) : [])) {
    const dir = releaseDir(rv, id);
    const meta = await readJson(path.join(dir, 'metadata.json'));
    const stats = await statsOf(dir, seenInodes);
    total += stats.rawBytes;
    gzipTotal += stats.gzipBytes;
    diskTotal += stats.disk;
    let patchCount = 0;
    let patchBytes = 0;
    for (const hash of releaseLaunchHashes(meta)) {
      const entry = patches.byTargetHash[hash];
      if (entry) {
        patchCount += entry.count;
        patchBytes += entry.bytes;
      }
    }
    releases.push({
      releaseId: id,
      updateId: meta?.id || null,
      createdAt: meta?.createdAt || null,
      platforms: meta?.platforms || [],
      files: stats.files,
      // 下发给客户端的字节（不含 .gz 副本）
      size: stats.rawBytes,
      gzipBytes: stats.gzipBytes,
      byKind: stats.byKind,
      largest: stats.largest,
      restoredFrom: meta?.restoredFrom || null,
      patchCount,
      patchBytes,
      currentChannels: currentBy.get(id) || [],
      previousChannels: previousBy.get(id) || [],
      // 各通道 current 的 updateId 集合：命中即同一个产物（不做内容 diff）
      sameAsCurrent: Boolean(meta?.id) && currentUpdateIds.has(meta.id),
    });
  }

  // 数据目录构成：回答「磁盘到底被什么占了」。
  const rvDir = rv ? runtimeDir(rv) : '';
  const dirs = {
    releases: diskTotal,
    patches: rv ? await dirBytes(path.join(rvDir, 'patches')) : 0,
    embedded: rv ? await dirBytes(path.join(rvDir, 'embedded')) : 0,
    metrics: rv ? await dirBytes(path.join(rvDir, 'metrics')) : 0,
    audit: rv ? await dirBytes(path.join(rvDir, 'audit.jsonl')) : 0,
  };

  const eventsQuery = pickEventQuery(query);
  const eventsResult = rv
    ? await recentEvents(rv, eventsQuery)
    : { items: [], total: 0 };

  const slc = stopLossConfig();
  const gcc = gcConfig();
  const gcRuntime = runtime.gc || {};
  return {
    generatedAt: new Date().toISOString(),
    publicBaseUrl: PUBLIC_BASE_URL,
    adminEnabled: ADMIN_ENABLED,
    // 全局止损设置（脱敏：不返回 Webhook 明文，只给是否已配置与 origin）。
    stopLoss: {
      enabled: slc.enabled,
      mode: slc.mode,
      minSamples: slc.minSamples,
      webhookConfigured: Boolean(slc.webhook),
      webhookOrigin: webhookOrigin(slc.webhook),
      overridden: slc.overridden || { minSamples: false, webhook: false },
    },
    // 回收设置：只有 keepDays / keepLast / mode 可在控制台改，其余是只读展示。
    gc: {
      enabled: gcc.enabled,
      mode: gcc.mode,
      keepDays: gcc.keepDays,
      keepLast: gcc.keepLast,
      intervalMs: gcc.intervalMs,
      patchBases: maxBases(),
      overridden: gcc.overridden || { keepDays: false, keepLast: false, mode: false },
      lastRunAt: gcRuntime.lastRunAt || null,
      lastCandidates: gcRuntime.lastCandidates || 0,
      lastRemoved: gcRuntime.lastRemoved || 0,
      lastBytes: gcRuntime.lastBytes || 0,
      lastError: gcRuntime.lastError || null,
    },
    runtimeVersion: rv,
    platform,
    runtimeVersions: versions,
    channels,
    releases,
    metrics,
    events: eventsResult.items,
    eventsTotal: eventsResult.total,
    eventsQuery,
    stats: {
      releases: releases.length,
      channels: channels.length,
      // 下发给客户端的原始资产字节（不含 .gz），也是「这个版本多大」的口径。
      assetsBytes: total,
      // 发布时预压缩的 .gz 副本，只占磁盘。
      gzipBytes: gzipTotal,
      // 真实磁盘占用：按 inode 去重，提升 / 重发复用的资产只算一次。
      diskBytes: diskTotal,
      patchCount: patches.totalCount,
      patchBytes: patches.totalBytes,
      // 数据目录构成：releases 是去重后的真实占用，其余是各子目录实际字节。
      dirs,
    },
  };
}
