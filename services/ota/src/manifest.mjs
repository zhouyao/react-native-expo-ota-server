import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  KEY_ID,
  PRIVATE_KEY_PATH,
  PUBLIC_BASE_URL,
  SIGNING_ALG,
} from './config.mjs';
import {
  contentTypeFor,
  hexToUuid,
  md5Hex,
  readJson,
  safeJoin,
  sfvDictionary,
  sha256Base64Url,
  sha256Hex,
  signManifest,
} from './lib.mjs';
import {
  DEFAULT_CHANNEL,
  normalizeChannel,
  readChannel,
  releaseDir,
} from './release-store.mjs';
import { parseUid, selectRelease } from './rollout.mjs';

const SUPPORTED_PLATFORMS = new Set(['ios', 'android']);

/**
 * 通道解析（EAS 标准）：只认构建时写入原生的 channel 请求头。
 * 运行时切换通道不属于 EAS 语义，灰度由服务端 rollout 控制。
 */
export function resolveChannel(headers = {}) {
  const explicit = headers['expo-channel-name'] || headers.channel;
  return normalizeChannel(explicit || DEFAULT_CHANNEL);
}

function commonHeaders(channel, extra = {}) {
  return {
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
    'cache-control': 'private, max-age=0',
    'expo-server-defined-headers': sfvDictionary({ channel }),
    ...extra,
  };
}

// 私钥内容不会在运行期变化，进程内缓存一次；读取失败不缓存，下次请求重试。
let privateKeyPromise = null;

function loadPrivateKey() {
  if (!PRIVATE_KEY_PATH) {
    throw new Error('客户端要求代码签名，但服务端未配置 OTA_PRIVATE_KEY_PATH');
  }
  if (!privateKeyPromise) {
    privateKeyPromise = fsp
      .readFile(path.resolve(PRIVATE_KEY_PATH), 'utf8')
      .catch((error) => {
        privateKeyPromise = null;
        throw error;
      });
  }
  return privateKeyPromise;
}

// 发布目录不可变（releaseId 唯一），因此元数据与 expoConfig 可以常驻缓存。
const releaseCache = new Map();

async function loadRelease(runtimeVersion, releaseId) {
  const key = `${runtimeVersion}:${releaseId}`;
  const cached = releaseCache.get(key);
  if (cached) return cached;
  const baseDir = releaseDir(runtimeVersion, releaseId);
  const [metadata, expoConfig] = await Promise.all([
    readJson(path.join(baseDir, 'metadata.json')),
    readJson(path.join(baseDir, 'expoConfig.json')),
  ]);
  if (!metadata) return { metadata: null, expoConfig };
  if (releaseCache.size > 200) releaseCache.clear();
  const entry = { metadata, expoConfig };
  releaseCache.set(key, entry);
  return entry;
}

async function signatureHeaderFor(manifest, expectSignature) {
  if (!expectSignature) return {};
  const privateKey = await loadPrivateKey();
  const sig = signManifest(manifest, privateKey);
  // expo-updates 的解析器把 expo-signature 读成 [String: String]，
  // 因此 sig 必须是 quoted string（base64 含 +/=，不能是 token）。
  return {
    'expo-signature': sfvDictionary({
      sig,
      keyid: KEY_ID,
      alg: SIGNING_ALG,
    }),
  };
}

function assetUrl(runtimeVersion, releaseId, relativeFile) {
  const query = new URLSearchParams({
    rv: String(runtimeVersion),
    release: String(releaseId),
    file: relativeFile,
  });
  return `${PUBLIC_BASE_URL}/api/assets?${query.toString()}`;
}

async function buildAsset(
  runtimeVersion,
  releaseId,
  baseDir,
  relativeFile,
  isLaunchAsset,
  assetIndex,
) {
  const ext = path.extname(relativeFile).toLowerCase();
  const known = assetIndex?.[relativeFile];
  let { key, hash } = known || {};
  if (!key || !hash) {
    // 兼容旧版本目录：没有预计算索引时回退读文件。
    const buffer = await fsp.readFile(safeJoin(baseDir, relativeFile));
    key = md5Hex(buffer);
    hash = sha256Base64Url(buffer);
  }
  const asset = {
    key,
    hash,
    contentType:
      known?.contentType ||
      (isLaunchAsset ? 'application/javascript' : contentTypeFor(relativeFile)),
    url: assetUrl(runtimeVersion, releaseId, relativeFile),
  };
  if (!isLaunchAsset && ext) {
    asset.fileExtension = ext;
  }
  return asset;
}

