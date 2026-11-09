import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { UPDATES_DIR } from '../services/ota/src/config.mjs';
import { exportEnv } from './lib/export-env.mjs';
import {
  contentTypeFor,
  hexToUuid,
  md5Hex,
  readJson,
  sha256Base64Url,
  sha256Hex,
  walkFilesSync,
  writeJsonAtomic,
} from '../services/ota/src/lib.mjs';
import {
  DEFAULT_CHANNEL,
  channelLockFile,
  listChannels,
  listReleaseIds,
  normalizeChannel,
  promoteRelease,
  readChannel,
  releaseDir,
  setRollback,
} from '../services/ota/src/release-store.mjs';
import { withLock } from '../services/ota/src/locks.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..');
const MOBILE_DIR = path.join(ROOT, 'apps', 'mobile');
const DIST_DIR = path.join(MOBILE_DIR, 'dist');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {
    platform: 'all',
    runtimeVersion: null,
    rollback: false,
    release: null,
    list: false,
    channel: DEFAULT_CHANNEL,
    fromDir: null,
    touch: false,
    rollout: null,
    whitelist: null,
    operator: process.env.OTA_OPERATOR || 'cli',
    via: 'cli',
    requestId: null,
    preflight: true,
    autoRollback: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--rollback') {
      args.rollback = true;
    } else if (key === '--channel') {
      args.channel = normalizeChannel(argv[++i]);
    } else if (key === '--release') {
      args.release = argv[++i];
    } else if (key === '--list') {
      args.list = true;
    } else if (key === '--platform') {
      args.platform = argv[++i];
    } else if (key === '--runtime-version') {
      args.runtimeVersion = argv[++i];
    } else if (key === '--from-dir') {
      args.fromDir = path.resolve(argv[++i]);
    } else if (key === '--touch') {
      args.touch = true;
    } else if (key === '--rollout') {
      args.rollout = Number(argv[++i]);
    } else if (key === '--whitelist') {
      args.whitelist = argv[++i];
    } else if (key === '--operator') {
      args.operator = argv[++i] || args.operator;
    } else if (key === '--via') {
      args.via = argv[++i] || args.via;
    } else if (key === '--request-id') {
      args.requestId = argv[++i] || null;
    } else if (key === '--no-preflight') {
      args.preflight = false;
    } else if (key === '--auto-rollback-on-fail') {
      args.autoRollback = true;
    } else if (key === '--help' || key === '-h') {
      console.log(`用法: node scripts/publish.mjs [选项]
  --runtime-version <rv>  指定 runtimeVersion（默认读取 app.config.js）
  --platform <p>          all | ios | android（默认 all）
  --channel <name>        发布到指定通道（默认 production）
  --from-dir <dir>        使用已有导出目录，跳过 expo export
  --rollout <0-100>       只放量给该百分比的设备（其余继续用 previous）
  --whitelist <uid,...>   白名单 uid，直接命中新版本
  --list                  列出通道状态与历史版本
  --touch                 重新发布通道当前版本（刷新 createdAt，republish）
  --release <id>          把指定历史版本提升到该通道（promote）
  --rollback              下发 rollBackToEmbedded（仅本地演练）
  --operator <name>       审计里的操作人（默认 $OTA_OPERATOR 或 cli）
  --via <source>          操作来源（cli / dashboard / ci）
  --request-id <id>       幂等键，重复提交不会重复发布
  --no-preflight          发布后跳过自检
  --auto-rollback-on-fail 自检失败时自动回滚到 previous`);
      process.exit(0);
    }
  }
  return args;
}

function resolveRuntimeVersion(explicit) {
  if (explicit) return String(explicit);
  const config = require(path.join(MOBILE_DIR, 'app.config.js'));
  const runtimeVersion = config.expo?.runtimeVersion;
  if (typeof runtimeVersion === 'string') return runtimeVersion;
  if (runtimeVersion?.policy === 'appVersion') return config.expo.version;
  throw new Error(
    'app.config.js 使用了 fingerprint 策略，请显式传入 --runtime-version（可用 npx expo fingerprint 计算）',
  );
}

