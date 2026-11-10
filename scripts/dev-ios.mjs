#!/usr/bin/env node
/**
 * 一键生成「真机 + 研发通道」Release 包：
 *   1. 探测局域网 IP（手机要能访问），写入 EXPO_PUBLIC_OTA_URL；
 *   2. 固定 EXPO_PUBLIC_CHANNEL=development，prebuild 把通道写进原生；
 *   3. 校验原生 Expo.plist 的 channel / requestHeaders / url 三处一致（避免两者打架）；
 *   4. expo run:ios --configuration Release 构建并安装到真机。
 *
 * 用法：
 *   npm run mobile:ios:dev -- --device "<device-name>"
 *   npm run mobile:ios:dev -- --channel canary --url http://<lan-ip>:3000/api/manifest
 *   npm run mobile:ios:dev -- --device "<device-name>" --skip-prebuild
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'apps/mobile');
const EXPO_PLIST = path.join(APP_DIR, 'ios/HotUpdateDemo/Supporting/Expo.plist');
const PORT = process.env.PORT || '3000';

function parseArgs(argv) {
  const args = { channel: 'development', device: process.env.IOS_DEVICE || null, url: null, skipPrebuild: false, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--channel') args.channel = argv[++i];
    else if (key === '--device') args.device = argv[++i];
    else if (key === '--url') args.url = argv[++i];
    else if (key === '--skip-prebuild') args.skipPrebuild = true;
    else if (key === '--skip-build') args.skipBuild = true;
    else if (key === '--help' || key === '-h') {
      console.log('用法: node scripts/dev-ios.mjs [--channel development] [--device "设备名"] [--url http://ip:3000/api/manifest] [--skip-prebuild] [--skip-build]');
      process.exit(0);
    }
  }
  if (!args.device) {
    console.error('缺少 --device（或设置 IOS_DEVICE）。示例: npm run mobile:ios:dev -- --device "<device-name>"');
    process.exit(1);
  }
  return args;
}

function detectLanIp() {
  const nets = os.networkInterfaces();
  const preferred = ['en0', 'en1', 'en2', 'en3'];
  const names = [...preferred.filter((n) => nets[n]), ...Object.keys(nets)];
  for (const name of names) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function run(cmd, args, env, cwd = APP_DIR) {
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
}

/**
 * 构建子进程环境：
 * - 剔除 NODE_OPTIONS，避免宿主 node 钩子拦截构建脚本里的批量删除；
 * - 补上 nvm 的 node 与 CocoaPods 的 gem bin（系统 ruby 2.6 需要 -rlogger）。
 */
function buildEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  env.PATH = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.gem/ruby/2.6.0/bin'),
    env.PATH || '',
  ].filter(Boolean).join(':');
  env.RUBYOPT = env.RUBYOPT || '-rlogger';
  return env;
}

function readPlistKey(key) {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', EXPO_PLIST]).toString().trim();
}

function readPlistJson(key) {
  return JSON.parse(execFileSync('plutil', ['-extract', key, 'json', '-o', '-', EXPO_PLIST]).toString());
}

function verifyNativeConfig({ channel, url }) {
  const problems = [];
  const nativeChannel = readPlistKey('EXUpdatesChannel');
  if (nativeChannel !== channel) problems.push(`EXUpdatesChannel=${nativeChannel}，期望 ${channel}`);

  try {
    const headers = readPlistJson('EXUpdatesRequestHeaders');
    if (headers['expo-channel-name'] !== channel) {
      problems.push(`EXUpdatesRequestHeaders.expo-channel-name=${headers['expo-channel-name']}，期望 ${channel}`);
    }
  } catch {
    problems.push('EXUpdatesRequestHeaders 解析失败');
  }

  const nativeUrl = readPlistKey('EXUpdatesURL');
  if (nativeUrl !== url) problems.push(`EXUpdatesURL=${nativeUrl}，期望 ${url}`);

  if (problems.length) {
    console.error('[verify] 原生配置与期望不一致：');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  提示：确认 plugins/withUpdatesChannel 生效，或删除 ios/ 后重新 prebuild。');
    process.exit(1);
  }
  console.log(`[verify] channel=${channel} url=${url} 已写入原生`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.skipBuild && !process.env.EXPO_APPLE_TEAM_ID) {
  console.error('缺少 EXPO_APPLE_TEAM_ID。iOS 真机构建需要签名团队 ID，请通过环境变量传入。');
  process.exit(1);
}
const ip = detectLanIp();
if (!ip && !args.url) {
  console.error('未探测到局域网 IP，请显式传 --url http://<mac-ip>:3000/api/manifest');
  process.exit(1);
}
const otaUrl = args.url || `http://${ip}:${PORT}/api/manifest`;

console.log(`[1/3] 通道 ${args.channel} / OTA 地址 ${otaUrl}`);
const env = buildEnv({
  EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV || 'development',
  EXPO_PUBLIC_CHANNEL: args.channel,
  EXPO_PUBLIC_OTA_URL: otaUrl,
});

if (!args.skipPrebuild) {
  console.log('[2/3] prebuild 同步原生工程（保留 Pods，不重装依赖）');
  run('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install'], env);
} else {
  console.log('[2/3] 跳过 prebuild');
}
verifyNativeConfig({ channel: args.channel, url: otaUrl });

// prebuild 会清空 ios/（含 Pods 与 workspace），缺依赖时补装
const iosDir = path.join(APP_DIR, 'ios');
if (!fs.existsSync(path.join(iosDir, 'Pods')) || !fs.existsSync(path.join(iosDir, 'HotUpdateDemo.xcworkspace'))) {
  console.log('[2.5/3] 安装 iOS 原生依赖（pod install）');
  run('pod', ['install'], env, iosDir);
}

if (args.skipBuild) {
  console.log('[3/3] 跳过构建');
  process.exit(0);
}

console.log(`[3/3] 构建 Release 并安装到 ${args.device}`);
run('npx', ['expo', 'run:ios', '--configuration', 'Release', '--no-bundler', '--device', args.device], env);

// 注册本次构建内置的 bundle（自动扫描 DerivedData），让新装设备首次更新也能走差分。
if (process.env.OTA_REGISTER_EMBEDDED !== '0') {
  try {
    run(process.execPath, [
      path.join(ROOT, 'scripts/register-embedded.mjs'),
      '--platform', 'ios',
      '--channel', args.channel,
      '--auto',
    ], env);
  } catch (error) {
    console.warn(`[embedded] 内置包注册失败（不影响构建）: ${error.message}`);
  }
}

console.log('\n完成。首次冷启动下载更新，第二次冷启动生效；页面 isEmbeddedLaunch 应为 false。');
