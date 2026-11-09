import { Platform } from 'react-native';
import * as Updates from 'expo-updates';

/**
 * 服务端地址：优先取 manifest 的 launchAsset（服务端按真机可达地址生成），
 * 退回构建期写入的 updates.url。内置包 / 开发模式下可能为 null。
 */
export function resolveOrigin() {
  const url =
    Updates.manifest?.launchAsset?.url ||
    Updates.manifest?.extra?.expoConfig?.updates?.url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 上报时附带的环境信息（全部来自 expo-updates，不额外采集设备标识）。 */
export function runtimeInfo() {
  const metadata = Updates.manifest?.metadata || {};
  return {
    runtimeVersion: Updates.runtimeVersion || null,
    channel: Updates.channel || null,
    releaseId: metadata.releaseId || null,
    updateId: Updates.updateId || null,
    platform: Platform.OS,
    isEmbeddedLaunch: Boolean(Updates.isEmbeddedLaunch),
    // 应急启动 = 新包启动失败后回退到内置包，是坏包的第一手信号。
    isEmergencyLaunch: Boolean(Updates.isEmergencyLaunch),
    appVersion: Updates.manifest?.extra?.expoConfig?.version || null,
  };
}

/** 设备 uid 由 expo-updates 的 ExtraParams 持久化，卸载重装会变。 */
export async function currentUid() {
  try {
    const params = await Updates.getExtraParamsAsync();
    return params?.uid || null;
  } catch {
    return null;
  }
}
