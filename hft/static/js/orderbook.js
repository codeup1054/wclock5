/* orderbook.js — страница «Стакан» (hft-app, роут /orderbook).
 * Табы: текущий стакан (книга рынка), график котировок (свечи), история снапшотов.
 * Читает /api/hft/orderbook{,/history,/health,/candles} (T-Invest; поток в orderbook.py).
 * Доступ: сессия hft + панель "orderbook" (проверяется на сервере).
 */
(function () {
  'use strict';

  var TIMERS = [];
  var ACTIVE_TAB = 'book';
  var HISTORY_ROWS = [];
  var CHART_ROWS = [];
  var CHART_GEO = null;
  var CHART_HOVER = -1;
  var CHART_KEY = '5_MIN';
  var CHART_RANGE = { start: 0, end: 'live' };   // end: epoch-сек или 'live'
  var CHART_TYPE = 'candles';                    // candles | bars | line | area
  var CHART_VIEW = { i0: 0, i1: 0 };             // видимое окно индексов свечей
  var CHART_YZOOM = null;                        // { min, max } или null (авто)

  var CHART_TYPES = [
    { key: 'candles', label: 'Свечи' },
    { key: 'bars',    label: 'Бары' },
    { key: 'line',    label: 'Линия' },
    { key: 'area',    label: 'Область' }
  ];

  // ── панели страницы (настройки + видимость, паттерн panel settings) ──────
  var PAGE_PANELS = ['book', 'chart', 'history', 'summary', 'analytics', 'chat'];
  var BOOK_DEPTH = 10;
  var REFRESH_SEC = 2;
  var CHART_SHOW_VOLUME = true;
  var CHART_SHOW_LABELS = true;
  var HISTORY_LIMIT = 200;
  var SUMMARY_METRICS = ['bestBid', 'bestAsk', 'mid', 'spread', 'spreadPct',
    'sumBid', 'sumAsk', 'imbalance', 'bookTime', 'updates'];
  var SUMMARY_META = {
    bestBid: 'Bid', bestAsk: 'Ask', mid: 'Mid', spread: 'Спред', spreadPct: 'Спред %',
    sumBid: 'Σ бид', sumAsk: 'Σ аск', imbalance: 'Дисбаланс', bookTime: 'Стакан от',
    updates: 'Обновлений', historyRows: 'Строк истории', dbBytes: 'Размер БД'
  };
  var LAST_BOOK = null;
  var LAST_HEALTH = null;
  var POLLING = false;
  var ANALYTICS_LOADED = false;
  var ANALYTICS_EMBED = true;

  var CANDLE_INTERVALS = [
    { key: '1_MIN',  label: '1 мин',  maxDays: 1 },
    { key: '5_MIN',  label: '5 мин',  maxDays: 7 },
    { key: '15_MIN', label: '15 мин', maxDays: 7 },
    { key: '30_MIN', label: '30 мин', maxDays: 7 },
    { key: 'HOUR',   label: '1 час',  maxDays: 90 },
    { key: 'DAY',    label: '1 день', maxDays: 365 }
  ];
  var PERIOD_PRESETS = [
    { label: '1 час',    sec: 3600 },
    { label: '3 часа',   sec: 3 * 3600 },
    { label: '6 часов',  sec: 6 * 3600 },
    { label: '12 часов', sec: 12 * 3600 },
    { label: '1 день',   sec: 86400 },
    { label: '2 дня',    sec: 2 * 86400 },
    { label: '3 дня',    sec: 3 * 86400 },
    { label: '1 неделя', sec: 7 * 86400 },
    { label: '2 недели', sec: 14 * 86400 },
    { label: '4 недели', sec: 28 * 86400 },
    { label: '3 месяца', sec: 90 * 86400 }
  ];

  function $id(id) { return document.getElementById(id); }
  function fmt(v, d) {
    d = d == null ? 2 : d;
    return (v === null || v === undefined) ? '—' : Number(v).toFixed(d);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

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

  // ── auth ────────────────────────────────────────
  function showLogin() {
    stopPolling();
    var ls = $id('o-login-screen');
    var wrap = $id('o-wrap');
    if (ls) ls.classList.remove('hidden');
    if (wrap) wrap.style.display = 'none';
  }

  function showApp() {
    var ls = $id('o-login-screen');
    var wrap = $id('o-wrap');
    if (ls) ls.classList.add('hidden');
    if (wrap) wrap.style.display = '';
    applyPanelVisibility();
    startPolling();
  }

  function bindLogin() {
    var form = $id('o-login-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var username = $id('o-login-username').value.trim();
      var password = $id('o-login-password').value;
      var errBox = $id('o-login-error');
      if (errBox) errBox.textContent = '';
      api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
        .then(function () { showApp(); })
        .catch(function (er) { if (errBox) errBox.textContent = er.message; });
    });
  }

  async function restore() {
    try {
      var data = await api('/api/auth/me');
      if (data.ok && data.user) {
        window.ObUserId = data.user.id || data.user.username || 'anon';
        showApp();
        return;
      }
      showLogin();
    } catch (e) { showLogin(); }
  }

  // ── вкладки ─────────────────────────────────────
  function bindTabs() {
    var tabs = $id('o-tabs');
    if (!tabs) return;
    tabs.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.ob-tab') : null;
      if (b) activateTab(b.getAttribute('data-tab'));
    });
  }

  function activateTab(name) {
    ACTIVE_TAB = name;
    var tabs = document.querySelectorAll('#o-tabs .ob-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    PAGE_PANELS.forEach(function (t) {
      var pane = $id('o-tab-' + t);
      if (pane) pane.style.display = (t === name) ? '' : 'none';
    });
    if (name === 'chart') {
      if (!CHART_ROWS.length) loadCandles();
      else drawCandles(CHART_ROWS);
    } else if (name === 'history') {
      drawSpark(HISTORY_ROWS);
    } else if (name === 'summary') {
      renderSummary();
    } else if (name === 'analytics') {
      updateAnalytics();
    }
  }

  // ── рендер стакана ──────────────────────────────
  function setStatus(kind, text) {
    var dot = $id('o-dot');
    if (dot) dot.className = 'ob-dot ' + kind;
    var t = $id('o-status');
    if (t) t.textContent = text;
  }

  function renderSide(tableId, rows, side) {
    var tbody = document.querySelector('#' + tableId + ' tbody');
    if (!tbody) return;
    var cum = 0;
    var cumRows = (rows || []).map(function (r) {
      cum += r[1];
      return [r[0], r[1], cum];
    });
    var max = cum || 1;
    tbody.innerHTML = cumRows.map(function (r) {
      return '<tr>' +
        '<td class="ob-' + side + '">' + fmt(r[0], 4) + '</td>' +
        '<td>' + r[1] + '</td>' +
        '<td class="ob-bar-cell"><span class="ob-bar ' + side + '" style="width:' +
          ((r[2] / max) * 100).toFixed(1) + '%"></span><span class="ob-bar-val">' + r[2] + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderBook(d) {
    LAST_BOOK = d;
    $id('o-ticker').textContent = d.ticker || '';
    $id('o-depth').textContent = d.depth ? '· ' + d.depth + ' уровней' : '';
    $id('o-book-time').textContent = d.book_time ? String(d.book_time).replace('T', ' ').replace('+00:00', '') : '—';
    $id('o-best-bid').textContent = fmt(d.bids && d.bids[0] && d.bids[0][0], 4);
    $id('o-best-ask').textContent = fmt(d.asks && d.asks[0] && d.asks[0][0], 4);
    $id('o-mid').textContent = fmt(d.mid, 4);
    $id('o-spread').textContent = fmt(d.spread, 4);
    var bc = $id('o-bid-count'); if (bc) bc.textContent = d.bids ? '· ' + d.bids.length + ' заявок' : '';
    var ac = $id('o-ask-count'); if (ac) ac.textContent = d.asks ? '· ' + d.asks.length + ' заявок' : '';
    renderSide('o-bids', (d.bids || []).slice(0, BOOK_DEPTH), 'bid');
    renderSide('o-asks', (d.asks || []).slice(0, BOOK_DEPTH), 'ask');
    if (ACTIVE_TAB === 'summary') renderSummary();
  }

  async function loadBook() {
    try {
      renderBook(await api('/api/hft/orderbook'));
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      setStatus('bad', e.status === 403 ? 'нет доступа к панели «Стакан»' : 'нет связи с сервером');
    }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  async function loadHealth() {
    try {
      var d = await api('/api/hft/orderbook/health');
      var parts = [d.transport, d.updates + ' обновлений'];
      if (d.error) parts.push('ошибка: ' + d.error);
      var kind = d.error ? 'warn' : (d.connected ? 'ok' : 'warn');
      setStatus(kind, parts.join(' · '));
      var db = '';
      if (d.db && d.db.enabled) {
        db = ' · БД ' + fmtBytes(d.db.bytes) + ', ret ' + d.db.retention_days + 'д' +
          (d.db.store_levels ? ', уровни' : '');
        if (d.db.error) db += ' (ошибка: ' + d.db.error + ')';
      } else if (d.db) {
        db = ' · БД выключена';
      }
      $id('o-updates').textContent = d.updates + ' обновлений, история: ' + (d.history_rows || 0) +
        ', последнее: ' + (d.last_update || '—') + db;
      if (d.ticker) $id('o-ticker').textContent = d.ticker;
      LAST_HEALTH = d;
      if (ACTIVE_TAB === 'summary') renderSummary();
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      setStatus('bad', e.status === 403 ? 'нет доступа к панели «Стакан»' : 'сервер недоступен');
    }
  }

  function drawSpark(rows) {
    var canvas = $id('o-spark');
    if (!canvas || canvas.clientWidth === 0) return;
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 600;
    var cssH = canvas.clientHeight || 120;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var points = (rows || []).slice().reverse()
      .filter(function (r) { return r.mid !== null; })
      .map(function (r) { return r.mid; });
    if (points.length < 2) {
      ctx.fillStyle = '#9aa0c7';
      ctx.font = '12px sans-serif';
      ctx.fillText('накапливается история…', 12, cssH / 2);
      return;
    }
    var pad = 10;
    var min = Math.min.apply(null, points);
    var max = Math.max.apply(null, points);
    var span = (max - min) || 1;
    var x = function (i) { return pad + (i / (points.length - 1)) * (cssW - pad * 2); };
    var y = function (v) { return cssH - pad - ((v - min) / span) * (cssH - pad * 2); };

    ctx.strokeStyle = '#1fc163';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach(function (v, i) { if (i) ctx.lineTo(x(i), y(v)); else ctx.moveTo(x(i), y(v)); });
    ctx.stroke();

    var grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, 'rgba(31,193,99,0.25)');
    grad.addColorStop(1, 'rgba(31,193,99,0)');
    ctx.lineTo(x(points.length - 1), cssH);
    ctx.lineTo(x(0), cssH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.fillStyle = '#9aa0c7';
    ctx.font = '10px sans-serif';
    ctx.fillText(fmt(max, 3), pad, pad + 4);
    ctx.fillText(fmt(min, 3), pad, cssH - pad - 2);
  }

  async function loadHistory() {
    try {
      var d = await api('/api/hft/orderbook/history?limit=' + HISTORY_LIMIT);
      HISTORY_ROWS = d.rows || [];
      if (ACTIVE_TAB === 'history') drawSpark(HISTORY_ROWS);
      if (ACTIVE_TAB === 'summary') renderSummary();
      var tbody = document.querySelector('#o-history tbody');
      if (tbody) {
        tbody.innerHTML = HISTORY_ROWS.map(function (r) {
          return '<tr>' +
            '<td class="muted">' + String(r.t || '').replace('T', ' ').replace('+00:00', '') + '</td>' +
            '<td>' + fmt(r.mid, 4) + '</td>' +
            '<td>' + fmt(r.spread, 4) + '</td>' +
            '<td>' + (r.bid_qty == null ? '—' : r.bid_qty) + '</td>' +
            '<td>' + (r.ask_qty == null ? '—' : r.ask_qty) + '</td>' +
            '</tr>';
        }).join('');
      }
    } catch (e) {
      if (e.status === 401) showLogin();
    }
  }

  // ── график котировок ────────────────────────────
  function intervalMeta(key) {
    for (var i = 0; i < CANDLE_INTERVALS.length; i++) {
      if (CANDLE_INTERVALS[i].key === key) return CANDLE_INTERVALS[i];
    }
    return CANDLE_INTERVALS[1];
  }
  function intervalLabel(key) { return intervalMeta(key).label; }

  function nowSec() { return Math.floor(Date.now() / 1000); }
  function rangeEndSec() { return CHART_RANGE.end === 'live' ? nowSec() : CHART_RANGE.end; }
  function rangeHours() { return Math.max(0, (rangeEndSec() - CHART_RANGE.start) / 3600); }

  function toDatetimeLocal(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function toEpoch(val) {
    if (!val) return null;
    var d = new Date(val);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }
  function summaryLabel() {
    var f = function (ts) {
      var x = new Date(ts * 1000);
      return pad2(x.getDate()) + '.' + pad2(x.getMonth() + 1) + ' ' + pad2(x.getHours()) + ':' + pad2(x.getMinutes());
    };
    if (CHART_RANGE.end === 'live') return f(CHART_RANGE.start) + '–сейчас';
    return f(CHART_RANGE.start) + '–' + f(CHART_RANGE.end);
  }

  function syncRangeInputs() {
    var from = $id('o-period-from'), to = $id('o-period-to'),
        live = $id('o-period-live'), trig = $id('o-period-trigger');
    if (!from || !to || !live || !trig) return;
    from.value = toDatetimeLocal(CHART_RANGE.start);
    if (CHART_RANGE.end === 'live') {
      to.value = toDatetimeLocal(nowSec());
      to.disabled = true;
      live.checked = true;
    } else {
      to.value = toDatetimeLocal(CHART_RANGE.end);
      to.disabled = false;
      live.checked = false;
    }
    trig.textContent = summaryLabel();
  }

  // Клип окна по лимиту глубины текущего интервала.
  function clampRange() {
    var maxSec = intervalMeta(CHART_KEY).maxDays * 86400;
    var end = rangeEndSec();
    if (end - CHART_RANGE.start > maxSec) CHART_RANGE.start = end - maxSec;
    if (CHART_RANGE.start >= end) CHART_RANGE.start = end - Math.min(maxSec, 86400);
  }

  function resetChartView() {
    CHART_VIEW.i0 = 0;
    CHART_VIEW.i1 = 0;
    CHART_YZOOM = null;
  }

  // Пресеты длиннее лимита интервала не показываем.
  function fillPresetOptions() {
    var sel = $id('o-period-preset');
    if (!sel) return;
    var maxSec = intervalMeta(CHART_KEY).maxDays * 86400;
    var html = '<option value="__none__">Быстрый период...</option>';
    PERIOD_PRESETS.forEach(function (p, i) {
      if (p.sec <= maxSec) html += '<option value="' + i + '">' + p.label + '</option>';
    });
    sel.innerHTML = html;
    sel.value = '__none__';
  }

  function setActiveInterval(key) {
    var btns = document.querySelectorAll('#o-interval-group .interval-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-interval') === key);
    }
  }

  function applyRangeRaw(startSec, endVal) {
    var endNum = endVal === 'live' ? nowSec() : parseInt(endVal, 10);
    if (!startSec || !endNum || endNum <= startSec) return;
    CHART_RANGE.start = startSec;
    CHART_RANGE.end = endVal === 'live' ? 'live' : endNum;
    clampRange();
    resetChartView();
    syncRangeInputs();
    loadCandles();
  }

  function applyPreset(index) {
    var p = PERIOD_PRESETS[index];
    if (!p) return;
    applyRangeRaw(nowSec() - p.sec, 'live');
  }

  function selectInterval(key) {
    if (!key) return;
    CHART_KEY = key;
    setActiveInterval(key);
    fillPresetOptions();
    clampRange();
    resetChartView();
    syncRangeInputs();
    loadCandles();
  }

  function initChartControls() {
    var group = $id('o-interval-group');
    if (group) {
      group.innerHTML = CANDLE_INTERVALS.map(function (iv) {
        return '<button type="button" class="interval-btn" data-interval="' + iv.key + '">' + iv.label + '</button>';
      }).join('');
      group.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('.interval-btn') : null;
        if (b) selectInterval(b.getAttribute('data-interval'));
      });
    }
    CHART_RANGE.start = nowSec() - 86400;   // дефолт: 1 день до текущего момента
    CHART_RANGE.end = 'live';
    setActiveInterval(CHART_KEY);
    fillPresetOptions();
    clampRange();
    syncRangeInputs();
    bindPeriodModal();
    bindLiveToggle();
  }

  function bindPeriodModal() {
    var modal = $id('o-period-modal');
    var trig = $id('o-period-trigger');
    var preset = $id('o-period-preset');
    var apply = $id('o-period-apply');
    if (!modal || !trig) return;
    var close = modal.querySelector('.period-range-close');
    var header = modal.querySelector('.period-range-modal-header');

    function position() {
      var r = trig.getBoundingClientRect();
      var mw = modal.offsetWidth || 300;
      var mh = modal.offsetHeight || 180;
      var left = r.right - mw;
      if (left < 8) left = 8;
      var top = r.bottom + 4;
      if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
      if (top < 8) top = 8;
      modal.style.left = left + 'px';
      modal.style.top = top + 'px';
    }
    function toggle(show) {
      show = (show === undefined) ? (modal.style.display === 'none') : show;
      if (show) { position(); modal.style.display = 'block'; }
      else modal.style.display = 'none';
    }
    trig.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    if (close) close.addEventListener('click', function () { toggle(false); });
    document.addEventListener('click', function (e) {
      if (modal.style.display === 'none') return;
      if (!modal.contains(e.target) && !trig.contains(e.target)) toggle(false);
    });
    window.addEventListener('resize', function () { if (modal.style.display !== 'none') position(); });

    if (preset) preset.addEventListener('change', function () {
      if (this.value === '__none__') return;
      applyPreset(parseInt(this.value, 10));
      this.value = '__none__';
      toggle(false);
    });
    if (apply) apply.addEventListener('click', function () {
      var s = toEpoch($id('o-period-from').value);
      var live = $id('o-period-live').checked;
      var e = live ? 'live' : toEpoch($id('o-period-to').value);
      if (s == null || (!live && (e == null || e <= s))) { alert('Укажи корректные «с» и «по» даты'); return; }
      applyRangeRaw(s, e);
      toggle(false);
    });

    var drag = null;
    if (header) header.addEventListener('mousedown', function (e) {
      if (e.target.classList && e.target.classList.contains('period-range-close')) return;
      drag = { dx: e.clientX - modal.offsetLeft, dy: e.clientY - modal.offsetTop };
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      modal.style.left = (e.clientX - drag.dx) + 'px';
      modal.style.top = (e.clientY - drag.dy) + 'px';
    });
    document.addEventListener('mouseup', function () { drag = null; });
  }

  function bindLiveToggle() {
    var live = $id('o-period-live');
    var to = $id('o-period-to');
    if (!live || !to) return;
    live.addEventListener('change', function () {
      if (this.checked) {
        to.disabled = true;
      } else {
        to.disabled = false;
        if (!to.value) to.value = toDatetimeLocal(nowSec());
      }
    });
  }

  async function loadCandles() {
    try {
      var url = '/api/hft/orderbook/candles?interval=' + encodeURIComponent(CHART_KEY) +
                '&from=' + CHART_RANGE.start +
                '&to=' + (CHART_RANGE.end === 'live' ? 'live' : CHART_RANGE.end);
      var d = await api(url);
      var oldTotal = CHART_ROWS.length;
      var wasFull = (CHART_VIEW.i0 === 0 && (CHART_VIEW.i1 === 0 || CHART_VIEW.i1 >= oldTotal));
      CHART_ROWS = d.rows || [];
      if (wasFull) { CHART_VIEW.i0 = 0; CHART_VIEW.i1 = CHART_ROWS.length; }
      CHART_HOVER = -1;
      if (ACTIVE_TAB === 'chart') drawCandles(CHART_ROWS);
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      if (ACTIVE_TAB === 'chart') {
        CHART_ROWS = [];
        var info = $id('o-chart-info');
        if (info) info.textContent = 'ошибка: ' + e.message;
        drawCandles([]);
      }
    }
  }

  function fmtCandleTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    var hm = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    var dm = pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1);
    var multiDay = rangeHours() > 24;
    return (CHART_KEY === 'DAY' || multiDay) ? (dm + ' ' + hm) : hm;
  }

  function drawCandleSeries(ctx, view, x, y, body) {
    view.forEach(function (r, i) {
      var cx = x(i);
      var up = r.c >= r.o;
      ctx.strokeStyle = up ? '#1fc163' : '#e74c3c';
      ctx.fillStyle = up ? '#1fc163' : '#e74c3c';
      ctx.beginPath();
      ctx.moveTo(cx, y(r.h));
      ctx.lineTo(cx, y(r.l));
      ctx.lineWidth = 1;
      ctx.stroke();
      var yo = y(r.o), yc = y(r.c);
      var top = Math.min(yo, yc);
      var h = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - body / 2, top, body, h);
    });
  }

  function drawBarSeries(ctx, view, x, y, body) {
    view.forEach(function (r, i) {
      var cx = x(i);
      var up = r.c >= r.o;
      ctx.strokeStyle = up ? '#1fc163' : '#e74c3c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, y(r.h));
      ctx.lineTo(cx, y(r.l));
      ctx.stroke();
      var tick = Math.max(2, body * 0.5);
      ctx.beginPath();
      ctx.moveTo(cx - tick, y(r.o));
      ctx.lineTo(cx, y(r.o));
      ctx.moveTo(cx, y(r.c));
      ctx.lineTo(cx + tick, y(r.c));
      ctx.stroke();
    });
  }

  function drawLineSeries(ctx, view, x, y, fill, baseY) {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#6c8cff';
    ctx.beginPath();
    view.forEach(function (r, i) {
      if (i) ctx.lineTo(x(i), y(r.c)); else ctx.moveTo(x(i), y(r.c));
    });
    ctx.stroke();
    if (fill) {
      var grad = ctx.createLinearGradient(0, 0, 0, baseY);
      grad.addColorStop(0, 'rgba(108,140,255,.28)');
      grad.addColorStop(1, 'rgba(108,140,255,0)');
      ctx.lineTo(x(view.length - 1), baseY);
      ctx.lineTo(x(0), baseY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  function drawCandles(rows) {
    var canvas = $id('o-candles');
    if (!canvas || canvas.clientWidth === 0) return;
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 900;
    var cssH = canvas.clientHeight || 360;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var info = $id('o-chart-info');
    if (!rows || rows.length < 2) {
      CHART_GEO = null;
      if (info) info.textContent = 'нет данных за выбранный период';
      ctx.fillStyle = '#9aa0c7';
      ctx.font = '12px sans-serif';
      ctx.fillText('нет данных', 12, cssH / 2);
      return;
    }

    var total = rows.length;
    var i0 = Math.max(0, Math.min(CHART_VIEW.i0, total - 2));
    var i1 = CHART_VIEW.i1 > i0 ? Math.min(CHART_VIEW.i1, total) : total;
    if (i1 - i0 < 2) { i0 = 0; i1 = total; }
    CHART_VIEW.i0 = i0; CHART_VIEW.i1 = i1;
    var view = rows.slice(i0, i1);

    var padL = 8, padR = 62, padT = 10, padB = 22;
    var volH = Math.max(36, Math.round(cssH * 0.18));
    var priceH = cssH - padT - padB - volH - 6;
    var plotW = cssW - padL - padR;

    var min, max;
    if (CHART_YZOOM) {
      min = CHART_YZOOM.min;
      max = CHART_YZOOM.max;
      if (!(max > min)) { max = min + 0.01; }
    } else {
      min = Math.min.apply(null, view.map(function (r) { return r.l; }));
      max = Math.max.apply(null, view.map(function (r) { return r.h; }));
      if (!(max > min)) max = min + 0.01;
      var pad = (max - min) * 0.06;
      min -= pad; max += pad;
    }
    var span = (max - min) || 1;
    var vmax = Math.max.apply(null, view.map(function (r) { return r.v || 0; })) || 1;

    var slot = plotW / view.length;
    var body = Math.max(1, Math.min(slot * 0.66, 14));
    var x = function (i) { return padL + (i + 0.5) * slot; };
    var y = function (v) { return padT + (max - v) / span * priceH; };
    var volTop = padT + priceH + 6;
    var volBase = volTop + volH;

    ctx.strokeStyle = '#26305a';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#9aa0c7';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    var g = 4;
    for (var k = 0; k <= g; k++) {
      var gv = min + span * k / g;
      var gy = Math.round(y(gv)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
      ctx.stroke();
      ctx.fillText(fmt(gv, 3), padL + plotW + 4, gy + 3);
    }

    if (CHART_SHOW_VOLUME) {
      view.forEach(function (r, i) {
        var vh = (r.v || 0) / vmax * (volH - 2);
        ctx.fillStyle = (r.c >= r.o) ? 'rgba(31,193,99,.35)' : 'rgba(231,76,60,.35)';
        ctx.fillRect(x(i) - body / 2, volBase - vh, body, vh);
      });
    }

    if (CHART_TYPE === 'bars') drawBarSeries(ctx, view, x, y, body);
    else if (CHART_TYPE === 'line') drawLineSeries(ctx, view, x, y, false, 0);
    else if (CHART_TYPE === 'area') drawLineSeries(ctx, view, x, y, true, padT + priceH);
    else drawCandleSeries(ctx, view, x, y, body);

    if (CHART_HOVER >= i0 && CHART_HOVER < i1) {
      var hx = x(CHART_HOVER - i0);
      ctx.strokeStyle = '#9aa0c7';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, volBase);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.textAlign = 'left';
    if (CHART_SHOW_LABELS) {
      ctx.fillText(fmtCandleTime(view[0].t), padL, cssH - 6);
      ctx.textAlign = 'right';
      ctx.fillText(fmtCandleTime(view[view.length - 1].t), padL + plotW, cssH - 6);
      ctx.textAlign = 'left';
    }

    CHART_GEO = {
      padL: padL, padT: padT, plotW: plotW, priceH: priceH,
      volTop: volTop, volBase: volBase, slot: slot,
      n: view.length, i0: i0, total: total, min: min, max: max
    };
    if (info && CHART_HOVER < 0) {
      var zoomMark = (i1 - i0 < total || CHART_YZOOM) ? ' · zoom ' + view.length + '/' + total : '';
      info.textContent = view.length + ' свечей · ' + intervalLabel(CHART_KEY) + ' · ' + summaryLabel() + zoomMark;
    }
  }

  // ── масштаб колесом: X — по нижней оси, Y — по правой оси ──
  function priceAtY(my) {
    var g = CHART_GEO;
    var ratio = Math.max(0, Math.min(1, (my - g.padT) / g.priceH));
    return g.max - ratio * (g.max - g.min);
  }

  function zoomX(factor, mx) {
    var g = CHART_GEO;
    var cnt = CHART_VIEW.i1 - CHART_VIEW.i0;
    if (cnt < 2) return;
    var frac = Math.max(0, Math.min(1, (mx - g.padL) / g.plotW));
    var pivot = CHART_VIEW.i0 + frac * cnt;
    var newCnt = Math.max(5, Math.min(g.total, Math.round(cnt * factor)));
    var ni0 = Math.round(pivot - frac * newCnt);
    ni0 = Math.max(0, Math.min(g.total - newCnt, ni0));
    CHART_VIEW.i0 = ni0;
    CHART_VIEW.i1 = ni0 + newCnt;
  }

  function zoomY(factor, my) {
    var g = CHART_GEO;
    var p = priceAtY(my);
    var ratio = Math.max(0, Math.min(1, (my - g.padT) / g.priceH));
    var span = (g.max - g.min) * factor;
    CHART_YZOOM = { min: p - (1 - ratio) * span, max: p + ratio * span };
  }

  function onChartWheel(ev) {
    if (!CHART_GEO || !CHART_ROWS.length) return;
    ev.preventDefault();
    var canvas = $id('o-candles');
    var rect = canvas.getBoundingClientRect();
    var mx = ev.clientX - rect.left;
    var my = ev.clientY - rect.top;
    var g = CHART_GEO;
    var factor = ev.deltaY < 0 ? 0.85 : 1.18;
    if (mx >= g.padL + g.plotW) {
      zoomY(factor, my);
    } else if (my >= g.padT + g.priceH) {
      zoomX(factor, mx);
    } else {
      zoomX(factor, mx);
    }
    drawCandles(CHART_ROWS);
  }

  var _hoverPending = false;
  function onChartMove(ev) {
    if (!CHART_GEO || !CHART_ROWS.length) return;
    var canvas = $id('o-candles');
    var rect = canvas.getBoundingClientRect();
    var mx = ev.clientX - rect.left;
    if (mx < CHART_GEO.padL || mx > CHART_GEO.padL + CHART_GEO.plotW) return;
    var i = Math.floor((mx - CHART_GEO.padL) / CHART_GEO.slot) + CHART_GEO.i0;
    i = Math.max(0, Math.min(CHART_GEO.total - 1, i));
    if (i === CHART_HOVER) return;
    CHART_HOVER = i;
    if (_hoverPending) return;
    _hoverPending = true;
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        _hoverPending = false;
        drawCandles(CHART_ROWS);
        var r = CHART_ROWS[CHART_HOVER];
        var info = $id('o-chart-info');
        if (r && info) {
          info.textContent = fmtCandleTime(r.t) + '  O ' + fmt(r.o, 3) + '  H ' + fmt(r.h, 3) +
            '  L ' + fmt(r.l, 3) + '  C ' + fmt(r.c, 3) + '  V ' + r.v;
        }
      });
    } else {
      _hoverPending = false;
    }
  }

  function bindChartHover() {
    var canvas = $id('o-candles');
    if (!canvas) return;
    canvas.addEventListener('mousemove', onChartMove);
    canvas.addEventListener('mouseleave', function () {
      CHART_HOVER = -1;
      drawCandles(CHART_ROWS);
    });
    canvas.addEventListener('wheel', onChartWheel, { passive: false });
    canvas.addEventListener('dblclick', function () {
      resetChartView();
      drawCandles(CHART_ROWS);
    });
  }

  // ── тип графика ─────────────────────────────────
  function setActiveType() {
    var btns = document.querySelectorAll('#o-chart-type-group .interval-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-type') === CHART_TYPE);
    }
  }

  function initChartType() {
    var group = $id('o-chart-type-group');
    if (!group) return;
    group.innerHTML = CHART_TYPES.map(function (t) {
      return '<button type="button" class="interval-btn" data-type="' + t.key + '">' + t.label + '</button>';
    }).join('');
    group.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.interval-btn') : null;
      if (!b) return;
      var type = b.getAttribute('data-type');
      if (window.ObPanelSettings) {
        window.ObPanelSettings.setSetting('chart', 'type', type);
      } else {
        CHART_TYPE = type;
        setActiveType();
        drawCandles(CHART_ROWS);
      }
    });
    setActiveType();
  }

  // ── настройки страницы (паттерн panel settings) ──
  function applyPageSettings() {
    var P = window.ObPanelSettings;
    var s = P ? P.getSettings() : null;
    if (s) {
      if (s.book) {
        if (s.book.depth) BOOK_DEPTH = s.book.depth;
        if (s.book.refreshSec) REFRESH_SEC = s.book.refreshSec;
      }
      if (s.chart) {
        if (s.chart.type) CHART_TYPE = s.chart.type;
        CHART_SHOW_VOLUME = s.chart.showVolume !== false;
        CHART_SHOW_LABELS = s.chart.showLabels !== false;
      }
      if (s.history && s.history.rows) HISTORY_LIMIT = s.history.rows;
      if (s.summary && s.summary.metrics) SUMMARY_METRICS = s.summary.metrics.slice();
      if (s.analytics) ANALYTICS_EMBED = s.analytics.embed !== false;
    }
    setActiveType();
    if (POLLING) scheduleTimers();
    if (ACTIVE_TAB === 'chart' && CHART_ROWS.length) drawCandles(CHART_ROWS);
    else if (ACTIVE_TAB === 'history') drawSpark(HISTORY_ROWS);
    else if (ACTIVE_TAB === 'summary') renderSummary();
    else if (ACTIVE_TAB === 'analytics') updateAnalytics();
    if (ACTIVE_TAB === 'book' && LAST_BOOK) renderBook(LAST_BOOK);
  }

  function applyPanelVisibility() {
    var P = window.ObPanelSettings;
    var vis = P ? P.getVisible() : null;
    PAGE_PANELS.forEach(function (pid) {
      var visible = !vis || vis[pid] !== false;
      var tab = document.querySelector('#o-tabs .ob-tab[data-tab="' + pid + '"]');
      if (tab) tab.style.display = visible ? '' : 'none';
      var pane = $id('o-tab-' + pid);
      if (pane && !visible) pane.style.display = 'none';
    });
    if (vis && vis[ACTIVE_TAB] === false) {
      for (var i = 0; i < PAGE_PANELS.length; i++) {
        if (vis[PAGE_PANELS[i]] !== false) { activateTab(PAGE_PANELS[i]); break; }
      }
    }
  }

  function renderSummary() {
    var grid = $id('o-summary-grid');
    if (!grid) return;
    var d = LAST_BOOK || {};
    var bids = d.bids || [], asks = d.asks || [];
    var bestBid = bids.length ? +bids[0][0] : null;
    var bestAsk = asks.length ? +asks[0][0] : null;
    var mid = d.mid != null ? +d.mid : (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null);
    var spread = d.spread != null ? +d.spread : (bestBid != null && bestAsk != null ? bestAsk - bestBid : null);
    var spreadPct = (mid && spread != null) ? (spread / mid) * 100 : null;
    var sumBid = 0, sumAsk = 0;
    bids.slice(0, BOOK_DEPTH).forEach(function (r) { sumBid += +r[1] || 0; });
    asks.slice(0, BOOK_DEPTH).forEach(function (r) { sumAsk += +r[1] || 0; });
    var total = sumBid + sumAsk;
    var imbalance = total ? (sumBid - sumAsk) / total : null;
    var h = LAST_HEALTH || {};
    var dbBytes = h.db && h.db.bytes != null ? h.db.bytes : null;

    var values = {
      bestBid: fmt(bestBid, 4),
      bestAsk: fmt(bestAsk, 4),
      mid: fmt(mid, 4),
      spread: fmt(spread, 4),
      spreadPct: spreadPct == null ? '—' : spreadPct.toFixed(3) + '%',
      sumBid: String(Math.round(sumBid)),
      sumAsk: String(Math.round(sumAsk)),
      imbalance: imbalance == null ? '—' : (imbalance * 100).toFixed(1) + '%',
      bookTime: d.book_time ? String(d.book_time).replace('T', ' ').replace('+00:00', '') : '—',
      updates: h.updates != null ? String(h.updates) : '—',
      historyRows: String(h.history_rows != null ? h.history_rows : (HISTORY_ROWS || []).length),
      dbBytes: dbBytes == null ? '—' : fmtBytes(dbBytes)
    };

    var on = (SUMMARY_METRICS && SUMMARY_METRICS.length) ? SUMMARY_METRICS : Object.keys(SUMMARY_META);
    grid.innerHTML = on.filter(function (k) { return SUMMARY_META[k]; }).map(function (k) {
      return '<div class="ob-summary-card"><div class="ob-summary-label">' + SUMMARY_META[k] +
        '</div><div class="ob-summary-value">' + (values[k] || '—') + '</div></div>';
    }).join('');
  }

  function updateAnalytics() {
    var host = $id('o-analytics-host');
    if (!host) return;
    if (!ANALYTICS_EMBED) {
      if (ANALYTICS_LOADED) host.innerHTML = '';
      ANALYTICS_LOADED = false;
      host.innerHTML = '<a class="btn" href="/analytics" target="_blank" rel="noopener">Открыть «Аналитику» в новой вкладке →</a>';
      return;
    }
    if (ANALYTICS_LOADED) return;
    host.innerHTML = '<iframe class="ob-analytics-frame" src="/analytics" title="Аналитика"></iframe>';
    ANALYTICS_LOADED = true;
  }

  function bindPanelsButton() {
    var btn = $id('o-panels-btn');
    if (!btn) return;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (window.ObPanelSettings) window.ObPanelSettings.open();
    });
  }

  // ── polling ─────────────────────────────────────
  function scheduleTimers() {
    TIMERS.forEach(function (t) { clearInterval(t); });
    TIMERS = [];
    TIMERS.push(setInterval(loadBook, Math.max(1, REFRESH_SEC) * 1000));
    TIMERS.push(setInterval(loadHealth, 3000));
    TIMERS.push(setInterval(loadHistory, 3000));
    TIMERS.push(setInterval(loadCandles, 20000));
  }

  function startPolling() {
    stopPolling();
    POLLING = true;
    loadBook(); loadHealth(); loadHistory(); loadCandles();
    scheduleTimers();
  }

  function stopPolling() {
    POLLING = false;
    TIMERS.forEach(function (t) { clearInterval(t); });
    TIMERS = [];
  }

  bindLogin();
  bindTabs();
  applyPageSettings();
  initChartType();
  initChartControls();
  bindChartHover();
  bindPanelsButton();
  applyPanelVisibility();
  document.addEventListener('ob-panels-change', function () { applyPanelVisibility(); });
  document.addEventListener('ob-settings-change', function () { applyPageSettings(); });
  window.addEventListener('resize', function () {
    if (ACTIVE_TAB === 'chart') drawCandles(CHART_ROWS);
    else if (ACTIVE_TAB === 'history') drawSpark(HISTORY_ROWS);
  });
  restore();
})();
