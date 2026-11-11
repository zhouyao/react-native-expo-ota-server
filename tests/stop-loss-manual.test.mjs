import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RV = '1';
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-stop-loss-manual-'));
process.env.OTA_DATA_DIR = TMP;
process.env.OTA_STOP_LOSS_ENABLED = 'true';
process.env.OTA_STOP_LOSS_MODE = 'monitor';
process.env.OTA_STOP_LOSS_WEBHOOK = '';
process.env.OTA_ADMIN_TOKENS = 'alice:tok-full,oncall:tok-halt:stop-loss';

const { applyHalt, restoreRollout } = await import('../services/ota/src/stop-loss.mjs');
const { readChannel, writeChannel } = await import('../services/ota/src/release-store.mjs');
const { ADMIN_TOKENS, hasScope, stopLossConfig } = await import(
  '../services/ota/src/config.mjs'
);
const { performAdminAction } = await import('../services/ota/src/admin.mjs');
const { recordEvent } = await import('../services/ota/src/metrics.mjs');

async function seedChannel(channel, releaseId, extra = {}) {
  await writeChannel(RV, channel, {
    channel,
    releaseId,
    updateId: `update-${releaseId}`,
    createdAt: new Date().toISOString(),
    previous: { releaseId: '1000', updateId: 'update-1000', createdAt: new Date().toISOString() },
    rollout: { percentage: 50, whitelist: ['u-1'], byPlatform: { ios: 30 }, updatedAt: null },
    ...extra,
  });
}

test('默认模式是 monitor，不会自动动作', () => {
  const prev = process.env.OTA_STOP_LOSS_MODE;
  delete process.env.OTA_STOP_LOSS_MODE;
  try {
    assert.equal(stopLossConfig().mode, 'monitor');
  } finally {
    if (prev === undefined) delete process.env.OTA_STOP_LOSS_MODE;
    else process.env.OTA_STOP_LOSS_MODE = prev;
  }
});

test('令牌 scope：未写第三段为全量，写了只给列出的', () => {
  const full = ADMIN_TOKENS.get('tok-full');
  assert.deepEqual(full, { label: 'alice', scopes: null });
  assert.equal(hasScope(full, 'release'), true, '全量令牌可发布');
  assert.equal(hasScope(full, 'stop-loss'), true);

  const oncall = ADMIN_TOKENS.get('tok-halt');
  assert.deepEqual(oncall, { label: 'oncall', scopes: ['stop-loss'] });
  assert.equal(hasScope(oncall, 'stop-loss'), true);
  assert.equal(hasScope(oncall, 'release'), false, '窄令牌不能发布');
  assert.equal(hasScope(oncall, 'rollout'), false);
});

test('人工止血：清零灰度、清白名单/平台覆盖，并快照原配置', async () => {
  await seedChannel('production', '2000');
  const result = await applyHalt(RV, 'production', {
    reason: 'manual-halt',
    operator: 'oncall',
    via: 'dashboard',
  });
  assert.equal(result.action, 'halt');

  const after = await readChannel(RV, 'production');
  assert.equal(after.rollout.percentage, 0);
  assert.deepEqual(after.rollout.whitelist, []);
  assert.equal(after.rollout.byPlatform, null);
  assert.equal(after.stopLoss.releaseId, '2000');
  assert.equal(after.stopLoss.operator, 'oncall');
  assert.equal(after.stopLoss.via, 'dashboard');
  assert.equal(after.stopLoss.previousRollout.percentage, 50);
  assert.deepEqual(after.stopLoss.previousRollout.whitelist, ['u-1']);
  assert.deepEqual(after.stopLoss.previousRollout.byPlatform, { ios: 30 });
});

test('重复止血不会把快照覆盖成 0%', async () => {
  await seedChannel('repeat', '2100', {
    rollout: { percentage: 80, whitelist: ['u-2'], byPlatform: null, updatedAt: null },
  });
  await applyHalt(RV, 'repeat', { operator: 'oncall' });
  const second = await applyHalt(RV, 'repeat', { operator: 'oncall' });
  assert.equal(second.action, 'skipped');
  assert.equal(second.reason, 'already-halted');

  const after = await readChannel(RV, 'repeat');
  assert.equal(after.stopLoss.previousRollout.percentage, 80, '快照应保持原始 80%');
});

test('恢复暂停前灰度：还原并清除止损状态', async () => {
  await seedChannel('beta', '3000', {
    rollout: {
      percentage: 20,
      whitelist: ['w-1', 'w-2'],
      byPlatform: { android: 10 },
      updatedAt: null,
    },
  });
  await applyHalt(RV, 'beta', { operator: 'oncall' });
  const restored = await restoreRollout(RV, 'beta', { operator: 'alice' });
  assert.equal(restored.percentage, 20);
  assert.equal(restored.whitelist, 2);

  const after = await readChannel(RV, 'beta');
  assert.equal(after.rollout.percentage, 20);
  assert.deepEqual(after.rollout.whitelist, ['w-1', 'w-2']);
  assert.deepEqual(after.rollout.byPlatform, { android: 10 });
  assert.equal(after.stopLoss, undefined);
});

test('恢复时若版本已变更则拒绝，避免把旧灰度套到新版本', async () => {
  await seedChannel('gamma', '4000');
  await applyHalt(RV, 'gamma', { operator: 'oncall' });
  const current = await readChannel(RV, 'gamma');
  await writeChannel(RV, 'gamma', { ...current, releaseId: '4999' });
  await assert.rejects(() => restoreRollout(RV, 'gamma'), /当前版本已变更/);
});

test('没有快照时恢复直接报错', async () => {
  await seedChannel('delta', '5000');
  await assert.rejects(() => restoreRollout(RV, 'delta'), /没有可恢复的暂停前灰度/);
});

test('evaluate-stop-loss 返回自动动作策略与样本缺口', async () => {
  await seedChannel('zeta', '7000');
  const now = new Date().toISOString();
  for (let i = 0; i < 2; i += 1) {
    await recordEvent(RV, {
      type: 'manifest',
      channel: 'zeta',
      status: 200,
      served: 'current',
      uid: `z-${i}`,
      releaseId: '7000',
      at: now,
    });
    await recordEvent(RV, {
      type: 'client-launch',
      channel: 'zeta',
      status: 200,
      uid: `z-${i}`,
      at: now,
    });
  }

  const result = await performAdminAction(
    { action: 'evaluate-stop-loss', channel: 'zeta', runtimeVersion: RV },
    { operator: 'tester', via: 'dashboard' },
  );
  assert.ok(result.message.includes('自动动作：仅监控'), '应说明当前策略');
  assert.ok(result.message.includes('样本不足'), '应说明样本不足');
  assert.ok(result.message.includes('启动 2/20（还差 18）'), '应给出启动样本缺口');
  assert.ok(result.message.includes('安装 0/20（还差 20）'), '应给出安装样本缺口');
});

test('admin halt-channel 走真止血语义并记录操作人', async () => {
  await seedChannel('epsilon', '6000');
  const result = await performAdminAction(
    { action: 'halt-channel', channel: 'epsilon', runtimeVersion: RV },
    { operator: 'oncall', via: 'dashboard', requestId: 'req-halt-1' },
  );
  assert.ok(result.message.includes('已紧急止血'));
  const after = await readChannel(RV, 'epsilon');
  assert.equal(after.rollout.percentage, 0);
  assert.equal(after.stopLoss.operator, 'oncall');
});
