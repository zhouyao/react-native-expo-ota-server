#!/usr/bin/env node
/**
 * 一键生成「Android 模拟器 / 真机 + 研发通道」Release 包：
 *   1. 探测 Android SDK 与 JDK，写入 android/local.properties；
 *   2. 生成本地 OTA 地址（默认 localhost + adb reverse，手机走 USB 也能用；
 *      想用局域网地址传 --lan，或直接 --url 覆盖）；
 *   3. prebuild 把 channel / url / runtimeVersion 写进 AndroidManifest，并逐项校验
 *      （原生配置已一致时跳过 prebuild，避免清空 build 目录导致全量重编）；
 *   4. 启动模拟器（无设备时自动开机）、adb reverse、Release 构建并安装。
 *
 * 用法：
 *   npm run mobile:android:dev
 *   npm run mobile:android:dev -- --channel canary --avd Pixel_7_API_36
 *   npm run mobile:android:dev -- --lan            # 用局域网 IP（Wi-Fi 真机）
 *   npm run mobile:android:dev -- --url http://10.0.2.2:3000/api/manifest
 *   npm run mobile:android:dev -- --prebuild       # 强制重新生成 android/
 *   npm run mobile:android:dev -- --skip-build
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'apps/mobile');
const ANDROID_DIR = path.join(APP_DIR, 'android');
const MANIFEST = path.join(ANDROID_DIR, 'app/src/main/AndroidManifest.xml');
const STRINGS = path.join(ANDROID_DIR, 'app/src/main/res/values/strings.xml');
const LOCAL_PROPS = path.join(ANDROID_DIR, 'local.properties');
const PORT = process.env.PORT || '3000';

function parseArgs(argv) {
  const args = {
    channel: 'development',
    url: null,
    lan: false,
    avd: process.env.ANDROID_AVD || null,
    device: process.env.ANDROID_SERIAL || null,
    variant: 'release',
    skipPrebuild: false,
    forcePrebuild: false,
    skipBuild: false,
    reverse: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--channel') args.channel = argv[++i];
    else if (key === '--url') args.url = argv[++i];
    else if (key === '--lan') args.lan = true;
    else if (key === '--avd') args.avd = argv[++i];
    else if (key === '--device') args.device = argv[++i];
    else if (key === '--variant') args.variant = argv[++i];
    else if (key === '--prebuild') args.forcePrebuild = true;
    else if (key === '--skip-prebuild') args.skipPrebuild = true;
    else if (key === '--skip-build') args.skipBuild = true;
    else if (key === '--no-reverse') args.reverse = false;
    else if (key === '--help' || key === '-h') {
      console.log(
        '用法: node scripts/dev-android.mjs [--channel development] [--avd <AVD名>] [--device <serial>]\n' +
          '              [--lan] [--url http://localhost:3000/api/manifest] [--variant release]\n' +
          '              [--prebuild] [--skip-prebuild] [--skip-build] [--no-reverse]',
      );
      process.exit(0);
    } else {
      console.error(`未知参数 ${key}，用 --help 查看用法`);
      process.exit(1);
    }
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

/** SDK 位置：ANDROID_HOME / ANDROID_SDK_ROOT / Android Studio 默认路径。 */
function resolveSdkDir() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library/Android/sdk'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'platform-tools/adb'))) return dir;
  }
  console.error(
    '未找到 Android SDK（需要 <sdk>/platform-tools/adb）。\n' +
      '  安装：sdkmanager --install "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "emulator" "system-images;android-36;google_apis;x86_64"\n' +
      '  或设置 ANDROID_HOME 指向已有 SDK。',
  );
  process.exit(1);
}

/** JDK 位置：JAVA_HOME / ~/.jdks/temurin-21 / macOS 注册的 JVM。 */
function resolveJavaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    path.join(os.homedir(), '.jdks/temurin-21/Contents/Home'),
    path.join(os.homedir(), '.jdks/temurin-17/Contents/Home'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'bin/java'))) return dir;
  }
  try {
    const dir = execFileSync('/usr/libexec/java_home', ['-v', '17+'], {
      encoding: 'utf8',
    }).trim();
    if (dir && fs.existsSync(path.join(dir, 'bin/java'))) return dir;
  } catch {
    // 系统没装 JDK
  }
  console.error(
    '未找到 JDK 17+。安装示例：\n' +
      '  curl -L -o /tmp/jdk.tar.gz https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/mac/OpenJDK21U-jdk_x64_mac_hotspot_21.0.13_9.tar.gz\n' +
      '  mkdir -p ~/.jdks/temurin-21 && tar xzf /tmp/jdk.tar.gz -C ~/.jdks/temurin-21 --strip-components=1',
  );
  process.exit(1);
}

