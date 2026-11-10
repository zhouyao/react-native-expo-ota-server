#!/usr/bin/env node
/**
 * 注册原生构建里内置的 bundle，让「全新安装」的设备首次 OTA 也能走差分。
 *
 * 客户端会在 asset 请求里带 Expo-Embedded-Update-ID（来自构建期 app.manifest 的 id），
 * 服务端据此找到内置的 launchAsset 作为 bsdiff 的 base。
 *
 *   npm run ota:embedded -- --platform android --channel canary --auto
 *   npm run ota:embedded -- --platform ios --rv 1 --bundle-dir <.../EXUpdates.bundle>
 *   node scripts/register-embedded.mjs --platform android \
 *     --bundle <path/to/index.android.bundle> --manifest <path/to/app.manifest>
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  embeddedDir,
  invalidatePatchCache,
  maxBases,
  patchIndexPath,
} from '../services/ota/src/patch-store.mjs';
import {
  sha256Base64Url,
  sha256Hex,
  writeJsonAtomic,
} from '../services/ota/src/lib.mjs';
import { generatePatchesFromEmbedded } from './patches.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'apps/mobile');
const require = createRequire(import.meta.url);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUNDLE_NAMES = ['main.jsbundle', 'index.ios.bundle', 'index.android.bundle'];

function appConfig() {
  return require(path.join(APP_DIR, 'app.config.js')).expo;
}

function parseArgs(argv) {
  const config = appConfig();
  const args = {
    platform: null,
    rv: null,
    channel: config.updates?.requestHeaders?.['expo-channel-name'] || config.updates?.channel || 'development',
    variant: 'release',
    bundle: null,
    manifest: null,
    bundleDir: null,
    auto: false,
    patches: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--platform') args.platform = argv[++i];
    else if (key === '--rv' || key === '--runtime-version') args.rv = argv[++i];
    else if (key === '--channel') args.channel = argv[++i];
    else if (key === '--variant') args.variant = argv[++i];
    else if (key === '--bundle') args.bundle = path.resolve(argv[++i]);
    else if (key === '--manifest') args.manifest = path.resolve(argv[++i]);
    else if (key === '--bundle-dir') args.bundleDir = path.resolve(argv[++i]);
    else if (key === '--auto') args.auto = true;
    else if (key === '--no-patches') args.patches = false;
    else if (key === '--help' || key === '-h') args.help = true;
  }
  return args;
}

function resolveRuntimeVersion(explicit) {
  if (explicit) return String(explicit);
  const rv = appConfig().runtimeVersion;
  if (typeof rv === 'string') return rv;
  if (rv?.policy === 'appVersion') return appConfig().version;
  throw new Error('app.config.js 使用了 fingerprint 策略，请显式传入 --rv');
}

/** 从目录里挑一个最像 launchAsset 的 bundle（显式文件名优先，否则取最大的候选）。 */
function pickBundle(dir, names = []) {
  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const known = [...BUNDLE_NAMES, ...names.map((n) => n.toLowerCase())].some(
      (name) => lower === name,
    );
    const ext = path.extname(entry.name).toLowerCase();
    if (!known && !['.bundle', '.jsbundle', '.hbc', '.js'].includes(ext)) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(file);
      candidates.push({ file, size: stat.size, known });
    } catch {
      // 忽略不可读文件
    }
  }
  candidates.sort((a, b) => Number(b.known) - Number(a.known) || b.size - a.size);
  return candidates[0]?.file || null;
}

function androidDefaults(args) {
  const variant = args.variant;
  const capital = variant.charAt(0).toUpperCase() + variant.slice(1);
  return {
    bundle: path.join(
      APP_DIR,
      `android/app/build/generated/assets/react/${variant}/index.android.bundle`,
    ),
    manifest: path.join(
      APP_DIR,
      `android/app/build/generated/assets/create${capital}UpdatesResources/app.manifest`,
    ),
  };
}

