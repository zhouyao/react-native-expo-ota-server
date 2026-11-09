import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.js': 'application/javascript',
  // Hermes 字节码同样作为 JS bundle 下发，与 manifest 中 launchAsset 的
  // contentType 保持一致，否则客户端校验/自检会不一致。
  '.hbc': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

export function contentTypeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function sha256Base64Url(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64url');
}

export function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 把 32 字节 hex 转成规范 UUID 字符串，用于 manifest.id。
export function hexToUuid(hex) {
  const h = hex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Expo Structured Field Values: 简单的 string Dictionary。
export function sfvDictionary(entries) {
  return Object.entries(entries)
    .map(([key, value]) => {
      const escaped = String(value).replace(/(["\\])/g, '\\$1');
      return `${key}="${escaped}"`;
    })
    .join(', ');
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

export function safeJoin(base, ...segments) {
  const resolved = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base);
  // 允许空段（resolved === base）：数据目录尚未创建时 listChannels 会传入空 rv。
  // 其余情况必须严格位于 base 之下，防止 ../ 穿越。
  if (
    resolved !== normalizedBase &&
    !resolved.startsWith(`${normalizedBase}${path.sep}`)
  ) {
    throw new Error('路径越界');
  }
  return resolved;
}

export function walkFilesSync(dir, relative = '') {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFilesSync(full, rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
  }
  return result;
}

export function signManifest(manifest, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(JSON.stringify(manifest), 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}
