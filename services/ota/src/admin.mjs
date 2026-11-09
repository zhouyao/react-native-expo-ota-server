import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_TOKENS } from './config.mjs';
import {
  channelLockFile,
  listReleaseIds,
  normalizeChannel,
  readChannel,
  setRollout,
} from './release-store.mjs';
import {
  fingerprintRequest,
  recallRequest,
  rememberRequest,
  withLock,
} from './locks.mjs';

// services/ota/src → 项目根需要上三级。
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const PUBLISH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'publish.mjs');

function providedToken(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // 有的客户端会把换行 / 空格带进头部，按原值比对会误判为无效令牌。
  return String(req.headers['x-ota-admin-token'] || bearer || '').trim();
}

/** 令牌 → 操作人标签（OTA_ADMIN_TOKENS 的冒号前缀）；无效返回 null。 */
export function resolveOperator(req) {
  const token = providedToken(req);
  if (!token) return null;
  return ADMIN_TOKENS.get(token) || null;
}

/** 令牌未配置时恒为 false。 */
export function isAuthorized(req) {
  return Boolean(resolveOperator(req));
}

/** 复用已验证的 CLI 逻辑，避免看板与命令行出现两套发布/回滚实现。 */
function runPublish(args) {
  const result = spawnSync(process.execPath, [PUBLISH_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail.slice(-800) || `发布脚本退出码 ${result.status}`);
  }
  return (result.stdout || '').trim();
}

/** 平台灰度覆盖：对象只保留 ios / android，null 表示清除覆盖。 */
function parseByPlatform(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('byPlatform 必须是对象或 null');
  }
  const result = {};
  for (const platform of ['ios', 'android']) {
    const raw = value[platform];
    if (raw === undefined || raw === null || raw === '') continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      throw new Error(`byPlatform.${platform} 必须是 0-100 的数字`);
    }
    result[platform] = num;
  }
  return Object.keys(result).length ? result : null;
}

function describeByPlatform(value) {
  if (!value) return '跟随统一值';
  return ['ios', 'android']
    .map((platform) =>
      value[platform] === undefined ? null : `${platform} ${value[platform]}%`,
    )
    .filter(Boolean)
    .join(' / ') || '跟随统一值';
}

/**
 * 支持的动作（对应 EAS 控制台的运维入口）：
 * - set-rollout：调整灰度百分比与白名单（直接写通道状态）
 * - promote：把指定历史版本提升为该通道 current（重新发布并刷新 createdAt）
 * - rollback-previous：回滚到该通道上一个版本（同样重新发布）
 * - republish：重新发布该通道当前版本（刷新时间戳，对应 eas update:republish）
 *
 * 所有动作都在「通道锁」内串行，并支持 requestId 幂等重试。
 */
export async function performAdminAction(input, context = {}) {
  const {
    operator = 'unknown',
    via = 'dashboard',
    requestId = null,
    source = null,
  } = context;

  const rv = String(input.runtimeVersion || '');
  if (!rv) throw new Error('缺少 runtimeVersion');
  const name = normalizeChannel(input.channel);
  const publishArgs = (extra) => [
    ...extra,
    '--channel',
    name,
    '--runtime-version',
    rv,
    '--operator',
    operator,
  ];

  const fingerprint = fingerprintRequest({
    action: input.action,
    rv,
    channel: name,
    releaseId: input.releaseId || null,
    percentage: input.percentage ?? null,
    whitelist: input.whitelist ?? null,
    byPlatform: input.byPlatform ?? null,
  });
  const requestKey = requestId ? `req:${requestId}` : null;
  const fingerprintKey = `fp:${fingerprint}`;

  if (requestKey) {
    const cached = recallRequest(requestKey);
    if (cached) return { ...cached, duplicated: true };
  }
  if (recallRequest(fingerprintKey)) {
    throw new Error('相同操作在 60 秒内已执行，请勿重复提交');
  }

  return withLock(`${rv}:${name}`, channelLockFile(rv, name), async () => {
    let message;

    if (input.action === 'set-rollout') {
      const current = await readChannel(rv, name);
      if (!current?.releaseId) throw new Error(`通道 ${name} 尚未发布任何版本`);
      if (input.percentage !== undefined) {
        const value = Number(input.percentage);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error('percentage 必须是 0-100 的数字');
        }
      }
      if (input.whitelist !== undefined && !Array.isArray(input.whitelist)) {
        throw new Error('whitelist 必须是数组');
      }
      const byPlatform =
        input.byPlatform === undefined ? undefined : parseByPlatform(input.byPlatform);
      const result = await setRollout(rv, name, {
        percentage: input.percentage,
        whitelist: input.whitelist ? input.whitelist.map(String) : undefined,
        byPlatform,
        operator,
        via,
        requestId,
        source,
      });
      message = `通道 ${name} rollout=${result.rollout.percentage}%，平台 ${describeByPlatform(result.rollout.byPlatform)}，白名单 ${result.rollout.whitelist.length} 个`;
    } else if (input.action === 'promote' || input.action === 'switch') {
      const ids = await listReleaseIds(rv);
      const id = String(input.releaseId || '');
      if (!ids.includes(id)) throw new Error(`版本 ${id || '(空)'} 不存在`);
      message = runPublish(publishArgs(['--release', id]));
    } else if (input.action === 'rollback-previous') {
      const current = await readChannel(rv, name);
      if (!current?.previous?.releaseId) {
        throw new Error(`通道 ${name} 没有可回滚的上一个版本`);
      }
      message = runPublish(publishArgs(['--release', current.previous.releaseId]));
    } else if (input.action === 'republish') {
      const current = await readChannel(rv, name);
      if (!current?.releaseId) throw new Error(`通道 ${name} 尚未发布任何版本`);
      message = runPublish(publishArgs(['--touch']));
    } else {
      throw new Error(`未知操作: ${String(input.action || '(空)')}`);
    }

    const result = { message, operator, duplicated: false };
    rememberRequest(fingerprintKey, result);
    if (requestKey) rememberRequest(requestKey, result);
    return result;
  });
}