/** 扫描 Xcode DerivedData，找最新一次构建的 EXUpdates.bundle/app.manifest。 */
function iosDefaults() {
  const derived = path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData');
  const found = [];
  let projects;
  try {
    projects = fs.readdirSync(derived, { withFileTypes: true });
  } catch {
    return {};
  }
  for (const project of projects) {
    if (!project.isDirectory() || !project.name.startsWith('HotUpdateDemo-')) continue;
    const products = path.join(derived, project.name, 'Build/Products');
    let configs;
    try {
      configs = fs.readdirSync(products, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const config of configs) {
      if (!config.isDirectory()) continue;
      let apps;
      try {
        apps = fs.readdirSync(path.join(products, config.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const app of apps) {
        if (!app.isDirectory() || !app.name.endsWith('.app')) continue;
        const appDir = path.join(products, config.name, app.name);
        const bundleDir = path.join(appDir, 'EXUpdates.bundle');
        const manifest = path.join(bundleDir, 'app.manifest');
        if (!fs.existsSync(manifest)) continue;
        found.push({
          manifest,
          appDir,
          bundleDir,
          mtime: fs.statSync(manifest).mtimeMs,
        });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const latest = found[0];
  if (!latest) return {};
  return {
    manifest: latest.manifest,
    bundle:
      pickBundle(latest.appDir) ||
      pickBundle(latest.bundleDir) ||
      pickBundle(path.join(latest.bundleDir, 'Contents/Resources')),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !['ios', 'android'].includes(args.platform)) {
    console.log(`用法: node scripts/register-embedded.mjs --platform <ios|android> [选项]
  --auto                 自动探测本机最近一次原生构建产物
  --bundle <path>        内置 launchAsset（Hermes bytecode / JS bundle）
  --manifest <path>      构建期生成的 app.manifest（含 embedded updateId）
  --bundle-dir <path>    EXUpdates.bundle 或 .app 目录，自动定位上述两个文件
  --platform <p>         ios | android（必填）
  --channel <name>       构建通道，默认读 app.config.js
  --rv <runtimeVersion>  默认读 app.config.js
  --variant <v>          Android 构建变体，默认 release
  --no-patches           只注册，不生成补丁`);
    if (!args.help) process.exitCode = 1;
    return;
  }

  const rv = resolveRuntimeVersion(args.rv);
  let bundleFile = args.bundle;
  let manifestFile = args.manifest;
  if (args.bundleDir) {
    manifestFile ||= path.join(args.bundleDir, 'app.manifest');
    bundleFile ||=
      pickBundle(args.bundleDir) ||
      pickBundle(path.dirname(args.bundleDir)) ||
      pickBundle(path.join(args.bundleDir, 'Contents/Resources'));
  }
  if (args.auto || !bundleFile || !manifestFile) {
    const defaults = args.platform === 'android' ? androidDefaults(args) : iosDefaults();
    bundleFile ||= defaults.bundle;
    manifestFile ||= defaults.manifest;
  }

  if (!bundleFile || !fs.existsSync(bundleFile)) {
    throw new Error(`找不到内置 bundle${bundleFile ? `: ${bundleFile}` : ''}；请先完成 Release 构建，或用 --bundle 指定`);
  }
  if (!manifestFile || !fs.existsSync(manifestFile)) {
    throw new Error(`找不到 app.manifest${manifestFile ? `: ${manifestFile}` : ''}；或用 --manifest 指定`);
  }

  const embeddedManifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  const updateId = String(embeddedManifest.id || '').toLowerCase();
  if (!UUID_RE.test(updateId)) {
    throw new Error(`app.manifest 的 id 不是规范 UUID: ${embeddedManifest.id}`);
  }
  const buffer = await fsp.readFile(bundleFile);
  if (buffer.length === 0) throw new Error(`内置 bundle 是空文件: ${bundleFile}`);

  const hash = sha256Base64Url(buffer);
  const ext = path.extname(bundleFile).toLowerCase() || '.hbc';
  const name = `${sha256Hex(buffer).slice(0, 32)}${ext}`;
  const dest = path.join(embeddedDir(rv), 'bundles', name);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buffer);

  const record = {
    updateId,
    platform: args.platform,
    channel: args.channel,
    runtimeVersion: rv,
    bundle: `bundles/${name}`,
    hash,
    size: buffer.length,
    commitTime: embeddedManifest.commitTime || null,
    source: path.relative(ROOT, bundleFile),
    manifestSource: path.relative(ROOT, manifestFile),
    registeredAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(embeddedDir(rv), `${updateId}.json`), record);
  invalidatePatchCache(rv);

  console.log(`[embedded] 已注册 ${args.platform} 内置包`);
  console.log(`  updateId:  ${updateId}`);
  console.log(`  channel:   ${args.channel}  runtimeVersion: ${rv}`);
  console.log(`  bundle:    ${record.bundle} (${buffer.length}B, ${hash.slice(0, 12)}…)`);
  console.log(`  manifest:  ${record.manifestSource}`);

  if (args.patches) {
    console.log(`[embedded] 以该内置包为 base 生成补丁（最多 ${maxBases()} 个目标）`);
    const result = await generatePatchesFromEmbedded(rv, record, { log: console.log });
    console.log(
      `[embedded] 生成 ${result.generated}，跳过 ${result.skipped}，失败 ${result.failed}` +
        (result.unavailable ? '（bsdiff 不可用，发布期仍可正常全量更新）' : ''),
    );
    console.log(`[embedded] 补丁索引: ${path.relative(ROOT, patchIndexPath(rv))}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[embedded] 失败: ${error.message}`);
    process.exitCode = 1;
  });
}
