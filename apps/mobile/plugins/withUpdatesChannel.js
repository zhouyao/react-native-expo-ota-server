const {
  withExpoPlist,
  withAndroidManifest,
  AndroidConfig,
} = require('@expo/config-plugins');

/**
 * 把 updates.channel 写进原生配置（EAS Build 会自动注入，本地 prebuild 不会）：
 * - iOS: Expo.plist -> EXUpdatesChannel + EXUpdatesRequestHeaders['expo-channel-name']
 * - Android: AndroidManifest meta-data -> UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY（JSON）
 *
 * 通道是构建期常量，改它必须重新 prebuild + 打包。
 *
 * Android 只认请求头 JSON 里的 expo-channel-name（expo-updates 58 的
 * IUpdatesController.kt 用 requestHeaders["expo-channel-name"] 作为 channel），
 * 不存在单独的 UPDATES_CONFIGURATION_CHANNEL 字段，所以这里只写 request headers。
 *
 * 另外：http:// 的 OTA 地址在 Android release 包里会被网络安全策略拦截
 * （targetSdk >= 28 默认禁止明文），只有地址是明文时才放开 usesCleartextTraffic，
 * HTTPS 生产包不会带上这个开关。
 */
module.exports = function withUpdatesChannel(config) {
  const channel = config.updates?.channel;
  if (!channel) return config;

  const otaUrl = config.updates?.url || '';
  const allowCleartext = /^http:\/\//i.test(otaUrl);

  // EAS 的实现是写进 EXUpdatesRequestHeaders 的 expo-channel-name；
  // 同时保留 EXUpdatesChannel 以兼容按字段读取的版本。
  config = withExpoPlist(config, (cfg) => {
    cfg.modResults.EXUpdatesChannel = channel;
    cfg.modResults.EXUpdatesRequestHeaders = {
      ...(cfg.modResults.EXUpdatesRequestHeaders || {}),
      'expo-channel-name': channel,
    };
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      cfg.modResults,
    );
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY',
      JSON.stringify({ 'expo-channel-name': channel }),
      'value',
    );
    if (allowCleartext) {
      application.$['android:usesCleartextTraffic'] = 'true';
    } else {
      delete application.$['android:usesCleartextTraffic'];
    }
    return cfg;
  });

  return config;
};
