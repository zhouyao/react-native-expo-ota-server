import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..');
const KEY_DIR = path.join(ROOT, 'services', 'ota', 'keys');
const CERT_DIR = path.join(ROOT, 'apps', 'mobile', 'certs');
const KEY_PATH = path.join(KEY_DIR, 'private-key.pem');
const CERT_PATH = path.join(CERT_DIR, 'certificate.pem');
const SUBJECT = '/CN=HotUpdate Demo Code Signing/O=HotUpdate Demo';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} 失败（退出码 ${result.status}）：${(result.stderr || '').trim()}`,
    );
  }
  return result;
}

async function main() {
  const force = process.argv.includes('--force');

  if (!force && fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    console.log('[keygen] 密钥与证书已存在，跳过（--force 可重新生成）');
    console.log(`  私钥: ${path.relative(ROOT, KEY_PATH)}`);
    console.log(`  证书: ${path.relative(ROOT, CERT_PATH)}`);
    return;
  }

  run('openssl', ['version']);
  await fsp.mkdir(KEY_DIR, { recursive: true });
  await fsp.mkdir(CERT_DIR, { recursive: true });

  console.log('[keygen] 生成 RSA 私钥（2048）…');
  run('openssl', ['genrsa', '-out', KEY_PATH, '2048']);
  await fsp.chmod(KEY_PATH, 0o600);

  console.log('[keygen] 生成自签 X.509 证书（10 年，含 Code Signing EKU）…');
  // expo-updates 要求证书带 extendedKeyUsage=codeSigning，否则拒绝更新。
  const configPath = path.join(KEY_DIR, 'openssl.cnf');
  await fsp.writeFile(
    configPath,
    `[req]
distinguished_name = dn
prompt = no
x509_extensions = v3

[dn]
CN = HotUpdate Demo Code Signing
O = HotUpdate Demo

[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = codeSigning
`,
  );
  run('openssl', [
    'req',
    '-new',
    '-x509',
    '-key',
    KEY_PATH,
    '-out',
    CERT_PATH,
    '-days',
    '3650',
    '-config',
    configPath,
  ]);

  const pem = await fsp.readFile(CERT_PATH, 'utf8');
  const cert = new crypto.X509Certificate(pem);
  console.log('\n[keygen] 完成');
  console.log(`  私钥（服务端）: ${path.relative(ROOT, KEY_PATH)}`);
  console.log(`  证书（客户端）: ${path.relative(ROOT, CERT_PATH)}`);
  console.log(`  证书 SHA-256:  ${cert.fingerprint256}`);
  console.log('\n下一步：');
  console.log('  1) 服务端启动时设置 OTA_PRIVATE_KEY_PATH=' + path.relative(ROOT, KEY_PATH));
  console.log('  2) apps/mobile/app.config.js 的 updates.codeSigningCertificate 指向 certs/certificate.pem');
  console.log('  3) 重新 prebuild + 打 release 包，客户端才会强制验签');
}

main().catch((error) => {
  console.error(`[keygen] 失败: ${error.message}`);
  process.exitCode = 1;
});
