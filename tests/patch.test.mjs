import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// config.mjs 在模块加载时解析 OTA_DATA_DIR，必须先设置再动态 import。
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-patch-'));
process.env.OTA_DATA_DIR = dataDir;

const store = await import('../services/ota/src/patch-store.mjs');
const { serveAsset } = await import('../services/ota/src/assets.mjs');
const { sha256Base64Url, sha256Hex } = await import('../services/ota/src/lib.mjs');

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const MAGIC = 'BSDIFF40';
const uuid = (prefix, rv) =>
  `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${String(rv).padStart(12, '0')}`;

function metadata(id, file, hash) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '1',
    platforms: ['ios', 'android'],
    launchAssets: { ios: file, android: file },
    assets: [],
    assetIndex: {
      [file]: { key: `key-${hash.slice(0, 6)}`, hash, contentType: 'application/javascript' },
    },
    metadata: { channel: 'development' },
  };
}

/** 每个用例用独立 rv，避免进程内索引缓存互相干扰。 */
async function setup(rv, options = {}) {
  const suffix = String(rv).padStart(12, '0');
  const uuidA = uuid('1', suffix);
  const uuidB = uuid('2', suffix);
  const bufA = Buffer.from(`AAA-${rv}-${'x'.repeat(64)}`);
  const bufB = Buffer.from(`BBB-${rv}-${'y'.repeat(64)}`);
  const hashA = sha256Base64Url(bufA);
  const hashB = sha256Base64Url(bufB);
  const dirA = path.join(dataDir, String(rv), '1000');
  const dirB = path.join(dataDir, String(rv), '2000');
  await fsp.mkdir(path.join(dirA, 'bundles'), { recursive: true });
  await fsp.mkdir(path.join(dirB, 'bundles'), { recursive: true });
  await fsp.writeFile(path.join(dirA, 'bundles/a.hbc'), bufA);
  await fsp.writeFile(path.join(dirB, 'bundles/b.hbc'), bufB);
  await fsp.writeFile(
    path.join(dirA, 'metadata.json'),
    JSON.stringify(metadata(uuidA, 'bundles/a.hbc', hashA)),
  );
  await fsp.writeFile(
    path.join(dirB, 'metadata.json'),
    JSON.stringify(metadata(uuidB, 'bundles/b.hbc', hashB)),
  );
  if (options.gzip) {
    const { gzipSync } = await import('node:zlib');
    await fsp.writeFile(path.join(dirB, 'bundles/b.hbc.gz'), gzipSync(bufB));
  }

  const patch = Buffer.concat([
    Buffer.from(MAGIC),
    Buffer.alloc(24, 7),
    Buffer.from('diff-payload'),
  ]);
  const patches = store.patchesDir(rv);
  await fsp.mkdir(patches, { recursive: true });
  const fileName = store.patchFileName(hashA, hashB);
  await fsp.writeFile(path.join(patches, fileName), patch);
  const entry = {
    file: fileName,
    baseHash: hashA,
    targetHash: hashB,
    baseUpdateId: uuidA,
    targetUpdateId: uuidB,
    platform: 'ios',
    baseKind: 'release',
    basePath: path.join('1000', 'bundles/a.hbc'),
    targetPath: path.join('2000', 'bundles/b.hbc'),
    baseSize: bufA.length,
    targetSize: bufB.length,
    targetGzipSize: options.targetGzipSize ?? 100000,
    patchSize: patch.length,
    sha256: sha256Hex(patch),
    beneficial: true,
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(
    store.patchIndexPath(rv),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: { [store.patchKey(hashA, hashB)]: entry },
    }),
  );
  store.invalidateBaseIndex(rv);
  store.invalidatePatchCache(rv);

  return {
    rv,
    uuidA,
    uuidB,
    bufA,
    bufB,
    hashA,
    hashB,
    patch,
    entry,
    fileName,
    fileB: 'bundles/b.hbc',
    releaseId: '2000',
  };
}

