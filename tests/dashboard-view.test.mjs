import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { renderDashboardHtml } from '../services/ota/src/dashboard-view.mjs';

const TEMPLATE_URL = new URL('../services/ota/src/dashboard.html', import.meta.url);

test('看板骨架从独立文件渲染，注入首屏 state 且不含全局搜索框 / 顶部平台下拉', async () => {
  const template = await fsp.readFile(TEMPLATE_URL, 'utf8');
  const html = renderDashboardHtml({ platform: 'ios', runtimeVersion: '1' });

  assert.ok(template.includes('__OTA_DASHBOARD_BOOT__'), '模板文件应保留注入占位符');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(!html.includes('id="globalPlatform"'), '顶部平台下拉应已移除');
  assert.ok(html.includes('自动刷新（15s）'));
  assert.ok(!html.includes('id="q"'), '全局搜索框应已移除');
  assert.ok(!html.includes('__OTA_DASHBOARD_BOOT__'), '占位符应被替换');
  assert.ok(html.includes('"platform":"ios"'), '首屏 state 应含平台筛选回显');
});

test('渲染结果完全以模板文件为准（不在 JS 里保留内联副本）', async () => {
  const template = await fsp.readFile(TEMPLATE_URL, 'utf8');
  const state = { marker: 'abc', runtimeVersion: '1' };
  const html = renderDashboardHtml(state);
  assert.equal(
    html,
    template.replace('__OTA_DASHBOARD_BOOT__', JSON.stringify(state)),
  );
});

test('首屏 JSON 转义 < 且不会被 $ 替换模式改写', () => {
  const html = renderDashboardHtml({
    note: '</script><script>x</script>',
    uid: 'u-$&-1',
  });
  assert.ok(!html.includes('</script><script>x'), '不能截断 script 标签');
  const start = html.indexOf('id="dashboard-state"');
  const bootJson = html.slice(start, html.indexOf('</script>', start));
  assert.ok(!bootJson.includes('<'), '首屏 JSON 中的 < 必须转义，避免截断 script');
  assert.ok(html.includes('u-$&-1'), '$& 必须原样保留');
});

test('模板文件改动后，下一次渲染无需重启即可生效', async () => {
  const original = await fsp.readFile(TEMPLATE_URL, 'utf8');
  const marker = '<!-- hot-reload-probe -->';
  try {
    await fsp.writeFile(TEMPLATE_URL, marker + original);
    const html = renderDashboardHtml({ ok: true });
    assert.ok(html.startsWith(marker), '应读到最新模板内容而不是进程内缓存');
  } finally {
    await fsp.writeFile(TEMPLATE_URL, original);
  }
});
