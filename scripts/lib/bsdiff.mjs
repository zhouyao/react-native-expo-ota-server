/**
 * bsdiff / bspatch CLI 封装（只在发布期使用，服务端运行时不依赖它）。
 *
 * expo-updates 58 的客户端内置 bspatch.c 只认标准 BSDIFF40：
 * 8 字节 "BSDIFF40" 魔数 + 三段 bzip2 流（ctrl / diff / extra）。
 * 因此这里用系统 bsdiff CLI 生成，并用 bspatch 还原一次做自检，
 * 任何一步不达标都不能写进补丁索引，避免把坏补丁发给客户端。
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAGIC = 'BSDIFF40';
// 没有 Homebrew 时通常源码编译到 ~/.local/bin；把该目录并入子进程 PATH，
// 发布脚本无需用户先改 shell 配置就能找到 bsdiff。
const USER_BIN = path.join(os.homedir(), '.local', 'bin');
const SPAWN_OPTIONS = {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  env: {
    ...process.env,
    PATH: `${USER_BIN}${path.delimiter}${process.env.PATH || ''}`,
  },
};

export class BsdiffUnavailableError extends Error {
  constructor(bin) {
    super(`找不到 ${bin} 命令；请安装 bsdiff（macOS: brew install bsdiff，Debian: apt install bsdiff），或设置 OTA_BSDIFF_BIN / OTA_BSPATCH_BIN`);
    this.name = 'BsdiffUnavailableError';
    this.bin = bin;
  }
}

export function bsdiffBin() {
  return process.env.OTA_BSDIFF_BIN || 'bsdiff';
}

export function bspatchBin() {
  return process.env.OTA_BSPATCH_BIN || 'bspatch';
}

function run(bin, args) {
  const result = spawnSync(bin, args, SPAWN_OPTIONS);
  if (result.error?.code === 'ENOENT') throw new BsdiffUnavailableError(bin);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(-400);
    throw new Error(`${path.basename(bin)} 执行失败（退出码 ${result.status}）: ${detail}`);
  }
}

/**
 * 生成标准 BSDIFF40 补丁。
 * 返回 { patchSize, sha256 }，调用方负责把元数据写进索引。
 */
export async function generatePatch({ baseFile, targetFile, outputFile }) {
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  run(bsdiffBin(), [baseFile, targetFile, outputFile]);

  const patch = await fsp.readFile(outputFile);
  if (patch.length < 32 || patch.subarray(0, 8).toString('ascii') !== MAGIC) {
    await fsp.rm(outputFile, { force: true });
    throw new Error(`生成的补丁不是 ${MAGIC} 格式: ${outputFile}`);
  }
  return {
    patchSize: patch.length,
    sha256: crypto.createHash('sha256').update(patch).digest('hex'),
  };
}

/**
 * 用 bspatch 还原并与目标哈希比对。
 * 客户端正是这样校验的（还原结果必须匹配已签名 manifest 的 launchAsset.hash），
 * 所以发布期先跑一遍可以把坏补丁拦在服务端之外。
 */
export async function verifyPatch({ baseFile, patchFile, expectedHash }) {
  const restored = `${patchFile}.verified.${process.pid}`;
  try {
    run(bspatchBin(), [baseFile, restored, patchFile]);
    const buffer = await fsp.readFile(restored);
    const actual = crypto.createHash('sha256').update(buffer).digest('base64url');
    if (actual !== expectedHash) {
      throw new Error(`bspatch 还原结果与目标 bundle 不一致: ${actual} != ${expectedHash}`);
    }
    return { size: buffer.length, hash: actual };
  } finally {
    await fsp.rm(restored, { force: true }).catch(() => {});
  }
}

/** 生成 + 还原校验；失败时清理半成品，不留坏补丁文件。 */
export async function buildPatch({ baseFile, targetFile, outputFile, expectedHash }) {
  const info = await generatePatch({ baseFile, targetFile, outputFile });
  try {
    await verifyPatch({ baseFile, patchFile: outputFile, expectedHash });
  } catch (error) {
    await fsp.rm(outputFile, { force: true }).catch(() => {});
    throw error;
  }
  return info;
}
