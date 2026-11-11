import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-integrity-'));
process.env.OTA_DATA_DIR = dataDir;

const { scanOrphans, pruneOrphans } = await import('../services/ota/src/integrity.mjs');
const { readAudit } = await import('../services/ota/src/release-store.mjs');
const { embeddedDir, patchIndexPath, patchesDir } = await import(
  '../services/ota/src/patch-store.mjs'
);

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const RV = '301';
const A = '1700000000100';
const B = '1700000000200';

async function writeFile(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

async function setup() {
  const root = path.join(dataDir, RV);
  // release A：metadata 引用 a.hbc（.gz 副本按约定跟随），另有一个未被引用的孤儿文件
  await writeFile(
    path.join(root, A, 'bundles', 'a.hbc'),
    'a'.repeat(10),
  );
  await writeFile(path.join(root, A, 'bundles', 'a.hbc.gz'), 'z'.repeat(5));
  await writeFile(path.join(root, A, 'bundles', 'orphan-a.hbc'), 'o'.repeat(7));
  await writeFile(
    path.join(root, A, 'metadata.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000100',
      launchAssets: { ios: 'bundles/a.hbc' },
      assets: [],
      assetIndex: { 'bundles/a.hbc': { hash: 'h-a' } },
    }),
  );
  // release B
  await writeFile(path.join(root, B, 'bundles', 'b.hbc'), 'b'.repeat(20));
  await writeFile(
    path.join(root, B, 'metadata.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000200',
      launchAssets: { android: 'bundles/b.hbc' },
      assets: [],
      assetIndex: { 'bundles/b.hbc': { hash: 'h-b' } },
    }),
  );

  // 补丁库：索引只引用 keep.bsdiff，stale.bsdiff 是孤儿
  await writeFile(path.join(patchesDir(RV), 'keep.bsdiff'), 'BSDIFF40');
  await writeFile(path.join(patchesDir(RV), 'stale.bsdiff'), 'BSDIFF40!!');
  await fsp.writeFile(
    patchIndexPath(RV),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: {
        kept: {
          file: 'keep.bsdiff',
          basePath: `${A}/bundles/a.hbc`,
          targetPath: `${B}/bundles/b.hbc`,
          baseHash: 'h-a',
          targetHash: 'h-b',
        },
      },
    }),
  );

  // 内置包：记录引用 emb.hbc，orphan-emb.hbc 是孤儿
  await writeFile(path.join(embeddedDir(RV), 'record.json'), JSON.stringify({
    updateId: '00000000-0000-4000-8000-00000000aaaa',
    hash: 'h-emb',
    bundle: 'bundles/emb.hbc',
    platform: 'ios',
  }));
  await writeFile(path.join(embeddedDir(RV), 'bundles', 'emb.hbc'), 'e'.repeat(9));
  await writeFile(path.join(embeddedDir(RV), 'bundles', 'orphan-emb.hbc'), 'x'.repeat(3));
}

test('scanOrphans 找出未被任何版本 / 补丁 / 内置包引用的文件', async () => {
  await setup();
  const report = await scanOrphans(RV);

  assert.equal(report.safe, true);
  assert.equal(report.scannedReleases, 2);
  // file 相对于 runtimeVersion 目录，与 patches/*、embedded/* 的写法保持一致
  assert.deepEqual(
    report.releaseOrphans.map((item) => item.file),
    [`${A}/bundles/orphan-a.hbc`],
  );
  assert.deepEqual(report.patchOrphans.map((item) => item.file), ['patches/stale.bsdiff']);
  assert.deepEqual(
    report.embeddedOrphans.map((item) => item.file),
    ['embedded/bundles/orphan-emb.hbc'],
  );
  assert.equal(report.totalFiles, 3);
  assert.equal(report.totalBytes, 7 + 10 + 3);
  // 被引用的文件与 .gz 副本不得出现在孤儿列表
  const all = JSON.stringify(report);
  assert.ok(!all.includes('a.hbc.gz'), '.gz 副本应视为已引用');
  assert.ok(!all.includes('keep.bsdiff'));
});

test('缺少 metadata 的版本会让体检降级为不可清理', async () => {
  const rv = '302';
  const root = path.join(dataDir, rv);
  await writeFile(path.join(root, '1700000000300', 'bundles', 'no-meta.hbc'), 'n'.repeat(4));

  const report = await scanOrphans(rv);
  assert.equal(report.safe, false);
  assert.deepEqual(report.unreadableReleases, ['1700000000300']);
  assert.deepEqual(report.releaseOrphans, [], '无法解析的版本不参与孤儿判断');

  await assert.rejects(
    () => pruneOrphans(rv, report),
    /无法解析 metadata/,
  );
});

test('pruneOrphans 只删孤儿，写 system 审计', async () => {
  const report = await scanOrphans(RV);
  const result = await pruneOrphans(RV, report, { operator: 'tester', via: 'cli' });

  assert.equal(result.removed.length, 3);
  assert.equal(result.failed.length, 0);
  assert.equal(result.bytes, 7 + 10 + 3);

  const root = path.join(dataDir, RV);
  for (const file of [
    `${A}/bundles/orphan-a.hbc`,
    'patches/stale.bsdiff',
    'embedded/bundles/orphan-emb.hbc',
  ]) {
    await assert.rejects(fsp.access(path.join(root, file)), `${file} 应被删除`);
  }
  // 被引用文件必须保留
  for (const file of [`${A}/bundles/a.hbc`, `${A}/bundles/a.hbc.gz`, `${B}/bundles/b.hbc`, 'patches/keep.bsdiff', 'embedded/bundles/emb.hbc']) {
    await assert.doesNotReject(fsp.access(path.join(root, file)), `${file} 不应被删除`);
  }

  const audit = await readAudit(RV, { limit: 5 });
  const entry = audit.find((item) => item.action === 'gc');
  assert.ok(entry, '应写入 gc 审计');
  assert.equal(entry.channel, 'system');
  assert.equal(entry.params.orphansRemoved, 3);
  assert.equal(entry.params.orphanBytes, 20);

  // 再扫一次应为干净状态
  const again = await scanOrphans(RV);
  assert.equal(again.totalFiles, 0);
});