function parseRollout(args) {
  if (args.rollout === null && args.whitelist === null) return undefined;
  const rollout = {};
  if (args.rollout !== null) {
    if (!Number.isFinite(args.rollout) || args.rollout < 0 || args.rollout > 100) {
      throw new Error('--rollout 必须是 0-100 的数字');
    }
    rollout.percentage = args.rollout;
  }
  if (args.whitelist !== null) {
    rollout.whitelist = args.whitelist
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return rollout;
}

function exportBundles() {
  console.log('[publish] 执行 npx expo export ...');
  const result = spawnSync(
    'npx',
    // --clear：Metro 的 transform 缓存不感知 EXPO_PUBLIC_* 变化，不清会复用旧产物。
    ['expo', 'export', '--platform', 'all', '--output-dir', 'dist', '--clear'],
    {
      cwd: MOBILE_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: exportEnv(MOBILE_DIR),
    },
  );
  if (result.status !== 0) {
    throw new Error(`expo export 失败（退出码 ${result.status}）`);
  }
  return DIST_DIR;
}

const BUNDLE_EXT = new Set(['.js', '.hbc', '.bundle']);
const SKIP_NAMES = new Set(['metadata.json', 'expoConfig.json', 'debug.html']);

function platformOf(file) {
  const lower = file.toLowerCase();
  if (lower.includes('ios')) return 'ios';
  if (lower.includes('android')) return 'android';
  return null;
}

// 优先读取 Expo 导出的 metadata.json，失败时按目录结构推断。
function parseExport(dir) {
  const metadataPath = path.join(dir, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const fileMetadata = metadata.fileMetadata;
      if (fileMetadata) {
        const launchAssets = {};
        const assets = new Set();
        for (const platform of ['ios', 'android']) {
          const entry = fileMetadata[platform];
          if (!entry) continue;
          const bundle =
            entry.bundle || entry.bundlePath || entry.jsBundle || entry.bundleUrl;
          if (bundle && fs.existsSync(path.join(dir, bundle))) {
            launchAssets[platform] = bundle;
          }
          for (const asset of entry.assets || []) {
            const assetPath =
              typeof asset === 'string' ? asset : asset.path || asset.file;
            if (assetPath && fs.existsSync(path.join(dir, assetPath))) {
              assets.add(assetPath);
            }
          }
        }
        if (Object.keys(launchAssets).length > 0) {
          return { launchAssets, assets: [...assets], source: 'metadata.json' };
        }
      }
    } catch (error) {
      console.warn(`[publish] metadata.json 解析失败，改用目录扫描: ${error.message}`);
    }
  }

  const launchAssets = {};
  const assets = [];
  for (const file of walkFilesSync(dir)) {
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file);
    if (SKIP_NAMES.has(base) || ext === '.map' || ext === '.html') continue;
    if (BUNDLE_EXT.has(ext)) {
      const platform = platformOf(file);
      if (platform && !launchAssets[platform]) {
        launchAssets[platform] = file;
        continue;
      }
    }
    if (!base.startsWith('.')) assets.push(file);
  }
  return { launchAssets, assets, source: '目录扫描' };
}

/**
 * 写入产物并生成 gzip 副本。
 * 压缩后反而更大时（已压缩的图片/字体）不落盘，避免白占空间。
 */
async function writeArtifact(target, buffer) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer);
  const gz = zlib.gzipSync(buffer, { level: 9 });
  if (gz.length < buffer.length) {
    await fsp.writeFile(`${target}.gz`, gz);
  }
}

