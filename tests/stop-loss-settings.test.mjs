import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-stop-loss-settings-'));
process.env.OTA_DATA_DIR = TMP;
process.env.OTA_STOP_LOSS_ENABLED = 'true';
process.env.OTA_STOP_LOSS_MIN_SAMPLES = '20';
process.env.OTA_STOP_LOSS_WEBHOOK = 'https://env.example/hook';

const {
  clearStopLossOverrideCache,
  readStopLossOverride,
  stopLossConfig,
  stopLossOverrideFile,
  webhookOrigin,
  writeStopLossOverride,
} = await import('../services/ota/src/config.mjs');
const { buildDashboardState } = await import('../services/ota/src/dashboard.mjs');
const { performAdminAction } = await import('../services/ota/src/admin.mjs');
const { readAudit } = await import('../services/ota/src/release-store.mjs');
const { webhookRequestBody } = await import('../services/ota/src/stop-loss.mjs');

test('覆盖文件位于数据目录 system/ 下', () => {
  assert.ok(stopLossOverrideFile().endsWith(path.join('system', 'stop-loss.json')));
});

test('未写入覆盖时使用环境变量', () => {
  clearStopLossOverrideCache();
  assert.equal(readStopLossOverride(), null);
  const cfg = stopLossConfig();
  assert.equal(cfg.minSamples, 20);
  assert.equal(cfg.webhook, 'https://env.example/hook');
  assert.deepEqual(cfg.overridden, { minSamples: false, webhook: false });
});

test('控制台覆盖 MIN_SAMPLES 后优先于环境变量', async () => {
  await writeStopLossOverride({ minSamples: 5 }, { operator: 'tester' });
  const cfg = stopLossConfig();
  assert.equal(cfg.minSamples, 5);
  assert.equal(cfg.overridden.minSamples, true);
  assert.equal(cfg.webhook, 'https://env.example/hook', '未覆盖的 Webhook 仍用环境变量');
  assert.equal(cfg.overridden.webhook, false);
});

test('Webhook 可覆盖也可显式清除', async () => {
  await writeStopLossOverride({ webhook: 'https://runtime.example/robot?token=secret' });
  let cfg = stopLossConfig();
  assert.equal(cfg.webhook, 'https://runtime.example/robot?token=secret');
  assert.equal(cfg.overridden.webhook, true);

  await writeStopLossOverride({ webhook: '' });
  cfg = stopLossConfig();
  assert.equal(cfg.webhook, '', '空串表示显式清除，不再回落到环境变量');
  assert.equal(cfg.overridden.webhook, true);
});

test('非法设置被拒绝', async () => {
  await assert.rejects(() => writeStopLossOverride({ minSamples: 0 }), /MIN_SAMPLES/);
  await assert.rejects(() => writeStopLossOverride({ minSamples: 1.5 }), /MIN_SAMPLES/);
  await assert.rejects(() => writeStopLossOverride({ minSamples: 100001 }), /MIN_SAMPLES/);
  await assert.rejects(
    () => writeStopLossOverride({ webhook: 'ftp://example.com/x' }),
    /只支持 http\(s\)|http/,
  );
  await assert.rejects(() => writeStopLossOverride({ webhook: 'not-a-url' }), /http/);
});

test('webhookOrigin 只保留 origin', () => {
  assert.equal(
    webhookOrigin('https://runtime.example/robot/send?access_token=secret'),
    'https://runtime.example',
  );
  assert.equal(webhookOrigin(''), '');
  assert.equal(webhookOrigin('not-a-url'), '');
});

test('Webhook 消息体按平台自动适配', () => {
  const text = '[OTA 止损] production alert';
  const payload = { channel: 'production' };
  assert.deepEqual(
    webhookRequestBody(text, payload, 'https://oapi.dingtalk.com/robot/send?access_token=x'),
    { msgtype: 'text', text: { content: text } },
  );
  assert.deepEqual(
    webhookRequestBody(text, payload, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'),
    { msgtype: 'text', text: { content: text } },
  );
  assert.deepEqual(
    webhookRequestBody(text, payload, 'https://open.feishu.cn/open-apis/bot/v2/hook/x'),
    { msg_type: 'text', content: { text } },
  );
  assert.deepEqual(
    webhookRequestBody(text, payload, 'https://hooks.slack.com/services/x'),
    { text, payload },
  );
  assert.deepEqual(webhookRequestBody(text, payload, 'not-a-url'), { text, payload });
});

test('看板 state 不泄露 Webhook 明文', async () => {
  await writeStopLossOverride({
    webhook: 'https://runtime.example/robot/send?access_token=supersecret',
  });
  const state = await buildDashboardState('', {});
  assert.equal(state.stopLoss.webhookConfigured, true);
  assert.equal(state.stopLoss.webhookOrigin, 'https://runtime.example');
  const raw = JSON.stringify(state);
  assert.ok(!raw.includes('supersecret'), '不得包含 token');
  assert.ok(!raw.includes('access_token'), '不得包含查询串');
});

test('admin set-stop-loss-config 持久化并写审计', async () => {
  const result = await performAdminAction(
    { action: 'set-stop-loss-config', runtimeVersion: '1', minSamples: 7 },
    { operator: 'tester', via: 'dashboard', requestId: 'req-sl-1' },
  );
  assert.ok(result.message.includes('MIN_SAMPLES=7'));
  assert.equal(stopLossConfig().minSamples, 7);

  const audit = await readAudit('1', { limit: 10 });
  assert.ok(
    audit.some((entry) => entry.action === 'set-stop-loss-config'),
    '应写一条 set-stop-loss-config 审计',
  );
});
