#!/usr/bin/env node
/**
 * 发布后自检：模拟 iOS / Android 客户端拉取 manifest，校验
 * 协议版本、通道、runtimeVersion、资源可达与 hash、manifest 签名、分桶结果。
 *
 * 用法：
 *   node scripts/preflight.mjs --channel beta --rv 1
 *   node scripts/preflight.mjs --channel production --url http://<lan-ip>:3000 --uid u-test-0
 *   node scripts/preflight.mjs --channel beta --cert apps/mobile/certs/certificate.pem --platform ios
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 默认直连服务本身：OTA_HEALTH_URL 的 origin，否则 localhost:PORT。 */
function defaultBaseUrl() {
  const health = process.env.OTA_HEALTH_URL;
  if (health) {
    try {
      return new URL(health).origin;
    } catch {
      // 回落到 localhost
    }
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

function parseArgs(argv) {
  const args = {
    channel: 'production',
    rv: null,
    url: defaultBaseUrl(),
    cert: path.join(ROOT, 'apps/mobile/certs/certificate.pem'),
    platform: 'all',
    uid: null,
    keyid: process.env.OTA_KEY_ID || 'main',
    maxAssets: 50,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--channel') args.channel = argv[++i];
    else if (key === '--rv') args.rv = argv[++i];
    else if (key === '--url') args.url = argv[++i];
    else if (key === '--cert') args.cert = argv[++i];
    else if (key === '--platform') args.platform = argv[++i];
    else if (key === '--uid') args.uid = argv[++i];
    else if (key === '--keyid') args.keyid = argv[++i];
    else if (key === '--max-assets') args.maxAssets = Number(argv[++i]) || 50;
    else if (key === '--quiet') args.quiet = true;
    else if (key === '--help' || key === '-h') {
      console.log(`用法: node scripts/preflight.mjs --channel <name> [--rv <rv>] [--url <base>]
  [--cert <pem>] [--platform all|ios|android] [--uid <uid>] [--max-assets N] [--quiet]`);
      process.exit(0);
    }
  }
  if (!args.rv) {
    console.error('[preflight] 缺少 --rv（runtimeVersion）');
    process.exit(2);
  }
  return args;
}

const results = [];
function check(condition, label, detail = '') {
  results.push({ ok: Boolean(condition), label, detail });
  if (!condition) process.exitCode = 1;
  if (!argsQuiet()) {
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
let quiet = false;
const argsQuiet = () => quiet;

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

async function verifySignature(body, signatureHeader, certPath) {
  check(Boolean(signatureHeader), '响应包含 expo-signature');
  if (!signatureHeader) return;
  const entries = parseSignatureHeader(signatureHeader);
  check(Boolean(entries?.sig), 'signature 可解析');
  check(entries?.alg === 'rsa-v1_5-sha256', '算法为 rsa-v1_5-sha256', entries?.alg || '');
  if (!entries?.sig) return;

  let certPem;
  try {
    certPem = await fsp.readFile(certPath, 'utf8');
  } catch (error) {
    check(false, '读取证书失败', error.message);
    return;
  }
  let ok = false;
  try {
    ok = crypto.verify(
      'sha256',
      body,
      crypto.createPublicKey(certPem),
      Buffer.from(entries.sig, 'base64'),
    );
  } catch (error) {
    check(false, '签名校验异常', error.message);
    return;
  }
  check(ok, 'RSA-SHA256 签名校验通过');
}

async function verifyResource(resource, label) {
  if (!resource?.url) {
    check(false, `${label} 含 url`);
    return;
  }
  let response;
  try {
    response = await fetch(resource.url);
  } catch (error) {
    check(false, `${label} 可下载`, error.message);
    return;
  }
  check(response.ok, `${label} 可下载`, `HTTP ${response.status}`);
  if (!response.ok) return;

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buffer).digest('base64url');
  check(actual === resource.hash, `${label} SHA-256 校验`, actual === resource.hash ? '' : `${actual} != ${resource.hash}`);

  if (resource.contentType) {
    const actualType = (response.headers.get('content-type') || '').split(';')[0];
    check(actualType === resource.contentType, `${label} Content-Type`, actualType);
  }
  check(
    (response.headers.get('cache-control') || '').includes('immutable'),
    `${label} immutable 长缓存`,
  );
}

/**
 * 通道存在性：服务端对未显式发布的通道会继承默认通道（这是刻意的灰度设计），
 * 所以拼错通道同样会返回 200，必须单独校验，否则自检形同虚设。
 */
async function verifyChannelExists(args) {
  console.log(`\n[preflight] 通道检查 channel=${args.channel}`);
  const url = new URL('/api/channels', args.url);
  url.searchParams.set('rv', String(args.rv));
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    check(false, '通道列表可获取', error.message);
    return;
  }
  check(response.ok, '通道列表可获取', `HTTP ${response.status}`);
  if (!response.ok) return;
  const data = await response.json();
  const names = (data.channels || []).map((item) => item.channel);
  const exists = names.includes(args.channel);
  check(
    exists,
    '通道已显式发布过',
    names.length ? `已有：${names.join(', ')}` : '没有任何通道',
  );
  return exists;
}

async function verifyPlatform(platform, args) {
  console.log(`\n[preflight] platform=${platform} channel=${args.channel} rv=${args.rv}`);

  const url = new URL('/api/manifest', args.url);
  const headers = {
    'expo-platform': platform,
    'expo-runtime-version': String(args.rv),
    'expo-channel-name': args.channel,
    'expo-protocol-version': '1',
    'expo-expect-signature': `sig, keyid="${args.keyid}", alg="rsa-v1_5-sha256"`,
  };
  if (args.uid) headers['expo-extra-params'] = `uid="${args.uid}"`;

  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    check(false, 'manifest 请求成功', error.message);
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  check(response.status === 200, 'manifest HTTP 200', `HTTP ${response.status}`);
  if (response.status !== 200) return;

  check(
    response.headers.get('expo-protocol-version') === '1',
    'expo-protocol-version = 1',
    response.headers.get('expo-protocol-version') || '',
  );

  let manifest;
  try {
    manifest = JSON.parse(body.toString('utf8'));
  } catch (error) {
    check(false, 'manifest 是合法 JSON', error.message);
    return;
  }

  check(String(manifest.runtimeVersion) === String(args.rv), 'runtimeVersion 一致', manifest.runtimeVersion);
  check(manifest.metadata?.channel === args.channel, 'channel 一致', manifest.metadata?.channel);
  check(Boolean(manifest.launchAsset?.url), 'launchAsset 含 url');

  if (args.uid) {
    const bucket = manifest.metadata?.bucket;
    check(
      bucket === null || bucket === undefined || (Number(bucket) >= 0 && Number(bucket) < 100),
      'bucket 在 0-99',
      String(bucket),
    );
    check(
      ['current', 'previous', 'whitelist'].includes(manifest.metadata?.served),
      'served 取值合法',
      String(manifest.metadata?.served),
    );
  }

  await verifySignature(body, response.headers.get('expo-signature'), args.cert);

  await verifyResource(manifest.launchAsset, 'launchAsset');
  const assets = (manifest.assets || []).slice(0, args.maxAssets);
  for (let i = 0; i < assets.length; i += 1) {
    await verifyResource(assets[i], `asset#${i + 1}`);
  }
  if ((manifest.assets || []).length > assets.length) {
    console.log(`  (资源共 ${manifest.assets.length} 个，仅校验前 ${assets.length} 个)`);
  }
  console.log(`  资源校验完成：${assets.length} 个`);
}

const args = parseArgs(process.argv.slice(2));
quiet = args.quiet;
const channelExists = await verifyChannelExists(args);
if (!channelExists) {
  // 通道不存在时不再请求 manifest：服务端虽然会继承默认通道返回 200，
  // 但那会把拼错的通道名写进 events.jsonl，污染按通道的指标。
  console.error('\n[preflight] 通道不存在，已跳过 manifest 校验');
  process.exitCode = 1;
  process.exit(1);
}

const platforms = args.platform === 'all' ? ['ios', 'android'] : [args.platform];
for (const platform of platforms) {
  await verifyPlatform(platform, args);
}

const failed = results.filter((item) => !item.ok);
console.log(
  `\n[preflight] ${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项失败` : ''}`,
);
if (failed.length) {
  for (const item of failed) console.error(`  FAIL ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
  process.exitCode = 1;
}
