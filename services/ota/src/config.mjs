import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib.mjs';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(srcDir, '..');
export const PORT = Number(process.env.PORT || 3000);

/**
 * 运行环境：development（本机/内网调试）| production（对外提供服务）。
 * production 会启用启动自检，缺配置直接拒绝启动，避免把 localhost 打进线上 manifest。
 */
export const OTA_ENV = String(process.env.OTA_ENV || 'development').toLowerCase();
export const IS_PRODUCTION = OTA_ENV === 'production';

/**
 * 数据目录：默认 services/ota/updates。
 * 上云后通常挂载独立卷，或用 OTA_DATA_DIR 指向容器外目录；
 * 相对路径按 ROOT 解析，绝对路径原样使用。
 */
export const UPDATES_DIR = path.resolve(ROOT, process.env.OTA_DATA_DIR || 'updates');

// manifest 中的 asset URL 前缀。真机/生产必须设置为 HTTPS 域名；
// Android 模拟器访问宿主机时通常设为 http://10.0.2.2:3000。
export const PUBLIC_BASE_URL =
  process.env.OTA_PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 看板写操作令牌：未配置时 /api/admin/actions 一律返回 403，页面按钮禁用。
export const ADMIN_TOKEN = process.env.OTA_ADMIN_TOKEN || '';

/**
 * 多令牌（可选）：OTA_ADMIN_TOKENS="alice:tok1,bob:tok2"
 * 冒号前是操作人标签，用于审计；未配置时退回单令牌（标签 admin）。
 *
 * 可选权限位（第三段，多个用 + 分隔）：OTA_ADMIN_TOKENS="oncall:tok3:stop-loss"
 * 未写第三段 = 全量权限（向后兼容）。已定义 scope：
 *   - release：发布 / 提升 / 回滚 / 重发
 *   - rollout：调整灰度与白名单
 *   - stop-loss：紧急止血 / 恢复暂停前灰度
 *   - gc：回收旧 release（不可恢复，与发布权限分开）
 * 只读评估（evaluate-stop-loss）不需要 scope。
 */
export const ADMIN_SCOPES = ['release', 'rollout', 'stop-loss', 'gc'];

/** 解析 scope 段：返回 { scopes } 或 null（null 表示这一段不是合法的 scope）。 */
function splitScopeSegment(segment) {
  const list = String(segment || '')
    .split('+')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return null;
  if (list.includes('*')) return { scopes: null };
  if (list.every((scope) => ADMIN_SCOPES.includes(scope))) return { scopes: list };
  return null;
}

function parseAdminTokens(raw) {
  const map = new Map();
  for (const item of String(raw || '').split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    let label = 'admin';
    let token = '';
    let scopes = null;
    if (parts.length === 1) {
      token = parts[0].trim();
    } else {
      // 优先尝试「label:token:scopes」；第三段不是合法 scope 时回退旧格式，
      // 保证历史令牌（token 里偶发带冒号）不被误解析。
      const scopeInfo = parts.length >= 3 ? splitScopeSegment(parts[parts.length - 1]) : null;
      if (scopeInfo) {
        scopes = scopeInfo.scopes;
        token = parts[parts.length - 2].trim();
        label = parts.slice(0, parts.length - 2).join(':').trim();
      } else {
        const index = trimmed.lastIndexOf(':');
        label = trimmed.slice(0, index).trim();
        token = trimmed.slice(index + 1).trim();
      }
    }
    if (token) map.set(token, { label: label || 'admin', scopes });
  }
  if (ADMIN_TOKEN && !map.has(ADMIN_TOKEN)) map.set(ADMIN_TOKEN, { label: 'admin', scopes: null });
  return map;
}

export const ADMIN_TOKENS = parseAdminTokens(process.env.OTA_ADMIN_TOKENS);
export const ADMIN_ENABLED = ADMIN_TOKENS.size > 0;

/** 某 admin 是否具备 scope；scopes=null 表示全量权限。 */
export function hasScope(admin, scope) {
  if (!admin) return false;
  if (!admin.scopes) return true;
  return admin.scopes.includes(scope);
}

// CLI / CI 发布时的操作人标签：npm run ota:publish -- 生成审计用。
export const CLI_OPERATOR = process.env.OTA_OPERATOR || 'cli';

/**
 * 止损（crash-aware stop-loss）配置：按需读取而非模块加载时固化，
 * 便于测试覆盖与线上热调整。默认关闭，启用后由 manifest 惰性评估触发。
 */
