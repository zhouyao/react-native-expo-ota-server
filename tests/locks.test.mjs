import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fingerprintRequest,
  recallRequest,
  rememberRequest,
  resetIdempotency,
  withLock,
} from '../services/ota/src/locks.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lockFileFor(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-lock-'));
  return path.join(dir, `${name}.lock`);
}

test('同一 key 的并发任务串行执行', async () => {
  const lockFile = await lockFileFor('serial');
  const order = [];
  await Promise.all([
    withLock('serial-key', lockFile, async () => {
      order.push('a-start');
      await sleep(50);
      order.push('a-end');
    }),
    withLock('serial-key', lockFile, async () => {
      order.push('b-start');
      await sleep(10);
      order.push('b-end');
    }),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('锁被占用且超时后报错', async () => {
  const lockFile = await lockFileFor('timeout');
  await fsp.writeFile(lockFile, JSON.stringify({ pid: process.pid }), 'utf8');
  await assert.rejects(
    () =>
      withLock('timeout-key', lockFile, async () => 'never', {
        timeout: 120,
        staleMs: 60_000,
      }),
    /发布锁被占用/,
  );
  await fsp.rm(lockFile, { force: true });
});

test('任务抛错后锁文件被释放，后续任务可继续', async () => {
  const lockFile = await lockFileFor('release');
  await assert.rejects(
    withLock('release-key', lockFile, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const result = await withLock('release-key', lockFile, async () => 'ok');
  assert.equal(result, 'ok');
});

test('幂等缓存命中与清理', () => {
  resetIdempotency();
  const key = fingerprintRequest({ action: 'set-rollout', percentage: 20 });
  assert.equal(recallRequest(key), null);
  rememberRequest(key, { ok: true });
  assert.deepEqual(recallRequest(key), { ok: true });
  assert.equal(recallRequest('missing'), null);
  resetIdempotency();
  assert.equal(recallRequest(key), null);
});
