/* analytics.js — страница «Аналитика рынка» (hft-app, роут /analytics).
 * Читает /api/analytics/* (arbitrage.db из 54.Hft), рисует на Chart.js.
 * Визуализация: AnalyticsChartKit (плавающая легенда, zoom, чипы, время-тики).
 */
(function () {
  'use strict';

  if (!window.Chart) return;
  var K = window.AnalyticsChartKit;
  if (K) {
    // регистрируем плагины движка один раз
    K.plugins.forEach(function (p) {
      if (!p.id) return;
      try { Chart.registry.getPlugin(p.id); } catch (e) { Chart.register(p); }
    });
  }

  var CHARTS = {};           // id → Chart.js instance
  var FAMILIES = [];
  var ACTIVE_ASSETS = [];
  var PAIRS = [
    { label: 'GOLD / BRENT', a: 'GOLD', b: 'BRENT' },
    { label: 'GOLD / NGAS',  a: 'GOLD', b: 'NGAS' },
    { label: 'SILV / BRENT', a: 'SILV', b: 'BRENT' },
    { label: 'COPPER / BRENT', a: 'COPPER', b: 'BRENT' },
    { label: 'GOLD / SILV',  a: 'GOLD', b: 'SILV' },
    { label: 'BRENT / NGAS', a: 'BRENT', b: 'NGAS' }
  ];

  function $id(id) { return document.getElementById(id); }
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toDate(x) {
    return x instanceof Date ? x : new Date((x || '').replace(' ', 'T'));
  }

  async function api(url, opts) {
    var resp = await fetch(url, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts || {}));
    var data;
    try { data = await resp.json(); } catch (e) { data = { ok: false, error: 'bad response' }; }
    if (!resp.ok || data.ok === false) {
      var er = new Error(data.error || ('HTTP ' + resp.status));
      er.status = resp.status;
      throw er;
    }
    return data;
  }

  function makeChart(id, cfg) {
    if (CHARTS[id]) {
      if (CHARTS[id]._analyticsHitCleanup) CHARTS[id]._analyticsHitCleanup();
      CHARTS[id].destroy();
      CHARTS[id] = null;
    }
    var host = $id(id);
    if (!host) return null;
    var canvas = host.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      host.innerHTML = '';
      host.appendChild(canvas);
    } else {
      var old = Chart.getChart(canvas);
      if (old) old.destroy();
    }
    cfg.plugins = cfg.plugins || [];
    cfg.type = cfg.type || 'line';
    var chart = new Chart(canvas, cfg);
    if (K) K.setupCanvasForDPR(canvas, host);
    if (K) K.attachInteractions(chart);
    CHARTS[id] = chart;
    return chart;
  }

  function buildTimeLabels(candles) {
    var labels = candles.map(function (r) { return (r.time || '').slice(0, 16); });
    var timestamps = candles.map(function (r) { return toDate(r.time); });
    return { labels: labels, timestamps: timestamps };
  }

  // ── загрузка меты (инструменты) ───────────────────
  function loadActiveAssets() {
    return {
      GOLD: '#FFD700',
      SILV: '#c0c0c0',
      COPPER: '#e36a2e',
      PLATINUM_SPOT: '#e5e4e2',
      BRENT: '#5b6ee8',
      NGAS: '#f44336'
    };
  }
  function defaultAssets() {
    return ['GOLD', 'SILV', 'COPPER', 'BRENT', 'NGAS'];
  }

  // ── сравнение активов ─────────────────────────────
  async function loadCompare() {
    var host = $id('a-chart-main');
    var interval = $id('a-interval').value;
    var limit = $id('a-period').value;
    var usePct = $id('a-pct').checked;
    var assets = ACTIVE_ASSETS.length ? ACTIVE_ASSETS : defaultAssets();

    try {
      if (!FAMILIES.length) {
        var meta = await api('/api/analytics/meta');
        FAMILIES = (meta.families || []).map(function (f) { return f.family; });
      }
      var names = ['GOLD', 'SILV', 'COPPER', 'PLATINUM_SPOT', 'BRENT', 'NGAS'];
      var colorFor = {};
      for (var i = 0; i < names.length; i++) {
        colorFor[names[i]] = (K ? K.palette[i % K.palette.length] : '#1a73e8');
      }

      var qs = assets.map(function (a) {
        return '/api/analytics/candles?interval=' + encodeURIComponent(interval) +
          '&asset=' + encodeURIComponent(a) + '&limit=' + encodeURIComponent(limit);
      });
      var results = await Promise.all(qs.map(function (u) { return api(u); }));

      var datasets = [];
      var scales = {};
      scales.x = K ? K.smartTimeScale() : { ticks: { maxTicksLimit: 8 } };
      var yAxisIds = {};
      var yAxisIdx = 0;

      // Обычные цены / % — по выбранному режиму, каждая серия на своей оси
      var hasAny = false;
      for (var r = 0; r < results.length; r++) {
        var asset = assets[r];
        var c = (results[r] && results[r].candles) || [];
        if (!c.length) continue;
        var series = usePct ? K.toPctSeries(c.map(function (x) { return x.close; })) : c.map(function (x) { return x.close; });
        var color = colorFor[asset] || '#1a73e8';
        var axisId = usePct ? 'y_pct' : ('y_' + r);
        if (usePct) {
          if (!yAxisIds['y_pct']) {
            yAxisIds['y_pct'] = true;
            scales.y_pct = {
              position: 'right', display: true,
              ticks: { callback: function (v) { return v.toFixed(1) + '%'; },
                       font: { size: 10 }, color: '#9aa0c7', autoSkip: true, maxTicksLimit: 6 },
              grid: { display: false }, title: { display: false }
            };
          }
        } else {
          var av = c.map(function (x) { return x.close; }).filter(function (v) { return v != null; });
          var min = av.length ? Math.min.apply(null, av) : 0;
          var max = av.length ? Math.max.apply(null, av) : 0;
          var range = Math.max(max - min, 1);
          var pad = range * 0.08;
          if (!yAxisIds[axisId]) {
            yAxisIds[axisId] = true;
            scales[axisId] = {
              position: 'right', display: true,
              min: Math.max(0, min - pad), max: max + pad,
              ticks: { callback: function (v) { return Number(v).toLocaleString('ru-RU'); },
                       font: { size: 10 }, color: '#9aa0c7', autoSkip: true, maxTicksLimit: 6 },
              grid: { display: false }, title: { display: false }
            };
          }
        }
        datasets.push({
          label: asset,
          data: series,
          borderColor: color,
          backgroundColor: color + '22',
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          tension: 0.15,
          fill: false,
          spanGaps: true,
          yAxisID: axisId,
          hidden: false
        });
        hasAny = true;
      }

      if (!hasAny) { host.innerHTML = '<div class="empty">Нет данных</div>'; return; }

      var bl = results.find(function (r) { return (r.candles || []).length; });
      var timeLbl = buildTimeLabels((bl && bl.candles) || []);

      makeChart('a-chart-main', {
        data: { labels: timeLbl.labels, datasets: datasets, timestamps: timeLbl.timestamps },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: K ? K.tooltipModeIndex() : {},
            crosshair: { line: { color: '#9aa0c7', width: 1, dashPattern: [4, 4] } }
          },
          scales: scales
        }
      });

      // метрики
      var m = $id('a-metrics');
      var lastTime = timeLbl.labels[timeLbl.labels.length - 1];
      var frag = '<div>Точка: <b>' + esc(lastTime) + '</b></div>';
      for (var i = 0; i < results.length; i++) {
        var cc = (results[i] && results[i].candles) || [];
        if (!cc.length) continue;
        var last = cc[cc.length - 1];
        var first = cc[0];
        var delta = first && first.close ? ((last.close / first.close) - 1) * 100 : 0;
        frag += '<div>' + esc(assets[i]) + ': <b>' + Number(last.close).toFixed(3) +
          '</b> <span style="color:' + (delta >= 0 ? '#4caf50' : '#e53935') + '">' +
          (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%</span></div>';
      }
      m.innerHTML = frag;
    } catch (e) {
      host.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  // ── спред пары (z-score) ──────────────────────────
  var currentPair = PAIRS[0];
  function renderPairPicker() {
    var host = $id('a-pair-picker');
    if (!host) return;
    host.style.display = 'flex';
    host.innerHTML = '<span style="font-size:13px;">Пара:</span>';
    host.insertAdjacentHTML('beforeend', PAIRS.map(function (p) {
      return '<button data-a="' + p.a + '" data-b="' + p.b + '"' +
        (p === currentPair ? ' class="active"' : '') + '>' + esc(p.label) + '</button>';
    }).join(''));
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        currentPair = {
          label: b.textContent, a: b.dataset.a, b: b.dataset.b
        };
        renderPairPicker();
        loadSpread();
      });
    });
  }

  async function loadSpread() {
    var host = $id('a-chart-spread');
    if (!K) { host.innerHTML = '<div class="empty">Нет движка графика</div>'; return; }
    var interval = $id('a-interval').value;
    if (interval !== '1d') {
      host.innerHTML = '<div class="empty">Спред на 1d (непрерывные ряды)</div>';
      return;
    }
    var limit = $id('a-period').value;
    try {
      var data = await api('/api/analytics/series?interval=1d&limit=' + encodeURIComponent(limit));
      var s = data.series || {};
      var ra = s[currentPair.a] || [], rb = s[currentPair.b] || [];
      if (!ra.length || !rb.length) { host.innerHTML = '<div class="empty">Нет данных пары</div>'; return; }
      var da = {}; ra.forEach(function (x) { da[x.t.slice(0, 10)] = x.c; });
      var db = {}; rb.forEach(function (x) { db[x.t.slice(0, 10)] = x.c; });
      var dates = Object.keys(da).filter(function (d) { return db[d] != null; }).sort();
      if (dates.length < 5) { host.innerHTML = '<div class="empty">Мало общих дат</div>'; return; }
      var ratio = dates.map(function (d) { return da[d] / db[d]; });
      var mean = ratio.reduce(function (a, b) { return a + b; }, 0) / ratio.length;
      var sd = Math.sqrt(ratio.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / ratio.length);
      var z = ratio.map(function (r) { return sd ? (r - mean) / sd : 0; });
      var colors = { a: '#3498db', b: '#e74c3c', z: '#f39c12' };

      var datasets = [];
      // отдельные цены пары + z-score (своя ось)
      datasets.push({
        label: currentPair.a,
        data: dates.map(function (d) { return da[d]; }),
        borderColor: colors.a, borderWidth: 1, pointRadius: 0, tension: 0.15,
        fill: false, spanGaps: true, yAxisID: 'y_a', hidden: true
      });
      datasets.push({
        label: currentPair.b,
        data: dates.map(function (d) { return db[d]; }),
        borderColor: colors.b, borderWidth: 1, pointRadius: 0, tension: 0.15,
        fill: false, spanGaps: true, yAxisID: 'y_b', hidden: true
      });
      datasets.push({
        label: currentPair.label + ' z-score',
        data: z,
        borderColor: '#f39c12', borderWidth: 1.5, pointRadius: 0, tension: 0.15,
        fill: false, spanGaps: true, yAxisID: 'y_z', hidden: false
      });
      datasets.push({
        label: '+1σ', data: dates.map(function () { return 1; }),
        borderColor: '#999', borderDash: [3, 3], pointRadius: 0, borderWidth: 1,
        fill: false, yAxisID: 'y_z', hidden: true, _noChips: true
      });
      datasets.push({
        label: '−1σ', data: dates.map(function () { return -1; }),
        borderColor: '#999', borderDash: [3, 3], pointRadius: 0, borderWidth: 1,
        fill: false, yAxisID: 'y_z', hidden: true, _noChips: true
      });

      var avgA = da[dates[dates.length - 1]];
      var ranges = {
        y_a: { pos: 'right', display: true, min: Math.min.apply(null, dates.map(function (d) { return da[d]; })) * 0.99,
               max: Math.max.apply(null, dates.map(function (d) { return da[d]; })) * 1.01,
               ticks: { font: { size: 10 }, color: colors.a, maxTicksLimit: 5 },
               grid: { display: false }, title: { display: false } },
        y_b: { pos: 'right', display: true, min: Math.min.apply(null, dates.map(function (d) { return db[d]; })) * 0.99,
               max: Math.max.apply(null, dates.map(function (d) { return db[d]; })) * 1.01,
               ticks: { font: { size: 10 }, color: colors.b, maxTicksLimit: 5 },
               grid: { display: false }, title: { display: false } },
        y_z: { pos: 'right', display: true, min: -2.2, max: 2.2,
               ticks: { font: { size: 10 }, color: '#f39c12', maxTicksLimit: 5 },
               grid: { display: true, color: 'rgba(243, 156, 18, 0.18)' }, title: { display: false } }
      };
      var scales = { x: K.smartTimeScale() };
      Object.keys(ranges).forEach(function (ax) {
        scales[ax] = ranges[ax];
      });

      var tt = K.tooltipModeIndex();
      makeChart('a-chart-spread', {
        data: { labels: dates, datasets: datasets, timestamps: dates.map(function (d) { return toDate(d); }) },
        options: {
          animation: false, responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: tt,
            crosshair: { line: { color: '#9aa0c7', width: 1, dashPattern: [4, 4] } }
          },
          scales: scales
        }
      });

      $id('a-metrics').innerHTML = '<div>Пара: <b>' + esc(currentPair.label) + '</b></div>' +
        '<div>ratio (посл): <b>' + Number(ratio[ratio.length - 1]).toFixed(4) + '</b></div>' +
        '<div>z-score: <b>' + Number(z[z.length - 1]).toFixed(2) + '</b></div>' +
        '<div>σ(ratio): <b>' + Number(sd).toFixed(4) + '</b></div>';
    } catch (e) {
      host.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  // ── переключение режимов ──────────────────────────
  function onMode() {
    var mode = $id('a-mode').value;
    $id('a-pair-picker').style.display = mode === 'spread' ? 'flex' : 'none';
    $id('a-asset-picker-wrap').style.display = mode === 'compare' ? 'block' : 'none';
    if (mode === 'spread') loadSpread(); else loadCompare();
  }

  // ── рендер выбора активов ─────────────────────────
  function renderAssetPicker() {
    var host = $id('a-asset-picker');
    if (!host) return;
    host.innerHTML = '<span style="font-size:13px;">Активы:</span>';
    var all = ['GOLD', 'SILV', 'COPPER', 'PLATINUM_SPOT', 'BRENT', 'NGAS'];
    all.forEach(function (a) {
      var active = ACTIVE_ASSETS.indexOf(a) >= 0 || (!ACTIVE_ASSETS.length && defaultAssets().indexOf(a) >= 0);
      host.insertAdjacentHTML('beforeend',
        '<button data-a="' + a + '"' + (active ? ' class="active"' : '') + '>' + esc(a) + '</button>');
    });
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.a;
        var idx = ACTIVE_ASSETS.indexOf(a);
        if (idx >= 0) { ACTIVE_ASSETS.splice(idx, 1); }
        else ACTIVE_ASSETS.push(a);
        renderAssetPicker();
        loadCompare();
      });
    });
  }

  // ── метапараметры (форма → бэктест) ───────────────
  function readMetaparamForm() {
    return {
      asset: $id('mp-asset').value.trim() || 'GOLD',
      objective: $id('mp-objective').value,
      splice: $id('mp-splice').value,
      split: $id('mp-split').value,
      max_drawdown: parseFloat($id('mp-maxdd').value) || 0.10,
      max_leverage: parseFloat($id('mp-lev').value) || 1.0
    };
  }

  async function runMetaparam() {
    var cfg = readMetaparamForm();
    var out = $id('mp-result');
    out.textContent = 'Запуск эксперимента...';
    try {
      var data = await api('/api/analytics/candles?interval=1d&asset=' +
        encodeURIComponent(cfg.asset) + '&limit=0');
      var c = (data.candles || []).map(function (r) { return r.close; });
      if (c.length < 30) { out.textContent = 'Мало данных для прогона'; return; }
      var win = 20, trades = 0, pnl = 0, peak = -Infinity, maxDD = 0;
      for (var i = win; i < c.length - 1; i++) {
        var window_ = c.slice(i - win, i);
        var mean = window_.reduce(function (a, b) { return a + b; }, 0) / win;
        var sd = Math.sqrt(window_.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / win);
        var z = sd ? (c[i] - mean) / sd : 0;
        var pos = 0;
        if (z < -1) pos = 1; else if (z > 1) pos = -1;
        pnl += pos * (c[i + 1] - c[i]);
        if (pos) trades++;
        peak = Math.max(peak, pnl);
        maxDD = Math.max(maxDD, peak - pnl);
      }
      var ddOk = (maxDD / (peak || 1)) <= cfg.max_drawdown;
      out.innerHTML = 'Прототип z-score(20) → ' +
        '<b>trades=' + trades + '</b>, pnl(пт)= <b>' + Number(pnl).toFixed(1) + '</b>, ' +
        'maxDD= <b>' + Number(maxDD).toFixed(1) + '</b>, dd%maxDD_ok= <b>' + (ddOk ? 'да' : 'нет') +
        '</b>. Конфиг: <code>' + esc(JSON.stringify(cfg)) + '</code> (движок — по эпику метапараметров)';
    } catch (e) {
      out.textContent = 'Ошибка: ' + e.message;
    }
  }

  // ── таблица скачанных данных ──────────────────────
  function fmtCount(n) {
    if (n >= 10000) return (n / 1000).toFixed(1) + 'к';
    return String(n);
  }
  function fmtDate(s) {
    return s ? String(s).slice(0, 10) : '—';
  }
  function renderDataTable(d) {
    var host = $id('a-data-table');
    if (!host) return;
    var rows = (d.families || []).slice();
    var cand = d.candles || {};
    var cont = d.continuous || {};
    if (!rows.length) {
      host.innerHTML = '<div class="empty">Нет данных</div>';
      return;
    }
    var html = '<table class="data-table"><thead><tr>' +
      '<th>Семейство</th><th>Класс</th><th>Инстр.</th>' +
      '<th>1d continuous</th><th>1d</th><th>60min</th><th>10min</th>' +
      '<th>Диапазон</th></tr></thead><tbody>';
    rows.forEach(function (f) {
      var fam = f.family;
      var c = cand[fam] || {};
      var cv = cont[fam];
      var spanT0 = null, spanT1 = null;
      ['10min', '60min', '1d'].forEach(function (iv) {
        var b = c[iv];
        if (b) {
          if (!spanT0 || b.t0 < spanT0) spanT0 = b.t0;
          if (!spanT1 || b.t1 > spanT1) spanT1 = b.t1;
        }
      });
      function cell(iv) {
        var b = c[iv];
        if (!b) return '<td class="muted">—</td>';
        var cls = b.n > 10000 ? 'ok' : (b.n > 1000 ? 'warn' : 'muted');
        return '<td class="n ' + cls + '">' + fmtCount(b.n) + '</td>';
      }
      function contCell() {
        if (!cv) return '<td class="muted">—</td>';
        return '<td class="n ' + (cv.n >= 60 ? 'ok' : 'warn') + '">' + fmtCount(cv.n) +
          ' <span class="muted">' + fmtDate(cv.t0) + '…' + fmtDate(cv.t1) + '</span></td>';
      }
      var clsSpan = spanT0 ? 'ок' : '—';
      html += '<tr>' +
        '<td class="cls">' + esc(fam) + (f.futures && f.instruments > f.futures ? '' : '') + '</td>' +
        '<td>' + esc(f.asset_class) + '</td>' +
        '<td class="n">' + f.instruments + (f.futures ? ' («+ ' + f.futures + ')' : '') + '</td>' +
        contCell() + cell('1d') + cell('60min') + cell('10min') +
        '<td>' + (spanT0 ? '<b class="ok">' + fmtDate(spanT0) + '</b> … ' + fmtDate(spanT1) : '—') + ' &nbsp;' +
        (spanT0 ? (clsSpan === 'ок' ? '<span class="muted">(10min)</span>' : '') : '') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>' +
      '<div class="a-hint">Объём свечей по каждому интервалу. ' +
      '1d continuous — сшитый ряд для спред-анализа; «Диапазон» — покрытие по данным.</div>';
    host.innerHTML = html;
  }

  async function loadDataTable() {
    try {
      var d = await api('/api/analytics/data');
      renderDataTable(d);
    } catch (e) {
      var h = $id('a-data-table');
      if (h) h.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  // ── auth ────────────────────────────────────────
  function showLogin() {
    var ls = $id('a-login-screen');
    var wrap = $id('a-analytica-wrap');
    if (ls) ls.classList.remove('hidden');
    if (wrap) wrap.style.display = 'none';
  }

  function showApp() {
    var ls = $id('a-login-screen');
    var wrap = $id('a-analytica-wrap');
    if (ls) ls.classList.add('hidden');
    if (wrap) wrap.style.display = '';
    init();
  }

  function bindLogin() {
    var form = $id('a-login-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var username = $id('a-login-username').value.trim();
      var password = $id('a-login-password').value;
      var errBox = $id('a-login-error');
      if (errBox) errBox.textContent = '';
      api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
        .then(function () { showApp(); })
        .catch(function (er) { if (errBox) errBox.textContent = er.message; });
    });
  }

  async function restore() {
    try {
      var data = await api('/api/auth/me');
      if (data.ok && data.user) { showApp(); return; }
      showLogin();
    } catch (e) { showLogin(); }
  }

  // ── init ─────────────────────────────────────────
  function switchSection(sec) {
    if (!sec) return;
    var btn = document.querySelector('.a-nav-item[data-sec="' + sec + '"]');
    var navs = document.querySelectorAll('.a-nav-item');
    navs.forEach(function (b) { b.classList.toggle('active', b === btn); });
    document.querySelectorAll('.a-section').forEach(function (s) {
      s.classList.toggle('active', s.id === 'a-sec-' + sec);
    });
  }

  function readSecFromHash() {
    var m = /^#(data|charts|news|signals|ml)(?:[\/?.\-_].*)?$/.exec(location.hash);
    return m ? m[1] : null;
  }

  function bindNav() {
    var navs = document.querySelectorAll('.a-nav-item');
    if (!navs.length) return;
    navs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sec = btn.getAttribute('data-sec');
        if (location.hash !== '#' + sec) location.hash = '#' + sec;
        switchSection(sec);
      });
    });
    window.addEventListener('hashchange', function () {
      switchSection(readSecFromHash() || 'charts');
    });
    switchSection(readSecFromHash() || 'charts');
  }

  // ── ML: корреляционные матрицы со сдвигом ──────
  var ML_LAG_PRESETS = {
    '1d': [1, 2, 3, 5, 10, 20, 30, 40],
    '60min': [1, 2, 4, 12, 24, 48, 72, 144],
    '10min': [1, 3, 6, 12, 36, 72, 144, 288, 432]
  };

  function mlLagsFor(interval, cur) {
    var arr = ML_LAG_PRESETS[interval] || ML_LAG_PRESETS['1d'];
    return arr;
  }

  function renderMlLagSelect() {
    var sel = $id('ml-lag');
    if (!sel) return;
    var interval = $id('ml-interval').value;
    var lags = mlLagsFor(interval);
    var curVal = sel.value;
    sel.innerHTML = lags.map(function (l) {
      var lbl = l + (interval === '1d' ? ' дн' : (interval === '60min' ? ' ч' : ' м'));
      return '<option value="' + l + '"' + ((String(curVal) === String(l) || l === lags[0]) ? ' selected' : '') + '>' + lbl + '</option>';
    }).join('');
  }

  function corrColor(r) {
    // r ∈ [-1,1] → сине-белый → зелёно-красный
    if (r == null) return 'rgba(38,48,90,0.35)';
    var a = Math.min(Math.abs(r), 1);
    var alpha = 0.12 + 0.88 * a;
    if (r >= 0) return 'rgba(31,193,99,' + alpha.toFixed(2) + ')';
    return 'rgba(231,76,60,' + alpha.toFixed(2) + ')';
  }

  function renderMlMatrix(data) {
    var host = $id('a-ml-matrix');
    if (!host) return;
    var fams = data.families || [];
    var mat = data.matrix || [];
    if (!fams.length || !mat.length) {
      host.innerHTML = '<div class="empty">Нет данных для построения (мало общих точек).</div>';
      return;
    }
    var html = '<div class="a-ml-wrap"><table class="a-ml-table"><thead><tr><th class="fam-name">→ ведёт</th>';
    fams.forEach(function (f) {
      html += '<th title="' + esc(f) + '">' + esc(f) + '</th>';
    });
    html += '</tr></thead><tbody>';
    for (var i = 0; i < fams.length; i++) {
      html += '<tr><td class="fam-name" title="' + esc(fams[i]) + '">' + esc(fams[i]) + '</td>';
      for (var j = 0; j < fams.length; j++) {
        var v = mat[i][j];
        var txt = v == null ? '—' : v.toFixed(2);
        html += '<td style="background:' + corrColor(v) + ';" title="' +
          esc(fams[i]) + ' → ' + esc(fams[j]) + ' · lag ' + data.lag + '">' + txt + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    host.innerHTML = html;
  }

  function renderMlBest(data) {
    var host = $id('a-ml-best');
    if (!host) return;
    var pairs = data.pairs || [];
    if (!pairs.length) {
      host.innerHTML = '<div class="empty">Пары не найдены.</div>';
      return;
    }
    var html = '<table class="a-ml-best-table"><thead><tr>' +
      '<th>Источник (ведёт)</th><th>Цель (запаздывает)</th><th>Лаг</th><th class="n">r</th></tr></thead><tbody>';
    pairs.slice(0, 25).forEach(function (p) {
      var cls = 'warn';
      if (Math.abs(p.r) >= 0.3) cls = 'ok';
      html += '<tr><td>' + esc(p.source) + '</td><td>' + esc(p.target) + '</td>' +
        '<td>' + p.lag + '</td><td class="n ' + cls + '">' + p.r.toFixed(4) + '</td></tr>';
    });
    html += '</tbody></table>' +
      '<div class="a-hint">Лучший лаг по |r| для каждой пары. Зелёный — |r|≥0.30.</div>';
    host.innerHTML = html;
  }

  async function loadMlMatrix() {
    var host = $id('a-ml-matrix');
    if (host) host.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      var interval = $id('ml-interval').value;
      var lag = $id('ml-lag').value;
      var d = await api('/api/analytics/ml/matrix?interval=' + encodeURIComponent(interval) +
        '&lag=' + encodeURIComponent(lag || '1'));
      renderMlMatrix(d);
    } catch (e) {
      if (host) host.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  async function loadMlBest() {
    var host = $id('a-ml-best');
    if (host) host.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      var interval = $id('ml-interval').value;
      var d = await api('/api/analytics/ml/best_lags?interval=' + encodeURIComponent(interval));
      renderMlBest(d);
    } catch (e) {
      if (host) host.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  function fmtRub(v) {
    return (v == null || isNaN(v)) ? '—' : (v < 0 ? '−' : '+') + Math.abs(v).toLocaleString('ru-RU');
  }

  function fmtLiq(v) {
    if (!v) return '<span class="lq-low">0</span>';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + ' млн';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + ' тыс';
    return String(Math.round(v));
  }

  function renderMlStrategies(data) {
    var host = $id('a-ml-strat');
    if (!host) return;
    var pairs = data.pairs || [];
    if (!pairs.length) {
      host.innerHTML = '<div class="empty">Стратегии не найдены.</div>';
      return;
    }
    var rows = pairs.slice(0, 30).map(function (p, i) {
      var cls = (p.profit_finam > 0) ? 'sig' : 'los';
      var tgtLiq = fmtLiq(p.liq_target);
      var srcLiq = fmtLiq(p.liq_source);
      return '<tr class="' + cls + '">' +
        '<td class="l">' + (i + 1) + '</td>' +
        '<td class="l">' + esc(p.source) + ' <span style="color:var(--muted)">→</span> ' + esc(p.target) +
          '<div class="a-hint" style="margin-top:2px">' + esc(p.source_secid) + ' → ' + esc(p.target_secid) + '</div></td>' +
        '<td>' + p.lag + '</td>' +
        '<td>' + p.r.toFixed(2) + '</td>' +
        '<td>' + ((p.acc * 100).toFixed(0)) + '%</td>' +
        '<td>' + p.trades_day + '</td>' +
        '<td class="p">' + srcLiq + '</td>' +
        '<td class="p">' + tgtLiq + '</td>' +
        '<td class="p">' + fmtRub(p.fee_day) + '/д</td>' +
        '<td class="p">' + fmtRub(p.profit_finam) + '</td></tr>';
    }).join('');
    var html = '<div class="a-ml-wrap"><table class="a-ml-wrap-table"><thead><tr>' +
      '<th>#</th><th class="l">Пара (source → target)</th><th>Лаг</th><th>r</th><th>Точность</th>' +
      '<th>Сдел/сут</th><th class="p">Ликв. source</th><th class="p">Ликв. target</th>' +
      '<th class="p">Комиссия</th><th class="p">Доход на 1 млн</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<div class="a-hint" style="margin-top:6px">Комиссия: пары futures = 1,2 ₽/контракт (Финам N6); пары со spot/ETF = 0,025%. Жёлтое 0 — нет объёма в БД (spread-пара, торгуется только как фьючерсный ордер).</div>';
    host.innerHTML = html;
  }

  async function loadMlStrategies() {
    var host = $id('a-ml-strat');
    if (host) host.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      var interval = $id('ml-interval').value;
      var nocom = $id('ml-strat-nocom').checked ? '1' : '0';
      var d = await api('/api/analytics/ml/strategies?interval=' + encodeURIComponent(interval) +
        '&ignore_com=' + nocom);
      renderMlStrategies(d);
    } catch (e) {
      if (host) host.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  function bindMl() {
    var sel = $id('ml-interval');
    if (!sel) return;
    renderMlLagSelect();
    sel.addEventListener('change', function () {
      renderMlLagSelect();
      loadMlMatrix();
    });
    var btn = $id('ml-build');
    if (btn) btn.addEventListener('click', loadMlMatrix);
    var best = $id('ml-autobest');
    if (best) best.addEventListener('click', loadMlBest);
    var strat = $id('ml-strat-run');
    if (strat) strat.addEventListener('click', loadMlStrategies);
  }

  /* ── Новостной конвейер ──────────────────────── */

  var NEWS_FAMILIES = ['GOLD','SILV','COPPER','PLATINUM_SPOT','BRENT','NGAS'];
  var _newsChart = null;

  function renderNewsStats(d) {
    var el = $id('a-news-stats'); if (!el) return;
    var src = d.sources || [];
    var active = src.filter(function(s){ return s.enabled; }).length;
    var periodH = d.period_h || 24;
    el.innerHTML =
      '<div class="a-news-stat"><div class="n">' + (src.length) + '</div><div class="l">источников (' + active + ' активных)</div></div>' +
      '<div class="a-news-stat"><div class="n">' + fmtCount(d.n_articles) + '</div><div class="l">статей всего</div></div>' +
      '<div class="a-news-stat"><div class="n">' + fmtCount(d.n_scores) + '</div><div class="l">оценок (-100…100)</div></div>' +
      '<div class="a-news-stat"><div class="n">' + fmtCount(d.n_period) + '</div><div class="l">за период (' + (periodH % 24 === 0 ? periodH / 24 + ' дн' : periodH + ' ч') + ')</div></div>';
    /* заполняем селекты */
    var artSrc = $id('news-art-src');
    if (artSrc) {
      var prev = artSrc.value;
      artSrc.innerHTML = '<option value="">Все</option>';
      src.forEach(function(s){ artSrc.innerHTML += '<option value="' + s.code + '"' + (prev===s.code?' selected':'') + '>' + esc(s.name || s.code) + '</option>'; });
    }
    var artFam = $id('news-art-fam');
    if (artFam) {
      var pf = artFam.value;
      artFam.innerHTML = '<option value="">Все</option>';
      NEWS_FAMILIES.forEach(function(f){ artFam.innerHTML += '<option value="' + f + '"' + (pf===f?' selected':'') + '>' + f + '</option>'; });
    }
  }

  var _newsFeedAll = [];

  function renderNewsFeedFeed(feed) {
    var el = $id('a-news-feed'); if (!el) return;
    _newsFeedAll = feed || [];
    renderNewsFeedFiltered();
  }

  function currentNewsFeedLimit() {
    var sel = $id('news-feed-limit');
    var n = sel ? parseInt(sel.value, 10) : 20;
    return isFinite(n) && n > 0 ? n : 20;
  }

  function renderNewsFeedFiltered() {
    var el = $id('a-news-feed'); if (!el) return;
    var onlyInfl = $id('news-feed-infl-only') ? $id('news-feed-infl-only').checked : false;
    var feed = _newsFeedAll.filter(function(a){
      if (onlyInfl && (a.top_score == null || a.n_scores === 0)) return false;
      return true;
    }).slice(0, currentNewsFeedLimit());
    if (!_newsFeedAll.length) { el.innerHTML = '<div class="empty">Нет данных. Нажмите «Собрать».</div>'; return; }
    if (!feed.length) { el.innerHTML = '<div class="empty">Нет новостей с рассчитанным влиянием на стоимость активов.</div>'; return; }
    var h = '<table><tr><th>Время</th><th>Источник</th><th>Заголовок</th><th>Ключевые слова</th><th>Скоринг</th><th>Conf</th></tr>';
    feed.forEach(function(a){
      var t = a.published || a.fetched || '';
      var top = a.top_score;
      var cls = top > 0.5 ? 'n-pos' : top < -0.5 ? 'n-neg' : 'n-mute';
      var scStr = top == null ? '—' : (top > 0 ? '+' + top.toFixed(1) : top.toFixed(1));
      var dir = top > 0 ? '▲' : top < 0 ? '▼' : '•';
      var conf = a.top_conf != null ? Math.round(a.top_conf * 100) + '%' : '—';
      var srcName = a.source_name || a.source_code || '';
      var title = a.title || '';
      var scores = a.scores || [];
      /* ключевые слова из features (cat_hits) */
      var kws = [];
      scores.slice(0, 3).forEach(function(s){
        var feats = null;
        try { feats = typeof s.features === 'string' ? JSON.parse(s.features || 'null') : (s.features || null); } catch(e) {}
        if (feats && feats.cat_hits) {
          feats.cat_hits.forEach(function(ch){
            if (!ch) return;
            var ph = typeof ch === 'string' ? ch : (ch[2] || (ch[1] || ''));
            var side = typeof ch === 'string' ? '' : (ch[1] || '');
            kws.push({ w: String(ph).substring(0, 26), pos: side === 'pos' });
          });
          if (feats.impact != null && feats.impact) kws.push({ w: 'impact ' + feats.impact, pos: feats.impact > 0 });
        }
      });
      var seen = {}; kws = kws.filter(function(k){ if (seen[k.w]) return false; seen[k.w] = true; return true; }).slice(0, 8);
      var kwHtml = kws.length ? kws.map(function(k){ return '<span class="nf-kw' + (k.pos ? ' b' : '') + '">' + esc(k.w) + '</span>'; }).join('') : '<span style="color:var(--muted)">—</span>';
      h += '<tr><td class="nf-time">' + esc(t) + '</td><td>' + esc(srcName) + '</td>' +
           '<td class="nf-title"><a href="' + esc(a.url || '#') + '" target="_blank" rel="noopener">' + esc(title) + '</a></td>' +
           '<td>' + kwHtml + '</td>' +
           '<td class="nf-score ' + cls + '">' + dir + ' ' + scStr + '<div class="d">' + (a.top_family || '') + '</div></td>' +
           '<td>' + conf + '</td></tr>';
    });
    el.innerHTML = h + '</table>';
  }

  function renderNewsOverviewCharts(d) {
    var hourly = d.hours || [];
    var labels = hourly.map(function(r){ return (r.h || '').slice(5, 16); });
    var vals = hourly.map(function(r){ return r.n; });
    makeChart('a-news-an-count', {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: 'Новостей за период', data: vals, backgroundColor: 'rgba(108,140,255,.55)', borderColor: '#6c8cff', borderWidth: 1, borderRadius: 3 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: K ? K.tooltipModeIndex() : {} },
        scales: { x: { ticks: { color: '#9aa0c7', font: { size: 9 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 10 } },
                  y: { beginAtZero: true, ticks: { color: '#9aa0c7', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(38,48,90,.4)' } } }
      }
    });
    /* потенциальная влиятельность по семействам */
    var fams = d.families || [];
    var famLabels = fams.map(function(r){ return r.family; });
    var famInfl = fams.map(function(r){ return Math.round(r.infl || 0); });
    var famStrong = fams.map(function(r){ return r.strong || 0; });
    makeChart('a-news-an-infl', {
      type: 'bar',
      data: { labels: famLabels, datasets: [
        { label: 'Σ|score|·conf', data: famInfl, backgroundColor: 'rgba(247,202,24,.45)', borderColor: '#f7ca18', borderWidth: 1, borderRadius: 3 },
        { label: 'сильных (|s|≥50)', data: famStrong, backgroundColor: 'rgba(231,76,60,.5)', borderColor: '#e74c3c', borderWidth: 1, borderRadius: 3 }
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 }, color: '#9aa0c7' } }, tooltip: K ? K.tooltipModeIndex() : {} },
        scales: { x: { ticks: { color: '#9aa0c7', font: { size: 10 } } }, y: { beginAtZero: true, ticks: { color: '#9aa0c7', font: { size: 10 } }, grid: { color: 'rgba(38,48,90,.4)' } } }
      }
    });
    /* по источникам */
    var srcs = d.by_source || [];
    var sLabels = srcs.map(function(r){ return r.code; });
    var sVals = srcs.map(function(r){ return r.n; });
    makeChart('a-news-an-src', {
      type: 'bar',
      data: { labels: sLabels, datasets: [{ label: 'Новостей', data: sVals, backgroundColor: 'rgba(31,193,99,.5)', borderColor: '#1fc163', borderWidth: 1, borderRadius: 3 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: K ? K.tooltipModeIndex() : {} },
        scales: { x: { beginAtZero: true, ticks: { color: '#9aa0c7', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(38,48,90,.4)' } },
                  y: { ticks: { color: '#9aa0c7', font: { size: 10 } } } }
      }
    });
  }

  function renderNewsOverviewBacktest(bt) {
    var el = $id('a-news-an-bt'); if (!el) return;
    if (!bt || !bt.compare) { el.innerHTML = '<div class="empty">Нет данных бэктеста.</div>'; return; }
    var h = '<table><tr><th>Метод</th><th>Точек</th><th>Spearman ρ (1д)</th><th>p-value</th><th>Hit rate</th><th>Вывод</th></tr>';
    Object.keys(bt.compare).forEach(function(m){
      var r = bt.compare[m] || {};
      var hr = (r.horizons && r.horizons['1']) || {};
      var n = hr.n || 0;
      var rho = hr.spearman_rho;
      var pv = hr.pvalue;
      var hit = hr.hit_rate;
      var verdict = n < 10 ? 'мало данных' : (rho > 0.3 && pv < 0.05 ? '✅ подтверждено' : (rho > 0.1 ? 'слабая связь' : 'не подтверждено'));
      var col = rho > 0.3 && pv < 0.05 ? 'var(--pos)' : (rho > 0.1 ? '#f7ca18' : 'var(--neg)');
      h += '<tr><td><b>' + esc(m) + '</b></td><td>' + n + '</td><td style="color:' + col + '">' + (rho != null ? rho : '—') + '</td>' +
           '<td>' + (pv != null ? pv : '—') + '</td><td>' + (hit != null ? hit : '—') + '</td><td><span class="' + (verdict.indexOf('подтверждено') > -1 ? 'n-pos' : verdict.indexOf('слабая') > -1 ? '' : 'n-neg') + '">' + esc(verdict) + '</span></td></tr>';
    });
    el.innerHTML = h + '</table>';
  }

  function renderNewsSources(d) {
    var el = $id('a-news-sources'); if (!el) return;
    var src = d.sources || [];
    if (!src.length) { el.innerHTML = '<div class="empty">Нет источников</div>'; return; }
    var h = '<table><tr><th>Вкл</th><th>Вес</th><th>Код</th><th>Название</th><th>Тип</th><th>Язык</th><th>URL</th><th>Статей</th><th>Последний сбор</th></tr>';
    src.forEach(function(s){
      var n = s.items_total || 0;
      var lf = s.last_fetch ? fmtDate(s.last_fetch) : '—';
      var w = (s.weight != null ? s.weight : 1.0);
      h += '<tr data-code="' + s.code + '">' +
           '<td><input type="checkbox" data-f="enabled" data-code="' + s.code + '"' + (s.enabled ? ' checked' : '') + '></td>' +
           '<td><input type="number" step="0.1" min="0" max="5" style="width:60px;background:var(--bg2);border:1px solid var(--line);border-radius:4px;color:var(--txt);padding:2px 4px;" data-f="weight" data-code="' + s.code + '" value="' + w.toFixed(1) + '"></td>' +
           '<td>' + esc(s.code) + '</td><td>' + esc(s.name) + '</td><td>' + esc(s.kind) + '</td><td>' + esc(s.lang) + '</td>' +
           '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a></td>' +
           '<td>' + n + '</td><td>' + lf + '</td></tr>';
    });
    el.innerHTML = h + '</table>';
    /* кнопка «Сохранить» в панели */
    var saveBtn = $id('news-src-save');
    if (saveBtn) {
      saveBtn.onclick = function () {
        var rows = {};
        el.querySelectorAll('tr[data-code]').forEach(function (tr) {
          var code = tr.getAttribute('data-code');
          var cb = tr.querySelector('input[data-f="enabled"]');
          var wt = tr.querySelector('input[data-f="weight"]');
          if (cb) rows[code] = { enabled: cb.checked ? 1 : 0 };
          if (wt) rows[code] = Object.assign(rows[code] || {}, { weight: parseFloat(wt.value) || 1.0 });
        });
        var list = Object.keys(rows).map(function (code) { return Object.assign({ code: code }, rows[code]); });
        api('/api/analytics/news/sources/update', { method: 'POST', body: JSON.stringify({ sources: list }) })
          .then(function () {
            saveBtn.textContent = '✓ сохранено';
            setTimeout(function(){ saveBtn.textContent = 'Сохранить'; }, 1500);
          })
          .catch(function (e) { console.warn('update sources failed:', e); });
      };
    }
  }

  function renderNewsArticles(rows) {
    var el = $id('a-news-articles'); if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="empty">Нет статей</div>'; return; }
    var h = '<table><tr><th>Дата</th><th>Источник</th><th>Заголовок</th><th>Семейство</th><th>Impact</th><th>Conf</th></tr>';
    rows.forEach(function(r){
      var sc = r.score || 0;
      var cls = sc > 0.5 ? 'n-pos' : sc < -0.5 ? 'n-neg' : 'n-mute';
      var scStr = sc > 0 ? '+' + sc.toFixed(1) : sc.toFixed(1);
      var conf = r.conf != null ? (r.conf * 100).toFixed(0) + '%' : '—';
      var title = r.title || '';
      var url = r.url || '#';
      var srcName = r.source || r.source_code || '';
      h += '<tr><td>' + fmtDate(r.published || '') + '</td><td>' + esc(srcName) + '</td><td>' +
           '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title.substring(0, 80)) + (title.length > 80 ? '…' : '') + '</a></td>' +
           '<td>' + esc(r.family || '') + '</td><td class="' + cls + '">' + scStr + '</td><td>' + conf + '</td></tr>';
    });
    el.innerHTML = h + '</table>';
  }

  function renderNewsParams(p) {
    var el = $id('a-news-params'); if (!el) return;
    if (!p || !p.params) { el.innerHTML = '<div class="empty">Нет параметров</div>'; return; }
    p = p.params;
    var w = p.weights || {};
    function sel(name, cur, opts) {
      var h = '<option value="">—</option>';
      opts.forEach(function(o){ h += '<option value="' + o + '"' + (cur === o ? ' selected' : '') + '>' + o + '</option>'; });
      return '<select id="' + name + '">' + h + '</select>';
    }
    el.innerHTML =
      '<div class="a-news-params-form">' +
        '<label>Полураспад (часы)<input id="np-half" type="number" value="' + (p.half_life_hours != null ? p.half_life_hours : 12) + '" min="6" max="720"></label>' +
        '<label>Мин. уверенность<input id="np-conf" type="number" step="0.05" value="' + (p.min_conf != null ? p.min_conf : 0.35) + '" min="0" max="1"></label>' +
        '<label>Агрегация' + sel('np-agg', p.agg, ['weighted', 'median', 'peak']) + '</label>' +
        '<label>Нормализация шкалы<input id="np-norm" type="number" step="10" value="' + (p.norm != null ? p.norm : 100) + '" min="1" max="1000"></label>' +
      '</div>' +
      '<div class="a-news-params-form" style="margin-top:10px;">' +
        '<label>Вес: monetary<input id="np-w-monetary" type="number" step="0.05" value="' + (w.monetary != null ? w.monetary : 0.3) + '"></label>' +
        '<label>Вес: commodity<input id="np-w-commodity" type="number" step="0.05" value="' + (w.commodity != null ? w.commodity : 0.25) + '"></label>' +
        '<label>Вес: geopolitics<input id="np-w-geopolitics" type="number" step="0.05" value="' + (w.geopolitics != null ? w.geopolitics : 0.25) + '"></label>' +
        '<label>Вес: macro<input id="np-w-macro" type="number" step="0.05" value="' + (w.macro != null ? w.macro : 0.1) + '"></label>' +
        '<label>Вес: demand<input id="np-w-demand" type="number" step="0.05" value="' + (w.demand != null ? w.demand : 0.1) + '"></label>' +
      '</div>' +
      '<div class="a-news-params-form" style="margin-top:12px;">' +
        '<button id="np-save" class="btn" title="Сохранить параметры">Сохранить параметры</button>' +
        '<button id="np-rescore" class="btn" title="Пересчитать метрики по всем статьям новыми параметрами">Пересчитать метрики</button>' +
      '</div>' +
      '<div id="np-status" style="font-size:12px;color:var(--muted);margin-top:6px;"></div>';
    $id('np-save').addEventListener('click', function(){
      saveNewsParams();
    });
    $id('np-rescore').addEventListener('click', function(){
      rescoreNews();
    });
  }

  async function saveNewsParams() {
    var st = $id('np-status');
    if (st) st.textContent = 'Сохранение…';
    var body = {
      half_life_hours: parseFloat($id('np-half').value) || 12,
      min_conf: parseFloat($id('np-conf').value) || 0.35,
      agg: $id('np-agg').value || 'weighted',
      norm: parseFloat($id('np-norm').value) || 100,
      weights: {
        monetary: parseFloat($id('np-w-monetary').value) || 0.3,
        commodity: parseFloat($id('np-w-commodity').value) || 0.25,
        geopolitics: parseFloat($id('np-w-geopolitics').value) || 0.25,
        macro: parseFloat($id('np-w-macro').value) || 0.1,
        demand: parseFloat($id('np-w-demand').value) || 0.1
      }
    };
    try {
      var res = await api('/api/analytics/news/params', { method: 'POST', body: JSON.stringify(body) });
      if (st) { st.textContent = res.saved ? '✓ Сохранено. Для применения к старым статьям нажмите «Пересчитать метрики».' : 'Ошибка'; }
    } catch(e) {
      if (st) st.textContent = 'Ошибка: ' + esc(e.message);
    }
  }

  async function rescoreNews() {
    var btn = $id('np-rescore'); var st = $id('np-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Пересчёт…'; }
    if (st) st.textContent = 'Пересчёт метрик по всем статьям…';
    try {
      var res = await api('/api/analytics/news/rescore', { method: 'POST', body: '{}' });
      if (st) st.textContent = '✓ Пересчитано: ' + (res.rescore ? res.rescore.scored + ' из ' + res.rescore.articles : '—');
      loadNewsSeries();
      loadNewsArticles();
    } catch(e) {
      if (st) st.textContent = 'Ошибка: ' + esc(e.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Пересчитать метрики'; }
  }

  function renderNewsSeriesChart(d) {
    var series = (d && d.series) || [];
    var labels = series.map(function(s){ return s.dt || ''; });
    var datasets = NEWS_FAMILIES.map(function(fam, i){
      var colors = ['#6c8cff','#1fc163','#f7ca18','#e74c3c','#9b59b6','#1abc9c'];
      return {
        label: fam,
        data: series.map(function(s){
          var v = (s.families && s.families[fam]) ? s.families[fam].score : null;
          return v;
        }),
        borderColor: colors[i % colors.length],
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.2,
        spanGaps: true,
        yAxisID: 'y'
      };
    });
    makeChart('a-news-chart', {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 }, color: '#9aa0c7' } } },
        scales: {
          x: K.smartTimeScale(),
          y: {
            position: 'right',
            grid: { color: 'rgba(38,48,90,.4)' },
            ticks: { color: '#9aa0c7', font: { size: 10 } },
            title: { display: true, text: 'Impact (-100…100)', color: '#9aa0c7', font: { size: 10 } }
          }
        }
      }
    });
  }

  var _newsLoading = false;

  async function loadNewsFoundTable() {
    var daysEl = $id('news-found-table-days');
    var days = daysEl ? daysEl.value : '3';
    try {
      var d = await api('/api/analytics/news/found_hours?days=' + encodeURIComponent(days));
      renderNewsFoundTable(d);
    } catch(e) {
      var el = $id('a-news-found-table');
      if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  function renderNewsFoundTable(d) {
    var el = $id('a-news-found-table'); if (!el) return;
    var hours = d.hours || [];
    var srcs = d.sources || [];
    var matrix = d.matrix || {};
    var totals = d.totals_by_source || [];
    var totalRow = {};
    var hoursTotal = {};
    totals.forEach(function(t){ totalRow[t.code] = t.n; });
    hours.forEach(function(h){ hoursTotal[h] = 0; });
    if (!hours.length || !srcs.length) {
      el.innerHTML = '<div class="empty">Статей за выбранный период нет — запустите «Собрать».</div>';
      return;
    }
    var h = '<table class="a-tbl" style="width:100%;font-size:11px;"><thead>' +
      '<tr><th style="position:sticky;left:0;background:var(--bg);">Дата / час</th>' +
      srcs.map(function(s){ return '<th>'+esc(s)+'</th>'; }).join('') +
      '<th>Σ</th></tr></thead><tbody>';
    hours.forEach(function(hour){
      var row = matrix[hour] || {};
      var rowSum = 0;
      h += '<tr><td style="position:sticky;left:0;background:var(--bg);font-weight:600;">' +
           esc(hour.replace('T',' ').slice(0,16)) + '</td>';
      srcs.forEach(function(s){
        var n = row[s] || 0;
        rowSum += n;
        hoursTotal[hour] += n;
        h += '<td style="text-align:center;' + (n ? 'color:var(--acc);font-weight:600;' : '') + '">' +
             (n ? n : '') + '</td>';
      });
      h += '<td style="text-align:center;font-weight:600;color:var(--muted);">' + rowSum + '</td></tr>';
    });
    h += '</tbody><tfoot><tr><td style="position:sticky;left:0;background:var(--bg);font-weight:600;">Σ</td>';
    srcs.forEach(function(s){
      h += '<td style="text-align:center;font-weight:700;">' + (totalRow[s] || 0) + '</td>';
    });
    var grandTotal = totals.reduce(function(a,t){ return a + t.n; }, 0);
    h += '<td style="text-align:center;font-weight:700;color:var(--acc);">' + grandTotal + '</td></tr></tfoot></table>';
    el.innerHTML = h;
  }

  async function loadNewsStats() {
    try {
      var period = $id('news-overview-period') ? $id('news-overview-period').value : '24';
      var d = await api('/api/analytics/news/overview?period=' + encodeURIComponent(period));
      renderNewsStats(d);
      renderNewsSources(d);
      renderNewsFeedFeed(d.feed || []);
      renderNewsOverviewCharts(d);
      loadNewsOverviewBacktest();
    } catch(e) {
      var el = $id('a-news-stats');
      if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  async function loadNewsOverviewBacktest() {
    try {
      var bt = await api('/api/analytics/news/signatures/validate?interval=1d');
      renderNewsOverviewBacktest(bt);
    } catch(e) { var el = $id('a-news-an-bt'); if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }

  async function loadNewsOverviewLite() {
    try {
      var period = $id('news-overview-period') ? $id('news-overview-period').value : '24';
      var d = await api('/api/analytics/news/overview?period=' + encodeURIComponent(period));
      renderNewsStats(d);
      renderNewsFeedFeed(d.feed || []);
      renderNewsOverviewCharts(d);
    } catch(e) { /* молча */ }
  }

  async function loadNewsArticles() {
    if (_newsLoading) return;
    _newsLoading = true;
    try {
      var src = $id('news-art-src') ? $id('news-art-src').value : '';
      var fam = $id('news-art-fam') ? $id('news-art-fam').value : '';
      var url = '/api/analytics/news/articles?limit=150';
      if (src) url += '&source=' + encodeURIComponent(src);
      if (fam) url += '&family=' + encodeURIComponent(fam);
      var d = await api(url);
      renderNewsArticles(d.articles || []);
    } catch(e) {
      var el = $id('a-news-articles');
      if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
    _newsLoading = false;
  }

  async function loadNewsSeries() {
    try {
      var days = $id('news-series-days') ? $id('news-series-days').value : '90';
      var d = await api('/api/analytics/news/series?interval=1d&days=' + encodeURIComponent(days));
      renderNewsSeriesChart(d);
    } catch(e) {
      var el = $id('a-news-series');
      if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  async function loadNewsParams() {
    try {
      var d = await api('/api/analytics/news/params');
      renderNewsParams(d);
    } catch(e) {
      var el = $id('a-news-params');
      if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  async function collectNews() {
    var btn = $id('news-collect');
    if (btn) { btn.disabled = true; btn.textContent = 'Сбор…'; }
    try {
      await api('/api/analytics/news/collect', { method: 'POST', body: '{}' });
      await loadNewsStats();
      await loadNewsHealth();
      await loadNewsArticles();
      await loadNewsSeries();
    } catch(e) { /* молча */ }
    if (btn) { btn.disabled = false; btn.textContent = 'Собрать'; }
  }

  async function loadNewsHealth() {
    var el = $id('a-news-health');
    if (!el) return;
    try {
      var d = await api('/api/analytics/news/health');
      var h = d.health || {};
      var enabled = d.enabled_sources || [];
      var totalArticles = h.total_articles || 0;
      var totalErrors = h.total_errors || 0;
      var srcCount = Object.keys(h.sources || {}).length;
      var el2 = $id('a-news-health');
      if (el2) {
        el2.innerHTML =
          '<div class="a-news-stat"><div class="n">' + totalArticles + '</div><div class="l">всего статей (сбор)</div></div>' +
          '<div class="a-news-stat"><div class="n" style="color:' + (totalErrors > 0 ? 'var(--neg)' : 'var(--pos)') + '">' + totalErrors + '</div><div class="l">ошибок</div></div>' +
          '<div class="a-news-stat"><div class="n">' + srcCount + '</div><div class="l">активных источников</div></div>' +
          '<div class="a-news-stat"><div class="n">' + enabled.length + '</div><div class="l">включено</div></div>';
        /* детали по источникам */
        var h2 = '<div style="margin-top:12px;font-size:12px;">';
        var src = h.sources || {};
        Object.keys(src).forEach(function(k) {
          var s = src[k];
          var lastRun = s.last_run ? fmtDate(s.last_run) : '—';
          h2 += '<div style="display:flex;gap:12px;margin:2px 0;">' +
                '<span style="min-width:80px;font-weight:600;">' + esc(k) + '</span>' +
                '<span>статей: ' + s.articles + '</span>' +
                '<span style="color:' + (s.errors > 0 ? 'var(--neg)' : 'var(--pos)') + '">ошибок: ' + s.errors + '</span>' +
                '<span style="color:var(--muted)">последний сбор: ' + lastRun + '</span>' +
                '</div>';
        });
        h2 += '</div>';
        el2.innerHTML += h2;
      }
    } catch(e) {
      if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  async function loadNewsSignatures(mode) {
    var el = $id('a-news-sig'); if (!el) return;
    el.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      var url = '/api/analytics/news/signatures/' + encodeURIComponent(mode);
      if (mode === 'validate') {
        url += '?interval=1d';
      }
      var resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (mode === 'compare') {
        renderSigCompare(el, data);
      } else if (mode === 'validate') {
        renderSigValidate(el, data);
      }
    } catch(e) {
      el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  function renderSigCompare(el, d) {
    if (!d || !d.compare) {
      el.innerHTML = '<div class="empty">Нет данных: ' + esc((d && d.message) || '—') + '</div>';
      return;
    }
    var html = '<table class="a-tbl" style="width:100%"><thead><tr>' +
      '<th>Подход</th><th>Уверенность</th><th>Семейств/статья</th><th>Статьи</th><th>Лат. мс/статья</th>' +
      '</tr></thead><tbody>';
    Object.keys(d.compare).forEach(function(m) {
      var s = d.compare[m];
      html += '<tr><td><b>' + esc(m) + '</b></td>' +
        '<td>' + s.avg_confidence + '</td>' +
        '<td>' + s.avg_nonzero_families + '</td>' +
        '<td>' + s.total_signatures + '</td>' +
        '<td>' + s.latency_ms_per_article + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="desc" style="margin-top:8px;color:var(--muted);font-size:11px;">Статей в корпусе: ' + d.n_articles + '. LEXICON — текущий словарь news_scorer; HYBRID — TF-IDF + направление; TF-IDF — чистая концентрация семейств.</div>';
    el.innerHTML = html;
  }

  function renderSigValidate(el, d) {
    if (!d || !d.compare || d.compare.error) {
      el.innerHTML = '<div class="empty">' + esc((d && (d.error || d.message)) || 'Нет данных для валидации.') + '</div>';
      return;
    }
    var html = '<div class="desc" style="margin-bottom:6px;">Spearman ρ сигнатуры vs фактическая доходность соответствующего семейства (горизонты 1/2/3/5 дн). Малые выборки — ориентировочно.</div>';
    html += '<table class="a-tbl" style="width:100%"><thead><tr>' +
      '<th rowspan="2">Подход</th>';
    var hor = d.horizons || [1,2,3,5];
    hor.forEach(function(h){ html += '<th colspan="3">' + h + ' дн</th>'; });
    html += '</tr><tr>';
    hor.forEach(function(){ html += '<th>ρ</th><th>p</th><th>hit</th>'; });
    html += '</tr></thead><tbody>';
    Object.keys(d.compare).forEach(function(m) {
      var res = d.compare[m];
      if (res.error) { html += '<tr><td><b>' + esc(m) + '</b></td><td colspan="6">' + esc(res.error) + '</td></tr>'; return; }
      html += '<tr><td><b>' + esc(m) + '</b></td>';
      var totalPoints = 0;
      hor.forEach(function(h) {
        var s = (res.horizons || {})[h];
        if (s && s.n > 0) {
          html += '<td>' + s.spearman_rho + '</td><td>' + (s.pvalue <= 0.05 ? '<b>' + s.pvalue + '</b>' : s.pvalue) + '</td><td>' + s.hit_rate + '</td>';
          totalPoints += s.n;
        } else {
          html += '<td colspan="3" style="color:var(--muted)">—</td>';
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  /* ── График найденных новостей (аналог a-chart-main) ── */
  var _newsFoundTimer = null;

  async function loadNewsFound() {
    var daysEl = $id('news-found-days');
    var days = daysEl ? daysEl.value : '30';
    try {
      var d = await api('/api/analytics/news/corpus?days=' + encodeURIComponent(days));
      var bySrc = d.by_source || [];
      /* заполняем полный диапазон дней от min до max полученной даты,
         кумулятивно по каждому источнику и итого */
      var minD = null, maxD = null;
      bySrc.forEach(function(r){ minD = (minD===null||r.d<minD)?r.d:minD; if(maxD===null||r.d>maxD)maxD=r.d; });
      var start = minD ? new Date(minD + 'T00:00:00') : new Date();
      var end = maxD ? new Date(maxD + 'T00:00:00') : start;
      if (start.getTime() > end.getTime()) { var t=start; start=end; end=t; }
      /* ограничиваем старт по days назад от today (если данных мало) */
      var today = new Date(); today.setHours(0,0,0,0);
      var cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - (+days) + 1);
      start = start < cutoff ? cutoff : start;

      var srcSet = {};
      var perDay = {};
      bySrc.forEach(function(r){
        srcSet[r.code] = 1;
        if (!perDay[r.d]) perDay[r.d] = {};
        perDay[r.d][r.code] = r.n;
      });
      var srcs = Object.keys(srcSet).sort();
      var labels = [], timestamps = [], cum = {}, totalCum = [];
      srcs.forEach(function(s){ cum[s] = 0; });
      var total = 0;
      var cursor = new Date(start);
      var guard = 0;
      while (cursor <= end && guard < 400) {
        var key = cursor.toISOString().slice(0, 10);
        var day = perDay[key] || {};
        labels.push(key);
        timestamps.push(new Date(key + 'T00:00:00'));
        srcs.forEach(function(s){ cum[s] += day[s] || 0; });
        total += Object.keys(day).reduce(function(a,k){ return a+day[k]; }, 0);
        totalCum.push(total);
        cursor.setDate(cursor.getDate() + 1);
        guard++;
      }
      renderNewsFoundChart(labels, timestamps, srcs, cum, totalCum);
      renderNewsFoundInfo(labels, srcs, cum, totalCum);
    } catch(e) {
      var host = $id('a-news-found');
      if (host) host.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  function renderNewsFoundInfo(labels, srcs, cum, totalCum) {
    var el = $id('a-news-found-info'); if (!el) return;
    var total = totalCum.length ? totalCum[totalCum.length - 1] : 0;
    var first = labels.length ? labels[0] : '';
    var last = labels.length ? labels[labels.length - 1] : '';
    var frag = '<div style="display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;">' +
      '<b style="color:#f1c40f;">' + total + '</b> <span>статей найдено</span>';
    if (first && last && first !== last) frag += '<span style="opacity:.7">' + esc(first) + ' → ' + esc(last) + '</span>';
    srcs.forEach(function(s){
      var n = cum[s] || 0;
      frag += '<span style="display:inline-flex;align-items:center;gap:4px;">' +
        '<i style="width:10px;height:10px;border-radius:50%;display:inline-block;background:' +
        ((K && K.palette) ? '#8899cc' : '#6c8cff') + ';"></i>' + esc(s) + ' <b>' + n + '</b></span>';
    });
    el.innerHTML = frag + '</div>';
  }

  function renderNewsFoundChart(labels, timestamps, srcs, cum, totalCum) {
    var host = $id('a-news-found');
    if (!host) return;
    if (!srcs.length) { host.innerHTML = '<div class="empty">Нет данных. Запустите «Собрать».</div>'; return; }
    var colorFor = {};
    var palette = (K && K.palette) ? K.palette : ['#6c8cff','#1fc163','#f7ca18','#e74c3c','#9b59b6','#1abc9c','#e67e22','#34495e'];
    for (var i = 0; i < srcs.length; i++) colorFor[srcs[i]] = palette[i % palette.length];

    var datasets = [];
    /* итого — толстая линия на своей оси */
    var hasData = totalCum.some(function(v){ return v > 0; });
    if (hasData) {
      datasets.push({
        label: 'ИТОГО', data: totalCum,
        borderColor: '#f1c40f', backgroundColor: 'rgba(241,196,15,.08)',
        borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, tension: 0.15,
        fill: true, spanGaps: true, yAxisID: 'y_total', hidden: false
      });
    }
    /* по источникам — свои суб-линии, тонкие */
    srcs.forEach(function(s, idx){
      datasets.push({
        label: s, data: labels.map(function(l){ return { x: new Date(l + 'T00:00:00'), y: cum[s] }; }),
        borderColor: colorFor[s], backgroundColor: 'transparent',
        borderWidth: 1.2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15,
        fill: false, spanGaps: true, yAxisID: 'y_src',
        hidden: idx > 3
      });
    });

    var scales = {
      x: K ? K.smartTimeScale() : { ticks: { maxTicksLimit: 8 } },
      y_total: {
        position: 'right', display: hasData,
        ticks: { color: '#9aa0c7', font: { size: 10 }, autoSkip: true, maxTicksLimit: 6 },
        grid: { display: false }, title: { display: false }
      },
      y_src: {
        position: 'left', display: true,
        ticks: { color: '#9aa0c7', font: { size: 10 }, autoSkip: true, maxTicksLimit: 7 },
        grid: { color: 'rgba(38,48,90,.4)' }, title: { display: true, text: 'Найдено (накопл.)', color: '#9aa0c7', font: { size: 10 } }
      }
    };

    makeChart('a-news-found', {
      data: { labels: labels, datasets: datasets, timestamps: timestamps },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: K ? K.tooltipModeIndex() : {},
          crosshair: { line: { color: '#9aa0c7', width: 1, dashPattern: [4, 4] } }
        },
        scales: scales
      }
    });
  }

  /* ── Корпус: графики накопления ──────────────────────── */
  var _corpusData = null;

  async function loadCorpus() {
    var daysEl = $id('news-corp-days');
    var days = daysEl ? daysEl.value : '30';
    try {
      var d = await api('/api/analytics/news/corpus?days=' + encodeURIComponent(days));
      _corpusData = d;
      renderCorpusAccum(d);
      renderCorpusFamilies(d);
      renderCorpusStacked(d);
      renderCorpusInfo(d);
    } catch(e) {
      ['a-news-corp-accum','a-news-corp-fam','a-news-corp-stacked'].forEach(function(id){
        var el = $id(id); if (el) el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
      });
    }
  }

  function renderCorpusAccum(d) {
    var labels = d.fetched.map(function(r){ return r.d; });
    /* кумулятив */
    var cum = [];
    var sum = 0;
    d.fetched.forEach(function(r){ sum += r.n; cum.push(sum); });
    var el = $id('a-news-corp-accum-ch');
    if (!el) return;
    makeChart('a-news-corp-accum', {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Статей (накопл.)', data: cum,
          borderColor: '#6c8cff', backgroundColor: 'rgba(108,140,255,.12)',
          fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.3
        },{
          label: 'Статей/день', data: d.fetched.map(function(r){ return r.n; }),
          borderColor: '#1fc163', backgroundColor: 'transparent',
          borderWidth: 1, pointRadius: 1, tension: 0.3, yAxisID: 'y1'
        }]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 }, color: '#9aa0c7' } } },
        scales: {
          x: { ticks: { color: '#9aa0c7', font: { size: 10 }, maxTicksLimit: 12 } },
          y:  { position: 'left',  grid: { color: 'rgba(38,48,90,.4)' }, ticks: { color: '#9aa0c7', font: { size: 10 } }, title: { display: true, text: 'Накоплено', color: '#9aa0c7', font: { size: 10 } } },
          y1: { position: 'right', grid: { drawOnChartArea: false },      ticks: { color: '#9aa0c7', font: { size: 10 } }, title: { display: true, text: 'За день',   color: '#9aa0c7', font: { size: 10 } } }
        }
      }
    });
  }

  function renderCorpusFamilies(d) {
    var el = $id('a-news-corp-fam-ch');
    if (!el) return;
    var labels = d.family_coverage.map(function(f){ return f.family; });
    var data   = d.family_coverage.map(function(f){ return f.n; });
    var colors = ['#f7ca18','#95a5a6','#e67e22','#3498db','#2ecc71','#9b59b6'];
    makeChart('a-news-corp-fam', {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 }, color: '#9aa0c7', padding: 6 } } }
      }
    });
  }

  function renderCorpusStacked(d) {
    var el = $id('a-news-corp-stacked-ch');
    if (!el) return;
    /* собираем уникальные даты и коды */
    var dateSet = {}; var srcSet = {};
    d.by_source.forEach(function(r){ dateSet[r.d]=1; srcSet[r.code]=1; });
    var dates = Object.keys(dateSet).sort();
    var srcs  = Object.keys(srcSet);
    /* строим индекс src×date→n */
    var idx = {};
    d.by_source.forEach(function(r){ idx[r.d+'_'+r.code] = r.n; });
    var palette = ['#6c8cff','#1fc163','#f7ca18','#e74c3c','#9b59b6','#1abc9c','#e67e22','#34495e'];
    var datasets = srcs.map(function(src, i){
      return {
        label: src,
        data: dates.map(function(dt){ return idx[dt+'_'+src] || 0; }),
        backgroundColor: palette[i % palette.length],
        borderWidth: 0
      };
    });
    makeChart('a-news-corp-stacked', {
      type: 'bar',
      data: { labels: dates, datasets: datasets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 9 }, color: '#9aa0c7' } } },
        scales: {
          x: { ticks: { color: '#9aa0c7', font: { size: 10 }, maxTicksLimit: 12 } },
          y: { stacked: true, grid: { color: 'rgba(38,48,90,.4)' }, ticks: { color: '#9aa0c7', font: { size: 10 } }, title: { display: true, text: 'Статей/день', color: '#9aa0c7', font: { size: 10 } } }
        }
      }
    });
  }

  function renderCorpusInfo(d) {
    var el = $id('a-news-corp-info');
    if (!el) return;
    el.textContent = 'Всего статей: ' + d.total_articles + ' · с текстом: ' + d.with_text +
      ' · семейств покрыто: ' + d.family_coverage.length +
      ' · интервал: ' + d.days + ' дн.';
  }

  /* ── Аналитические дашборды ──────────────────────────── */
  async function loadDashboard() {
    var viewEl = $id('news-dash-view');
    var view = viewEl ? viewEl.value : 'family_heat';
    var el = $id('a-news-dash');
    if (!el) return;
    el.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      if (view === 'family_heat')    return await renderDashFamilyHeat(el);
      if (view === 'conf_dist')      return renderDashConfDist(el);
      if (view === 'score_scatter')  return await renderDashScoreScatter(el);
      if (view === 'source_quality') return await renderDashSourceQuality(el);
    } catch(e) {
      el.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  async function renderDashFamilyHeat(el) {
    /* простая тепловая карта: семейство × источник, ячейки = avg|score| */
    var d = await api('/api/analytics/news/articles?limit=500');
    var arts = d.articles || [];
    var srcSet = {}; var famSet = {};
    var idx = {};
    arts.forEach(function(r){
      var src = r.source_code || '?', fam = r.family || '?';
      srcSet[src]=1; famSet[fam]=1;
      var key = src+'_'+fam;
      if (!idx[key]) idx[key] = { sum: 0, n: 0 };
      idx[key].sum += (r.score||0); idx[key].n++;
    });
    var srcs = Object.keys(srcSet).sort();
    var fams = Object.keys(famSet).sort();
    if (!srcs.length || !fams.length) {
      el.innerHTML = '<div class="empty">Недостаточно данных.</div>'; return;
    }
    var html = '<div style="overflow:auto;"><table style="border-collapse:collapse;font-size:11px;"><tr><th style="padding:3px 6px;color:#9aa0c7;">Источник \\ Семейство</th>';
    fams.forEach(function(f){ html += '<th style="padding:3px 6px;color:#9aa0c7;text-align:center;">'+f+'</th>'; });
    html += '</tr>';
    srcs.forEach(function(src){
      html += '<tr><td style="padding:3px 6px;font-weight:600;">'+src+'</td>';
      fams.forEach(function(fam){
        var cell = idx[src+'_'+fam];
        var avg = cell ? cell.sum/cell.n : 0;
        var color = avg > 0 ? 'rgba(31,193,99,' + Math.min(avg/100, 0.9) + ')' :
                    avg < 0 ? 'rgba(231,76,60,' + Math.min(-avg/100, 0.9) + ')' : 'rgba(255,255,255,0.04)';
        html += '<td style="padding:4px 6px;text-align:center;background:'+color+';min-width:50px;">' +
                (cell ? Math.round(avg) : '—') + '</td>';
      });
      html += '</tr>';
    });
    html += '</table></div>';
    html += '<div style="margin-top:6px;font-size:10px;color:#9aa0c7;">Средний score (-100…100) по семейству для каждого источника. Зелёный = positive, красный = negative.</div>';
    el.innerHTML = html;
    el.style.height = 'auto';
  }

  function renderDashConfDist(el) {
    if (!_corpusData || !_corpusData.conf_buckets) {
      el.innerHTML = '<div class="empty">Сначала обновите корпус.</div>'; return;
    }
    var buckets = _corpusData.conf_buckets;
    var labels = buckets.map(function(b){ return (b.bucket/10).toFixed(1); });
    var data = buckets.map(function(b){ return b.n; });
    makeChart('a-news-dash', {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: 'Статей', data: data, backgroundColor: '#6c8cff', borderWidth: 0 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'Confidence', color: '#9aa0c7', font: { size: 10 } }, ticks: { color: '#9aa0c7', font: { size: 10 } } },
          y: { grid: { color: 'rgba(38,48,90,.4)' }, ticks: { color: '#9aa0c7', font: { size: 10 } } }
        }
      }
    });
  }

  async function renderDashScoreScatter(el) {
    var d = await api('/api/analytics/news/articles?limit=500');
    var arts = d.articles || [];
    var pts = arts.filter(function(r){ return r.score != null; }).map(function(r){
      return { x: r.conf || 0, y: r.score || 0 };
    });
    if (!pts.length) { el.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    makeChart('a-news-dash', {
      type: 'scatter',
      data: { datasets: [{ label: 'Score vs Conf', data: pts, backgroundColor: 'rgba(108,140,255,0.5)', pointRadius: 3 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'Confidence', color: '#9aa0c7', font: { size: 10 } }, ticks: { color: '#9aa0c7' }, grid: { color: 'rgba(38,48,90,.4)' } },
          y: { title: { display: true, text: 'Score', color: '#9aa0c7', font: { size: 10 } }, ticks: { color: '#9aa0c7' }, grid: { color: 'rgba(38,48,90,.4)' } }
        }
      }
    });
  }

  async function renderDashSourceQuality(el) {
    var d = await api('/api/analytics/news/stats');
    var srcs = (d.sources || []).filter(function(s){ return s.items_total > 0; });
    if (!srcs.length) { el.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    var labels = srcs.map(function(s){ return s.code; });
    var weights = srcs.map(function(s){ return s.weight; });
    var totals = srcs.map(function(s){ return s.items_total; });
    makeChart('a-news-dash', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Вес', data: weights, backgroundColor: '#6c8cff', yAxisID: 'y' },
          { label: 'Всего статей', data: totals, backgroundColor: '#1fc163', yAxisID: 'y1' }
        ]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 }, color: '#9aa0c7' } } },
        scales: {
          x: { ticks: { color: '#9aa0c7', font: { size: 10 } } },
          y:  { position: 'left',  grid: { color: 'rgba(38,48,90,.4)' }, ticks: { color: '#9aa0c7', font: { size: 10 } }, title: { display: true, text: 'Вес', color: '#9aa0c7', font: { size: 10 } } },
          y1: { position: 'right', grid: { drawOnChartArea: false },      ticks: { color: '#9aa0c7', font: { size: 10 } }, title: { display: true, text: 'Статей', color: '#9aa0c7', font: { size: 10 } } }
        }
      }
    });
  }

  function bindNews() {
    var sec = $id('a-sec-news'); if (!sec) return;
    /* первичная загрузка при переключении на секцию (лениво) */
    var loaded = false;
    function loadAll() {
      if (loaded) return; loaded = true;
      loadNewsStats();
      loadNewsHealth();
      loadNewsArticles();
      loadNewsSeries();
      loadNewsParams();
      loadCorpus();
      loadNewsFound();
      loadNewsFoundTable();
      startNewsFoundAuto();
    }
    /* загрузка при активации секции */
    var navItems = document.querySelectorAll('.a-nav-item[data-sec="news"]');
    for (var i = 0; i < navItems.length; i++) {
      navItems[i].addEventListener('click', loadAll);
    }
    /* если hash уже #news — загружаем сразу */
    if (location.hash && location.hash.indexOf('#news') === 0) loadAll();
    var colBtn = $id('news-collect');
    if (colBtn) colBtn.addEventListener('click', collectNews);
    var ovrPeriod = $id('news-overview-period');
    if (ovrPeriod) ovrPeriod.addEventListener('change', loadNewsOverviewLite);
    var ovrRefresh = $id('news-overview-refresh');
    if (ovrRefresh) ovrRefresh.addEventListener('click', loadNewsOverviewLite);
    var feedInfl = $id('news-feed-infl-only');
    if (feedInfl) feedInfl.addEventListener('change', renderNewsFeedFiltered);
    var feedLim = $id('news-feed-limit');
    if (feedLim) feedLim.addEventListener('change', renderNewsFeedFiltered);
    var srcSel = $id('news-art-src');
    if (srcSel) srcSel.addEventListener('change', loadNewsArticles);
    var famSel = $id('news-art-fam');
    if (famSel) famSel.addEventListener('change', loadNewsArticles);
    var daysSel = $id('news-series-days');
    if (daysSel) daysSel.addEventListener('change', loadNewsSeries);
    var refBtn = $id('news-series-refresh');
    if (refBtn) refBtn.addEventListener('click', loadNewsSeries);
    var healthBtn = $id('news-health-refresh');
    if (healthBtn) healthBtn.addEventListener('click', loadNewsHealth);
    var sigComp = $id('news-sig-compare');
    if (sigComp) sigComp.addEventListener('click', function(){ loadNewsSignatures('compare'); });
    var sigValid = $id('news-sig-validate');
    if (sigValid) sigValid.addEventListener('click', function(){ loadNewsSignatures('validate'); });
    var corpRefresh = $id('news-corp-refresh');
    if (corpRefresh) corpRefresh.addEventListener('click', loadCorpus);
    var corpDays = $id('news-corp-days');
    if (corpDays) corpDays.addEventListener('change', loadCorpus);
    var dashBuild = $id('news-dash-build');
    if (dashBuild) dashBuild.addEventListener('click', loadDashboard);
    var foundDays = $id('news-found-days');
    if (foundDays) foundDays.addEventListener('change', loadNewsFound);
    var foundRefresh = $id('news-found-refresh');
    if (foundRefresh) foundRefresh.addEventListener('click', loadNewsFound);
    var foundTableDays = $id('news-found-table-days');
    if (foundTableDays) foundTableDays.addEventListener('change', loadNewsFoundTable);
    var foundTableRefresh = $id('news-found-table-refresh');
    if (foundTableRefresh) foundTableRefresh.addEventListener('click', loadNewsFoundTable);
    /* табы навигации */
    bindNewsTabs(loadAll);
  }

  var _newsTabTimer = null;

  function bindNewsTabs(loadAll) {
    var tabsBox = $id('a-news-tabs'); if (!tabsBox) return;
    /* карта: имя таба → id панели */
    var PAN_MAP = {
      'overview': 'a-pan-overview', 'sources': 'a-pan-sources', 'health': 'a-pan-health',
      'found': 'a-pan-found', 'corpus': 'a-pan-corpus', 'dashboards': 'a-pan-dashboards',
      'articles': 'a-pan-articles', 'series': 'a-pan-series', 'params': 'a-pan-params',
      'signatures': 'a-pan-signatures'
    };
    function setActive(tabName) {
      var tabs = tabsBox.querySelectorAll('.a-news-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].dataset.tab === tabName);
      }
    }
    function scrollToTab(tabName) {
      var panel = document.getElementById(PAN_MAP[tabName]);
      if (panel) { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    function applyHash() {
      var h = location.hash || '';
      var m = h.match(/^#news(?:[\/\-:_.]([a-z]+))?/);
      if (!m) return;
      if (loadAll) try { loadAll(); } catch(e) {}
      var tab = m[1];
      if (!tab || !PAN_MAP[tab]) { tab = 'overview'; }
      setActive(tab);
      if (m[1]) setTimeout(function(){ scrollToTab(tab); }, 60);
    }
    /* клики по табам: скроллим + обновляем hash без двойного # */
    var tabs = tabsBox.querySelectorAll('.a-news-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function(btn){
        btn.addEventListener('click', function(){
          var tab = btn.dataset.tab;
          setActive(tab);
          scrollToTab(tab);
          try {
            var base = location.pathname + location.search;
            if (tab === 'overview') {
              history.pushState(null, '', base + '#news');
            } else {
              history.pushState(null, '', base + '#news-' + tab);
            }
          } catch(e) {}
        });
      })(tabs[i]);
    }
    /* подсветка активного таба по скроллу */
    var scrollTarget = document.querySelector('.a-scroll-area, .a-section, html');
    if (scrollTarget) {
      scrollTarget.addEventListener('scroll', function(){
        if (_newsTabTimer) return;
        _newsTabTimer = setTimeout(function(){
          _newsTabTimer = null;
          var best = 'overview'; var bestPos = -1e9;
          Object.keys(PAN_MAP).forEach(function(tab){
            var el = document.getElementById(PAN_MAP[tab]);
            if (!el) return;
            var r = el.getBoundingClientRect();
            if (r.top <= 120 && r.top > bestPos) { bestPos = r.top; best = tab; }
          });
          setActive(best);
        }, 150);
      });
    }
    window.addEventListener('hashchange', applyHash);
    applyHash();
  }

  function startNewsFoundAuto() {
    if (_newsFoundTimer) return;
    _newsFoundTimer = setInterval(function(){
      try { loadNewsFound(); } catch(e){ /* молчим */ }
    }, 60000);
  }

  /* ── ML-модель новостей (раздел «Сигналы») ── */
  function bindMlNews() {
    var btn = $id('a-ml-news-train'); if (!btn) return;
    btn.addEventListener('click', function(){
      btn.disabled = true;
      btn.textContent = 'Обучение…';
      api('/api/analytics/news/ml/train', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
        .then(function(res){
          if (res && res.error) { showMlNewsError(res.error, res); }
          else { renderMlNews(resultFallback(res)); }
        })
        .catch(function(e){ showMlNewsError(String(e)); })
        .finally(function(){ btn.disabled = false; btn.textContent = 'Переобучить (вручную)'; });
    });
    loadMlNewsStatus();
  }

  function resultFallback(res) {
    return res || {};
  }

  function renderMlNews(res) {
    var box = $id('a-ml-news-res'); if (!box) return;
    box.style.display = '';
    var m = res.metrics || {};
    var met = $id('a-ml-news-metrics');
    met.innerHTML =
      '<div>n_train: <b>' + (m.n_train || 0) + '</b></div>' +
      '<div>n_test: <b>' + (m.n_test || 0) + '</b></div>' +
      '<div>MAE train: <b>' + (m.train_mae != null ? m.train_mae.toFixed(7) : '-') + '</b></div>' +
      '<div>MAE test: <b>' + (m.test_mae != null ? m.test_mae.toFixed(7) : '-') + '</b></div>' +
      '<div>R² train: <b>' + (m.train_r2 != null ? m.train_r2.toFixed(4) : '-') + '</b></div>' +
      '<div>R² test: <b>' + (m.test_r2 != null ? m.test_r2.toFixed(4) : '-') + '</b></div>' +
      '<div>Направление (hit): <b>' + (m.direction_acc != null ? (m.direction_acc*100).toFixed(1)+'%' : '-') + '</b></div>';
    var lags = res.optimal_lags || {};
    var lagBox = $id('a-ml-news-lags');
    lagBox.innerHTML = Object.keys(lags).map(function(f){
      var l = lags[f];
      return '<div><b>' + f + '</b>: lag=' + (l.optimal_lag || '-') +
             ' бар (' + ((l.optimal_lag||0)*10) + ' мин), |r|=' + (l.avg_abs_return!=null ? l.avg_abs_return.toFixed(5) : '-') +
             ', n=' + (l.n_samples || 0) + '</div>';
    }).join('');
    var st = $id('a-ml-news-status');
    if (st) st.textContent = 'обучено · ' + (res.dataset_info ? ('строк: ' + res.dataset_info.total_rows + ', ') : '') + 'v' + (res.version || '0.1');
  }

  function showMlNewsError(msg, res) {
    var st = $id('a-ml-news-status');
    if (st) st.textContent = 'ошибка: ' + msg;
    if (res && res.n_rows != null) st.textContent = 'мало данных: ' + res.n_rows + ' строк (нужно ≥20)';
  }

  function loadMlNewsStatus() {
    api('/api/analytics/news/ml/status')
      .then(function(res){
        if (!res || res.status !== 'trained') {
          var st = $id('a-ml-news-status');
          if (st) st.textContent = 'модель не обучена — нажмите «Переобучить»';
          return;
        }
        renderMlNews(res);
      }).catch(function(){ /* молчим */ });
  }

  /* ── Сигналы: табы + таблица ── */
  function bindSignals() {
    var tabsBox = $id('a-sig-tabs'); if (!tabsBox) return;

    function setActive(tabName) {
      var tabs = tabsBox.querySelectorAll('.a-news-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].dataset.tab === tabName);
      }
      var a = $id('a-sig-tab-algo'), l = $id('a-sig-tab-list');
      if (a) a.style.display = tabName === 'algo' ? '' : 'none';
      if (l) {
        l.style.display = tabName === 'list' ? '' : 'none';
        if (tabName === 'list') loadSignalsList();
      }
    }

    /* hash (#signals / #signals-list) */
    function applyHash() {
      var h = location.hash || '';
      var m = h.match(/^#signals(?:[\/\-:_.]([a-z]+))?/);
      if (!m) return;
      setActive(m[1] === 'list' ? 'list' : 'algo');
    }

    var tabs = tabsBox.querySelectorAll('.a-news-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function(btn){
        btn.addEventListener('click', function(){
          var tab = btn.dataset.tab;
          setActive(tab);
          try {
            var base = location.pathname + location.search;
            history.pushState(null, '', base + '#signals' + (tab === 'list' ? '-list' : ''));
          } catch(e) {}
        });
      })(tabs[i]);
    }

    var periodSel = $id('sig-list-period');
    if (periodSel) periodSel.addEventListener('change', loadSignalsList);
    var thrSel = $id('sig-list-thr');
    if (thrSel) thrSel.addEventListener('change', loadSignalsList);
    var refBtn = $id('sig-list-refresh');
    if (refBtn) refBtn.addEventListener('click', loadSignalsList);

    window.addEventListener('hashchange', applyHash);
    applyHash();
  }

  var _signalsCacheTouched = false;
  function loadSignalsList() {
    var box = $id('a-sig-table'); if (!box) return;
    box.innerHTML = '<div class="empty">Загрузка…</div>';
    var period = ($id('sig-list-period') || {}).value || '168';
    var thr = ($id('sig-list-thr') || {}).value || '5';
    api('/api/analytics/news/signals/list?period=' + period + '&min_score=' + thr + '&limit=100')
      .then(function(res){
        if (!res || !res.signals) { box.innerHTML = '<div class="empty">Нет данных</div>'; return; }
        renderSignalsList(res.signals, res);
      })
      .catch(function(e){ box.innerHTML = '<div class="empty">Ошибка: ' + e.message + '</div>'; });
  }

  function renderSignalsList(signals, meta) {
    var box = $id('a-sig-table'); if (!box || !signals) return;
    if (!signals.length) {
      box.innerHTML = '<div class="empty">Сигналов за период нет (измените порог/период)</div>';
      return;
    }
    var rows = signals.map(function(s){
      var t = s.published || '';
      if (t.length > 19) t = t.slice(0, 19).replace('T', ' ');
      var score = s.score || 0;
      var sc = (score > 0 ? '+' : '') + Number(score).toFixed(1);
      var col = score > 0 ? '#4cd964' : (score < 0 ? '#ff5f57' : 'var(--muted)');
      var moves = s.moves || {};
      function mv(k){ return moves[k] != null ? (moves[k] > 0 ? '+' : '') + moves[k].toFixed(2) + '%' : '—'; }
      var mvCls = function(k){ return moves[k] != null ? (moves[k] >= 0 ? 'color:#4cd964;' : 'color:#ff5f57;') : 'color:var(--muted);'; };
      var title = s.title || '';
      if (title.length > 100) title = title.slice(0, 100) + '…';
      return '<tr>' +
        '<td style="padding:5px 8px;white-space:nowrap;font-size:11px;">' + t + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;"><b>' + s.family + '</b></td>' +
        '<td style="padding:5px 8px;font-size:11px;color:' + col + ';">' + sc + ' · ' + (s.signal || '') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--muted);">' + (s.basis || 'lex') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--muted);">' + (s.source_name || s.source_code || '') + (s.domain ? ' · <span style="opacity:.7;">'+s.domain+'</span>' : '') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;max-width:360px;">' + title + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;' + mvCls('2h') + '">' + mv('2h') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;' + mvCls('4h') + '">' + mv('4h') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;' + mvCls('8h') + '">' + mv('8h') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;' + mvCls('24h') + '">' + mv('24h') + '</td>' +
        '</tr>';
    }).join('');
    box.innerHTML =
      '<table style="width:100%;border-collapse:collapse;font-size:11px;min-width:1020px;">' +
        '<thead><tr style="color:var(--muted);text-align:left;border-bottom:1px solid var(--line);">' +
          '<th style="padding:6px 8px;">Дата / время</th>' +
          '<th style="padding:6px 8px;">Актив</th>' +
          '<th style="padding:6px 8px;">Сила (score)</th>' +
          '<th style="padding:6px 8px;">Метод</th>' +
          '<th style="padding:6px 8px;">Источник</th>' +
          '<th style="padding:6px 8px;">Новость</th>' +
          '<th style="padding:6px 8px;">Δ2ч</th>' +
          '<th style="padding:6px 8px;">Δ4ч</th>' +
          '<th style="padding:6px 8px;">Δ8ч</th>' +
          '<th style="padding:6px 8px;">Δ24ч</th>' +
        '</tr></thead><tbody>' + rows + '</tbody>' +
      '</table>' +
      '<div style="margin:6px 0 0;font-size:11px;color:var(--muted);">Сигналов: <b>' + signals.length + '</b> · Δ2ч/4ч/8ч/24ч — фактическое движение цены актива после публикации новости.</div>';
  }

  function init() {
    bindNav();
    bindMl();
    bindNews();
    bindMlNews();
    bindSignals();
    renderPairPicker();
    renderAssetPicker();
    loadDataTable();
    $id('a-refresh').addEventListener('click', onMode);
    $id('a-mode').addEventListener('change', onMode);
    $id('a-interval').addEventListener('change', onMode);
    $id('a-pct').addEventListener('change', onMode);
    $id('mp-run').addEventListener('click', runMetaparam);
    onMode();
  }

  bindLogin();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore);
  } else {
    restore();
  }
})();