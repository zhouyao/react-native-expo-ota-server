import { stopLossConfig } from './config.mjs';
import { eventsSince } from './metrics.mjs';
import {
  channelLockFile,
  clearStopLoss,
  normalizeChannel,
  readChannel,
  setRollout,
  setStopLoss,
} from './release-store.mjs';
import { withLock } from './locks.mjs';

/**
 * 崩溃感知 / 止损哨兵。
 *
 * 口径（v2）：不再对「整个通道的所有启动」求比率（会被放量比例稀释，小灰度永远触发不了），
 * 而是先按 manifest 事件构建 cohort —— 被本通道下发过 current 的 uid 集合 ——
 * 再只统计这批 uid 的应急启动 / 安装失败。这样：
 *   - 5% 灰度 + 该版本 100% 坏，cohort 内应急率仍是 100%，能被正确识别；
 *   - emergency 事件本身带着内置包的 releaseId，无法直接绑坏版本，用 uid 关联更可靠。
 *
 * 动作（默认 halt）：清零灰度，并清空白名单与平台覆盖，否则它们仍会命中坏包。
 * 注意：halt 只止血（挡住还没拿到坏包的新设备）。已在坏包上的设备要真正回退，
 * 需要「重发布上一版」刷新 createdAt（expo-updates 只接受更新的 manifest），
 * 那是重量级操作，绝不放在 manifest 请求路径上，交由管理动作/CLI 执行。
 */

const verdictCache = new Map();
// 告警去重：monitor 模式下同一个 releaseId + 失败类型只提醒一次（冷却期内）。
const alertCache = new Map();

/** 测试与发布后可清空进程内判定缓存。 */
export function resetStopLossCache() {
  verdictCache.clear();
  alertCache.clear();
}

function fmtRate(rate) {
  return `${Math.round((Number(rate) || 0) * 1000) / 10}%`;
}

function computeHealth(record, channelName, events, cfg) {
  const releaseId = record?.releaseId || null;
  if (!releaseId) {
    return {
      channel: channelName,
      releaseId: null,
      updateId: null,
      enabled: cfg.enabled,
      mode: cfg.mode,
      minSamples: cfg.minSamples,
      windowMs: cfg.windowMs,
      cohortSize: 0,
      launches: 0,
      emergency: 0,
      fallback: 0,
      badLaunches: 0,
      attempts: 0,
      fails: 0,
      emergencyRate: 0,
      fallbackRate: 0,
      launchFailRate: 0,
      installFailRate: 0,
      channelLaunches: 0,
      channelEmergency: 0,
      samples: 0,
      verdict: 'healthy',
      reason: 'no-release',
    };
  }

  // cohort：当前版本在这个通道被下发过的设备（uid 去重）。
  const cohort = new Set();
  for (const event of events) {
    if (
      event.type === 'manifest' &&
      event.served === 'current' &&
      event.uid &&
      String(event.channel || '') === channelName &&
      String(event.releaseId || '') === String(releaseId)
    ) {
      cohort.add(event.uid);
    }
  }

  let launches = 0;
  let emergency = 0;
  let fallback = 0;
  let badLaunches = 0;
  let attempts = 0;
  let fails = 0;
  let channelLaunches = 0;
  let channelEmergency = 0;

  for (const event of events) {
    if (event.type === 'client-launch') {
      const sameChannel = String(event.channel || '') === channelName;
      if (sameChannel) {
        channelLaunches += 1;
        if (event.emergency) channelEmergency += 1;
      }
      if (!event.uid || !cohort.has(event.uid)) continue;
      launches += 1;
      if (event.emergency) emergency += 1;
      // 坏包回退信号：客户端 watchdog 对比 pendingUpdateId 与实际 updateId 得出。
      if (event.fallback) fallback += 1;
      if (event.emergency || event.fallback) badLaunches += 1;
    } else if (
      event.type === 'client-download' ||
      event.type === 'client-apply'
    ) {
      if (!event.uid || !cohort.has(event.uid)) continue;
      attempts += 1;
      if (Number(event.status) >= 400) fails += 1;
    }
  }

  const emergencyRate = launches ? emergency / launches : 0;
  const fallbackRate = launches ? fallback / launches : 0;
  const launchFailRate = launches ? badLaunches / launches : 0;
  const installFailRate = attempts ? fails / attempts : 0;
  // 关闭或仅监控时永远不给出可执行的 halt/rollback，避免"评估即动作"的误解。
  const actionable = !cfg.enabled || cfg.mode === 'monitor' ? 'alert' : cfg.mode;

  let verdict = 'healthy';
  let reason = 'ok';
  if (launches >= cfg.minSamples && launchFailRate >= cfg.emergencyRate) {
    verdict = actionable;
    reason =
      `launch-fail ${badLaunches}/${launches} (${fmtRate(launchFailRate)}; ` +
      `emergency ${emergency}, fallback ${fallback})`;
  } else if (attempts >= cfg.minSamples && installFailRate >= cfg.installFailRate) {
    verdict = actionable;
    reason = `install-fail ${fails}/${attempts} (${fmtRate(installFailRate)})`;
  } else if (launches < cfg.minSamples && attempts < cfg.minSamples) {
    reason = 'insufficient-samples';
  }

  return {
    channel: channelName,
    releaseId,
    updateId: record.updateId || null,
    enabled: cfg.enabled,
    mode: cfg.mode,
    minSamples: cfg.minSamples,
    windowMs: cfg.windowMs,
    cohortSize: cohort.size,
    launches,
    emergency,
    fallback,
    badLaunches,
    attempts,
    fails,
    emergencyRate,
    fallbackRate,
    launchFailRate,
    installFailRate,
    channelLaunches,
    channelEmergency,
    samples: launches + attempts,
    verdict,
    reason,
  };
}

