import fs from 'node:fs';

const TEMPLATE_URL = new URL('./dashboard.html', import.meta.url);

/**
 * 看板骨架 + 首屏 state。
 * 内容渲染与交互都在 dashboard-client.js，HTML 骨架单独放在 dashboard.html。
 *
 * 模板每次请求读盘：改 HTML / CSS 后刷新页面即可生效，与 /dashboard.js 的处理一致，
 * 不再需要重启服务进程（修改本文件的 JS 逻辑仍需重启）。
 */
export function renderDashboardHtml(state) {
  // 内嵌 JSON 必须转义 '<'，否则版本号/uid 里出现 </script 会截断文档。
  const boot = JSON.stringify(state).replace(/</g, '\\u003c');
  // 用函数形式替换，避免 boot 里的 $& / $1 被当成替换模式解释。
  return fs
    .readFileSync(TEMPLATE_URL, 'utf8')
    .replace('__OTA_DASHBOARD_BOOT__', () => boot);
}
