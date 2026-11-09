import crypto from 'node:crypto';

/** 稳定分桶：同一 uid 永远落在同一个 0-99 桶里。 */
export function bucketFor(uid) {
  const digest = crypto.createHash('sha256').update(String(uid)).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * 从 Expo-Extra-Params 里取 uid（SFV 字典，逗号分隔）。
 * 引号包裹的值必须完整闭合、裸值必须紧邻逗号或结尾，
 * 否则 `uid="has space"` 会被截断成 `has`，把设备分到错误的桶。
 */
export function parseUid(headers = {}) {
  const raw = headers['expo-extra-params'];
  if (!raw) return null;
  const match = String(raw).match(
    /(?:^|,)\s*uid\s*=\s*(?:"([A-Za-z0-9_.-]{1,64})"|([A-Za-z0-9_.-]{1,64})(?=\s*(?:,|$)))/i,
  );
  return match ? match[1] || match[2] : null;
}

function normalizePercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

const PLATFORM_KEYS = new Set(['ios', 'android']);

/**
 * 生效放量百分比：平台覆盖优先，未配置或平台未知时回退通道统一 percentage。
 * 平台覆盖放在 rollout.byPlatform，current/previous 仍然双端共用一份指针。
 */
export function percentageFor(channel, platform) {
  const rollout = channel?.rollout || { percentage: 100, whitelist: [] };
  const override = PLATFORM_KEYS.has(platform)
    ? rollout.byPlatform?.[platform]
    : undefined;
  return normalizePercent(
    override === undefined || override === null ? rollout.percentage : override,
  );
}

/**
 * 按 rollout 配置决定这次请求应该拿到 current 还是 previous。
 * - 100%：所有人拿 current
 * - 白名单：名单内直接拿 current
 * - 无 uid：只有 100% 才拿 current，避免未上报设备被意外放量
 * - platform：按 expo-platform 选取该平台的放量百分比（A+ 平台灰度）
 */
export function selectRelease(channel, uid, platform) {
  const rollout = channel?.rollout || { percentage: 100, whitelist: [] };
  const percentage = percentageFor(channel, platform);
  const whitelist = rollout.whitelist || [];

  if (!channel?.releaseId) return null;
  if (percentage >= 100) {
    return {
      releaseId: channel.releaseId,
      served: 'current',
      percentage,
      bucket: uid ? bucketFor(uid) : null,
    };
  }
  if (uid && whitelist.includes(uid)) {
    return {
      releaseId: channel.releaseId,
      served: 'whitelist',
      percentage,
      bucket: bucketFor(uid),
    };
  }
  if (!uid) {
    return {
      releaseId: channel.previous?.releaseId || channel.releaseId,
      served: channel.previous?.releaseId ? 'previous' : 'current',
      percentage,
      bucket: null,
    };
  }

  const bucket = bucketFor(uid);
  if (bucket < percentage) {
    return {
      releaseId: channel.releaseId,
      served: 'current',
      percentage,
      bucket,
    };
  }
  // 没有 previous 时灰度无处可退，只能全量下发 current；
  // 此时标记必须保持 current，否则指标会把"实际拿到新版本"记成 previous。
  if (!channel.previous?.releaseId) {
    return {
      releaseId: channel.releaseId,
      served: 'current',
      percentage,
      bucket,
    };
  }
  return {
    releaseId: channel.previous.releaseId,
    served: 'previous',
    percentage,
    bucket,
  };
}
