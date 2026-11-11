import http from 'node:http';
import https from 'node:https';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_ENABLED,
  OTA_ENV,
  PORT,
  PUBLIC_BASE_URL,
  UPDATES_DIR,
  assertServiceConfig,
  gcConfig,
  hasScope,
  stopLossConfig,
} from './config.mjs';
import { performAdminAction, requiredScope, resolveAdmin } from './admin.mjs';
import { serveAsset } from './assets.mjs';
import { applyGc, planGc } from './gc.mjs';
import { buildManifestResponse, resolveChannel } from './manifest.mjs';
import { listChannels, readAudit, readChannel, runtimeVersions } from './release-store.mjs';
import { aggregateMetrics, recordEvent } from './metrics.mjs';
import { buildDashboardState } from './dashboard.mjs';
import { renderDashboardHtml } from './dashboard-view.mjs';

/**
 * 统一响应出口。body 可以是 Buffer / 字符串 / 可读流（206 分片）；
 * head=true 时只发与 GET 相同的头，不创建或读取响应体。
 */
function send(res, { status = 200, headers = {}, body }, options = {}) {
  const head = options.head === true;
  const isStream = Boolean(body && typeof body.pipe === 'function');
  const payload =
    body == null || isStream
      ? null
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body));
  const bodyless = head || body == null || status === 304 || status === 204;

  if (isStream && bodyless) body.destroy();

  const finalHeaders = { ...headers };
  if (status === 304 || status === 204) {
    delete finalHeaders['content-length'];
  } else if (!('content-length' in finalHeaders) && payload) {
    finalHeaders['content-length'] = String(payload.length);
  }

  res.writeHead(status, finalHeaders);
  if (bodyless) {
    res.end();
    return;
  }
  if (isStream) {
    body.on('error', (error) => {
      console.error('[ota] 资产流读取失败:', error);
      res.destroy();
    });
    body.pipe(res);
    return;
  }
  res.end(payload);
}

const MAX_BODY_BYTES = 16384;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 反代后面的真实来源地址；直连时退回 socket 地址。 */
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

// /api/events 是公网可达且无鉴权的写入端点，按 IP 做固定窗口限流，避免被刷满磁盘。
const EVENTS_RATE_LIMIT = Number(process.env.OTA_EVENTS_RATE_LIMIT ?? 60);
const EVENTS_WINDOW_MS = 60_000;
const eventWindows = new Map();

function checkEventRate(ip) {
  if (!Number.isFinite(EVENTS_RATE_LIMIT) || EVENTS_RATE_LIMIT <= 0) {
    return { allowed: true };
  }
  const now = Date.now();
  const entry = eventWindows.get(ip);
  if (!entry || now - entry.start >= EVENTS_WINDOW_MS) {
    // 顺带清理过期窗口，避免 Map 随 IP 数量无限增长。
    if (eventWindows.size > 5000) {
      for (const [key, value] of eventWindows) {
        if (now - value.start >= EVENTS_WINDOW_MS) eventWindows.delete(key);
      }
    }
    eventWindows.set(ip, { start: now, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count > EVENTS_RATE_LIMIT) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((EVENTS_WINDOW_MS - (now - entry.start)) / 1000)),
    };
  }
  return { allowed: true };
}

/** 事件流查询参数：只影响列表分页与过滤，不改变指标聚合口径。 */
function dashboardQuery(url) {
  return {
    // platform 是全局指标口径（也是旧事件 URL 的兼容回退）；eventsPlatform 只过滤事件流且优先。
    platform: url.searchParams.get('platform'),
    eventsPlatform: url.searchParams.get('eventsPlatform'),
    eventsLimit: url.searchParams.get('eventsLimit'),
    eventsOffset: url.searchParams.get('eventsOffset'),
    eventsType: url.searchParams.get('eventsType'),
    eventsChannel: url.searchParams.get('eventsChannel'),
    eventsStatus: url.searchParams.get('eventsStatus'),
    eventsUid: url.searchParams.get('eventsUid'),
  };
}

