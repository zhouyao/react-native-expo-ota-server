import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// config.mjs 在模块加载时解析 OTA_DATA_DIR，必须先设置再动态 import。
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-metrics-'));
process.env.OTA_DATA_DIR = dataDir;

const {
  aggregateMetrics,
  metricsFile,
  normalizePlatform,
  platformKey,
  recentEvents,
  recordEvent,
} = await import('../services/ota/src/metrics.mjs');
const { buildDashboardState } = await import('../services/ota/src/dashboard.mjs');

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const RV = '1';

const seedEvents = [
  { type: 'manifest', channel: 'beta', status: 200, uid: 'u-ios-1', served: 'current', updateId: 'up-1', platform: 'ios' },
  { type: 'client-launch', channel: 'beta', status: 200, uid: 'u-ios-1', platform: 'ios' },
  { type: 'manifest', channel: 'beta', status: 404, uid: 'u-ios-2', served: 'previous', platform: 'ios' },
  { type: 'manifest', channel: 'beta', status: 200, uid: 'u-and-1', served: 'current', updateId: 'up-1', platform: 'android' },
  { type: 'asset', channel: 'beta', status: 200, platform: 'android' },
  // 早期无 platform 字段的事件：归入 unknown，而不是被丢掉。
  { type: 'client-error', channel: 'beta', status: 500, uid: 'u-unknown' },
];
for (const event of seedEvents) await recordEvent(RV, event);

test('platformKey / normalizePlatform 归一化', () => {
  assert.equal(platformKey({ platform: 'ios' }), 'ios');
  assert.equal(platformKey({ platform: 'Android' }), 'unknown');
  assert.equal(platformKey({}), 'unknown');
  assert.equal(normalizePlatform('ios'), 'ios');
  assert.equal(normalizePlatform(' ANDROID '), 'android');
  assert.equal(normalizePlatform('unknown'), 'unknown');
  assert.equal(normalizePlatform('web'), '');
  assert.equal(normalizePlatform(null), '');
});

test('byPlatform 分组：事件数、错误、设备去重、命中分布与版本分布', async () => {
  const m = await aggregateMetrics(RV, { days: 7 });
  assert.equal(m.total, 6);
  assert.equal(m.manifests, 3);
  assert.equal(m.assets, 1);
  assert.equal(m.clientEvents, 2);
  assert.equal(m.errors, 2);
  assert.equal(m.uniqueUids, 4);
  assert.equal(m.byChannel.beta.total, 5); // asset 不计入 byChannel，沿用旧口径

  const ios = m.byPlatform.ios;
  assert.equal(ios.total, 3);
  assert.equal(ios.manifests, 2);
  assert.equal(ios.errors, 1);
  assert.equal(ios.uniqueUids, 2);
  assert.equal(ios.byServed.current, 1);
  assert.equal(ios.byServed.previous, 1);
  assert.equal(ios.byStatus[404], 1);
  assert.equal(ios.versions['up-1'], 1);
  assert.equal(ios.byDay.length, 1);
  assert.equal(ios.byDay[0].total, 2);
  assert.equal(ios.byChannel.beta.uniqueUids, 2);

  assert.equal(m.byPlatform.android.total, 2);
  assert.equal(m.byPlatform.android.manifests, 1);
  assert.equal(m.byPlatform.android.assets, 1);
  assert.equal(m.byPlatform.android.uniqueUids, 1);
  assert.equal(m.byPlatform.android.byChannel.beta.manifests, 1);
  assert.equal(m.byPlatform.android.byChannel.beta.uniqueUids, 1);

  assert.equal(m.byPlatform.unknown.total, 1);
  assert.equal(m.byPlatform.unknown.clientEvents, 1);
  assert.equal(m.byPlatform.unknown.errors, 1);
  assert.equal(m.byPlatform.unknown.byChannel.beta.uniqueUids, 1);
});

