import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * 导出 bundle 时注入的构建期常量。
 *
 * 客户端用 `process.env.EXPO_PUBLIC_*` 读它们，Metro 在 transform 阶段就地内联：
 * - `EXPO_PUBLIC_CHANNEL`：页面上的「构建通道」；
 * - `EXPO_PUBLIC_OTA_URL`：切换调试通道时提交的 updates.url。必须是「与打 APK/IPA 时
 *   同一个 origin」，因为 expo-updates 的 scopeKey 默认取 updateUrl 的 origin ——
 *   换 origin 等于换 scope，已下载包和 uid（按 scope 存在本地）全部对不上。
 *
 * 默认值取自 app.config.js 解析结果，所以只要 APK/IPA 与 OTA 用同一套环境变量，
 * 两边就会得到同一个 URL。
 *
 * 注意：必须配合 `expo export --clear`，Metro 的 transform 缓存按文件内容命中，
 * 不感知 env 变化，不清缓存会把上一次（没注入）的产物原样复用。
 */
export function exportEnv(mobileDir) {
  const requireAppConfig = createRequire(import.meta.url);
  const { expo } = requireAppConfig(path.join(mobileDir, 'app.config.js'));
  return {
    ...process.env,
    EXPO_PUBLIC_CHANNEL: process.env.EXPO_PUBLIC_CHANNEL || expo.updates.channel,
    EXPO_PUBLIC_OTA_URL: process.env.EXPO_PUBLIC_OTA_URL || expo.updates.url,
  };
}