async function copyIntoRelease(dir, releaseDirPath, parsed) {
  const launchAssets = {};
  const assets = [];
  // 资产 key/hash 在发布时算一次写入 metadata，manifest 请求不再读产物文件。
  const assetIndex = {};

  for (const [platform, source] of Object.entries(parsed.launchAssets)) {
    const buffer = await fsp.readFile(path.join(dir, source));
    const ext = path.extname(source).toLowerCase() || '.js';
    const name = `bundles/${md5Hex(buffer)}${ext}`;
    await writeArtifact(path.join(releaseDirPath, name), buffer);
    launchAssets[platform] = name;
    assetIndex[name] = {
      key: md5Hex(buffer),
      hash: sha256Base64Url(buffer),
      contentType: 'application/javascript',
    };
  }

  for (const source of parsed.assets) {
    const buffer = await fsp.readFile(path.join(dir, source));
    const ext = path.extname(source).toLowerCase();
    const name = `assets/${md5Hex(buffer)}${ext}`;
    await writeArtifact(path.join(releaseDirPath, name), buffer);
    if (!assets.includes(name)) {
      assets.push(name);
      assetIndex[name] = {
        key: md5Hex(buffer),
        hash: sha256Base64Url(buffer),
        contentType: contentTypeFor(name),
      };
    }
  }

  return { launchAssets, assets, assetIndex };
}

