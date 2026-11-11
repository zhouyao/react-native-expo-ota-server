/* OTA 更新控制台前端：Tab 分组、局部刷新、搜索、分页、写操作防重复。
 * 数据全部来自 /api/admin/state，渲染只消费已有字段，不新增统计口径。 */
(function () {
  'use strict';

  var TABS = ['overview', 'channels', 'updates', 'metrics', 'events', 'settings'];

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
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1024).toFixed(1) + ' KB';
  }
  function pct(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
  }
  /** 比率（0-1）→ 百分比字符串，保留一位小数。 */
  function ratePct(v) {
    return (Math.round((Number(v) || 0) * 1000) / 10) + '%';
  }
  /** 止损健康徽标：自动动作已关闭 / 健康 / 告警 / 已止损。 */
  function healthBadge(health) {
    if (!health) return '';
    if (!health.enabled) {
      return '<span class="tag gray" title="设置 OTA_STOP_LOSS_ENABLED=true 开启；健康度仍在统计">自动止损已关闭</span>';
    }
    var cls = 'green';
    var label = '健康';
    if (health.verdict === 'alert') { cls = 'amber'; label = '告警'; }
    else if (health.verdict === 'halt' || health.verdict === 'rollback') { cls = 'red'; label = '已止损'; }
    else if (health.reason === 'insufficient-samples') { cls = 'gray'; label = '样本不足'; }
    var failRate = health.launchFailRate === undefined
      ? health.emergencyRate
      : health.launchFailRate;
    return '<span class="tag ' + cls + '">' + label + '</span>'
      + '<span class="meta" title="启动失败率（应急+回退） / 安装失败率">失败 ' + ratePct(failRate)
      + ' · 安装 ' + ratePct(health.installFailRate)
      + (health.fallback ? ' · 回退 ' + esc(health.fallback) : '') + '</span>';
  }
  /** 实际运行版本与通道指针对齐的徽标。 */
  function runningKindTag(kind) {
    if (kind === 'current') return '<span class="tag green">current</span>';
    if (kind === 'previous') return '<span class="tag amber">previous</span>';
    if (kind === 'embedded') return '<span class="tag gray">内置</span>';
    return '<span class="tag red">其他</span>';
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
    settings: { tab: 'token' },
    updates: { platform: '', channel: '', run: '', query: '', page: 1, size: 10 },
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
    // 长消息（如评估结果）多留一会儿，避免还没看完就消失。
    var ms = String(text || '').length > 80 ? 6000 : 3600;
    setTimeout(function () { el.remove(); }, ms);
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

  /** 打开设置页并按需聚焦令牌输入（缺令牌 / 401 时使用）。 */
  function openSettings(focusToken) {
    if (location.hash !== '#settings') location.hash = '#settings';
    renderTab('settings');
    if (focusToken) {
      var input = $('#token');
      if (input && input.focus) input.focus();
    }
  }

  /** 设置页的止损输入是否被用户改过；改过就不被自动刷新覆盖。 */
  function settingsDirty() {
    var min = $('#slMinSamples');
    if (min && min.dataset.orig !== undefined && min.value !== min.dataset.orig) return true;
    var webhook = $('#slWebhook');
    if (webhook && webhook.value) return true;
    var clear = $('#slWebhookClear');
    if (clear && clear.checked) return true;
    return false;
  }

  /** 回填止损设置（force=true 时无条件覆盖，用于保存成功后）。 */
  function syncStopLossSettings(force) {
    var sl = state.stopLoss || {};
    var dirty = settingsDirty();
    if (force || !dirty) {
      var min = $('#slMinSamples');
      if (min) {
        min.value = sl.minSamples === undefined ? '' : String(sl.minSamples);
        min.dataset.orig = min.value;
      }
      var webhook = $('#slWebhook');
      if (webhook) {
        webhook.value = '';
        webhook.placeholder = sl.webhookConfigured
          ? '已配置' + (sl.webhookOrigin ? '（' + sl.webhookOrigin + '）' : '') + '，留空不修改'
          : 'https://oapi.dingtalk.com/robot/send?access_token=...';
      }
      var clear = $('#slWebhookClear');
      if (clear) clear.checked = false;
    }
    var hint = $('#stopLossHint');
    if (hint) {
      hint.textContent = 'MIN_SAMPLES=' + (sl.minSamples === undefined ? '-' : String(sl.minSamples))
        + ' · Webhook ' + (sl.webhookConfigured ? '已配置' : '未配置');
    }
    var source = $('#slSource');
    if (source) {
      var ov = sl.overridden || {};
      var policy = !sl.enabled
        ? '自动止损已关闭'
        : sl.mode === 'monitor'
          ? '仅监控（只告警）'
          : sl.mode === 'rollback'
            ? '自动止血并标记待回滚'
            : sl.mode === 'halt'
              ? '自动止血'
              : '未知';
      source.textContent = '当前策略：' + policy
        + (ov.minSamples || ov.webhook ? ' · 部分项由控制台覆盖' : ' · 全部来自环境变量');
    }
  }

  /** 设置页的回收输入是否被用户改过。 */
  function gcSettingsDirty() {
    var days = $('#gcKeepDays');
    if (days && days.dataset.orig !== undefined && days.value !== days.dataset.orig) return true;
    var last = $('#gcKeepLast');
    if (last && last.dataset.orig !== undefined && last.value !== last.dataset.orig) return true;
    var mode = $('#gcMode');
    if (mode && mode.dataset.orig !== undefined && mode.value !== mode.dataset.orig) return true;
    return false;
  }

  /** 回填回收设置（force=true 时无条件覆盖，用于保存成功后）。 */
  function syncGcSettings(force) {
    var gc = state.gc || {};
    if (force || !gcSettingsDirty()) {
      var days = $('#gcKeepDays');
      if (days) {
        days.value = gc.keepDays === undefined || gc.keepDays === null ? '' : String(gc.keepDays);
        days.dataset.orig = days.value;
      }
      var last = $('#gcKeepLast');
      if (last) {
        last.value = gc.keepLast === undefined || gc.keepLast === null ? '' : String(gc.keepLast);
        last.dataset.orig = last.value;
      }
      var mode = $('#gcMode');
      if (mode) {
        mode.value = gc.mode === 'apply' ? 'apply' : 'dry-run';
        mode.dataset.orig = mode.value;
      }
    }

    // 未开启 OTA_GC_ENABLED 时不允许在控制台切「执行」：自动回收的闸门在部署层。
    var modeEl = $('#gcMode');
    if (modeEl) modeEl.disabled = !gc.enabled;

    var ov = gc.overridden || {};
    // 差分 base 也受保护：实际保留数 = max(最少保留版本数, 差分 base 保护数)，
    // 否则「设了 3 却只删到剩 5 个」会让人以为回收没生效。
    var keepLast = gc.keepLast === undefined || gc.keepLast === null ? 0 : Number(gc.keepLast);
    var patchBases = gc.patchBases === undefined || gc.patchBases === null ? 0 : Number(gc.patchBases);
    var effectiveKeep = Math.max(keepLast, patchBases);
    var hint = $('#gcHint');
    if (hint) {
      hint.textContent = '当前生效：保留 ' + (gc.keepDays === undefined ? '-' : String(gc.keepDays)) + ' 天'
        + ' / 最少 ' + (gc.keepLast === undefined ? '-' : String(gc.keepLast)) + ' 个'
        + ' · 模式 ' + (gc.mode === 'apply' ? '执行（真实删除）' : '预览（只记录）');
    }
    if (hint && patchBases > keepLast) {
      hint.textContent += '（实际至少保留 ' + effectiveKeep + ' 个：差分 base 保护要求 ' + patchBases
        + ' 个，高于所设的最少保留版本数）';
    }

    var source = $('#gcSource');
    if (source) {
      var parts = [];
      parts.push(gc.enabled ? '自动回收已开启' : '自动回收未开启（需服务端 OTA_GC_ENABLED=true）');
      parts.push('间隔 ' + Math.round(Number(gc.intervalMs || 0) / 60000) + ' 分钟');
      parts.push('差分 base 保护 ' + (gc.patchBases === undefined ? 0 : gc.patchBases) + ' 个');
      parts.push(
        ov.keepDays || ov.keepLast || ov.mode
          ? '部分项由控制台覆盖'
          : '全部来自环境变量',
      );
      if (gc.lastRunAt) {
        parts.push(
          '上次执行 ' + fmtTime(gc.lastRunAt) + '（候选 ' + (gc.lastCandidates || 0)
            + '、回收 ' + (gc.lastRemoved || 0) + ' 个 / ' + fmtBytes(gc.lastBytes || 0) + '）',
        );
      } else {
        parts.push('尚未执行过');
      }
      if (gc.lastError) parts.push('最近错误：' + gc.lastError);
      source.textContent = parts.join(' · ');
    }
  }

  /** 设置页：左侧分类切换右侧内容。 */
  function renderSettings() {
    var tab = view.settings.tab || 'token';
    var items = document.querySelectorAll('#settingsNav [data-settings-tab]');
    for (var i = 0; i < items.length; i += 1) {
      var active = items[i].dataset.settingsTab === tab;
      items[i].classList.toggle('active', active);
      items[i].setAttribute('aria-selected', String(active));
    }
    var panels = document.querySelectorAll('[data-settings-panel]');
    for (var j = 0; j < panels.length; j += 1) {
      panels[j].hidden = panels[j].dataset.settingsPanel !== tab;
    }
    syncStopLossSettings(false);
    syncGcSettings(false);
  }

  // ---------- 渲染：概览 ----------
  function renderStats() {
    var m = state.metrics || {};
    var p = m.patch || {};
    var s = state.stats || {};
    var errRate = pct(m.errors, m.total);
    // 按「运营核心 → 资产 → 效率」分组；宽屏 4 列，前 4 项一行、后 4 项一行。
    var cards = [
      { label: '通道', value: esc(s.channels), hint: '当前 runtimeVersion 下的通道数' },
      { label: '历史发布', value: esc(s.releases), hint: '每次发布/提升/回滚/重发都新增一条不可变产物；下发内容合计 ' + fmtBytes(s.assetsBytes || 0) + '（不含 gzip 副本）' },
      { label: '7 天 manifest 请求', value: esc(m.manifests), hint: '指标窗口固定 7 天' + (view.platform ? '，已按平台 ' + view.platform + ' 筛选' : '') },
      { label: '错误率', value: errRate + '%', hint: '口径：7 天内全部事件（manifest / asset / 客户端上报）中 status>=400 的占比，' + esc(m.errors) + '/' + esc(m.total), tone: errRate > 0 ? 'bad' : '' },
      { label: '磁盘占用', value: fmtBytes(s.diskBytes || 0), hint: '按 inode 去重后的真实占用：提升/重发用硬链接复用的资产只算一次，含 gzip 副本与日志' },
      { label: '补丁库', value: esc(s.patchCount || 0) + ' 个 / ' + fmtBytes(s.patchBytes || 0), hint: '差分补丁文件数量与体积；命中率见指标页' },
      { label: '差分命中率', value: esc(p.hitRate || 0) + '%', hint: '口径：7 天内带 A-IM 的 asset 请求中返回 226 补丁的占比，' + esc(p.hits || 0) + '/' + esc(p.requests || 0), tone: 'blue' },
      { label: '节省流量', value: fmtBytes(p.savedBytes), hint: '补丁相比 gzip 完整包累计节省的下载字节', tone: 'ok' },
    ];
    $('#stats').innerHTML = cards.map(function (c) {
      return '<div class="stat" title="' + esc(c.hint) + '"><b'
        + (c.tone ? ' class="tone-' + c.tone + '"' : '')
        + '>' + c.value + '</b><span>' + esc(c.label) + '</span></div>';
    }).join('');
  }

  /** 数据目录构成：磁盘到底被什么占了。 */
  function renderStorage() {
    var s = state.stats || {};
    var dirs = s.dirs || {};
    var rows = [
      ['releases', dirs.releases || 0, '发布产物（按 inode 去重）'],
      ['patches', dirs.patches || 0, '差分补丁库'],
      ['embedded', dirs.embedded || 0, '已注册内置包'],
      ['metrics', dirs.metrics || 0, 'events.jsonl 及轮转文件'],
      ['audit', dirs.audit || 0, 'audit.jsonl'],
    ];
    var total = rows.reduce(function (sum, row) { return sum + row[1]; }, 0);
    var body = rows.map(function (row) {
      var share = total ? Math.round((row[1] / total) * 100) : 0;
      return '<tr><td><b>' + esc(row[0]) + '</b></td>'
        + '<td>' + esc(fmtBytes(row[1])) + '</td>'
        + '<td>' + esc(share) + '%</td>'
        + '<td class="meta">' + esc(row[2]) + '</td></tr>';
    }).join('');
    $('#storage').innerHTML = ''
      + '<div class="table-wrap"><table><thead><tr><th>目录</th><th>占用</th><th>占比</th><th>说明</th></tr></thead><tbody>'
      + body
      + '<tr><td><b>合计</b></td><td>' + esc(fmtBytes(total)) + '</td><td>100%</td>'
      + '<td class="meta">下发内容 ' + esc(fmtBytes(s.assetsBytes || 0))
      + ' + gzip 副本 ' + esc(fmtBytes(s.gzipBytes || 0)) + '</td></tr>'
      + '</tbody></table></div>';
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
      var topRun = c.running && c.running.versions && c.running.versions[0];
      var runCell = topRun
        ? '<span class="mono" title="' + escAttr(topRun.updateId || 'embedded') + '">'
          + esc(topRun.updateId || 'embedded') + '</span> '
          + '<span class="meta">' + esc(topRun.devices) + ' 台</span> '
          + runningKindTag(topRun.kind)
        : '<span class="empty">暂无上报</span>';
      return '<tr><td><b>' + esc(c.channel) + '</b> ' + badge + ' ' + healthBadge(c.health) + '</td>'
        + '<td class="mono" title="' + escAttr(c.releaseId) + '">' + esc(c.releaseId) + '</td>'
        + '<td>' + runCell + '</td>'
        + '<td>' + clamp(c.rollout && c.rollout.percentage, 0, 100) + '%' + platformRolloutTag(c.rollout) + '</td>'
        + '<td>' + esc(cm.total || 0) + '</td>'
        + '<td>' + esc(cm.errors || 0) + '</td></tr>';
    }).join('');
    $('#overviewChannels').innerHTML = '<div class="table-wrap"><table><thead><tr><th>通道</th><th>current</th><th>实际运行</th><th>灰度</th><th>7天</th><th>错误</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="6" class="empty">暂无通道</td></tr>') + '</tbody></table></div>';
  }

  function renderOverviewEvents() {
    var rows = (state.events || []).slice(0, 5).map(function (e) {
      var cls = e.status >= 200 && e.status < 300 ? 'green' : e.status >= 400 ? 'red' : 'amber';
      return '<tr><td>' + esc(fmtTime(e.at)) + '</td><td>' + esc(e.type) + '</td><td>' + esc(e.platform || 'unknown')
        + '</td><td>' + esc(e.channel) + '</td><td class="mono">' + esc(e.uid || '-')
        + '</td><td><span class="tag ' + cls + '">' + esc(e.status) + '</span></td></tr>';
    }).join('');
    $('#overviewEvents').innerHTML = '<div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>平台</th><th>通道</th><th>uid</th><th>状态</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="6" class="empty">暂无事件</td></tr>') + '</tbody></table></div>';
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
        + esc(r.updateId) + ' · ' + esc(fmtTime(r.createdAt)) + '</option>';
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
      var health = c.health || null;
      var sl = c.stopLoss || null;
      var canRestore = Boolean(sl && sl.previousRollout);
      var policyText = !health
        ? '未知'
        : !health.enabled
          ? '已关闭（仅展示健康度，不自动动作）'
          : health.mode === 'monitor'
            ? '仅监控（超阈值只告警，不自动动作）'
            : health.mode === 'rollback'
              ? '自动止血并标记待回滚'
              : health.mode === 'halt'
                ? '自动止血（超阈值直接降为 0%）'
                : '未知';
      var healthSection = '<div class="ch-section"><div class="ch-section-head">'
        + '<div><h3>止损 / 健康度</h3><p>口径：被本通道下发过 current 的设备中，应急启动率与安装失败率</p></div>'
        + '<div class="inline">'
        + '<button type="button" data-act="evaluate-stop-loss"' + disabled + ' title="只读评估当前健康度，不改灰度">立即评估</button>'
        + '<button type="button" class="danger" data-act="halt-channel"'
        + (state.adminEnabled && c.releaseId ? '' : ' disabled')
        + (c.releaseId ? '' : ' title="当前通道未发布，无需止血"') + '>紧急止血</button>'
        + '<button type="button" data-act="restore-rollout"'
        + (state.adminEnabled && canRestore ? '' : ' disabled')
        + (canRestore ? '' : ' title="暂无可恢复的暂停前灰度"') + '>恢复暂停前灰度</button>'
        + '</div></div>'
        + '<div class="ch-stat"><span>自动动作</span><b>' + esc(policyText) + '</b></div>'
        + '<div class="ch-stat"><span>样本 / 设备</span><b>' + esc((health && health.samples) || 0)
        + ' / ' + esc((health && health.cohortSize) || 0) + '</b></div>'
        + '<div class="ch-stat-detail">启动失败 ' + esc((health && health.badLaunches) || 0) + '/'
        + esc((health && health.launches) || 0) + '（' + ratePct(health && health.launchFailRate) + '）'
        + ' · 应急 ' + esc((health && health.emergency) || 0)
        + ' · 回退 ' + esc((health && health.fallback) || 0)
        + ' · 安装失败 ' + esc((health && health.fails) || 0) + '/'
        + esc((health && health.attempts) || 0) + '（' + ratePct(health && health.installFailRate) + '）</div>'
        + (health ? '<div class="ch-stat-detail">' + healthBadge(health) + '</div>' : '')
        + (sl ? '<div class="ch-stat-detail">最近止损：' + esc(sl.action) + ' · ' + esc(fmtTime(sl.at))
          + (sl.operator ? ' · ' + esc(sl.operator) : '')
          + (sl.reason ? ' · ' + esc(sl.reason) : '')
          + (sl.previousRollout ? ' · 可恢复' : '') + '</div>' : '')
        + '</div>';
      var running = c.running || { devices: 0, versions: [] };
      var runningKindLabel = {
        current: ['green', 'current'],
        previous: ['amber', 'previous'],
        embedded: ['gray', '内置包'],
        other: ['red', '其他版本'],
      };
      var runningRows = (running.versions || []).map(function (v) {
        var kind = runningKindLabel[v.kind] || ['gray', v.kind || '未知'];
        return '<tr><td class="mono" title="' + escAttr(v.updateId || 'embedded') + '">'
          + esc(v.updateId || 'embedded') + '</td>'
          + '<td class="mono" title="' + escAttr(v.releaseId) + '">' + esc(v.releaseId) + '</td>'
          + '<td>' + esc(v.platform === 'unknown' ? '未标记' : v.platform) + '</td>'
          + '<td>' + esc(v.devices) + '</td>'
          + '<td>' + esc(fmtTime(v.lastAt)) + '</td>'
          + '<td><span class="tag ' + kind[0] + '">' + esc(kind[1]) + '</span></td></tr>';
      }).join('');
      var runningSection = '<div class="ch-section"><div class="ch-section-head">'
        + '<div><h3>实际运行版本</h3><p>最近 7 天来自客户端上报的最近一次运行版本，按设备去重；与通道 current/previous 指针区分</p></div>'
        + '<span class="tag gray">' + esc(running.devices || 0) + ' 台设备</span></div>'
        + '<div class="table-wrap"><table><thead><tr><th>updateId</th><th>releaseId</th><th>平台</th><th>设备</th><th>最近上报</th><th>对齐</th></tr></thead><tbody>'
        + (runningRows || '<tr><td colspan="6" class="empty">暂无客户端上报</td></tr>') + '</tbody></table></div></div>';
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
              + (h.releaseId ? ' <code title="' + escAttr(h.releaseId) + '">' + esc(h.releaseId) + '</code>' : '')
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
        + '<div class="ch-head"><div class="ch-title"><b>' + esc(c.channel) + '</b>' + badge
        + (health ? ' ' + healthBadge(health) : '') + '</div>'
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
        + healthSection
        + runningSection
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
  /** 指标页的下载流量小节：区分原始 / gzip / 分片 / 补丁，并给出最占流量的文件。 */
  function transferSection(m) {
    var t = m.transfer || {};
    if (!t.requests) {
      return '<div class="panel"><h2>下载流量 <span class="meta">最近 7 天</span></h2>'
        + '<div class="empty">暂无资源请求（旧事件没有 bytes 字段，新请求会开始统计）</div></div>';
    }
    var kindLabel = { raw: '原始字节', gzip: 'gzip 压缩', range: '分片（206）', patch: '差分补丁（226）' };
    var kindRows = ['raw', 'gzip', 'range', 'patch'].map(function (kind) {
      var v = (t.byKind && t.byKind[kind]) || { requests: 0, bytes: 0 };
      return '<tr><td><b>' + esc(kindLabel[kind]) + '</b></td><td>' + esc(v.requests || 0) + '</td>'
        + '<td>' + esc(fmtBytes(v.bytes || 0)) + '</td>'
        + '<td>' + esc(pct(v.bytes || 0, t.bytes || 0)) + '%</td></tr>';
    }).join('');
    var fileRows = (t.byFile || []).map(function (file) {
      var name = String(file.file || '');
      return '<tr><td class="mono" title="' + escAttr(name) + '">' + esc(name.split('/').pop()) + '</td>'
        + '<td>' + esc(file.requests || 0) + '</td>'
        + '<td>' + esc(fmtBytes(file.bytes || 0)) + '</td>'
        + '<td>' + esc(fmtBytes(file.requests ? Math.round(file.bytes / file.requests) : 0)) + '</td></tr>';
    }).join('');
    return '<div class="panel"><h2>下载流量 <span class="meta">最近 7 天</span></h2>'
      + '<div class="meta">资源请求 ' + esc(t.requests || 0)
      + ' · 下发 ' + esc(fmtBytes(t.bytes || 0))
      + ' · 平均 ' + esc(fmtBytes(t.requests ? Math.round(t.bytes / t.requests) : 0)) + '/请求'
      + ' · 分片请求 ' + esc(t.rangeRequests || 0)
      + ' · 涉及文件 ' + esc(t.uniqueFiles || 0) + '</div>'
      + '<div class="grid-2">'
      + '<div class="stat"><h2>按类型</h2><div class="table-wrap"><table><thead><tr><th>类型</th><th>请求</th><th>下发</th><th>占比</th></tr></thead><tbody>'
      + kindRows + '</tbody></table></div></div>'
      + (fileRows
        ? '<div class="stat"><h2>Top 10 文件</h2>'
          + '<div class="table-wrap"><table><thead><tr><th>文件</th><th>请求</th><th>下发</th><th>平均</th></tr></thead><tbody>'
          + fileRows + '</tbody></table></div></div>'
        : '')
      + '</div>'
      + '</div>';
  }

  /** 指标页的增量差分小节：命中/回退、节省量、按平台与按通道。 */
  function patchSection(m) {
    var p = m.patch || {};
    var byPlatform = p.byPlatform || {};
    var platformRows = PLATFORMS.map(function (name) {
      var v = byPlatform[name] || {};
      return '<tr><td><b>' + esc(PLATFORM_LABEL[name] || name) + '</b></td>'
        + '<td>' + esc(v.requests || 0) + '</td><td>' + esc(v.hits || 0) + '</td>'
        + '<td>' + esc(v.fallbacks || 0) + '</td><td>' + esc(v.hitRate || 0) + '%</td>'
        + '<td>' + esc(fmtBytes(v.savedBytes)) + '</td></tr>';
    }).join('');
    var byChannel = p.byChannel || {};
    // 兼容历史数据里被兜底成 '-' 的空通道 key，不在「按通道」表里展示。
    var channelRows = Object.keys(byChannel).filter(function (name) {
      return name && name !== '-';
    }).sort(function (a, b) {
      return (byChannel[b].requests || 0) - (byChannel[a].requests || 0);
    }).map(function (name) {
      var v = byChannel[name];
      return '<tr><td><b>' + esc(name) + '</b></td><td>' + esc(v.requests || 0) + '</td>'
        + '<td>' + esc(v.hits || 0) + '</td><td>' + esc(v.hitRate || 0) + '%</td>'
        + '<td>' + esc(fmtBytes(v.savedBytes)) + '</td></tr>';
    }).join('');
    var reasons = p.reasons || {};
    var reasonTags = Object.keys(reasons).sort(function (a, b) {
      return reasons[b] - reasons[a];
    }).map(function (reason) {
      return '<span class="tag gray">' + esc(reason) + ' × ' + esc(reasons[reason]) + '</span>';
    }).join('') || '<span class="empty">暂无</span>';

    return '<div class="panel"><h2>增量差分 <span class="meta">最近 7 天</span></h2>'
      + '<div class="meta">请求 ' + esc(p.requests || 0) + ' · 命中 ' + esc(p.hits || 0)
      + ' · 回退 ' + esc(p.fallbacks || 0) + ' · 命中率 ' + esc(p.hitRate || 0) + '%'
      + ' · 补丁 ' + esc(fmtBytes(p.patchBytes)) + ' / 全量 ' + esc(fmtBytes(p.fullBytes))
      + ' · 节省 ' + esc(fmtBytes(p.savedBytes)) + '（' + esc(p.savingRate || 0) + '%）</div>'
      + '<div class="meta" style="margin:8px 0">回退原因：' + reasonTags + '</div>'
      + '<div class="grid-2">'
      + '<div class="stat"><h2>按平台</h2><div class="table-wrap"><table><thead><tr><th>平台</th><th>请求</th><th>命中</th><th>回退</th><th>命中率</th><th>节省</th></tr></thead><tbody>'
      + (platformRows || '<tr><td colspan="6" class="empty">暂无数据</td></tr>') + '</tbody></table></div></div>'
      + '<div class="stat"><h2>按通道 <span class="meta">受顶部筛选影响</span></h2><div class="table-wrap"><table><thead><tr><th>通道</th><th>请求</th><th>命中</th><th>命中率</th><th>节省</th></tr></thead><tbody>'
      + (channelRows || '<tr><td colspan="5" class="empty">暂无数据</td></tr>') + '</tbody></table></div></div>'
      + '</div>'
      + '<div class="meta" style="margin-top:8px">补丁库：' + esc((state.stats || {}).patchCount || 0)
      + ' 个 / ' + esc(fmtBytes((state.stats || {}).patchBytes)) + '</div>'
      + '</div>';
  }

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
      return '<tr><td class="mono" title="' + escAttr(updateId) + '">' + esc(updateId) + '</td><td class="mono">' + esc(updateToRelease[updateId] || '-')
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

    var kpis = [
      { label: '事件总数', value: esc(m.total || 0), hint: '7 天窗口内全部事件（manifest / asset / 客户端上报）' },
      { label: 'manifest 请求', value: esc(m.manifests || 0), hint: '客户端拉取 manifest 的次数' },
      { label: '资源请求', value: esc(m.assets || 0), hint: 'bundles / assets 下载请求' },
      { label: '客户端上报', value: esc(m.clientEvents || 0), hint: '客户端主动上报的事件' },
      { label: '独立设备', value: esc(m.uniqueUids || 0), hint: '7 天内去重后的设备数' },
    ];
    var kpiHtml = kpis.map(function (c) {
      return '<div class="stat" title="' + esc(c.hint) + '"><b>' + c.value + '</b><span>' + esc(c.label) + '</span></div>';
    }).join('');

    $('#metrics').innerHTML = ''
      + '<div class="stats" style="margin-bottom:16px">' + kpiHtml + '</div>'
      + '<div class="panel"><h2>状态码分布 <span class="meta">窗口 ' + esc(m.windowDays || 7) + ' 天</span></h2>' + statusRows + '</div>'
      + '<div class="panel"><h2>按平台 <span class="meta">全量，不受顶部筛选影响</span></h2>'
      + '<div class="table-wrap"><table><thead><tr><th>平台</th><th>事件</th><th>manifest</th><th>资源</th><th>客户端</th><th>设备</th><th>current / previous / whitelist</th><th>错误</th><th>错误率</th></tr></thead><tbody>'
      + (platformRows || '<tr><td colspan="9" class="empty">暂无数据</td></tr>') + '</tbody></table></div>'
      + unattributedNote
      + '</div>'
      + '<div class="panel"><h2>按通道 <span class="meta">受顶部筛选影响</span></h2>'
      + '<div class="table-wrap"><table><thead><tr><th>通道</th><th>事件</th><th>manifest</th><th>current</th><th>previous</th><th>whitelist</th><th>设备</th><th>错误</th></tr></thead><tbody>'
      + (channelRows || '<tr><td colspan="8" class="empty">暂无数据</td></tr>') + '</tbody></table></div></div>'
      + (versionRows
        ? '<div class="panel"><h2>updateId 命中 Top 5</h2><div class="table-wrap"><table><thead><tr><th>updateId</th><th>releaseId</th><th>manifest 命中</th></tr></thead><tbody>' + versionRows + '</tbody></table></div></div>'
        : '')
      + patchSection(m)
      + transferSection(m);
  }

  // ---------- 渲染：Updates ----------
  /** 把「各通道实际运行版本」汇总成 release 可查的索引（updateId / releaseId 双键）。 */
  function buildRunningIndex() {
    var byUpdate = {};
    var byRelease = {};
    function add(map, key, channelName, version) {
      if (!key) return;
      var entry = map[key] || (map[key] = { devices: 0, channels: {} });
      var channel = entry.channels[channelName] || (entry.channels[channelName] = { devices: 0, kinds: {} });
      channel.devices += version.devices || 0;
      channel.kinds[version.kind] = (channel.kinds[version.kind] || 0) + (version.devices || 0);
      entry.devices += version.devices || 0;
    }
    (state.channels || []).forEach(function (c) {
      var running = c.running;
      if (!running || !running.versions) return;
      running.versions.forEach(function (v) {
        if (v.embedded) return;
        add(byUpdate, v.updateId, c.channel, v);
        add(byRelease, v.releaseId, c.channel, v);
      });
    });
    return function runInfoFor(release) {
      if (!release) return null;
      return (release.updateId && byUpdate[release.updateId]) ||
        (release.releaseId && byRelease[release.releaseId]) ||
        null;
    };
  }

  function renderRunningCell(runInfo) {
    if (!runInfo || !runInfo.devices) return '<span class="empty">未运行</span>';
    var channelRows = Object.keys(runInfo.channels).sort().map(function (name) {
      var entry = runInfo.channels[name];
      var kinds = Object.keys(entry.kinds).map(function (kind) {
        return kind + ' ' + entry.kinds[kind];
      }).join(' / ');
      return '<div><b>' + esc(name) + '</b> ' + esc(entry.devices) + ' 台'
        + (kinds ? ' <span class="meta">' + esc(kinds) + '</span>' : '') + '</div>';
    }).join('');
    return channelRows + '<div class="meta">合计 ' + esc(runInfo.devices) + ' 台</div>';
  }

  function matchesRunningFilter(runInfo, filter) {
    if (!filter) return true;
    if (filter === 'running') return Boolean(runInfo && runInfo.devices);
    if (filter === 'idle') return !runInfo || !runInfo.devices;
    if (!runInfo) return false;
    return Object.keys(runInfo.channels).some(function (name) {
      return (runInfo.channels[name].kinds[filter] || 0) > 0;
    });
  }

  /** 版本页展开区：按目录（bundles / assets）汇总 + 最大的几个文件。 */
  function renderReleaseFiles(r) {
    var kinds = r.byKind || {};
    var kindRows = ['bundles', 'assets'].map(function (name) {
      var value = kinds[name];
      if (!value) return '';
      return '<tr><td><b>' + esc(name) + '</b></td><td>' + esc(value.files || 0) + '</td>'
        + '<td>' + esc(fmtBytes(value.rawBytes || 0)) + '</td>'
        + '<td>' + esc(fmtBytes(value.gzipBytes || 0)) + '</td></tr>';
    }).join('');
    var topRows = (r.largest || []).map(function (file) {
      var name = String(file.file || '');
      return '<tr><td class="mono" title="' + escAttr(name) + '">' + esc(name.split('/').pop()) + '</td>'
        + '<td>' + esc(fmtBytes(file.bytes || 0)) + '</td>'
        + '<td>' + esc(fmtBytes(file.gzipBytes || 0)) + '</td></tr>';
    }).join('');
    return '<div class="rel-files">'
      + '<table><thead><tr><th>目录</th><th>文件数</th><th>原始</th><th>gzip</th></tr></thead><tbody>'
      + kindRows + '</tbody></table>'
      + (topRows
        ? '<table><thead><tr><th>最大文件</th><th>原始</th><th>gzip</th></tr></thead><tbody>'
          + topRows + '</tbody></table>'
        : '')
      + '</div>';
  }

  function renderUpdates(options) {
    var platform = view.updates.platform;
    var channelFilter = view.updates.channel;
    var runFilter = view.updates.run;
    var query = String(view.updates.query || '').trim();
    // 空格分隔的多个关键词按 AND 组合，releaseId / updateId / 运行通道名都参与匹配。
    var terms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
    var total = (state.releases || []).length;
    var runInfoFor = buildRunningIndex();
    var list = (state.releases || []).filter(function (r) {
      if (platform && (r.platforms || []).indexOf(platform) === -1) return false;
      var runInfo = runInfoFor(r);
      if (channelFilter && !(runInfo && runInfo.channels[channelFilter] && runInfo.channels[channelFilter].devices)) {
        return false;
      }
      if (!matchesRunningFilter(runInfo, runFilter)) return false;
      if (!terms.length) return true;
      var words = [r.releaseId, r.updateId];
      if (runInfo) {
        Object.keys(runInfo.channels).forEach(function (name) {
          words.push(name);
          words = words.concat(Object.keys(runInfo.channels[name].kinds));
        });
      }
      var haystack = words.join(' ').toLowerCase();
      return terms.every(function (term) { return haystack.indexOf(term) !== -1; });
    });

    var size = view.updates.size;
    var pages = Math.max(1, Math.ceil(list.length / size));
    var page = Math.min(Math.max(1, view.updates.page), pages);
    view.updates.page = page;
    var slice = list.slice((page - 1) * size, page * size);

    // 重绘会替换输入框；先记录焦点，重绘后恢复，避免输入时被自动刷新打断。
    var keepFocus = Boolean(options && options.keepFocus);
    try {
      keepFocus = keepFocus || (document.activeElement && document.activeElement.id === 'upQuery');
    } catch (e) {
      // 非浏览器环境（测试桩）忽略
    }

    var rows = slice.map(function (r) {
      var tags = '';
      if (r.currentChannels.length) tags += '<span class="tag green">current: ' + esc(r.currentChannels.join(', ')) + '</span>';
      if (r.previousChannels.length) tags += '<span class="tag amber">previous: ' + esc(r.previousChannels.join(', ')) + '</span>';
      if (r.sameAsCurrent && !r.currentChannels.length) tags += '<span class="tag blue">与 current 同产物</span>';
      if (r.restoredFrom) tags += '<span class="tag gray">源自 ' + esc(r.restoredFrom) + '</span>';
      if (!tags) tags = '<span class="tag gray">历史</span>';
      var runInfo = runInfoFor(r);
      // current / previous 版本受服务端保护，前端只做提示；真正裁决在 gc.mjs 的保护集。
      var pinned = r.currentChannels.length || r.previousChannels.length;
      var gcDisabled = !state.adminEnabled || pinned;
      var gcTitle = pinned
        ? 'current / previous 版本受保护，不能回收'
        : (!state.adminEnabled ? '未配置管理令牌' : '回收该版本目录，不可恢复');
      return '<tr><td>' + esc(fmtTime(r.createdAt)) + '</td>'
        + '<td class="mono">' + esc(r.releaseId) + ' <button type="button" class="mini" data-copy="' + escAttr(r.releaseId) + '">复制</button></td>'
        + '<td class="mono" title="' + escAttr(r.updateId) + '">' + esc(r.updateId) + '</td>'
        + '<td>' + esc((r.platforms || []).join(', ')) + '</td>'
        + '<td>' + esc(fmtBytes(r.size))
        + (r.gzipBytes ? ' <span class="meta">+gz ' + esc(fmtBytes(r.gzipBytes)) + '</span>' : '')
        + (r.files ? ' <details><summary>' + esc(r.files) + ' 个文件</summary>' + renderReleaseFiles(r) + '</details>' : '')
        + '</td>'
        + '<td title="以此版本为目标的补丁数 / 体积">' + esc(r.patchCount || 0)
        + ' / ' + esc(fmtBytes(r.patchBytes)) + '</td>'
        + '<td>' + renderRunningCell(runInfo) + '</td>'
        + '<td>' + tags + '</td>'
        + '<td><button type="button" class="mini" data-act="gc-release" data-release="' + escAttr(r.releaseId) + '"'
        + (gcDisabled ? ' disabled' : '') + ' title="' + escAttr(gcTitle) + '">回收</button></td>'
        + '</tr>';
    }).join('');

    var channelOptions = ['<option value="">全部通道</option>'].concat(
      (state.channels || []).map(function (c) {
        return '<option value="' + escAttr(c.channel) + '"'
          + (channelFilter === c.channel ? ' selected' : '') + '>' + esc(c.channel) + '</option>';
      }),
    ).join('');
    var runOptions = [
      ['', '全部运行状态'],
      ['running', '有设备运行'],
      ['idle', '无设备运行'],
      ['current', '作为 current 运行'],
      ['previous', '作为 previous 运行'],
      ['other', '作为其他版本运行'],
    ].map(function (pair) {
      return '<option value="' + escAttr(pair[0]) + '"'
        + (runFilter === pair[0] ? ' selected' : '') + '>' + esc(pair[1]) + '</option>';
    }).join('');

    var filtering = Boolean(platform || channelFilter || runFilter || terms.length);
    var countText = filtering
      ? '筛选后 ' + list.length + ' / ' + total + ' 条'
      : '共 ' + total + ' 条';

    $('#updates').innerHTML = ''
      + '<div class="inline" style="margin-bottom:8px">'
      + '<select id="platform"><option value="">全部平台</option>'
      + PLATFORMS.map(function (p) {
        return '<option value="' + p + '"' + (platform === p ? ' selected' : '') + '>' + esc(PLATFORM_LABEL[p] || p) + '</option>';
      }).join('') + '</select>'
      + '<select id="upChannel">' + channelOptions + '</select>'
      + '<select id="upRun">' + runOptions + '</select>'
      + '<input id="upQuery" type="search" placeholder="搜索 releaseId / updateId / 通道（空格分隔多关键词）" value="' + escAttr(query) + '">'
      + '<button type="button" id="upClear"' + (filtering ? '' : ' disabled') + '>重置</button>'
      + (state.adminEnabled ? '<button type="button" id="upGcPreview" title="按保留策略预览将被回收的版本（不删除）">回收预览</button>' : '')
      + (state.adminEnabled ? '<button type="button" id="upOrphans" title="扫描没有任何版本 / 补丁 / 内置包引用的文件（只读）">孤儿体检</button>' : '')
      + '<span class="meta">' + countText + '</span></div>'
      + '<div class="table-wrap"><table><thead><tr><th>时间</th><th>releaseId</th><th>updateId</th><th>平台</th><th>大小</th><th>补丁</th><th>实际运行</th><th>状态</th><th>操作</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="9" class="empty">没有匹配的版本</td></tr>') + '</tbody></table></div>'
      + '<div class="pager">'
      + '<button type="button" id="upPrev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
      + '<span>' + page + ' / ' + pages + '</span>'
      + '<button type="button" id="upNext"' + (page >= pages ? ' disabled' : '') + '>下一页</button>'
      + '</div>';

    if (keepFocus) {
      var searchInput = $('#upQuery');
      if (searchInput && searchInput.focus) {
        searchInput.focus();
        var cursor = (searchInput.value || '').length;
        if (searchInput.setSelectionRange) {
          try { searchInput.setSelectionRange(cursor, cursor); } catch (e) { /* ignore */ }
        }
      }
    }

    $('#updatesHint').textContent =
      '共 ' + total + ' 条历史版本；支持按 releaseId / updateId / 运行通道关键字搜索，并可按通道与运行状态（current / previous / 其他）筛选；「实际运行」来自客户端最近一次上报；回收只对既非 current 也非 previous、且不在保留期内的版本生效';
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
        + '<td class="mono" title="' + escAttr(e.updateId) + '">' + esc(e.updateId) + '</td>'
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
    // 设置页不展示全局统计卡（通道数 / 历史发布数等）。
    var stats = $('#stats');
    if (stats) stats.hidden = name === 'settings';

    if (name === 'overview') {
      renderTrend();
      renderOverviewChannels();
      renderStorage();
      renderOverviewEvents();
    } else if (name === 'channels') {
      renderChannels();
    } else if (name === 'updates') {
      renderUpdates();
    } else if (name === 'metrics') {
      renderMetricsDetail();
    } else if (name === 'events') {
      renderEvents();
    } else if (name === 'settings') {
      renderSettings();
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
      openSettings(true);
      return false;
    }
    if (confirmText && !window.confirm(confirmText)) return false;

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
        // 令牌无效时直接打开设置页并聚焦，避免用户只看到一句报错。
        openSettings(true);
        throw new Error('管理令牌无效：请在「设置」中填写服务启动时的 OTA_ADMIN_TOKEN，并点「保存到本机」');
      }
      if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
      // 服务端会返回可读结果（评估结论 / 止血摘要等），优先展示它而不是笼统的成功提示。
      var output = String(json.output || '').replace(/\s+/g, ' ').trim();
      var text = json.duplicated
        ? '重复提交已忽略（60 秒内相同操作）'
        : output
          ? (output.length > 260 ? output.slice(0, 260) + '…' : output)
          : '操作成功，已刷新';
      toast(text, 'ok');
      await refresh({ silent: true });
      return true;
    } catch (err) {
      toast('操作失败：' + err.message, 'err');
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      return false;
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
    } else if (act === 'evaluate-stop-loss') {
      // 只读评估：不改状态，用于人工复核当前口径。
      postAction({
        action: 'evaluate-stop-loss',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
      }, null, btn);
    } else if (act === 'halt-channel') {
      // 人工紧急止血：与自动止损同一语义，会清空白名单与平台覆盖（可恢复）。
      postAction({
        action: 'halt-channel',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
      }, '确认对通道 ' + ch + ' 紧急止血？会把灰度降为 0%，并清空白名单与平台覆盖（原配置会快照，可恢复）。', btn);
    } else if (act === 'restore-rollout') {
      postAction({
        action: 'restore-rollout',
        channel: ch,
        runtimeVersion: state.runtimeVersion,
      }, '确认恢复通道 ' + ch + ' 暂停前的灰度、白名单与平台覆盖？', btn);
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
      if (!e.target) return;
      if (e.target.id === 'platform') view.updates.platform = e.target.value;
      else if (e.target.id === 'upChannel') view.updates.channel = e.target.value;
      else if (e.target.id === 'upRun') view.updates.run = e.target.value;
      else return;
      view.updates.page = 1;
      renderUpdates();
    });
    // 版本搜索：客户端即时过滤 releaseId / updateId，重绘后恢复焦点与光标。
    $('#updates').addEventListener('input', function (e) {
      if (!e.target || e.target.id !== 'upQuery') return;
      view.updates.query = e.target.value === undefined ? '' : e.target.value;
      view.updates.page = 1;
      renderUpdates({ keepFocus: true });
    });
    $('#updates').addEventListener('click', function (e) {
      if (e.target.id === 'upPrev') { view.updates.page -= 1; renderUpdates(); }
      if (e.target.id === 'upNext') { view.updates.page += 1; renderUpdates(); }
      if (e.target.id === 'upClear') {
        view.updates.query = '';
        view.updates.channel = '';
        view.updates.run = '';
        view.updates.platform = '';
        view.updates.page = 1;
        renderUpdates({ keepFocus: true });
      }
      // 回收预览：服务端按保护集算出保留 / 待删清单，不删除任何文件。
      if (e.target.id === 'upGcPreview') {
        postAction({
          action: 'gc-releases',
          runtimeVersion: state.runtimeVersion,
          apply: false,
        }, null, e.target);
        return;
      }
      // 孤儿体检：只读扫描，清理动作仍走命令行。
      if (e.target.id === 'upOrphans') {
        postAction({
          action: 'scan-orphans',
          runtimeVersion: state.runtimeVersion,
        }, null, e.target);
        return;
      }
      // 测试桩的 target 不一定实现 closest，这里做能力检测，行为与真实浏览器一致。
      var gcBtn = e.target && e.target.closest
        ? e.target.closest('button[data-act="gc-release"]')
        : null;
      if (gcBtn) {
        var releaseId = gcBtn.dataset.release;
        postAction({
          action: 'gc-releases',
          runtimeVersion: state.runtimeVersion,
          apply: true,
          releaseIds: [releaseId],
        }, '确认回收版本 ' + releaseId + '？目录会被删除且不可恢复；仍持有该版本 manifest 的设备将无法下载资产。', gcBtn);
      }
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

    // 管理令牌（设置页）
    var tokenInput = $('#token');
    tokenInput.value = localStorage.getItem('ota_admin_token') || '';
    $('#saveToken').addEventListener('click', function () {
      var value = tokenInput.value.trim();
      tokenInput.value = value;
      localStorage.setItem('ota_admin_token', value);
      $('#tokenHint').textContent = value ? '已保存到本机浏览器' : '令牌为空，写操作仍会失败';
      toast(value ? '令牌已保存' : '令牌为空', value ? 'ok' : 'warn');
    });

    // 设置页左侧分类切换：管理令牌 / 止损设置。
    var settingsNav = $('#settingsNav');
    if (settingsNav) {
      settingsNav.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('button[data-settings-tab]') : null;
        if (!btn) return;
        view.settings.tab = btn.dataset.settingsTab;
        renderSettings();
      });
    }

    // 止损设置（设置页）：只提交改动过的字段，避免把未填的 Webhook 覆盖掉。
    var saveStopLoss = $('#saveStopLoss');
    if (saveStopLoss) {
      saveStopLoss.addEventListener('click', async function () {
        var minInput = $('#slMinSamples');
        var webhookInput = $('#slWebhook');
        var clearInput = $('#slWebhookClear');
        var minRaw = minInput ? minInput.value.trim() : '';
        var webhookRaw = webhookInput ? webhookInput.value.trim() : '';
        var body = {
          action: 'set-stop-loss-config',
          runtimeVersion: state.runtimeVersion,
        };
        if (minRaw !== '') body.minSamples = Number(minRaw);
        if (clearInput && clearInput.checked) body.webhook = '';
        else if (webhookRaw !== '') body.webhook = webhookRaw;
        var ok = await postAction(body, null, saveStopLoss);
        saveStopLoss.disabled = false;
        saveStopLoss.textContent = '保存止损设置';
        if (ok) syncStopLossSettings(true);
      });
    }

    // 回收设置（设置页）：只提交有值的字段；切到「执行」需要二次确认。
    var saveGc = $('#saveGc');
    if (saveGc) {
      saveGc.addEventListener('click', async function () {
        var daysInput = $('#gcKeepDays');
        var lastInput = $('#gcKeepLast');
        var modeInput = $('#gcMode');
        var body = {
          action: 'set-gc-config',
          runtimeVersion: state.runtimeVersion,
        };
        if (daysInput && String(daysInput.value).trim() !== '') body.keepDays = Number(daysInput.value);
        if (lastInput && String(lastInput.value).trim() !== '') body.keepLast = Number(lastInput.value);
        if (modeInput && !modeInput.disabled) body.gcMode = modeInput.value;
        var switchingToApply = body.gcMode === 'apply' && (!state.gc || state.gc.mode !== 'apply');
        var ok = await postAction(
          body,
          switchingToApply
            ? '确认切换到「执行」模式？下一次定时回收将真实删除不在保留策略内的版本，且不可恢复。'
            : null,
          saveGc,
        );
        saveGc.disabled = false;
        saveGc.textContent = '保存回收设置';
        if (ok) syncGcSettings(true);
      });
    }

    // 首屏 hash 可能直接是 #settings，初始化时先回填一次。
    syncStopLossSettings(false);
    syncGcSettings(false);
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