function patchHeaders(fixture, overrides = {}) {
  return {
    'a-im': 'bsdiff',
    'expo-current-update-id': fixture.uuidA,
    'expo-platform': 'ios',
    ...overrides,
  };
}

test('patchFileName / patchKey 基于内容哈希且稳定', () => {
  assert.equal(store.patchKey('aaa', 'bbb'), 'aaa:bbb');
  assert.equal(store.patchFileName('aaa', 'bbb'), store.patchFileName('aaa', 'bbb'));
  assert.notEqual(store.patchFileName('aaa', 'bbb'), store.patchFileName('bbb', 'aaa'));
  assert.match(store.patchFileName('aaa', 'bbb'), /^[0-9a-f]{32}\.bsdiff$/);
});

test('readPatchIndex 在索引缺失或版本不符时返回空索引', async () => {
  const empty = await store.readPatchIndex('missing-rv');
  assert.deepEqual(empty, store.emptyPatchIndex());
  await fsp.mkdir(store.patchesDir('bad-version'), { recursive: true });
  await fsp.writeFile(
    store.patchIndexPath('bad-version'),
    JSON.stringify({ version: 99, entries: {} }),
  );
  assert.deepEqual(await store.readPatchIndex('bad-version'), store.emptyPatchIndex());
});

test('findBase 按 updateId + platform 定位 release launchAsset', async () => {
  const f = await setup(1);
  const base = await store.findBase(f.rv, f.uuidA, 'ios');
  assert.equal(base.kind, 'release');
  assert.equal(base.hash, f.hashA);
  assert.equal(base.releaseId, '1000');
  assert.equal(await store.findBase(f.rv, 'not-a-uuid', 'ios'), null);
  assert.equal(await store.findBase(f.rv, f.uuidA, 'web'), null);
});

test('findPatch 与 isWorthIt 按收益阈值判定', async () => {
  const f = await setup(2);
  const hit = await store.findPatch(f.rv, f.hashA, f.hashB);
  assert.equal(hit.file, f.fileName);
  assert.equal(await store.findPatch(f.rv, f.hashB, f.hashA), null);
  assert.equal(store.isWorthIt(f.entry), true);
  assert.equal(store.isWorthIt({ ...f.entry, targetGzipSize: f.patch.length }), false);
  assert.equal(store.isWorthIt({ ...f.entry, patchSize: 0 }), false);
  assert.equal(store.isWorthIt({ ...f.entry, targetGzipSize: 0, targetSize: 0 }), false);
});

test('negotiatePatch 命中时返回 226 / IM / Expo-Base-Update-ID 与补丁', async () => {
  const f = await setup(3);
  const result = await store.negotiatePatch({
    runtimeVersion: f.rv,
    releaseId: f.releaseId,
    file: f.fileB,
    headers: patchHeaders(f),
  });
  assert.equal(result.kind, 'patch');
  assert.equal(result.response.status, 226);
  assert.equal(result.response.headers.im, 'bsdiff');
  assert.equal(result.response.headers['expo-base-update-id'], f.uuidA);
  assert.match(result.response.headers.vary, /a-im/);
  assert.match(result.response.headers['cache-control'], /no-store/);
  assert.equal(result.response.body.subarray(0, 8).toString('ascii'), MAGIC);
  assert.equal(result.meta.hit, true);
  assert.equal(result.meta.patchSize, f.patch.length);
  assert.ok(result.meta.savedBytes > 0);
});