/**
 * 构建子进程环境：剔除 NODE_OPTIONS，避免宿主 node 钩子拦截构建脚本；
 * PATH 前置 JDK 与 SDK 工具，保证 gradle / adb / sdkmanager 可被找到。
 */
function buildEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  env.PATH = [
    env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin'),
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools'),
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'emulator'),
    env.PATH || '',
  ]
    .filter(Boolean)
    .join(':');
  return env;
}

function run(cmd, args, env, cwd = APP_DIR) {
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** 从 AndroidManifest.xml 里取出 application 下的 meta-data 键值对。 */
function readMetaData(xml) {
  const out = {};
  const blocks = xml.match(/<meta-data\b[^>]*>/g) || [];
  for (const block of blocks) {
    const name = block.match(/android:name="([^"]+)"/);
    const value = block.match(/android:value="([^"]*)"/);
    if (name) out[name[1]] = value ? decodeEntities(value[1]) : undefined;
  }
  return out;
}

function readApplicationAttr(xml, attr) {
  const app = xml.match(/<application\b[^>]*>/);
  if (!app) return null;
  const m = app[0].match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

function readStrings(xml) {
  const out = {};
  for (const m of xml.matchAll(/<string name="([^"]+)"[^>]*>([^<]*)<\/string>/g)) {
    out[m[1]] = decodeEntities(m[2]);
  }
  return out;
}

