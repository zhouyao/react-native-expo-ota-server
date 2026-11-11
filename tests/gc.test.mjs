import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// config.mjs 在模块加载时解析 OTA_DATA_DIR，必须先设置再动态 import。
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-gc-'));
process.env.OTA_DATA_DIR = dataDir;

const { planGc, applyGc } = await import('../services/ota/src/gc.mjs');
const { auditFile, channelFile, listReleaseIds, releaseDir } = await import(
  '../services/ota/src/release-store.mjs'
);
const { patchIndexPath, patchesDir, readPatchIndex } = await import(
  '../services/ota/src/patch-store.mjs'
);

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.now();

/** 每个用例用独立 rv，避免进程内缓存与通道状态互相干扰。 */
async function makeRelease(rv, id, { bytes = 1024 } = {}) {
  const dir = releaseDir(rv, id);
  await fsp.mkdir(path.join(dir, 'bundles'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'bundles', `${id}.hbc`), Buffer.alloc(bytes, 7));
  await fsp.writeFile(
    path.join(dir, 'metadata.json'),
    JSON.stringify({
      id: `00000000-0000-4000-8000-${String(id).slice(-12)}`,
      createdAt: new Date(Number(id)).toISOString(),
      launchAssets: { ios: `bundles/${id}.hbc` },
      assetIndex: { [`bundles/${id}.hbc`]: { hash: `hash-${id}` } },
    }),
  );
  return dir;
}

async function writeChannel(rv, name, record) {
  await fsp.mkdir(path.dirname(channelFile(rv, name)), { recursive: true });
  await fsp.writeFile(
    channelFile(rv, name),
    JSON.stringify({ channel: name, ...record }),
  );
}

function idsFor(count, rv) {
  return Array.from({ length: count }, (_, index) =>
    String(BASE - Number(rv) - index * 2 * DAY),
  );
}

test('保护集：通道 current / previous、keep-last、keep-days', async () => {
  const rv = '101';
  const ids = idsFor(12, 101);
  for (const id of ids) await makeRelease(rv, id);
  await writeChannel(rv, 'production', {
    releaseId: ids[0],
    previous: { releaseId: ids[1] },
  });
  // 通道指针指向一个很老的版本：即使不在保留期，也不能回收。
  await writeChannel(rv, 'canary', { releaseId: ids[6] });

  const plan = await planGc(rv, { keepDays: 5, keepLast: 3, patchBases: 0 });
  const reasonsOf = (id) =>
    plan.protected.find((item) => item.releaseId === id)?.reasons || [];

  assert.deepEqual(reasonsOf(ids[0]).sort(), ['current:production', 'keep-days', 'keep-last']);
  assert.ok(reasonsOf(ids[1]).includes('previous:production'));
  assert.ok(reasonsOf(ids[6]).includes('current:canary'), '老版本只要仍是通道指针就受保护');
  assert.ok(reasonsOf(ids[2]).includes('keep-days'), '4 天前仍在 5 天保留期内');
  assert.equal(reasonsOf(ids[3]).length, 0, '6 天前已超出保留期');

  const candidates = plan.candidates.map((item) => item.releaseId);
  assert.deepEqual(
    candidates.sort(),
    [ids[3], ids[4], ids[5], ids[7], ids[8], ids[9], ids[10], ids[11]].sort(),
  );
  assert.equal(plan.total, 12);
  assert.ok(plan.reclaimableBytes > 0);
});

test('patch-base 作为独立保护规则', async () => {
  const rv = '102';
  const ids = idsFor(6, 102);
  for (const id of ids) await makeRelease(rv, id);

  const plan = await planGc(rv, { keepDays: 0, keepLast: 1, patchBases: 4 });
  const reasonsOf = (id) =>
    plan.protected.find((item) => item.releaseId === id)?.reasons || [];

  assert.ok(reasonsOf(ids[3]).includes('patch-base'), '最近 4 个版本要留给差分 base');
  assert.equal(reasonsOf(ids[4]).length, 0);
});

test('keepLast 至少保留 1 个，避免把最新版本也回收', async () => {
  const rv = '103';
  const ids = idsFor(3, 103);
  for (const id of ids) await makeRelease(rv, id);

  const plan = await planGc(rv, { keepDays: 0, keepLast: 0, patchBases: 0 });

  assert.deepEqual(
    plan.protected.map((item) => item.releaseId),
    [ids[0]],
  );
  assert.deepEqual(
    plan.candidates.map((item) => item.releaseId),
    [ids[1], ids[2]],
  );
});

test('planGc 只读：不删除任何目录', async () => {
  const rv = '104';
  const ids = idsFor(3, 104);
  for (const id of ids) await makeRelease(rv, id);

  const plan = await planGc(rv, { keepDays: 0, keepLast: 1, patchBases: 0 });
  assert.equal(plan.candidates.length, 2);

  for (const id of ids) {
    await assert.doesNotReject(fsp.access(releaseDir(rv, id)));
  }
});

