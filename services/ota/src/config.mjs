import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(srcDir, '..');
export const PORT = Number(process.env.PORT || 3000);

/**
 * 运行环境：development（本机/内网调试）| production（对外提供服务）。
 * production 会启用启动自检，缺配置直接拒绝启动，避免把 localhost 打进线上 manifest。
 */
export const OTA_ENV = String(process.env.OTA_ENV || 'development').toLowerCase();
export const IS_PRODUCTION = OTA_ENV === 'production';

/**
 * 数据目录：默认 services/ota/updates。
 * 上云后通常挂载独立卷，或用 OTA_DATA_DIR 指向容器外目录；
 * 相对路径按 ROOT 解析，绝对路径原样使用。
 */
export const UPDATES_DIR = path.resolve(ROOT, process.env.OTA_DATA_DIR || 'updates');

// manifest 中的 asset URL 前缀。真机/生产必须设置为 HTTPS 域名；
// Android 模拟器访问宿主机时通常设为 http://10.0.2.2:3000。
export const PUBLIC_BASE_URL =
  process.env.OTA_PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 看板写操作令牌：未配置时 /api/admin/actions 一律返回 403，页面按钮禁用。
export const ADMIN_TOKEN = process.env.OTA_ADMIN_TOKEN || '';

/**
 * 多令牌（可选）：OTA_ADMIN_TOKENS="alice:tok1,bob:tok2"
 * 冒号前是操作人标签，用于审计；未配置时退回单令牌（标签 admin）。
 */
function parseAdminTokens(raw) {
  const map = new Map();
  for (const item of String(raw || '').split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const index = trimmed.lastIndexOf(':');
    const label = index > 0 ? trimmed.slice(0, index).trim() : 'admin';
    const token = index > 0 ? trimmed.slice(index + 1).trim() : trimmed;
    if (token) map.set(token, label || 'admin');
  }
  if (ADMIN_TOKEN && !map.has(ADMIN_TOKEN)) map.set(ADMIN_TOKEN, 'admin');
  return map;
}

export const ADMIN_TOKENS = parseAdminTokens(process.env.OTA_ADMIN_TOKENS);
export const ADMIN_ENABLED = ADMIN_TOKENS.size > 0;

// CLI / CI 发布时的操作人标签：npm run ota:publish -- 生成审计用。
export const CLI_OPERATOR = process.env.OTA_OPERATOR || 'cli';

// P3 代码签名：配置私钥后客户端可开启 expo-expect-signature 校验。
export const PRIVATE_KEY_PATH = process.env.OTA_PRIVATE_KEY_PATH || '';
export const KEY_ID = process.env.OTA_KEY_ID || 'main';
export const SIGNING_ALG = 'rsa-v1_5-sha256';

/** 本机 / 内网 / 模拟器回环地址：对真机不可达，production 一律拒绝。 */
const LOCAL_HOST_PATTERN =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|10\.0\.2\.2|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/i;

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 客户端构建期已有 profile 防呆，这里补齐服务端侧，两侧对称。 */
export function assertServiceConfig() {
  const problems = [];

  if (IS_PRODUCTION) {
    let parsed = null;
    try {
      parsed = new URL(PUBLIC_BASE_URL);
    } catch {
      problems.push(`OTA_PUBLIC_BASE_URL 不是合法 URL：${PUBLIC_BASE_URL}`);
    }
    if (parsed) {
      if (parsed.protocol !== 'https:') {
        problems.push(`production 的 OTA_PUBLIC_BASE_URL 必须是 HTTPS，当前为 ${parsed.protocol}`);
      }
      if (LOCAL_HOST_PATTERN.test(parsed.hostname)) {
        problems.push(
          `production 的 OTA_PUBLIC_BASE_URL 不能是 localhost/内网地址，当前为 ${parsed.hostname}`,
        );
      }
    }

    if (!PRIVATE_KEY_PATH) {
      problems.push('production 必须配置 OTA_PRIVATE_KEY_PATH（客户端已强制验签）');
    } else if (!fs.existsSync(path.resolve(PRIVATE_KEY_PATH))) {
      problems.push(`签名私钥不存在：${path.resolve(PRIVATE_KEY_PATH)}`);
    }

    if (!ADMIN_ENABLED) {
      problems.push('production 必须配置 OTA_ADMIN_TOKEN 或 OTA_ADMIN_TOKENS（否则无法发布/回滚）');
    }
  }

  if (problems.length > 0) {
    throw new Error(
      ['启动配置校验失败：', ...problems.map((item) => `  - ${item}`)].join('\n'),
    );
  }

  if (!IS_PRODUCTION) {
    const host = hostnameOf(PUBLIC_BASE_URL);
    if (LOCAL_HOST_PATTERN.test(host)) {
      console.warn(
        `[ota] 提示：OTA_PUBLIC_BASE_URL=${PUBLIC_BASE_URL} 指向本机/内网，` +
          '仅模拟器可用；真机需改用局域网 IP，上线需 HTTPS 域名（并设置 OTA_ENV=production 做自检）',
      );
    }
  }
}
