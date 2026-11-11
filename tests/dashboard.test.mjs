import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = await fsp.readFile(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../services/ota/src/dashboard-client.js',
  ),
  'utf8',
);

const BOOT_STATE = {
  generatedAt: new Date().toISOString(),
  publicBaseUrl: 'http://localhost:3000',
  adminEnabled: false,
  runtimeVersion: '1',
  runtimeVersions: ['1'],
  platform: '',
  channels: [],
  releases: [],
  metrics: { byDay: [], byServed: {} },
  events: [],
  eventsTotal: 0,
  eventsQuery: {},
  stats: { releases: 0, channels: 0, assetsBytes: 0 },
};

/**
 * 用最小 DOM 桩执行控制台脚本，返回所有已注册的监听器。
 * missingSelectors 用来模拟旧版 HTML 骨架。
 */
function runDashboard(missingSelectors = [], options = {}) {
  const elements = new Map();
  const calls = [];
  const intervals = [];
  const fetchCalls = [];
  const replacedUrls = [];
  const savedTokens = [];
  const toastTexts = [];
  const bootState = { ...BOOT_STATE, ...(options.state || {}) };
  const NativeDate = Date;
  let clockOffset = 0;
  class MockDate extends NativeDate {
    static now() { return NativeDate.now() + clockOffset; }
  }

  const makeElement = (selector) => ({
    selector,
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    hidden: false,
    dataset: {},
    open: false,
    checked: true,
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector() { return null; },
    closest() { return null; },
    contains() { return false; },
    appendChild() {},
    remove() {},
    focus() {},
    addEventListener(type, handler) {
      calls.push({ selector, type, handler });
    },
  });

  const querySelector = (selector) => {
    if (missingSelectors.includes(selector)) return null;
    if (selector === '#dashboard-state') {
      return { textContent: JSON.stringify(bootState) };
    }
    if (!elements.has(selector)) elements.set(selector, makeElement(selector));
    return elements.get(selector);
  };

  const context = {
    document: {
      querySelector,
      querySelectorAll: () => [],
      addEventListener(type, handler) {
        calls.push({ selector: 'document', type, handler });
      },
      createElement() {
        const el = { className: '', _text: '', remove() {} };
        Object.defineProperty(el, 'textContent', {
          get() { return el._text; },
          set(value) { el._text = String(value); toastTexts.push(String(value)); },
        });
        return el;
      },
      hidden: false,
    },
    window: {
      addEventListener(type, handler) {
        calls.push({ selector: 'window', type, handler });
      },
    },
    location: { hash: options.hash || '#overview' },
    localStorage: {
      getItem: () => null,
      setItem(key, value) { savedTokens.push({ key, value }); },
    },
    history: {
      replaceState(_state, _title, url) { replacedUrls.push(url); },
    },
    navigator: {},
    console,
    URLSearchParams,
    Date: MockDate,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    fetch(url) {
      fetchCalls.push(url);
      if (url === '/api/admin/actions') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(options.actionResponse || { ok: true, output: '操作成功' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(bootState),
      });
    },
  };

  vm.runInNewContext(source, context, { filename: 'dashboard-client.js' });
  return {
    calls,
    elements,
    intervals,
    fetchCalls,
    replacedUrls,
    savedTokens,
    toastTexts,
    getElement: querySelector,
    setHash: (hash) => { context.location.hash = hash; },
    advance: (ms) => { clockOffset += ms; },
  };
}

test('初始化不依赖顶部平台下拉，移除后 Tab 与通道按钮仍可用', () => {
  const { calls } = runDashboard(['#globalPlatform']);
  const has = (selector, type) =>
    calls.some((call) => call.selector === selector && call.type === type);

  assert.ok(has('window', 'hashchange'), 'Tab 跳转监听应已注册');
  assert.ok(has('#channels', 'click'), '通道按钮事件委托应已注册');
  assert.ok(has('#channels', 'change'), '版本选择监听应已注册');
  assert.ok(has('#refresh', 'click'), '刷新按钮应已注册');
  assert.ok(has('#events', 'input'), '事件过滤应已注册');
  assert.ok(has('#updates', 'change'), '版本页筛选应已注册');
  assert.ok(has('#saveToken', 'click'), '令牌保存应已注册');
  assert.ok(!has('#globalPlatform', 'change'), '顶部不应再绑定平台筛选');
});