/** 自检直连服务本身，与对外 asset 前缀（OTA_PUBLIC_BASE_URL）解耦。 */
function serviceBaseUrl() {
  const health = process.env.OTA_HEALTH_URL;
  if (health) {
    try {
      return new URL(health).origin;
    } catch {
      // 忽略非法 URL，回落到 localhost
    }
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

/** 发布后自检：拉一次真实 manifest，校验协议/通道/资源/签名。 */
function runPreflight(runtimeVersion, args) {
  const script = path.join(ROOT, 'scripts', 'preflight.mjs');
  const base = serviceBaseUrl();
  const result = spawnSync(
    process.execPath,
    [script, '--channel', args.channel, '--rv', String(runtimeVersion), '--url', base],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status === 0) {
    console.log('[publish] 发布后自检通过');
    return true;
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const failures = output
    .split('\n')
    .filter((line) => line.includes('[FAIL]'))
    .join('\n');
  console.error('[publish] 发布后自检失败：');
  console.error(failures || output.slice(-600));
  return false;
}

async function finalizePublish(runtimeVersion, args) {
  if (!args.preflight) return;
  if (runPreflight(runtimeVersion, args)) return;

  if (!args.autoRollback) {
    console.error('[publish] 可用 --auto-rollback-on-fail 自动回到 previous，或手动执行 ota:rollback');
    process.exitCode = 1;
    return;
  }

  const current = await readChannel(runtimeVersion, args.channel);
  const previous = current?.previous?.releaseId;
  if (!previous) {
    console.error('[publish] 自检失败，且通道没有 previous，无法自动回滚');
    process.exitCode = 1;
    return;
  }
  console.error(`[publish] 自检失败，自动回滚到 ${previous}`);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--release',
      previous,
      '--channel',
      args.channel,
      '--runtime-version',
      String(runtimeVersion),
      '--no-preflight',
      '--operator',
      `${args.operator}:autorevert`,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exitCode = result.status === 0 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeVersion = resolveRuntimeVersion(args.runtimeVersion);
  const rollout = parseRollout(args);
  console.log(
    `[publish] runtimeVersion = ${runtimeVersion}, channel = ${args.channel}`,
  );

  if (args.list) {
    const ids = await listReleaseIds(runtimeVersion);
    const channels = await listChannels(runtimeVersion);
    console.log(`\n[publish] runtimeVersion ${runtimeVersion} 的通道:`);
    for (const name of channels) {
      const record = await readChannel(runtimeVersion, name);
      const state = record?.rollback
        ? '回滚指令（内置包）'
        : record?.releaseId || '无';
      const previous = record?.previous?.releaseId
        ? `  previous=${record.previous.releaseId}`
        : '';
      const roll = record?.rollout
        ? `  rollout=${record.rollout.percentage}%` +
          (record.rollout.byPlatform
            ? ` byPlatform=${JSON.stringify(record.rollout.byPlatform)}`
            : '') +
          (record.rollout.whitelist?.length
            ? `(whitelist ${record.rollout.whitelist.length})`
            : '')
        : '';
      const inherited = record?.inheritedFrom
        ? `  (继承 ${record.inheritedFrom})`
        : '';
      const target = name === args.channel ? '  <- 本次目标' : '';
      console.log(
        `  ${name.padEnd(12)} ${state}${previous}${roll}${inherited}${target}`,
      );
    }

    console.log('\n[publish] 历史版本（新 → 旧）:');
    for (const id of ids) {
      const meta = await readJson(
        path.join(releaseDir(runtimeVersion, id), 'metadata.json'),
      );
      const restored = meta?.restoredFrom ? `  (源自 ${meta.restoredFrom})` : '';
      console.log(
        `  ${id}  ${meta?.createdAt || '无时间'}  ${meta?.id || '无 id'}${restored}`,
      );
    }
    if (ids.length === 0) console.log('  (无历史版本)');
    console.log('\n灰度放量: npm run ota:rollout -- --channel beta --percentage 20');
    console.log('切换版本: npm run ota:publish -- --release <id> --channel <name>');
    return;
  }

  if (args.touch && (args.release || args.rollback)) {
    throw new Error('--touch 不能与 --release / --rollback 同时使用');
  }

  // --touch：重新发布通道当前版本（刷新 createdAt、生成新 updateId）。
  if (args.touch) {
    const current = await readChannel(runtimeVersion, args.channel);
    if (!current?.releaseId) {
      throw new Error(
        `通道 ${args.channel} 当前没有可刷新的版本（指针为空或已下发回滚指令）`,
      );
    }
    console.log(
      `[publish] --touch：基于版本 ${current.releaseId} 刷新通道 ${args.channel}`,
    );
    args.release = current.releaseId;
  }

  if (args.rollback && args.release) {
    throw new Error('--rollback 与 --release 不能同时使用');
  }

  if (args.release) {
    const ids = await listReleaseIds(runtimeVersion);
    if (!ids.includes(args.release)) {
      throw new Error(
        `版本 ${args.release} 不存在。可用版本: ${ids.join(', ') || '(无)'}`,
      );
    }
    const sourceDir = releaseDir(runtimeVersion, args.release);
    const sourceMeta = await readJson(path.join(sourceDir, 'metadata.json'));
    if (!sourceMeta) {
      throw new Error(`版本 ${args.release} 缺少 metadata.json`);
    }

    // 不能只把指针指回旧目录：expo-updates 会因该版本的 createdAt 早于当前
    // 运行版本而跳过。因此复制其内容重新发布一个新版本，刷新时间戳。
    const newReleaseId = String(Date.now());
    const targetDir = releaseDir(runtimeVersion, newReleaseId);
    await fsp.mkdir(targetDir, { recursive: true });
    for (const sub of ['bundles', 'assets']) {
      const src = path.join(sourceDir, sub);
      if (fs.existsSync(src)) {
        await fsp.cp(src, path.join(targetDir, sub), { recursive: true });
      }
    }
    const expoConfigSrc = path.join(sourceDir, 'expoConfig.json');
    if (fs.existsSync(expoConfigSrc)) {
      await fsp.copyFile(expoConfigSrc, path.join(targetDir, 'expoConfig.json'));
    }

    const createdAt = new Date().toISOString();
    const id = hexToUuid(
      sha256Hex(Buffer.from(`${runtimeVersion}:${newReleaseId}`)),
    );
    await writeJsonAtomic(path.join(targetDir, 'metadata.json'), {
      ...sourceMeta,
      id,
      createdAt,
      restoredFrom: args.release,
      metadata: { ...(sourceMeta.metadata || {}), channel: args.channel },
    });
    await withLock(
      `${runtimeVersion}:${args.channel}`,
      channelLockFile(runtimeVersion, args.channel),
      () =>
        promoteRelease(runtimeVersion, args.channel, newReleaseId, {
          updateId: id,
          createdAt,
          rollout,
          action: args.touch ? 'republish' : 'promote',
          operator: args.operator,
          via: args.via,
          requestId: args.requestId,
          params: { restoredFrom: args.release, rollout },
        }),
    );
    console.log(
      `\n[publish] 已基于版本 ${args.release} 重新发布（通道 ${args.channel}）`,
    );
    console.log(`  新版本目录: ${path.relative(ROOT, targetDir)}`);
    console.log(`  updateId: ${id}`);
    console.log('  已刷新 createdAt，确保客户端接受该更新');
    await finalizePublish(runtimeVersion, args);
    return;
  }

  if (args.rollback) {
    await withLock(
      `${runtimeVersion}:${args.channel}`,
      channelLockFile(runtimeVersion, args.channel),
      () =>
        setRollback(runtimeVersion, args.channel, {
          operator: args.operator,
          via: args.via,
          requestId: args.requestId,
        }),
    );
    console.log(
      `[publish] 已下发回滚指令（通道 ${args.channel}，客户端将回到内置包）`,
    );
    return;
  }

  const dir = args.fromDir || exportBundles();
  if (!fs.existsSync(dir)) {
    throw new Error(`导出目录不存在: ${dir}`);
  }

  const parsed = parseExport(dir);
  const platforms = Object.keys(parsed.launchAssets);
  if (platforms.length === 0) {
    throw new Error(
      `未在 ${dir} 找到 iOS/Android bundle。请先安装依赖并执行 npx expo export，或检查 dist 结构。`,
    );
  }
  console.log(`[publish] 产物来源: ${parsed.source}`);
  console.log(`[publish] 发现平台: ${platforms.join(', ')}`);

  const releaseId = String(Date.now());
  const releaseDirPath = path.join(UPDATES_DIR, runtimeVersion, releaseId);
  await fsp.mkdir(releaseDirPath, { recursive: true });

  const files = await copyIntoRelease(dir, releaseDirPath, parsed);
  const createdAt = new Date().toISOString();
  const id = hexToUuid(sha256Hex(Buffer.from(`${runtimeVersion}:${releaseId}`)));

  await writeJsonAtomic(path.join(releaseDirPath, 'metadata.json'), {
    id,
    createdAt,
    runtimeVersion,
    platforms,
    launchAssets: files.launchAssets,
    assets: files.assets,
    assetIndex: files.assetIndex,
    metadata: { channel: args.channel },
  });

  try {
    const appConfig = require(path.join(MOBILE_DIR, 'app.config.js'));
    await writeJsonAtomic(
      path.join(releaseDirPath, 'expoConfig.json'),
      appConfig.expo || appConfig,
    );
  } catch (error) {
    console.warn(`[publish] 写入 expoConfig.json 失败（不影响更新）: ${error.message}`);
  }

  const channel = await withLock(
    `${runtimeVersion}:${args.channel}`,
    channelLockFile(runtimeVersion, args.channel),
    () =>
      promoteRelease(runtimeVersion, args.channel, releaseId, {
        updateId: id,
        createdAt,
        rollout,
        action: 'publish',
        operator: args.operator,
        via: args.via,
        requestId: args.requestId,
        params: { rollout },
      }),
  );

  console.log('\n[publish] 发布完成');
  console.log(`  版本目录: ${path.relative(ROOT, releaseDirPath)}`);
  console.log(`  updateId: ${id}`);
  console.log(`  launchAssets: ${JSON.stringify(files.launchAssets)}`);
  console.log(`  assets 数量: ${files.assets.length}`);
  console.log(
    `  rollout: ${channel.rollout.percentage}%` +
      (channel.rollout.whitelist.length
        ? `（白名单 ${channel.rollout.whitelist.length} 个）`
        : ''),
  );
  if (channel.rollout.byPlatform) {
    console.log(
      `  byPlatform: ${JSON.stringify(channel.rollout.byPlatform)}（覆盖优先生效；current/previous 双端共用）`,
    );
  }
  if (channel.previous?.releaseId) {
    console.log(`  previous: ${channel.previous.releaseId}`);
  }
  console.log('\n协议自检: node scripts/verify-manifest.mjs --platform ios');
  console.log('灰度放量: node scripts/rollout.mjs --channel <name> --percentage 20');
  console.log('历史版本: node scripts/publish.mjs --list');
  console.log('回滚上一版本: node scripts/rollback.mjs --channel <name>');
  await finalizePublish(runtimeVersion, args);
}

main().catch((error) => {
  console.error(`[publish] 失败: ${error.message}`);
  process.exitCode = 1;
});
