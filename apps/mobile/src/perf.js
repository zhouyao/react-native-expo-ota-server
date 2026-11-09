import { reportMetric } from './logger';

const moduleStart = Date.now();
// 超过 5 分钟一定不是有效启动耗时（时钟基准不一致）。
const MAX_REASONABLE_MS = 5 * 60 * 1000;
let startupReported = false;

/**
 * RN 在 bundle 开始执行时写入 global.__BUNDLE_START_TIME__。
 * 不同 RN / Hermes 版本里它的时钟基准不一样：
 * - 部分版本是 Date.now()；
 * - 新版更像 performance.now()（进程启动以来的毫秒数）。
 * 两种情况分别校验，取第一个落在合理区间的结果；都不满足则退回模块加载时刻。
 */
function elapsedSinceBundleStart() {
  const injected = Number(global.__BUNDLE_START_TIME__);
  if (!Number.isFinite(injected) || injected <= 0) return null;

  const perfNow =
    global.performance && typeof global.performance.now === 'function'
      ? global.performance.now()
      : null;

  // 情况 1：与 performance.now() 同基准。
  if (perfNow !== null) {
    const delta = perfNow - injected;
    if (delta >= 0 && delta <= MAX_REASONABLE_MS) return delta;
  }

  // 情况 2：与 Date.now() 同基准。
  const delta = Date.now() - injected;
  if (delta >= 0 && delta <= MAX_REASONABLE_MS) return delta;

  return null;
}

export function sinceBundleStart() {
  const measured = elapsedSinceBundleStart();
  if (measured !== null) return Math.round(measured);
  return Math.round(Math.max(0, Date.now() - moduleStart));
}

/**
 * 首屏渲染后上报一次启动耗时。
 * 只报一次，冷启动/热重载都不会重复。
 */
export async function reportStartupOnce(extra = {}) {
  if (startupReported) return false;
  startupReported = true;
  return reportMetric('startup', sinceBundleStart(), extra);
}