test('顶部不再绑定平台下拉，平台筛选入口收敛到事件页', () => {
  const { calls } = runDashboard();
  assert.ok(
    !calls.some((call) => call.selector === '#globalPlatform'),
    '顶部平台下拉已移除',
  );
  assert.ok(
    calls.some((call) => call.selector === '#events' && call.type === 'change'),
    '事件页平台筛选仍应绑定',
  );
});

test('指标页「按平台」只列 ios / android，未标记事件降级为脚注', () => {
  const { elements } = runDashboard([], {
    hash: '#metrics',
    state: {
      metrics: {
        byDay: [],
        byServed: {},
        byPlatform: {
          ios: { total: 10, manifests: 5, byServed: { current: 5 } },
          android: { total: 8, manifests: 4, byServed: { previous: 4 } },
          unknown: { total: 1, assets: 1, errors: 1 },
        },
      },
    },
  });
  const html = elements.get('#metrics').innerHTML;
  assert.ok(html.includes('<b>iOS</b>'), '应渲染 iOS 行');
  assert.ok(html.includes('<b>Android</b>'), '应渲染 Android 行');
  assert.ok(!html.includes('<b>unknown</b>'), '不应把 unknown 当成第三种平台');
  assert.ok(html.includes('1 条未标记平台事件'), '应提示未标记事件的数量');
  assert.ok(html.includes('未计入上表'), '应说明未计入平台对比');
});

test('差分数据同时进入概览卡、指标页与版本页', () => {
  const state = {
    metrics: {
      byDay: [],
      byServed: {},
      byPlatform: { ios: {}, android: {}, unknown: {} },
      patch: {
        requests: 10, hits: 7, fallbacks: 3, hitRate: 70,
        patchBytes: 700, fullBytes: 10000, savedBytes: 9300, savingRate: 93,
        reasons: { 'base-missing': 3 },
        byPlatform: {
          ios: { requests: 6, hits: 5, fallbacks: 1, hitRate: 83, savedBytes: 5000 },
          android: { requests: 4, hits: 2, fallbacks: 2, hitRate: 50, savedBytes: 4300 },
        },
        byChannel: { beta: { requests: 10, hits: 7, hitRate: 70, savedBytes: 9300 } },
      },
    },
    stats: { releases: 1, channels: 1, assetsBytes: 1024, patchCount: 4, patchBytes: 2048 },
    releases: [{
      releaseId: '1000', updateId: 'abc', createdAt: '2026-01-01T00:00:00.000Z',
      platforms: ['ios'], files: 1, size: 1024,
      currentChannels: ['beta'], previousChannels: [], sameAsCurrent: true,
      restoredFrom: null, patchCount: 2, patchBytes: 512,
    }],
  };
  const overview = runDashboard([], { hash: '#overview', state }).elements;
  const statsHtml = overview.get('#stats').innerHTML;
  assert.ok(statsHtml.includes('差分命中率'));
  assert.ok(statsHtml.includes('70%'));
  assert.ok(statsHtml.includes('节省流量'));

  const metrics = runDashboard([], { hash: '#metrics', state }).elements;
  const metricsHtml = metrics.get('#metrics').innerHTML;
  assert.ok(metricsHtml.includes('增量差分'));
  assert.ok(metricsHtml.includes('base-missing'));
  assert.ok(metricsHtml.includes('补丁库：4'));

  const updates = runDashboard([], { hash: '#updates', state }).elements;
  const updatesHtml = updates.get('#updates').innerHTML;
  assert.ok(updatesHtml.includes('<th>补丁</th>'));
  assert.ok(updatesHtml.includes('2 / '));
});

test('移除全局搜索后初始化不再依赖 #q', () => {
  const { calls } = runDashboard(['#q']);
  assert.ok(!calls.some((call) => call.selector === '#q'));
  assert.ok(calls.some((call) => call.selector === 'window' && call.type === 'hashchange'));
  assert.ok(calls.some((call) => call.selector === '#channels' && call.type === 'click'));
});