test('applyGc 删除候选、返回释放体积并写审计', async () => {
  const rv = '105';
  const ids = idsFor(4, 105);
  for (const id of ids) await makeRelease(rv, id, { bytes: 2048 });

  const plan = await planGc(rv, { keepDays: 0, keepLast: 1, patchBases: 0 });
  const result = await applyGc(rv, plan, { operator: 'tester', via: 'test' });

  assert.equal(result.removed.length, 3);
  assert.equal(result.failed.length, 0);
  // 释放体积包含 metadata.json，因此与 plan 的口径比对，而不是只算 bundle。
  assert.equal(result.reclaimedBytes, plan.reclaimableBytes);
  assert.ok(result.reclaimedBytes >= 3 * 2048);
  assert.deepEqual(await listReleaseIds(rv), [ids[0]]);

  const audit = await fsp.readFile(auditFile(rv), 'utf8');
  const entry = audit
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((item) => item.action === 'gc');
  assert.ok(entry, '应写入 gc 审计');
  assert.equal(entry.channel, 'system', '全局动作不应被归到 production 通道');
  assert.equal(entry.operator, 'tester');
  assert.deepEqual(entry.params.releaseIds.sort(), [ids[1], ids[2], ids[3]].sort());
});

test('applyGc 二次校验：规划后被 promote 的版本跳过', async () => {
  const rv = '106';
  const ids = idsFor(3, 106);
  for (const id of ids) await makeRelease(rv, id);

  const plan = await planGc(rv, { keepDays: 0, keepLast: 1, patchBases: 0 });
  assert.ok(plan.candidates.some((item) => item.releaseId === ids[1]));

  // 规划与执行之间有人把这个版本提升为 current。
  await writeChannel(rv, 'production', { releaseId: ids[1] });

  const result = await applyGc(rv, plan);

  assert.deepEqual(result.removed.map((item) => item.releaseId), [ids[2]]);
  assert.deepEqual(result.skipped, [{ releaseId: ids[1], reason: 'no-longer-eligible' }]);
  await assert.doesNotReject(fsp.access(releaseDir(rv, ids[1])));
});

test('applyGc 联动补丁索引：清悬空条目与孤儿补丁文件', async () => {
  const rv = '107';
  const ids = idsFor(3, 107);
  for (const id of ids) await makeRelease(rv, id);
  await writeChannel(rv, 'production', {
    releaseId: ids[0],
    previous: { releaseId: ids[1] },
  });

  await fsp.mkdir(patchesDir(rv), { recursive: true });
  for (const name of ['stale.bsdiff', 'kept.bsdiff', 'orphan.bsdiff']) {
    await fsp.writeFile(path.join(patchesDir(rv), name), 'BSDIFF40');
  }
  await fsp.writeFile(
    patchIndexPath(rv),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: {
        stale: {
          file: 'stale.bsdiff',
          basePath: `${ids[0]}/bundles/a.hbc`,
          targetPath: `${ids[2]}/bundles/b.hbc`,
          baseHash: 'base-a',
          targetHash: 'target-b',
        },
        kept: {
          file: 'kept.bsdiff',
          basePath: `${ids[1]}/bundles/c.hbc`,
          targetPath: `${ids[0]}/bundles/d.hbc`,
          baseHash: 'base-c',
          targetHash: 'target-d',
        },
      },
    }),
  );

  const plan = await planGc(rv, { keepDays: 0, keepLast: 1, patchBases: 0 });
  assert.deepEqual(plan.patch.entriesToDrop, ['stale']);

  const result = await applyGc(rv, plan);
  assert.equal(result.patch.droppedEntries, 1);
  assert.equal(result.patch.droppedFiles, 2, 'stale.bsdiff 与孤儿都应被回收');

  const index = await readPatchIndex(rv);
  assert.deepEqual(Object.keys(index.entries), ['kept']);
  const left = await fsp.readdir(patchesDir(rv));
  assert.deepEqual(left.sort(), ['index.json', 'kept.bsdiff'].sort());
});

test('并发 applyGc 串行执行，不会重复删除或报错', async () => {
  const rv = '108';
  const ids = idsFor(5, 108);
  for (const id of ids) await makeRelease(rv, id);

  const plan = await planGc(rv, { keepDays: 0, keepLast: 1, patchBases: 0 });
  const [first, second] = await Promise.all([applyGc(rv, plan), applyGc(rv, plan)]);

  assert.equal(first.removed.length + second.removed.length, 4);
  assert.equal(first.failed.length + second.failed.length, 0);
  assert.deepEqual(await listReleaseIds(rv), [ids[0]]);
});

test('admin gc-releases 复用 CLI：预览、单条回收、拒绝受保护版本', async () => {
  const rv = '109';
  const ids = idsFor(3, 109);
  for (const id of ids) await makeRelease(rv, id);
  const { performAdminAction } = await import('../services/ota/src/admin.mjs');
  // 收窄保留策略，让 ids[1] / ids[2] 成为候选，ids[0] 由 keep-last 保护。
  const policy = { keepDays: 0, keepLast: 1, patchBases: 0 };

  const preview = await performAdminAction({
    action: 'gc-releases',
    runtimeVersion: rv,
    apply: false,
    ...policy,
  });
  assert.match(preview.message, /回收预览/);

  const applied = await performAdminAction({
    action: 'gc-releases',
    runtimeVersion: rv,
    apply: true,
    releaseIds: [ids[1]],
    ...policy,
  });
  assert.match(applied.message, /已回收 1 个版本/);
  assert.deepEqual(await listReleaseIds(rv), [ids[0], ids[2]]);

  // 受保护版本即使被显式指定也必须被服务端拒绝（前端禁用只是 UX）。
  await assert.rejects(
    performAdminAction({
      action: 'gc-releases',
      runtimeVersion: rv,
      apply: true,
      releaseIds: [ids[0]],
      ...policy,
    }),
    /受保护/,
  );
});
