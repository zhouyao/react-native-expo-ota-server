import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  contentTypeFor,
  hexToUuid,
  md5Hex,
  safeJoin,
  sfvDictionary,
  sha256Base64Url,
} from '../services/ota/src/lib.mjs';

test('safeJoin 允许 base 内的子路径', () => {
  const base = path.resolve('/tmp/ota-base');
  assert.equal(safeJoin(base, 'a/b.js'), path.join(base, 'a', 'b.js'));
});

test('safeJoin 拒绝路径穿越', () => {
  const base = path.resolve('/tmp/ota-base');
  assert.throws(() => safeJoin(base, '../etc/passwd'), /路径越界/);
  assert.throws(() => safeJoin(base, 'a/../../etc/passwd'), /路径越界/);
});

test('safeJoin 允许空段，返回 base 本身', () => {
  const base = path.resolve('/tmp/ota-base');
  assert.equal(safeJoin(base), base);
  assert.equal(safeJoin(base, ''), base);
  assert.equal(safeJoin(base, ''), safeJoin(base));
});

test('sfvDictionary 转义引号与反斜杠', () => {
  assert.equal(sfvDictionary({ a: 'x"y' }), 'a="x\\"y"');
  assert.equal(sfvDictionary({ a: 'ok', b: 'v' }), 'a="ok", b="v"');
});

test('hash 编码符合标准向量', () => {
  assert.equal(md5Hex(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(
    sha256Base64Url(Buffer.from('abc')),
    'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
  );
});

test('hexToUuid 输出规范 UUID 形态', () => {
  const uuid = hexToUuid('0123456789abcdef0123456789abcdef');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('contentTypeFor 覆盖 launchAsset 与常见资产', () => {
  assert.equal(contentTypeFor('a.hbc'), 'application/javascript');
  assert.equal(contentTypeFor('a.js'), 'application/javascript');
  assert.equal(contentTypeFor('a.png'), 'image/png');
  assert.equal(contentTypeFor('a.unknown'), 'application/octet-stream');
});