test('platform 筛选后原有字段只统计该平台，byPlatform 仍基于全量事件', async () => {
  const filtered = await aggregateMetrics(RV, { days: 7, platform: 'ios' });
  assert.equal(filtered.platform, 'ios');
  assert.equal(filtered.total, 3);
  assert.equal(filtered.manifests, 2);
  assert.equal(filtered.errors, 1);
  assert.equal(filtered.uniqueUids, 2);
  assert.equal(filtered.byServed.current, 1);
  assert.equal(filtered.byServed.previous, 1);
  assert.equal(filtered.byChannel.beta.total, 3);

  const all = await aggregateMetrics(RV, { days: 7 });
  assert.equal(filtered.byPlatform.android.total, all.byPlatform.android.total);
  assert.equal(filtered.byPlatform.unknown.total, all.byPlatform.unknown.total);

  const android = await aggregateMetrics(RV, { days: 7, platform: 'android' });
  assert.equal(android.total, 2);
  assert.equal(android.assets, 1);
  const unknown = await aggregateMetrics(RV, { days: 7, platform: 'unknown' });
  assert.equal(unknown.total, 1);
  assert.equal(unknown.errors, 1);
});

test('recentEvents 支持 platform 过滤并可与其它条件组合', async () => {
  assert.equal((await recentEvents(RV, {})).total, 6);
  const android = await recentEvents(RV, { platform: 'android' });
  assert.equal(android.total, 2);
  assert.ok(android.items.every((event) => event.platform === 'android'));
  const unknown = await recentEvents(RV, { platform: 'unknown' });
  assert.equal(unknown.total, 1);
  const combined = await recentEvents(RV, { platform: 'ios', type: 'manifest' });
  assert.equal(combined.total, 2);
  assert.equal((await recentEvents(RV, { platform: 'web' })).total, 6);
});

test('轮转出去的 events.jsonl.<ts> 仍参与聚合与事件查询', async () => {
  const file = metricsFile('2');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    `${file}.1700000000000`,
    `${JSON.stringify({
      at: new Date().toISOString(),
      type: 'manifest',
      channel: 'beta',
      status: 200,
      uid: 'u-rot',
      served: 'current',
      platform: 'ios',
    })}\n`,
  );
  await recordEvent('2', {
    type: 'client-launch',
    channel: 'beta',
    status: 200,
    uid: 'u-new',
    platform: 'android',
  });

  const m = await aggregateMetrics('2', { days: 7 });
  assert.equal(m.total, 2);
  assert.equal(m.byPlatform.ios.manifests, 1);
  assert.equal(m.byPlatform.android.clientEvents, 1);

  const events = await recentEvents('2', {});
  assert.equal(events.total, 2);
  // 轮转文件在前、主文件在后，倒序后主文件的新事件排第一。
  assert.equal(events.items[0].platform, 'android');
  assert.equal(events.items[1].platform, 'ios');
});

test('eventsPlatform 只过滤事件流，指标仍为全量口径', async () => {
  const state = await buildDashboardState(RV, {
    eventsPlatform: 'android',
    eventsLimit: 50,
    eventsOffset: 0,
  });
  assert.equal(state.platform, '');
  assert.equal(state.metrics.total, 6);
  assert.equal(state.metrics.byPlatform.android.total, 2);
  assert.ok(state.events.length > 0);
  assert.ok(state.events.every((event) => event.platform === 'android'));
  assert.equal(state.eventsQuery.platform, 'android');
});

test('全局 platform 收敛指标，eventsPlatform 优先于它过滤事件', async () => {
  const scoped = await buildDashboardState(RV, {
    platform: 'ios',
    eventsLimit: 50,
    eventsOffset: 0,
  });
  assert.equal(scoped.platform, 'ios');
  assert.equal(scoped.metrics.total, 3);
  assert.ok(scoped.events.every((event) => event.platform === 'ios'));

  const mixed = await buildDashboardState(RV, {
    platform: 'ios',
    eventsPlatform: 'android',
    eventsLimit: 50,
    eventsOffset: 0,
  });
  assert.equal(mixed.metrics.total, 3, '指标仍按全局 platform 收敛');
  assert.ok(mixed.events.every((event) => event.platform === 'android'));
});
