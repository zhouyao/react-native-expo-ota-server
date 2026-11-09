import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_STALE = 60_000;
const IDEMPOTENCY_TTL = 60_000;

// 进程内按 key 串行：同一通道的写操作排队，避免自竞争。
const queues = new Map();

// 幂等缓存：requestId / 参数指纹 → 结果，60 秒窗口。
const recent = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function inProcess(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  // 前一个任务失败也要继续执行后续任务，因此 onFulfilled / onRejected 都用 fn。
  const run = prev.then(() => fn());
  queues.set(key, run.catch(() => {}));
  return run;
}

async function readLockOwner(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** lock 文件陈旧判定：超时且持有进程已消失；无法解析时视为陈旧。 */
async function isStale(file, staleMs) {
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs < staleMs) return false;
    const owner = await readLockOwner(file);
    const pid = Number(owner?.pid);
    if (!pid) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  } catch {
    return true;
  }
}

async function acquireFileLock(file, { timeout, staleMs }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const handle = await fsp.open(file, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'utf8',
      );
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await isStale(file, staleMs)) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`发布锁被占用，请稍后重试（${path.basename(file)}）`);
      }
      await sleep(50 + Math.random() * 50);
    }
  }
}

/**
 * 双层互斥：进程内队列 + 跨进程 lock 文件。
 * 只应包住「操作级」逻辑，不要包底层 writeChannel（会自锁）。
 */
export async function withLock(key, lockFile, fn, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, staleMs = DEFAULT_STALE } = options;
  return inProcess(key, async () => {
    await acquireFileLock(lockFile, { timeout, staleMs });
    try {
      return await fn();
    } finally {
      await fsp.rm(lockFile, { force: true }).catch(() => {});
    }
  });
}

function prune(now = Date.now()) {
  for (const [key, entry] of recent) {
    if (now - entry.at > IDEMPOTENCY_TTL) recent.delete(key);
  }
}

export function fingerprintRequest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

/** 命中 60 秒内的相同请求时返回上次结果，调用方不应重复执行。 */
export function recallRequest(id) {
  if (!id) return null;
  prune();
  const entry = recent.get(id);
  return entry ? entry.result : null;
}

export function rememberRequest(id, result) {
  if (!id) return;
  prune();
  recent.set(id, { at: Date.now(), result });
}

export function resetIdempotency() {
  recent.clear();
}