/** 单通道健康度（只读，供看板与管理动作使用）。 */
export async function evaluateChannelHealth(runtimeVersion, channel, { now = Date.now() } = {}) {
  const cfg = stopLossConfig();
  const name = normalizeChannel(channel);
  const record = await readChannel(runtimeVersion, name);
  if (!record) {
    return {
      channel: name,
      releaseId: null,
      verdict: 'healthy',
      reason: 'no-channel',
      enabled: cfg.enabled,
      mode: cfg.mode,
      minSamples: cfg.minSamples,
    };
  }
  const events = await eventsSince(runtimeVersion, now - cfg.windowMs);
  return computeHealth(record, name, events, cfg);
}

/** 多通道健康度：事件只读一次，避免看板按通道重复解析文件。 */
export async function evaluateChannels(runtimeVersion, channelNames, { now = Date.now() } = {}) {
  const cfg = stopLossConfig();
  const events = await eventsSince(runtimeVersion, now - cfg.windowMs);
  const result = {};
  for (const channel of channelNames) {
    const name = normalizeChannel(channel);
    const record = await readChannel(runtimeVersion, name);
    result[name] = record
      ? computeHealth(record, name, events, cfg)
      : {
          channel: name,
          releaseId: null,
          verdict: 'healthy',
          reason: 'no-channel',
          enabled: cfg.enabled,
          mode: cfg.mode,
          minSamples: cfg.minSamples,
        };
  }
  return result;
}

function formatStopLoss(payload) {
  const rates = payload.rates || payload;
  const action = payload.action || payload.verdict || 'alert';
  return (
    `[OTA 止损] ${payload.channel || '-'} ${action} release=${payload.releaseId || '-'} ` +
    `${payload.reason || ''}`.trim() +
    (rates.emergencyRate !== undefined ? ` 应急=${fmtRate(rates.emergencyRate)}` : '') +
    (rates.installFailRate !== undefined ? ` 安装失败=${fmtRate(rates.installFailRate)}` : '')
  );
}

/**
 * 按 Webhook 平台生成消息体，兼容常见机器人：
 * - 钉钉 / 企业微信：{ msgtype:"text", text:{ content } }
 * - 飞书 / Lark：{ msg_type:"text", content:{ text } }
 * - Slack / 通用：{ text, payload }
 */
export function webhookRequestBody(text, payload, webhook) {
  let host = '';
  try {
    host = new URL(String(webhook || '')).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host.endsWith('dingtalk.com') || host === 'qyapi.weixin.qq.com') {
    return { msgtype: 'text', text: { content: text } };
  }
  if (host === 'open.feishu.cn' || host === 'open.larksuite.com') {
    return { msg_type: 'text', content: { text } };
  }
  return { text, payload };
}

