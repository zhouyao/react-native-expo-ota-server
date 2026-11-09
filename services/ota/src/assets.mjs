import fsp from 'node:fs/promises';
import path from 'node:path';
import { contentTypeFor, safeJoin } from './lib.mjs';
import { releaseDir } from './release-store.mjs';

/**
 * 只启用 gzip。
 * Expo 规范虽然允许 br，但 iOS NSURLSession / Android OkHttp 默认只声明 gzip，
 * 返回客户端无法解压的编码会让 hash 校验失败、更新被静默拒绝。
 * 等双端真机确认后再考虑 brotli。
 */
function acceptsGzip(acceptEncoding) {
  const raw = String(acceptEncoding || '').toLowerCase();
  if (!raw) return false;
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const token = name.trim();
    if (token !== 'gzip' && token !== '*') continue;
    const q = params.map((item) => item.trim()).find((item) => item.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

// 资产 URL 一旦发布便不可变更或删除，因此可以长缓存。
export async function serveAsset({
  runtimeVersion,
  releaseId,
  file,
  acceptEncoding = '',
}) {
  if (!runtimeVersion || !releaseId || !file) {
    return { status: 400, body: '缺少参数' };
  }

  let fullPath;
  try {
    fullPath = safeJoin(releaseDir(runtimeVersion, releaseId), file);
  } catch {
    return { status: 400, body: '非法路径' };
  }

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) return { status: 404, body: '文件不存在' };

    // 发布时预生成的 .gz 与原始文件内容一致，content-type 仍按原始文件名判断。
    let readPath = fullPath;
    let encoding = null;
    if (acceptsGzip(acceptEncoding)) {
      const gzPath = `${fullPath}.gz`;
      try {
        const gzStat = await fsp.stat(gzPath);
        if (gzStat.isFile()) {
          readPath = gzPath;
          encoding = 'gzip';
        }
      } catch {
        // 老版本没有预压缩副本，回退原始文件
      }
    }

    const body = await fsp.readFile(readPath);
    return {
      status: 200,
      encoding,
      headers: {
        'content-type': contentTypeFor(file),
        'content-length': String(body.length),
        'cache-control': 'public, max-age=31536000, immutable',
        // 同一 URL 随 accept-encoding 返回不同字节，必须声明 vary，否则缓存会串。
        vary: 'accept-encoding',
        ...(encoding ? { 'content-encoding': encoding } : {}),
      },
      body,
    };
  } catch {
    return { status: 404, body: `文件不存在: ${path.basename(file)}` };
  }
}
