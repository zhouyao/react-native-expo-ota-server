import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPDATES_DIR } from './config.mjs';
import { readJson, safeJoin, writeJsonAtomic } from './lib.mjs';

export const DEFAULT_CHANNEL = 'production';
export const MAX_HISTORY = 20;

export function normalizeChannel(channel) {
  const value = String(channel || DEFAULT_CHANNEL).trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(value) ? value : DEFAULT_CHANNEL;
}

export function runtimeDir(runtimeVersion) {
  return safeJoin(UPDATES_DIR, String(runtimeVersion));
}

export function releaseDir(runtimeVersion, releaseId) {
  return safeJoin(runtimeDir(runtimeVersion), String(releaseId));
}

export function channelsDir(runtimeVersion) {
  return path.join(runtimeDir(runtimeVersion), 'channels');
}

export function channelFile(runtimeVersion, channel) {
  return safeJoin(channelsDir(runtimeVersion), `${normalizeChannel(channel)}.json`);
}

// 旧布局：current.json / current.<channel>.json，仅用于兼容读取。
function legacyPointerFile(runtimeVersion, channel) {
  const name = normalizeChannel(channel);
  const file =
    name === DEFAULT_CHANNEL ? 'current.json' : `current.${name}.json`;
  return path.join(runtimeDir(runtimeVersion), file);
}

export function defaultRollout() {
  return { percentage: 100, whitelist: [], updatedAt: null };
}

export const PLATFORM_KEYS = ['ios', 'android'];

/** 平台灰度覆盖：非法值丢弃，空对象归一为 null（表示跟随统一 percentage）。 */
export function normalizeByPlatform(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const platform of PLATFORM_KEYS) {
    const raw = value[platform];
    if (raw === undefined || raw === null || raw === '') continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    result[platform] = Math.max(0, Math.min(100, num));
  }
  return Object.keys(result).length ? result : null;
}

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** 通道级发布锁文件：与通道状态同目录，跨进程互斥。 */
export function channelLockFile(runtimeVersion, channel) {
  return safeJoin(
    channelsDir(runtimeVersion),
    '.locks',
    `${normalizeChannel(channel)}.lock`,
  );
}

/** 统一的审计条目：history 与 audit.jsonl 共用，保证字段一致。 */
export function auditEntry({
  action,
  channel,
  releaseId = null,
  updateId = null,
  operator = 'unknown',
  via = 'cli',
  requestId = null,
  params,
  source,
}) {
  return {
    at: new Date().toISOString(),
    action,
    channel: normalizeChannel(channel),
    releaseId: releaseId || null,
    updateId: updateId || null,
    operator,
    via,
    requestId: requestId || null,
    ...(params ? { params } : {}),
    ...(source ? { source } : {}),
  };
}

export function auditFile(runtimeVersion) {
  return path.join(runtimeDir(runtimeVersion), 'audit.jsonl');
}

/** 追加全量审计日志；失败只影响审计，不影响发布主流程。 */
export async function appendAudit(runtimeVersion, entry) {
  try {
    const file = auditFile(runtimeVersion);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    const stat = await fsp.stat(file);
    if (stat.size > AUDIT_MAX_BYTES) {
      await fsp.rename(file, `${file}.${Date.now()}`);
    }
  } catch {
    // 审计是旁路
  }
}

export async function readAudit(runtimeVersion, { channel = '', limit = 100 } = {}) {
  try {
    const text = await fsp.readFile(auditFile(runtimeVersion), 'utf8');
    const items = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (channel && item.channel !== normalizeChannel(channel)) continue;
        items.push(item);
      } catch {
        // 跳过损坏行
      }
    }
    return items.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function normalizeRecord(record) {
  return {
    ...record,
    rollout: {
      ...defaultRollout(),
      ...(record.rollout || {}),
      byPlatform: normalizeByPlatform(record.rollout?.byPlatform),
    },
    history: Array.isArray(record.history)
      ? record.history.slice(0, MAX_HISTORY)
      : [],
  };
}

/**
 * 读取通道状态：
 * channels/<channel>.json 为唯一写入位置；旧 current*.json 作为只读兼容。
 */