function envNumber(name, fallback, { min = 0, strict = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (strict ? value <= min : value < min) return fallback;
  return value;
}

/**
 * 止损运行时覆盖（控制台「设置」写入）：UPDATES_DIR/system/stop-loss.json。
 * 优先级：运行时文件 > 环境变量 > 默认值；删除文件即回落到环境变量。
 * 只覆盖可变项（minSamples / webhook），enabled / mode / 阈值仍由环境变量决定。
 */
const STOP_LOSS_OVERRIDE_FILE = path.join(UPDATES_DIR, 'system', 'stop-loss.json');
let stopLossOverrideCache = { mtimeMs: -1, value: null };

export function stopLossOverrideFile() {
  return STOP_LOSS_OVERRIDE_FILE;
}

export function clearStopLossOverrideCache() {
  stopLossOverrideCache = { mtimeMs: -1, value: null };
}

/** 同步读取覆盖（按 mtime 缓存，避免 manifest 热路径反复读盘）。 */
export function readStopLossOverride() {
  try {
    const stat = fs.statSync(STOP_LOSS_OVERRIDE_FILE);
    if (stopLossOverrideCache.mtimeMs === stat.mtimeMs) return stopLossOverrideCache.value;
    const parsed = JSON.parse(fs.readFileSync(STOP_LOSS_OVERRIDE_FILE, 'utf8'));
    const value = {
      minSamples: Number.isInteger(Number(parsed.minSamples))
        ? Number(parsed.minSamples)
        : undefined,
      webhook: typeof parsed.webhook === 'string' ? parsed.webhook : undefined,
      updatedAt: parsed.updatedAt || null,
      operator: parsed.operator || null,
    };
    stopLossOverrideCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    stopLossOverrideCache = { mtimeMs: -1, value: null };
    return null;
  }
}

function normalizeMinSamples(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100000) {
    throw new Error('MIN_SAMPLES 必须是 1-100000 的整数');
  }
  return value;
}

function normalizeWebhook(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > 2048) throw new Error('Webhook 地址过长');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Webhook 必须是合法的 http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook 只支持 http(s)');
  }
  return value;
}