test('negotiatePatch 在各类不满足条件时回退完整包并给出原因', async () => {
  const f = await setup(4);
  const baseArgs = { runtimeVersion: f.rv, releaseId: f.releaseId, file: f.fileB };
  const cases = [
    [{}, 'no-aim'],
    [{ 'a-im': 'br' }, 'no-aim'],
    [patchHeaders(f, { 'expo-current-update-id': 'invalid' }), 'invalid-base-id'],
    [patchHeaders(f, { 'expo-current-update-id': f.uuidB }), 'same-update'],
    [
      patchHeaders(f, { 'expo-current-update-id': uuid('9', String(f.rv).padStart(12, '0')) }),
      'base-missing',
    ],
  ];
  for (const [headers, reason] of cases) {
    const result = await store.negotiatePatch({ ...baseArgs, headers });
    assert.equal(result.kind, 'full', reason);
    assert.equal(result.meta.reason, reason, reason);
    assert.equal(result.meta.hit, false);
  }
  const nonLaunch = await store.negotiatePatch({
    ...baseArgs,
    file: 'bundles/missing.hbc',
    headers: patchHeaders(f),
  });
  assert.equal(nonLaunch.meta.reason, 'not-launch-asset');
});

test('negotiatePatch 收益不足或补丁损坏时回退', async () => {
  const poor = await setup(5, { targetGzipSize: 30 });
  const poorResult = await store.negotiatePatch({
    runtimeVersion: poor.rv,
    releaseId: poor.releaseId,
    file: poor.fileB,
    headers: patchHeaders(poor),
  });
  assert.equal(poorResult.meta.reason, 'not-beneficial');

  const broken = await setup(6);
  await fsp.writeFile(path.join(store.patchesDir(broken.rv), broken.fileName), 'broken');
  const brokenResult = await store.negotiatePatch({
    runtimeVersion: broken.rv,
    releaseId: broken.releaseId,
    file: broken.fileB,
    headers: patchHeaders(broken),
  });
  assert.equal(brokenResult.meta.reason, 'patch-corrupt');
});

test('serveAsset 补丁分支优先于 gzip，全量分支仍可校验 hash', async () => {
  const f = await setup(7, { gzip: true });
  const patched = await serveAsset({
    runtimeVersion: f.rv,
    releaseId: f.releaseId,
    file: f.fileB,
    acceptEncoding: 'gzip',
    headers: patchHeaders(f),
  });
  assert.equal(patched.status, 226);
  assert.equal(patched.encoding, undefined);
  assert.equal(patched.headers['content-encoding'], undefined);
  assert.equal(patched.patch.hit, true);
  assert.match(patched.headers.vary, /accept-encoding/);

  const full = await serveAsset({
    runtimeVersion: f.rv,
    releaseId: f.releaseId,
    file: f.fileB,
    acceptEncoding: 'identity',
    headers: {},
  });
  assert.equal(full.status, 200);
  assert.equal(full.patch, undefined);
  assert.equal(full.body.toString(), f.bufB.toString());
  assert.match(full.headers['cache-control'], /immutable/);
  assert.match(full.headers.vary, /a-im/);

  const gz = await serveAsset({
    runtimeVersion: f.rv,
    releaseId: f.releaseId,
    file: f.fileB,
    acceptEncoding: 'gzip',
    headers: {},
  });
  assert.equal(gz.status, 200);
  assert.equal(gz.encoding, 'gzip');
});

