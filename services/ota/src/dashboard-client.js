/* OTA 更新控制台前端：Tab 分组、局部刷新、搜索、分页、写操作防重复。
 * 数据全部来自 /api/admin/state，渲染只消费已有字段，不新增统计口径。 */
(function () {
  'use strict';

  var TABS = ['overview', 'channels', 'updates', 'metrics', 'events'];

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    if (v === null || v === undefined || v === '') return '-';
    return String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  // 表单控件用：空值保持空，不要变成占位符 '-'
  function escAttr(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function fmtTime(v) {
    if (!v) return '-';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString();
  }
  function fmtShort(v) {
    return v ? String(v).slice(0, 8) : '-';
  }
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1024).toFixed(1) + ' KB';
  }
  function pct(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
  }
  function $(sel) { return document.querySelector(sel); }
  function clamp(v, min, max) {
    var n = Number(v);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }
  /** 通道 / 概览里展示平台灰度覆盖；未配置时不占空间。 */
  function platformRolloutTag(rollout) {
    var bp = rollout && rollout.byPlatform;
    if (!bp) return '';
    var parts = PLATFORMS.map(function (p) {
      return bp[p] === undefined || bp[p] === null ? null : (PLATFORM_LABEL[p] || p) + ' ' + bp[p] + '%';
    }).filter(Boolean);
    return parts.length ? '<div class="meta">平台：' + esc(parts.join(' / ')) + '</div>' : '';
  }

  /** 工具条显示更新时间与自动刷新倒计时，让开关是否生效一眼可见。 */
  function updateRefreshLabel() {
    var el = $('#updated');
    if (!el) return;
    var base = '更新于 ' + new Date(state.generatedAt).toLocaleTimeString();
    if (!view.auto) {
      el.textContent = base + ' · 自动刷新已关闭';
      return;
    }
    var left = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    el.textContent = base + ' · 自动刷新 ' + left + 's';
  }

  var state = JSON.parse($('#dashboard-state').textContent || '{}');
  // 首屏 URL 可能带 events 过滤参数，回显到控件，避免下一次刷新把条件覆盖掉。
  var bootQuery = state.eventsQuery || {};
  var view = {
    rv: state.runtimeVersion || '',
    platform: state.platform || '',
    auto: true,
    channel: '',
    updates: { platform: '', page: 1, size: 10 },
    events: {
      // 事件页专属平台过滤，不写回 view.platform，避免影响指标/概览/通道卡。
      platform: bootQuery.platform || '',
      type: bootQuery.type || '',
      channel: bootQuery.channel || '',
      status: bootQuery.status || '',
      uid: bootQuery.uid || '',
      offset: bootQuery.offset || 0,
      limit: bootQuery.limit || 30,
    },
  };
  // 平台灰度与观测的驱动列表：以后新增平台（如 web）在这里加一项，
  // 同时需同步服务端 rollout / metrics / manifest 的平台常量。
  var PLATFORMS = ['ios', 'android'];
  var PLATFORM_LABEL = { ios: 'iOS', android: 'Android' };
  var CHANNEL_ORDER = ['development', 'canary', 'beta', 'production'];
  var AUTO_REFRESH_MS = 15000;
  var tickTimer = null;
  var nextRefreshAt = 0;
  var refreshing = false;
  var pendingRefresh = false;
  var booted = false;

  // ---------- 提示 ----------
  function toast(text, kind) {
    var box = $('#toast');
    var el = document.createElement('div');
    el.className = kind || '';
    el.textContent = text;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 3600);
  }

  function token() {
    var input = $('#token');
    var value = (input && input.value) || localStorage.getItem('ota_admin_token') || '';
    // 输入 / 粘贴时常带首尾空格，服务端按原值比对，这里统一去掉。
    return String(value).trim();
  }

  /** 幂等键：服务端 60 秒内收到相同 requestId 时直接返回上次结果。 */
  function newRequestId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- 渲染：概览 ----------
  function renderStats() {
    var m = state.metrics || {};
    var cards = [
      ['通道', esc(state.stats.channels), '当前 runtimeVersion 下的通道数'],
      ['历史发布', esc(state.stats.releases), '每次发布/提升/回滚/重发都新增一条不可变产物'],
      ['7 天 manifest 请求', esc(m.manifests), '指标窗口固定 7 天' + (view.platform ? '，已按平台 ' + view.platform + ' 筛选' : '')],
      ['错误率', pct(m.errors, m.total) + '%', '口径：7 天内全部事件（manifest / asset / 客户端上报）中 status>=400 的占比，' + esc(m.errors) + '/' + esc(m.total)],
    ];
    $('#stats').innerHTML = cards.map(function (c) {
      return '<div class="stat" title="' + esc(c[2]) + '"><b>' + c[1] + '</b><span>' + esc(c[0]) + '</span></div>';
    }).join('');
  }

  function dayBarsHtml(byDay) {
    var maxDay = Math.max.apply(null, [1].concat(byDay.map(function (d) { return d.total; })));
    return byDay.map(function (d) {
      return '<div class="day" title="' + esc(d.date) + ' 共 ' + esc(d.total) + ' 次">'
        + '<div class="daybar">'
        + '<i class="cur" style="height:' + Math.round((d.current / maxDay) * 100) + '%"></i>'
        + '<i class="prev" style="height:' + Math.round((d.previous / maxDay) * 100) + '%"></i>'
        + '</div><span>' + esc(d.date.slice(5)) + '</span></div>';
    }).join('');
  }

  function renderTrend() {
    var m = state.metrics || {};
    var served = m.byServed || {};
    var byDay = m.byDay || [];
    $('#trend').innerHTML = ''
      + '<div class="meta">命中：current ' + esc(served.current || 0) + ' · previous ' + esc(served.previous || 0)
      + ' · whitelist ' + esc(served.whitelist || 0) + ' · 设备 ' + esc(m.uniqueUids || 0) + '</div>'
      + '<div class="legend"><span class="mono">■</span> current &nbsp; <span style="color:#93c5fd">■</span> previous</div>'
      + (byDay.length ? '<div class="days">' + dayBarsHtml(byDay) + '</div>' : '<div class="empty">暂无请求</div>');
  }

  function renderOverviewChannels() {
    var rows = (state.channels || []).map(function (c) {
      var cm = c.metrics || {};
      var badge = c.rollback ? '<span class="tag red">回滚指令</span>'
        : c.inheritedFrom ? '<span class="tag amber">继承</span>'
          : '';
      return '<tr><td><b>' + esc(c.channel) + '</b> ' + badge + '</td>'
        + '<td class="mono" title="' + escAttr(c.releaseId) + '">' + esc(fmtShort(c.releaseId)) + '</td>'
        + '<td>' + clamp(c.rollout && c.rollout.percentage, 0, 100) + '%' + platformRolloutTag(c.rollout) + '</td>'
        + '<td>' + esc(cm.total || 0) + '</td>'
        + '<td>' + esc(cm.errors || 0) + '</td></tr>';
    }).join('');
    $('#overviewChannels').innerHTML = '<table><thead><tr><th>通道</th><th>current</th><th>灰度</th><th>7天</th><th>错误</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="5" class="empty">暂无通道</td></tr>') + '</tbody></table>';
  }

  function renderOverviewEvents() {
    var rows = (state.events || []).slice(0, 5).map(function (e) {
      var cls = e.status >= 200 && e.status < 300 ? 'green' : e.status >= 400 ? 'red' : 'amber';
      return '<tr><td>' + esc(fmtTime(e.at)) + '</td><td>' + esc(e.type) + '</td><td>' + esc(e.platform || 'unknown')
        + '</td><td>' + esc(e.channel) + '</td><td class="mono">' + esc(e.uid || '-')
        + '</td><td><span class="tag ' + cls + '">' + esc(e.status) + '</span></td></tr>';
    }).join('');
    $('#overviewEvents').innerHTML = '<table><thead><tr><th>时间</th><th>类型</th><th>平台</th><th>通道</th><th>uid</th><th>状态</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="6" class="empty">暂无事件</td></tr>') + '</tbody></table>';
  }

  // ---------- 渲染：Channels ----------
  function channelsDirty() {
    var inputs = document.querySelectorAll('#channels input[data-orig]');
    for (var i = 0; i < inputs.length; i += 1) {
      if (inputs[i].value !== inputs[i].dataset.orig) return true;
    }
    var focused = document.activeElement;
    return Boolean(focused && focused.closest && focused.closest('#channels'));
  }

  function renderChannels() {
    var wrap = $('#channels');
    if (booted && channelsDirty()) return; // 有未保存输入时不覆盖
    var disabled = state.adminEnabled ? '' : ' disabled';
    var list = (state.channels || []).slice().sort(function (a, b) {
      var aIndex = CHANNEL_ORDER.indexOf(a.channel);
      var bIndex = CHANNEL_ORDER.indexOf(b.channel);
      return (aIndex < 0 ? CHANNEL_ORDER.length : aIndex) - (bIndex < 0 ? CHANNEL_ORDER.length : bIndex);
    });
    var releaseOptions = (state.releases || []).slice(0, 50).map(function (r) {
      return '<option value="' + escAttr(r.releaseId) + '">' + esc(r.releaseId) + ' · '
        + esc(fmtShort(r.updateId)) + ' · ' + esc(fmtTime(r.createdAt)) + '</option>';
    }).join('');

    if (!list.length) {
      view.channel = '';
      wrap.innerHTML = '<div class="empty">暂无通道</div>';
      $('#channelsHint').textContent = '';
      return;
    }

    var activeChannel = list.some(function (c) { return c.channel === view.channel; })
      ? view.channel
      : list[0].channel;
    view.channel = activeChannel;
    var tabs = list.map(function (c, index) {
      var active = c.channel === activeChannel;
      return '<button type="button" class="channel-tab' + (active ? ' active' : '') + '" role="tab"'
        + ' id="channel-tab-' + index + '" data-channel-tab="' + escAttr(c.channel) + '"'
        + ' aria-controls="channel-panel-' + index + '" aria-selected="' + active + '" tabindex="' + (active ? '0' : '-1') + '">'
        + esc(c.channel) + '</button>';
    }).join('');

    wrap.innerHTML = '<div class="channel-tabs" role="tablist" aria-label="通道列表">' + tabs + '</div>'
      + list.map(function (c, index) {
      var ch = escAttr(c.channel);
      var percentage = clamp(c.rollout && c.rollout.percentage, 0, 100);
      var whitelist = ((c.rollout && c.rollout.whitelist) || []).join(',');
      var whitelistCount = whitelist ? whitelist.split(',').length : 0;
      var bp = (c.rollout && c.rollout.byPlatform) || {};
      var cm = c.metrics || {};
      var byPlatformMetrics = (state.metrics || {}).byPlatform || {};
      var hasPrevious = Boolean(c.previous && c.previous.releaseId);
      var rollbackDisabled = (!state.adminEnabled || !hasPrevious) ? ' disabled' : '';
      var republishDisabled = (!state.adminEnabled || !c.releaseId) ? ' disabled' : '';
      // 只有异常状态才占用头部空间；「独立发布」是常态，不显示。
      var badge = c.rollback
        ? '<span class="tag red">回滚指令</span>'
        : c.inheritedFrom
          ? '<span class="tag amber">继承 ' + esc(c.inheritedFrom) + '</span>'
          : '';
      var current = c.releaseId
        ? '<span class="ch-version-label">当前版本</span><span class="tag green">current</span>'
          + '<span class="mono ch-release" title="' + escAttr(c.releaseId) + '">' + esc(c.releaseId) + '</span>'
          + '<button type="button" class="mini" data-copy="' + escAttr(c.releaseId) + '" aria-label="复制 ' + ch + ' 当前版本 releaseId">复制</button>'
        : '<span class="ch-version-label">当前版本</span><span class="tag gray">未发布</span>';
      var previous = hasPrevious
        ? '<span class="ch-version-label">上一版本</span><span class="tag amber">previous</span>'
          + '<span class="mono ch-release" title="' + escAttr(c.previous.releaseId) + '">' + esc(c.previous.releaseId) + '</span>'
          + '<button type="button" class="mini" data-copy="' + escAttr(c.previous.releaseId) + '" aria-label="复制 ' + ch + ' 上一版本 releaseId">复制</button>'
        : '<span class="ch-version-label">上一版本</span><span class="empty">暂无</span>';

      var historyItems = c.history || [];
      var history = historyItems.length
        ? '<details class="ch-history"><summary>最近变更（' + historyItems.length + ' 条）'
          + '<span class="meta"> · ' + esc(historyItems[0].action) + ' · ' + esc(fmtTime(historyItems[0].at)) + '</span></summary>'
          + '<ul class="history">' + historyItems.map(function (h) {
            return '<li><b>' + esc(h.action) + '</b><span class="meta">' + esc(fmtTime(h.at)) + '</span>'
              + (h.releaseId ? ' <code title="' + escAttr(h.releaseId) + '">' + esc(fmtShort(h.releaseId)) + '</code>' : '')
              + (h.operator ? '<span class="meta">' + esc(h.operator) + (h.via ? '（' + esc(h.via) + '）' : '') + '</span>' : '')
              + '</li>';
          }).join('') + '</ul></details>'
        : '<div class="ch-history"><span class="meta">最近变更</span> <span class="empty">暂无变更记录</span></div>';

      // 每个平台独立展示配置与观测，但一次保存提交双端，避免误覆盖另一平台。
      var platformCells = PLATFORMS.map(function (platform) {
        var label = PLATFORM_LABEL[platform] || platform;
        var override = bp[platform];
        var hasOverride = override !== undefined && override !== null;
        var effective = clamp(hasOverride ? override : percentage, 0, 100);
        var pm = byPlatformMetrics[platform] || {};
        var pcm = (pm.byChannel || {})[c.channel] || {};
        var inputId = 'pct-' + platform + '-' + ch;
        var presets = [0, 10, 20, 50, 100].map(function (value) {
          return '<button type="button" class="mini" data-act="set-percentage" data-platform="' + platform
            + '" data-value="' + value + '" aria-label="将 ' + label + ' 灰度设为 ' + value + '%"' + disabled + '>' + value + '%</button>';
        }).join('');
        return '<div class="ch-platform" data-platform="' + platform + '">'
          + '<div class="ch-platform-head"><div class="ch-platform-name"><b>' + label + '</b>'
          + '<span class="tag ' + (hasOverride ? 'blue' : 'gray') + '">' + (hasOverride ? '独立配置' : '跟随默认') + '</span></div>'
          + '<span class="ch-effective">' + effective + '%</span></div>'
          + '<div class="ch-control"><label for="' + inputId + '">灰度比例</label><div class="ch-percent">'
          + '<input id="' + inputId + '" type="number" min="0" max="100" value="' + effective + '" data-orig="' + effective + '"' + disabled + '><span>%</span></div></div>'
          + '<div class="ch-presets" role="group" aria-label="' + label + ' 灰度快捷设置">' + presets + '</div>'
          + '<div class="bar" role="progressbar" aria-label="' + label + ' 当前灰度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + effective + '"><i style="width:' + effective + '%"></i></div>'
          + '<div class="ch-stat"><span>7 天观测</span><b>' + esc(pcm.total || 0) + ' 请求 · '
          + esc(pcm.uniqueUids || 0) + ' 设备 · ' + esc(pcm.errors || 0) + ' 错误</b></div>'
          + '<div class="ch-stat-detail">current ' + esc(pcm.current || 0) + ' · previous '
          + esc(pcm.previous || 0) + ' · whitelist ' + esc(pcm.whitelist || 0) + '</div>'
          + '</div>';
      }).join('');

      return '<div class="ch" data-channel="' + ch + '" id="channel-panel-' + index + '" role="tabpanel"'
        + ' aria-labelledby="channel-tab-' + index + '"' + (c.channel === activeChannel ? '' : ' hidden') + '>'
        + '<div class="ch-head"><div class="ch-title"><b>' + esc(c.channel) + '</b>' + badge + '</div>'
        + '<div class="ch-head-meta"><span class="ch-total">7 天合计：' + esc(cm.total || 0) + ' 请求 · '
        + esc(cm.uniqueUids || 0) + ' 设备 · ' + esc(cm.errors || 0) + ' 错误</span>'
        + '<span class="ch-updated">更新于 ' + esc(fmtTime(c.createdAt)) + '</span></div></div>'
        + '<div class="ch-versions"><div class="ch-version">' + current + '</div><div class="ch-version">' + previous + '</div></div>'
        + '<div class="ch-body">'
        + '<div class="ch-section"><div class="ch-section-head"><div><h3>平台灰度</h3><p>快捷档位仅修改输入；保存时会同时提交 iOS 与 Android 当前比例</p></div>'
        + '<button type="button" class="primary" data-act="save-platform"' + disabled + '>保存全部平台灰度</button></div>'
        + '<div class="ch-platforms">' + platformCells + '</div></div>'
        + '<div class="ch-section"><div class="ch-section-head"><div><h3>白名单</h3><p>使用英文逗号分隔 uid，对 iOS 与 Android 同时生效</p></div>'
        + '<span class="tag gray">' + whitelistCount + ' 个 uid</span></div>'
        + '<div class="ch-whitelist"><label class="sr-only" for="wl-' + ch + '">' + esc(c.channel) + ' 白名单 uid</label>'
        + '<input id="wl-' + ch + '" type="text" placeholder="例如：uid1,uid2" value="' + escAttr(whitelist) + '" data-orig="' + escAttr(whitelist) + '"' + disabled + '>'
        + '<button type="button" class="primary" data-act="save-whitelist"' + disabled + '>保存白名单</button></div></div>'
        + '<div class="ch-section"><div class="ch-section-head"><div><h3>发布操作</h3><p>提升历史版本，或回滚、重新发布当前通道</p></div></div>'
        + '<div class="ch-release-actions"><div class="ch-promote"><label for="ver-' + ch + '">选择要提升的历史版本</label><div class="inline">'
        + '<select id="ver-' + ch + '"' + disabled + '><option value="">选择版本…</option>' + releaseOptions + '</select>'
        + '<button type="button" data-act="promote" disabled>提升所选版本</button></div></div>'
        + '<div class="ch-secondary-actions"><button type="button" data-act="rollback"' + rollbackDisabled
        + (!hasPrevious ? ' title="暂无上一版本，无法回滚"' : '') + '>回滚上一版本</button>'
        + '<button type="button" data-act="republish"' + republishDisabled
        + (!c.releaseId ? ' title="当前通道尚未发布"' : '') + '>重新发布当前版本</button></div></div></div>'
        + history
        + '</div></div>';
    }).join('');

    $('#channelsHint').textContent = list.length + ' 条通道';
  }

  function activateChannel(channel, moveFocus) {
    view.channel = channel;
    var activeTab = null;
    var tabs = document.querySelectorAll('#channels [data-channel-tab]');
    for (var i = 0; i < tabs.length; i += 1) {
      var selected = tabs[i].dataset.channelTab === channel;
      tabs[i].classList.toggle('active', selected);
      tabs[i].setAttribute('aria-selected', String(selected));
      tabs[i].tabIndex = selected ? 0 : -1;
      if (selected) activeTab = tabs[i];
    }
    var panels = document.querySelectorAll('#channels [data-channel]');
    for (var j = 0; j < panels.length; j += 1) {
      panels[j].hidden = panels[j].dataset.channel !== channel;
    }
    if (moveFocus && activeTab) activeTab.focus();
  }

  // ---------- 渲染：Metrics 明细 ----------
  function renderMetricsDetail() {
    var m = state.metrics || {};
    var updateToRelease = {};
    (state.releases || []).forEach(function (r) { if (r.updateId) updateToRelease[r.updateId] = r.releaseId; });

    var channelRows = Object.keys(m.byChannel || {}).sort(function (a, b) {
      return (m.byChannel[b].total || 0) - (m.byChannel[a].total || 0);
    }).map(function (name) {
      var v = m.byChannel[name];
      return '<tr><td><b>' + esc(name) + '</b></td><td>' + esc(v.total) + '</td><td>' + esc(v.manifests)
        + '</td><td>' + esc(v.current) + '</td><td>' + esc(v.previous) + '</td><td>' + esc(v.whitelist)
        + '</td><td>' + esc(v.uniqueUids) + '</td><td>' + esc(v.errors) + '</td></tr>';
    }).join('');

    var statusRows = Object.keys(m.byStatus || {}).sort(function (a, b) {
      return m.byStatus[b] - m.byStatus[a];
    }).map(function (code) {
      var cls = Number(code) >= 400 ? 'red' : Number(code) >= 300 ? 'amber' : 'green';
      return '<span class="tag ' + cls + '">' + esc(code) + ' × ' + esc(m.byStatus[code]) + '</span>';
    }).join('') || '<span class="empty">暂无</span>';

    var versionRows = Object.keys(m.versions || {}).sort(function (a, b) {
      return m.versions[b] - m.versions[a];
    }).slice(0, 5).map(function (updateId) {
      return '<tr><td class="mono">' + esc(fmtShort(updateId)) + '</td><td class="mono">' + esc(updateToRelease[updateId] || '-')
        + '</td><td>' + esc(m.versions[updateId]) + '</td></tr>';
    }).join('');

    // 按平台表只列真实设备平台；unknown 收纳的是资源请求失败 / 历史无字段事件，
    // 不是「第三种平台」，单独用脚注提示，保留可排查性但不占一行。
    var platformRows = PLATFORMS.map(function (p) {
      var v = (m.byPlatform || {})[p] || {};
      var served = v.byServed || {};
      return '<tr><td><b>' + esc(PLATFORM_LABEL[p] || p) + '</b></td><td>' + esc(v.total || 0) + '</td><td>' + esc(v.manifests || 0)
        + '</td><td>' + esc(v.assets || 0) + '</td><td>' + esc(v.clientEvents || 0) + '</td><td>' + esc(v.uniqueUids || 0)
        + '</td><td>' + esc(served.current || 0) + ' / ' + esc(served.previous || 0) + ' / ' + esc(served.whitelist || 0)
        + '</td><td>' + esc(v.errors || 0) + '</td><td>' + pct(v.errors || 0, v.total || 0) + '%</td></tr>';
    }).join('');
    var unattributed = (m.byPlatform || {}).unknown || {};
    var unattributedNote = unattributed.total
      ? '<div class="meta" style="margin-top:8px">另有 ' + esc(unattributed.total)
        + ' 条未标记平台事件（资源请求失败 / 历史数据），不属于设备平台，未计入上表；可在「事件」页的平台筛选选择「未标记」查看。</div>'
      : '';

    $('#metrics').innerHTML = ''
      + '<div class="meta">窗口 ' + esc(m.windowDays || 7) + ' 天 · 事件 ' + esc(m.total || 0) + ' · manifest ' + esc(m.manifests || 0)
      + ' · 资源请求 ' + esc(m.assets || 0) + ' · 客户端上报 ' + esc(m.clientEvents || 0) + '</div>'
      + '<div class="meta" style="margin:8px 0">状态码分布：' + statusRows + '</div>'
      + '<h2 style="margin-top:16px">按平台（全量，不受顶部筛选影响）</h2>'
      + '<div class="table-wrap"><table><thead><tr><th>平台</th><th>事件</th><th>manifest</th><th>资源</th><th>客户端</th><th>设备</th><th>current / previous / whitelist</th><th>错误</th><th>错误率</th></tr></thead><tbody>'
      + (platformRows || '<tr><td colspan="9" class="empty">暂无数据</td></tr>') + '</tbody></table></div>'
      + unattributedNote
      + '<h2 style="margin-top:16px">按通道（受顶部筛选影响）</h2>'
      + '<div class="table-wrap"><table><thead><tr><th>通道</th><th>事件</th><th>manifest</th><th>current</th><th>previous</th><th>whitelist</th><th>设备</th><th>错误</th></tr></thead><tbody>'
      + (channelRows || '<tr><td colspan="8" class="empty">暂无数据</td></tr>') + '</tbody></table></div>'
      + (versionRows
        ? '<h2 style="margin-top:16px">updateId 命中 Top 5</h2><div class="table-wrap"><table><thead><tr><th>updateId</th><th>releaseId</th><th>manifest 命中</th></tr></thead><tbody>' + versionRows + '</tbody></table></div>'
        : '');
  }

  // ---------- 渲染：Updates ----------
  function renderUpdates() {
    var platform = view.updates.platform;
    var list = (state.releases || []).filter(function (r) {
      return !platform || (r.platforms || []).indexOf(platform) !== -1;
    });

    var size = view.updates.size;
    var pages = Math.max(1, Math.ceil(list.length / size));
    var page = Math.min(Math.max(1, view.updates.page), pages);
    view.updates.page = page;
    var slice = list.slice((page - 1) * size, page * size);

    var rows = slice.map(function (r) {
      var tags = '';
      if (r.currentChannels.length) tags += '<span class="tag green">current: ' + esc(r.currentChannels.join(', ')) + '</span>';
      if (r.previousChannels.length) tags += '<span class="tag amber">previous: ' + esc(r.previousChannels.join(', ')) + '</span>';
      if (r.sameAsCurrent && !r.currentChannels.length) tags += '<span class="tag blue">与 current 同产物</span>';
      if (r.restoredFrom) tags += '<span class="tag gray">源自 ' + esc(r.restoredFrom) + '</span>';
      if (!tags) tags = '<span class="tag gray">历史</span>';
      return '<tr><td>' + esc(fmtTime(r.createdAt)) + '</td>'
        + '<td class="mono">' + esc(r.releaseId) + ' <button type="button" class="mini" data-copy="' + escAttr(r.releaseId) + '">复制</button></td>'
        + '<td class="mono" title="' + escAttr(r.updateId) + '">' + esc(fmtShort(r.updateId)) + '</td>'
        + '<td>' + esc((r.platforms || []).join(', ')) + '</td>'
        + '<td>' + esc(fmtBytes(r.size)) + '</td>'
        + '<td>' + tags + '</td></tr>';
    }).join('');

    $('#updates').innerHTML = ''
      + '<div class="inline" style="margin-bottom:8px">'
      + '<select id="platform"><option value="">全部平台</option>'
      + PLATFORMS.map(function (p) {
        return '<option value="' + p + '"' + (platform === p ? ' selected' : '') + '>' + esc(PLATFORM_LABEL[p] || p) + '</option>';
      }).join('') + '</select>'
      + '<span class="meta">共 ' + list.length + ' 条</span></div>'
      + '<div class="table-wrap"><table><thead><tr><th>时间</th><th>releaseId</th><th>updateId</th><th>平台</th><th>大小</th><th>状态</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="6" class="empty">没有匹配的版本</td></tr>') + '</tbody></table></div>'
      + '<div class="pager">'
      + '<button type="button" id="upPrev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
      + '<span>' + page + ' / ' + pages + '</span>'
      + '<button type="button" id="upNext"' + (page >= pages ? ' disabled' : '') + '>下一页</button>'
      + '</div>';

    $('#updatesHint').textContent = '每次发布都会新增版本，可按 releaseId / updateId 搜索';
  }

  // ---------- 渲染：Events ----------
  function renderEvents() {
    var events = state.events || [];
    var total = state.eventsTotal || 0;
    var from = total ? view.events.offset + 1 : 0;
    var to = Math.min(view.events.offset + events.length, total);

    var rows = events.map(function (e) {
      var cls = e.status >= 200 && e.status < 300 ? 'green' : e.status >= 400 ? 'red' : 'amber';
      var raw = esc(JSON.stringify(e, null, 2));
      return '<tr><td>' + esc(fmtTime(e.at)) + '</td>'
        + '<td>' + esc(e.type) + '</td>'
        + '<td>' + esc(e.platform || 'unknown') + '</td>'
        + '<td>' + esc(e.channel) + '</td>'
        + '<td class="mono">' + esc(e.uid || '-') + '</td>'
        + '<td>' + esc(e.bucket === null || e.bucket === undefined ? '-' : e.bucket) + '</td>'
        + '<td>' + esc(e.served || '-') + '</td>'
        + '<td class="mono">' + esc(fmtShort(e.updateId)) + '</td>'
        + '<td><span class="tag ' + cls + '">' + esc(e.status) + '</span></td>'
        + '<td>' + esc(e.ms === undefined || e.ms === null ? '-' : e.ms + 'ms') + '</td>'
        + '<td><details><summary>JSON</summary><pre>' + raw + '</pre></details></td></tr>';
    }).join('');

    var channelList = [{ value: '', label: '全部通道' }];
    var seen = {};
    (state.channels || []).forEach(function (c) {
      if (!c.channel || seen[c.channel]) return;
      seen[c.channel] = true;
      channelList.push({ value: c.channel, label: c.channel });
    });
    channelList.push({ value: '-', label: '未标记通道' });
    var channelOptions = channelList.map(function (o) {
      return '<option value="' + escAttr(o.value) + '"' + (view.events.channel === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');

    // 只作用于事件流（eventsPlatform），不影响指标 / 概览 / 通道卡。
    var platformList = [{ value: '', label: '全部平台' }]
      .concat(PLATFORMS.map(function (p) { return { value: p, label: PLATFORM_LABEL[p] || p }; }))
      .concat([{ value: 'unknown', label: '未标记（非设备事件）' }]);
    var platformOptions = platformList.map(function (p) {
      return '<option value="' + escAttr(p.value) + '"' + (view.events.platform === p.value ? ' selected' : '') + '>' + esc(p.label) + '</option>';
    }).join('');

    $('#events').innerHTML = ''
      + '<div class="inline" style="margin-bottom:8px">'
      + '<input id="evType" type="text" placeholder="类型，如 manifest" value="' + escAttr(view.events.type) + '">'
      + '<select id="evPlatform">' + platformOptions + '</select>'
      + '<select id="evChannel">' + channelOptions + '</select>'
      + '<select id="evStatus">'
      + [['', '全部状态'], ['ok', '成功 (<400)'], ['error', '失败 (>=400)'], ['200', '200'], ['404', '404']]
        .map(function (p) {
          return '<option value="' + p[0] + '"' + (view.events.status === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('')
      + '</select>'
      + '<input id="evUid" type="text" placeholder="uid 片段" value="' + escAttr(view.events.uid) + '">'
      + '<button type="button" id="evReset">重置</button>'
      + '<span class="meta">' + from + '-' + to + ' / 共 ' + total + ' 条</span></div>'
      + '<div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>平台</th><th>通道</th><th>uid</th><th>bucket</th><th>served</th><th>updateId</th><th>状态</th><th>耗时</th><th>详情</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="11" class="empty">没有匹配的事件</td></tr>') + '</tbody></table></div>'
      + '<div class="pager">'
      + '<button type="button" id="evPrev"' + (view.events.offset <= 0 ? ' disabled' : '') + '>上一页</button>'
      + '<span>第 ' + (Math.floor(view.events.offset / view.events.limit) + 1) + ' 页</span>'
      + '<button type="button" id="evNext"' + (to >= total ? ' disabled' : '') + '>下一页</button>'
      + '</div>';

    $('#eventsHint').textContent = '过滤在服务端执行，覆盖全部已落盘事件；平台与顶部工具条联动';
  }

  // ---------- Tab 与页头 ----------
  function currentTab() {
    var name = (location.hash || '#overview').slice(1);
    return TABS.indexOf(name) !== -1 ? name : 'overview';
  }

  function renderCounts() {
    $('#tabChannels').textContent = (state.channels || []).length;
    $('#tabUpdates').textContent = (state.releases || []).length;
    $('#tabEvents').textContent = state.eventsTotal || 0;
  }

  function renderHeader() {
    var mode = $('#mode');
    mode.textContent = state.adminEnabled ? '读写' : '只读';
    mode.className = 'badge' + (state.adminEnabled ? '' : ' ro');
    $('#subline').textContent = '资产前缀：' + state.publicBaseUrl + ' · runtimeVersion：' + state.runtimeVersion
      + (view.platform ? ' · 全局平台：' + view.platform : '');
    updateRefreshLabel();
    $('#adminHint').innerHTML = state.adminEnabled
      ? '<div class="meta">填写服务启动时的 <code>OTA_ADMIN_TOKEN</code> 后可调整灰度、回滚、提升版本；令牌只存在本机浏览器。提示「管理令牌无效」时，请向服务端确认当前令牌后重新保存。</div>'
      : '<div class="warn">服务端未配置 <code>OTA_ADMIN_TOKEN</code>，写操作已禁用。</div>';
  }

  /** 只渲染当前 Tab，避免刷新时整页 DOM 抖动。 */
  function renderTab(name) {
    TABS.forEach(function (tab) {
      var panel = document.querySelector('[data-tab-panel="' + tab + '"]');
      if (panel) panel.hidden = tab !== name;
      var link = document.querySelector('#tabs a[data-tab="' + tab + '"]');
      if (link) link.classList.toggle('active', tab === name);
    });

    if (name === 'overview') {
      renderTrend();
      renderOverviewChannels();
      renderOverviewEvents();
    } else if (name === 'channels') {
      renderChannels();
    } else if (name === 'updates') {
      renderUpdates();
    } else if (name === 'metrics') {
      renderMetricsDetail();
    } else if (name === 'events') {
      renderEvents();
    }
    renderCounts();
  }

  function renderAll() {
    renderHeader();
    renderStats();
    renderTab(currentTab());
    booted = true;
  }

  // ---------- 数据刷新 ----------
  async function refresh(opts) {
    if (refreshing) {
      // 请求进行中又切了 Tab / 改了筛选：结束后按最新状态补一次。
      pendingRefresh = true;
      return;
    }
    refreshing = true;
    var silent = opts && opts.silent;
    // 倒计时从本次请求开始重新计时，避免慢请求刚结束就又触发一次。
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    var params = new URLSearchParams();
    params.set('rv', view.rv || '');
    // platform 只由 URL 显式指定（全局口径）。
    if (view.platform) params.set('platform', view.platform);
    // 事件筛选只属于「事件」页：只在当前 Tab 是 events 时进入请求与 URL。
    if (currentTab() === 'events') {
      if (view.events.platform) params.set('eventsPlatform', view.events.platform);
      params.set('eventsLimit', String(view.events.limit));
      params.set('eventsOffset', String(view.events.offset));
      if (view.events.type) params.set('eventsType', view.events.type);
      if (view.events.channel) params.set('eventsChannel', view.events.channel);
      if (view.events.status) params.set('eventsStatus', view.events.status);
      if (view.events.uid) params.set('eventsUid', view.events.uid);
    }

    var btn = $('#refresh');
    btn.disabled = true;
    try {
      var res = await fetch('/api/admin/state?' + params.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state = await res.json();
      view.rv = state.runtimeVersion || view.rv;
      history.replaceState(null, '', '/dashboard?' + params.toString() + location.hash);
      renderHeader();
      renderStats();
      renderTab(currentTab());
      // 通道页有未保存输入时 renderChannels 会跳过重绘，明确说明而不是让刷新看起来失效。
      var updated = $('#updated');
      if (updated && currentTab() === 'channels' && channelsDirty()) {
        updated.textContent += ' · 通道区有未保存输入，暂不重绘';
      }
      if (!silent) toast('已刷新', 'ok');
    } catch (err) {
      toast('刷新失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      refreshing = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        refresh({ silent: true });
      }
    }
  }

  // ---------- 写操作 ----------
  async function postAction(body, confirmText, btn) {
    var t = token();
    if (!t) {
      toast('请先在「设置」中填写管理令牌', 'warn');
      var settings = $('#settings');
      if (settings) settings.open = true;
      $('#token').focus();
      return;
    }
    if (confirmText && !window.confirm(confirmText)) return;

    var label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '处理中…';
    }
    try {
      var payload = Object.assign({ requestId: newRequestId() }, body);
      var res = await fetch('/api/admin/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ota-admin-token': t },
        body: JSON.stringify(payload),
      });
      var json = await res.json().catch(function () { return {}; });
      if (res.status === 401) {
        // 令牌无效时直接打开设置并聚焦，避免用户只看到一句报错。
        var settings = $('#settings');
        if (settings) settings.open = true;
        var input = $('#token');
        if (input) input.focus();
        throw new Error('管理令牌无效：请在「设置」中填写服务启动时的 OTA_ADMIN_TOKEN，并点「保存到本机」');
      }
      if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
      toast(json.duplicated ? '重复提交已忽略（60 秒内相同操作）' : '操作成功，已刷新', 'ok');
      await refresh({ silent: true });
    } catch (err) {
      toast('操作失败：' + err.message, 'err');
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  function syncPlatformPreview(input) {
    var cell = input && input.closest('.ch-platform');
    if (!cell) return;
    var raw = input.value.trim();
    var value = clamp(raw !== '' ? raw : input.dataset.orig, 0, 100);
    var effective = cell.querySelector('.ch-effective');
    var bar = cell.querySelector('.bar');
    var fill = cell.querySelector('.bar i');
    if (effective) effective.textContent = value + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(value));
    if (fill) fill.style.width = value + '%';
  }

  function actHandler(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('[data-channel]');
    if (!card) return;
    var ch = card.dataset.channel;

    var act = btn.dataset.act;
    if (act === 'set-percentage') {
      var percentageInput = $('#pct-' + btn.dataset.platform + '-' + ch);
      if (!percentageInput || percentageInput.disabled) return;
      percentageInput.value = btn.dataset.value;
      syncPlatformPreview(percentageInput);
      percentageInput.focus();
    } else if (act === 'save-whitelist') {
      // 白名单是全局策略，与各平台百分比分开保存。
      var wl = $('#wl-' + ch).value.split(',').map(function (v) { return v.trim(); }).filter(Boolean);
      postAction({
        action: 'set-rollout',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
        whitelist: wl,
      }, '确认保存 ' + ch + ' 的白名单 ' + wl.length + ' 个（覆盖）？', btn);
    } else if (act === 'save-platform') {
      var byPlatform = {};
      PLATFORMS.forEach(function (item) {
        var input = $('#pct-' + item + '-' + ch);
        var raw = input && input.value.trim();
        var fallback = input && input.dataset ? input.dataset.orig : '';
        byPlatform[item] = clamp(raw !== '' ? raw : fallback, 0, 100);
      });
      var summary = PLATFORMS.map(function (item) {
        return (PLATFORM_LABEL[item] || item) + ' ' + byPlatform[item] + '%';
      }).join(' / ');
      postAction({
        action: 'set-rollout',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
        byPlatform: byPlatform,
      }, '确认保存 ' + ch + ' 的灰度：' + summary + '？', btn);
    } else if (act === 'rollback') {
      postAction({
        action: 'rollback-previous',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
      }, '确认回滚通道 ' + ch + ' 到上一个版本？会重新发布并刷新时间戳。', btn);
    } else if (act === 'republish') {
      postAction({
        action: 'republish',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
      }, '确认重新发布通道 ' + ch + ' 的当前版本（刷新时间戳）？', btn);
    } else if (act === 'promote') {
      var select = $('#ver-' + ch);
      if (!select || !select.value) {
        toast('请先选择要提升的版本', 'warn');
        return;
      }
      postAction({
        action: 'promote',
        channel: ch,
        releaseId: select.value,
        runtimeVersion: state.runtimeVersion,
      }, '确认把版本 ' + select.value + ' 提升到通道 ' + ch + '？', btn);
    }
  }

  // ---------- 初始化 ----------
  function initControls() {
    var rvSelect = $('#rv');
    rvSelect.innerHTML = (state.runtimeVersions || []).map(function (v) {
      return '<option value="' + escAttr(v) + '"' + (v === view.rv ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('') || '<option value="">（无）</option>';
    rvSelect.addEventListener('change', function () {
      view.rv = rvSelect.value;
      view.events.offset = 0;
      refresh();
    });

    $('#refresh').addEventListener('click', function () { refresh(); });

    $('#auto').addEventListener('change', function (e) {
      view.auto = e.target.checked;
      setupTimer();
    });

    // 页面隐藏时暂停刷新，重新可见且已到点立即补一次。
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !view.auto) return;
      if (Date.now() >= nextRefreshAt) refresh({ silent: true });
      updateRefreshLabel();
    });

    window.addEventListener('hashchange', function () {
      renderTab(currentTab());
      // URL 只保留当前页参数：离开事件页后 events* 会被清掉。
      refresh({ silent: true });
    });

    // 写操作事件委托
    $('#channels').addEventListener('click', actHandler);
    $('#channels').addEventListener('click', function (e) {
      var tab = e.target.closest('button[data-channel-tab]');
      if (tab) activateChannel(tab.dataset.channelTab);
    });
    $('#channels').addEventListener('keydown', function (e) {
      var tab = e.target.closest('button[data-channel-tab]');
      if (!tab) return;
      var tabs = document.querySelectorAll('#channels [data-channel-tab]');
      var index = Array.prototype.indexOf.call(tabs, tab);
      var next = -1;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next < 0 || !tabs.length) return;
      e.preventDefault();
      activateChannel(tabs[next].dataset.channelTab, true);
    });
    $('#channels').addEventListener('input', function (e) {
      if (e.target.id && e.target.id.indexOf('pct-') === 0) syncPlatformPreview(e.target);
    });
    $('#channels').addEventListener('change', function (e) {
      if (!e.target.id || e.target.id.indexOf('ver-') !== 0) return;
      var card = e.target.closest('[data-channel]');
      var promote = card && card.querySelector('button[data-act="promote"]');
      if (promote) promote.disabled = !e.target.value;
    });

    // 复制按钮
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-copy]');
      if (!btn) return;
      var text = btn.dataset.copy;
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('已复制 ' + text, 'ok'); });
      else toast('复制失败，请手动选择', 'warn');
    });

    // Updates：平台筛选 + 分页
    $('#updates').addEventListener('change', function (e) {
      if (e.target.id !== 'platform') return;
      view.updates.platform = e.target.value;
      view.updates.page = 1;
      renderUpdates();
    });
    $('#updates').addEventListener('click', function (e) {
      if (e.target.id === 'upPrev') { view.updates.page -= 1; renderUpdates(); }
      if (e.target.id === 'upNext') { view.updates.page += 1; renderUpdates(); }
    });

    // Events：服务端过滤 + 分页
    function applyEventFilter() {
      var evPlatform = $('#evPlatform');
      view.events.platform = evPlatform ? evPlatform.value : '';
      view.events.type = $('#evType').value.trim();
      view.events.channel = $('#evChannel').value;
      view.events.status = $('#evStatus').value;
      view.events.uid = $('#evUid').value.trim();
      view.events.offset = 0;
      refresh({ silent: true });
    }
    var evTimer = null;
    function debounceFilter() {
      clearTimeout(evTimer);
      evTimer = setTimeout(applyEventFilter, 400);
    }
    $('#events').addEventListener('input', function (e) {
      if (e.target.id === 'evType' || e.target.id === 'evUid') debounceFilter();
    });
    $('#events').addEventListener('change', function (e) {
      if (e.target.id === 'evChannel' || e.target.id === 'evStatus' || e.target.id === 'evPlatform') applyEventFilter();
    });
    $('#events').addEventListener('click', function (e) {
      if (e.target.id === 'evReset') {
        $('#evType').value = '';
        $('#evUid').value = '';
        $('#evChannel').value = '';
        $('#evStatus').value = '';
        var evPlatform = $('#evPlatform');
        if (evPlatform) evPlatform.value = '';
        applyEventFilter();
      }
      if (e.target.id === 'evPrev') {
        view.events.offset = Math.max(0, view.events.offset - view.events.limit);
        refresh({ silent: true });
      }
      if (e.target.id === 'evNext') {
        view.events.offset += view.events.limit;
        refresh({ silent: true });
      }
    });

    // 管理令牌
    var tokenInput = $('#token');
    tokenInput.value = localStorage.getItem('ota_admin_token') || '';
    $('#saveToken').addEventListener('click', function () {
      var value = tokenInput.value.trim();
      tokenInput.value = value;
      localStorage.setItem('ota_admin_token', value);
      $('#tokenHint').textContent = value ? '已保存到本机浏览器' : '令牌为空，写操作仍会失败';
      toast(value ? '令牌已保存' : '令牌为空', value ? 'ok' : 'warn');
    });

    // 点击面板外部关闭设置
    document.addEventListener('click', function (e) {
      var settings = $('#settings');
      if (!settings || !settings.open) return;
      if (!settings.contains(e.target)) settings.open = false;
    });
  }

  function setupTimer() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    updateRefreshLabel();
    if (!view.auto) return;
    // 每秒更新倒计时，到点才发请求；比原来的 60 秒静默刷新更容易确认在工作。
    tickTimer = setInterval(function () {
      if (document.hidden) return;
      if (Date.now() >= nextRefreshAt) refresh({ silent: true });
      updateRefreshLabel();
    }, 1000);
  }

  renderAll();
  initControls();
  setupTimer();
})();