/** Webhook 通知是旁路：失败静默，绝不阻塞止损或更新链路。 */
function notifyStopLoss(payload, cfg) {
  if (!cfg.webhook) return;
  try {
    const body = JSON.stringify(webhookRequestBody(formatStopLoss(payload), payload, cfg.webhook));
    void fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => {});
  } catch {
    // 通知失败不影响止损主流程
  }
}

/**
 * 执行「止血」：清零灰度 + 清空白名单 + 清除平台覆盖，并把原配置快照进 stopLoss。
 *
 * 重要：调用方必须已经持有通道锁，本函数内部不加锁（withLock 不可重入，会死锁）。
 * 哨兵（haltChannel）和看板的人工止血（admin.halt-channel）共用这一份语义。
 */
export async function applyHalt(
  runtimeVersion,
  channel,
  {
    reason = 'manual-halt',
    operator = 'stop-loss',
    via = 'sentinel',
    requestId = null,
    action = 'halt',
    requestedMode = null,
    pendingRollback = false,
    rates = null,
    fallback = 0,
    samples = 0,
    verdict = 'halt',
  } = {},
) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  if (!current?.releaseId) {
    return { verdict, action: 'skipped', reason: 'no-release', releaseId: null };
  }
  // 已处于止血状态且持有快照时，不重复覆盖快照（避免双击把「原灰度」写成 0%）。
  if (
    current.stopLoss &&
    String(current.stopLoss.releaseId) === String(current.releaseId) &&
    current.stopLoss.previousRollout
  ) {
    return { verdict, action: 'skipped', reason: 'already-halted', releaseId: current.releaseId };
  }

  const prev = current.rollout || {};
  const previousRollout = {
    percentage: prev.percentage === undefined ? 100 : prev.percentage,
    whitelist: Array.isArray(prev.whitelist) ? prev.whitelist.slice() : [],
    byPlatform: prev.byPlatform ? { ...prev.byPlatform } : null,
    updatedAt: prev.updatedAt || null,
    at: new Date().toISOString(),
  };

  // 止血：清零灰度 + 清空白名单 + 清除平台覆盖。
  // 只改 percentage 不够：白名单和 byPlatform 仍会命中坏包。
  await setRollout(runtimeVersion, name, {
    percentage: 0,
    whitelist: [],
    byPlatform: null,
    operator,
    via,
    requestId,
  });

  const stopLoss = {
    releaseId: current.releaseId,
    updateId: current.updateId || null,
    action,
    requestedMode,
    // rollback 模式在惰性路径只做止血并标记；真正重发布由管理动作/CLI 执行。
    pendingRollback,
    reason,
    rates,
    fallback,
    samples,
    // 供看板「恢复暂停前灰度」还原。
    previousRollout,
    at: new Date().toISOString(),
    operator,
    via,
  };
  await setStopLoss(runtimeVersion, name, stopLoss);
  notifyStopLoss({ channel: name, ...stopLoss }, stopLossConfig());
  console.log(
    `[ota] 止损${operator === 'stop-loss' ? '触发' : '执行'}：通道 ${name} 版本 ${current.releaseId} 已降为 0%（${reason}）`,
  );

  return {
    verdict,
    action,
    reason,
    releaseId: current.releaseId,
    pendingRollback,
  };
}

/**
 * 恢复「暂停前灰度」：写回 halt 前的 percentage / whitelist / byPlatform，并清除止血状态。
 * 同样要求调用方已持有通道锁。
 */
export async function restoreRollout(
  runtimeVersion,
  channel,
  { operator = 'dashboard', via = 'dashboard', requestId = null } = {},
) {
  const name = normalizeChannel(channel);
  const current = await readChannel(runtimeVersion, name);
  if (!current) throw new Error(`通道 ${name} 不存在`);
  const snapshot = current.stopLoss?.previousRollout;
  if (!snapshot) throw new Error(`通道 ${name} 没有可恢复的暂停前灰度`);
  if (
    current.stopLoss?.releaseId &&
    current.releaseId &&
    String(current.stopLoss.releaseId) !== String(current.releaseId)
  ) {
    throw new Error(`通道 ${name} 当前版本已变更，暂停前灰度不再适用`);
  }
  const percentage =
    snapshot.percentage === null || snapshot.percentage === undefined
      ? 100
      : Number(snapshot.percentage);
  const whitelist = Array.isArray(snapshot.whitelist) ? snapshot.whitelist : [];
  const byPlatform = snapshot.byPlatform === undefined ? null : snapshot.byPlatform;

  await setRollout(runtimeVersion, name, {
    percentage,
    whitelist,
    byPlatform,
    operator,
    via,
    requestId,
  });
  const cleared = await clearStopLoss(runtimeVersion, name, { operator, via, requestId });
  console.log(`[ota] 止损恢复：通道 ${name} 已恢复暂停前灰度 ${percentage}%`);

  return {
    restored: true,
    releaseId: cleared.releaseId || null,
    percentage,
    whitelist: whitelist.length,
    byPlatform: byPlatform || null,
  };
}

