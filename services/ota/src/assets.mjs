import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  contentTypeFor,
  ifRangeMatches,
  parseByteRange,
  safeJoin,
} from './lib.mjs';
import { releaseDir } from './release-store.mjs';
import { negotiatePatch, PATCH_VARY } from './patch-store.mjs';

// 带 Range 的请求会被强制走原始文件，同一 URL 的字节随 A-IM / Accept-Encoding / Range
// 变化，缓存必须按 Range 分流，否则 CDN 可能把 gzip 或补丁字节当作资产片段。
const ASSET_VARY = `${PATCH_VARY}, range`;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * release 目录发布后不可变，因此 size + mtime 足以作为强 validator：
 * 内容相同则取值相同，文件被替换则取值变化（且 URL 中的 releaseId 也会变化）。
 * 不额外算内容 hash，避免为续传请求再把整个 bundle 读进内存。
 */
function assetValidators(stat) {
  const tag = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
  return {
    etag: `"${tag}"`,
    gzipEtag: `"${tag}-gz"`,
    lastModified: stat.mtime.toUTCString(),
  };
}

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

function wantsBsdiff(headers) {
  return String(headers['a-im'] || '')
    .toLowerCase()
    .split(',')
    .some((value) => value.trim() === 'bsdiff');
}

// 资产 URL 一旦发布便不可变更或删除，因此可以长缓存；
// 但补丁响应必须 private/no-store：同一 URL 会因 A-IM 与 base 不同而返回不同字节。
export async function serveAsset({
  runtimeVersion,
  releaseId,
  file,
  acceptEncoding = '',
  headers = {},
  method = 'GET',
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

  const headOnly = method === 'HEAD';

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) return { status: 404, body: '文件不存在' };

    const { etag, gzipEtag, lastModified } = assetValidators(stat);
    const commonHeaders = {
      'accept-ranges': 'bytes',
      etag,
      'last-modified': lastModified,
      vary: ASSET_VARY,
    };

    // HEAD 用于探测续传能力，必须返回未编码表示的字节长度与 ETag。
    // 若走 gzip 协商，客户端会拿压缩后长度去规划原始文件的 Range 偏移而拼接错位。
    if (headOnly) {
      return {
        status: 200,
        headers: {
          ...commonHeaders,
          'content-type': contentTypeFor(file),
          'content-length': String(stat.size),
          'cache-control': CACHE_CONTROL,
        },
        body: null,
      };
    }

    const rawRange = String(headers.range || '').trim();

    // 带 Range 时只服务原始（未压缩、未差分）表示：gzip 的偏移属于压缩域，
    // bsdiff 的 226 与 206 组合也有协议歧义，两者都会让客户端按已签名的
    // asset hash 校验失败。因此这一分支完全绕过内容协商。
    if (rawRange) {
      const valid = ifRangeMatches(headers['if-range'], { etag, lastModified });
      const parsed = valid ? parseByteRange(rawRange, stat.size) : { kind: 'ignore' };

      if (parsed.kind === 'unsatisfiable') {
        return {
          status: 416,
          headers: {
            ...commonHeaders,
            'content-type': 'text/plain; charset=utf-8',
            'content-range': `bytes */${stat.size}`,
            'cache-control': 'no-store',
          },
          body: 'Range Not Satisfiable',
        };
      }

      if (parsed.kind === 'range') {
        const { start, end } = parsed;
        return {
          status: 206,
          range: { start, end, size: stat.size },
          headers: {
            ...commonHeaders,
            'content-type': contentTypeFor(file),
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${stat.size}`,
            'cache-control': CACHE_CONTROL,
          },
          // 流式下发片段，避免为大 bundle 的续传请求再整包读进内存。
          body: fs.createReadStream(fullPath, { start, end }),
        };
      }

      // 语法不支持或 If-Range 不匹配：按 RFC 忽略 Range，返回未编码的完整文件。
      const body = await fsp.readFile(fullPath);
      return {
        status: 200,
        headers: {
          ...commonHeaders,
          'content-type': contentTypeFor(file),
          'content-length': String(stat.size),
          'cache-control': CACHE_CONTROL,
        },
        body,
      };
    }

    // 无 Range：保持原有的「差分优先于 gzip」内容协商顺序。
    // 补丁分支必须先于 gzip 判断：把完整包的 .gz 当补丁返回会让客户端校验失败。
    let patch = null;
    if (wantsBsdiff(headers)) {
      let result;
      try {
        result = await negotiatePatch({ runtimeVersion, releaseId, file, headers });
      } catch (error) {
        result = {
          kind: 'full',
          meta: { hit: false, reason: 'negotiation-error', message: error.message },
        };
      }
      if (result.kind === 'patch') {
        return { ...result.response, patch: result.meta };
      }
      patch = result.meta;
    }

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
        'cache-control': CACHE_CONTROL,
        ...commonHeaders,
        // gzip 是不同表示，ETag 必须区分，否则 If-Range 会把两种字节混在一起。
        ...(encoding ? { etag: gzipEtag, 'content-encoding': encoding } : {}),
      },
      body,
      ...(patch ? { patch } : {}),
    };
  } catch {
    return { status: 404, body: `文件不存在: ${path.basename(file)}` };
  }
}