export async function readChannel(runtimeVersion, channel = DEFAULT_CHANNEL) {
  const name = normalizeChannel(channel);
  const record = await readJson(channelFile(runtimeVersion, name));
  if (record) return normalizeRecord({ ...record, channel: name });

  const legacy = await readJson(legacyPointerFile(runtimeVersion, name));
  if (legacy?.rollback) {
    return normalizeRecord({
      channel: name,
      rollback: true,
      commitTime: legacy.commitTime,
    });
  }
  if (legacy?.releaseId) {
    return normalizeRecord({
      channel: name,
      releaseId: legacy.releaseId,
      createdAt: legacy.createdAt || null,
    });
  }

  if (name !== DEFAULT_CHANNEL) {
    const fallback = await readChannel(runtimeVersion, DEFAULT_CHANNEL);
    if (fallback?.releaseId) {
      return normalizeRecord({ ...fallback, channel: name, inheritedFrom: DEFAULT_CHANNEL });
    }
  }

  const [latest] = await listReleaseIds(runtimeVersion);
  return latest
    ? normalizeRecord({ channel: name, releaseId: latest })
    : null;
}

// 兼容旧调用方。
export const readCurrent = readChannel;

export async function listChannels(runtimeVersion) {
  const names = new Set([DEFAULT_CHANNEL]);
  try {
    for (const file of await fsp.readdir(channelsDir(runtimeVersion))) {
      if (file.endsWith('.json')) names.add(file.slice(0, -'.json'.length));
    }
  } catch {
    // 新布局目录尚未创建
  }
  try {
    for (const file of await fsp.readdir(runtimeDir(runtimeVersion))) {
      const match = file.match(/^current(?:\.([a-z0-9_-]+))?\.json$/);
      if (match) names.add(match[1] || DEFAULT_CHANNEL);
    }
  } catch {
    // runtimeVersion 目录不存在
  }
  return [...names].sort();
}

export async function listReleaseIds(runtimeVersion) {
  try {
    const entries = await fsp.readdir(runtimeDir(runtimeVersion), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
}

export async function writeChannel(runtimeVersion, channel, record) {
  const name = normalizeChannel(channel);
  const normalized = normalizeRecord({
    ...record,
    channel: name,
    updatedAt: new Date().toISOString(),
  });
  await writeJsonAtomic(channelFile(runtimeVersion, name), normalized);
  return normalized;
}

/**
 * 发布/提升：current 变成 previous，新版本成为 current。
 * rollout 随通道继承；显式传入时覆盖。
 */
export async function promoteRelease(runtimeVersion, channel, releaseId, options = {}) {
  const name = normalizeChannel(channel);
  const previous = await readChannel(runtimeVersion, name);
  const entry = auditEntry({
    action: options.action || 'publish',
    channel: name,
    releaseId,
    updateId: options.updateId,
    operator: options.operator,
    via: options.via,
    requestId: options.requestId,
    params: options.params,
    source: options.source,
  });
  const record = {
    channel: name,
    releaseId,
    createdAt: options.createdAt || new Date().toISOString(),
    updateId: options.updateId || null,
    previous:
      previous?.releaseId && previous.releaseId !== releaseId
        ? {
            releaseId: previous.releaseId,
            createdAt: previous.createdAt || null,
            updateId: previous.updateId || null,
          }
        : previous?.previous || null,
    // 发布沿用已有平台灰度配置，options.rollout 只覆盖显式传入的字段。
    rollout: options.rollout
      ? {
          ...defaultRollout(),
          ...(previous?.rollout || {}),
          ...options.rollout,
          updatedAt: new Date().toISOString(),
        }
      : previous?.rollout || defaultRollout(),
    history: [entry, ...(previous?.history || [])].slice(0, MAX_HISTORY),
  };
  const written = await writeChannel(runtimeVersion, name, record);
  await appendAudit(runtimeVersion, entry);
  return written;
}

export async function setRollout(
  runtimeVersion,
  channel,
  { percentage, whitelist, byPlatform, operator, via, requestId, source } = {},
) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  if (!current) throw new Error(`通道 ${name} 不存在`);
  const next = {
    ...current.rollout,
    ...(percentage === undefined
      ? {}
      : { percentage: Math.max(0, Math.min(100, Number(percentage))) }),
    ...(whitelist === undefined ? {} : { whitelist: whitelist.map(String) }),
    // undefined = 保持不变；null / 空对象 = 清除覆盖，回到统一 percentage。
    ...(byPlatform === undefined
      ? {}
      : { byPlatform: normalizeByPlatform(byPlatform) }),
    updatedAt: new Date().toISOString(),
  };
  const entry = auditEntry({
    action: 'set-rollout',
    channel: name,
    releaseId: current.releaseId || null,
    updateId: current.updateId || null,
    operator,
    via,
    requestId,
    params: {
      percentage: next.percentage,
      whitelist: next.whitelist,
      byPlatform: next.byPlatform,
    },
    source,
  });
  const written = await writeChannel(runtimeVersion, name, {
    ...current,
    rollout: next,
    history: [entry, ...(current.history || [])].slice(0, MAX_HISTORY),
  });
  await appendAudit(runtimeVersion, entry);
  return written;
}

/**
 * 记录止损状态（不做发布动作；止血由 setRollout 完成）。
 * 状态写入通道记录，供幂等/冷却判定与看板复盘；releaseId 变化后自然重新具备触发资格。
 */
export async function setStopLoss(runtimeVersion, channel, stopLoss) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  if (!current) throw new Error(`通道 ${name} 不存在`);
  const entry = auditEntry({
    action: 'stop-loss',
    channel: name,
    releaseId: current.releaseId || null,
    updateId: current.updateId || null,
    operator: stopLoss.operator || 'stop-loss',
    via: stopLoss.via || 'sentinel',
    params: { mode: stopLoss.action, reason: stopLoss.reason },
  });
  const written = await writeChannel(runtimeVersion, name, {
    ...current,
    stopLoss: { ...stopLoss },
    history: [entry, ...(current.history || [])].slice(0, MAX_HISTORY),
  });
  await appendAudit(runtimeVersion, entry);
  return written;
}

