import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * release 目录里的资产名是内容寻址（`bundles/<md5>.hbc`），提升 / 重发时
 * 新版本与源版本的文件内容、文件名都完全一致。因此优先用硬链接重建目录，
 * 而不是复制字节：单次 `--touch` 的增量从「整个 release」降到「元数据文件」。
 *
 * 硬链接只共享 inode，不共享目录项：删除其中一个 release 目录不会影响另一个。
 */
const FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOSYS', 'EMLINK', 'EACCES', 'EINVAL']);

/**
 * 优先硬链接，失败（跨设备 / 无权限 / 文件系统不支持）时回退真实拷贝。
 * @returns {Promise<'link'|'copy'>}
 */
export async function linkOrCopyFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.link(src, dest);
    return 'link';
  } catch (error) {
    if (!FALLBACK_CODES.has(error.code)) throw error;
    await fsp.copyFile(src, dest);
    return 'copy';
  }
}

/**
 * 递归重建目录结构，文件一律走 linkOrCopyFile。
 * 只处理普通文件与目录，忽略符号链接等特殊项（发布产物里不应出现）。
 *
 * @returns {Promise<{linked:number, copied:number}>}
 */
export async function linkTree(srcDir, destDir, stats = { linked: 0, copied: 0 }) {
  let entries;
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch {
    // 源目录不存在（例如没有 assets/），按「无文件」处理而不是失败。
    return stats;
  }
  await fsp.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await linkTree(src, dest, stats);
    } else if (entry.isFile()) {
      const kind = await linkOrCopyFile(src, dest);
      if (kind === 'link') stats.linked += 1;
      else stats.copied += 1;
    }
  }
  return stats;
}