async function haltChannel(runtimeVersion, channel, health, cfg) {
  const name = normalizeChannel(channel);
  try {
    return await withLock(
      `${runtimeVersion}:${name}`,
      channelLockFile(runtimeVersion, name),
      async () => {
        const current = await readChannel(runtimeVersion, name);
        if (!current?.releaseId) {
          return { verdict: health.verdict, action: 'skipped', reason: 'no-release' };
        }

        // 同一版本在冷却窗口内只处置一次：既避免持续坏包时每 5 分钟重复写状态，
        // 也不影响「发布新版本后立即评估」——新版本 releaseId 不同，直接放行。
        if (
          current.stopLoss &&
          String(current.stopLoss.releaseId) === String(current.releaseId)
        ) {
          const lastAt = Date.parse(current.stopLoss.at || '');
          if (!Number.isFinite(lastAt) || Date.now() - lastAt < cfg.cooldownMs) {
            return {
              verdict: health.verdict,
              action: 'skipped',
              reason: 'cooling-down',
              releaseId: current.releaseId,
            };
          }
        }

        return applyHalt(runtimeVersion, name, {
          reason: health.reason,
          operator: 'stop-loss',
          via: 'sentinel',
          action: 'halt',
          requestedMode: cfg.mode,
          // rollback 模式在惰性路径只做止血并标记；真正重发布由管理动作/CLI 执行。
          pendingRollback: cfg.mode === 'rollback',
          rates: {
            emergencyRate: health.emergencyRate,
            fallbackRate: health.fallbackRate,
            launchFailRate: health.launchFailRate,
            installFailRate: health.installFailRate,
          },
          fallback: health.fallback,
          samples: health.samples,
          verdict: health.verdict,
        });
      },
      // 请求路径上的锁竞争不应拖慢更新：拿不到就跳过，下一轮再评估。
      { timeout: 2000 },
    );
  } catch (error) {
    // 锁竞争 / 写失败都只影响止损旁路。
    return { verdict: health.verdict, action: 'skipped', reason: `error:${error.message}` };
  }
}

/**
 * 惰性评估 + 动作。默认由 manifest 请求触发（fire-and-forget），
 * 进程内按 cacheMs 缓存判定，避免高频请求反复读事件流。
 */
export async function maybeStopLoss(runtimeVersion, channel, { now = Date.now() } = {}) {
  const cfg = stopLossConfig();
  if (!cfg.enabled) return { verdict: 'disabled', action: null };

  const name = normalizeChannel(channel);
  const key = `${runtimeVersion}:${name}`;
  const cached = verdictCache.get(key);
  if (cached && now - cached.at < cfg.cacheMs) return cached.result;

  const health = await evaluateChannelHealth(runtimeVersion, name, { now });
  let result;
  if (health.verdict === 'healthy' || health.verdict === 'alert') {
    result = { verdict: health.verdict, action: null, reason: health.reason, health };
    if (health.verdict === 'alert') {
      // 同一 releaseId + 失败类型在冷却期内只告警一次，避免 monitor 每 5 分钟刷屏。
      const kind = String(health.reason || 'alert').split(' ')[0] || 'alert';
      const alertKey = `${key}:${health.releaseId || '-'}:${kind}`;
      const lastAt = alertCache.get(alertKey);
      if (!lastAt || now - lastAt >= cfg.alertCooldownMs) {
        alertCache.set(alertKey, now);
        notifyStopLoss({ ...health, action: 'alert' }, cfg);
        console.log(`[ota] 止损告警（未动作）：通道 ${name} ${health.reason}`);
      }
    }
  } else {
    result = await haltChannel(runtimeVersion, name, health, cfg);
  }

  verdictCache.set(key, { at: now, result });
  return result;
}
