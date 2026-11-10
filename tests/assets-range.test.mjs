import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// config.mjs 在模块加载时解析 OTA_DATA_DIR，必须先设置再动态 import。
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-range-'));
process.env.OTA_DATA_DIR = dataDir;

const lib = await import('../services/ota/src/lib.mjs');
const { serveAsset } = await import('../services/ota/src/assets.mjs');
const { handle } = await import('../services/ota/src/server.mjs');

const RV = 'range-rv';
const RELEASE = '1000';
const FILE = 'bundles/app.hbc';
const CONTENT = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const SIZE = CONTENT.length;

const assetDir = path.join(dataDir, RV, RELEASE, 'bundles');
await fsp.mkdir(assetDir, { recursive: true });
await fsp.writeFile(path.join(assetDir, 'app.hbc'), CONTENT);
await fsp.writeFile(path.join(assetDir, 'app.hbc.gz'), gzipSync(CONTENT));

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function args(overrides = {}) {
  return {
    runtimeVersion: RV,
    releaseId: RELEASE,
    file: FILE,
    acceptEncoding: '',
    headers: {},
    ...overrides,
  };
}

async function readBody(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body) || typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('parseByteRange 解析闭区间、开区间、尾部区间并截断越界 end', () => {
  assert.deepEqual(lib.parseByteRange('bytes=0-9', SIZE), {
    kind: 'range',
    start: 0,
    end: 9,
  });
  assert.deepEqual(lib.parseByteRange('bytes=10-', SIZE), {
    kind: 'range',
    start: 10,
    end: SIZE - 1,
  });
  assert.deepEqual(lib.parseByteRange('bytes=-5', SIZE), {
    kind: 'range',
    start: SIZE - 5,
    end: SIZE - 1,
  });
  assert.deepEqual(lib.parseByteRange('bytes=0-999', SIZE), {
    kind: 'range',
    start: 0,
    end: SIZE - 1,
  });
  assert.deepEqual(lib.parseByteRange(`bytes=-${SIZE + 10}`, SIZE), {
    kind: 'range',
    start: 0,
    end: SIZE - 1,
  });
  assert.equal(lib.parseByteRange('BYTES=2-3', SIZE).kind, 'range');
  assert.equal(lib.parseByteRange('bytes=0-0', 1).kind, 'range');
});

test('parseByteRange 区分不可满足与不支持的语法', () => {
  for (const value of [
    `bytes=${SIZE}-`,
    `bytes=${SIZE + 5}-${SIZE + 9}`,
    'bytes=9-3',
    'bytes=-0',
    `bytes=${Number.MAX_SAFE_INTEGER}1-`,
  ]) {
    assert.equal(lib.parseByteRange(value, SIZE).kind, 'unsatisfiable', value);
  }
  assert.equal(lib.parseByteRange('bytes=0-9', 0).kind, 'unsatisfiable');
  for (const value of [
    '',
    'items=0-9',
    'bytes=0-9,20-29',
    'bytes=-',
    'garbage',
  ]) {
    assert.equal(lib.parseByteRange(value, SIZE).kind, 'ignore', value);
  }
});

test('ifRangeMatches 只接受强 ETag 或未变更的 HTTP-date', () => {
  const validator = {
    etag: '"abc-123"',
    lastModified: 'Wed, 11 Nov 2026 00:00:00 GMT',
  };
  assert.equal(lib.ifRangeMatches('', validator), true);
  assert.equal(lib.ifRangeMatches('"abc-123"', validator), true);
  assert.equal(lib.ifRangeMatches('"other"', validator), false);
  assert.equal(lib.ifRangeMatches('W/"abc-123"', validator), false);
  assert.equal(lib.ifRangeMatches('Wed, 11 Nov 2026 00:00:00 GMT', validator), true);
  assert.equal(lib.ifRangeMatches('Thu, 12 Nov 2026 00:00:00 GMT', validator), true);
  assert.equal(lib.ifRangeMatches('Tue, 10 Nov 2026 00:00:00 GMT', validator), false);
  assert.equal(lib.ifRangeMatches('not-a-date', validator), false);
});

test('普通下载返回 200 并声明 Accept-Ranges / ETag / Last-Modified / Vary', async () => {
  const res = await serveAsset(args());
  assert.equal(res.status, 200);
  assert.deepEqual(await readBody(res.body), CONTENT);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-length'], String(SIZE));
  assert.match(res.headers.etag, /^".+"$/);
  assert.match(res.headers['last-modified'], /GMT$/);
  assert.match(res.headers.vary, /range/);
  assert.match(res.headers.vary, /accept-encoding/);
  assert.match(res.headers['cache-control'], /immutable/);
});

