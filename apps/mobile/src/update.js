import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { currentUid, runtimeInfo } from './runtime-info';

// 构建期写进原生的值。Updates.channel 是模块加载时读一次的常量（且带着运行时覆盖），
// 而 Constants.expoConfig 在 OTA 启动时是 null（expo-constants 只认 extra.expoClient），
// 所以「构建通道 / 构建 URL」优先用打包时内联的 EXPO_PUBLIC_*。
export const buildChannel =
  process.env.EXPO_PUBLIC_CHANNEL || Constants.expoConfig?.updates?.channel || null;

// 必须是「构建期同一个 origin」：expo-updates 的 scopeKey 默认取 updateUrl 的 origin，
// 换 origin 等于换 scope —— 老 scope 的已下载包查不到，uid（按 scope 存）也会丢。
const buildUpdateUrl =
  process.env.EXPO_PUBLIC_OTA_URL || Constants.expoConfig?.updates?.url || null;

/**
 * 客户端更新能力封装（EAS 标准 API 的组合）。
 *
 * - 默认：已下载的更新在下次冷启动生效，不打断当前操作；
 * - 主动：页面在安全时机（提交完成、退出编辑、回首页）调用 checkAndApplyUpdate()，
 *   把生效时间提前；失败不影响业务。
 * - 灰度：服务端按 uid 分桶决定返回 current 还是 previous，客户端无需关心。
 */

// 内置包启动时 Updates.manifest 为空，用最近一次下载的清单兜底，
// 否则首次检查/下载的事件无法上报。
let lastManifest = null;

function apiOrigin() {
  // launchAsset.url 由服务端生成，天然指向真机可达的地址（含局域网 IP）；
  // expoConfig.updates.url 是构建期写入的，发布产物里常常还是 localhost，不能优先用。
  const url =
    lastManifest?.launchAsset?.url ||
    Updates.manifest?.launchAsset?.url ||
    lastManifest?.extra?.expoConfig?.updates?.url ||
    Updates.manifest?.extra?.expoConfig?.updates?.url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 上报 check / download / apply 结果，供服务端统计采用率与失败率。 */
export async function reportEvent({ type, status = 0, message }) {
  const origin = apiOrigin();
  if (!origin) return;
  try {
    await fetch(`${origin}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type,
        status,
        message: message ? String(message).slice(0, 300) : undefined,
        uid: await currentUid(),
        ...runtimeInfo(),
      }),
    });
  } catch {
    // 监控是旁路，失败不影响更新
  }
}

export async function checkForUpdate() {
  if (!Updates.isEnabled) return { available: false, disabled: true };
  try {
    // 原生检查在网络异常时可能长时间不返回，加超时避免按钮一直转圈。
    const result = await Promise.race([
      Updates.checkForUpdateAsync(),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 8000)),
    ]);
    if (result?.__timeout) throw new Error('检查更新超时，请稍后重试');
    void reportEvent({ type: 'check', status: 200 });
    return {
      available: Boolean(result.isAvailable),
      rollback: Boolean(result.isRollBackToEmbedded),
      updateId: result.manifest?.id || null,
    };
  } catch (error) {
    void reportEvent({ type: 'check', status: 500, message: error.message });
    throw error;
  }
}

export async function downloadUpdate() {
  if (!Updates.isEnabled) return { downloaded: false, disabled: true };
  try {
    const result = await Updates.fetchUpdateAsync();
    if (result.manifest) lastManifest = result.manifest;
    const downloaded = Boolean(result.isNew || result.isRollBackToEmbedded);
    void reportEvent({ type: 'download', status: downloaded ? 200 : 204 });
    return {
      downloaded,
      rollback: Boolean(result.isRollBackToEmbedded),
      updateId: result.manifest?.id || null,
    };
  } catch (error) {
    void reportEvent({ type: 'download', status: 500, message: error.message });
    throw error;
  }
}

export async function applyDownloadedUpdate() {
  void reportEvent({ type: 'apply', status: 200 });
  // 不要在这里清掉通道覆盖：LauncherSelectionPolicy 启动时要求已下载包的
  // url + requestHeaders 与当前 config 完全一致，清早了刚下载的跨通道包会被过滤掉。
  await Updates.reloadAsync();
}

/** 清掉运行时通道覆盖（含双端持久化的那份），回到构建期配置。 */
export function clearChannelOverride() {
  if (!Updates.isEnabled) return { cleared: false };
  try {
    Updates.setUpdateURLAndRequestHeadersOverride(null);
    return { cleared: true };
  } catch (error) {
    return { cleared: false, reason: error.message };
  }
}

/**
 * 内部调试：运行时切换通道（experimental API）。
 * 只在 app.config.js 开启 disableAntiBrickingMeasures 的调试包可用。
 *
 * 覆盖是持久的（iOS UserDefaults / Android SharedPreferences），重启后仍生效；
 * 传 null 才回到构建期配置。别在重启前主动清掉：启动时 LauncherSelectionPolicy
 * 要求已下载包的 url + requestHeaders 与当前 config 一致，清早了会切不过去。
 *
 * updateUrl 必须是「构建期同一个 origin」（scopeKey 由它推导），否则等于换 scope：
 * 老包查不到、uid 丢失，Android 上还可能出现 "Failed to launch"。
 *
 * 拿不到构建期 URL 时：iOS 可以只覆盖请求头（getUpdateUrl 用 `if let` 回落内置 URL），
 * Android 不行 —— 它的 getUpdateUrl 会返回 null，`!!` 直接抛 NPE，
 * 而且这份非法覆盖已经写进 SharedPreferences，重启后 expo-updates 直接 disabled。
 */
export function switchChannel(channel) {
  if (!Updates.isEnabled) return { ok: false, reason: 'updates 未启用' };
  try {
    if (!channel) {
      const cleared = clearChannelOverride();
      if (!cleared.cleared) return { ok: false, reason: cleared.reason || 'updates 未启用' };
      return { ok: true, channel: buildChannel };
    }
    const requestHeaders = { 'expo-channel-name': channel };
    // iOS：只覆盖请求头。getUpdateUrl() 用 `if let` 回落内置 URL，
    // 不碰 updateUrl 就不会改 scopeKey（uid、已下载包都按 scope 存）。
    if (Platform.OS !== 'android') {
      Updates.setUpdateRequestHeadersOverride(requestHeaders);
      return { ok: true, channel };
    }
    if (!buildUpdateUrl) {
      return {
        ok: false,
        reason: '拿不到构建期 updates.url，Android 上只覆盖请求头会写坏原生配置',
      };
    }
    Updates.setUpdateURLAndRequestHeadersOverride({ updateUrl: buildUpdateUrl, requestHeaders });
    return { ok: true, channel };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/** 检查 → 下载 → 立即应用；没有可用更新时返回 up-to-date。 */
export async function checkAndApplyUpdate() {
  const check = await checkForUpdate();
  if (!check.available) {
    return { status: check.disabled ? 'disabled' : 'up-to-date' };
  }

  const download = await downloadUpdate();
  if (!download.downloaded) return { status: 'up-to-date' };

  await applyDownloadedUpdate();
  return { status: 'applied', updateId: download.updateId };
}