export async function handle(req, res) {
  const started = Date.now();
  const secure = Boolean(req.socket.encrypted);
  let url;
  let channel = '-';
  try {
    url = new URL(
      req.url,
      `${secure ? 'https' : 'http'}://${req.headers.host || 'localhost'}`,
    );
  } catch {
    return send(res, { status: 400, body: 'bad request' });
  }

  try {
    // 只读看板：写操作统一走 /api/admin/actions（需令牌）。
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      if (req.method !== 'GET') {
        return send(res, { status: 405, body: 'method not allowed' });
      }
      const state = await buildDashboardState(
        url.searchParams.get('rv') || '',
        dashboardQuery(url),
      );
      return send(res, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
        body: renderDashboardHtml(state),
      });
    }

    // 控制台前端脚本：独立静态文件，避免把大段 JS 内联进服务端模板。
    if (url.pathname === '/dashboard.js') {
      if (req.method !== 'GET') {
        return send(res, { status: 405, body: 'method not allowed' });
      }
      const script = await fsp.readFile(
        new URL('./dashboard-client.js', import.meta.url),
      );
      return send(res, {
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
        },
        body: script,
      });
    }

    if (url.pathname === '/api/admin/state') {
      const state = await buildDashboardState(
        url.searchParams.get('rv') || '',
        dashboardQuery(url),
      );
      return send(res, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
        body: JSON.stringify(state),
      });
    }

    // 审计日志（只读）：按通道过滤，默认最近 100 条。
    if (url.pathname === '/api/audit') {
      const runtimeVersion = url.searchParams.get('rv') || '';
      const channel = url.searchParams.get('channel') || '';
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const items = runtimeVersion
        ? await readAudit(runtimeVersion, { channel, limit })
        : [];
      return send(res, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
        body: JSON.stringify({ runtimeVersion, channel, items }),
      });
    }

    if (url.pathname === '/api/admin/actions') {
      if (req.method !== 'POST') {
        return send(res, { status: 405, body: 'method not allowed' });
      }
      const jsonHeaders = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      };
      if (!ADMIN_ENABLED) {
        return send(res, {
          status: 403,
          headers: jsonHeaders,
          body: JSON.stringify({ error: '未配置 OTA_ADMIN_TOKEN，写操作已禁用' }),
        });
      }
      const admin = resolveAdmin(req);
      if (!admin) {
        return send(res, {
          status: 401,
          headers: jsonHeaders,
          body: JSON.stringify({ error: '管理令牌无效' }),
        });
      }
      const operator = admin.label;
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        return send(res, {
          status: 400,
          headers: jsonHeaders,
          body: JSON.stringify({ error: `请求体无效: ${error.message}` }),
        });
      }
      // 权限位：止血 / 恢复只需 stop-loss，可给 on-call 一个「能止血不能发布」的窄令牌。
      const scope = requiredScope(payload.action);
      if (scope && !hasScope(admin, scope)) {
        return send(res, {
          status: 403,
          headers: jsonHeaders,
          body: JSON.stringify({ error: `当前令牌缺少 ${scope} 权限` }),
        });
      }
      const requestId =
        typeof payload.requestId === 'string' ? payload.requestId.slice(0, 64) : null;
      const source = {
        ip: clientIp(req),
        ua: String(req.headers['user-agent'] || '').slice(0, 160),
      };
      try {
        const result = await performAdminAction(
          {
            action: payload.action,
            channel: payload.channel,
            releaseId: payload.releaseId,
            runtimeVersion: payload.runtimeVersion,
            percentage: payload.percentage,
            whitelist: payload.whitelist,
            byPlatform: payload.byPlatform,
            reason: payload.reason,
            mode: payload.mode,
            minSamples: payload.minSamples,
            webhook: payload.webhook,
            // GC：releaseIds 为空表示按保留策略整体回收；apply=false 为预览。
            releaseIds: payload.releaseIds,
            apply: payload.apply,
            keepDays: payload.keepDays,
            keepLast: payload.keepLast,
            patchBases: payload.patchBases,
          },
          { operator, via: 'dashboard', requestId, source },
        );
        return send(res, {
          headers: jsonHeaders,
          body: JSON.stringify({
            ok: true,
            output: result.message,
            operator: result.operator,
            duplicated: Boolean(result.duplicated),
          }),
        });
      } catch (error) {
        return send(res, {
          status: 400,
          headers: jsonHeaders,
          body: JSON.stringify({ error: error.message }),
        });
      }
    }

    if (url.pathname === '/healthz') {
      return send(res, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({
          ok: true,
          secure,
          env: OTA_ENV,
          publicBaseUrl: PUBLIC_BASE_URL,
          // 重启后这个时间会更新；控制台报「未知操作」时可据此判断是否加载了新代码。
          startedAt: STARTED_AT,
          // 只暴露「有没有在跑、上次跑成什么样」，不回显被回收的版本清单。
          gc: {
            enabled: gcState.enabled,
            mode: gcState.mode,
            lastRunAt: gcState.lastRunAt,
            lastError: gcState.lastError,
          },
        }),
      });
    }

    if (url.pathname === '/api/channels') {
      const runtimeVersion =
        url.searchParams.get('rv') || req.headers['expo-runtime-version'] || '';
      const names = await listChannels(runtimeVersion);
      const channels = [];
      for (const name of names) {
        const record = await readChannel(runtimeVersion, name);
        channels.push({
          channel: name,
          releaseId: record?.releaseId || null,
          updateId: record?.updateId || null,
          createdAt: record?.createdAt || record?.commitTime || null,
          rollback: Boolean(record?.rollback),
          inheritedFrom: record?.inheritedFrom || null,
          rollout: record?.rollout || null,
          previous: record?.previous || null,
        });
      }
      return send(res, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ runtimeVersion, channels, pointers: channels }),
      });
    }

    if (url.pathname === '/api/metrics') {
      const runtimeVersion = url.searchParams.get('rv') || '';
      const days = Number(url.searchParams.get('days') || 7);
      const metrics = await aggregateMetrics(runtimeVersion, {
        days: Number.isFinite(days) && days > 0 ? days : 7,
        platform: url.searchParams.get('platform') || '',
      });
      return send(res, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ runtimeVersion, ...metrics }),
      });
    }

    // 客户端上报：check / download / apply 结果，供采用率与失败率统计。
    if (url.pathname === '/api/events') {
      if (req.method !== 'POST') {
        return send(res, { status: 405, body: 'method not allowed' });
      }
      const limit = checkEventRate(clientIp(req));
      if (!limit.allowed) {
        return send(res, {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(limit.retryAfter),
          },
          body: JSON.stringify({ error: '上报过于频繁，请稍后重试' }),
        });
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        return send(res, {
          status: error.code === 'BODY_TOO_LARGE' ? 413 : 400,
          body: `bad body: ${error.message}`,
        });
      }
      const runtimeVersion =
        payload.runtimeVersion || req.headers['expo-runtime-version'] || '';
      await recordEvent(runtimeVersion, {
        type: `client-${payload.type || 'unknown'}`,
        channel: payload.channel || '-',
        status: Number(payload.status) || 0,
        uid: payload.uid || null,
        releaseId: payload.releaseId || null,
        updateId: payload.updateId || null,
        message: payload.message ? String(payload.message).slice(0, 300) : undefined,
        platform: payload.platform || '-',
        // 止损信号：应急启动 = 坏包回退到内置包；内置启动 = 尚未接收过更新。
        ...(payload.isEmbeddedLaunch === undefined
          ? {}
          : { embedded: Boolean(payload.isEmbeddedLaunch) }),
        ...(payload.isEmergencyLaunch === undefined
          ? {}
          : { emergency: Boolean(payload.isEmergencyLaunch) }),
        // 坏包回退信号：客户端 watchdog 对比 pendingUpdateId 与实际 updateId 得出。
        ...(payload.fallback === undefined
          ? {}
          : { fallback: Boolean(payload.fallback) }),
        ...(payload.expectedUpdateId
          ? { expectedUpdateId: String(payload.expectedUpdateId).slice(0, 64) }
          : {}),
      });
      return send(res, {
        status: 202,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      });
    }

    if (url.pathname === '/api/manifest') {
      if (req.method !== 'GET') {
        return send(res, { status: 405, body: 'method not allowed' });
      }
      channel = resolveChannel(req.headers);
      const runtimeVersion = req.headers['expo-runtime-version'] || '';
      const response = await buildManifestResponse({
        runtimeVersion,
        platform: req.headers['expo-platform'] || '',
        headers: req.headers,
        channel,
      });
      recordEvent(runtimeVersion, {
        type: 'manifest',
        channel,
        status: response.status,
        ms: Date.now() - started,
        platform: req.headers['expo-platform'] || '-',
        uid: response.meta?.uid || null,
        served: response.meta?.served || null,
        releaseId: response.meta?.releaseId || null,
        updateId: response.meta?.updateId || null,
        percentage: response.meta?.percentage ?? null,
        bucket: response.meta?.bucket ?? null,
      });
      return send(res, response);
    }

    if (url.pathname === '/api/assets') {
      // HEAD 供客户端探测文件长度与 Accept-Ranges，再决定是否需要续传。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, { status: 405, body: 'method not allowed' });
      }
      const response = await serveAsset({
        runtimeVersion: url.searchParams.get('rv'),
        releaseId: url.searchParams.get('release'),
        file: url.searchParams.get('file'),
        acceptEncoding: req.headers['accept-encoding'] || '',
        headers: req.headers,
        method: req.method,
      });
      // 差分命中/回退单独成事件，不混进普通 asset 指标口径。
      if (response.patch) {
        recordEvent(url.searchParams.get('rv') || '', {
          type: 'asset-patch',
          channel: req.headers['expo-channel-name'] || (channel === '-' ? null : channel),
          status: response.status,
          platform: req.headers['expo-platform'] || null,
          releaseId: url.searchParams.get('release'),
          file: url.searchParams.get('file'),
          ...response.patch,
        });
        if (response.patch.hit) {
          console.log(
            `[ota] asset 差分命中: ${response.patch.platform} ${response.patch.patchSize}B ` +
              `-> 省 ${response.patch.savedBytes}B`,
          );
        }
      }
      if (response.status >= 400) {
        // 资产请求由 expo-updates 原生层发起，不带 expo-platform，无法归因到设备平台；
        // 显式写 null，聚合时归入「未标记」兜底分组而不是某种设备平台。
        recordEvent(url.searchParams.get('rv') || '', {
          type: 'asset',
          channel: channel === '-' ? null : channel,
          status: response.status,
          releaseId: url.searchParams.get('release'),
          file: url.searchParams.get('file'),
          platform: null,
        });
      }
      if (response.encoding) {
        console.log(
          `[ota] asset 压缩命中: ${response.encoding} ${url.searchParams.get('file')} -> ${response.headers['content-length']}B`,
        );
      }
      if (response.range) {
        console.log(
          `[ota] asset 断点续传: ${url.searchParams.get('file')} -> ` +
            `${response.range.start}-${response.range.end}/${response.range.size}`,
        );
      }
      return send(res, response, { head: req.method === 'HEAD' });
    }

    return send(res, { status: 404, body: 'not found' });
  } catch (error) {
    console.error('[ota] 请求处理失败:', error);
    return send(res, {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    });
  } finally {
    console.log(
      `[ota] ${req.method} ${url.pathname} [${channel}] -> ${res.statusCode} (${Date.now() - started}ms)`,
    );
  }
}

