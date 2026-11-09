import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

const BASE_URL = process.env.OTA_URL || 'http://localhost:3000/api/manifest';

function parseArgs(argv) {
  const args = {
    platform: 'ios',
    runtimeVersion: '1',
    url: BASE_URL,
    channel: null,
    uid: null,
    expectServed: null,
    expectRollback: false,
    cert: process.env.OTA_CODE_SIGNING_CERT || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--platform') args.platform = argv[++i];
    else if (key === '--runtime-version') args.runtimeVersion = argv[++i];
    else if (key === '--url') args.url = argv[++i];
    else if (key === '--channel') args.channel = argv[++i];
    else if (key === '--uid') args.uid = argv[++i];
    else if (key === '--expect-served') args.expectServed = argv[++i];
    else if (key === '--expect-rollback') args.expectRollback = true;
    else if (key === '--cert') args.cert = argv[++i];
  }
  return args;
}

function check(condition, label, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

function parseMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) return null;
  const text = buffer.toString('utf8');
  for (const part of text.split(`--${boundary}`)) {
    if (!part.includes('name="directive"')) continue;
    const bodyStart = part.indexOf('\r\n\r\n');
    if (bodyStart === -1) continue;
    const body = part.slice(bodyStart + 4).trim();
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

function parseSignatureHeader(value) {
  if (!value) return null;
  const entries = {};
  for (const part of String(value).split(',')) {
    const match = part.trim().match(/^([a-z0-9_]+)=(?:"([^"]*)"|:([^:]*):)/i);
    if (!match) continue;
    entries[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return entries;
}

async function verifySignature(buffer, manifest, signatureHeader, certPath) {
  check(Boolean(signatureHeader), '响应包含 expo-signature');
  if (!signatureHeader) return;
  const entries = parseSignatureHeader(signatureHeader);
  const sig = entries?.sig;
  check(Boolean(sig), 'signature 可解析');
  check(entries?.alg === 'rsa-v1_5-sha256', '算法为 rsa-v1_5-sha256', entries?.alg || '');
  if (!sig) return;

  const certPem = await fsp.readFile(certPath, 'utf8');
  const ok = crypto.verify(
    'sha256',
    Buffer.from(JSON.stringify(manifest), 'utf8'),
    crypto.createPublicKey(certPem),
    Buffer.from(sig, 'base64'),
  );
  check(ok, 'RSA-SHA256 签名校验通过');
}

async function verifyAsset(asset, label) {
  const response = await fetch(asset.url);
  check(response.ok, `${label} 可下载`, `HTTP ${response.status}`);
  if (!response.ok) return;

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buffer).digest('base64url');
  check(actual === asset.hash, `${label} SHA-256 校验通过`);

  const contentType = response.headers.get('content-type') || '';
  check(
    contentType.split(';')[0] === asset.contentType,
    `${label} Content-Type 正确`,
    contentType,
  );
  check(
    (response.headers.get('cache-control') || '').includes('immutable'),
    `${label} 使用 immutable 长缓存`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.channel ? `channel=${args.channel}` : '默认通道';
  const uid = args.uid ? `, uid=${args.uid}` : '';
  console.log(
    `[verify] ${args.url} (${args.platform}, runtime ${args.runtimeVersion}, ${target}${uid})`,
  );

  const requestHeaders = {
    'expo-protocol-version': '1',
    'expo-platform': args.platform,
    'expo-runtime-version': args.runtimeVersion,
    accept: 'application/expo+json, application/json, multipart/mixed',
  };
  if (args.channel) requestHeaders['expo-channel-name'] = args.channel;
  if (args.uid) requestHeaders['expo-extra-params'] = `uid=${args.uid}`;
  if (args.cert) requestHeaders['expo-expect-signature'] = 'true';

  const response = await fetch(args.url, { headers: requestHeaders });

  check(response.status === 200, 'manifest 返回 200', `HTTP ${response.status}`);
  if (!response.ok) {
    console.error(await response.text());
    return;
  }

  for (const header of [
    'expo-protocol-version',
    'expo-sfv-version',
    'expo-manifest-filters',
    'expo-server-defined-headers',
    'cache-control',
  ]) {
    check(Boolean(response.headers.get(header)), `响应头 ${header} 存在`);
  }
  check(response.headers.get('expo-protocol-version') === '1', '协议版本为 1');

  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (args.expectRollback || contentType.includes('multipart/mixed')) {
    check(contentType.includes('multipart/mixed'), '回滚使用 multipart/mixed');
    const directive = parseMultipart(buffer, contentType);
    check(Boolean(directive), 'directive 可解析');
    check(
      directive?.type === 'rollBackToEmbedded',
      'directive 类型为 rollBackToEmbedded',
      directive?.type || '',
    );
    return;
  }

  check(
    contentType.includes('application/expo+json') ||
      contentType.includes('application/json'),
    '清单 Content-Type 正确',
    contentType,
  );

  let manifest;
  try {
    manifest = JSON.parse(buffer.toString('utf8'));
  } catch {
    check(false, '清单是合法 JSON');
    return;
  }
  check(true, '清单是合法 JSON');

  for (const field of ['id', 'createdAt', 'runtimeVersion', 'launchAsset', 'assets', 'metadata']) {
    check(manifest[field] !== undefined, `字段 ${field} 存在`);
  }
  check(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.id || ''),
    'id 是规范 UUID',
  );
  check(
    manifest.runtimeVersion === args.runtimeVersion,
    'runtimeVersion 与请求一致',
    manifest.runtimeVersion,
  );
  check(!Number.isNaN(Date.parse(manifest.createdAt)), 'createdAt 是合法时间');
  check(Boolean(manifest.launchAsset?.url && manifest.launchAsset?.hash), 'launchAsset 含 url 与 hash');
  check(Array.isArray(manifest.assets), 'assets 是数组');

  if (args.channel) {
    check(manifest.metadata?.channel === args.channel, 'metadata.channel 与请求通道一致', manifest.metadata?.channel);
  }
  check(Boolean(manifest.metadata?.releaseId), 'metadata.releaseId 存在');
  check(
    typeof manifest.metadata?.rollout === 'number',
    'metadata.rollout 存在',
    String(manifest.metadata?.rollout),
  );
  if (args.expectServed) {
    check(
      manifest.metadata?.served === args.expectServed,
      `served 命中 ${args.expectServed}`,
      manifest.metadata?.served,
    );
  }

  if (args.cert) {
    await verifySignature(buffer, manifest, response.headers.get('expo-signature'), args.cert);
  }

  await verifyAsset(manifest.launchAsset, 'launchAsset');
  for (const [index, asset] of (manifest.assets || []).entries()) {
    await verifyAsset(asset, `assets[${index}]`);
  }

  console.log(process.exitCode ? '\n[verify] 存在失败项' : '\n[verify] 全部检查通过');
}

main().catch((error) => {
  console.error(`[verify] 失败: ${error.message}`);
  process.exitCode = 1;
});
