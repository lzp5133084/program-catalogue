/* 本地程序目录 · 前端交互 */
(function () {
  'use strict';

  var CATEGORIES = ['办公与文件', '直播与音视频', '桌面自动化', '财务与资产', '日历与提醒',
    '保险与理赔', 'AI与大模型', '网站与业务原型', '其他开发工具', '系统与软件'];

  var GLOSSARY = [
    ['程序入口', '能直接打开或运行的文件，例如 .exe（双击运行）、.py（Python 脚本）、.bat（批处理）、.html（网页）。看到入口，才知道这个项目从哪儿启动。'],
    ['项目目录', '一个文件夹里装着一套程序、源码或资源，就叫项目目录。本工具会把这样的文件夹找出来并登记。'],
    ['扫描快照', '每扫描一次，就像给电脑拍一张照片，记录当时的项目、入口、大小和时间。以后可以对比两张照片，看多了什么、少了什么。'],
    ['静态整理', '只读取文件名、大小、修改时间这些信息，不运行程序。所以“静态整理完成”只代表资料理清了，不代表程序功能一定正常。'],
    ['语法检查', '检查 Python 代码写得是否符合语法，解释器能不能读懂。语法通过不等于功能正常，只是少了一类明显错误。'],
    ['扫描深度', '从磁盘根目录往下找几层文件夹。层数越深越全，但扫描也更慢。一般 5～6 层够用。'],
    ['标注', '你手动修改的项目名称、分类、用途、使用方式和备注。标注单独保存，重新扫描也不会被覆盖。'],
    ['API Key', '给其他程序调用本工具数据的“钥匙”。把这个 Key 放在请求头 X-API-Key 里，就能读取目录数据。'],
    ['局域网访问', '手机和电脑连同一个 Wi-Fi 时，用电脑的局域网 IP 加端口（例如 http://192.168.1.8:8788）就能打开本工具。'],
    ['入口数', '这个项目里被识别为可运行或可打开的文件数量，不代表它们全都能正常运行。']
  ];

  var state = {
    me: null,
    meta: null,
    drives: [],
    snapshots: [],
    snapshotId: null,
    snapshot: null,
    statsData: null,
    view: 'dashboard',
    scan: null,
    scanTimer: null,
    selectedDrives: [],
    depth: 6,
    projects: { page: 1, page_size: 20, q: '', category: '', kind: '', sort: 'default', total: 0, items: [] },
    entries: { page: 1, page_size: 50, q: '', ext: '', total: 0, items: [] },
    logs: [],
    users: [],
    settings: null,
    drawerId: null,
    loading: {}
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var TITLES = {
    dashboard: ['总览', '本机程序、入口与使用说明，一处查清'],
    projects: ['项目目录', '按分类、状态与路径查找本机程序'],
    entries: ['程序入口', '所有可运行、可打开的文件索引'],
    snapshots: ['扫描快照', '每次扫描都是一张可对比的照片'],
    logs: ['操作记录', '谁在什么时候做了什么'],
    users: ['账号管理', '多人共用与权限'],
    settings: ['设置与接口', 'API Key、导出、关于']
  };

  // ------------------------------------------------------------ 基础工具
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function num(n) {
    n = Number(n) || 0;
    return n.toLocaleString('zh-CN');
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(2) + ' ' + u[i];
  }

  function shortDate(s) {
    if (!s) return '—';
    return String(s).replace(' ', ' · ');
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    var res = await fetch(path, init);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401 && path.indexOf('/api/login') === -1) {
      showLogin();
      throw new Error('登录已失效，请重新登录');
    }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || ('请求失败 ' + res.status));
    }
    return data;
  }

  var inited = false;
  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3200);
  }

  // ------------------------------------------------------------ 登录 / 启动
  function showLogin() {
    stopPolling();
    state.me = null;
    $('#shell').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#boot').classList.add('hidden');
    var p = $('#loginPass');
    if (p) p.value = '';
    setTimeout(function () { var u = $('#loginUser'); if (u) u.focus(); }, 60);
  }

  async function init() {
    if (inited) return;
    inited = true;
    bindGlobalEvents();
    try {
      var me = await api('/api/me');
      state.me = me.user;
      await enterApp();
    } catch (e) {
      showLogin();
    }
    $('#boot').classList.add('hidden');
  }

  async function enterApp() {
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    updateUserUI();
    await loadMeta();
    await loadDrives();
    await loadSnapshots();
    if (state.scan === null) {
      try {
        var s = await api('/api/scan/status');
        state.scan = s.state;
        if (state.scan.status === 'running') startPolling();
      } catch (e) { }
    }
    go('dashboard');
  }

  function updateUserUI() {
    if (!state.me) return;
    var name = state.me.display_name || state.me.username;
    $('#userName').textContent = name;
    $('#userRole').textContent = state.me.role === 'admin' ? '管理员' : '普通成员';
    $('#userAvatar').textContent = name.slice(0, 1);
    $$('.admin-only').forEach(function (el) {
      el.style.display = state.me.role === 'admin' ? '' : 'none';
    });
  }

  async function loadMeta() {
    try {
      state.meta = await api('/api/meta');
      updateMetaUI();
    } catch (e) { }
  }

  function updateMetaUI() {
    var m = state.meta;
    if (!m) return;
    $('#metaSize').textContent = m.tool_size_text;
    $('#metaSaved').textContent = m.tool_modified || '—';
    $('#sideSize').textContent = m.tool_size_text;
    $('#sideSaved').textContent = m.tool_modified || '—';
  }

  async function loadDrives() {
    try {
      var d = await api('/api/drives');
      state.drives = d.drives || [];
      if (!state.selectedDrives.length) {
        state.selectedDrives = state.drives.filter(function (x) { return x.type === 3; })
          .map(function (x) { return x.letter; });
      }
    } catch (e) { state.drives = []; }
  }

  async function loadSnapshots(preferredId) {
    try {
      var d = await api('/api/snapshots');
      state.snapshots = d.items || [];
      if (preferredId) state.snapshotId = Number(preferredId) || preferredId;
      if (!state.snapshotId && state.snapshots[0]) state.snapshotId = state.snapshots[0].id;
      state.snapshot = null;
      for (var i = 0; i < state.snapshots.length; i++) {
        if (state.snapshots[i].id === state.snapshotId) { state.snapshot = state.snapshots[i]; break; }
      }
      if (!state.snapshot && state.snapshots[0]) {
        state.snapshot = state.snapshots[0];
        state.snapshotId = state.snapshot.id;
      }
      await loadStats();
    } catch (e) { state.snapshots = []; state.snapshot = null; state.statsData = null; }
  }

  async function loadStats() {
    if (!state.snapshotId) { state.statsData = null; return; }
    try {
      state.statsData = await api('/api/stats?snapshot_id=' + state.snapshotId);
    } catch (e) { state.statsData = null; }
  }

  // ------------------------------------------------------------ 导航
  function go(view) {
    state.view = view;
    var t = TITLES[view] || TITLES.dashboard;
    $('#pageTitle').textContent = t[0];
    $('#pageSub').textContent = t[1];
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    closeSidebar();
    render();
  }

  function render() {
    var v = state.view;
    if (v === 'dashboard') return renderDashboard();
    if (v === 'projects') return renderProjects();
    if (v === 'entries') return renderEntries();
    if (v === 'snapshots') return renderSnapshots();
    if (v === 'logs') return renderLogs();
    if (v === 'users') return renderUsers();
    if (v === 'settings') return renderSettings();
    return renderDashboard();
  }

  function loadingCard(text) {
    return '<div class="card card-pad"><div class="empty"><strong>' + esc(text || '正在读取…') + '</strong><p>数据来自本机 SQLite，只需稍等片刻。</p></div></div>';
  }

  // ------------------------------------------------------------ 总览
  async function renderDashboard() {
    var view = $('#view');
    view.innerHTML = loadingCard('正在汇总本机目录…');
    var snap = state.snapshot;
    var counts = (state.statsData && state.statsData.counts) || { projects: 0, entries: 0, syntax_projects: 0, installed: 0 };
    var stats = (snap && snap.stats) || {};
    var cats = (state.statsData && state.statsData.categories) || [];
    var recent = { items: [] };
    if (state.snapshotId) {
      try {
        recent = await api('/api/projects?snapshot_id=' + state.snapshotId + '&page_size=6&sort=default');
      } catch (e) { }
    }
    if (state.view !== 'dashboard') return;

    var scanRunning = state.scan && state.scan.status === 'running';
    var lastScan = snap ? {
      name: snap.name,
      at: snap.created_at,
      drives: (snap.drives || []).join('、'),
      depth: snap.depth,
      duration: stats.duration || 0,
      files: stats.files_seen || 0,
      candidates: stats.projects || 0,
      aborted: !!stats.aborted
    } : null;

    var heroSide = '';
    if (lastScan) {
      heroSide = [
        '<div class="mini-row"><span>最新快照</span><b>' + esc(shortDate(lastScan.at)) + '</b></div>',
        '<div class="divider"></div>',
        '<div class="mini-row"><span>扫描磁盘</span><b>' + esc(lastScan.drives || '—') + '</b></div>',
        '<div class="mini-row"><span>扫描深度</span><b>' + esc(lastScan.depth) + ' 层</b></div>',
        '<div class="mini-row"><span>读取文件</span><b>' + num(lastScan.files) + '</b></div>',
        '<div class="mini-row"><span>用时</span><b>' + esc(lastScan.duration) + ' 秒</b></div>',
        '<div class="badge-line" style="margin-top:14px">' +
        '<span class="chip">' + (lastScan.aborted ? '达到上限提前结束' : '扫描完整结束') + '</span>' +
        '<span class="chip cyan">登录已启用</span><span class="chip violet">API 已预留</span></div>'
      ].join('');
    } else {
      heroSide = '<div class="mini-row"><span>还没有扫描记录</span></div>' +
        '<p style="color:var(--dim);font-size:11.5px;margin:8px 0 0">选择磁盘并开始扫描，系统会读取项目目录、程序入口与已安装软件。</p>' +
        '<div class="badge-line" style="margin-top:14px"><span class="chip cyan">数据仅保存在本机</span><span class="chip violet">预留 API</span></div>';
    }

    var html = [];
    html.push('<section class="hero">');
    html.push('<div class="card hero-main">');
    html.push('<span class="eyebrow">Local Program Catalogue</span>');
    html.push('<h2>把电脑里的程序，<em>一次找全</em></h2>');
    html.push('<p>扫描本机磁盘，自动整理项目目录、程序入口、用途与使用方式；每次扫描留下快照，随时对比新增与消失。</p>');
    html.push('<div class="hero-actions">');
    html.push('<button class="btn primary" data-action="scroll-scan"><svg class="icon"><use href="#i-play"/></svg>开始扫描本机</button>');
    html.push('<button class="btn" data-action="go-projects"><svg class="icon"><use href="#i-folder"/></svg>浏览项目目录</button>');
    html.push('<button class="btn ghost" data-open-glossary><svg class="icon"><use href="#i-help"/></svg>名词解释</button>');
    html.push('</div></div>');
    html.push('<div class="card hero-side">' + heroSide + '</div>');
    html.push('</section>');

    html.push('<div class="stats">');
    html.push(statCard('项目 / 目录', num(counts.projects), '包含已安装软件', 'i-folder'));
    html.push(statCard('程序入口', num(counts.entries), '可运行 / 可打开的文件', 'i-terminal'));
    html.push(statCard('已安装软件', num(counts.installed), '来自注册表卸载项', 'i-shield'));
    html.push(statCard('扫描文件', num(stats.files_seen || 0), '本次扫描读取的文件数', 'i-db'));
    html.push('</div>');

    html.push('<div class="dash-grid"><div class="dash-col">');
    html.push(renderScanCard(snap));
    html.push('<div class="card card-pad"><div class="section-head"><div><h3>最近项目</h3><p>按最近修改时间排序，点任意一行查看详情</p></div><div class="right"><button class="btn sm ghost" data-action="go-projects">全部项目<svg class="icon" style="width:13px;height:13px"><use href="#i-chevron"/></svg></button></div></div>');
    html.push(renderProjectTable(recent.items, false));
    html.push('</div></div>');

    html.push('<div class="dash-col">');
    html.push(renderGuide(
      '使用说明 · 三步开始',
      '<ol><li><b>选择磁盘</b>：默认勾选本地磁盘，可单选、多选或全选。</li>' +
      '<li><b>开始扫描</b>：后台读取项目和入口，进度实时显示，可随时取消。</li>' +
      '<li><b>查找与标注</b>：进入项目目录搜索，点开详情修改名称、用途和使用方式。</li></ol>' +
      '<div class="note">要点：扫描只读取文件名、大小和时间，不运行任何程序；“静态整理完成”不等于功能验收。标注会单独保存，重新扫描不会丢失。</div>',
      '可随时召唤'
    ));
    html.push('<div class="card card-pad"><div class="section-head"><div><h3>分类分布</h3><p>帮助判断这台电脑主要装了什么</p></div><div class="right"><button class="icon-btn tiny" data-action="refresh-dashboard" aria-label="刷新"><svg class="icon"><use href="#i-refresh"/></svg></button></div></div>');
    html.push(renderCategoryBars(cats));
    html.push('<div class="section-sep" style="margin:16px 0"></div>');
    html.push('<div class="setting-row"><span>数据库体积</span><b>' + esc((state.meta && state.meta.db_size_text) || '—') + '</b></div>');
    html.push('<div class="setting-row"><span>语法问题项目</span><b>' + num(counts.syntax_projects) + ' 个</b></div>');
    html.push('<div class="setting-row"><span>程序保存时间</span><b>' + esc((state.meta && state.meta.tool_modified) || '—') + '</b></div>');
    html.push('</div></div>');
    html.push('</div>');
    view.innerHTML = html.join('');
    applyScanState();
  }

  function renderGuide(title, bodyHtml, chip) {
    return '<div class="guide">' +
      '<div class="guide-head"><svg class="icon"><use href="#i-help"/></svg><strong>' + esc(title) + '</strong>' +
      (chip ? '<span class="g-chip">' + esc(chip) + '</span>' : '') + '</div>' +
      bodyHtml + '</div>';
  }

  function statCard(label, value, sub, icon) {
    return '<div class="card stat"><div class="stat-top"><span>' + esc(label) + '</span>' +
      '<span class="stat-ico"><svg class="icon"><use href="#' + icon + '"/></svg></span></div>' +
      '<div class="stat-num">' + value + '</div><div class="stat-sub">' + esc(sub) + '</div></div>';
  }

  function renderCategoryBars(cats) {
    if (!cats || !cats.length) {
      return '<div class="empty" style="padding:24px 10px"><strong>暂无分类数据</strong><p>完成一次扫描后，这里会显示项目分类分布。</p></div>';
    }
    var max = 1;
    cats.forEach(function (c) { if (c.count > max) max = c.count; });
    return '<div class="cat-list">' + cats.map(function (c) {
      var pct = Math.max(4, Math.round(c.count / max * 100));
      return '<div class="cat-row"><span class="cat-name" title="' + esc(c.name) + '">' + esc(c.name) + '</span>' +
        '<span class="cat-track"><i style="width:' + pct + '%"></i></span><b>' + num(c.count) + '</b></div>';
    }).join('') + '</div>';
  }

  function renderScanCard(snap) {
    var running = state.scan && state.scan.status === 'running';
    var h = [];
    h.push('<div class="card card-pad" id="scanCard"><div class="section-head"><div><span class="eyebrow">Scan</span><h3>扫描本机磁盘</h3><p>选择磁盘与深度，后台读取项目目录、程序入口和已安装软件</p></div>' +
      '<div class="right"><button class="btn sm ghost" data-action="refresh-drives"><svg class="icon" style="width:13px;height:13px"><use href="#i-refresh"/></svg>刷新磁盘</button></div></div>');
    h.push('<div class="scan-grid"><div>');
    h.push('<div class="drive-list">');
    if (!state.drives.length) {
      h.push('<div class="empty" style="padding:14px"><strong>未读取到磁盘</strong><p>请点击右上角刷新磁盘。</p></div>');
    }
    state.drives.forEach(function (d) {
      var on = state.selectedDrives.indexOf(d.letter) !== -1;
      h.push('<div class="drive-chip' + (on ? ' on' : '') + '" data-action="toggle-drive" data-letter="' + esc(d.letter) + '">' +
        '<span class="drive-letter">' + esc(d.letter) + '</span>' +
        '<span class="drive-info"><strong>' + esc(d.label || (d.type_name + ' ' + d.letter + ':')) + '</strong>' +
        '<span>' + esc(d.type_name) + ' · 可用 ' + esc(d.free_text) + '</span></span>' +
        '<svg class="icon tick"><use href="#i-shield"/></svg></div>');
    });
    h.push('</div>');
    h.push('<div class="scan-opts"><button class="btn sm ghost" data-action="drive-all">全选</button>' +
      '<button class="btn sm ghost" data-action="drive-none">清空</button>' +
      '<label>扫描深度 <select class="select" id="depthSel">' +
      [3, 4, 5, 6, 7, 8].map(function (n) {
        return '<option value="' + n + '"' + (state.depth === n ? ' selected' : '') + '>' + n + ' 层</option>';
      }).join('') + '</select></label></div>');
    h.push('</div>');
    h.push('<div><div class="setting-row" style="padding-top:0"><span>已选磁盘</span><b>' + (state.selectedDrives.length ? esc(state.selectedDrives.join('、')) : '未选择') + '</b></div>');
    h.push('<div class="setting-row"><span>上次扫描</span><b>' + (snap ? esc(snap.created_at) : '无记录') + '</b></div>');
    h.push('<div class="setting-row"><span>扫描方式</span><b>后台线程 · 可取消</b></div>');
    h.push('<p style="font-size:11px;color:var(--dim);line-height:1.7;margin:8px 0 0">扫描期间不运行任何程序，只读取文件信息。磁盘很大时可能需要几分钟，达到时间/文件上限会自动收尾，并标注“提前结束”。</p></div>');
    h.push('</div>');
    h.push('<div class="scan-actions">' +
      '<button class="btn primary" id="startScanBtn" data-action="start-scan"' + (running ? ' disabled' : '') + '>' +
      '<svg class="icon"><use href="#i-play"/></svg>' + (running ? '正在扫描…' : '开始扫描') + '</button>' +
      '<button class="btn danger' + (running ? '' : ' hidden') + '" id="cancelScanBtn" data-action="cancel-scan"><svg class="icon"><use href="#i-stop"/></svg>取消扫描</button>' +
      '<span style="font-size:11px;color:var(--dim);align-self:center">数据仅存本机 · 最多保留全部快照</span></div>');
    h.push('<div class="progress-wrap" id="scanProgress"><div class="progress-top"><span id="scanPhase">准备中…</span><b id="scanElapsed">0s</b></div>' +
      '<div class="progress-bar"><i id="scanBar"></i></div>' +
      '<div class="progress-stats"><span>文件 <b id="scanFiles">0</b></span><span>目录 <b id="scanDirs">0</b></span>' +
      '<span>候选项目 <b id="scanCands">0</b></span><span>入口 <b id="scanEntries">0</b></span></div>' +
      '<div style="font-size:10.5px;color:var(--dim);margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="scanCurrent"></div>' +
      '<div class="scan-live" id="scanLog"></div></div>');
    h.push('</div>');
    return h.join('');
  }

  function applyScanState() {
    var st = state.scan;
    if (!st) return;
    var wrap = $('#scanProgress');
    if (!wrap) return;
    var running = st.status === 'running';
    wrap.classList.toggle('on', running);
    var phase = $('#scanPhase');
    if (phase) {
      var label = st.phase || '准备中…';
      if (st.status === 'done') label = '扫描完成 · 已生成快照';
      if (st.status === 'cancelled') label = '扫描已取消（未写入快照）';
      if (st.status === 'error') label = '扫描失败：' + (st.error || '未知错误');
      phase.textContent = label;
    }
    var el = $('#scanElapsed'); if (el) el.textContent = (st.elapsed || 0) + 's';
    var f = $('#scanFiles'); if (f) f.textContent = num(st.files_seen);
    var d = $('#scanDirs'); if (d) d.textContent = num(st.dirs_seen);
    var c = $('#scanCands'); if (c) c.textContent = num(st.candidates);
    var en = $('#scanEntries'); if (en) en.textContent = num(st.entries);
    var cur = $('#scanCurrent'); if (cur) cur.textContent = st.current || '';
    var logBox = $('#scanLog');
    if (logBox) {
      var lines = st.logs || [];
      logBox.innerHTML = lines.length ? lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('') :
        '<div>等待扫描进程输出…</div>';
      logBox.scrollTop = logBox.scrollHeight;
    }
    var startBtn = $('#startScanBtn');
    if (startBtn) {
      startBtn.disabled = running;
      startBtn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>' + (running ? '正在扫描…' : '开始扫描');
    }
    var cancelBtn = $('#cancelScanBtn');
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !running);
  }

  // ------------------------------------------------------------ 项目表
  function kindChip(p) {
    if (p.kind && p.kind.indexOf('installed') !== -1) {
      return '<span class="chip cyan"><span class="dot"></span>' + (p.kind === 'installed+project' ? '软件+项目' : '已安装软件') + '</span>';
    }
    return '<span class="chip"><span class="dot"></span>项目目录</span>';
  }

  function statusCell(p) {
    var s = p.status || '—';
    var cls = '';
    if (s.indexOf('语法错误') !== -1) cls = 'bad';
    else if (s.indexOf('待验收') !== -1) cls = 'warn';
    return '<div class="cell-status">' + (cls ? '<span class="' + cls + '">' + esc(s) + '</span>' : esc(s)) + '</div>';
  }

  function renderProjectTable(items, withIndex, startIndex) {
    if (!items || !items.length) {
      return '<div class="empty"><svg class="icon"><use href="#i-folder"/></svg><strong>这里还没有项目</strong><p>选择磁盘并开始扫描；如果已经扫描过，试试调整搜索词或分类筛选。</p></div>';
    }
    var h = [];
    h.push('<div class="table-wrap"><table class="table table-cards"><thead><tr>' +
      '<th style="width:74px">顺序 / 时间</th><th>项目与用途</th><th style="width:112px">分类</th>' +
      '<th>使用与状态</th><th>路径 / 工具</th><th style="width:62px">详情</th></tr></thead><tbody>');
    items.forEach(function (p, i) {
      var idx = withIndex ? (startIndex || 0) + i + 1 : i + 1;
      var idLabel = (p.kind && p.kind.indexOf('installed') !== -1) ? 'SW' : 'PJ';
      h.push('<tr class="clickable" data-action="open-project" data-id="' + p.id + '">');
      h.push('<td class="cell-idx" data-label="序号"><div>' + idx + ' · ' + idLabel + String(idx).padStart(3, '0') + '</div><div style="font-size:10px;color:var(--dim)">' + esc((p.modified_at || p.install_date || '—').slice(0, 10)) + '</div></td>');
      h.push('<td class="cell-name" data-label="项目"><strong>' + esc(p.display_name) + (p.favorite ? '<span class="star-mark"><svg class="icon"><use href="#i-star"/></svg></span>' : '') + '</strong>' +
        '<small>' + esc(p.display_purpose || '') + '</small></td>');
      h.push('<td data-label="分类"><div style="display:flex;flex-direction:column;gap:4px"><span class="chip">' + esc(p.display_category || '未分类') + '</span>' +
        '<span style="font-size:9.5px;color:var(--dim)">' + ((p.kind && p.kind.indexOf('installed') !== -1) ? '已安装软件' : '项目目录') + '</span></div></td>');
      h.push('<td class="cell-usage" data-label="使用"><div style="margin-bottom:4px;color:#cfd8e6">' + esc((p.display_usage || '').slice(0, 90)) + ((p.display_usage || '').length > 90 ? '…' : '') + '</div>' + statusCell(p) + '</td>');
      h.push('<td class="cell-path" data-label="路径"><code>' + esc(p.path || '（注册表未提供安装路径）') + '</code>' +
        '<span class="path-meta">' + esc(p.extensions || '') + (p.entry_count ? ' · ' + p.entry_count + ' 个入口' : '') + (p.size_bytes ? ' · ' + bytes(p.size_bytes) : '') + '</span></td>');
      h.push('<td data-label="详情"><span class="row-btn">查看<svg class="icon"><use href="#i-chevron"/></svg></span></td>');
      h.push('</tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  function pagerHTML(page, total, size, list) {
    var pages = Math.max(1, Math.ceil(total / size));
    var start = Math.max(1, page - 2);
    var end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    var h = ['<div class="pager"><span class="info">共 <b>' + num(total) + '</b> 条 · 第 ' + page + ' / ' + pages + ' 页</span>'];
    h.push('<button data-action="page" data-list="' + list + '" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>');
    for (var i = start; i <= end; i++) {
      h.push('<button data-action="page" data-list="' + list + '" data-page="' + i + '"' + (i === page ? ' class="on"' : '') + '>' + i + '</button>');
    }
    h.push('<button data-action="page" data-list="' + list + '" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button></div>');
    return h.join('');
  }

  // ------------------------------------------------------------ 项目目录
  async function renderProjects() {
    var view = $('#view');
    view.innerHTML = '<div class="card card-pad"><div class="toolbar">' +
      '<div class="search"><svg class="icon"><use href="#i-search"/></svg><input id="projectSearch" placeholder="搜索名称、用途、路径或标签…" value="' + esc(state.projects.q) + '"></div>' +
      '<select class="select" id="projectCategory"><option value="">全部分类</option>' + CATEGORIES.map(function (c) {
        return '<option value="' + esc(c) + '"' + (state.projects.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select>' +
      '<select class="select" id="projectKind"><option value="">全部类型</option>' +
      '<option value="project"' + (state.projects.kind === 'project' ? ' selected' : '') + '>项目目录</option>' +
      '<option value="installed"' + (state.projects.kind === 'installed' ? ' selected' : '') + '>已安装软件</option></select>' +
      '<select class="select" id="projectSort"><option value="default">按最新修改</option>' +
      '<option value="size"' + (state.projects.sort === 'size' ? ' selected' : '') + '>按体积</option>' +
      '<option value="name"' + (state.projects.sort === 'name' ? ' selected' : '') + '>按名称</option>' +
      '<option value="time"' + (state.projects.sort === 'time' ? ' selected' : '') + '>按时间</option></select>' +
      '<span class="grow"></span><span class="filter-note">快照：<b>' + (state.snapshot ? esc(shortDate(state.snapshot.created_at)) : '无') + '</b></span></div>' +
      '<div class="section-head" style="margin-bottom:12px"><div><h3>项目与目录</h3><p>点任意一行打开详情，可修改名称、分类、用途和使用方式</p></div>' +
      '<div class="right">' +
      '<a class="btn sm" href="/api/export?format=csv&snapshot_id=' + (state.snapshotId || '') + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-download"/></svg>导出 CSV</a>' +
      '<a class="btn sm" href="/api/export?format=json&snapshot_id=' + (state.snapshotId || '') + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-download"/></svg>导出 JSON</a>' +
      '</div></div>' +
      '<div id="projectListWrap"></div><div id="projectPager"></div></div>' +
      renderGuide('操作指引 · 项目目录',
        '<ul><li><b>搜索</b>：输入项目名、用途关键词或路径片段，列表实时过滤。</li>' +
        '<li><b>筛选</b>：分类、类型、排序可组合使用；导出按钮可把当前快照导出为表格。</li>' +
        '<li><b>详情</b>：点开行后可复制路径、在资源管理器定位，并保存你自己的标注。</li></ul>' +
        '<div class="note">标注按“完整路径”保存，同一个目录重新扫描后仍会自动套用；换路径或改文件夹名后会视为新项目。</div>',
        '关键处看这里');
    await refreshProjects();
  }

  async function refreshProjects() {
    var wrap = $('#projectListWrap');
    if (!wrap) return;
    if (!state.snapshotId) {
      wrap.innerHTML = '<div class="empty"><svg class="icon"><use href="#i-folder"/></svg><strong>还没有扫描结果</strong><p>先回到总览页选择磁盘并扫描，这里才会出现项目目录。</p></div>';
      var pg = $('#projectPager'); if (pg) pg.innerHTML = '';
      return;
    }
    wrap.innerHTML = '<div class="empty"><strong>正在读取项目…</strong></div>';
    var p = state.projects;
    var qs = new URLSearchParams({
      snapshot_id: state.snapshotId, page: p.page, page_size: p.page_size,
      q: p.q, category: p.category, kind: p.kind, sort: p.sort
    });
    try {
      var d = await api('/api/projects?' + qs.toString());
      if (state.view !== 'projects') return;
      p.total = d.total; p.items = d.items;
      wrap.innerHTML = renderProjectTable(d.items, true, (p.page - 1) * p.page_size);
      var pg = $('#projectPager');
      if (pg) pg.innerHTML = pagerHTML(p.page, d.total, p.page_size, 'projects');
    } catch (e) {
      wrap.innerHTML = '<div class="empty"><strong>读取失败</strong><p>' + esc(e.message) + '</p></div>';
    }
  }

  // ------------------------------------------------------------ 程序入口
  async function renderEntries() {
    var view = $('#view');
    view.innerHTML = '<div class="card card-pad"><div class="toolbar">' +
      '<div class="search"><svg class="icon"><use href="#i-search"/></svg><input id="entrySearch" placeholder="搜索入口文件名或路径…" value="' + esc(state.entries.q) + '"></div>' +
      '<select class="select" id="entryExt"><option value="">全部类型</option>' +
      ['exe', 'py', 'pyw', 'bat', 'cmd', 'ps1', 'html', 'js', 'tsx', 'vue', 'jar', 'apk', 'sln'].map(function (x) {
        return '<option value="' + x + '"' + (state.entries.ext === x ? ' selected' : '') + '>' + x.toUpperCase() + '</option>';
      }).join('') + '</select>' +
      '<select class="select" id="entryPageSize"><option value="50">每页 50 条</option>' +
      '<option value="100"' + (state.entries.page_size === 100 ? ' selected' : '') + '>每页 100 条</option>' +
      '<option value="200"' + (state.entries.page_size === 200 ? ' selected' : '') + '>每页 200 条</option></select>' +
      '<span class="grow"></span><span class="filter-note">快照：<b>' + (state.snapshot ? esc(shortDate(state.snapshot.created_at)) : '无') + '</b></span></div>' +
      '<div class="section-head" style="margin-bottom:12px"><div><h3>程序与脚本入口</h3><p>双击入口前请先看清文件类型与所属项目，避免误运行</p></div></div>' +
      '<div id="entryListWrap"></div><div id="entryPager"></div></div>' +
      renderGuide('操作指引 · 程序入口',
        '<ul><li><b>按类型筛选</b>：只想找可执行程序就选 EXE，只想找源码入口就选 PY。</li>' +
        '<li><b>看所属项目</b>：同一个文件名可能出现在多个项目里，路径与所属项目是判断依据。</li>' +
        '<li><b>安全提示</b>：本工具只列出入口，不会运行它们；确认来源可信后再自行双击。</li></ul>' +
        '<div class="note">入口数多不代表都能正常运行；“运行待验收”表示还没有实际启动验证过。</div>',
        '安全优先');
    await refreshEntries();
  }

  async function refreshEntries() {
    var wrap = $('#entryListWrap');
    if (!wrap) return;
    if (!state.snapshotId) {
      wrap.innerHTML = '<div class="empty"><svg class="icon"><use href="#i-terminal"/></svg><strong>还没有入口记录</strong><p>先完成一次磁盘扫描，这里会列出所有被识别为程序入口的文件。</p></div>';
      $('#entryPager').innerHTML = '';
      return;
    }
    wrap.innerHTML = '<div class="empty"><strong>正在读取入口…</strong></div>';
    var p = state.entries;
    var qs = new URLSearchParams({
      snapshot_id: state.snapshotId, page: p.page, page_size: p.page_size,
      q: p.q, ext: p.ext
    });
    try {
      var d = await api('/api/entries?' + qs.toString());
      if (state.view !== 'entries') return;
      p.total = d.total; p.items = d.items;
      if (!d.items.length) {
        wrap.innerHTML = '<div class="empty"><svg class="icon"><use href="#i-terminal"/></svg><strong>没有匹配的入口</strong><p>试试清空搜索词或换一个文件类型。</p></div>';
      } else {
        var h = ['<div class="table-wrap"><table class="table table-cards"><thead><tr><th style="width:44px">#</th><th>文件</th><th style="width:74px">类型</th><th style="width:92px">大小</th><th style="width:150px">修改时间</th><th>所属项目</th><th>路径</th></tr></thead><tbody>'];
        d.items.forEach(function (e, i) {
          h.push('<tr class="clickable" data-action="open-entry" data-id="' + e.project_id + '">' +
            '<td class="cell-idx" data-label="#">' + ((p.page - 1) * p.page_size + i + 1) + '</td>' +
            '<td class="cell-name" data-label="文件"><strong>' + esc(e.name) + '</strong></td>' +
            '<td data-label="类型"><span class="chip gray">' + esc((e.ext || '').toUpperCase()) + '</span></td>' +
            '<td data-label="大小" style="font-size:11px;color:var(--muted)">' + bytes(e.size_bytes) + '</td>' +
            '<td data-label="修改" style="font-size:11px;color:var(--dim)">' + esc(e.modified_at || '—') + '</td>' +
            '<td data-label="项目" style="font-size:11.5px;color:var(--muted);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.project_name || '—') + '</td>' +
            '<td class="cell-path" data-label="路径"><code>' + esc(e.path) + '</code></td></tr>');
        });
        h.push('</tbody></table></div>');
        wrap.innerHTML = h.join('');
      }
      $('#entryPager').innerHTML = pagerHTML(p.page, d.total, p.page_size, 'entries');
    } catch (e) {
      wrap.innerHTML = '<div class="empty"><strong>读取失败</strong><p>' + esc(e.message) + '</p></div>';
    }
  }

  // ------------------------------------------------------------ 快照
  async function renderSnapshots() {
    var view = $('#view');
    view.innerHTML = loadingCard('正在读取扫描记录…');
    try { await loadSnapshots(); } catch (e) { }
    if (state.view !== 'snapshots') return;
    var h = [];
    h.push('<div class="card card-pad"><div class="section-head"><div><h3>扫描快照</h3><p>共 ' + state.snapshots.length + ' 份记录，可查看、对比或删除</p></div>' +
      '<div class="right"><button class="btn sm ghost" data-action="refresh-snapshots"><svg class="icon" style="width:13px;height:13px"><use href="#i-refresh"/></svg>刷新</button>' +
      '<button class="btn sm primary" data-action="go-dashboard"><svg class="icon" style="width:13px;height:13px"><use href="#i-play"/></svg>去扫描</button></div></div>');
    h.push(renderGuide('使用说明 · 快照怎么用',
      '<ul><li><b>查看</b>：切到某份快照，项目目录与入口列表都会按那份记录展示。</li>' +
      '<li><b>对比</b>：系统会找出“这份新增了什么、相比上一份少了什么”，适合核对是否误删。</li>' +
      '<li><b>删除</b>：只删除记录，不会删除磁盘上的任何文件。</li></ul>' +
      '<div class="note">建议每次大改动前扫描一次，形成可回看的版本线。</div>', '像照片一样回看'));
    if (!state.snapshots.length) {
      h.push('<div class="empty" style="padding:30px"><svg class="icon"><use href="#i-camera"/></svg><strong>还没有快照</strong><p>回到总览选择磁盘扫描，第一份快照会自动生成。</p></div>');
    } else {
      h.push('<div class="snap-grid">');
      state.snapshots.forEach(function (s, i) {
        var st = s.stats || {};
        var current = s.id === state.snapshotId;
        h.push('<div class="card snap-card' + (current ? ' ' : '') + '">');
        h.push('<div class="snap-top"><span class="snap-ico"><svg class="icon"><use href="#i-camera"/></svg></span>' +
          (current ? '<span class="chip">当前查看</span>' : '<span class="chip gray">历史记录</span>') +
          (i === 0 ? '<span class="chip cyan">最新</span>' : '') + '</div>');
        h.push('<h3>' + esc(s.name || ('快照 #' + s.id)) + '</h3>');
        h.push('<div class="snap-time">' + esc(s.created_at) + ' · 深度 ' + esc(s.depth) + ' 层 · 磁盘 ' + esc((s.drives || []).join('、')) + '</div>');
        h.push('<div class="snap-stats"><div><b>' + num(st.total_projects || st.projects || 0) + '</b><span>项目</span></div>' +
          '<div><b>' + num(st.entry_total || 0) + '</b><span>入口</span></div>' +
          '<div><b>' + num(st.files_seen || 0) + '</b><span>文件</span></div></div>');
        h.push('<div class="snap-actions">' +
          '<button class="btn sm primary" data-action="view-snapshot" data-id="' + s.id + '">查看</button>' +
          '<button class="btn sm" data-action="compare-snapshot" data-id="' + s.id + '">与上一份对比</button>' +
          '<a class="btn sm ghost" href="/api/export?format=csv&snapshot_id=' + s.id + '">导出</a>' +
          '<button class="btn sm danger" data-action="delete-snapshot" data-id="' + s.id + '">删除</button></div>');
        if (st.aborted) h.push('<div style="font-size:10.5px;color:#ffcf8a;margin-top:8px">该次扫描达到上限提前结束，结果可能不完整。</div>');
        h.push('</div>');
      });
      h.push('</div>');
    }
    h.push('</div>');
    view.innerHTML = h.join('');
  }

  // ------------------------------------------------------------ 操作记录
  async function renderLogs() {
    var view = $('#view');
    view.innerHTML = loadingCard('正在读取操作记录…');
    try { state.logs = (await api('/api/logs?limit=120')).items || []; } catch (e) { state.logs = []; }
    if (state.view !== 'logs') return;
    var h = ['<div class="card card-pad"><div class="section-head"><div><h3>最近操作</h3><p>扫描、登录、标注、账号与快照操作都会留痕</p></div>' +
      '<div class="right"><button class="btn sm ghost" data-action="refresh-logs"><svg class="icon" style="width:13px;height:13px"><use href="#i-refresh"/></svg>刷新</button></div></div>'];
    if (!state.logs.length) {
      h.push('<div class="empty"><svg class="icon"><use href="#i-history"/></svg><strong>还没有操作记录</strong><p>登录、扫描或保存标注后，这里会自动记录。</p></div>');
    } else {
      h.push('<div class="table-wrap"><table class="table table-cards log-table"><thead><tr><th style="width:150px">时间</th><th style="width:110px">操作人</th><th style="width:110px">动作</th><th>详情</th></tr></thead><tbody>');
      var labels = { scan: '扫描完成', scan_start: '开始扫描', scan_cancel: '取消扫描', login: '登录', logout: '退出',
        annotation_save: '保存标注', annotation_delete: '清除标注', snapshot_delete: '删除快照',
        user_add: '新增账号', user_update: '修改账号', user_delete: '删除账号', password: '修改密码',
        api_key: 'API Key', reveal: '打开位置' };
      state.logs.forEach(function (l) {
        h.push('<tr><td data-label="时间" style="font-size:11px;color:var(--dim)">' + esc(l.at) + '</td>' +
          '<td data-label="操作人" style="font-size:11.5px">' + esc(l.username === 'system' ? '系统' : l.username) + '</td>' +
          '<td data-label="动作"><span class="log-action ' + esc(l.action) + '">' + esc(labels[l.action] || l.action) + '</span></td>' +
          '<td data-label="详情" style="font-size:11.5px;color:var(--muted);word-break:break-all">' + esc(l.detail) + '</td></tr>');
      });
      h.push('</tbody></table></div>');
    }
    h.push('</div>');
    h.push(renderGuide('使用说明 · 操作留痕',
      '<ul><li><b>系统</b>会在扫描完成、登录、标注、账号变更时自动记录，不需要手动维护。</li>' +
      '<li><b>排查</b>：如果不确定谁改过标注或删过快照，先来这里看时间和操作人。</li>' +
      '<li><b>隐私</b>：记录只保存在本机数据库，不会上传到任何服务器。</li></ul>' +
      '<div class="note">最多显示最近 120 条；更早的记录仍保存在数据库里，需要时可通过接口读取。</div>', '可追溯'));
    view.innerHTML = h.join('');
  }
  async function renderUsers() {
    if (!state.me || state.me.role !== 'admin') {
      $('#view').innerHTML = '<div class="card card-pad"><div class="empty"><strong>仅管理员可访问</strong><p>请使用管理员账号登录。</p></div></div>';
      return;
    }
    var view = $('#view');
    view.innerHTML = loadingCard('正在读取账号…');
    try { state.users = (await api('/api/users')).items || []; } catch (e) { state.users = []; }
    if (state.view !== 'users') return;
    var h = [];
    h.push('<div class="card card-pad"><div class="section-head"><div><h3>账号与权限</h3><p>多人共用时，每个人使用自己的账号登录，目录数据共享</p></div>' +
      '<div class="right"><button class="btn sm primary" data-action="add-user"><svg class="icon" style="width:13px;height:13px"><use href="#i-plus"/></svg>新增账号</button></div></div>');
    h.push('<div class="table-wrap"><table class="table user-table"><thead><tr><th style="width:44px">#</th><th>账号</th><th style="width:100px">角色</th><th style="width:84px">状态</th><th style="width:150px">最近登录</th><th style="width:160px">操作</th></tr></thead><tbody>');
    state.users.forEach(function (u, i) {
      h.push('<tr><td class="cell-idx" style="color:var(--dim)">' + (i + 1) + '</td>' +
        '<td><div class="user-cell"><span class="avatar-s">' + esc((u.display_name || u.username).slice(0, 1)) + '</span>' +
        '<div style="display:flex;flex-direction:column;line-height:1.35"><strong style="font-size:12.5px">' + esc(u.display_name || '未命名') + '</strong>' +
        '<span style="font-size:10.5px;color:var(--dim)">' + esc(u.username) + '</span></div></div></td>' +
        '<td><span class="chip ' + (u.role === 'admin' ? '' : 'gray') + '">' + (u.role === 'admin' ? '管理员' : '普通成员') + '</span></td>' +
        '<td><span class="chip ' + (u.active ? 'cyan' : 'danger') + '">' + (u.active ? '启用' : '停用') + '</span></td>' +
        '<td style="font-size:11px;color:var(--dim)">' + esc(u.last_login || '—') + '</td>' +
        '<td><div style="display:flex;gap:6px"><button class="btn sm" data-action="edit-user" data-id="' + u.id + '">修改</button>' +
        (state.me && u.id === state.me.id
          ? '<button class="btn sm danger" disabled title="不能删除当前登录账号">删除</button>'
          : '<button class="btn sm danger" data-action="delete-user" data-id="' + u.id + '">删除</button>') + '</div></td></tr>');
    });
    h.push('</tbody></table></div></div>');
    h.push(renderGuide('使用说明 · 多人共用',
      '<ul><li><b>管理员</b>可新增、停用、重置密码；普通成员只能查看和标注目录。</li>' +
      '<li><b>权限</b>：扫描、标注、导出对所有登录用户开放；账号管理与 API Key 仅管理员可见。</li>' +
      '<li><b>安全</b>：密码使用 PBKDF2 加盐存储；连续输错 8 次会锁定 5 分钟。</li></ul>' +
      '<div class="note">默认管理员账号由部署者保管；建议首次登录后在“设置与接口”里修改自己的密码。</div>', '管理员必读'));
    view.innerHTML = h.join('');
  }

  // ------------------------------------------------------------ 设置
  async function renderSettings() {
    var view = $('#view');
    view.innerHTML = loadingCard('正在读取设置…');
    state.settings = null;
    if (state.me && state.me.role === 'admin') {
      try { state.settings = await api('/api/settings'); } catch (e) { }
    }
    if (state.view !== 'settings') return;
    var m = state.meta || {};
    var isAdmin = state.me && state.me.role === 'admin';
    var h = [];
    h.push('<div class="settings-grid"><div class="dash-col">');
    h.push('<div class="card card-pad"><div class="section-head"><div><h3>程序与作者</h3><p>本工具的体积、保存时间与归属信息</p></div><div class="right"><button class="icon-btn tiny" data-open-glossary aria-label="名词解释"><svg class="icon"><use href="#i-help"/></svg></button></div></div>');
    h.push('<div class="about-box"><div class="brand-mark">目</div><div><strong>本地程序目录 v' + esc(m.version || '1.0.0') + '</strong>' +
      '<span>作者：军哥懂保 · 微信：xunijiayuan</span><span>界面与功能持续检查中，商用级三端自适应</span></div></div>');
    h.push('<div class="setting-row"><span>程序体积</span><b>' + esc(m.tool_size_text || '—') + '</b></div>');
    h.push('<div class="setting-row"><span>上次保存</span><b>' + esc(m.tool_modified || '—') + '</b></div>');
    h.push('<div class="setting-row"><span>数据库体积</span><b>' + esc(m.db_size_text || '—') + '</b></div>');
    h.push('<div class="setting-row"><span>当前快照</span><b>' + (state.snapshot ? esc(state.snapshot.name) : '无') + '</b></div>');
    h.push('<div class="setting-row"><span>运行方式</span><b>本地 Python 服务 · 三端自适应</b></div>');
    h.push('<div class="setting-row"><span>数据位置</span><b>程序目录 data/catalogue.db</b></div>');
    h.push('<div class="form-actions" style="margin-top:14px"><a class="btn sm" href="/api/export?format=csv&snapshot_id=' + (state.snapshotId || '') + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-download"/></svg>导出当前快照 CSV</a>' +
      '<button class="btn sm ghost" data-open-glossary>查看名词解释</button></div></div>');
    h.push('<div class="card card-pad"><div class="section-head"><div><h3>修改我的密码</h3><p>建议首次登录后立即修改</p></div></div>' +
      '<form id="pwdForm" class="form-grid"><label class="field"><span>原密码</span><input id="pwdOld" type="password" required></label>' +
      '<label class="field"><span>新密码（至少6位）</span><input id="pwdNew" type="password" minlength="6" required></label>' +
      '<div class="form-actions wide"><button class="btn primary" type="submit">保存新密码</button></div></form></div>');
    h.push('</div><div class="dash-col">');
    if (isAdmin) {
      h.push('<div class="card card-pad"><div class="section-head"><div><h3>外部调用 API</h3><p>把 Key 放在请求头 X-API-Key，供其他程序读取目录数据</p></div>' +
        '<div class="right"><button class="btn sm ghost" data-action="regen-key"><svg class="icon" style="width:13px;height:13px"><use href="#i-refresh"/></svg>重新生成</button></div></div>');
      h.push('<div class="api-key"><code id="apiKeyText">' + esc((state.settings && state.settings.api_key) || '—') + '</code>' +
        '<button class="icon-btn tiny" data-action="copy-key" aria-label="复制"><svg class="icon"><use href="#i-copy"/></svg></button></div>');
      h.push('<div class="docs">');
      var docs = (state.settings && state.settings.docs) || {};
      Object.keys(docs).forEach(function (group) {
        if (typeof docs[group] === 'string') {
          h.push('<div class="doc-row"><code>说明</code><span>' + esc(docs[group]) + '</span></div>');
          return;
        }
        Object.keys(docs[group]).forEach(function (k) {
          h.push('<div class="doc-row"><code>' + esc(k) + '</code><span>' + esc(docs[group][k]) + '</span></div>');
        });
      });
      h.push('</div>');
      h.push('<div class="note-line" style="font-size:11px;color:var(--dim);margin-top:12px;line-height:1.7">示例：GET /api/projects?page=1&page_size=20，请求头加 <code style="color:var(--cyan)">X-API-Key: 你的Key</code>。重新生成后旧 Key 立即失效。</div></div>');
    } else {
      h.push('<div class="card card-pad"><div class="section-head"><div><h3>外部调用 API</h3><p>API Key 仅管理员可见</p></div></div>' +
        '<div class="empty" style="padding:20px"><strong>当前为普通成员</strong><p>如需对接其他程序，请联系管理员获取 API Key。</p></div></div>');
    }
    h.push(renderGuide('操作指引 · 设置与接口',
      '<ul><li><b>导出</b>：CSV 适合用 Excel 打开，JSON 适合给程序继续处理。</li>' +
      '<li><b>API</b>：只读接口覆盖项目、入口、统计、快照与导出；写入接口需要浏览器登录。</li>' +
      '<li><b>安全</b>：Key 相当于钥匙，不要发到公开群或截图外传；怀疑泄露就重新生成。</li></ul>' +
      '<div class="note">本工具没有云端服务，数据保存在本机 data 目录；换电脑时连同目录一起复制即可。</div>', '对接与备份'));
    h.push('</div></div>');
    view.innerHTML = h.join('');
  }

  // ------------------------------------------------------------ 详情抽屉
  async function openProject(id) {
    if (!id) return;
    state.drawerId = id;
    $('#drawerTitle').textContent = '读取中…';
    $('#drawerBody').innerHTML = '<div class="empty"><strong>正在读取项目详情…</strong></div>';
    $('#drawerMask').classList.remove('hidden');
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    try {
      var d = await api('/api/projects/' + id);
      if (state.drawerId !== id) return;
      renderDrawer(d.project, d.entries || [], d.annotation);
    } catch (e) {
      $('#drawerBody').innerHTML = '<div class="empty"><strong>读取失败</strong><p>' + esc(e.message) + '</p></div>';
    }
  }

  function renderDrawer(p, entries, ann) {
    ann = ann || {};
    var title = p.display_name || p.name;
    $('#drawerTitle').textContent = title;
    var isInstalled = p.kind && p.kind.indexOf('installed') !== -1;
    var h = [];
    h.push('<div style="display:flex;gap:6px;flex-wrap:wrap">' + kindChip(p) +
      '<span class="chip gray">' + esc(p.display_category || '未分类') + '</span>' +
      (p.favorite ? '<span class="chip"><svg class="icon" style="width:11px;height:11px"><use href="#i-star"/></svg>已收藏</span>' : '') +
      '<span class="chip ' + (p.syntax_errors ? 'danger' : 'cyan') + '">' + (p.syntax_errors ? '语法问题 ' + p.syntax_errors : '静态检查通过') + '</span></div>');
    h.push('<div class="detail-grid">');
    h.push(detailItem('完整路径', '<code>' + esc(p.path || '注册表未提供') + '</code>', true));
    h.push(detailItem('类型', isInstalled ? (p.kind === 'installed+project' ? '已安装软件 + 项目目录' : '已安装软件') : '项目目录'));
    h.push(detailItem('分类', esc(p.display_category || '未分类')));
    h.push(detailItem('体积', p.size_bytes ? bytes(p.size_bytes) : '未统计'));
    h.push(detailItem('最近修改', esc(p.modified_at || p.install_date || '—')));
    h.push(detailItem('程序入口数', num(p.entry_count)));
    h.push(detailItem('主要入口', esc(p.top_entry || '—')));
    h.push(detailItem('扩展名', esc(p.extensions || '—')));
    if (isInstalled) {
      h.push(detailItem('发布者', esc(p.publisher || '—')));
      h.push(detailItem('版本', esc(p.version || '—')));
      h.push(detailItem('安装日期', esc(p.install_date || '—')));
    }
    h.push('</div>');
    h.push('<div class="detail-actions">' +
      (p.path ? '<button class="btn sm primary" data-action="open-folder" data-path="' + esc(p.path) + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-external"/></svg>在资源管理器打开</button>' +
        '<button class="btn sm" data-action="copy-text" data-copy="' + esc(p.path) + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-copy"/></svg>复制路径</button>' :
        '<span class="chip gray">注册表未提供安装路径，无法定位</span>') + '</div>');
    h.push('<div class="detail-block"><h3>用途</h3><p>' + esc(p.display_purpose || '—') + '</p></div>');
    h.push('<div class="detail-block"><h3>使用方式</h3><p>' + esc(p.display_usage || '—') + '</p></div>');
    h.push('<div class="detail-block"><h3>当前状态</h3><p>' + esc(p.status || '—') + '</p></div>');

    if (entries && entries.length) {
      h.push('<div class="detail-block"><h3>入口文件（最近 ' + entries.length + ' 个）</h3><div class="entry-list">');
      entries.slice(0, 200).forEach(function (e) {
        h.push('<div class="entry-row"><span class="ext">' + esc(e.ext || '') + '</span>' +
          '<span class="nm" title="' + esc(e.path) + '">' + esc(e.name) + '</span>' +
          '<span class="sz">' + bytes(e.size_bytes) + '</span><span class="tm">' + esc((e.modified_at || '').slice(0, 16)) + '</span></div>');
      });
      h.push('</div></div>');
    } else if (!isInstalled) {
      h.push('<div class="detail-block"><h3>入口文件</h3><p>没有识别到直接入口，可能是源码工程或资源目录；可参考上面的使用方式。</p></div>');
    }

    h.push('<div class="section-sep"></div>');
    h.push('<div class="detail-block"><h3>我的标注</h3><p style="font-size:11px;color:var(--dim);margin-bottom:10px">标注独立保存，重新扫描不会覆盖。' + (ann.updated_at ? '上次修改：' + esc(ann.updated_at) + ' · ' + esc(ann.updated_by || '') : '还没有标注。') + '</p>');
    h.push('<form class="form-grid" id="annotationForm" data-path="' + esc(p.path || '') + '">');
    h.push('<label class="field wide"><span>自定义名称</span><input id="annName" value="' + esc(ann.custom_name || '') + '" placeholder="' + esc(p.name) + '"></label>');
    h.push('<label class="field"><span>分类</span><select id="annCategory" class="select" style="width:100%;padding-left:12px">' +
      '<option value="">使用系统识别（' + esc(p.display_category || '未分类') + '）</option>' +
      CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '"' + (ann.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>');
    h.push('<label class="field"><span>标签（逗号分隔）</span><input id="annTags" value="' + esc(ann.tags || '') + '" placeholder="例如：常用, 待修复"></label>');
    h.push('<label class="field wide"><span>用途说明</span><textarea id="annPurpose" placeholder="用大白话说清这个程序做什么">' + esc(ann.purpose || '') + '</textarea></label>');
    h.push('<label class="field wide"><span>使用方式</span><textarea id="annUsage" placeholder="从哪里启动、先装什么、注意什么">' + esc(ann.usage || '') + '</textarea></label>');
    h.push('<label class="field wide"><span>备注</span><textarea id="annNote" placeholder="账号、依赖、坑点、后续计划…">' + esc(ann.note || '') + '</textarea></label>');
    h.push('<label class="checkline wide"><input type="checkbox" id="annFavorite"' + (ann.favorite ? ' checked' : '') + '>标为收藏（在列表中显示星标）</label>');
    h.push('<div class="form-actions wide"><button class="btn primary" type="submit">保存标注</button>' +
      '<button class="btn danger" type="button" data-action="delete-annotation" data-path="' + esc(p.path || '') + '">清除标注</button></div>');
    h.push('</form></div>');
    $('#drawerBody').innerHTML = h.join('');
    var form = $('#annotationForm');
    if (form) form.addEventListener('submit', saveAnnotation);
  }

  function detailItem(label, valueHtml, wide) {
    return '<div class="detail-item' + (wide ? ' wide' : '') + '"><span>' + esc(label) + '</span><strong>' + valueHtml + '</strong></div>';
  }

  async function saveAnnotation(e) {
    e.preventDefault();
    var form = e.target;
    var path = form.getAttribute('data-path');
    if (!path) return;
    var payload = {
      path: path,
      custom_name: $('#annName').value.trim(),
      category: $('#annCategory').value,
      tags: $('#annTags').value.trim(),
      purpose: $('#annPurpose').value.trim(),
      usage: $('#annUsage').value.trim(),
      note: $('#annNote').value.trim(),
      favorite: $('#annFavorite').checked
    };
    try {
      await api('/api/annotation', { method: 'POST', body: payload });
      toast('标注已保存', 'ok');
      var id = state.drawerId;
      if (id) await openProject(id);
      if (state.view === 'projects') refreshProjects();
      if (state.view === 'dashboard') renderDashboard();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function closeDrawer() {
    state.drawerId = null;
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#drawerMask').classList.add('hidden');
  }

  // ------------------------------------------------------------ 弹窗
  function openModal(title, bodyHtml) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modalMask').classList.remove('hidden');
  }

  function closeModal() {
    $('#modalMask').classList.add('hidden');
  }

  function confirmModal(title, text, onOk, danger) {
    openModal(title, '<p class="modal-note" style="font-size:12.5px">' + esc(text) + '</p>' +
      '<div class="form-actions" style="justify-content:flex-end;margin-top:18px">' +
      '<button class="btn" data-action="close-modal">取消</button>' +
      '<button class="btn ' + (danger ? 'danger' : 'primary') + '" id="modalOk">' + (danger ? '确认删除' : '确认') + '</button></div>');
    var ok = $('#modalOk');
    if (ok) ok.onclick = async function () {
      ok.disabled = true;
      try { await onOk(); closeModal(); } catch (e) { toast(e.message, 'err'); ok.disabled = false; }
    };
  }

  function openGlossary() {
    var h = ['<div class="glossary">'];
    GLOSSARY.forEach(function (g) {
      h.push('<div class="glossary-item"><strong>' + esc(g[0]) + '</strong><p>' + esc(g[1]) + '</p></div>');
    });
    h.push('</div><p class="modal-note" style="margin-top:14px">还有不懂的词？把词发到微信 xunijiayuan，军哥懂保给你补上大白话解释。</p>');
    openModal('名词解释 · 大白话版', h.join(''));
  }

  // ------------------------------------------------------------ 扫描控制
  function toggleDrive(letter) {
    var i = state.selectedDrives.indexOf(letter);
    if (i === -1) state.selectedDrives.push(letter); else state.selectedDrives.splice(i, 1);
    var card = $('#scanCard');
    if (card) {
      var chips = $$('.drive-chip', card);
      chips.forEach(function (c) {
        c.classList.toggle('on', state.selectedDrives.indexOf(c.getAttribute('data-letter')) !== -1);
      });
      var row = $$('.setting-row', card)[0];
      if (row) {
        var b = row.querySelector('b');
        if (b) b.textContent = state.selectedDrives.length ? state.selectedDrives.join('、') : '未选择';
      }
    }
  }

  async function startScan() {
    var drives = state.selectedDrives.slice().sort();
    if (!drives.length) return toast('请至少选择一个磁盘', 'err');
    try {
      await api('/api/scan', { method: 'POST', body: { drives: drives, depth: state.depth } });
      toast('扫描已开始，可随时取消', 'ok');
      state.scan = { status: 'running', phase: '准备扫描', files_seen: 0, dirs_seen: 0, candidates: 0, entries: 0, elapsed: 0, logs: [] };
      applyScanState();
      startPolling();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function cancelScan() {
    try {
      await api('/api/scan/cancel', { method: 'POST' });
      toast('已发送取消指令，等待扫描线程收尾', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function startPolling() {
    stopPolling();
    pollScan();
    state.scanTimer = setInterval(pollScan, 1200);
  }

  function stopPolling() {
    if (state.scanTimer) { clearInterval(state.scanTimer); state.scanTimer = null; }
  }

  async function pollScan() {
    try {
      var d = await api('/api/scan/status');
      state.scan = d.state;
      applyScanState();
      if (state.scan.status === 'running') return;
      stopPolling();
      if (state.scan.status === 'done') {
        toast('扫描完成，已生成新快照', 'ok');
        await loadMeta();
        await loadSnapshots(state.scan.snapshot_id);
        if (state.view === 'dashboard') renderDashboard();
        else if (state.view === 'projects') renderProjects();
        else if (state.view === 'entries') renderEntries();
        else render();
      } else if (state.scan.status === 'cancelled') {
        toast('扫描已取消，未写入快照', 'err');
        if (state.view === 'dashboard') renderDashboard();
      } else if (state.scan.status === 'error') {
        toast('扫描失败：' + (state.scan.error || '未知错误'), 'err');
        if (state.view === 'dashboard') renderDashboard();
      }
    } catch (e) {
      stopPolling();
    }
  }

  // ------------------------------------------------------------ 账号弹窗
  function openAddUser() {
    openModal('新增账号', '<form id="userAddForm" class="modal-form">' +
      '<label class="field"><span>登录账号</span><input id="newUsername" placeholder="例如手机号或英文名" required></label>' +
      '<label class="field"><span>显示名称</span><input id="newDisplay" placeholder="例如 张三"></label>' +
      '<label class="field"><span>初始密码（至少6位）</span><input id="newPassword" type="password" minlength="6" required></label>' +
      '<label class="field"><span>角色</span><select id="newRole" class="select" style="width:100%"><option value="user">普通成员</option><option value="admin">管理员</option></select></label>' +
      '<p class="modal-note">普通成员可以扫描、查看、标注和导出；管理员额外拥有账号管理与 API Key 权限。</p>' +
      '<div class="form-actions" style="justify-content:flex-end"><button type="button" class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit">创建账号</button></div></form>');
    var f = $('#userAddForm');
    if (f) f.addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await api('/api/users', { method: 'POST', body: {
          username: $('#newUsername').value.trim(),
          display_name: $('#newDisplay').value.trim(),
          password: $('#newPassword').value,
          role: $('#newRole').value
        } });
        toast('账号已创建', 'ok');
        closeModal();
        renderUsers();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  function openEditUser(id) {
    var u = null;
    state.users.forEach(function (x) { if (x.id === id) u = x; });
    if (!u) return;
    openModal('修改账号 · ' + (u.display_name || u.username), '<form id="userEditForm" class="modal-form">' +
      '<label class="field"><span>登录账号（不可改）</span><input value="' + esc(u.username) + '" disabled></label>' +
      '<label class="field"><span>显示名称</span><input id="editDisplay" value="' + esc(u.display_name || '') + '"></label>' +
      '<label class="field"><span>角色</span><select id="editRole" class="select" style="width:100%">' +
      '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>普通成员</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>管理员</option></select></label>' +
      '<label class="field"><span>重置密码（留空则不修改）</span><input id="editPassword" type="password" placeholder="至少6位"></label>' +
      '<label class="checkline"><input type="checkbox" id="editActive"' + (u.active ? ' checked' : '') + '>账号启用</label>' +
      '<div class="form-actions" style="justify-content:flex-end"><button type="button" class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit">保存修改</button></div></form>');
    var f = $('#userEditForm');
    if (f) f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var body = {
        display_name: $('#editDisplay').value.trim(),
        role: $('#editRole').value,
        active: $('#editActive').checked ? 1 : 0
      };
      var pwd = $('#editPassword').value;
      if (pwd) body.password = pwd;
      try {
        await api('/api/users/' + id, { method: 'PUT', body: body });
        toast('账号已更新', 'ok');
        closeModal();
        renderUsers();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  // ------------------------------------------------------------ 快照操作
  async function viewSnapshot(id) {
    id = Number(id) || id;
    state.snapshotId = id;
    state.projects.page = 1;
    state.entries.page = 1;
    await loadSnapshots(id);
    toast('已切换到该快照', 'ok');
    go('projects');
  }

  async function compareSnapshot(id) {
    id = Number(id) || 0;
    var idx = -1;
    state.snapshots.forEach(function (s, i) { if (s.id === id) idx = i; });
    if (idx < 0 || !state.snapshots[idx + 1]) {
      return toast('这是最早的一份快照，没有上一份可对比', 'err');
    }
    var prev = state.snapshots[idx + 1];
    try {
      var d = await api('/api/snapshots/compare?a=' + prev.id + '&b=' + id);
      var c = d.compare;
      var h = ['<p class="modal-note">对比：<b style="color:var(--muted)">' + esc(prev.created_at) + '</b> → <b style="color:var(--gold)">' + esc(d.b ? d.b.created_at : '') + '</b></p>'];
      h.push('<div class="detail-grid" style="margin-top:12px">' + detailItem('新增项目', num(c.added.length)) + detailItem('消失项目', num(c.removed.length)) + detailItem('保持不变', num(c.same), true) + '</div>');
      if (c.added.length) {
        h.push('<div class="detail-block" style="margin-top:14px"><h3>新增（' + c.added.length + '）</h3>');
        c.added.slice(0, 40).forEach(function (x) {
          h.push('<div class="entry-row" style="padding:6px 0"><span class="nm">' + esc(x.name) + '</span></div>');
          h.push('<div style="font-size:10px;color:var(--dim);word-break:break-all;margin:-2px 0 6px">' + esc(x.path) + '</div>');
        });
        if (c.added.length > 40) h.push('<p class="modal-note">仅显示前 40 条。</p>');
        h.push('</div>');
      }
      if (c.removed.length) {
        h.push('<div class="detail-block" style="margin-top:14px"><h3>消失（' + c.removed.length + '）</h3>');
        c.removed.slice(0, 40).forEach(function (x) {
          h.push('<div class="entry-row" style="padding:6px 0"><span class="nm" style="color:#ffb3b3">' + esc(x.name) + '</span></div>');
          h.push('<div style="font-size:10px;color:var(--dim);word-break:break-all;margin:-2px 0 6px">' + esc(x.path) + '</div>');
        });
        if (c.removed.length > 40) h.push('<p class="modal-note">仅显示前 40 条。</p>');
        h.push('</div>');
      }
      openModal('快照对比', h.join(''));
    } catch (e) { toast(e.message, 'err'); }
  }

  // ------------------------------------------------------------ 全局事件
  function bindGlobalEvents() {
    var loginForm = $('#loginForm');
    if (loginForm) loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('#loginBtn');
      var msg = $('#loginMsg');
      msg.textContent = '';
      btn.disabled = true;
      btn.textContent = '正在登录…';
      try {
        var d = await api('/api/login', { method: 'POST', body: {
          username: $('#loginUser').value.trim(), password: $('#loginPass').value
        } });
        state.me = d.user;
        await enterApp();
      } catch (err) {
        msg.textContent = err.message + '（密码区分大小写，请留意末尾的英文句点等符号）';
      } finally {
        btn.disabled = false;
        btn.textContent = '进入目录';
      }
    });

    document.addEventListener('click', function (e) {
      var nav = e.target.closest('[data-view]');
      if (nav) { go(nav.getAttribute('data-view')); return; }

      if (e.target.closest('[data-open-glossary]')) { openGlossary(); return; }

      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.getAttribute('data-action');
      var id = Number(el.getAttribute('data-id') || 0);
      var page = Number(el.getAttribute('data-page') || 0);

      if (action === 'toggle-sidebar') { $('#sidebar').classList.toggle('open'); return; }
      if (action === 'close-sidebar') { closeSidebar(); return; }
      if (action === 'close-drawer') { closeDrawer(); return; }
      if (action === 'close-modal') { closeModal(); return; }
      if (action === 'scroll-scan') {
        var card = $('#scanCard');
        if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.style.boxShadow = '0 0 0 2px rgba(246,197,107,.45)'; setTimeout(function () { card.style.boxShadow = ''; }, 1600); }
        return;
      }
      if (action === 'go-projects') { go('projects'); return; }
      if (action === 'go-dashboard') { go('dashboard'); return; }
      if (action === 'logout') {
        api('/api/logout', { method: 'POST' }).catch(function () { });
        showLogin();
        return;
      }
      if (action === 'open-project' || action === 'open-entry') { openProject(id); return; }
      if (action === 'toggle-drive') { toggleDrive(el.getAttribute('data-letter')); return; }
      if (action === 'drive-all') { state.selectedDrives = state.drives.map(function (d) { return d.letter; }); rerenderScanCard(); return; }
      if (action === 'drive-none') { state.selectedDrives = []; rerenderScanCard(); return; }
      if (action === 'refresh-drives') { loadDrives().then(function () { renderDashboard(); }); return; }
      if (action === 'start-scan') { startScan(); return; }
      if (action === 'cancel-scan') { cancelScan(); return; }
      if (action === 'page') {
        var list = el.getAttribute('data-list');
        if (list === 'projects') { state.projects.page = page; refreshProjects(); }
        else { state.entries.page = page; refreshEntries(); }
        var wrap = list === 'projects' ? $('.card') : $('.card');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (action === 'open-folder') {
        var path = el.getAttribute('data-path');
        api('/api/reveal', { method: 'POST', body: { path: path } })
          .then(function () { toast('已在资源管理器中打开', 'ok'); })
          .catch(function (err) { toast(err.message, 'err'); });
        return;
      }
      if (action === 'copy-text' || action === 'copy-key') {
        var text = action === 'copy-text' ? el.getAttribute('data-copy') : ($('#apiKeyText') ? $('#apiKeyText').textContent : '');
        copyText(text);
        return;
      }
      if (action === 'delete-annotation') {
        var p = el.getAttribute('data-path');
        confirmModal('清除标注', '将删除这个项目的手动标注，恢复系统识别内容。磁盘上的文件不会受影响。', async function () {
          await api('/api/annotation?path=' + encodeURIComponent(p), { method: 'DELETE' });
          toast('已清除标注', 'ok');
          if (state.drawerId) await openProject(state.drawerId);
          if (state.view === 'projects') refreshProjects();
        }, true);
        return;
      }
      if (action === 'refresh-dashboard') { renderDashboard(); return; }
      if (action === 'refresh-snapshots') { renderSnapshots(); return; }
      if (action === 'refresh-logs') { renderLogs(); return; }
      if (action === 'view-snapshot') { viewSnapshot(id); return; }
      if (action === 'compare-snapshot') { compareSnapshot(id); return; }
      if (action === 'delete-snapshot') {
        confirmModal('删除快照', '只删除这次扫描记录，不会删除磁盘上的任何文件。', async function () {
          await api('/api/snapshots/' + id, { method: 'DELETE' });
          toast('快照已删除', 'ok');
          if (state.snapshotId === id) state.snapshotId = null;
          await loadSnapshots();
          renderSnapshots();
        }, true);
        return;
      }
      if (action === 'add-user') { openAddUser(); return; }
      if (action === 'edit-user') { openEditUser(id); return; }
      if (action === 'delete-user') {
        confirmModal('删除账号', '删除后该账号立即无法登录，但目录数据与标注不受影响。', async function () {
          await api('/api/users/' + id, { method: 'DELETE' });
          toast('账号已删除', 'ok');
          renderUsers();
        }, true);
        return;
      }
      if (action === 'regen-key') {
        confirmModal('重新生成 API Key', '旧 Key 会立即失效，正在使用它的程序需要更新。', async function () {
          var d = await api('/api/settings/api-key', { method: 'POST' });
          toast('新的 API Key 已生成，请复制保存', 'ok');
          var el2 = $('#apiKeyText');
          if (el2) el2.textContent = d.api_key;
          if (state.settings) state.settings.api_key = d.api_key;
        });
        return;
      }
    });

    document.addEventListener('change', function (e) {
      if (e.target.id === 'depthSel') state.depth = Number(e.target.value) || 6;
      if (e.target.id === 'projectCategory') { state.projects.category = e.target.value; state.projects.page = 1; refreshProjects(); }
      if (e.target.id === 'projectKind') { state.projects.kind = e.target.value; state.projects.page = 1; refreshProjects(); }
      if (e.target.id === 'projectSort') { state.projects.sort = e.target.value; state.projects.page = 1; refreshProjects(); }
      if (e.target.id === 'entryExt') { state.entries.ext = e.target.value; state.entries.page = 1; refreshEntries(); }
      if (e.target.id === 'entryPageSize') { state.entries.page_size = Number(e.target.value) || 50; state.entries.page = 1; refreshEntries(); }
    });

    var searchProjects = debounce(function (val) {
      state.projects.q = val;
      state.projects.page = 1;
      refreshProjects();
    }, 300);
    var searchEntries = debounce(function (val) {
      state.entries.q = val;
      state.entries.page = 1;
      refreshEntries();
    }, 300);

    document.addEventListener('input', function (e) {
      if (e.target.id === 'projectSearch') searchProjects(e.target.value.trim());
      if (e.target.id === 'entrySearch') searchEntries(e.target.value.trim());
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('#modalMask').classList.contains('hidden')) closeModal();
        else if ($('#drawer').classList.contains('open')) closeDrawer();
        else closeSidebar();
      }
    });
  }

  function rerenderScanCard() {
    var card = $('#scanCard');
    if (!card) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = renderScanCard(state.snapshot);
    card.parentNode.replaceChild(tmp.firstElementChild, card);
    applyScanState();
  }

  function closeSidebar() {
    var sb = $('#sidebar');
    if (sb) sb.classList.remove('open');
  }

  function copyText(text) {
    if (!text) return toast('没有可复制的内容', 'err');
    var done = function () { toast('已复制到剪贴板', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本', 'err'); }
    document.body.removeChild(ta);
  }

  // 设置页的表单是动态渲染的，用委托绑定提交
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'pwdForm') {
      e.preventDefault();
      api('/api/me/password', { method: 'POST', body: { old: $('#pwdOld').value, new: $('#pwdNew').value } })
        .then(function () { toast('密码已修改，请重新登录', 'ok'); showLogin(); })
        .catch(function (err) { toast(err.message, 'err'); });
    }
  });

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') init();
})();
