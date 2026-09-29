/* report.js — панель «Отчёт» для HFT (порт wclock report.js на ванильный JS).
 * Панель встраивается в .hft-panel-body: вкладки «Инвестиции» / «Ошибки бота».
 * Данные: /api/hft/report (read_report) и /api/hft/bot_events (read_bot_events).
 */
(function (window) {
  'use strict';

  // Стаб-хук: переопределяется в hft.js (подключается позже).
  // Определён здесь, чтобы контракт глобалов не ругался на порядок загрузки.
  window.HftReportOnClose = window.HftReportOnClose || function () {};

  var SOURCES = ['finam', 'tinkoff'];
  var SRCLABEL = { finam: 'F', tinkoff: 'T' };

  var INTERVALS = [
    { key: 'day', label: 'День' },
    { key: '3day', label: '3 дня' },
    { key: 'week', label: 'Неделя' },
    { key: 'month', label: 'Месяц' }
  ];
  var PERIODS = [
    { key: '-7 day', label: 'Неделя' },
    { key: '-35 day', label: 'Месяц' },
    { key: '-90 day', label: '3 месяца' },
    { key: '-365 day', label: 'Год' }
  ];

  var host = null;
  var modalEl = null;
  var state = { interval: 'day', period: '-35 day', loading: false, data: null, rows: null, sort: { key: 'label', src: null, dir: -1 } };

  var BOT_LVL = {
    block: { label: 'Блокировка', icon: '🚨' },
    warn: { label: 'Предупреждение', icon: '⚠' },
    info: { label: 'Инфо', icon: '✅' }
  };
  var BOT_CATS = ['balance', 'ratio', 'order', 'stat', 'tradecycle', 'lib', 'reminder', 'ok', 'session', 'analytics', 'balance_chip', 'other'];
  var BOT_CATLABEL = {
    balance: 'Баланс', ratio: 'Ratio', order: 'Ордера', stat: 'T-test',
    tradecycle: 'Цикл торговли', lib: 'Ликвидность', reminder: 'Напоминание',
    ok: 'Восстановление', session: 'Сессия', analytics: 'Аналитика',
    balance_chip: 'Баланс-чип', other: 'Прочее'
  };
  var stateBot = {
    interval: 'day', period: '-35 day', errorsOnly: false, category: 'all',
    loading: false, loaded: false, events: [], sort: { key: 'ts', dir: -1 }
  };

  // ── утилиты ─────────────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function botMs(ts) { return (Number(ts) || 0) * 1000 + 3 * 3600 * 1000; }
  function botDayStr(ts) {
    var x = new Date(botMs(ts));
    return x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate());
  }
  function botHm(ts) {
    var x = new Date(botMs(ts));
    return pad(x.getUTCHours()) + ':' + pad(x.getUTCMinutes());
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function botShortChat(chat) {
    return /Финам/.test(chat) ? 'Финам' : (/Т-Инвест|Тинькофф/.test(chat) ? 'Т-Инвест' : chat);
  }
  var BOT_CHAN_ABBR = { 'Финам': 'Ф', 'Т-Инвест': 'Т' };
  var BOT_ACC_ABBR = {
    'prod_finam_tgld_sergey': 'PFTS', 'preprod_finam_tgld_sergey': 'PFTS',
    'preprod_tinv_btc_david': 'PTBD', 'prod_tinkoff_tgld_sergey': 'PTKS',
    'sergey_brok': 'SB', 'finam': 'Ф', 'tinkoff': 'Т'
  };
  var BOT_CATABBR = {
    balance: 'Бал', ratio: 'Rat', order: 'Орд', stat: 'T', tradecycle: 'Цикл',
    lib: 'Лик', reminder: 'Нап', ok: 'Ок', session: 'Сесс', analytics: 'Анал',
    balance_chip: 'Чип', other: 'Проч'
  };

  function round2(x) { return Math.round(x * 100) / 100; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseDay(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  function groupKey(date, interval) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (interval === 'day') return iso(d);
    if (interval === '3day') {
      var days = Math.floor(d.getTime() / 86400000);
      var mod = ((days % 3) + 3) % 3;
      return iso(new Date((days - mod) * 86400000));
    }
    if (interval === 'week') {
      var dow = (d.getDay() + 6) % 7;
      return iso(addDays(d, -dow));
    }
    return iso(new Date(d.getFullYear(), d.getMonth(), 1));
  }

  function fmt(x, d) { return x == null ? '' : (typeof x === 'number' ? x.toLocaleString('ru-RU', { maximumFractionDigits: d == null ? 2 : d }) : x); }
  function fmtRub(x) { return x == null ? '' : Math.round(x).toLocaleString('ru-RU'); }
  function fmtPct(x) { return x == null ? '' : fmt(x) + '%'; }
  function fmtPct4(x) { return x == null ? '' : (typeof x === 'number' ? x.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + '%' : x + '%'); }
  function round4(x) { return Math.round(x * 10000) / 10000; }
  function fmtVal(x) { var s = fmtRub(x); return x < 0 ? '<span class="r-neg">' + s + '</span>' : s; }
  function fmtPctVal(x) { var s = fmtPct(x); return x < 0 ? '<span class="r-neg">' + s + '</span>' : s; }
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var OFF_MD = ['01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
    '02-23', '03-08', '05-01', '05-09', '06-12', '11-04'];
  var OFF_EXTRA = { '2025-12-31': 1, '2026-01-09': 1, '2026-03-09': 1, '2026-05-11': 1, '2026-12-31': 1 };
  function isOffDay(dateStr) {
    if (!dateStr || dateStr.length !== 10) return false;
    if (OFF_EXTRA[dateStr]) return true;
    var p = dateStr.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var dow = d.getDay();
    if (dow === 0 || dow === 6) return true;
    return OFF_MD.indexOf(p[1] + '-' + p[2]) !== -1;
  }

  // ── агрегация (та же логика, что в wclock report.js) ──────
  function aggCell(entries, src) {
    var cell = {
      has: false, days: entries.length,
      cap_start: null, cap_end: null, changeRub: null, changePct: null,
      volume: 0, rateSum: 0, rateN: 0, commission: 0
    };
    var firstCap = null, lastCap = null;
    entries.forEach(function (e) {
      var v = e && e[src];
      if (!v) return;
      cell.has = true;
      if (v.cap_start != null && firstCap == null) firstCap = v.cap_start;
      if (v.cap_end != null) lastCap = v.cap_end;
      cell.volume += (v.volume || 0);
      cell.commission += (v.commission || 0);
      if (v.rate != null) { cell.rateSum += v.rate; cell.rateN++; }
    });
    cell.cap_start = firstCap;
    cell.cap_end = lastCap;
    if (cell.cap_start != null && cell.cap_end != null) {
      cell.changeRub = round2(cell.cap_end - cell.cap_start);
      cell.changePct = round2((cell.cap_end - cell.cap_start) / cell.cap_start * 100);
    }
    cell.volume = round2(cell.volume);
    cell.commission = round2(cell.commission);
    return cell;
  }
  function aggAll(entries) {
    var out = {};
    SOURCES.forEach(function (src) { out[src] = aggCell(entries, src); });
    return out;
  }

  function buildSummary(days) {
    var dates = Object.keys(days).sort();
    var entries = dates.map(function (k) { return days[k]; });
    var c = aggAll(entries);
    var combinedEntries = dates.map(function (k) {
      var e = days[k], f = e && e.finam, t = e && e.tinkoff;
      var fcs = f && f.cap_start != null, tcs = t && t.cap_start != null;
      var fce = f && f.cap_end != null, tce = t && t.cap_end != null;
      return { combined: {
        cap_start: (fcs || tcs) ? round2((fcs ? f.cap_start : 0) + (tcs ? t.cap_start : 0)) : null,
        cap_end: (fce || tce) ? round2((fce ? f.cap_end : 0) + (tce ? t.cap_end : 0)) : null,
        volume: round2(((f && f.volume) || 0) + ((t && t.volume) || 0)),
        commission: round2(((f && f.commission) || 0) + ((t && t.commission) || 0)),
        rate: null
      } };
    });
    var combinedCell = aggCell(combinedEntries, 'combined');
    var tradeDays = dates.length;
    var out = {};
    function make(src, cell, rateAvg) {
      out[src] = {
        src: src,
        tradeDays: tradeDays,
        dateRange: dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : dates[0] + ' — ' + dates[dates.length - 1]) : '',
        cap_start: cell.cap_start,
        cap_end: cell.cap_end,
        changeRub: cell.changeRub,
        changePct: cell.changePct,
        avgChangeRub: cell.days ? round2(cell.changeRub / cell.days) : null,
        avgChangePct: cell.days ? round2(cell.changePct / cell.days) : null,
        volume: cell.volume,
        avgVolume: cell.days ? round2(cell.volume / cell.days) : null,
        rateAvg: rateAvg != null ? rateAvg : (cell.rateN ? round4(cell.rateSum / cell.rateN) : null),
        commission: cell.commission,
        avgCommission: cell.days ? round2(cell.commission / cell.days) : null
      };
    }
    SOURCES.forEach(function (src) { make(src, c[src], null); });
    make('combined', combinedCell, combinedCell.volume ? round4(combinedCell.commission / combinedCell.volume * 100) : null);
    return out;
  }

  function buildRows(days, interval) {
    var groups = {};
    Object.keys(days).forEach(function (dateStr) {
      var key = groupKey(parseDay(dateStr), interval);
      var g = groups[key] || (groups[key] = { start: null, end: null, entries: [] });
      if (!g.start || dateStr < g.start) g.start = dateStr;
      if (!g.end || dateStr > g.end) g.end = dateStr;
      g.entries.push(days[dateStr]);
    });
    return Object.keys(groups).sort().map(function (key) {
      var g = groups[key];
      var label = interval === 'month' ? g.start.slice(0, 7) : (g.start === g.end ? g.start : g.start + ' — ' + g.end);
      return { label: label, start: g.start, end: g.end, cells: aggAll(g.entries) };
    });
  }

  // сортировка
  function colGetter(key, src) {
    if (key === 'label') return function (r) { return r.start; };
    if (key === 'days') return function (r) { return r.cells.finam.days; };
    return function (r) {
      var c = r.cells[src];
      if (!c) return null;
      if (key === 'rate') return c.rateN ? c.rateSum / c.rateN : null;
      return c[key];
    };
  }
  function sortRows() {
    var s = state.sort, get = colGetter(s.key, s.src);
    return state.rows.slice().sort(function (a, b) {
      var av = get(a), bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number') return (av - bv) * s.dir;
      return (av < bv ? -1 : av > bv ? 1 : 0) * s.dir;
    });
  }

  // CSV
  function csvValue(x) { return x == null ? '' : String(x).replace('.', ','); }
  function csvRate(x) { return x == null ? '' : x.toFixed(4).replace('.', ','); }

  function buildCsv(rows, summary) {
    var lines = ['Отчёт по портфелю', 'Интервал;' + state.interval + ';Период;' + state.period, '', 'СВОДКА ЗА ПЕРИОД', 'Показатель;F (Финам);T (Тинькофф);F+T'];
    var sumRows = [
      ['Период дат', function (s) { return s.dateRange; }],
      ['Торговых дней, шт', function (s) { return s.tradeDays; }],
      ['Капитал на начало, ₽', function (s) { return csvValue(s.cap_start); }],
      ['Капитал на конец, ₽', function (s) { return csvValue(s.cap_end); }],
      ['Изменение капитала за период, ₽', function (s) { return csvValue(s.changeRub); }],
      ['Среднее изменение капитала в день, ₽', function (s) { return csvValue(s.avgChangeRub); }],
      ['Изменение капитала за период, %', function (s) { return csvValue(s.changePct); }],
      ['Среднее изменение капитала в день, %', function (s) { return csvValue(s.avgChangePct); }],
      ['Объём за период, ₽', function (s) { return csvValue(s.volume); }],
      ['Объём средний в день, ₽', function (s) { return csvValue(s.avgVolume); }],
      ['Ставка комиссии средняя, %', function (s) { return csvRate(s.rateAvg); }],
      ['Комиссия за период, ₽', function (s) { return csvValue(s.commission); }],
      ['Комиссия средняя в день, ₽', function (s) { return csvValue(s.avgCommission); }]
    ];
    sumRows.forEach(function (r) {
      lines.push(r[0] + ';' + r[1](summary.finam) + ';' + r[1](summary.tinkoff) + ';' + r[1](summary.combined));
    });
    lines.push('', 'ДЕТАЛИЗАЦИЯ' + (state.interval === 'day' ? ' (по дням)' : state.interval === '3day' ? ' (по 3 дня)' : ' (по ' + state.interval + 'ам)'));
    var flat = [];
    SOURCES.forEach(function (src) {
      ['Начало', 'Конец', 'Изм ₽', 'Изм %', 'Объём ₽', 'Ставка %', 'Комиссия ₽'].forEach(function (h) {
        flat.push(SRCLABEL[src] + ' ' + h);
      });
    });
    lines.push('Дата;Дней;' + flat.join(';'));
    rows.forEach(function (r) {
      var line = [r.label, r.cells.finam.days];
      SOURCES.forEach(function (src) {
        var c = r.cells[src];
        var rate = c.rateN ? round4(c.rateSum / c.rateN) : null;
        line.push(csvValue(c.cap_start), csvValue(c.cap_end), csvValue(c.changeRub), csvValue(c.changePct),
          csvValue(c.volume), csvRate(rate), csvValue(c.commission));
      });
      lines.push(line.join(';'));
    });
    return lines.join('\r\n');
  }

  function downloadFile(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  // ── рендер «Инвестиции» ────────────────────────────────────
  function renderSummary(summary) {
    var tb = $('#report-summary-tbody', host);
    if (!summary) { tb.innerHTML = '<tr><td colspan="4">Нет данных</td></tr>'; return; }
    function row(label, fn) {
      return '<tr><td class="r-label">' + label + '</td>' + ['finam', 'tinkoff', 'combined'].map(function (s) {
        var v = fn(summary[s]);
        return '<td>' + (v == null || v === '' ? '<span class="r-empty">—</span>' : v) + '</td>';
      }).join('') + '</tr>';
    }
    tb.innerHTML =
      row('Период дат', function (s) { return s.dateRange + ' <span class="r-sub">(' + s.tradeDays + ' торг. дн.)</span>'; }) +
      row('Капитал на начало, ₽', function (s) { return fmtRub(s.cap_start); }) +
      row('Капитал на конец, ₽', function (s) { return fmtRub(s.cap_end); }) +
      row('Изменение капитала за период, ₽', function (s) { return fmtVal(s.changeRub); }) +
      row('Среднее изменение капитала в день, ₽', function (s) { return fmtVal(s.avgChangeRub); }) +
      row('Изменение капитала за период, %', function (s) { return fmtPctVal(s.changePct); }) +
      row('Среднее изменение капитала в день, %', function (s) { return fmtPctVal(s.avgChangePct); }) +
      row('Объём за период, ₽', function (s) { return fmtRub(s.volume); }) +
      row('Объём средний в день, ₽', function (s) { return fmtRub(s.avgVolume); }) +
      row('Ставка комиссии средняя, %', function (s) { return fmtPct4(s.rateAvg); }) +
      row('Комиссия за период, ₽', function (s) { return fmtRub(s.commission); }) +
      row('Комиссия средняя в день, ₽', function (s) { return fmtRub(s.avgCommission); });
  }

  function renderTable(rows) {
    var tb = $('#report-table-tbody', host);
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="15">Нет данных</td></tr>'; return; }
    tb.innerHTML = rows.map(function (r) {
      var off = (state.interval === 'day' && isOffDay(r.label)) ? ' class="r-off"' : '';
      var line = '<tr' + off + '><td class="r-date">' + r.label + '</td><td>' + r.cells.finam.days + '</td>';
      SOURCES.forEach(function (src) {
        var c = r.cells[src];
        var rate = c.rateN ? round4(c.rateSum / c.rateN) : null;
        line += '<td>' + fmtRub(c.cap_start) + '</td><td>' + fmtRub(c.cap_end) + '</td><td>' + fmtVal(c.changeRub) + '</td>' +
          '<td>' + fmtPctVal(c.changePct) + '</td><td>' + fmtRub(c.volume) + '</td><td>' + fmtPct4(rate) + '</td><td>' + fmtRub(c.commission) + '</td>';
      });
      return line + '</tr>';
    }).join('');
  }

  function render() {
    var st = $('#report-status', host);
    if (!state.data) { st.textContent = 'Данных нет'; return; }
    var summary = buildSummary(state.data);
    state.rows = buildRows(state.data, state.interval);
    st.textContent = 'Период: ' + PERIODS.filter(function (p) { return p.key === state.period; })[0].label +
      ' · интервал: ' + INTERVALS.filter(function (i) { return i.key === state.interval; })[0].label +
      ' · дней в периоде: ' + Object.keys(state.data).length;
    renderSummary(summary);
    renderTable(sortRows());
  }

  function load() {
    if (state.loading) return;
    state.loading = true;
    $('#report-status', host).textContent = 'Загрузка…';
    fetch('/api/hft/report?period=' + encodeURIComponent(state.period) + '&_=' + Date.now(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.data = (d && d.days) ? d.days : null;
        render();
      })
      .catch(function () { $('#report-status', host).textContent = 'Ошибка загрузки данных'; })
      .finally(function () { state.loading = false; });
  }

  // ── таб «Ошибки бота» ──────────────────────────────────────
  function botFiltered() {
    var ev = stateBot.events;
    if (stateBot.errorsOnly) ev = ev.filter(function (e) { return e.level !== 'info'; });
    if (stateBot.category !== 'all') ev = ev.filter(function (e) { return e.category === stateBot.category; });
    return ev;
  }
  function botBuildTimeline(ev) {
    var groups = {};
    ev.forEach(function (e) {
      var ds = botDayStr(e.ts);
      var key = groupKey(parseDay(ds), stateBot.interval);
      var g = groups[key] || (groups[key] = { start: null, end: null, block: 0, warn: 0, info: 0, total: 0 });
      if (g.start == null || ds < g.start) g.start = ds;
      if (g.end == null || ds > g.end) g.end = ds;
      g[e.level]++;
      g.total++;
    });
    return Object.keys(groups).sort().map(function (key) {
      var g = groups[key];
      var label = stateBot.interval === 'month' ? g.start.slice(0, 7) : (g.start === g.end ? g.start : g.start + ' — ' + g.end);
      return { label: label, block: g.block, warn: g.warn, info: g.info, total: g.total };
    });
  }
  function botAgg(ev, keyField) {
    var o = {};
    ev.forEach(function (e) {
      var k = e[keyField];
      var g = o[k] || (o[k] = { block: 0, warn: 0, info: 0, total: 0, level: 'info' });
      g[e.level]++;
      g.total++;
      if (g.block) g.level = 'block';
      else if (g.warn) g.level = 'warn';
    });
    return Object.keys(o).map(function (k) { return { key: k, block: o[k].block, warn: o[k].warn, info: o[k].info, total: o[k].total, level: o[k].level }; })
      .sort(function (a, b) { return b.total - a.total; });
  }
  function botSortedEvents(ev) {
    var s = stateBot.sort;
    return ev.slice().sort(function (a, b) {
      var av = a[s.key], bv = b[s.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number') return (av - bv) * s.dir;
      return (String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0) * s.dir;
    });
  }
  function botBadge(level) {
    var m = BOT_LVL[level] || BOT_LVL.info;
    return '<span class="be-lvl be-' + level + '" title="' + m.icon + ' ' + m.label + '">' +
      (level === 'block' ? '🚨 Б' : level === 'warn' ? '⚠ П' : '✅ И') + '</span>';
  }
  function botLvlTd(n, level) {
    return n ? '<td class="be-' + level + '">' + n + '</td>' : '<td class="r-empty">—</td>';
  }

  function renderBot() {
    var st = $('#bot-status', host);
    if (!stateBot.loaded) { st.textContent = 'Загрузка…'; return; }
    var ev = botFiltered();
    var tim = botBuildTimeline(ev);
    var cats = botAgg(ev, 'category');
    var accs = botAgg(ev, 'account');
    var chs = botAgg(ev, 'chat');
    var lv = { block: 0, warn: 0, info: 0 };
    ev.forEach(function (e) { lv[e.level]++; });
    var range = '';
    if (stateBot.events.length) {
      var min = stateBot.events[0].ts, max = stateBot.events[0].ts;
      stateBot.events.forEach(function (e) { if (e.ts < min) min = e.ts; if (e.ts > max) max = e.ts; });
      range = botDayStr(min) + ' — ' + botDayStr(max);
    }
    st.textContent =
      'Период: ' + PERIODS.filter(function (p) { return p.key === stateBot.period; })[0].label +
      ' · интервал: ' + INTERVALS.filter(function (i) { return i.key === stateBot.interval; })[0].label +
      ' · диапазон: ' + range +
      ' · сообщений: ' + stateBot.events.length +
      (stateBot.errorsOnly ? ' (фильтр: только ошибки)' : '') +
      (stateBot.category !== 'all' ? ' (категория: ' + BOT_CATLABEL[stateBot.category] + ')' : '');

    $('#bot-card-total .bot-card-n', host).textContent = stateBot.events.length;
    $('#bot-card-block .bot-card-n', host).textContent = lv.block;
    $('#bot-card-warn .bot-card-n', host).textContent = lv.warn;
    $('#bot-card-info .bot-card-n', host).textContent = lv.info;

    $('#bot-cat-tbody', host).innerHTML = cats.length ? cats.map(function (c) {
      return '<tr><td>' + (BOT_CATLABEL[c.key] || c.key) + '</td><td>' + botBadge(c.level) + '</td><td>' + c.total + '</td></tr>';
    }).join('') : '<tr><td colspan="3">Нет данных</td></tr>';
    $('#bot-acc-tbody', host).innerHTML = accs.length ? accs.map(function (c) {
      return '<tr><td>' + esc(c.key) + '</td><td>' + c.total + '</td></tr>';
    }).join('') : '<tr><td colspan="2">Нет данных</td></tr>';
    $('#bot-ch-tbody', host).innerHTML = chs.map(function (c) {
      return '<tr><td>' + esc(botShortChat(c.key)) + '</td><td>' + c.total + '</td></tr>';
    }).join('');

    $('#bot-timeline-tbody', host).innerHTML = tim.length ? tim.map(function (r) {
      return '<tr><td class="r-date">' + r.label + '</td>' + botLvlTd(r.block, 'block') + botLvlTd(r.warn, 'warn') + botLvlTd(r.info, 'info') + '<td>' + r.total + '</td></tr>';
    }).join('') : '<tr><td colspan="5">Нет данных за период</td></tr>';

    $('#bot-event-tbody', host).innerHTML = botSortedEvents(ev).slice(0, 3000).map(function (e) {
      var t = e.text;
      var short = t.length > 140 ? t.slice(0, 139) + '…' : t;
      var ch = BOT_CHAN_ABBR[botShortChat(e.chat)] || botShortChat(e.chat);
      var cat = BOT_CATABBR[e.category] || BOT_CATLABEL[e.category] || e.category;
      var acc = BOT_ACC_ABBR[e.account] || e.account;
      return '<tr class="be-row be-row-' + e.level + '"><td class="r-date">' + botDayStr(e.ts) + '</td><td>' + botHm(e.ts) + '</td>' +
        '<td class="be-abbr" title="' + esc(botShortChat(e.chat)) + '">' + esc(ch) + '</td><td>' + botBadge(e.level) + '</td>' +
        '<td class="be-abbr" title="' + esc(BOT_CATLABEL[e.category] || e.category) + '">' + esc(cat) + '</td>' +
        '<td class="be-abbr" title="' + esc(e.account) + '">' + esc(acc) + '</td>' +
        '<td class="be-text" title="' + esc(t) + '">' + esc(short) + '</td></tr>';
    }).join('') || '<tr><td colspan="7">Нет событий</td></tr>';
  }

  function loadBot() {
    if (stateBot.loading) return;
    stateBot.loading = true;
    $('#bot-status', host).textContent = 'Загрузка…';
    fetch('/api/hft/bot_events?period=' + encodeURIComponent(stateBot.period) + '&_=' + Date.now(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        stateBot.events = (d && d.events) ? d.events : [];
        stateBot.loaded = true;
        renderBot();
      })
      .catch(function () { $('#bot-status', host).textContent = 'Ошибка загрузки событий бота'; })
      .finally(function () { stateBot.loading = false; });
  }

  // ── построение DOM ─────────────────────────────────────────
  function build() {
    host.innerHTML =
      '<div class="report-tabs">' +
        '<button class="report-tab active" data-tab="invest">Инвестиции</button>' +
        '<button class="report-tab" data-tab="bot" title="Отчёты об ошибках бота (Telegram)">Ошибки бота</button>' +
      '</div>' +
      '<div id="report-pane-invest">' +
        '<div class="report-controls">' +
          '<div class="report-control-group"><span>Интервал:</span>' +
            INTERVALS.map(function (i) { return '<button class="interval-btn report-int" data-int="' + i.key + '">' + i.label + '</button>'; }).join('') +
          '</div>' +
          '<div class="report-control-group"><span>Период:</span>' +
            '<select class="panel-view-select report-period">' + PERIODS.map(function (p) {
              return '<option value="' + p.key + '">' + p.label + '</option>';
            }).join('') + '</select>' +
          '</div>' +
          '<button id="report-csv" class="interval-btn" title="Экспорт в CSV">⇩ CSV</button>' +
        '</div>' +
        '<div id="report-status" class="report-status"></div>' +
        '<div class="report-summary-title">Сводка за период</div>' +
        '<table class="report-summary-table"><thead><tr><th>Показатель</th><th>F (Финам)</th><th>T (Тинькофф)</th><th>F+T</th></tr></thead>' +
          '<tbody id="report-summary-tbody"></tbody></table>' +
        '<div class="report-table-title">Детализация</div>' +
        '<div class="report-table-wrap"><table class="report-table"><thead><tr>' +
          '<th rowspan="2" data-sort="label">Дата</th><th rowspan="2" data-sort="days">Дней</th>' +
          '<th colspan="7" class="r-src-f">F (Финам)</th><th colspan="7" class="r-src-t">T (Тинькофф)</th>' +
        '</tr><tr>' +
          '<th data-sort="cap_start" data-src="finam">Начало</th><th data-sort="cap_end" data-src="finam">Конец</th><th data-sort="changeRub" data-src="finam">Изм ₽</th><th data-sort="changePct" data-src="finam">Изм %</th><th data-sort="volume" data-src="finam">Объём ₽</th><th data-sort="rate" data-src="finam">Ставка %</th><th data-sort="commission" data-src="finam">Комиссия ₽</th>' +
          '<th data-sort="cap_start" data-src="tinkoff">Начало</th><th data-sort="cap_end" data-src="tinkoff">Конец</th><th data-sort="changeRub" data-src="tinkoff">Изм ₽</th><th data-sort="changePct" data-src="tinkoff">Изм %</th><th data-sort="volume" data-src="tinkoff">Объём ₽</th><th data-sort="rate" data-src="tinkoff">Ставка %</th><th data-sort="commission" data-src="tinkoff">Комиссия ₽</th>' +
        '</tr></thead><tbody id="report-table-tbody"></tbody></table></div>' +
      '</div>' +
      '<div id="report-pane-bot" style="display:none">' +
        '<div class="report-controls">' +
          '<div class="report-control-group"><span>Интервал:</span>' +
            INTERVALS.map(function (i) { return '<button class="interval-btn report-int-bot" data-int="' + i.key + '">' + i.label + '</button>'; }).join('') +
            '<span class="report-cat-sep">Категория:</span>' +
            '<select class="panel-view-select report-cat-bot"><option value="all">Все</option>' +
              BOT_CATS.map(function (c) { return '<option value="' + c + '">' + BOT_CATLABEL[c] + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
          '<div class="report-control-group"><span>Период:</span>' +
            '<select class="panel-view-select report-period-bot">' + PERIODS.map(function (p) {
              return '<option value="' + p.key + '">' + p.label + '</option>';
            }).join('') + '</select>' +
          '</div>' +
          '<label class="report-filt-label" title="Показывать только предупреждения и блокировки"><input type="checkbox" id="bot-errors-only"> только ошибки</label>' +
          '<button id="bot-csv" class="interval-btn" title="Экспорт в CSV">⇩ CSV</button>' +
        '</div>' +
        '<div id="bot-status" class="report-status"></div>' +
        '<div class="bot-cards">' +
          '<div class="bot-card" id="bot-card-total"><div class="bot-card-n"></div><div class="bot-card-l">Сообщений за период</div></div>' +
          '<div class="bot-card bot-card-block" id="bot-card-block"><div class="bot-card-n"></div><div class="bot-card-l">🚨 Блокировки</div></div>' +
          '<div class="bot-card bot-card-warn" id="bot-card-warn"><div class="bot-card-n"></div><div class="bot-card-l">⚠ Предупреждения</div></div>' +
          '<div class="bot-card bot-card-info" id="bot-card-info"><div class="bot-card-n"></div><div class="bot-card-l">✅ Инфо</div></div>' +
        '</div>' +
        '<div class="bot-cols">' +
          '<div class="bot-col"><div class="report-summary-title">Сводка по категориям</div>' +
            '<table class="report-summary-table"><thead><tr><th>Категория</th><th>Уровень</th><th>Кол-во</th></tr></thead><tbody id="bot-cat-tbody"></tbody></table></div>' +
          '<div class="bot-col"><div class="report-summary-title">Сводка по аккаунтам</div>' +
            '<table class="report-summary-table"><thead><tr><th>Аккаунт</th><th>Кол-во</th></tr></thead><tbody id="bot-acc-tbody"></tbody></table>' +
            '<div class="report-summary-title">Сводка по каналам</div>' +
            '<table class="report-summary-table"><thead><tr><th>Канал</th><th>Кол-во</th></tr></thead><tbody id="bot-ch-tbody"></tbody></table></div>' +
        '</div>' +
        '<div class="report-tabs report-tabs-sub">' +
          '<button class="report-tab report-tab-sub active" data-sub="timeline">По интервалу</button>' +
          '<button class="report-tab report-tab-sub" data-sub="events">События</button>' +
        '</div>' +
        '<div class="report-table-wrap" id="bot-view-timeline"><table class="report-table"><thead><tr>' +
          '<th>Период</th><th>🚨 Блокировки</th><th>⚠ Предупреждения</th><th>✅ Инфо</th><th>Всего</th>' +
        '</tr></thead><tbody id="bot-timeline-tbody"></tbody></table></div>' +
        '<div class="report-table-wrap" id="bot-view-events" style="display:none"><table class="report-table"><thead><tr>' +
          '<th>Дата</th><th>Время</th><th>Канал</th><th>Уровень</th><th>Категория</th>' +
          '<th data-bsort="account">Аккаунт</th><th>Текст</th>' +
        '</tr></thead><tbody id="bot-event-tbody"></tbody></table></div>' +
      '</div>';
  }

  function bind() {
    $('.report-tab[data-tab]', host).addEventListener('click', function () {
      var tab = this.getAttribute('data-tab');
      $all('.report-tab[data-tab]', host).forEach(function (b) { b.classList.remove('active'); });
      this.classList.add('active');
      $('#report-pane-invest', host).style.display = tab === 'invest' ? '' : 'none';
      $('#report-pane-bot', host).style.display = tab === 'bot' ? '' : 'none';
      if (tab === 'bot') loadBot();
    });
    $all('.report-int', host).forEach(function (b) {
      b.addEventListener('click', function () {
        $all('.report-int', host).forEach(function (x) { x.classList.remove('active'); });
        this.classList.add('active');
        state.interval = this.getAttribute('data-int');
        render();
      });
    });
    $('.report-period', host).addEventListener('change', function () { state.period = this.value; load(); });
    $('#report-csv', host).addEventListener('click', function () {
      if (state.data) downloadFile('invest_report_' + state.interval + '_' + state.period.replace(/[^-0-9]/g, '') + '.csv', buildCsv(sortRows(), buildSummary(state.data)));
    });
    $all('.report-table th[data-sort]', host).forEach(function (th) {
      th.addEventListener('click', function () {
        var key = this.getAttribute('data-sort');
        var src = this.getAttribute('data-src') || null;
        if (state.sort.key === key && state.sort.src === src) state.sort.dir = -state.sort.dir;
        else state.sort = { key: key, src: src, dir: -1 };
        render();
      });
    });
    $all('.report-int-bot', host).forEach(function (b) {
      b.addEventListener('click', function () {
        $all('.report-int-bot', host).forEach(function (x) { x.classList.remove('active'); });
        this.classList.add('active');
        stateBot.interval = this.getAttribute('data-int');
        renderBot();
      });
    });
    $('.report-period-bot', host).addEventListener('change', function () {
      stateBot.period = this.value;
      stateBot.loaded = false;
      loadBot();
    });
    $('#bot-errors-only', host).addEventListener('change', function () { stateBot.errorsOnly = this.checked; renderBot(); });
    $('.report-cat-bot', host).addEventListener('change', function () { stateBot.category = this.value; renderBot(); });
    $('#bot-csv', host).addEventListener('click', function () { exportBotCsv(); });
    $all('.report-tab-sub', host).forEach(function (b) {
      b.addEventListener('click', function () {
        var sub = this.getAttribute('data-sub');
        $all('.report-tab-sub', host).forEach(function (x) { x.classList.remove('active'); });
        this.classList.add('active');
        $('#bot-view-timeline', host).style.display = sub === 'timeline' ? '' : 'none';
        $('#bot-view-events', host).style.display = sub === 'events' ? '' : 'none';
      });
    });
    var bsort = $('[data-bsort]', host);
    if (bsort) bsort.addEventListener('click', function () {
      var key = this.getAttribute('data-bsort');
      if (stateBot.sort.key === key) stateBot.sort.dir = -stateBot.sort.dir;
      else stateBot.sort = { key: key, dir: -1 };
      renderBot();
    });
    $('.report-int[data-int="' + state.interval + '"]', host).classList.add('active');
    $('.report-period', host).value = state.period;
    $('.report-int-bot[data-int="' + stateBot.interval + '"]', host).classList.add('active');
    $('.report-period-bot', host).value = stateBot.period;
    $('.report-cat-bot', host).value = stateBot.category;
  }

  function exportBotCsv() {
    if (!stateBot.loaded) return;
    var ev = botFiltered();
    var tim = botBuildTimeline(ev);
    var cats = botAgg(ev, 'category');
    var accs = botAgg(ev, 'account');
    var lv = { block: 0, warn: 0, info: 0 };
    ev.forEach(function (e) { lv[e.level]++; });
    var lines = ['Отчёт об ошибках бота'];
    lines.push('Период;' + stateBot.period);
    lines.push('Фильтр;' + (stateBot.errorsOnly ? 'только ошибки (block+warn)' : 'все уровни') + ';Категория;' + BOT_CATLABEL[stateBot.category]);
    lines.push('', 'СВОДКА', 'Всего сообщений;' + ev.length, 'Блокировки (block);' + lv.block, 'Предупреждения (warn);' + lv.warn, 'Инфо (info);' + lv.info);
    lines.push('', 'ПО КАТЕГОРИЯМ', 'Категория;Уровень;Кол-во');
    cats.forEach(function (c) { lines.push((BOT_CATLABEL[c.key] || c.key) + ';' + c.level + ';' + c.total); });
    lines.push('', 'ПО АККАУНТАМ', 'Аккаунт;Кол-во');
    accs.forEach(function (c) { lines.push(c.key + ';' + c.total); });
    lines.push('', 'ПО ИНТЕРВАЛУ (' + stateBot.interval + ')', 'Период;Блокировки;Предупреждения;Инфо;Всего');
    tim.forEach(function (r) { lines.push([r.label, r.block, r.warn, r.info, r.total].join(';')); });
    lines.push('', 'СОБЫТИЯ', 'Дата;Время;Канал;Уровень;Категория;Аккаунт;Тикер;Текст');
    botSortedEvents(ev).forEach(function (e) {
      lines.push([botDayStr(e.ts), botHm(e.ts), botShortChat(e.chat), e.level, BOT_CATLABEL[e.category] || e.category, e.account, e.ticker, '"' + String(e.text).replace(/"/g, '""') + '"'].join(';'));
    });
    downloadFile('bot_errors_' + stateBot.interval + '_' + stateBot.period.replace(/[^-0-9]/g, '') + '.csv', lines.join('\r\n'));
  }

  // ── API ────────────────────────────────────────────────────
  function start(el) {
    host = el;
    build();
    bind();
    load();
  }

  // ── страница «Отчёт» (встраивается в main#stage) ─────────────
  // Модальный overlay не используется: контент рендерится в переданный
  // контейнер (страницу) приложения. Вёрстка — классы panels-modal-content /
  // report-modal-content, как в модалке wclock.
  function buildModal(hostPage) {
    var content = document.createElement('div');
    content.className = 'panels-modal-content report-modal-content';
    var header = document.createElement('div');
    header.className = 'panels-modal-header';
    header.innerHTML = '<h3>Отчёт</h3><button class="close-modal" title="Закрыть">&times;</button>';
    content.appendChild(header);
    var body = document.createElement('div');
    body.className = 'report-modal-body';
    content.appendChild(body);
    if (hostPage) hostPage.appendChild(content);

    $('.close-modal', content).addEventListener('click', function () { closeModal(); });

    return { content: content, body: body };
  }

  function openModal(hostPage) {
    if (!hostPage || (modalEl && modalEl.host !== hostPage)) closeModal(true);
    if (!modalEl) {
      modalEl = buildModal(hostPage);
      modalEl.host = hostPage;
    }
    start(modalEl.body);
  }

  // silent=true — только убрать страницу, без хука закрытия
  function closeModal(silent) {
    if (modalEl) {
      try {
        if (modalEl.host && modalEl.content.parentNode) {
          modalEl.host.removeChild(modalEl.content);
        }
      } catch (e) { /* noop */ }
      modalEl = null;
    }
    if (!silent && window.HftReportOnClose) window.HftReportOnClose();
  }

  window.HftReport = {
    start: start,
    open: openModal,
    close: closeModal,
    isOpen: function () { return !!modalEl; },
    reload: function () { load(); loadBot(); },
    setInterval: function (k) { state.interval = k; },
    setPeriod: function (p) { state.period = p; },
    botSetInterval: function (k) { stateBot.interval = k; },
    botSetPeriod: function (p) { stateBot.period = p; }
  };
})(window);