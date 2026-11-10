/**
 * 环境配置固化：EXPO_PUBLIC_APP_ENV 决定默认通道、OTA 地址与调试开关。
 * 显式的 EXPO_PUBLIC_CHANNEL / EXPO_PUBLIC_OTA_URL 仍然优先（用于临时验证）。
 *
 * 生产 protection（会直接让构建失败，避免 localhost 打进线上包）：
 * - production 必须 HTTPS、只能绑 production 通道、必须关闭通道切换；
 * - staging 必须 HTTPS。
 */
const PROFILES = {
  development: {
    channel: 'development',
    otaUrl: 'http://localhost:3000/api/manifest',
    channelSwitch: true,
  },
  staging: {
    channel: 'beta',
    otaUrl: 'https://ota-staging.example.com/api/manifest',
    channelSwitch: true,
  },
  production: {
    channel: 'production',
    otaUrl: 'https://ota.example.com/api/manifest',
    channelSwitch: false,
  },
};

const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || 'development';
const PROFILE = PROFILES[APP_ENV];
if (!PROFILE) {
  throw new Error(
    `未知的 EXPO_PUBLIC_APP_ENV=${APP_ENV}，可选：${Object.keys(PROFILES).join(' / ')}`,
  );
}

const OTA_URL = process.env.EXPO_PUBLIC_OTA_URL || PROFILE.otaUrl;
const CHANNEL = process.env.EXPO_PUBLIC_CHANNEL || PROFILE.channel;
const APPLE_TEAM_ID = process.env.EXPO_APPLE_TEAM_ID || '';
// 显式关闭优先；否则跟随 profile。
const CHANNEL_SWITCH_ENABLED =
  process.env.EXPO_PUBLIC_ENABLE_CHANNEL_SWITCH === 'false'
    ? false
    : process.env.EXPO_PUBLIC_ENABLE_CHANNEL_SWITCH === 'true'
      ? true
      : PROFILE.channelSwitch;

function assertProfile() {
  const isHttps = /^https:\/\//i.test(OTA_URL);
  const isLocal = /localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.|172\.(1[6-9]|2\d|3[01])\./i.test(
    OTA_URL,
  );

  if (APP_ENV === 'production') {
    if (!isHttps) throw new Error('production 的 updates.url 必须是 HTTPS');
    if (isLocal) throw new Error('production 的 updates.url 不能是内网或 localhost');
    if (CHANNEL !== 'production') {
      throw new Error(`production 只能绑定 production 通道，当前为 ${CHANNEL}`);
    }
    if (CHANNEL_SWITCH_ENABLED) {
      throw new Error('production 必须关闭通道切换与防砖开关');
    }
  }
  if (APP_ENV === 'staging' && !isHttps && !isLocal) {
    throw new Error('staging 的 updates.url 必须是 HTTPS');
  }
}

assertProfile();

module.exports = {
  expo: {
    name: 'HotUpdate Demo',
    slug: 'hotupdate-demo',
    version: '1.0.0',
    orientation: 'portrait',
    // 原生兼容层：改原生代码/依赖必须提升该值并重新发版。
    runtimeVersion: '1',
    plugins: ['./plugins/withUpdatesChannel'],
    updates: {
      enabled: true,
      url: OTA_URL,
      // 通道层：构建时绑定，运行期不可改；灰度由服务端 rollout 百分比控制。
      channel: CHANNEL,
      // 双端原生读的都是请求头里的 expo-channel-name（Android 见 IUpdatesController.kt，
      // iOS 见 EXUpdatesRequestHeaders）。这里显式写入，避免本地 prebuild 依赖插件执行顺序。
      requestHeaders: {
        'expo-channel-name': CHANNEL,
      },
      // 安全层：客户端强制校验 manifest 签名（证书随包内置）。
      codeSigningCertificate: './certs/certificate.pem',
      codeSigningMetadata: {
        keyid: 'main',
        alg: 'rsa-v1_5-sha256',
      },
      // SDK 55+ 默认开启 bsdiff 补丁；显式声明避免后续升级时被误关。
      // 服务端实现 A-IM 协商后，客户端只下载差异部分并本地还原。
      enableBsdiffPatchSupport: true,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      // 内部调试：允许运行时覆盖 requestHeaders（切通道）；生产构建应关闭。
      disableAntiBrickingMeasures: CHANNEL_SWITCH_ENABLED,
    },
    extra: {
      appEnv: APP_ENV,
      enableChannelSwitch: CHANNEL_SWITCH_ENABLED,
    },
    ios: {
      bundleIdentifier: 'com.example.hotupdatedemo',
      // 真机调试签名通过 EXPO_APPLE_TEAM_ID 注入，仓库不保存个人 Team ID。
      ...(APPLE_TEAM_ID ? { appleTeamId: APPLE_TEAM_ID } : {}),
      supportsTablet: true,
    },
    android: {
      package: 'com.example.hotupdatedemo',
    },
  },
};