/**
 * 清除止损状态（恢复灰度后调用），并记录一条 restore-rollout 审计。
 * 只删 stopLoss 字段，rollout 由调用方先行写回。
 */
export async function clearStopLoss(
  runtimeVersion,
  channel,
  { operator, via, requestId, source } = {},
) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  if (!current) throw new Error(`通道 ${name} 不存在`);
  const entry = auditEntry({
    action: 'restore-rollout',
    channel: name,
    releaseId: current.releaseId || null,
    updateId: current.updateId || null,
    operator,
    via,
    requestId,
    params: { hadSnapshot: Boolean(current.stopLoss?.previousRollout) },
    source,
  });
  const rest = { ...current };
  delete rest.stopLoss;
  const written = await writeChannel(runtimeVersion, name, {
    ...rest,
    history: [entry, ...(current.history || [])].slice(0, MAX_HISTORY),
  });
  await appendAudit(runtimeVersion, entry);
  return written;
}

export async function rollbackPrevious(runtimeVersion, channel) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  if (!current?.previous?.releaseId) {
    throw new Error(`通道 ${name} 没有可回滚的上一个版本`);
  }
  const restored = current.previous;
  return writeChannel(runtimeVersion, name, {
    ...current,
    releaseId: restored.releaseId,
    createdAt: new Date().toISOString(),
    updateId: restored.updateId || null,
    previous: null,
    history: [
      {
        releaseId: restored.releaseId,
        updateId: restored.updateId || null,
        at: new Date().toISOString(),
        action: 'rollback',
      },
      ...(current.history || []),
    ].slice(0, MAX_HISTORY),
  });
}

/** 下发 rollBackToEmbedded 指令（协议保留，运维入口不在看板）。 */
export async function setRollback(
  runtimeVersion,
  channel = DEFAULT_CHANNEL,
  { operator, via, requestId, source } = {},
) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  const entry = auditEntry({
    action: 'rollback-embedded',
    channel: name,
    releaseId: current?.releaseId || null,
    updateId: current?.updateId || null,
    operator,
    via,
    requestId,
    source,
  });
  const written = await writeChannel(runtimeVersion, name, {
    ...(current || {}),
    rollback: true,
    commitTime: new Date().toISOString(),
    history: [entry, ...(current?.history || [])].slice(0, MAX_HISTORY),
  });
  await appendAudit(runtimeVersion, entry);
  return written;
}
