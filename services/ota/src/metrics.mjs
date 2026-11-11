import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPDATES_DIR } from './config.mjs';

const MAX_BYTES = 5 * 1024 * 1024;

export const PLATFORM_KEYS = ['ios', 'android'];
export const UNKNOWN_PLATFORM = 'unknown';
export const PLATFORM_GROUPS = [...PLATFORM_KEYS, UNKNOWN_PLATFORM];

/**
 * 事件平台归一化：只认 ios / android。
 * 其余（资源请求失败、早期无字段事件、异常请求头）归入 unknown 兜底分组：
 * 它不是设备平台，看板「按平台」表不展示，只用于排查与总数核对。
 */
export function platformKey(event) {
  return PLATFORM_KEYS.includes(event?.platform) ? event.platform : UNKNOWN_PLATFORM;
}

/** 查询参数归一化：空串表示不筛选，非法值视为不筛选而不是悄悄归到 unknown。 */
export function normalizePlatform(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return PLATFORM_GROUPS.includes(key) ? key : '';
}

export function metricsFile(runtimeVersion) {
  return path.join(UPDATES_DIR, String(runtimeVersion), 'metrics', 'events.jsonl');
}

/** 追加一条事件；任何失败都只影响监控，不影响更新链路。 */
export async function recordEvent(runtimeVersion, event) {
  if (!runtimeVersion) return;
  try {
    const file = metricsFile(runtimeVersion);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
    const stat = await fsp.stat(file);
    if (stat.size > MAX_BYTES) {
      await fsp.rename(file, `${file}.${Date.now()}`);
    }
  } catch {
    // 监控是旁路，静默失败
  }
}

/** 主文件 + 5 MB 轮转出去的历史文件；轮转文件按时间戳升序，主文件最后。 */
async function metricsFiles(runtimeVersion) {
  const file = metricsFile(runtimeVersion);
  const dir = path.dirname(file);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const prefix = 'events.jsonl.';
  const rotated = names
    .filter((name) => /^events\.jsonl\.\d+$/.test(name))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  return [...rotated.map((name) => path.join(dir, name)), file];
}

async function readEvents(runtimeVersion, since) {
  const events = [];
  for (const file of await metricsFiles(runtimeVersion)) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue; // 主文件可能还没创建，轮转文件可能已被清理
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (since && Date.parse(event.at) < since) continue;
        events.push(event);
      } catch {
        // 跳过损坏行
      }
    }
  }
  return events;
}

/** 只读导出：供止损哨兵按时间窗口取事件，避免再实现一套事件读取。 */
export async function eventsSince(runtimeVersion, sinceMs) {
  return readEvents(runtimeVersion, sinceMs);
}

const dayKey = (iso) => {
  const time = Date.parse(iso);
  return Number.isFinite(time)
    ? new Date(time).toISOString().slice(0, 10)
    : 'unknown';
};

/** 差分补丁的独立统计口径：不并入 total / manifests / assets / clientEvents。 */
function emptyPatchStats() {
  return {
    requests: 0,
    hits: 0,
    fallbacks: 0,
    patchBytes: 0,
    fullBytes: 0,
    savedBytes: 0,
  };
}

function bumpPatch(stats, event) {
  stats.requests += 1;
  if (event.hit) {
    stats.hits += 1;
    stats.patchBytes += Number(event.patchSize) || 0;
    stats.fullBytes += Number(event.fullSize) || 0;
    stats.savedBytes += Number(event.savedBytes) || 0;
  } else {
    stats.fallbacks += 1;
  }
  return stats;
}

function patchRates(stats) {
  return {
    ...stats,
    hitRate: stats.requests ? Math.round((stats.hits / stats.requests) * 100) : 0,
    savingRate: stats.fullBytes ? Math.round((stats.savedBytes / stats.fullBytes) * 100) : 0,
  };
}

function emptyPlatformGroup() {
  return {
    total: 0,
    manifests: 0,
    assets: 0,
    clientEvents: 0,
    errors: 0,
    uniqueUids: 0,
    byServed: { current: 0, previous: 0, whitelist: 0 },
    byStatus: {},
    versions: {},
    byChannel: {},
    byDay: {},
  };
}

function dayEntries(map) {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, ...value }));
}

/**
 * 只读聚合：看板指标卡片与版本分布。
 * platform 为空时统计全部；指定后所有原有字段都只统计该平台。
 * byPlatform 始终基于全量事件，便于在筛选状态下同时对比两端。
 */
