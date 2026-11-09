import { logger, reportError } from './logger';

let installed = false;

function normalizeReason(reason) {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  try {
    return new Error(JSON.stringify(reason));
  } catch {
    return new Error('未知的 Promise 拒绝');
  }
}

/**
 * 安装全局异常捕获（必须在 App 模块加载前调用）：
 * - JS 未捕获异常：ErrorUtils.setGlobalHandler，保留原 handler 以免丢失 RN 红屏；
 * - Promise 未处理拒绝：复用 RN 内置的 rejection-tracking。
 * 两者都会走 logger 上报，服务端落盘为 client-error。
 */
export function installErrorHandler() {
  if (installed) return;
  installed = true;

  const errorUtils = global.ErrorUtils;
  if (errorUtils && typeof errorUtils.setGlobalHandler === 'function') {
    const previous =
      typeof errorUtils.getGlobalHandler === 'function'
        ? errorUtils.getGlobalHandler()
        : null;
    errorUtils.setGlobalHandler((error, isFatal) => {
      void reportError(error, { source: 'global', isFatal: Boolean(isFatal) });
      if (typeof previous === 'function') previous(error, isFatal);
    });
  } else {
    logger.warn('ErrorUtils 不可用，跳过全局 JS 异常捕获');
  }

  try {
    // RN 内置 polyfill，使用 CommonJS 引入以避免额外依赖。
    const tracking = require('promise/setimmediate/rejection-tracking');
    tracking.enable({
      allRejections: true,
      onUnhandled: (id, reason) => {
        void reportError(normalizeReason(reason), {
          source: 'unhandled-rejection',
          rejectionId: id,
        });
      },
      onHandled: () => {},
    });
  } catch {
    logger.debug('未启用 unhandledRejection 跟踪');
  }

  logger.info('全局异常捕获已安装');
}
