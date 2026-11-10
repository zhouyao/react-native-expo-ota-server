import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

/**
 * OTA 服务地址与端口。
 *
 * 构建期地址来自 EXPO_PUBLIC_OTA_URL（Metro 会内联进 bundle），反映打进包里的
 * updates.url；实际连接地址优先用 manifest 的 launchAsset.url ——它由服务端按
 * 真机可达的 OTA_PUBLIC_BASE_URL 生成，比包内配置更贴近"现在连的是谁"。
 * 内置包 / 开发模式没有 manifest 时，回退到构建期配置。
 */
function parse(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      origin: url.origin,
      url: value,
    };
  } catch {
    return null;
  }
}

export function serverConfig() {
  const build = parse(
    process.env.EXPO_PUBLIC_OTA_URL || Constants.expoConfig?.updates?.url || null,
  );
  const runtime = parse(Updates.manifest?.launchAsset?.url || null);
  const active = runtime || build;

  return {
    build,
    runtime,
    active,
    endpoint: active ? `${active.host}:${active.port}` : '未配置',
    requestUrl: active ? `${active.origin}/api/manifest` : null,
    source: runtime ? '已下载更新（服务端下发）' : build ? '构建期配置' : '未配置',
    mismatched: Boolean(build && runtime && build.origin !== runtime.origin),
  };
}
