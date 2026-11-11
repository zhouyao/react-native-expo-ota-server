import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Updates from 'expo-updates';
import {
  applyDownloadedUpdate,
  buildChannel as BUILD_CHANNEL,
  checkAndApplyUpdate,
  rememberPendingUpdate,
  reportLaunchOutcome,
  switchChannel,
} from './src/update';
import Header from './src/components/Header';
import VersionCard from './src/components/VersionCard';
import UpdateFlow from './src/components/UpdateFlow';
import CapabilityRow from './src/components/CapabilityRow';
import DebugPanel, { DebugRow } from './src/components/DebugPanel';
import DebugSection from './src/components/DebugSection';
import ErrorBoundary from './src/components/ErrorBoundary';
import { getJson, getRecentRequests } from './src/api';
import { logger, reportError } from './src/logger';
import { reportStartupOnce, sinceBundleStart } from './src/perf';
import { serverConfig } from './src/server-config';
import { colors, spacing } from './src/theme';

const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || 'development';

// 端到端演练：先打 v1 的 release 包，把这行改成 v2 文案后执行 ota:publish。
export const VERSION_TEXT = 'v1 - 内容版本';

// 内部调试开关：与 app.config.js 的 disableAntiBrickingMeasures 同步。
const CHANNEL_SWITCH_ENABLED =
  process.env.EXPO_PUBLIC_ENABLE_CHANNEL_SWITCH !== 'false';

const SERVED_LABEL = {
  current: 'current',
  previous: 'previous',
  whitelist: 'whitelist',
  rollback: 'rollback',
};

function formatTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function relativeTime(value) {
  if (!value) return '时间未知';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// useUpdates 只在 release 包中可用，用错误边界保证开发模式下页面仍能打开。
class UpdatesBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, passthrough: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // 只接管 expo-updates 自身的不可用错误；其它异常交还给外层 ErrorBoundary，
    // 否则它会抢先吞掉所有渲染错误，通用兜底页永远显示不出来。
    const text = `${error?.name || ''} ${error?.message || ''}`;
    const fromUpdates = /expo-updates|UpdatesContext|useUpdates/i.test(text);
    if (!fromUpdates) this.setState({ passthrough: true });
  }

  render() {
    if (this.state.passthrough && this.state.error) {
      // 重新抛出，冒泡到外层 ErrorBoundary。
      throw this.state.error;
    }
    if (this.state.error) {
      return (
        <View style={styles.fallback}>
          <Text style={styles.fallbackTitle}>更新状态不可用</Text>
          <Text style={styles.fallbackText}>
            expo-updates 需要 release 包；当前处于开发模式或模块未初始化。
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

function Console() {
  const {
    isChecking,
    isDownloading,
    isUpdateAvailable,
    isUpdatePending,
    downloadProgress,
    downloadedUpdate,
  } = Updates.useUpdates();
  const [message, setMessage] = useState('');
  const [uid, setUid] = useState('初始化中…');
  const [crash, setCrash] = useState(false);
  const [lastLog, setLastLog] = useState('');
  const [startupMs, setStartupMs] = useState(null);
  const [channelList, setChannelList] = useState([]);
  // 运行时切换的通道（请求头覆盖），与构建通道不是一回事。
  // Updates.channel 是模块加载时读的原生值，带着持久化覆盖，正好能反映"重启后仍在某通道"。
  const [activeChannel, setActiveChannel] = useState(Updates.channel || BUILD_CHANNEL || '');
  const [channelRefreshedAt, setChannelRefreshedAt] = useState(null);
  // 服务端实际下发的通道：切换后直接请求一次 manifest 校验（不影响 SDK 状态）。
  const [servedChannel, setServedChannel] = useState(null);
  const [servedAt, setServedAt] = useState(null);

  // 设备标识 + 启动心跳（内置包无 origin 时心跳自动跳过）。
  useEffect(() => {
    let active = true;
    (async () => {
      if (!Updates.isEnabled) {
        if (active) setUid('不可用（release 包才生效）');
        return;
      }
      try {
        const params = await Updates.getExtraParamsAsync();
        if (params?.uid) {
          if (active) setUid(params.uid);
        } else {
          const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await Updates.setExtraParamAsync('uid', id);
          if (active) setUid(id);
        }
      } catch {
        if (active) setUid('不可用');
      }
      void reportLaunchOutcome();
    })();
    return () => {
      active = false;
    };
  }, []);

  // 自动下载（checkAutomatically=ON_LOAD）不经过 downloadUpdate()，
  // 这里监听 useUpdates 暴露的 downloadedUpdate，把待应用版本持久化，
  // 供下次启动判断是否发生了坏包回退。
  useEffect(() => {
    const id = downloadedUpdate?.updateId;
    if (id) void rememberPendingUpdate(id);
  }, [downloadedUpdate?.updateId]);

  // 首屏渲染后记录一次启动耗时（bundle 开始 → 这里），并上报 client-metric。
  useEffect(() => {
    setStartupMs(sinceBundleStart());
    void reportStartupOnce();
  }, []);

  // 通道版本信息：挂载、切换通道、检查更新后都会重新拉取。
  const loadChannels = useCallback(async () => {
    try {
      const rv = encodeURIComponent(Updates.runtimeVersion || '1');
      const data = await getJson(`/api/channels?rv=${rv}`, { retries: 0 });
      if (data && Array.isArray(data.channels)) {
        setChannelList(data.channels);
        setChannelRefreshedAt(Date.now());
      }
    } catch {
      // 通道版本信息只是辅助提示，失败不影响页面
    }
  }, []);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  // 服务器地址/端口：构建期配置 + 实际连接 origin，首屏与调试面板都展示。
  const server = serverConfig();
  const metadata = Updates.manifest?.metadata || {};
  // 运行中版本所属通道（manifest metadata），拿不到时退回请求通道。
  const channel = metadata.channel || activeChannel || BUILD_CHANNEL || '未配置';
  const rollout = typeof metadata.rollout === 'number' ? metadata.rollout : null;
  const served = SERVED_LABEL[metadata.served] || null;
  const releaseId = metadata.releaseId || null;

  // 通道 → 当前版本信息；用于切换提示，取不到时按钮仍可用。
  const channelByName = {};
  for (const item of channelList) channelByName[item.channel] = item;
  const runningAt = Updates.createdAt ? new Date(Updates.createdAt).getTime() : null;

  // 调试面板摘要与文案：统一用「运行版本 / 请求通道 / 下发通道」三个词，避免概念混淆。
  const buildChannel = BUILD_CHANNEL || 'development';
  const runningChannelName =
    (channelList.find((item) => item.releaseId && item.releaseId === releaseId) || {}).channel ||
    '未知';
  const runningVersionLabel = releaseId
    ? `${runningChannelName} · #${String(releaseId).slice(-6)}`
    : '内置包';
  const requestLabel =
    activeChannel && activeChannel !== buildChannel
      ? `${activeChannel}（覆盖中，重启仍生效；点下方恢复 ${buildChannel}）`
      : `${buildChannel}（与构建通道一致）`;
  const servedLabel = servedChannel
    ? `${servedChannel}${servedAt ? `（${new Date(servedAt).toLocaleTimeString()} 校验）` : ''}`
    : '未校验';
  const updateState = isUpdatePending
    ? '已下载，待重启'
    : isUpdateAvailable
      ? '有可用更新'
      : '已是最新';
  const debugSummary = `${server.endpoint} · ${runningVersionLabel}${
    activeChannel && activeChannel !== buildChannel ? ` → ${activeChannel}` : ''
  }`;

  const stage = isChecking
    ? 'checking'
    : isDownloading
      ? 'downloading'
      : isUpdatePending
        ? 'pending'
        : isUpdateAvailable
          ? 'available'
          : 'idle';
  const progress = Math.round((downloadProgress || 0) * 100);

  const runState = Updates.isEmbeddedLaunch
    ? '内置包 · 尚未接收更新'
    : `OTA 更新 · ${relativeTime(Updates.createdAt)}`;

  async function onCheck() {
    setMessage('');
    try {
      const result = await checkAndApplyUpdate();
      if (result.status === 'disabled') {
        setMessage('需要 release 包才能检查更新');
      }
    } catch (error) {
      setMessage(`检查失败：${error.message}`);
    } finally {
      // 检查/下载后各通道版本可能变化，刷新面板显示。
      void loadChannels();
    }
  }

  async function onApply() {
    setMessage('');
    try {
      // 走 applyDownloadedUpdate：重启前会清掉通道覆盖，避免下次启动无内置包可回退
      await applyDownloadedUpdate();
    } catch (error) {
      setMessage(`重载失败：${error.message}`);
    }
  }

  /**
   * 直接请求一次 manifest 验证「服务端实际按哪个通道下发」。
   * 不用 Updates.checkForUpdateAsync()：那会把 SDK 的 isUpdateAvailable 置为 true，
   * 而这里只查不下载，会造成页面一直挂着「有更新」却消不掉。
   */
  const verifyServedChannel = useCallback(async (channelName) => {
    try {
      const rv = Updates.runtimeVersion || '1';
      const data = await getJson('/api/manifest', {
        retries: 0,
        timeout: 6000,
        headers: {
          'expo-platform': Platform.OS,
          'expo-runtime-version': rv,
          'expo-channel-name': channelName || BUILD_CHANNEL || 'development',
          'expo-protocol-version': '1',
        },
      });
      const served = data?.metadata?.channel || null;
      if (served) {
        setServedChannel(served);
        setServedAt(Date.now());
        setMessage(`服务端实际下发通道：${served}`);
        return;
      }
      setMessage('已切换；清单未返回通道信息');
    } catch (error) {
      setMessage(`已切换；校验失败：${error.message}`);
    }
  }, []);

  function applySwitch(target) {
    const result = switchChannel(target);
    if (!result.ok) {
      setMessage(`切换失败：${result.reason}`);
      return;
    }
    const next = target || BUILD_CHANNEL || '';
    setActiveChannel(next);
    void loadChannels();
    setMessage(
      target ? `已切到 ${target}，正在校验下发行通道…` : `已恢复构建通道 ${next}，正在校验下发行通道…`,
    );
    void verifyServedChannel(next);
  }

  function confirmSwitch(target) {
    if (target) {
      const info = channelByName[target];
      const publishedAt = info?.createdAt ? new Date(info.createdAt).getTime() : null;
      if (publishedAt && runningAt && publishedAt < runningAt) {
        Alert.alert(
          '目标通道版本更旧',
          `${target} 当前版本发布于 ${formatTime(info.createdAt)}，比正在运行的版本（${formatTime(
            Updates.createdAt,
          )}）旧。\n切换后检查更新看不到新功能；若装上旧版本，界面会回到旧代码。`,
          [
            { text: '取消', style: 'cancel' },
            { text: '继续切换', onPress: () => applySwitch(target) },
          ],
        );
        return;
      }
    }
    applySwitch(target);
  }

  function switchTo(target) {
    // 已下载的更新不区分通道，重启时会先应用它，容易造成"切了通道还是旧版本"的错觉。
    if (target && isUpdatePending) {
      Alert.alert(
        '有已下载的更新待应用',
        '这个更新属于切换前的通道，重启后会先应用它。建议先点「立即重启」应用，再切换到目标通道检查。',
        [
          { text: '取消', style: 'cancel' },
          { text: '仍然切换', onPress: () => confirmSwitch(target) },
        ],
      );
      return;
    }
    confirmSwitch(target);
  }

  async function onTestError() {
    const uploaded = await reportError(new Error('OTA 控制台测试错误'), {
      source: 'manual-test',
    });
    const entry = logger.getEntries().slice(-1)[0];
    if (entry) setLastLog(`${entry.at} [${entry.level}] ${entry.message}`);
    setMessage(
      uploaded
        ? '测试错误已上报，看板「事件」可见 client-error'
        : '已记录到本地日志（当前无服务地址，内置包不上报）',
    );
  }

  // 测试入口：验证 ErrorBoundary 的兜底与重试链路。
  if (crash) {
    const error = new Error('测试渲染异常：用于验证 ErrorBoundary');
    error.name = 'TestRenderError';
    throw error;
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Header
        version={VERSION_TEXT}
        channel={channel}
        rollout={rollout}
        runState={runState}
      />

      <VersionCard
        releaseId={releaseId}
        updateId={Updates.updateId}
        createdAt={formatTime(Updates.createdAt)}
        serverEndpoint={server.endpoint}
      />

      <UpdateFlow
        stage={stage}
        progress={progress}
        message={message}
        onCheck={onCheck}
        onApply={onApply}
        busy={isChecking || isDownloading}
      />

      <CapabilityRow
        channel={channel}
        rollout={rollout}
        served={served}
        signed={Boolean(releaseId)}
      />

      <DebugPanel summary={debugSummary}>
        <DebugSection title="OTA 状态">
          <DebugRow label="运行版本" value={runningVersionLabel} />
          <DebugRow label="请求通道" value={requestLabel} />
          <DebugRow label="下发通道" value={servedLabel} />
          <DebugRow label="更新状态" value={updateState} />
        </DebugSection>

        <DebugSection
          title="OTA 服务地址"
          hint="构建期地址来自打包时的 updates.url；已下载更新后以服务端下发的 origin 为准。"
        >
          <DebugRow label="服务器地址" value={server.active?.host || '-'} />
          <DebugRow label="端口" value={server.active?.port || '-'} />
          <DebugRow label="请求地址" value={server.requestUrl || '-'} multiline />
          <DebugRow label="地址来源" value={server.source} />
          <DebugRow label="构建期地址" value={server.build?.url || '-'} multiline />
          <DebugRow
            label="地址一致性"
            value={server.mismatched ? '构建期与实际不同' : '一致'}
            warn={server.mismatched}
          />
        </DebugSection>

        <DebugSection title="环境与版本">
          <DebugRow label="runtimeVersion" value={Updates.runtimeVersion} />
          <DebugRow label="构建环境" value={APP_ENV} />
          <DebugRow label="构建通道" value={buildChannel} />
          <DebugRow
            label="App 版本"
            value={Updates.manifest?.extra?.expoConfig?.version || '-'}
          />
          <DebugRow
            label="启动方式"
            value={Updates.isEmbeddedLaunch ? '内置包（未接收更新）' : 'OTA 更新'}
          />
          <DebugRow
            label="应急启动"
            value={Updates.isEmergencyLaunch ? '是' : '否'}
            warn={Boolean(Updates.isEmergencyLaunch)}
          />
          <DebugRow label="设备 uid" value={uid} />
          <DebugRow label="bucket" value={metadata.bucket ?? '-'} />
          <DebugRow label="启动耗时" value={startupMs === null ? '-' : `${startupMs} ms`} />
        </DebugSection>
        {CHANNEL_SWITCH_ENABLED ? (
          <DebugSection
            title="测试通道"
            hint="切换会写入原生并持久化：重启后仍停在该通道，点「恢复构建通道」才清除。目标通道的旧包也会被下载并生效。"
            action={
              <Pressable onPress={() => loadChannels()} style={styles.smallBtn}>
                <Text style={styles.smallBtnText}>刷新</Text>
              </Pressable>
            }
          >
            {['production', 'beta', 'canary', 'development'].map((name) => {
              const info = channelByName[name];
              const publishedAt = info?.createdAt ? new Date(info.createdAt).getTime() : null;
              const older = Boolean(publishedAt && runningAt && publishedAt < runningAt);
              const running = Boolean(
                info?.releaseId && releaseId && info.releaseId === releaseId,
              );
              const selected = activeChannel === name;
              return (
                <View key={name} style={styles.channelLine}>
                  <View style={styles.channelMain}>
                    <Text style={styles.channelName}>{name}</Text>
                    <Text style={styles.channelInfo} numberOfLines={1}>
                      {info
                        ? `#${String(info.releaseId || '').slice(-6)} · ${relativeTime(info.createdAt)}`
                        : '未获取版本'}
                    </Text>
                    {running ? (
                      <Text style={[styles.channelTag, styles.tagRunning]}>运行中</Text>
                    ) : selected ? (
                      <Text style={[styles.channelTag, styles.tagSelected]}>已选中</Text>
                    ) : older ? (
                      <Text style={[styles.channelTag, styles.tagWarn]}>落后</Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => switchTo(name)}
                    disabled={running}
                    style={[styles.switchBtn, running ? styles.switchBtnDisabled : null]}
                  >
                    <Text style={styles.switchBtnText}>{running ? '当前' : '切换'}</Text>
                  </Pressable>
                </View>
              );
            })}
            <View style={styles.channelFoot}>
              <Pressable onPress={() => switchTo(null)} style={styles.secondaryBtn}>
                <Text style={styles.secondaryBtnText}>恢复构建通道 {buildChannel}</Text>
              </Pressable>
              <Text style={styles.channelMeta}>
                {channelRefreshedAt
                  ? `状态更新于 ${new Date(channelRefreshedAt).toLocaleTimeString()}`
                  : '未获取通道状态'}
              </Text>
            </View>
          </DebugSection>
        ) : null}

        <DebugSection
          title="错误与日志"
          hint="上报写入 /api/events，看板「事件」按 client-error 过滤可见。"
        >
          <View style={styles.actionRow}>
            <Pressable onPress={onTestError} style={styles.smallBtn}>
              <Text style={styles.smallBtnText}>发送测试错误</Text>
            </Pressable>
            <Pressable onPress={() => setCrash(true)} style={styles.smallBtn}>
              <Text style={styles.smallBtnText}>触发渲染异常</Text>
            </Pressable>
          </View>
          {lastLog ? (
            <Text style={styles.logText} selectable>
              {lastLog}
            </Text>
          ) : null}
        </DebugSection>

        {getRecentRequests().length ? (
          <DebugSection title="请求诊断" hint="最近 5 次网络请求（内存，不落盘）">
            {getRecentRequests()
              .slice(0, 3)
              .map((item) => (
                <DebugRow
                  key={`${item.at}-${item.requestId}`}
                  label={`${item.method} ${item.path}`}
                  value={`${item.status || 'ERR'} · ${item.ms}ms`}
                  warn={!item.status}
                />
              ))}
          </DebugSection>
        ) : null}
      </DebugPanel>

      <Text style={styles.footer}>
        更新默认在下次冷启动生效；页面可在安全时机主动检查并应用，避免打断用户操作。
      </Text>
    </ScrollView>
  );
}

export default function App() {
  // 换 key 重新挂载子树，让边界「重试」能清掉渲染异常状态。
  const [boundaryKey, setBoundaryKey] = useState(0);
  return (
    <SafeAreaView style={styles.safe}>
      <ErrorBoundary key={boundaryKey} onReset={() => setBoundaryKey((key) => key + 1)}>
        <UpdatesBoundary>
          <Console />
        </UpdatesBoundary>
      </ErrorBoundary>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  page: {
    padding: spacing.page,
    paddingTop: 56,
    paddingBottom: 40,
  },
  switchBox: {
    marginTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: 12,
  },
  switchTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  switchHint: {
    marginTop: 4,
    fontSize: 12,
    color: colors.faint,
    lineHeight: 17,
  },
  switchButtons: {
    marginTop: 10,
  },
  channelMeta: {
    fontSize: 11,
    color: colors.faint,
    marginTop: 6,
  },
  channelLine: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  channelMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  channelName: {
    width: 88,
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  channelInfo: {
    fontSize: 11,
    color: colors.muted,
    flexShrink: 1,
  },
  channelTag: {
    fontSize: 10,
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
  },
  tagRunning: { backgroundColor: colors.successSoft, color: colors.success },
  tagSelected: { backgroundColor: colors.primarySoft, color: colors.primary },
  tagWarn: { backgroundColor: colors.warningSoft, color: colors.warning },
  switchBtn: {
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: colors.primarySoft,
  },
  switchBtnDisabled: { backgroundColor: colors.bg },
  switchBtnText: { fontSize: 12, fontWeight: '600', color: colors.primary },
  channelFoot: { marginTop: 10 },
  secondaryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    marginBottom: 6,
  },
  secondaryBtnText: { fontSize: 12, color: colors.muted },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.primarySoft,
  },
  smallBtnText: { fontSize: 12, fontWeight: '600', color: colors.primary },
  logText: {
    marginTop: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: colors.bg,
    fontSize: 11,
    color: colors.muted,
  },
  footer: {
    marginTop: 4,
    fontSize: 12,
    color: colors.faint,
    lineHeight: 18,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  fallbackTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  fallbackText: {
    marginTop: 8,
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
  },
});
