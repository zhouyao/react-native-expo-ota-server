import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-transfer-'));
process.env.OTA_DATA_DIR = dataDir;

const { aggregateMetrics, metricsFile } = await import('../services/ota/src/metrics.mjs');

const RV = '401';
const now = new Date().toISOString();

function event(extra) {
  return JSON.stringify({ at: now, ...extra });
}

async function seed() {
  const file = metricsFile(RV);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    [
      // gzip 完整包
      event({ type: 'asset', file: 'bundles/a.hbc', platform: null, status: 200, bytes: 1000, encoding: 'gzip' }),
      // 206 分片
      event({ type: 'asset', file: 'bundles/a.hbc', platform: null, status: 206, bytes: 300, range: true }),
      // 失败请求：没有响应体
      event({ type: 'asset', file: 'bundles/missing.hbc', platform: null, status: 404 }),
      // 差分包（独立口径，但字节要计入总流量）
      event({ type: 'asset-patch', platform: 'ios', file: 'bundles/b.hbc', status: 226, hit: true, patchSize: 100, fullSize: 2000, savedBytes: 1900 }),
      event({ type: 'manifest', platform: 'ios', status: 200, served: 'current' }),
    ].join('\n'),
  );
}

await seed();

test('下载流量汇总：区分原始 / gzip / 分片 / 补丁', async () => {
  const m = await aggregateMetrics(RV, { days: 7 });
  const t = m.transfer;

  assert.equal(t.requests, 4, '3 条 asset + 1 条 asset-patch');
  assert.equal(t.bytes, 1400, '1000 + 300 + 100，失败请求不计字节');
  assert.equal(t.rangeRequests, 1);
  assert.equal(t.uniqueFiles, 3);

  assert.deepEqual(t.byKind.gzip, { requests: 1, bytes: 1000 });
  assert.deepEqual(t.byKind.range, { requests: 1, bytes: 300 });
  assert.deepEqual(t.byKind.raw, { requests: 1, bytes: 0 });
  assert.deepEqual(t.byKind.patch, { requests: 1, bytes: 100 });

  assert.equal(t.byFile[0].file, 'bundles/a.hbc');
  assert.equal(t.byFile[0].requests, 2);
  assert.equal(t.byFile[0].bytes, 1300);

  // 原有口径不受影响
  assert.equal(m.assets, 3);
  assert.equal(m.errors, 1);
  assert.equal(m.patch.hits, 1);
});

test('平台筛选只统计该平台的流量', async () => {
  const m = await aggregateMetrics(RV, { days: 7, platform: 'ios' });
  // asset 事件由服务端产生，platform 为 null（unknown），因此只有补丁事件被计入
  assert.equal(m.transfer.requests, 1);
  assert.equal(m.transfer.bytes, 100);
  assert.deepEqual(m.transfer.byKind.patch, { requests: 1, bytes: 100 });
  assert.equal(m.transfer.byKind.gzip.requests, 0);
});

test('窗口外事件不计入', async () => {
  const file = metricsFile(RV);
  await fsp.appendFile(
    file,
    '\n' + JSON.stringify({
      at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      type: 'asset',
      file: 'bundles/old.hbc',
      status: 200,
      bytes: 9999,
    }),
  );
  const m = await aggregateMetrics(RV, { days: 7 });
  assert.equal(m.transfer.bytes, 1400, '30 天前的事件不应计入 7 天窗口');
  assert.ok(!m.transfer.byFile.some((item) => item.file === 'bundles/old.hbc'));
});

test('没有资源请求时返回零值结构', async () => {
  const m = await aggregateMetrics('402', { days: 7 });
  assert.deepEqual(m.transfer, {
    requests: 0,
    bytes: 0,
    rangeRequests: 0,
    uniqueFiles: 0,
    byKind: {
      raw: { requests: 0, bytes: 0 },
      gzip: { requests: 0, bytes: 0 },
      range: { requests: 0, bytes: 0 },
      patch: { requests: 0, bytes: 0 },
    },
    byFile: [],
  });
});

test.after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});
