import { currentUid, resolveOrigin, runtimeInfo } from './runtime-info';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BUFFER = 200;
const MAX_REPORTS = 20;
const REPORT_WINDOW = 60 * 1000;

const buffer = [];
const reportedAt = new Map();
let reportCount = 0;
let minLevel = __DEV__ ? LEVELS.debug : LEVELS.info;

// 脱敏规则：凭据类键名、Bearer、JWT、长 token、邮箱、手机号。
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|session|credential|api[-_]?key/i;
const BEARER = /(bearer\s+)[\w.~+/=-]{8,}/gi;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const LONG_TOKEN = /\b[A-Za-z0-9+/=_-]{40,}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const CN_PHONE = /\b1[3-9]\d{9}\b/g;

const MAX_STRING = 500;
const MAX_DEPTH = 4;

export function redactString(input) {
  let text = String(input);
  if (text.length > MAX_STRING) text = `${text.slice(0, MAX_STRING)}…`;
  return text
    .replace(BEARER, '$1[REDACTED]')
    .replace(JWT, '[JWT]')
    .replace(LONG_TOKEN, '[REDACTED]')
    .replace(EMAIL, '[EMAIL]')
    .replace(CN_PHONE, '[PHONE]');
}

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[DEPTH]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redact(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1);
  }
  return output;
}

function emit(level, message, context) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    at: new Date().toISOString(),
    level,
    message: redactString(String(message)),
    ...(context === undefined ? {} : { context: redact(context) }),
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const printer = level === 'debug' ? console.log : console[level] || console.log;
  if (entry.context === undefined) printer(`[${level}] ${entry.message}`);
  else printer(`[${level}] ${entry.message}`, entry.context);
}

export const logger = {
  debug: (message, context) => emit('debug', message, context),
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context),
  setLevel(level) {
    if (LEVELS[level]) minLevel = LEVELS[level];
  },
  getEntries: () => buffer.slice(),
  /** 导出为纯文本，便于用户复制反馈。 */
  exportText: () =>
    buffer
      .map((entry) => {
        const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
        return `${entry.at} [${entry.level}] ${entry.message}${ctx}`;
      })
      .join('\n'),
};

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 记录并上报错误到 OTA 服务端的 /api/events（服务端落盘为 client-error）。
 * - 内置包 / 开发模式下没有服务地址，只写本地日志；
 * - 同一错误 60 秒内只上报一次，整个进程最多 20 条，避免崩溃循环刷屏。
 */
export async function reportError(error, context = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  const name = err.name || 'Error';
  const message = err.message || '未知错误';

  emit('error', `${name}: ${message}`, {
    ...context,
    stack: truncate(err.stack, 800),
  });

  const origin = resolveOrigin();
  if (!origin) return false;

  const key = `${name}:${message}`.slice(0, 120);
  const now = Date.now();
  const last = reportedAt.get(key);
  if (last && now - last < REPORT_WINDOW) return false;
  if (reportCount >= MAX_REPORTS) return false;
  reportedAt.set(key, now);
  reportCount += 1;

  try {
    const [uid, info] = await Promise.all([currentUid(), Promise.resolve(runtimeInfo())]);
    const summary = `${name}: ${message} | ${context.source || 'js'} | ${truncate(err.stack, 160)}`;
    const response = await fetch(`${origin}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        status: 500,
        message: summary.slice(0, 300),
        uid,
        ...info,
      }),
    });
    return response.ok;
  } catch {
    // 上报是旁路，失败不影响业务
    return false;
  }
}

/**
 * 上报轻量指标（type: metric → 服务端落盘 client-metric）。
 * 用于启动耗时这类没有错误语义、但需要观测的数据。
 */
export async function reportMetric(name, value, context = {}) {
  emit('info', `metric ${name}=${value}ms`, context);

  const origin = resolveOrigin();
  if (!origin) return false;

  try {
    const [uid, info] = await Promise.all([currentUid(), Promise.resolve(runtimeInfo())]);
    const response = await fetch(`${origin}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'metric',
        status: 200,
        message: `${name}=${value}ms`,
        uid,
        ...info,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
