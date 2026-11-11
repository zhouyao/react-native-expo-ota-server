import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_TOKENS,
  hasScope,
  stopLossConfig,
  writeStopLossOverride,
} from './config.mjs';
import {
  appendAudit,
  auditEntry,
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
import { applyHalt, evaluateChannelHealth, restoreRollout } from './stop-loss.mjs';

// services/ota/src → 项目根需要上三级。
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const PUBLISH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'publish.mjs');
const GC_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'gc.mjs');
/** 回收要遍历 / 删除目录，比发布慢得多，单独给更长的超时。 */
const GC_TIMEOUT_MS = 5 * 60 * 1000;

function providedToken(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // 有的客户端会把换行 / 空格带进头部，按原值比对会误判为无效令牌。
  return String(req.headers['x-ota-admin-token'] || bearer || '').trim();
}

/** 令牌 → { label, scopes }；无效返回 null。兼容历史字符串值。 */
export function resolveAdmin(req) {
  const token = providedToken(req);
  if (!token) return null;
  const entry = ADMIN_TOKENS.get(token);
  if (!entry) return null;
  return typeof entry === 'string' ? { label: entry, scopes: null } : entry;
}

/** 令牌 → 操作人标签（OTA_ADMIN_TOKENS 的冒号前缀）；无效返回 null。 */
export function resolveOperator(req) {
  const admin = resolveAdmin(req);
  return admin ? admin.label : null;
}

/** 令牌未配置时恒为 false。 */
export function isAuthorized(req) {
  return Boolean(resolveAdmin(req));
}

/**
 * 动作 → 所需权限位。未列出的动作（evaluate-stop-loss）不需要 scope。
 * 止血 / 恢复只要求 stop-loss，便于给 on-call 一个「能止血但不能发布」的窄令牌。
 */
const ACTION_SCOPES = {
  'set-rollout': 'rollout',
  promote: 'release',
  switch: 'release',
  'rollback-previous': 'release',
  republish: 'release',
  'halt-channel': 'stop-loss',
  'restore-rollout': 'stop-loss',
  'set-stop-loss-config': 'stop-loss',
  'gc-releases': 'gc',
};

export function requiredScope(action) {
  return ACTION_SCOPES[String(action || '')] || null;
}

/** 该 admin 是否有权执行某动作；只读评估恒为 true。 */
export function canPerform(admin, action) {
  const scope = requiredScope(action);
  if (!scope) return Boolean(admin);
  return hasScope(admin, scope);
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

/**
 * 回收旧 release：复用 CLI 的保护集与补丁联动逻辑。
 * 用 spawn 而不是同进程调用，是因为删除大目录会长时间阻塞事件循环，
 * 期间所有 manifest / asset 请求都会被拖住。
 *
 * 服务端仍会重新校验保护集（由 gc.mjs 负责），前端禁用只是 UX。
 */
function runGc(runtimeVersion, input, { operator, via, requestId }) {
  const targets = (Array.isArray(input.releaseIds) ? input.releaseIds : [])
    .map((id) => String(id).trim())
    .filter((id) => /^\d+$/.test(id));
  const args = [
    GC_SCRIPT,
    '--rv',
    String(runtimeVersion),
    '--json',
    '--operator',
    operator,
    '--via',
    via,
    input.apply === true ? '--apply' : '--dry-run',
  ];
  if (requestId) args.push('--request-id', requestId);
  for (const key of ['keepDays', 'keepLast', 'patchBases']) {
    if (input[key] !== undefined && input[key] !== null) {
      args.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(input[key]));
    }
  }
  for (const id of targets) args.push('--release', id);

  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: GC_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail.slice(-800) || `回收脚本退出码 ${result.status}`);
  }

  let parsed = {};
  try {
    parsed = JSON.parse((result.stdout || '').trim() || '{}');
  } catch {
    throw new Error('回收结果解析失败，请检查服务端日志');
  }
  const entry = parsed.results?.[0] || {};
  const plan = entry.plan || {};
  const removed = entry.result?.removed || [];
  const bytes = entry.result?.reclaimedBytes ?? plan.reclaimableBytes ?? 0;
  const message = entry.dryRun
    ? `回收预览（dry-run）：${plan.candidates?.length ?? 0} 个版本 / ${bytes} 字节可释放`
    : `已回收 ${removed.length} 个版本 / ${bytes} 字节`;
  return { message, operator, duplicated: false };
}

/**
 * 全局止损设置（MIN_SAMPLES / Webhook）。不针对具体通道，因此不占通道锁；
 * 写入运行时覆盖文件并记录审计（Webhook 只记 configured/none，不落明文）。
 */