/** Webhook 脱敏：只返回 origin，避免把带 token 的完整地址暴露给公开看板。 */
export function webhookOrigin(webhook) {
  try {
    const url = new URL(String(webhook || ''));
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/** 写入运行时覆盖。webhook 传 undefined = 保持不变；传 '' = 清除（覆盖 env）。 */
export async function writeStopLossOverride(patch, { operator = 'unknown' } = {}) {
  const current = readStopLossOverride() || {};
  const next = {
    ...current,
    ...(patch.minSamples === undefined
      ? {}
      : { minSamples: normalizeMinSamples(patch.minSamples) }),
    ...(patch.webhook === undefined ? {} : { webhook: normalizeWebhook(patch.webhook) }),
    updatedAt: new Date().toISOString(),
    operator,
  };
  if (next.minSamples === undefined) delete next.minSamples;
  if (next.webhook === undefined) delete next.webhook;
  await writeJsonAtomic(STOP_LOSS_OVERRIDE_FILE, next);
  clearStopLossOverrideCache();
  return next;
}

export function stopLossConfig() {
  const override = readStopLossOverride() || {};
  // 默认 monitor：开启哨兵时先只告警、不自动改生产；要自动止血需显式设 halt。
  // 非法值同样回落到 monitor，避免拼错后意外变成自动动作。
  const mode = String(process.env.OTA_STOP_LOSS_MODE || 'monitor').toLowerCase();
  const cooldownMs = envNumber('OTA_STOP_LOSS_COOLDOWN_MS', 60 * 60 * 1000, { min: 0 });
  return {
    enabled: String(process.env.OTA_STOP_LOSS_ENABLED || '').toLowerCase() === 'true',
    mode: ['monitor', 'halt', 'rollback'].includes(mode) ? mode : 'monitor',
    // min=0 + strict：允许 1（测试/小车队），拒绝 0 及负数。
    minSamples:
      override.minSamples !== undefined
        ? override.minSamples
        : envNumber('OTA_STOP_LOSS_MIN_SAMPLES', 20, { min: 0, strict: true }),
    emergencyRate: envNumber('OTA_STOP_LOSS_EMERGENCY_RATE', 0.08),
    installFailRate: envNumber('OTA_STOP_LOSS_INSTALL_FAIL_RATE', 0.15),
    windowMs: envNumber('OTA_STOP_LOSS_WINDOW_MS', 30 * 60 * 1000, { min: 1, strict: true }),
    cooldownMs,
    // 同一 releaseId + 失败类型的告警冷却，避免 monitor 模式每 5 分钟刷屏。
    alertCooldownMs: envNumber('OTA_STOP_LOSS_ALERT_COOLDOWN_MS', 15 * 60 * 1000, { min: 0 }),
    cacheMs: envNumber('OTA_STOP_LOSS_CACHE_MS', 5 * 60 * 1000, { min: 0 }),
    webhook:
      override.webhook !== undefined
        ? override.webhook
        : process.env.OTA_STOP_LOSS_WEBHOOK || '',
    overridden: {
      minSamples: override.minSamples !== undefined,
      webhook: override.webhook !== undefined,
    },
  };
}

/**
 * 存储回收（GC）配置：默认关闭，且默认只做 dry-run。
 * 与止损哨兵一样按需读取，避免模块加载时固化，便于测试覆盖。
 * 回收不可恢复，因此线上开启时建议先观察一段 dry-run 日志再切 apply。
 */
export function gcConfig() {
  const mode = String(process.env.OTA_GC_MODE || 'dry-run').toLowerCase();
  return {
    enabled: String(process.env.OTA_GC_ENABLED || '').toLowerCase() === 'true',
    mode: mode === 'apply' ? 'apply' : 'dry-run',
    intervalMs: envNumber('OTA_GC_INTERVAL_MS', 6 * 60 * 60 * 1000, { min: 60_000, strict: true }),
    initialDelayMs: envNumber('OTA_GC_INITIAL_DELAY_MS', 5 * 60 * 1000, { min: 0 }),
    keepDays: envNumber('OTA_GC_KEEP_DAYS', 14, { min: 0 }),
    // min=0 + strict：允许 1，拒绝 0（否则可能连最新版本一起回收）。
    keepLast: envNumber('OTA_GC_KEEP_LAST', 10, { min: 0, strict: true }),
  };
}

// P3 代码签名：配置私钥后客户端可开启 expo-expect-signature 校验。
export const PRIVATE_KEY_PATH = process.env.OTA_PRIVATE_KEY_PATH || '';
export const KEY_ID = process.env.OTA_KEY_ID || 'main';
export const SIGNING_ALG = 'rsa-v1_5-sha256';

/** 本机 / 内网 / 模拟器回环地址：对真机不可达，production 一律拒绝。 */
const LOCAL_HOST_PATTERN =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|10\.0\.2\.2|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/i;

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 客户端构建期已有 profile 防呆，这里补齐服务端侧，两侧对称。 */
export function assertServiceConfig() {
  const problems = [];

  if (IS_PRODUCTION) {
    let parsed = null;
    try {
      parsed = new URL(PUBLIC_BASE_URL);
    } catch {
      problems.push(`OTA_PUBLIC_BASE_URL 不是合法 URL：${PUBLIC_BASE_URL}`);
    }
    if (parsed) {
      if (parsed.protocol !== 'https:') {
        problems.push(`production 的 OTA_PUBLIC_BASE_URL 必须是 HTTPS，当前为 ${parsed.protocol}`);
      }
      if (LOCAL_HOST_PATTERN.test(parsed.hostname)) {
        problems.push(
          `production 的 OTA_PUBLIC_BASE_URL 不能是 localhost/内网地址，当前为 ${parsed.hostname}`,
        );
      }
    }

    if (!PRIVATE_KEY_PATH) {
      problems.push('production 必须配置 OTA_PRIVATE_KEY_PATH（客户端已强制验签）');
    } else if (!fs.existsSync(path.resolve(PRIVATE_KEY_PATH))) {
      problems.push(`签名私钥不存在：${path.resolve(PRIVATE_KEY_PATH)}`);
    }

    if (!ADMIN_ENABLED) {
      problems.push('production 必须配置 OTA_ADMIN_TOKEN 或 OTA_ADMIN_TOKENS（否则无法发布/回滚）');
    }
  }

  if (problems.length > 0) {
    throw new Error(
      ['启动配置校验失败：', ...problems.map((item) => `  - ${item}`)].join('\n'),
    );
  }

  if (!IS_PRODUCTION) {
    const host = hostnameOf(PUBLIC_BASE_URL);
    if (LOCAL_HOST_PATTERN.test(host)) {
      console.warn(
        `[ota] 提示：OTA_PUBLIC_BASE_URL=${PUBLIC_BASE_URL} 指向本机/内网，` +
          '仅模拟器可用；真机需改用局域网 IP，上线需 HTTPS 域名（并设置 OTA_ENV=production 做自检）',
      );
    }
  }
}