test('自动刷新每秒更新倒计时，到点发起请求', async () => {
  const { elements, intervals, fetchCalls, advance } = runDashboard();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 1000);
  assert.ok(elements.get('#updated').textContent.includes('自动刷新 15s'));

  intervals[0].fn(); // 未到点
  assert.equal(fetchCalls.length, 0);

  advance(16000);
  intervals[0].fn(); // 到点
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].startsWith('/api/admin/state?'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('关闭自动刷新会显示状态，页面重新可见时可补刷', () => {
  const { calls, elements } = runDashboard();
  const change = calls.find(
    (call) => call.selector === '#auto' && call.type === 'change',
  );
  assert.ok(change, '自动刷新开关应绑定 change');
  change.handler({ target: { checked: false } });
  assert.ok(elements.get('#updated').textContent.includes('自动刷新已关闭'));
  assert.ok(
    calls.some((call) => call.selector === 'document' && call.type === 'visibilitychange'),
    '应监听页面重新可见以补刷',
  );
});

test('事件页平台筛选只作用于事件流，不改指标口径', async () => {
  const { elements, calls, fetchCalls, getElement } = runDashboard([], {
    hash: '#events',
  });
  const html = elements.get('#events').innerHTML;
  assert.ok(html.includes('id="evPlatform"'), '事件页应有平台下拉');
  assert.ok(html.includes('value="unknown"'), '应包含未标记选项');

  getElement('#evPlatform').value = 'ios';
  const change = calls.find(
    (call) => call.selector === '#events' && call.type === 'change',
  );
  assert.ok(change, '事件页应绑定 change 事件委托');
  change.handler({ target: { id: 'evPlatform' } });

  assert.equal(fetchCalls.length, 1);
  const url = fetchCalls[0];
  assert.ok(url.includes('eventsPlatform=ios'), '应使用事件专用参数');
  assert.ok(
    !/(^|[?&])platform=ios/.test(url),
    '不应写回全局 platform 参数，否则会带走指标口径',
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test('通道页按功能分区，双平台灰度统一保存且观测直接可见', () => {
  const now = new Date().toISOString();
  const { elements } = runDashboard([], {
    hash: '#channels',
    state: {
      channels: [
        {
          channel: 'beta',
          releaseId: 'r2',
          updateId: 'u2',
          createdAt: now,
          previous: { releaseId: 'r1' },
          rollout: { percentage: 50, whitelist: ['u1', 'u2'], byPlatform: { ios: 20, android: 0 } },
          metrics: { total: 20, uniqueUids: 5, errors: 1, current: 12, previous: 8, whitelist: 0 },
          history: [
            { action: 'publish', at: now, releaseId: 'r2', operator: 'tester', via: 'dashboard' },
            { action: 'rollback', at: now, releaseId: 'r1' },
          ],
        },
      ],
      metrics: {
        byDay: [],
        byServed: {},
        byPlatform: {
          ios: {
            total: 12,
            byChannel: {
              beta: { total: 12, manifests: 6, uniqueUids: 3, errors: 0, current: 8, previous: 4, whitelist: 0 },
            },
          },
          android: {
            total: 8,
            byChannel: {
              beta: { total: 8, manifests: 4, uniqueUids: 2, errors: 1, current: 4, previous: 4, whitelist: 0 },
            },
          },
        },
      },
      releases: [],
    },
  });
  const html = elements.get('#channels').innerHTML;
  assert.ok(html.includes('data-platform="ios"'), '应有 iOS 独立区块');
  assert.ok(html.includes('data-platform="android"'), '应有 Android 独立区块');
  assert.ok(html.includes('id="pct-ios-beta" type="number" min="0" max="100" value="20"'), 'iOS 输入应显示独立值');
  assert.ok(html.includes('id="pct-android-beta" type="number" min="0" max="100" value="0"'), 'Android 输入应显示独立值');
  assert.equal((html.match(/data-act="save-platform"/g) || []).length, 1, '每个通道只保留一个双端保存按钮');
  assert.ok(html.includes('保存全部平台灰度'), '保存按钮应明确作用范围');
  assert.ok(html.includes('保存时会同时提交 iOS 与 Android 当前比例'), '应说明双端保存语义');
  assert.equal((html.match(/data-act="set-percentage"/g) || []).length, 10, '双平台应各有五个可见快捷档位');
  assert.ok(html.includes('12 请求 · 3 设备 · 0 错误'), 'iOS 观测应直接可读');
  assert.ok(html.includes('8 请求 · 2 设备 · 1 错误'), 'Android 观测应直接可读');
  assert.ok(html.includes('class="ch-versions"'), '当前与上一版本应集中展示');
  assert.ok(html.includes('data-copy="r2"'), '当前版本应支持复制完整 releaseId');
  assert.ok(html.includes('data-copy="r1"'), '上一版本应支持复制完整 releaseId');
  assert.ok(html.includes('data-act="save-whitelist"'), '白名单应独立保存');
  assert.ok(html.includes('2 个 uid'), '白名单数量应直接可见');
  assert.ok(html.includes('<h3>平台灰度</h3>'), '灰度应有独立分组');
  assert.ok(html.includes('<h3>白名单</h3>'), '白名单应有独立分组');
  assert.ok(html.includes('<h3>发布操作</h3>'), '发布操作应有独立分组');
  assert.ok(html.includes('回滚上一版本'), '回滚操作应直接可见');
  assert.ok(html.includes('重新发布当前版本'), '重新发布应直接可见');
  assert.ok(html.includes('提升所选版本'), '提升版本应直接可见');
  assert.ok(html.includes('<details class="ch-history">'), '历史应使用可展开列表');
  assert.ok(html.includes('<ul class="history">'), '展开后应展示完整历史列表');
  assert.ok(!html.includes('id="pct-presets"'), '不应再依赖不直观的 datalist');
  assert.ok(!html.includes('class="ch-history-inline"'), '完整历史不应只放在 tooltip');
});

test('四个通道按指定顺序渲染为 Tab，初始只显示 development', () => {
  const { elements } = runDashboard([], {
    hash: '#channels',
    state: {
      channels: ['production', 'beta', 'development', 'canary'].map((channel) => ({
        channel,
        rollout: { percentage: 100 },
      })),
    },
  });
  const html = elements.get('#channels').innerHTML;
  const tabOrder = [...html.matchAll(/data-channel-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabOrder, ['development', 'canary', 'beta', 'production']);
  assert.ok(html.includes('class="channel-tabs" role="tablist" aria-label="通道列表"'));
  assert.equal((html.match(/role="tab"/g) || []).length, 4, '应有四个通道 Tab');
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 4, '应有四个对应面板');
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, '只能有一个选中 Tab');
  assert.equal((html.match(/aria-selected="false"/g) || []).length, 3, '其余 Tab 应为未选中状态');
  assert.equal((html.match(/role="tabpanel"[^>]* hidden/g) || []).length, 3, '初始只显示首个通道');
  assert.ok(html.includes('id="channel-tab-0" data-channel-tab="development"'));
  assert.ok(html.includes('id="channel-panel-0" role="tabpanel" aria-labelledby="channel-tab-0">'));
});

test('灰度快捷档位只更新输入和预览，不直接发起保存', () => {
  const { calls, getElement, fetchCalls } = runDashboard([], {
    hash: '#channels',
    state: {
      adminEnabled: true,
      channels: [{ channel: 'beta', rollout: { percentage: 20, byPlatform: { ios: 20 } } }],
    },
  });
  const click = calls.find((call) => call.selector === '#channels' && call.type === 'click');
  const input = getElement('#pct-ios-beta');
  input.dataset.orig = '20';
  const card = { dataset: { channel: 'beta' } };
  const button = {
    dataset: { act: 'set-percentage', platform: 'ios', value: '50' },
    closest: () => card,
  };

  click.handler({ target: { closest: () => button } });

  assert.equal(input.value, '50');
  assert.equal(fetchCalls.length, 0, '快捷档位不应直接提交写请求');
});

test('无上一版本或未发布时禁用对应发布操作', () => {
  const { elements } = runDashboard([], {
    hash: '#channels',
    state: {
      adminEnabled: true,
      channels: [{ channel: 'beta', rollout: { percentage: 100 } }],
    },
  });
  const html = elements.get('#channels').innerHTML;
  assert.ok(html.includes('data-act="rollback" disabled title="暂无上一版本，无法回滚"'));
  assert.ok(html.includes('data-act="republish" disabled title="当前通道尚未发布"'));
});

test('事件页筛选参数只留在事件页 URL 与请求中，切换 Tab 后清除', async () => {
  const { calls, fetchCalls, replacedUrls, getElement, setHash } = runDashboard([], {
    hash: '#events',
  });

  getElement('#evPlatform').value = 'ios';
  getElement('#evType').value = 'manifest';
  const change = calls.find(
    (call) => call.selector === '#events' && call.type === 'change',
  );
  change.handler({ target: { id: 'evPlatform' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    fetchCalls[fetchCalls.length - 1].includes('eventsPlatform=ios'),
    '事件页请求应带事件筛选',
  );
  assert.ok(
    replacedUrls[replacedUrls.length - 1].includes('eventsPlatform=ios'),
    '事件页 URL 应带事件筛选',
  );

  const hashChange = calls.find(
    (call) => call.selector === 'window' && call.type === 'hashchange',
  ).handler;

  // 切到指标页：事件筛选不应出现在请求和 URL 中
  setHash('#metrics');
  hashChange();
  await new Promise((resolve) => setImmediate(resolve));

  const metricsFetch = fetchCalls[fetchCalls.length - 1];
  const metricsUrl = replacedUrls[replacedUrls.length - 1];
  assert.ok(!metricsFetch.includes('eventsPlatform'), '离开事件页后请求不应带平台筛选');
  assert.ok(!metricsFetch.includes('eventsType'), '离开事件页后请求不应带类型筛选');
  assert.ok(!metricsUrl.includes('eventsPlatform'), '离开事件页后 URL 不应带平台筛选');
  assert.ok(metricsUrl.includes('#metrics'), 'URL hash 应指向当前页');

  // 切回事件页：筛选状态恢复，URL 与请求重新带上
  setHash('#events');
  hashChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    fetchCalls[fetchCalls.length - 1].includes('eventsPlatform=ios'),
    '回到事件页应恢复筛选',
  );
  assert.ok(
    replacedUrls[replacedUrls.length - 1].includes('eventsPlatform=ios'),
    '回到事件页 URL 应恢复筛选',
  );
});

test('保存管理令牌会去掉首尾空格，避免被服务端判为无效', () => {
  const { calls, getElement, savedTokens } = runDashboard();
  getElement('#token').value = '  dev-token  ';
  const save = calls.find(
    (call) => call.selector === '#saveToken' && call.type === 'click',
  );
  assert.ok(save, '保存令牌按钮应已绑定');
  save.handler({ target: {} });
  assert.equal(savedTokens.length, 1);
  assert.equal(savedTokens[0].value, 'dev-token');
  assert.equal(getElement('#token').value, 'dev-token');
});

test('版本页支持按 releaseId / updateId 即时搜索并可清除', () => {
  const now = new Date().toISOString();
  const releases = [
    { releaseId: '1111', updateId: 'aaaa-1111', createdAt: now, platforms: ['ios'], currentChannels: [], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
    { releaseId: '2222', updateId: 'bbbb-2222', createdAt: now, platforms: ['android'], currentChannels: [], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
    { releaseId: '3333', updateId: 'aaaa-3333', createdAt: now, platforms: ['ios'], currentChannels: [], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
  ];
  const { calls, elements } = runDashboard([], { hash: '#updates', state: { releases } });
  const html = () => elements.get('#updates').innerHTML;
  const input = calls.find((call) => call.selector === '#updates' && call.type === 'input');
  assert.ok(input, '版本页应绑定搜索输入');
  assert.ok(html().includes('id="upQuery"'), '应渲染搜索框');
  assert.ok(
    elements.get('#updatesHint').textContent.includes('releaseId / updateId'),
    '提示文案应准确说明可搜索',
  );

  input.handler({ target: { id: 'upQuery', value: '2222' } });
  assert.ok(html().includes('data-copy="2222"'), 'releaseId 命中');
  assert.ok(!html().includes('data-copy="1111"'), '非命中 releaseId 应被过滤');
  assert.ok(html().includes('筛选后 1 / 3 条'));

  input.handler({ target: { id: 'upQuery', value: 'aaaa' } });
  assert.ok(html().includes('data-copy="1111"') && html().includes('data-copy="3333"'), 'updateId 命中');
  assert.ok(!html().includes('data-copy="2222"'), '非命中 updateId 应被过滤');

  const click = calls.find((call) => call.selector === '#updates' && call.type === 'click');
  click.handler({ target: { id: 'upClear' } });
  assert.ok(
    html().includes('data-copy="1111"') &&
      html().includes('data-copy="2222"') &&
      html().includes('data-copy="3333"'),
    '清除后应恢复全部版本',
  );
  assert.ok(!html().includes('筛选后'), '清除后不再显示筛选计数');
});

test('通道页展示设备实际运行版本并与指针区分', () => {
  const now = new Date().toISOString();
  const { elements } = runDashboard([], {
    hash: '#channels',
    state: {
      channels: [{
        channel: 'beta',
        releaseId: 'r2',
        updateId: 'u2',
        createdAt: now,
        previous: { releaseId: 'r1', updateId: 'u1' },
        rollout: { percentage: 100 },
        running: {
          devices: 3,
          versions: [
            { updateId: 'u2', releaseId: 'r2', platform: 'android', devices: 2, lastAt: now, kind: 'current' },
            { updateId: 'u1', releaseId: 'r1', platform: 'ios', devices: 1, lastAt: now, kind: 'previous' },
          ],
        },
        metrics: { total: 3, uniqueUids: 3, errors: 0, current: 3, previous: 0, whitelist: 0 },
      }],
    },
  });
  const html = elements.get('#channels').innerHTML;
  assert.ok(html.includes('<h3>实际运行版本</h3>'));
  assert.ok(html.includes('3 台设备'));
  assert.ok(html.includes('>u2<') && html.includes('>u1<'));
  assert.ok(html.includes('>current<') && html.includes('>previous<'));
  assert.ok(html.includes('来自客户端上报'));
});

test('概览通道表展示实际运行 top 版本', () => {
  const now = new Date().toISOString();
  const { elements } = runDashboard([], {
    hash: '#overview',
    state: {
      channels: [{
        channel: 'beta',
        releaseId: 'r2',
        updateId: 'u2',
        rollout: { percentage: 100 },
        metrics: { total: 4, errors: 0 },
        running: {
          devices: 2,
          versions: [{
            updateId: 'abcdefgh-9999',
            releaseId: 'r2',
            platform: 'android',
            devices: 2,
            lastAt: now,
            kind: 'current',
          }],
        },
      }],
    },
  });
  const html = elements.get('#overviewChannels').innerHTML;
  assert.ok(html.includes('<th>实际运行</th>'));
  assert.ok(html.includes('abcdefgh'), '展示 top 版本短 id');
  assert.ok(html.includes('2 台'));
  assert.ok(html.includes('>current<'));
});

test('版本页展示各通道实际运行版本并支持通道/状态筛选', () => {
  const now = new Date().toISOString();
  const state = {
    channels: [
      {
        channel: 'canary',
        running: {
          devices: 3,
          versions: [
            { updateId: 'u-new', releaseId: 'r2', platform: 'android', devices: 2, lastAt: now, kind: 'current' },
            { updateId: 'u-old', releaseId: 'r1', platform: 'ios', devices: 1, lastAt: now, kind: 'other' },
          ],
        },
      },
      {
        channel: 'production',
        running: {
          devices: 1,
          versions: [
            { updateId: 'u-old', releaseId: 'r1', platform: 'android', devices: 1, lastAt: now, kind: 'other' },
          ],
        },
      },
    ],
    releases: [
      { releaseId: 'r2', updateId: 'u-new', createdAt: now, platforms: ['android'], currentChannels: ['canary'], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
      { releaseId: 'r1', updateId: 'u-old', createdAt: now, platforms: ['ios'], currentChannels: [], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
    ],
  };
  const { calls, elements } = runDashboard([], { hash: '#updates', state });
  const html = () => elements.get('#updates').innerHTML;
  assert.ok(html().includes('<th>实际运行</th>'));
  assert.ok(html().includes('<b>canary</b> 2 台'), 'r2 在 canary 实际运行 2 台');
  assert.ok(html().includes('<b>production</b> 1 台'), 'r1 在 production 实际运行 1 台');
  assert.ok(html().includes('<b>canary</b> 1 台'), 'r1 在 canary 实际运行 1 台');

  const change = calls.find((call) => call.selector === '#updates' && call.type === 'change');
  change.handler({ target: { id: 'upChannel', value: 'production' } });
  assert.ok(html().includes('data-copy="r1"'));
  assert.ok(!html().includes('data-copy="r2"'), '按运行通道过滤');

  change.handler({ target: { id: 'upChannel', value: '' } });
  change.handler({ target: { id: 'upRun', value: 'current' } });
  assert.ok(html().includes('data-copy="r2"'));
  assert.ok(!html().includes('data-copy="r1"'), '按运行状态过滤');

  const input = calls.find((call) => call.selector === '#updates' && call.type === 'input');
  change.handler({ target: { id: 'upRun', value: '' } });
  input.handler({ target: { id: 'upQuery', value: 'production' } });
  assert.ok(html().includes('data-copy="r1"'), '关键词可匹配运行通道名');
  assert.ok(!html().includes('data-copy="r2"'));
});

test('版本搜索与平台筛选可组合', () => {
  const now = new Date().toISOString();
  const releases = [
    { releaseId: 'r-ios', updateId: 'u-ios', createdAt: now, platforms: ['ios'], currentChannels: [], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
    { releaseId: 'r-and', updateId: 'u-and', createdAt: now, platforms: ['android'], currentChannels: [], previousChannels: [], size: 1, patchCount: 0, patchBytes: 0 },
  ];
  const { calls, elements } = runDashboard([], { hash: '#updates', state: { releases } });
  const html = () => elements.get('#updates').innerHTML;
  const change = calls.find((call) => call.selector === '#updates' && call.type === 'change');
  const input = calls.find((call) => call.selector === '#updates' && call.type === 'input');

  change.handler({ target: { id: 'platform', value: 'ios' } });
  assert.ok(html().includes('data-copy="r-ios"'));
  assert.ok(!html().includes('data-copy="r-and"'), '平台筛选应生效');

  input.handler({ target: { id: 'upQuery', value: 'r-and' } });
  assert.ok(!html().includes('data-copy="r-ios"'), '平台与关键字应同时生效');
  assert.ok(!html().includes('data-copy="r-and"'), 'android 版本不应出现在 ios 筛选下');
  assert.ok(html().includes('筛选后 0 / 2 条'));
});

test('设置页可直达，展示止损策略并能提交止损设置', async () => {
  const { calls, elements, getElement, fetchCalls } = runDashboard([], {
    hash: '#settings',
    state: {
      adminEnabled: true,
      runtimeVersion: '1',
      stopLoss: {
        enabled: true,
        mode: 'monitor',
        minSamples: 20,
        webhookConfigured: true,
        webhookOrigin: 'https://hook.example',
        overridden: { minSamples: false, webhook: false },
      },
    },
  });

  const save = calls.find(
    (call) => call.selector === '#saveStopLoss' && call.type === 'click',
  );
  assert.ok(save, '设置页应绑定止损保存');
  assert.ok(
    elements.get('#slSource').textContent.includes('仅监控'),
    '应展示当前策略',
  );
  assert.ok(
    elements.get('#stopLossHint').textContent.includes('MIN_SAMPLES=20'),
    '应展示当前最小样本数',
  );

  getElement('#token').value = 'dev-token';
  getElement('#slMinSamples').value = '5';
  getElement('#slWebhook').value = 'https://hook.example/new';
  getElement('#slWebhookClear').checked = false;

  await save.handler({ target: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(fetchCalls.includes('/api/admin/actions'), '应发起写请求');
});

test('立即评估会把服务端 output 显示在提示里', async () => {
  const output =
    '通道 beta 止损评估：healthy（insufficient-samples） · 自动动作：仅监控（只告警）';
  const { calls, getElement, toastTexts } = runDashboard([], {
    hash: '#channels',
    state: {
      adminEnabled: true,
      runtimeVersion: '1',
      channels: [
        {
          channel: 'beta',
          releaseId: 'r2',
          updateId: 'u2',
          rollout: { percentage: 100 },
          health: {
            enabled: true,
            mode: 'monitor',
            verdict: 'healthy',
            reason: 'insufficient-samples',
            samples: 0,
            cohortSize: 0,
          },
        },
      ],
    },
    actionResponse: { ok: true, output },
  });

  getElement('#token').value = 'dev-token';
  const click = calls.find((call) => call.selector === '#channels' && call.type === 'click');
  const card = { dataset: { channel: 'beta' } };
  const button = { dataset: { act: 'evaluate-stop-loss' }, closest: () => card };

  await click.handler({ target: { closest: () => button } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    toastTexts.some((text) => text.includes('止损评估') && text.includes('仅监控')),
    '应展示服务端返回的评估结果',
  );
});
