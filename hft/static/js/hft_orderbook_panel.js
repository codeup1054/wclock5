/* hft_orderbook_panel.js — панель «Стакан» для HFT-дашборда
 * (компактная книга заявок в .hft-panel-body; полная страница — /orderbook).
 * Данные: /api/hft/orderbook (поток T-Invest в orderbook.py).
 * Настройки: localStorage hft_ob_cfg {depth, refreshSec}, событие hftObCfgChange.
 * Публичный API: window.HftOrderbook = { start(host), stop() }.
 */
(function (window) {
  'use strict';

  var CFG_KEY = 'hft_ob_cfg';
  var DEFAULT_CFG = { depth: 10, refreshSec: 2 };

  var alive = false;
  var host = null;
  var timer = null;
  var cfg = null;

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* noop */ } }

  function loadCfg() {
    var raw = lsGet(CFG_KEY);
    var c = { depth: DEFAULT_CFG.depth, refreshSec: DEFAULT_CFG.refreshSec };
    if (raw) {
      try {
        var o = JSON.parse(raw);
        if (typeof o.depth === 'number' && o.depth >= 1 && o.depth <= 40) c.depth = o.depth;
        if (typeof o.refreshSec === 'number' && o.refreshSec >= 1 && o.refreshSec <= 60) c.refreshSec = o.refreshSec;
      } catch (e) { /* ignore */ }
    }
    return c;
  }

  function saveCfg(obj) {
    var c = loadCfg();
    Object.keys(obj).forEach(function (k) { c[k] = obj[k]; });
    lsSet(CFG_KEY, JSON.stringify(c));
    cfg = c;
  }

  function fmt(n, digits) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  async function api(url) {
    var resp = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
    var data;
    try { data = await resp.json(); } catch (e) { data = { ok: false, error: 'bad response' }; }
    if (!resp.ok || data.ok === false) {
      var er = new Error(data.error || ('HTTP ' + resp.status));
      er.status = resp.status;
      throw er;
    }
    return data;
  }

  // одна колонка стакана: side 'bid'|'ask'
  function renderSide(side, rows, maxQty) {
    var col = document.createElement('div');
    col.className = 'ob-widget-col';

    var head = document.createElement('div');
    head.className = 'ob-widget-col-head ' + side;
    head.textContent = side === 'bid' ? 'BID' : 'ASK';
    col.appendChild(head);

    var rowsWrap = document.createElement('div');
    rowsWrap.className = 'ob-widget-rows';
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var price = r[0];
      var qty = r[1];
      var pct = maxQty > 0 ? Math.round((qty / maxQty) * 100) : 0;
      var row = document.createElement('div');
      row.className = 'ob-widget-row';
      var bar = document.createElement('span');
      bar.className = 'ob-widget-bar ' + side;
      bar.style.width = pct + '%';
      var priceEl = document.createElement('span');
      priceEl.className = 'ob-widget-price';
      priceEl.textContent = fmt(price, 6);
      var qtyEl = document.createElement('span');
      qtyEl.className = 'ob-widget-qty';
      qtyEl.textContent = fmt(qty, 2);
      row.appendChild(bar);
      row.appendChild(priceEl);
      row.appendChild(qtyEl);
      rowsWrap.appendChild(row);
    }
    col.appendChild(rowsWrap);
    return col;
  }

  function render(d) {
    if (!host) return;
    var depth = cfg.depth;
    var bids = (d.bids || []).slice(0, depth);
    var asks = (d.asks || []).slice(0, depth);
    var maxQty = 1;
    b2h(bids, asks).forEach(function (q) { if (q > maxQty) maxQty = q; });

    var wrap = document.createElement('div');
    wrap.className = 'ob-widget-wrap';

    var head = document.createElement('div');
    head.className = 'ob-widget-head';
    var ticker = document.createElement('span');
    ticker.className = 'ob-widget-ticker';
    ticker.textContent = d.ticker || '—';
    var mid = document.createElement('span');
    mid.className = 'ob-widget-mid';
    mid.textContent = 'mid ' + fmt(d.mid, 6);
    var spread = document.createElement('span');
    spread.className = 'ob-widget-spread';
    spread.textContent = 'спред ' + fmt(d.spread, 6);
    var time = document.createElement('span');
    time.className = 'ob-widget-time';
    time.textContent = (d.book_time || '').replace('T', ' ').replace('+00:00', '').slice(11, 19) || '';
    head.appendChild(ticker);
    head.appendChild(mid);
    head.appendChild(spread);
    head.appendChild(time);
    wrap.appendChild(head);

    var cols = document.createElement('div');
    cols.className = 'ob-widget-cols';
    cols.appendChild(renderSide('bid', bids, maxQty));
    cols.appendChild(renderSide('ask', asks, maxQty));
    wrap.appendChild(cols);

    host.innerHTML = '';
    host.appendChild(wrap);
  }

  function b2h(bids, asks) {
    var out = [];
    (bids || []).forEach(function (r) { if (r && typeof r[1] === 'number') out.push(r[1]); });
    (asks || []).forEach(function (r) { if (r && typeof r[1] === 'number') out.push(r[1]); });
    return out;
  }

  async function load() {
    if (!alive) return;
    try {
      var d = await api('/api/hft/orderbook');
      if (alive) render(d);
    } catch (e) {
      if (!alive) return;
      if (host) {
        host.innerHTML = '<div class="empty">Стакан недоступен</div>';
      }
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { load(); }, Math.max(cfg.refreshSec, 1) * 1000);
  }

  function onCfgChange(e) {
    var d = e && e.detail;
    if (!d) return;
    var changed = false;
    if (typeof d.depth === 'number' && d.depth !== cfg.depth) { cfg.depth = d.depth; changed = true; }
    if (typeof d.refreshSec === 'number' && d.refreshSec !== cfg.refreshSec) {
      cfg.refreshSec = d.refreshSec;
      changed = true;
    }
    if (changed) {
      try { lsSet(CFG_KEY, JSON.stringify(cfg)); } catch (er) { /* noop */ }
      startTimer();
      load();
    }
  }

  function start(h) {
    host = h;
    alive = true;
    cfg = loadCfg();
    host.innerHTML = '<div class="empty">Загрузка стакана…</div>';
    document.addEventListener('hftObCfgChange', onCfgChange);
    startTimer();
    load();
  }

  function stop() {
    alive = false;
    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener('hftObCfgChange', onCfgChange);
    if (host) host.innerHTML = '';
    host = null;
  }

  window.HftOrderbook = {
    start: start,
    stop: stop,
    refresh: load,
    getCfg: loadCfg,
    setCfg: saveCfg
  };
})(window);