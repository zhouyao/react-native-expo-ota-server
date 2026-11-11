import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ADMIN_ENABLED,
  PUBLIC_BASE_URL,
  UPDATES_DIR,
  stopLossConfig,
  webhookOrigin,
} from './config.mjs';
import {
  listChannels,
  listReleaseIds,
  readChannel,
  releaseDir,
} from './release-store.mjs';
import { readJson } from './lib.mjs';
import { aggregateMetrics, normalizePlatform, recentEvents } from './metrics.mjs';
import { patchStats, releaseLaunchHashes } from './patch-store.mjs';
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

async function statsOf(dir) {
  let size = 0;
  let files = 0;
  for (const sub of ['bundles', 'assets']) {
    try {
      const entries = await fsp.readdir(path.join(dir, sub), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        size += (await fsp.stat(path.join(dir, sub, entry.name))).size;
        files += 1;
      }
    } catch {
      // 没有 assets 目录属于正常情况
    }
  }
  return { size, files };
}

async function runtimeVersions() {
  try {
    const entries = await fsp.readdir(UPDATES_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 只读聚合：通道状态、更新列表、指标与事件。
 * 指标与事件是两套查询：指标固定 7 天窗口，事件支持分页与过滤。
 */
export async function buildDashboardState(requested, query = {}) {
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
  for (const id of (rv ? await listReleaseIds(rv) : [])) {
    const dir = releaseDir(rv, id);
    const meta = await readJson(path.join(dir, 'metadata.json'));
    const stats = await statsOf(dir);
    total += stats.size;
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
      size: stats.size,
      restoredFrom: meta?.restoredFrom || null,
      patchCount,
      patchBytes,
      currentChannels: currentBy.get(id) || [],
      previousChannels: previousBy.get(id) || [],
      // 各通道 current 的 updateId 集合：命中即同一个产物（不做内容 diff）
      sameAsCurrent: Boolean(meta?.id) && currentUpdateIds.has(meta.id),
    });
  }

  const eventsQuery = pickEventQuery(query);
  const eventsResult = rv
    ? await recentEvents(rv, eventsQuery)
    : { items: [], total: 0 };

  const slc = stopLossConfig();
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
      assetsBytes: total,
      patchCount: patches.totalCount,
      patchBytes: patches.totalBytes,
    },
  };
}