/**
 * 存储回收（GC）的进程内状态。
 * 定时器只在单写实例下有意义（与通道锁 / JSON 存储的前提一致）。
 */
const gcState = {
  enabled: false,
  mode: 'dry-run',
  lastRunAt: null,
  lastError: null,
};

/** 进程启动时间：控制台新功能报「未知操作」时，用它确认服务是不是旧进程。 */
const STARTED_AT = new Date().toISOString();

/** 遍历所有 runtimeVersion 跑一次规划；apply 模式下才真正删除。 */
async function runGcOnce() {
  const cfg = gcConfig();
  const versions = await runtimeVersions();
  let candidates = 0;
  let removed = 0;
  let bytes = 0;
  for (const runtimeVersion of versions) {
    try {
      const plan = await planGc(runtimeVersion, cfg);
      candidates += plan.candidates.length;
      if (cfg.mode !== 'apply' || plan.candidates.length === 0) continue;
      const result = await applyGc(runtimeVersion, plan, {
        operator: 'gc-scheduler',
        via: 'server',
      });
      removed += result.removed.length;
      bytes += result.reclaimedBytes;
      for (const item of result.failed) {
        console.error(`[ota] GC 删除失败: ${item.releaseId} -> ${item.error}`);
      }
    } catch (error) {
      gcState.lastError = `rv ${runtimeVersion}: ${error.message}`;
      console.error(`[ota] GC(rv ${runtimeVersion}) 失败:`, error.message);
    }
  }
  gcState.lastRunAt = new Date().toISOString();
  console.log(
    `[ota] GC(${cfg.mode}): 候选 ${candidates} 个，回收 ${removed} 个 / ${bytes}B`,
  );
  return { candidates, removed, bytes };
}