/** 返回原生配置与期望的差异列表；空数组表示可以直接增量构建。 */
function collectNativeProblems({ channel, url, expect }) {
  if (!fs.existsSync(MANIFEST)) return ['android/ 尚未生成（缺少 AndroidManifest.xml）'];
  const xml = fs.readFileSync(MANIFEST, 'utf8');
  const meta = readMetaData(xml);
  const strings = fs.existsSync(STRINGS) ? readStrings(fs.readFileSync(STRINGS, 'utf8')) : {};
  const problems = [];

  const push = (label, actual, expected) => {
    if (String(actual) !== String(expected)) {
      problems.push(`${label}=${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
    }
  };

  push('EXPO_UPDATE_URL', meta['expo.modules.updates.EXPO_UPDATE_URL'], url);
  push('ENABLED', meta['expo.modules.updates.ENABLED'], 'true');
  push('EXPO_RUNTIME_VERSION', meta['expo.modules.updates.EXPO_RUNTIME_VERSION'], '@string/expo_runtime_version');
  push('strings.expo_runtime_version', strings.expo_runtime_version, expect.runtimeVersion);

  // Android 认的是请求头 JSON 里的 expo-channel-name（不是独立的 channel 字段）
  const rawHeaders = meta['expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY'];
  let headers = {};
  try {
    headers = JSON.parse(rawHeaders || '{}');
  } catch {
    problems.push(`REQUEST_HEADERS 不是合法 JSON：${rawHeaders}`);
  }
  push('REQUEST_HEADERS.expo-channel-name', headers['expo-channel-name'], channel);

  if (!meta['expo.modules.updates.CODE_SIGNING_CERTIFICATE']) {
    problems.push('CODE_SIGNING_CERTIFICATE 缺失（客户端不会校验签名）');
  }

  const nativeSwitch = meta['expo.modules.updates.DISABLE_ANTI_BRICKING_MEASURES'] === 'true';
  push('DISABLE_ANTI_BRICKING_MEASURES', nativeSwitch, expect.channelSwitch);

  const cleartext = readApplicationAttr(xml, 'android:usesCleartextTraffic');
  const isHttp = /^http:\/\//i.test(url);
  if (isHttp && cleartext !== 'true') {
    problems.push('usesCleartextTraffic 未开启，Android release 包会拦截 http:// 更新请求');
  }
  if (!isHttp && cleartext === 'true') {
    problems.push('usesCleartextTraffic=true 被打进了 HTTPS 包');
  }

  return problems;
}

function verifyNativeConfig(target) {
  const problems = collectNativeProblems(target);
  const { channel, url, expect } = target;
  if (problems.length) {
    console.error('[verify] Android 原生配置与期望不一致：');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  提示：确认 plugins/withUpdatesChannel 生效，或删除 android/ 后重新 prebuild。');
    process.exit(1);
  }
  console.log(`[verify] channel=${channel} url=${url} runtimeVersion=${expect.runtimeVersion} 已写入原生`);
}

function adb(serial, args, opts = {}) {
  const base = serial ? ['-s', serial, ...args] : args;
  const adbPath = path.join(sdkDir, 'platform-tools/adb');
  return execFileSync(fs.existsSync(adbPath) ? adbPath : 'adb', base, { encoding: 'utf8', ...opts });
}

function listDevices() {
  const out = adb(null, ['devices']);
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
}

function listAvds(sdkDir) {
  try {
    return execFileSync(path.join(sdkDir, 'emulator/emulator'), ['-list-avds'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function waitForBoot(serial, timeoutMs = 240_000) {
  const started = Date.now();
  adb(serial, ['wait-for-device']);
  while (Date.now() - started < timeoutMs) {
    const booted = adb(serial, ['shell', 'getprop', 'sys.boot_completed']).trim();
    if (booted === '1') return true;
    execFileSync('sleep', ['3']);
  }
  return false;
}

function bootEmulator(sdkDir, avdName) {
  console.log(`[1/4] 没有在线设备，启动模拟器 ${avdName}`);
  const child = spawn(
    path.join(sdkDir, 'emulator/emulator'),
    ['-avd', avdName, '-netdelay', 'none', '-netspeed', 'full', '-no-boot-anim'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const emulator = listDevices().find((d) => d.startsWith('emulator-'));
    if (emulator) {
      if (!waitForBoot(emulator)) {
        console.error('模拟器启动超时（sys.boot_completed != 1）');
        process.exit(1);
      }
      return emulator;
    }
    execFileSync('sleep', ['2']);
  }
  console.error('等待模拟器上线超时。手动启动：emulator -avd ' + avdName);
  process.exit(1);
}

/** 只编目标设备实际需要的 ABI。 */
function pinArchitectures(serial) {
  const propsPath = path.join(ANDROID_DIR, 'gradle.properties');
  if (!fs.existsSync(propsPath)) return;
  let abi = '';
  try {
    abi = adb(serial, ['shell', 'getprop', 'ro.product.cpu.abi']).trim();
  } catch {
    return;
  }
  if (!['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].includes(abi)) return;
  const source = fs.readFileSync(propsPath, 'utf8');
  fs.writeFileSync(propsPath, source.replace(/^reactNativeArchitectures=.*$/m, `reactNativeArchitectures=${abi}`));
  console.log(`      仅编译 ${abi}`);
}

const args = parseArgs(process.argv.slice(2));
const sdkDir = resolveSdkDir();
const javaHome = resolveJavaHome();
process.env.ANDROID_HOME = sdkDir;
process.env.ANDROID_SDK_ROOT = sdkDir;

const lanIp = detectLanIp();
if (args.lan && !lanIp) {
  console.error('未探测到局域网 IP，请改用 --url http://<mac-ip>:3000/api/manifest');
  process.exit(1);
}
const otaUrl =
  args.url ||
  (args.lan ? `http://${lanIp}:${PORT}/api/manifest` : `http://localhost:${PORT}/api/manifest`);

// 让 app.config.js 在本次构建里读到同一组值（prebuild 与校验共用）
process.env.EXPO_PUBLIC_APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || 'development';
process.env.EXPO_PUBLIC_CHANNEL = args.channel;
process.env.EXPO_PUBLIC_OTA_URL = otaUrl;

const require_ = createRequire(import.meta.url);
const expoConfig = require_(path.join(APP_DIR, 'app.config.js')).expo;
const expect = {
  runtimeVersion: String(expoConfig.runtimeVersion),
  channelSwitch: Boolean(expoConfig.extra?.enableChannelSwitch),
};

const env = buildEnv({
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdkDir,
  ANDROID_SDK_ROOT: sdkDir,
  EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV,
  EXPO_PUBLIC_CHANNEL: args.channel,
  EXPO_PUBLIC_OTA_URL: otaUrl,
});

console.log(`[1/4] 通道 ${args.channel} / OTA 地址 ${otaUrl}`);
console.log(`      SDK ${sdkDir}`);
console.log(`      JDK ${javaHome}`);

const target = { channel: args.channel, url: otaUrl, expect };
// prebuild 会清空 android/（含 build 目录），每次都跑等于每次都全量重编。
// 原生配置已经和目标一致时就跳过，只有配置漂移或显式 --prebuild 才重新生成。
let needPrebuild = !args.skipPrebuild && args.forcePrebuild;
if (!args.skipPrebuild && !args.forcePrebuild) {
  needPrebuild = collectNativeProblems(target).length > 0;
  if (!needPrebuild) console.log('[2/4] 原生配置已一致，跳过 prebuild（--prebuild 可强制重建）');
}
if (needPrebuild) {
  console.log('[2/4] prebuild 同步 android 工程');
  run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], env);
} else if (args.skipPrebuild) {
  console.log('[2/4] 跳过 prebuild');
}

// gradle 只认 local.properties / ANDROID_HOME，写死一份避免 IDE 与 CLI 不一致
fs.mkdirSync(ANDROID_DIR, { recursive: true });
fs.writeFileSync(LOCAL_PROPS, `sdk.dir=${sdkDir}\n`);

verifyNativeConfig(target);

// 设备：--device 优先，其次已在线设备，最后自动开第一个 AVD
let serial = args.device;
if (!serial) {
  const devices = listDevices();
  serial =
    devices.find((d) => d.startsWith('emulator-')) || devices[0] || null;
  if (!serial) {
    const avds = listAvds(sdkDir);
    const avd = args.avd || avds[0];
    if (!avd) {
      console.error(
        '没有在线设备也没有可用 AVD。创建模拟器：\n' +
          '  avdmanager create avd -n Pixel_API_36 -k "system-images;android-36;google_apis;x86_64" -d pixel_6\n' +
          '或插入真机后执行：adb devices',
      );
      process.exit(1);
    }
    serial = bootEmulator(sdkDir, avd);
  }
}
console.log(`[3/4] 目标设备 ${serial}`);

// localhost 在设备上指向设备自己，adb reverse 把端口转发到开发机；
// 服务端 OTA_PUBLIC_BASE_URL 默认也是 localhost，所以资产下载同样受益。
const urlHost = (() => {
  try {
    return new URL(otaUrl).hostname;
  } catch {
    return '';
  }
})();
if (args.reverse && ['localhost', '127.0.0.1', '::1'].includes(urlHost)) {
  adb(serial, ['reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
  console.log(`      adb reverse tcp:${PORT} -> 开发机 ${PORT}`);
}

if (args.skipBuild) {
  console.log('[4/4] 跳过构建');
  process.exit(0);
}

// 只编目标设备的 ABI，四个架构全编会让首次构建多花一倍以上时间。
// gradle.properties 是 prebuild 产物，每次 prebuild 都会重置，所以每次构建前重新钉一次。
pinArchitectures(serial);

console.log(`[4/4] 构建 ${args.variant} 并安装到 ${serial}`);
const runArgs = ['expo', 'run:android', '--variant', args.variant, '--no-bundler'];
if (args.device) runArgs.push('--device', serial);
run('npx', runArgs, env);

// 注册本次构建内置的 bundle，让全新安装的设备首次 OTA 也能命中 bsdiff 补丁。
// 找不到构建产物或 bsdiff 时只告警，绝不阻断构建。
if (process.env.OTA_REGISTER_EMBEDDED !== '0') {
  try {
    run(process.execPath, [
      path.join(ROOT, 'scripts/register-embedded.mjs'),
      '--platform', 'android',
      '--channel', args.channel,
      '--rv', String(expect.runtimeVersion),
      '--variant', args.variant,
      '--auto',
    ], env);
  } catch (error) {
    console.warn(`[embedded] 内置包注册失败（不影响构建）: ${error.message}`);
  }
}

console.log(`
完成。验证 OTA：
  adb -s ${serial} shell am force-stop ${expoConfig.android.package}
  adb -s ${serial} shell monkey -p ${expoConfig.android.package} -c android.intent.category.LAUNCHER 1
  adb -s ${serial} logcat -s dev.expo.updates:V ReactNativeJS:V | grep -i -E "update|embedded"

第一次冷启动下载、第二次冷启动生效；页面 isEmbeddedLaunch 为 false 即已跑 OTA 版本。
`);
