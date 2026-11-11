import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RV = '1';
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-stop-loss-'));
process.env.OTA_DATA_DIR = TMP;
process.env.OTA_STOP_LOSS_ENABLED = 'true';
process.env.OTA_STOP_LOSS_MODE = 'halt';
process.env.OTA_STOP_LOSS_MIN_SAMPLES = '5';
process.env.OTA_STOP_LOSS_EMERGENCY_RATE = '0.5';
process.env.OTA_STOP_LOSS_INSTALL_FAIL_RATE = '0.5';
process.env.OTA_STOP_LOSS_WINDOW_MS = String(60 * 60 * 1000);
process.env.OTA_STOP_LOSS_COOLDOWN_MS = String(60 * 60 * 1000);
process.env.OTA_STOP_LOSS_CACHE_MS = '0';
process.env.OTA_STOP_LOSS_WEBHOOK = '';

const { evaluateChannelHealth, maybeStopLoss, resetStopLossCache } = await import(
  '../services/ota/src/stop-loss.mjs'
);
const { readChannel, writeChannel } = await import('../services/ota/src/release-store.mjs');
const { recordEvent } = await import('../services/ota/src/metrics.mjs');

async function seedChannel(channel, releaseId, extra = {}) {
  await writeChannel(RV, channel, {
    channel,
    releaseId,
    updateId: `update-${releaseId}`,
    createdAt: new Date().toISOString(),
    previous: { releaseId: '1000', updateId: 'update-1000', createdAt: new Date().toISOString() },
    rollout: { percentage: 100, whitelist: [], byPlatform: null, updatedAt: null },
    ...extra,
  });
}

async function seedEvents(channel, releaseId, { devices = 10, launches = 10, emergency = 8 } = {}) {
  const now = new Date().toISOString();
  for (let i = 0; i < devices; i += 1) {
    await recordEvent(RV, {
      type: 'manifest',
      channel,
      status: 200,
      served: 'current',
      uid: `u-${channel}-${i}`,
      releaseId,
      updateId: `update-${releaseId}`,
      at: now,
    });
  }
  for (let i = 0; i < launches; i += 1) {
    await recordEvent(RV, {
      type: 'client-launch',
      channel,
      status: 200,
      uid: `u-${channel}-${i % devices}`,
      emergency: i < emergency,
      embedded: i < emergency,
      at: now,
    });
  }
}

test('cohort 内应急启动率超阈值 -> halt', async () => {
  await seedChannel('production', '2000');
  await seedEvents('production', '2000');

  const health = await evaluateChannelHealth(RV, 'production');
  assert.equal(health.cohortSize, 10, 'cohort 应按被下发 current 的 uid 去重');
  assert.equal(health.launches, 10);
  assert.equal(health.emergency, 8);
  assert.equal(health.verdict, 'halt');
  assert.ok(health.reason.includes('launch-fail'), '原因应写明启动失败');
});

test('下载后实际运行的不是目标版本 -> fallback 计入止损', async () => {
  await seedChannel('fallback-ch', '7000');
  const now = new Date().toISOString();
  for (let i = 0; i < 6; i += 1) {
    await recordEvent(RV, {
      type: 'manifest',
      channel: 'fallback-ch',
      status: 200,
      served: 'current',
      uid: `f-${i}`,
      releaseId: '7000',
      at: now,
    });
    await recordEvent(RV, {
      type: 'client-launch',
      channel: 'fallback-ch',
      status: 500,
      uid: `f-${i}`,
      emergency: false,
      fallback: true,
      expectedUpdateId: 'update-7000',
      at: now,
    });
  }
  resetStopLossCache();

  const health = await evaluateChannelHealth(RV, 'fallback-ch');
  assert.equal(health.launches, 6);
  assert.equal(health.emergency, 0, '坏包回退不一定伴随 emergency 标志');
  assert.equal(health.fallback, 6);
  assert.equal(health.launchFailRate, 1);
  assert.equal(health.verdict, 'halt');
  assert.ok(health.reason.includes('fallback 6'));
});

test('halt 会清零灰度、清空白名单与平台覆盖，并记录幂等状态', async () => {
  await seedChannel('canary', '3000', {
    rollout: { percentage: 50, whitelist: ['u-keep'], byPlatform: { ios: 30 }, updatedAt: null },
  });
  await seedEvents('canary', '3000');
  resetStopLossCache();

  const result = await maybeStopLoss(RV, 'canary');
  assert.equal(result.action, 'halt');

  const after = await readChannel(RV, 'canary');
  assert.equal(after.rollout.percentage, 0, '应把灰度降到 0% 止血');
  assert.deepEqual(after.rollout.whitelist, [], '白名单必须清空，否则仍会命中坏包');
  assert.equal(after.rollout.byPlatform, null, '平台覆盖必须清除');
  assert.equal(after.stopLoss.releaseId, '3000');
  assert.equal(after.stopLoss.action, 'halt');

  // 冷却期内 / 同一版本重复评估不应再次动作。
  const again = await maybeStopLoss(RV, 'canary', { now: Date.now() });
  assert.equal(again.action, 'skipped');
});

test('monitor 模式只告警，不修改通道状态', async () => {
  process.env.OTA_STOP_LOSS_MODE = 'monitor';
  await seedChannel('beta', '4000');
  await seedEvents('beta', '4000');
  resetStopLossCache();

  const health = await evaluateChannelHealth(RV, 'beta');
  assert.equal(health.verdict, 'alert', '监控模式不应给出可执行判定');

  const result = await maybeStopLoss(RV, 'beta');
  assert.equal(result.action, null);

  const after = await readChannel(RV, 'beta');
  assert.equal(after.rollout.percentage, 100, '监控模式不得改动灰度');
  assert.equal(after.stopLoss, undefined);

  process.env.OTA_STOP_LOSS_MODE = 'halt';
});

test('安装失败率超阈值同样触发止损', async () => {
  await seedChannel('gamma', '5000');
  const now = new Date().toISOString();
  for (let i = 0; i < 6; i += 1) {
    await recordEvent(RV, {
      type: 'manifest',
      channel: 'gamma',
      status: 200,
      served: 'current',
      uid: `g-${i}`,
      releaseId: '5000',
      at: now,
    });
    await recordEvent(RV, {
      type: 'client-download',
      channel: 'gamma',
      status: 500,
      uid: `g-${i}`,
      at: now,
    });
  }
  resetStopLossCache();

  const health = await evaluateChannelHealth(RV, 'gamma');
  assert.equal(health.attempts, 6);
  assert.equal(health.fails, 6);
  assert.equal(health.verdict, 'halt');
  assert.ok(health.reason.includes('install-fail'));
});

test('未达最小样本不动作', async () => {
  await seedChannel('delta', '6000');
  await seedEvents('delta', '6000', { devices: 2, launches: 2, emergency: 2 });
  resetStopLossCache();

  const health = await evaluateChannelHealth(RV, 'delta');
  assert.equal(health.verdict, 'healthy');
  assert.equal(health.reason, 'insufficient-samples');

  const result = await maybeStopLoss(RV, 'delta');
  assert.equal(result.action, null);
});

test('未启用时直接跳过', async () => {
  process.env.OTA_STOP_LOSS_ENABLED = 'false';
  resetStopLossCache();
  const result = await maybeStopLoss(RV, 'production');
  assert.equal(result.verdict, 'disabled');
  process.env.OTA_STOP_LOSS_ENABLED = 'true';
});