/** 定时 GC 默认关闭；开启后也默认 dry-run，便于先观察日志再接 apply。 */
function scheduleGc() {
  const cfg = gcConfig();
  gcState.enabled = cfg.enabled;
  gcState.mode = cfg.mode;
  if (!cfg.enabled) return;

  console.log(
    `[ota] 存储回收: 已启用（mode=${cfg.mode}，keep-days=${cfg.keepDays}，` +
      `keep-last=${cfg.keepLast}，间隔 ${Math.round(cfg.intervalMs / 60000)} 分钟）`,
  );
  const first = setTimeout(() => {
    runGcOnce().catch((error) => console.error('[ota] GC 失败:', error.message));
  }, cfg.initialDelayMs);
  const timer = setInterval(() => {
    runGcOnce().catch((error) => console.error('[ota] GC 失败:', error.message));
  }, cfg.intervalMs);
  // 不要因为定时器阻止进程退出（容器里 SIGTERM 后应尽快结束）。
  first.unref?.();
  timer.unref?.();
}

async function main() {
  assertServiceConfig();

  const keyPath = process.env.OTA_TLS_KEY;
  const certPath = process.env.OTA_TLS_CERT;
  let server;
  let secure = false;

  if (keyPath && certPath) {
    const [key, cert] = await Promise.all([
      fsp.readFile(path.resolve(keyPath)),
      fsp.readFile(path.resolve(certPath)),
    ]);
    server = https.createServer({ key, cert }, handle);
    secure = true;
  } else {
    server = http.createServer(handle);
  }

  server.listen(PORT, () => {
    const scheme = secure ? 'https' : 'http';
    console.log(`[ota] 服务已启动: ${scheme}://localhost:${PORT}`);
    console.log(`[ota] 环境: ${OTA_ENV} | 数据目录: ${UPDATES_DIR}`);
    console.log(`[ota] 资产 URL 前缀: ${PUBLIC_BASE_URL}`);
    console.log(`[ota] 看板: ${scheme}://localhost:${PORT}/dashboard`);
    console.log(
      `[ota] 事件上报限流: ${
        Number.isFinite(EVENTS_RATE_LIMIT) && EVENTS_RATE_LIMIT > 0
          ? `${EVENTS_RATE_LIMIT} 次/分钟/IP`
          : '已关闭'
      }`,
    );
    console.log(
      `[ota] 代码签名: ${process.env.OTA_PRIVATE_KEY_PATH ? '已配置私钥' : '未启用（设置 OTA_PRIVATE_KEY_PATH 开启）'}`,
    );
    console.log(
      `[ota] 管理写操作: ${ADMIN_ENABLED ? '已启用（需 OTA_ADMIN_TOKEN / OTA_ADMIN_TOKENS）' : '未启用（设置 OTA_ADMIN_TOKEN 开启）'}`,
    );
    const sl = stopLossConfig();
    console.log(
      `[ota] 止损哨兵: ${
        sl.enabled
          ? `已启用（mode=${sl.mode}${sl.mode === 'monitor' ? '，仅告警不自动动作' : '，超阈值自动止血'}）`
          : '未启用（设置 OTA_STOP_LOSS_ENABLED=true 开启，默认 monitor）'
      }`,
    );
    console.log(
      '[ota] manifest: /api/manifest | assets: /api/assets | channels: /api/channels | metrics: /api/metrics | events: POST /api/events',
    );
    scheduleGc();
  });
}

// 仅当作为入口脚本执行时监听端口；被测试 import 时只导出 handle，不启动服务。
const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[ota] 启动失败: ${error.message}`);
    process.exitCode = 1;
  });
}
