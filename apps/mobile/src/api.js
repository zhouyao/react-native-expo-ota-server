import { logger } from './logger';
import { resolveOrigin } from './runtime-info';

const DEFAULT_TIMEOUT = 10_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RECENT_REQUESTS = 5;

// 最近请求（内存环形缓冲），供调试面板展示，不落盘。
const recentRequests = [];

function shortPath(url) {
  try {
    const parsed = new URL(url);
    const query = parsed.search ? parsed.search.slice(1, 40) : '';
    return `${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return String(url).slice(0, 60);
  }
}

function remember({ method, url, status, ms, requestId, error }) {
  recentRequests.unshift({
    at: Date.now(),
    method,
    path: shortPath(url),
    status,
    ms,
    requestId,
    error: error || null,
  });
  if (recentRequests.length > MAX_RECENT_REQUESTS) recentRequests.pop();
}

/** 调试面板用：最近 5 次请求（新 → 旧）。 */
export function getRecentRequests() {
  return recentRequests.slice();
}

/** 统一错误对象：区分网络 / 超时 / HTTP 状态，便于上层分支处理。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network', payload = null, url = '', requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.url = url;
    this.requestId = requestId;
  }
}

function newRequestId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickMessage(data, fallback) {
  if (data && typeof data === 'object') {
    return data.error || data.message || fallback;
  }
  return fallback;
}

async function once(url, { method, payload, headers, timeout, requestId, signal }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: payload,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseJson(text);
    const elapsed = Date.now() - started;

    if (!response.ok) {
      const error = new ApiError(pickMessage(data, `HTTP ${response.status}`), {
        status: response.status,
        code: 'http',
        payload: data,
        url,
        requestId,
      });
      error.elapsed = elapsed;
      remember({
        method,
        url,
        status: response.status,
        ms: elapsed,
        requestId,
        error: error.message,
      });
      throw error;
    }

    logger.debug(`API ${method} ${url} -> ${response.status} (${elapsed}ms)`, { requestId });
    remember({ method, url, status: response.status, ms: elapsed, requestId });
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code !== 'http') {
        remember({
          method,
          url,
          status: 0,
          ms: Date.now() - started,
          requestId,
          error: error.message,
        });
      }
      throw error;
    }
    const aborted = error?.name === 'AbortError';
    throw new ApiError(
      aborted ? (timedOut ? '请求超时' : '请求已取消') : '网络异常',
      {
        status: 0,
        code: aborted ? (timedOut ? 'timeout' : 'aborted') : 'network',
        url,
        requestId,
      },
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 统一请求入口：
 * - 相对路径自动拼服务地址（来自 manifest 的 launchAsset）；
 * - 默认 10s 超时；GET 默认失败重试 1 次（网络错误 / 5xx / 429）；
 * - 失败统一抛 ApiError，并写入 logger（error 级）。
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    timeout = DEFAULT_TIMEOUT,
    retries,
    signal,
  } = options;

  const attempts = retries === undefined ? (method === 'GET' ? 1 : 0) : retries;
  const origin = options.baseUrl || resolveOrigin();
  const absolute = /^https?:\/\//i.test(path);
  const url = absolute ? path : origin ? `${origin}${path}` : null;

  if (!url) {
    const error = new ApiError('服务地址未知（内置包尚未收到更新清单）', { code: 'no-origin' });
    logger.warn(error.message);
    throw error;
  }

  const payload =
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const requestId = newRequestId();

  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return await once(url, { method, payload, headers, timeout, requestId, signal });
    } catch (error) {
      lastError = error;
      const retryable =
        error.code === 'network' ||
        error.code === 'timeout' ||
        RETRYABLE_STATUS.has(error.status);
      if (attempt === attempts || !retryable) break;
      logger.warn(`API 重试 ${attempt + 1}/${attempts}：${error.message}`, { url, requestId });
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }

  logger.error(`API ${method} ${url} 失败：${lastError.message}`, {
    requestId,
    status: lastError.status,
    code: lastError.code,
  });
  throw lastError;
}

export const getJson = (path, options = {}) => request(path, { ...options, method: 'GET' });
export const postJson = (path, body, options = {}) =>
  request(path, { ...options, method: 'POST', body });