test('内置包 base 可通过 Expo-Embedded-Update-ID 命中（首装差分）', async () => {
  const f = await setup(8);
  const suffix = String(f.rv).padStart(12, '0');
  const uuidE = uuid('3', suffix);
  const bufE = Buffer.from(`EMBEDDED-${f.rv}-${'z'.repeat(64)}`);
  const hashE = sha256Base64Url(bufE);
  const embedded = store.embeddedDir(f.rv);
  await fsp.mkdir(path.join(embedded, 'bundles'), { recursive: true });
  await fsp.writeFile(path.join(embedded, 'bundles/e.hbc'), bufE);
  await fsp.writeFile(
    path.join(embedded, `${uuidE}.json`),
    JSON.stringify({
      updateId: uuidE,
      platform: 'ios',
      channel: 'development',
      runtimeVersion: String(f.rv),
      bundle: 'bundles/e.hbc',
      hash: hashE,
      size: bufE.length,
      commitTime: 1,
      registeredAt: new Date().toISOString(),
    }),
  );

  const fileName = store.patchFileName(hashE, f.hashB);
  const patch = Buffer.concat([Buffer.from(MAGIC), Buffer.alloc(24, 3), Buffer.from('embedded-diff')]);
  await fsp.writeFile(path.join(store.patchesDir(f.rv), fileName), patch);
  const index = await store.readPatchIndex(f.rv);
  index.entries[store.patchKey(hashE, f.hashB)] = {
    ...f.entry,
    file: fileName,
    baseHash: hashE,
    baseUpdateId: uuidE,
    baseKind: 'embedded',
    basePath: path.join('embedded', 'bundles/e.hbc'),
    baseSize: bufE.length,
    patchSize: patch.length,
    sha256: sha256Hex(patch),
  };
  await store.writePatchIndex(f.rv, index);
  store.invalidateBaseIndex(f.rv);

  const base = await store.findBase(f.rv, uuidE, 'ios');
  assert.equal(base.kind, 'embedded');
  assert.equal(base.hash, hashE);

  const result = await store.negotiatePatch({
    runtimeVersion: f.rv,
    releaseId: f.releaseId,
    file: f.fileB,
    headers: { 'a-im': 'bsdiff', 'expo-embedded-update-id': uuidE },
  });
  assert.equal(result.kind, 'patch');
  assert.equal(result.response.headers['expo-base-update-id'], uuidE);
  assert.equal(result.meta.baseKind, 'embedded');
});

test('patchStats 汇总补丁库规模与按目标产物分布', async () => {
  const f = await setup(9);
  const stats = await store.patchStats(f.rv);
  assert.equal(stats.totalCount, 1);
  assert.equal(stats.totalBytes, f.patch.length);
  assert.equal(stats.byTargetHash[f.hashB].count, 1);
  assert.equal(stats.byPlatform.ios.count, 1);
});

test('226 IM Used 可作为真实 HTTP 响应返回且保留全部协商头', async () => {
  const f = await setup(10);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const response = await serveAsset({
      runtimeVersion: url.searchParams.get('rv'),
      releaseId: url.searchParams.get('release'),
      file: url.searchParams.get('file'),
      acceptEncoding: req.headers['accept-encoding'] || '',
      headers: req.headers,
    });
    res.writeHead(response.status, {
      'content-length': String(response.body.length),
      ...response.headers,
    });
    res.end(response.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const url = `http://127.0.0.1:${port}/api/assets?rv=${f.rv}&release=${f.releaseId}&file=${f.fileB}`;
    const patched = await fetch(url, { headers: patchHeaders(f) });
    assert.equal(patched.status, 226);
    assert.equal(patched.ok, true);
    assert.equal(patched.headers.get('im'), 'bsdiff');
    assert.equal(patched.headers.get('expo-base-update-id'), f.uuidA);
    assert.match(patched.headers.get('vary'), /a-im/);
    assert.equal(patched.headers.get('cache-control'), 'private, no-store');
    const body = Buffer.from(await patched.arrayBuffer());
    assert.equal(body.subarray(0, 8).toString('ascii'), MAGIC);

    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal((await full.text()), f.bufB.toString());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OTA_PATCH_ENABLED=0 时强制回退完整包', async () => {
  const f = await setup(11);
  process.env.OTA_PATCH_ENABLED = '0';
  try {
    const result = await store.negotiatePatch({
      runtimeVersion: f.rv,
      releaseId: f.releaseId,
      file: f.fileB,
      headers: patchHeaders(f),
    });
    assert.equal(result.kind, 'full');
    assert.equal(result.meta.reason, 'disabled');
  } finally {
    delete process.env.OTA_PATCH_ENABLED;
  }
});