async function saveStopLossSettings(input, { operator, via, requestId, source, rv }) {
  if (requestId) {
    const cached = recallRequest(`req:${requestId}`);
    if (cached) return { ...cached, duplicated: true };
  }
  await writeStopLossOverride(
    { minSamples: input.minSamples, webhook: input.webhook },
    { operator },
  );
  const cfg = stopLossConfig();
  const entry = auditEntry({
    action: 'set-stop-loss-config',
    channel: 'system',
    operator,
    via,
    requestId,
    params: {
      minSamples: cfg.minSamples,
      webhook: cfg.webhook ? 'configured' : 'none',
    },
    source,
  });
  if (rv) await appendAudit(rv, entry);
  const result = {
    message: `止损设置已更新：MIN_SAMPLES=${cfg.minSamples}，Webhook ${cfg.webhook ? '已配置' : '未配置'}`,
    operator,
    duplicated: false,
  };
  if (requestId) rememberRequest(`req:${requestId}`, result);
  return result;
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

  // 全局设置不针对通道，提前返回，避免占用通道锁。
  if (input.action === 'set-stop-loss-config') {
    return saveStopLossSettings(input, { operator, via, requestId, source, rv });
  }

  // GC 同样不针对通道：脚本内部持 runtimeVersion 级锁（与提升 / 重发互斥），
  // 这里不能再拿通道锁，否则会与 publish 的加锁顺序冲突。
  if (input.action === 'gc-releases') {
    if (requestId) {
      const cached = recallRequest(`req:${requestId}`);
      if (cached) return { ...cached, duplicated: true };
    }
    const result = runGc(rv, input, { operator, via, requestId });
    if (requestId) rememberRequest(`req:${requestId}`, result);
    return result;
  }

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
  // 只读评估不写状态；止血 / 恢复属于应急动作，允许 60 秒内重复触发（后端幂等保护），
  // 因此都不走「相同操作已执行」的指纹拦截。
  const readOnly = input.action === 'evaluate-stop-loss';
  const skipFingerprint =
    readOnly || input.action === 'halt-channel' || input.action === 'restore-rollout';

  if (requestKey) {
    const cached = recallRequest(requestKey);
    if (cached) return { ...cached, duplicated: true };
  }
  if (!skipFingerprint && recallRequest(fingerprintKey)) {
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
    } else if (input.action === 'evaluate-stop-loss') {
      // 只读评估，不改状态：便于人工在看板上先看口径再决定是否恢复。
      const health = await evaluateChannelHealth(rv, name);
      const policy = !health.enabled
        ? '已关闭（仅展示健康度）'
        : health.mode === 'monitor'
          ? '仅监控（只告警）'
          : health.mode === 'rollback'
            ? '自动止血并标记待回滚'
            : health.mode === 'halt'
              ? '自动止血'
              : '未知';
      const minSamples = Number(health.minSamples || 0);
      let sampleNote = '';
      if (health.reason === 'insufficient-samples' && minSamples > 0) {
        const launchGap = Math.max(0, minSamples - Number(health.launches || 0));
        const installGap = Math.max(0, minSamples - Number(health.attempts || 0));
        sampleNote =
          ` · 样本不足：启动 ${health.launches ?? 0}/${minSamples}（还差 ${launchGap}）` +
          `、安装 ${health.attempts ?? 0}/${minSamples}（还差 ${installGap}）`;
      }
      message =
        `通道 ${name} 止损评估：${health.verdict}` +
        (health.reason ? `（${health.reason}）` : '') +
        ` · 自动动作：${policy}` +
        ` · cohort ${health.cohortSize ?? 0} 设备` +
        ` · 启动失败 ${health.badLaunches ?? 0}/${health.launches ?? 0}` +
        `（应急 ${health.emergency ?? 0} / 回退 ${health.fallback ?? 0}）` +
        ` · 安装失败 ${health.fails ?? 0}/${health.attempts ?? 0}` +
        sampleNote;
    } else if (input.action === 'halt-channel') {
      // 人工紧急止血：复用哨兵的 halt 语义（清零灰度 + 清白名单/平台覆盖 + 快照）。
      // 注意：此处已持有通道锁，applyHalt 内部不得再加锁（否则死锁）。
      const current = await readChannel(rv, name);
      if (!current?.releaseId) throw new Error(`通道 ${name} 尚未发布任何版本`);
      const halted = await applyHalt(rv, name, {
        reason: input.reason ? String(input.reason).slice(0, 200) : 'manual-halt',
        operator,
        via,
        requestId,
        action: 'halt',
        requestedMode: input.mode ? String(input.mode).slice(0, 20) : null,
      });
      if (halted.action === 'skipped' && halted.reason === 'already-halted') {
        message = `通道 ${name} 已处于止血状态（灰度 0%），未重复快照`;
      } else if (halted.action === 'skipped') {
        message = `通道 ${name} 未止血：${halted.reason}`;
      } else {
        message =
          `通道 ${name} 已紧急止血：灰度 0%，白名单与平台覆盖已清空` +
          `（原配置已快照，可点「恢复暂停前灰度」还原）`;
      }
    } else if (input.action === 'restore-rollout') {
      const restored = await restoreRollout(rv, name, { operator, via, requestId });
      message =
        `通道 ${name} 已恢复暂停前灰度：${restored.percentage}%` +
        `，白名单 ${restored.whitelist} 个` +
        (restored.byPlatform ? `，平台覆盖 ${describeByPlatform(restored.byPlatform)}` : '');
    } else {
      // 控制台前端是热加载的、后端模块不是，因此「页面有新按钮但服务是旧进程」很常见。
      // 这里把排查方向直接写进报错，避免只看到一句「未知操作」。
      throw new Error(
        `未知操作: ${String(input.action || '(空)')}。` +
          '若该功能是刚新增的，说明运行中的服务仍是旧进程，请重启 npm run ota:start 加载新代码',
      );
    }

    const result = { message, operator, duplicated: false };
    if (!skipFingerprint) rememberRequest(fingerprintKey, result);
    if (requestKey) rememberRequest(requestKey, result);
    return result;
  });
}