export async function aggregateMetrics(
  runtimeVersion,
  { days = 7, platform = '' } = {},
) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const filter = normalizePlatform(platform);
  const events = await readEvents(runtimeVersion, since);
  const uids = new Set();
  const byChannel = {};
  const byServed = { current: 0, previous: 0, whitelist: 0 };
  const byStatus = {};
  const byDay = {};
  const versions = {};
  const byPlatform = Object.fromEntries(
    PLATFORM_GROUPS.map((name) => [name, emptyPlatformGroup()]),
  );
  const platformUids = Object.fromEntries(
    PLATFORM_GROUPS.map((name) => [name, new Set()]),
  );
  // patch 单独聚合：byPlatform / reasons 始终全量，汇总与 byChannel / byDay 跟随平台筛选。
  const patch = {
    ...emptyPatchStats(),
    reasons: {},
    byPlatform: Object.fromEntries(
      PLATFORM_GROUPS.map((name) => [name, emptyPatchStats()]),
    ),
    byChannel: {},
    byDay: {},
  };
  let manifests = 0;
  let assets = 0;
  let clientEvents = 0;
  let errors = 0;

  const channelEntry = (name) => {
    if (!byChannel[name]) {
      byChannel[name] = {
        total: 0,
        manifests: 0,
        current: 0,
        previous: 0,
        whitelist: 0,
        errors: 0,
        uniqueUids: 0,
      };
    }
    return byChannel[name];
  };
  const groupChannel = (group, name) => {
    if (!group.byChannel[name]) {
      group.byChannel[name] = {
        total: 0,
        manifests: 0,
        errors: 0,
        current: 0,
        previous: 0,
        whitelist: 0,
        uniqueUids: 0,
      };
    }
    return group.byChannel[name];
  };
  const dayEntry = (map, day) => {
    if (!map[day]) map[day] = { total: 0, current: 0, previous: 0 };
    return map[day];
  };
  const channelUids = new Map();
  // 平台 × 通道的设备去重，供通道页按平台展示「N 设备」。
  const platformChannelUids = new Map();
  // 实际运行版本：每个设备（uid）只保留最近一次客户端上报，避免更新前后重复计入。
  const runningUids = new Map();

  for (const event of events) {
    // 补丁事件走独立口径，避免改变既有 total / 错误率 / 客户端上报等统计。
    if (event.type === 'asset-patch') {
      const patchPlatform = platformKey(event);
      bumpPatch(patch.byPlatform[patchPlatform], event);
      if (!event.hit) {
        const reason = event.reason || 'unknown';
        patch.reasons[reason] = (patch.reasons[reason] || 0) + 1;
      }
      if (filter && patchPlatform !== filter) continue;
      bumpPatch(patch, event);
      const patchChannel = event.channel || '-';
      patch.byChannel[patchChannel] ||= emptyPatchStats();
      bumpPatch(patch.byChannel[patchChannel], event);
      const patchDay = dayKey(event.at);
      patch.byDay[patchDay] ||= emptyPatchStats();
      bumpPatch(patch.byDay[patchDay], event);
      continue;
    }

    const key = platformKey(event);
    const group = byPlatform[key];
    const status = Number(event.status) || 0;
    const failed = status >= 400;
    const channelName = event.channel || '-';
    const day = dayKey(event.at);
    const isManifest = event.type === 'manifest';
    const isAsset = event.type === 'asset';
    // 客户端事件携带的是「当时正在运行的 updateId」，不是服务端下发的版本。
    // 按 uid 取最近一条，得到每个设备当前实际运行的版本。
    if (!isManifest && !isAsset && event.uid) {
      const runningUpdateId = event.updateId || null;
      const embedded = Boolean(event.embedded);
      if ((runningUpdateId || embedded) && (!filter || key === filter)) {
        const runningKey = `${channelName}\u0000${event.uid}`;
        const at = Date.parse(event.at) || 0;
        const previous = runningUids.get(runningKey);
        if (!previous || at >= previous.at) {
          runningUids.set(runningKey, {
            channel: channelName,
            uid: event.uid,
            at,
            updateId: runningUpdateId,
            releaseId: event.releaseId || null,
            platform: key,
            embedded,
          });
        }
      }
    }

    // 平台分组基于全量事件。
    group.total += 1;
    group.byStatus[status] = (group.byStatus[status] || 0) + 1;
    if (failed) group.errors += 1;
    if (event.uid) {
      platformUids[key].add(event.uid);
      const pcKey = `${key}:${channelName}`;
      const set = platformChannelUids.get(pcKey) || new Set();
      set.add(event.uid);
      platformChannelUids.set(pcKey, set);
    }
    const gChannel = groupChannel(group, channelName);
    if (!isAsset) {
      gChannel.total += 1;
      if (failed) gChannel.errors += 1;
      if (isManifest && event.served && gChannel[event.served] !== undefined) {
        gChannel[event.served] += 1;
      }
    }
    if (isManifest) {
      group.manifests += 1;
      gChannel.manifests += 1;
      const gDay = dayEntry(group.byDay, day);
      gDay.total += 1;
      if (event.served && gDay[event.served] !== undefined) gDay[event.served] += 1;
      if (event.served && group.byServed[event.served] !== undefined) {
        group.byServed[event.served] += 1;
      }
      if (event.updateId) {
        group.versions[event.updateId] = (group.versions[event.updateId] || 0) + 1;
      }
    } else if (isAsset) {
      group.assets += 1;
    } else {
      group.clientEvents += 1;
    }

    if (filter && key !== filter) continue;

    // 以下沿用旧口径：asset 不进 byChannel / byDay，byDay 只统计 manifest。
    if (event.uid) {
      uids.add(event.uid);
      const set = channelUids.get(channelName) || new Set();
      set.add(event.uid);
      channelUids.set(channelName, set);
    }
    if (failed) errors += 1;
    byStatus[status] = (byStatus[status] || 0) + 1;

    if (isManifest) {
      manifests += 1;
      const entry = channelEntry(channelName);
      entry.total += 1;
      entry.manifests += 1;
      if (event.served && entry[event.served] !== undefined) entry[event.served] += 1;
      if (failed) entry.errors += 1;
      const entryDay = dayEntry(byDay, day);
      entryDay.total += 1;
      if (event.served && entryDay[event.served] !== undefined) entryDay[event.served] += 1;
      if (event.served && byServed[event.served] !== undefined) byServed[event.served] += 1;
      if (event.updateId) versions[event.updateId] = (versions[event.updateId] || 0) + 1;
    } else if (isAsset) {
      assets += 1;
    } else {
      clientEvents += 1;
      const entry = channelEntry(channelName);
      entry.total += 1;
    }
  }

  for (const [channel, set] of channelUids) {
    if (byChannel[channel]) byChannel[channel].uniqueUids = set.size;
  }
  for (const name of PLATFORM_GROUPS) {
    const group = byPlatform[name];
    group.uniqueUids = platformUids[name].size;
    group.byDay = dayEntries(group.byDay);
  }
  for (const [pcKey, set] of platformChannelUids) {
    const index = pcKey.indexOf(':');
    const platform = pcKey.slice(0, index);
    const channelName = pcKey.slice(index + 1);
    const entry = byPlatform[platform] && byPlatform[platform].byChannel[channelName];
    if (entry) entry.uniqueUids = set.size;
  }

  // 汇总实际运行版本：channel → 设备数 + 版本分布（按设备数降序）。
  const runningChannels = new Map();
  for (const entry of runningUids.values()) {
    let bucket = runningChannels.get(entry.channel);
    if (!bucket) {
      bucket = { devices: 0, versions: new Map() };
      runningChannels.set(entry.channel, bucket);
    }
    bucket.devices += 1;
    const versionKey = `${entry.platform}\u0000${entry.embedded ? 'embedded' : entry.updateId || ''}`;
    let version = bucket.versions.get(versionKey);
    if (!version) {
      version = {
        updateId: entry.updateId,
        releaseId: entry.releaseId,
        platform: entry.platform,
        embedded: entry.embedded,
        devices: 0,
        lastAtMs: entry.at,
      };
      bucket.versions.set(versionKey, version);
    }
    version.devices += 1;
    if (entry.at >= version.lastAtMs) {
      version.lastAtMs = entry.at;
      if (entry.releaseId) version.releaseId = entry.releaseId;
    }
  }
  const running = { byChannel: {} };
  for (const [name, bucket] of runningChannels) {
    running.byChannel[name] = {
      devices: bucket.devices,
      versions: [...bucket.versions.values()]
        .sort((a, b) => b.devices - a.devices)
        .map((version) => ({
          updateId: version.updateId,
          releaseId: version.releaseId,
          platform: version.platform,
          embedded: version.embedded,
          devices: version.devices,
          lastAt: new Date(version.lastAtMs).toISOString(),
        })),
    };
  }

  return {
    windowDays: days,
    platform: filter,
    total: manifests + assets + clientEvents,
    manifests,
    assets,
    clientEvents,
    errors,
    uniqueUids: uids.size,
    byChannel,
    byPlatform,
    byServed,
    byStatus,
    byDay: dayEntries(byDay),
    versions,
    running,
    patch: {
      ...patchRates(patch),
      reasons: patch.reasons,
      byPlatform: Object.fromEntries(
        PLATFORM_GROUPS.map((name) => [name, patchRates(patch.byPlatform[name])]),
      ),
      byChannel: Object.fromEntries(
        Object.entries(patch.byChannel).map(([name, stats]) => [name, patchRates(stats)]),
      ),
      byDay: dayEntries(
        Object.fromEntries(
          Object.entries(patch.byDay).map(([day, stats]) => [day, patchRates(stats)]),
        ),
      ),
    },
  };
}

/**
 * 事件流查询：倒序返回，支持偏移与过滤。
 * 过滤只作用于已落盘事件，不改变聚合口径。
 */
export async function recentEvents(runtimeVersion, options = {}) {
  if (typeof options === 'number') options = { limit: options };
  const {
    limit = 30,
    offset = 0,
    type = '',
    channel = '',
    status = '',
    uid = '',
    platform = '',
  } = options;

  let events = await readEvents(runtimeVersion, 0);
  const filter = normalizePlatform(platform);

  if (filter) events = events.filter((e) => platformKey(e) === filter);
  if (type) events = events.filter((e) => String(e.type || '').includes(type));
  if (channel) events = events.filter((e) => e.channel === channel);
  if (status === 'error') events = events.filter((e) => Number(e.status) >= 400);
  else if (status === 'ok') events = events.filter((e) => Number(e.status) < 400);
  else if (status) events = events.filter((e) => String(e.status) === String(status));
  if (uid) events = events.filter((e) => String(e.uid || '').includes(uid));

  const ordered = events.slice().reverse();
  return { items: ordered.slice(offset, offset + limit), total: events.length };
}