test('206 返回单区间片段、Content-Range 与准确 Content-Length', async () => {
  const cases = [
    ['bytes=0-9', 0, 9],
    ['bytes=10-', 10, SIZE - 1],
    ['bytes=-5', SIZE - 5, SIZE - 1],
    ['bytes=0-999', 0, SIZE - 1],
  ];
  for (const [range, start, end] of cases) {
    const res = await serveAsset(args({ headers: { range } }));
    assert.equal(res.status, 206, range);
    assert.equal(res.range.size, SIZE, range);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${SIZE}`, range);
    assert.equal(res.headers['content-length'], String(end - start + 1), range);
    assert.equal(res.headers['accept-ranges'], 'bytes', range);
    assert.match(res.headers.vary, /range/, range);
    assert.equal(res.headers['content-encoding'], undefined, range);
    assert.deepEqual(await readBody(res.body), CONTENT.subarray(start, end + 1), range);
  }
});

test('不可满足的范围返回 416 与 bytes */size', async () => {
  const res = await serveAsset(args({ headers: { range: `bytes=${SIZE + 10}-` } }));
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], `bytes */${SIZE}`);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('Range 请求绕过 gzip 与 A-IM 差分，只服务原始字节', async () => {
  const res = await serveAsset(
    args({
      acceptEncoding: 'gzip',
      headers: {
        range: 'bytes=0-9',
        'a-im': 'bsdiff',
        'expo-current-update-id': '11111111-1111-4111-8111-111111111111',
        'expo-platform': 'ios',
      },
    }),
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.headers.im, undefined);
  assert.equal(res.patch, undefined);
  assert.deepEqual(await readBody(res.body), CONTENT.subarray(0, 10));
});

test('multi-range 与 If-Range 不匹配都降级为 200 未编码全量', async () => {
  const multi = await serveAsset(
    args({ acceptEncoding: 'gzip', headers: { range: 'bytes=0-9,20-29' } }),
  );
  assert.equal(multi.status, 200);
  assert.equal(multi.headers['content-encoding'], undefined);
  assert.deepEqual(await readBody(multi.body), CONTENT);

  const stale = await serveAsset(
    args({
      acceptEncoding: 'gzip',
      headers: { range: 'bytes=10-', 'if-range': '"stale"' },
    }),
  );
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['content-encoding'], undefined);
  assert.deepEqual(await readBody(stale.body), CONTENT);

  const weak = await serveAsset(
    args({ headers: { range: 'bytes=10-', 'if-range': 'W/"stale"' } }),
  );
  assert.equal(weak.status, 200);
});

test('If-Range 匹配当前 ETag / Last-Modified 时仍允许续传', async () => {
  const head = await serveAsset(args({ method: 'HEAD' }));
  for (const validator of [head.headers.etag, head.headers['last-modified']]) {
    const res = await serveAsset(
      args({ headers: { range: 'bytes=10-19', 'if-range': validator } }),
    );
    assert.equal(res.status, 206, validator);
    assert.deepEqual(await readBody(res.body), CONTENT.subarray(10, 20));
  }
});

test('HEAD 返回未编码表示的头且没有响应体', async () => {
  const res = await serveAsset(args({ method: 'HEAD', acceptEncoding: 'gzip' }));
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
  assert.equal(res.headers['content-length'], String(SIZE));
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-range'], undefined);
});

test('gzip 表示使用不同的 ETag，避免与原始字节共用 validator', async () => {
  const identity = await serveAsset(args());
  const gz = await serveAsset(args({ acceptEncoding: 'gzip' }));
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.notEqual(gz.headers.etag, identity.headers.etag);
  assert.equal(gz.headers['content-length'], String(gzipSync(CONTENT).length));
});

test('真实 HTTP：GET / HEAD / 206 / 416 / 405 与分片拼接还原', async () => {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[test] handle 失败:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const query = new URLSearchParams({ rv: RV, release: RELEASE, file: FILE });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/assets?${query}`;

  try {
    const full = await fetch(baseUrl);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), CONTENT);

    const head = await fetch(baseUrl, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(SIZE));
    assert.equal(head.headers.get('content-encoding'), null);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const part = await fetch(baseUrl, { headers: { range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-9/${SIZE}`);
    assert.equal(part.headers.get('content-length'), '10');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), CONTENT.subarray(0, 10));

    // 模拟中断后续传：两段拼接必须逐字节等于原文件（可通过 manifest hash 校验）。
    const rest = await fetch(baseUrl, { headers: { range: 'bytes=10-' } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get('content-range'), `bytes 10-${SIZE - 1}/${SIZE}`);
    assert.deepEqual(
      Buffer.concat([CONTENT.subarray(0, 10), Buffer.from(await rest.arrayBuffer())]),
      CONTENT,
    );

    const withValidator = await fetch(baseUrl, {
      headers: { range: 'bytes=5-', 'if-range': head.headers.get('etag') },
    });
    assert.equal(withValidator.status, 206);
    assert.equal(
      withValidator.headers.get('content-range'),
      `bytes 5-${SIZE - 1}/${SIZE}`,
    );

    const outOfRange = await fetch(baseUrl, { headers: { range: `bytes=${SIZE}-` } });
    assert.equal(outOfRange.status, 416);
    assert.equal(outOfRange.headers.get('content-range'), `bytes */${SIZE}`);

    const notAllowed = await fetch(baseUrl, { method: 'POST' });
    assert.equal(notAllowed.status, 405);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
