import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signManifest } from '../services/ota/src/lib.mjs';

// 测试用密钥在内存生成，不依赖仓库里的私钥文件。
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function verify(manifest, signature) {
  return crypto.verify(
    'sha256',
    Buffer.from(JSON.stringify(manifest)),
    crypto.createPublicKey(publicKey),
    Buffer.from(signature, 'base64'),
  );
}

test('manifest 签名可被对应公钥验证', () => {
  const manifest = { id: 'u-1', runtimeVersion: '1', assets: [] };
  assert.equal(verify(manifest, signManifest(manifest, privateKey)), true);
});

test('内容被篡改后验签失败', () => {
  const manifest = { id: 'u-1', runtimeVersion: '1' };
  const signature = signManifest(manifest, privateKey);
  assert.equal(verify({ ...manifest, runtimeVersion: '2' }, signature), false);
});

test('签名随资产列表变化而变化', () => {
  const base = { id: 'u-1', runtimeVersion: '1', assets: [] };
  const withAsset = { ...base, assets: [{ key: 'abc', hash: 'x' }] };
  assert.notEqual(signManifest(base, privateKey), signManifest(withAsset, privateKey));
});