function multipart(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n`);
    chunks.push('Content-Type: application/json\r\n');
    if (part.signature) {
      chunks.push(`expo-signature: ${part.signature}\r\n`);
    }
    chunks.push('\r\n');
    chunks.push(JSON.stringify(part.body));
    chunks.push('\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(''), 'utf8');
}

/**
 * 按 Expo Updates v1 生成响应。
 * 返回 { status, headers, body, meta }，meta 用于请求日志与监控。
 */
export async function buildManifestResponse({
  runtimeVersion,
  platform,
  headers,
  channel,
}) {
  const protocolVersion = headers['expo-protocol-version'];
  if (protocolVersion && protocolVersion !== '1') {
    return {
      status: 406,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: 'unsupported protocol version' })),
    };
  }

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: 'unsupported platform' })),
    };
  }

  const channelRecord = await readChannel(runtimeVersion, channel);
  if (!channelRecord) {
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ error: `no release for runtime ${runtimeVersion}` }),
      ),
    };
  }

  const baseHeaders = commonHeaders(channel, {
    'expo-manifest-filters': sfvDictionary({ platform }),
  });

  // 回滚：multipart/mixed + directive part
  if (channelRecord.rollback) {
    const directive = {
      type: 'rollBackToEmbedded',
      parameters: { commitTime: channelRecord.commitTime },
    };
    const boundary = `expo-${crypto.randomUUID()}`;
    let partSignature;
    if (headers['expo-expect-signature']) {
      const sigHeaders = await signatureHeaderFor(
        directive,
        headers['expo-expect-signature'],
      );
      partSignature = sigHeaders['expo-signature'];
    }
    return {
      status: 200,
      headers: {
        ...baseHeaders,
        'content-type': `multipart/mixed; boundary=${boundary}`,
      },
      body: multipart(
        [{ name: 'directive', body: directive, signature: partSignature }],
        boundary,
      ),
      meta: { channel, served: 'rollback', releaseId: null },
    };
  }

  // rollout：按 uid 分桶决定 current / previous，百分比按请求平台取覆盖值。
  const uid = parseUid(headers);
  const selected = selectRelease(channelRecord, uid, platform);
  if (!selected) {
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: 'no active release' })),
    };
  }

  const releaseId = selected.releaseId;
  const baseDir = releaseDir(runtimeVersion, releaseId);
  const { metadata, expoConfig } = await loadRelease(runtimeVersion, releaseId);
  if (!metadata) {
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: 'release metadata missing' })),
    };
  }

  const launchFile = metadata.launchAssets?.[platform];
  if (!launchFile) {
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ error: `no bundle for platform ${platform}` }),
      ),
    };
  }

  const assetIndex = metadata.assetIndex || null;
  const launchAsset = await buildAsset(
    runtimeVersion,
    releaseId,
    baseDir,
    launchFile,
    true,
    assetIndex,
  );
  const assets = [];
  for (const file of metadata.assets || []) {
    assets.push(
      await buildAsset(runtimeVersion, releaseId, baseDir, file, false, assetIndex),
    );
  }

  const manifest = {
    id: metadata.id || hexToUuid(sha256Hex(Buffer.from(`${releaseId}`))),
    createdAt: metadata.createdAt,
    runtimeVersion: String(runtimeVersion),
    launchAsset,
    assets,
    metadata: {
      ...(metadata.metadata || {}),
      channel,
      releaseId,
      rollout: selected.percentage,
      served: selected.served,
      bucket: selected.bucket ?? undefined,
      // 未显式发布过的通道会继承默认通道，透出继承来源便于排查"通道名拼错"。
      ...(channelRecord.inheritedFrom
        ? { inheritedFrom: channelRecord.inheritedFrom }
        : {}),
    },
    extra: expoConfig ? { expoConfig } : {},
  };

  const signatureHeaders = await signatureHeaderFor(
    manifest,
    headers['expo-expect-signature'],
  );

  return {
    status: 200,
    headers: {
      ...baseHeaders,
      ...signatureHeaders,
      'content-type': 'application/expo+json',
    },
    body: Buffer.from(JSON.stringify(manifest)),
    meta: {
      channel,
      releaseId,
      updateId: manifest.id,
      served: selected.served,
      percentage: selected.percentage,
      bucket: selected.bucket,
      uid,
    },
  };
}
