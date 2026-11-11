import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-gc-settings-'));
process.env.OTA_DATA_DIR = TMP;
process.env.OTA_GC_ENABLED = 'true';
process.env.OTA_GC_KEEP_DAYS = '14';
process.env.OTA_GC_KEEP_LAST = '10';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  GC_KEEP_LAST_MIN,
  clearGcOverrideCache,
  gcConfig,
  gcOverrideFile,
  readGcOverride,
  writeGcOverride,
} = await import('../services/ota/src/config.mjs');
const { buildDashboardState } = await import('../services/ota/src/dashboard.mjs');
const { performAdminAction } = await import('../services/ota/src/admin.mjs');
const { readAudit } = await import('../services/ota/src/release-store.mjs');

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

test('覆盖文件位于数据目录 system/ 下', () => {
  assert.ok(gcOverrideFile().endsWith(path.join('system', 'gc.json')));
});

test('未写入覆盖时使用环境变量', () => {
  clearGcOverrideCache();
  assert.equal(readGcOverride(), null);
  const cfg = gcConfig();
  assert.equal(cfg.keepDays, 14);
  assert.equal(cfg.keepLast, 10);
  assert.equal(cfg.mode, 'dry-run');
  assert.deepEqual(cfg.overridden, { keepDays: false, keepLast: false, mode: false });
});

test('控制台覆盖保留策略后优先于环境变量', async () => {
  await writeGcOverride({ keepDays: 30, keepLast: 5 }, { operator: 'tester' });
  const cfg = gcConfig();
  assert.equal(cfg.keepDays, 30);
  assert.equal(cfg.keepLast, 5);
  assert.equal(cfg.overridden.keepDays, true);
  assert.equal(cfg.overridden.keepLast, true);
  assert.equal(cfg.mode, 'dry-run', '未覆盖的模式仍用环境变量');
  assert.equal(cfg.overridden.mode, false);
});

test('执行模式可覆盖', async () => {
  await writeGcOverride({ mode: 'apply' });
  const cfg = gcConfig();
  assert.equal(cfg.mode, 'apply');
  assert.equal(cfg.overridden.mode, true);

  await writeGcOverride({ mode: 'dry-run' });
  assert.equal(gcConfig().mode, 'dry-run');
});

test('非法值被拒绝', async () => {
  await assert.rejects(() => writeGcOverride({ keepLast: GC_KEEP_LAST_MIN - 1 }), /最少保留版本数/);
  await assert.rejects(() => writeGcOverride({ keepLast: 0 }), /最少保留版本数/);
  await assert.rejects(() => writeGcOverride({ keepLast: 2.5 }), /最少保留版本数/);
  await assert.rejects(() => writeGcOverride({ keepLast: 1001 }), /最少保留版本数/);
  await assert.rejects(() => writeGcOverride({ keepDays: -1 }), /保留天数/);
  await assert.rejects(() => writeGcOverride({ keepDays: 1.5 }), /保留天数/);
  await assert.rejects(() => writeGcOverride({ keepDays: 3651 }), /保留天数/);
  await assert.rejects(() => writeGcOverride({ mode: 'halt' }), /执行模式/);
});

test('未开启 OTA_GC_ENABLED 时不能切执行模式，读取也强制 dry-run', async () => {
  process.env.OTA_GC_ENABLED = 'false';
  try {
    await assert.rejects(() => writeGcOverride({ mode: 'apply' }), /OTA_GC_ENABLED/);
  } finally {
    process.env.OTA_GC_ENABLED = 'true';
  }

  // 先写一个 apply，再把开关关掉：读取时必须回落成 dry-run，避免「打开开关就真删」。
  await writeGcOverride({ mode: 'apply' });
  process.env.OTA_GC_ENABLED = 'false';
  try {
    const cfg = gcConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mode, 'dry-run');
    assert.equal(cfg.overridden.mode, false);
  } finally {
    process.env.OTA_GC_ENABLED = 'true';
  }
});

test('admin set-gc-config 持久化并写 system 审计', async () => {
  const result = await performAdminAction(
    { action: 'set-gc-config', runtimeVersion: '1', keepDays: 21, keepLast: 6, gcMode: 'apply' },
    { operator: 'tester', via: 'dashboard', requestId: 'req-gc-1' },
  );
  assert.ok(result.message.includes('保留 21 天'));
  assert.ok(result.message.includes('最少 6 个版本'));
  assert.ok(result.message.includes('执行'));

  const cfg = gcConfig();
  assert.equal(cfg.keepDays, 21);
  assert.equal(cfg.keepLast, 6);
  assert.equal(cfg.mode, 'apply');

  const audit = await readAudit('1', { limit: 10 });
  const entry = audit.find((item) => item.action === 'set-gc-config');
  assert.ok(entry, '应写一条 set-gc-config 审计');
  assert.equal(entry.channel, 'system', '全局动作不应归到 production 通道');
  assert.equal(entry.params.keepDays, 21);
  assert.equal(entry.params.mode, 'apply');
});

test('admin set-gc-config 的非法值会作为错误返回', async () => {
  await assert.rejects(
    () =>
      performAdminAction(
        { action: 'set-gc-config', runtimeVersion: '1', keepLast: 2 },
        { operator: 'tester' },
      ),
    /最少保留版本数/,
  );
});

test('看板 state 暴露回收设置与上次执行信息', async () => {
  const state = await buildDashboardState('', {}, {
    gc: { lastRunAt: '2026-01-01T00:00:00.000Z', lastCandidates: 3, lastRemoved: 2, lastBytes: 2048 },
  });
  assert.equal(state.gc.enabled, true);
  assert.equal(state.gc.mode, 'apply');
  assert.equal(state.gc.keepDays, 21);
  assert.equal(state.gc.keepLast, 6);
  assert.ok(state.gc.intervalMs >= 60_000);
  assert.ok(state.gc.patchBases >= 1);
  assert.equal(state.gc.lastCandidates, 3);
  assert.equal(state.gc.lastRemoved, 2);
  assert.equal(state.gc.lastBytes, 2048);
  assert.equal(state.gc.overridden.keepDays, true);
});

test('CLI 未显式传参时沿用控制台覆盖值', async () => {
  const rv = '201';
  for (const id of [1700000000100, 1700000000200, 1700000000300]) {
    const dir = path.join(TMP, rv, String(id));
    await fsp.mkdir(path.join(dir, 'bundles'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'bundles', 'b.hbc'), 'x');
    await fsp.writeFile(
      path.join(dir, 'metadata.json'),
      JSON.stringify({ id: `00000000-0000-4000-8000-${String(id).slice(-12)}` }),
    );
  }
  await writeGcOverride({ keepDays: 0, keepLast: 9 });

  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'gc.mjs'), '--rv', rv],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /keep-days 0d \/ keep-last 9/, 'CLI 应读取覆盖后的保留策略');
});
