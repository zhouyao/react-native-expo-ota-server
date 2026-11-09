import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportEnv } from './lib/export-env.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..');
const MOBILE_DIR = path.join(ROOT, 'apps', 'mobile');
const PUBLISH_SCRIPT = path.join(scriptsDir, 'publish.mjs');
const VERIFY_SCRIPT = path.join(scriptsDir, 'verify-manifest.mjs');
const SERVER_SCRIPT = path.join(ROOT, 'services', 'ota', 'src', 'server.mjs');
const HEALTH_URL = process.env.OTA_HEALTH_URL || 'http://localhost:3000/healthz';

function parseArgs(argv) {
  const args = {
    fromDir: null,
    runtimeVersion: null,
    platform: 'all',
    channel: null,
    skipVerify: false,
    rollout: null,
    whitelist: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--from-dir') {
      args.fromDir = path.resolve(argv[++i]);
    } else if (key === '--runtime-version') {
      args.runtimeVersion = argv[++i];
    } else if (key === '--channel') {
      args.channel = argv[++i];
    } else if (key === '--platform') {
      args.platform = argv[++i];
    } else if (key === '--skip-verify') {
      args.skipVerify = true;
    } else if (key === '--rollout') {
      args.rollout = argv[++i];
    } else if (key === '--whitelist') {
      args.whitelist = argv[++i];
    } else if (key === '--help' || key === '-h') {
      console.log(`用法: npm run ota:hotfix -- [选项]
  --from-dir <dir>        使用已有导出目录，跳过 expo export
  --runtime-version <rv>  指定 runtimeVersion
  --channel <name>        发布到指定通道（默认 production）
  --rollout <0-100>       放量比例，未命中分桶的设备继续用 previous
  --whitelist <uid,...>   白名单 uid
  --platform <p>          自检范围: all | ios | android（默认 all，仅影响自检）
  --skip-verify           跳过协议自检`);
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${key}`);
    }
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `命令失败: ${command} ${args.join(' ')}（退出码 ${result.status}）`,
    );
  }
}

async function ping() {
  try {
    const response = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// 自检需要服务在线；若未提供常驻服务，则临时启动一个并在结束时关闭。
async function ensureService() {
  if (await ping()) {
    console.log('[hotfix] OTA 服务已在运行，直接复用');
    return null;
  }
  console.log('[hotfix] 临时启动 OTA 服务…');
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await ping()) {
      console.log('[hotfix] OTA 服务已就绪');
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  child.kill();
  throw new Error('OTA 服务启动超时，请检查 3000 端口');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let temporaryServer = null;

  try {
    console.log('\n=== 1/4 导出 bundle ===');
    let distDir = args.fromDir;
    if (distDir) {
      console.log(`[hotfix] 跳过导出，使用 ${distDir}`);
    } else {
      // --clear 必须带：Metro 的 transform 缓存按文件内容命中，不感知 EXPO_PUBLIC_* 变化，
      // 不清缓存会把上一次导出（没注入 OTA URL）的产物原样复用。
      run('npx', ['expo', 'export', '--platform', 'all', '--output-dir', 'dist', '--clear'], {
        cwd: MOBILE_DIR,
        env: exportEnv(MOBILE_DIR),
      });
      distDir = path.join(MOBILE_DIR, 'dist');
    }

    console.log('\n=== 2/4 发布 ===');
    // 一定要把刚导出的目录传给 publish：它自己也会 export（不注入 env、不清缓存），
    // 会把刚生成的 bundle 覆盖成没有 EXPO_PUBLIC_* 的那一份。
    const publishArgs = [PUBLISH_SCRIPT, '--from-dir', distDir];
    if (args.runtimeVersion) {
      publishArgs.push('--runtime-version', args.runtimeVersion);
    }
    if (args.channel) publishArgs.push('--channel', args.channel);
    if (args.rollout) publishArgs.push('--rollout', args.rollout);
    if (args.whitelist) publishArgs.push('--whitelist', args.whitelist);
    run(process.execPath, publishArgs);

    console.log('\n=== 3/4 协议自检 ===');
    if (args.skipVerify) {
      console.log('[hotfix] 已跳过');
    } else {
      temporaryServer = await ensureService();
      const platforms =
        args.platform === 'all' ? ['ios', 'android'] : [args.platform];
      for (const platform of platforms) {
        console.log(`[hotfix] 自检 ${platform} …`);
        const verifyArgs = [VERIFY_SCRIPT, '--platform', platform];
        if (args.channel) verifyArgs.push('--channel', args.channel);
        run(process.execPath, verifyArgs);
      }
    }

    console.log('\n=== 4/4 完成 ===');
    console.log('客户端：冷启动一次下载，第二次冷启动生效，或点击「立即重启」。');
    console.log('查看历史版本：npm run ota:publish -- --list');
    console.log('回滚到指定版本：npm run ota:publish -- --release <id>');
    console.log('回退内置包（仅本地协议演练）：npm run ota:publish -- --rollback');
  } finally {
    if (temporaryServer) {
      temporaryServer.kill();
      console.log('[hotfix] 已关闭临时 OTA 服务');
    }
  }
}

main().catch((error) => {
  console.error(`[hotfix] 失败: ${error.message}`);
  process.exitCode = 1;
});
