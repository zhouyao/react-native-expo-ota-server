import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-patch-metrics-'));
process.env.OTA_DATA_DIR = dataDir;

const { aggregateMetrics, recentEvents, recordEvent } = await import(
  '../services/ota/src/metrics.mjs'
);
const { buildDashboardState } = await import('../services/ota/src/dashboard.mjs');

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const RV = '9';
const seed = [
  { type: 'manifest', channel: 'beta', status: 200, platform: 'ios', uid: 'u1' },
  { type: 'asset', channel: 'beta', status: 200, platform: 'android' },
  {
    type: 'asset-patch', channel: 'beta', status: 226, platform: 'ios',
    hit: true, reason: 'hit', patchSize: 100, fullSize: 1000, savedBytes: 900,
  },
  {
    type: 'asset-patch', channel: 'beta', status: 226, platform: 'android',
    hit: true, reason: 'hit', patchSize: 200, fullSize: 1000, savedBytes: 800,
  },
  {
    type: 'asset-patch', channel: 'beta', status: 200, platform: 'ios',
    hit: false, reason: 'base-missing',
  },
];
for (const event of seed) await recordEvent(RV, event);

test('差分事件不改变既有指标口径', async () => {
  const m = await aggregateMetrics(RV, { days: 7 });
  assert.equal(m.total, 2);
  assert.equal(m.manifests, 1);
  assert.equal(m.assets, 1);
  assert.equal(m.clientEvents, 0);
  assert.equal(m.errors, 0);
  assert.equal(m.uniqueUids, 1);
  assert.equal(m.byStatus[226], undefined, '226 不应混进旧状态码口径');
});

test('patch 聚合命中率、节省字节与回退原因', async () => {
  const m = await aggregateMetrics(RV, { days: 7 });
  const p = m.patch;
  assert.equal(p.requests, 3);
  assert.equal(p.hits, 2);
  assert.equal(p.fallbacks, 1);
  assert.equal(p.hitRate, 67);
  assert.equal(p.patchBytes, 300);
  assert.equal(p.fullBytes, 2000);
  assert.equal(p.savedBytes, 1700);
  assert.equal(p.savingRate, 85);
  assert.equal(p.reasons['base-missing'], 1);
  assert.equal(p.byChannel.beta.requests, 3);
  assert.equal(p.byDay.length, 1);
});

test('byPlatform 始终基于全量事件，汇总跟随平台筛选', async () => {
  const all = await aggregateMetrics(RV, { days: 7 });
  assert.equal(all.patch.byPlatform.ios.requests, 2);
  assert.equal(all.patch.byPlatform.ios.hits, 1);
  assert.equal(all.patch.byPlatform.android.requests, 1);
  assert.equal(all.patch.byPlatform.unknown.requests, 0);

  const ios = await aggregateMetrics(RV, { days: 7, platform: 'ios' });
  assert.equal(ios.patch.requests, 2);
  assert.equal(ios.patch.byPlatform.android.requests, 1);
  assert.equal(ios.patch.byChannel.beta.requests, 2);
});

test('事件页可按 asset-patch 类型筛选', async () => {
  const { items, total } = await recentEvents(RV, { type: 'asset-patch', limit: 10 });
  assert.equal(total, 3);
  assert.equal(items.length, 3);
  assert.ok(items.every((event) => event.type === 'asset-patch'));
});

test('看板状态透传差分指标与补丁库规模', async () => {
  const state = await buildDashboardState(RV);
  assert.equal(state.metrics.patch.requests, 3);
  assert.equal(state.stats.patchCount, 0);
  assert.equal(state.stats.patchBytes, 0);
});
