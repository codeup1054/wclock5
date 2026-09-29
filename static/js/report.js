// static/js/report.js — Отчёт по портфелю (кнопка O в панели управления)
(function () {
  'use strict';

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

  var state = { interval: 'day', period: '-35 day', loading: false, data: null, rows: null, sort: { key: 'label', src: null, dir: -1 } };

  // ─── Таб «Ошибки бота» ────────────────────────────────────────
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
    loading: false, loaded: false, events: [], sort: { key: 'ts', dir: -1 },
    timelineSort: { key: 'total', dir: -1 }
  };

  // Дата/время событий в МСК (UTC+3), т.к. ts_epoch хранится в UTC
  function botMs(ts) { return (Number(ts) || 0) * 1000 + 3 * 3600 * 1000; }
  function botDayStr(ts) {
    var x = new Date(botMs(ts));
    return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
  }
  function botHm(ts) {
    var x = new Date(botMs(ts));
    return String(x.getUTCHours()).padStart(2, '0') + ':' + String(x.getUTCMinutes()).padStart(2, '0');
  }
  function botShortChat(chat) {
    return /Финам/.test(chat) ? 'Финам' : (/Т-Инвест|Тинькофф/.test(chat) ? 'Т-Инвест' : chat);
  }

  // Сокращения для таблицы «События» (полное имя — в тултипе)
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

  function botCellAbbr(v, map) {
    var abbr = map[v] || v;
    return { abbr: abbr, full: v };
  }

  function round2(x) { return Math.round(x * 100) / 100; }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseDay(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  function groupKey(date, interval) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (interval === 'day') return iso(d);
    if (interval === '3day') {
      var days = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
      var mod = ((days % 3) + 3) % 3;
      return iso(new Date((days - mod) * 86400000));
    }
    if (interval === 'week') {
      var dow = (d.getDay() + 6) % 7;
      return iso(addDays(d, -dow));
    }
    return iso(new Date(d.getFullYear(), d.getMonth(), 1));
  }

  function fmtDateRange(a, b) { return a === b ? a : a + ' — ' + b; }
  function fmt(x, d) { return x == null ? '' : (typeof x === 'number' ? x.toLocaleString('ru-RU', { maximumFractionDigits: d == null ? 2 : d }) : x); }
  function fmtRub(x) { return x == null ? '' : Math.round(x).toLocaleString('ru-RU'); }
  function fmtPct(x) { return x == null ? '' : fmt(x) + '%'; }
  function fmtPct4(x) { return x == null ? '' : (typeof x === 'number' ? x.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + '%' : x + '%'); }
  function round4(x) { return Math.round(x * 10000) / 10000; }
  function fmtVal(x) {
    var s = fmtRub(x);
    return x < 0 ? '<span class="r-neg">' + s + '</span>' : s;
  }
  function fmtPctVal(x) {
    var s = fmtPct(x);
    return x < 0 ? '<span class="r-neg">' + s + '</span>' : s;
  }

  // Выходные по российскому календарю: сб/вс + нерабочие праздничные дни
  // (ст.112 ТК РФ) + переносы Правительства (2025-2026).
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

  // Агрегация группы записей по одному источнику
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

  // Сводка за период (итоги над таблицей)
  function buildSummary(days) {
    var dates = Object.keys(days).sort();
    var entries = dates.map(function (k) { return days[k]; });
    var c = aggAll(entries);

    // F+T: по-дневная сумма источников, затем стандартная агрегация
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
        dateRange: dates.length ? fmtDateRange(dates[0], dates[dates.length - 1]) : '',
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

  // Строки таблицы по интервалу
  function buildRows(days, interval) {
    var groups = {};
    Object.keys(days).forEach(function (dateStr) {
      var key = groupKey(parseDay(dateStr), interval);
      var g = groups[key] || (groups[key] = { start: null, end: null, entries: [] });
      if (!g.start || dateStr < g.start) g.start = dateStr;
      if (!g.end || dateStr > g.end) g.end = dateStr;
      g.entries.push(days[dateStr]);
    });
    var keys = Object.keys(groups).sort();
    return keys.map(function (key) {
      var g = groups[key];
      var label = interval === 'month' ? g.start.slice(0, 7) : fmtDateRange(g.start, g.end);
      return { label: label, start: g.start, end: g.end, cells: aggAll(g.entries) };
    });
  }

  // CSV
  function csvValue(x) { return x == null ? '' : String(x).replace('.', ','); }
  function csvRate(x) { return x == null ? '' : x.toFixed(4).replace('.', ','); }

  // ─── Сортировка детализации ────────────────────────────────────
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

  function applySortIndicator() {
    var $ths = $('#report-table-wrap th[data-sort]');
    if (!$ths.length) return;
    $ths.removeClass('sort-asc sort-desc');
    $('#report-table-wrap th[data-sort]').filter(function () {
      var t = $(this);
      return t.attr('data-sort') === state.sort.key &&
        (t.attr('data-src') || null) === state.sort.src;
    }).addClass(state.sort.dir > 0 ? 'sort-asc' : 'sort-desc');
  }

  function buildCsv(rows, summary) {
    var lines = [];
    lines.push('Отчёт по портфелю');
    lines.push('Интервал;' + state.interval + ';Период;' + state.period);
    lines.push('');
    lines.push('СВОДКА ЗА ПЕРИОД');
    lines.push('Показатель;F (Финам);T (Тинькофф);F+T');
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
    lines.push('');
    lines.push('ДЕТАЛИЗАЦИЯ' + (state.interval === 'day' ? ' (по дням)' : state.interval === '3day' ? ' (по 3 дня)' : ' (по ' + state.interval + 'ам)'));
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

  function exportCsv(rows, summary) {
    var csv = buildCsv(rows, summary);
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'invest_report_' + state.interval + '_' + state.period.replace(/[^-0-9]/g, '') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  // ─── Ошибки бота: фильтры и агрегация ──────────────────────────
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
      var label = stateBot.interval === 'month' ? g.start.slice(0, 7) : fmtDateRange(g.start, g.end);
      return { label: label, start: g.start, block: g.block, warn: g.warn, info: g.info, total: g.total };
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

  function botSortedTimeline(tim) {
    var s = stateBot.timelineSort;
    return tim.slice().sort(function (a, b) {
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
    var abbr = level === 'block' ? '🚨 Б' : level === 'warn' ? '⚠ П' : '✅ И';
    return '<span class="be-lvl be-' + level + '" title="' + m.icon + ' ' + m.label + '">' + abbr + '</span>';
  }
  function botLvlTd(n, level) {
    return n ? '<td class="be-' + level + '">' + n + '</td>' : '<td class="r-empty">—</td>';
  }

  function renderBot() {
    var $pane = $('#report-pane-bot');
    if (!$pane.length) return;
    if (!stateBot.loaded) {
      $('#bot-status').text('Загрузка…');
      return;
    }
    var ev = botFiltered();
    var tim = botBuildTimeline(ev);
    var cats = botAgg(ev, 'category');
    var accs = botAgg(ev, 'account');
    var chs = botAgg(ev, 'chat');
    var lv = { block: 0, warn: 0, info: 0 };
    ev.forEach(function (e) { lv[e.level]++; });
    var range = '';
    if (stateBot.events.length) {
      var begun = new Date(botMs(stateBot.events.reduce(function (m, e) { return e.ts < m ? e.ts : m; }, stateBot.events[0].ts)));
      var ended = new Date(botMs(stateBot.events.reduce(function (m, e) { return e.ts > m ? e.ts : m; }, stateBot.events[0].ts)));
      range = begun.getUTCFullYear() + '-' + String(begun.getUTCMonth() + 1).padStart(2, '0') + '-' + String(begun.getUTCDate()).padStart(2, '0') +
        ' — ' + ended.getUTCFullYear() + '-' + String(ended.getUTCMonth() + 1).padStart(2, '0') + '-' + String(ended.getUTCDate()).padStart(2, '0');
    }
    $('#bot-status').html('Период: ' + PERIODS.filter(function (p) { return p.key === stateBot.period; })[0].label +
      ' · интервал: ' + INTERVALS.filter(function (i) { return i.key === stateBot.interval; })[0].label +
      ' · диапазон: ' + range +
      ' · сообщений: ' + stateBot.events.length +
      (stateBot.errorsOnly ? ' <span class="be-warn-text">(фильтр: только ошибки)</span>' : '') +
      (stateBot.category !== 'all' ? ' <span class="be-warn-text">(категория: ' + BOT_CATLABEL[stateBot.category] + ')</span>' : ''));

    $('#bot-card-total .bot-card-n').text(stateBot.events.length);
    $('#bot-card-block .bot-card-n').text(lv.block);
    $('#bot-card-warn .bot-card-n').text(lv.warn);
    $('#bot-card-info .bot-card-n').text(lv.info);

    $('#bot-cat-tbody').html(cats.length ? cats.map(function (c) {
      return '<tr><td>' + (BOT_CATLABEL[c.key] || c.key) + '</td><td>' + botBadge(c.level) + '</td><td>' + c.total + '</td></tr>';
    }).join('') : '<tr><td colspan="3">Нет данных</td></tr>');
    $('#bot-acc-tbody').html(accs.length ? accs.map(function (c) {
      return '<tr><td>' + c.key + '</td><td>' + c.total + '</td></tr>';
    }).join('') : '<tr><td colspan="2">Нет данных</td></tr>');
    $('#bot-ch-tbody').html(chs.map(function (c) {
      return '<tr><td>' + botShortChat(c.key) + '</td><td>' + c.total + '</td></tr>';
    }).join(''));

    $('#bot-timeline-tbody').html(tim.length ? botSortedTimeline(tim).map(function (r) {
      return '<tr><td class="r-date">' + r.label + '</td>' + botLvlTd(r.block, 'block') + botLvlTd(r.warn, 'warn') + botLvlTd(r.info, 'info') + '<td>' + r.total + '</td></tr>';
    }).join('') : '<tr><td colspan="5">Нет данных за период</td></tr>');

var rows = botSortedEvents(ev).slice(0, 3000);
    $('#bot-event-tbody').html(rows.map(function (e) {
      var t = e.text;
      var short = t.length > 140 ? t.slice(0, 139) + '…' : t;
      var ch = botCellAbbr(botShortChat(e.chat), BOT_CHAN_ABBR);
      var cat = botCellAbbr(BOT_CATLABEL[e.category] || e.category, BOT_CATABBR);
      var acc = botCellAbbr(e.account, BOT_ACC_ABBR);
      return '<tr class="be-row be-row-' + e.level + '"><td class="r-date">' + botDayStr(e.ts) + '</td><td>' + botHm(e.ts) + '</td>' +
        '<td class="be-abbr" title="' + ch.full + '">' + ch.abbr + '</td><td>' + botBadge(e.level) + '</td>' +
        '<td class="be-abbr" title="' + cat.full + '">' + cat.abbr + '</td>' +
        '<td class="be-abbr" title="' + acc.full + '">' + acc.abbr + '</td>' +
        '<td class="be-text" title="' + t.replace(/"/g, '&quot;') + '">' + short + '</td></tr>';
    }).join('') || '<tr><td colspan="7">Нет событий</td></tr>');

    $pane.find('th[data-bsort]').removeClass('sort-asc sort-desc').filter(function () {
      return $(this).attr('data-bsort') === stateBot.sort.key;
    }).addClass(stateBot.sort.dir > 0 ? 'sort-asc' : 'sort-desc');

    $('#bot-view-timeline th[data-sort]').removeClass('sort-asc sort-desc').filter(function () {
      return $(this).attr('data-sort') === stateBot.timelineSort.key;
    }).addClass(stateBot.timelineSort.dir > 0 ? 'sort-asc' : 'sort-desc');
  }

  function loadBot() {
    if (stateBot.loading) return;
    stateBot.loading = true;
    $('#bot-status').text('Загрузка…');
    $.getJSON('/api/invest/bot_events?period=' + encodeURIComponent(stateBot.period) + '&_=' + Date.now())
      .done(function (d) {
        stateBot.events = (d && d.events) ? d.events : [];
        stateBot.loaded = true;
        renderBot();
      })
      .fail(function () {
        $('#bot-status').text('Ошибка загрузки событий бота');
      })
      .always(function () { stateBot.loading = false; });
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
    lines.push('');
    lines.push('СВОДКА');
    lines.push('Всего сообщений;' + ev.length);
    lines.push('Блокировки (block);' + lv.block);
    lines.push('Предупреждения (warn);' + lv.warn);
    lines.push('Инфо (info);' + lv.info);
    lines.push('');
    lines.push('ПО КАТЕГОРИЯМ');
    lines.push('Категория;Уровень;Кол-во');
    cats.forEach(function (c) { lines.push((BOT_CATLABEL[c.key] || c.key) + ';' + c.level + ';' + c.total); });
    lines.push('');
    lines.push('ПО АККАУНТАМ');
    lines.push('Аккаунт;Кол-во');
    accs.forEach(function (c) { lines.push(c.key + ';' + c.total); });
    lines.push('');
    lines.push('ПО ИНТЕРВАЛУ (' + stateBot.interval + ')');
    lines.push('Период;Блокировки;Предупреждения;Инфо;Всего');
    tim.forEach(function (r) { lines.push([r.label, r.block, r.warn, r.info, r.total].join(';')); });
    lines.push('');
    lines.push('СОБЫТИЯ');
    lines.push('Дата;Время;Канал;Уровень;Категория;Аккаунт;Тикер;Текст');
    botSortedEvents(ev).forEach(function (e) {
      lines.push([botDayStr(e.ts), botHm(e.ts), botShortChat(e.chat), e.level, BOT_CATLABEL[e.category] || e.category, e.account, e.ticker, '"' + String(e.text).replace(/"/g, '""') + '"'].join(';'));
    });
    var csv = lines.join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bot_errors_' + stateBot.interval + '_' + stateBot.period.replace(/[^-0-9]/g, '') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  // Рендер сводки
  function renderSummary(summary) {
    var $tb = $('#report-summary-tbody');
    if (!summary) { $tb.html('<tr><td colspan="4">Нет данных</td></tr>'); return; }
    function row(label, fn) {
      return '<tr><td class="r-label">' + label + '</td>' + ['finam', 'tinkoff', 'combined'].map(function (s) {
        var v = fn(summary[s]);
        return '<td>' + (v == null || v === '' ? '<span class="r-empty">—</span>' : v) + '</td>';
      }).join('') + '</tr>';
    }
    var html =
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
    $tb.html(html);
  }

  // Рендер таблицы
  function renderTable(rows) {
    var $tb = $('#report-table-tbody');
    if (!rows.length) { $tb.html('<tr><td colspan="15">Нет данных</td></tr>'); return; }
    var html = rows.map(function (r) {
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
    $tb.html(html);
    // двухрядная липкая шапка: вторая строка фиксируется на высоте первой
    var $trs = $('#report-table-tbody').closest('table').find('thead tr');
    if ($trs.length === 2) {
      $trs.eq(1).find('th').css('top', $trs.eq(0).outerHeight() + 'px');
    }
  }

  function render() {
    if (!state.data) {
      $('#report-summary-tbody').html('<tr><td colspan="4">Нет данных</td></tr>');
      $('#report-table-tbody').html('<tr><td colspan="15">Нет данных</td></tr>');
      $('#report-status').text('Данных нет');
      return;
    }
    var summary = buildSummary(state.data);
    state.rows = buildRows(state.data, state.interval);
    $('#report-status').text('Период: ' + PERIODS.filter(function (p) { return p.key === state.period; })[0].label +
      ' · интервал: ' + INTERVALS.filter(function (i) { return i.key === state.interval; })[0].label +
      ' · дней в периоде: ' + Object.keys(state.data).length);
    renderSummary(summary);
    renderTable(sortRows());
    applySortIndicator();
  }

  function load() {
    if (state.loading) return;
    state.loading = true;
    $('#report-status').text('Загрузка…');
    $.getJSON('/api/invest/report?period=' + encodeURIComponent(state.period) + '&_=' + Date.now())
      .done(function (d) {
        state.data = (d && d.days) ? d.days : null;
        render();
      })
      .fail(function () {
        $('#report-status').text('Ошибка загрузки данных');
      })
      .always(function () { state.loading = false; });
  }

  // Заполняет вкладку «Настройки» (однократно) контентом из lib.js
  var _settingsPaneBuilt = false;
  function populateSettingsPane() {
    if (_settingsPaneBuilt) return;
    _settingsPaneBuilt = true;
    var $host = $('#report-pane-settings .settings-container');
    if ($host.length && typeof window.populateSettingsContent === 'function') {
      window.populateSettingsContent($host);
    }
  }

  function open(tabToOpen) {
    var $el = $('#report-modal');
    if (!$el.length) {
      $el = $('<div id="report-modal" class="panels-modal"></div>');
      var $content = $('<div class="report-modal-content"></div>');
      $content.html(
        '<div class="panels-modal-header"><h3>Отчёты и настройки</h3><button class="close-modal">&times;</button></div>' +
        '<div class="report-tabs">' +
          '<button class="report-tab active" data-tab="invest">Инвестиции</button>' +
          '<button class="report-tab" data-tab="bot" title="Отчёты об ошибках бота (Telegram)">Ошибки бота</button>' +
          '<button class="report-tab" data-tab="settings">Настройки</button>' +
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
          '<th data-sort="start">Период</th><th data-sort="block">🚨 Блокировки</th><th data-sort="warn">⚠ Предупреждения</th><th data-sort="info">✅ Инфо</th><th data-sort="total">Всего</th>' +
        '</tr></thead><tbody id="bot-timeline-tbody"></tbody></table></div>' +
        '<div class="report-table-wrap" id="bot-view-events" style="display:none"><table class="report-table"><thead><tr>' +
          '<th>Дата</th><th>Время</th><th>Канал</th><th>Уровень</th><th>Категория</th>' +
          '<th data-bsort="account">Аккаунт</th><th>Текст</th>' +
        '</tr></thead><tbody id="bot-event-tbody"></tbody></table></div>' +
      '</div>' +
      '<div id="report-pane-settings" style="display:none">' +
        '<div class="settings-container"></div>' +
      '</div>'
      );
      $el.append($content);
      $('body').append($el);

      // закрытие
      $el.find('.close-modal').on('click', function () { $el.hide(); });
      $el.on('click', function (e) { if (e.target === $el[0]) $el.hide(); });

      // перетаскивание
      var $header = $content.find('.panels-modal-header').css('cursor', 'move');
      var dragging = false, ox = 0, oy = 0;
      $header.on('mousedown', function (e) {
        if (e.target.classList.contains('close-modal')) return;
        dragging = true;
        ox = e.clientX - $content[0].offsetLeft;
        oy = e.clientY - $content[0].offsetTop;
      });
      $(document).on('mousemove', function (e) {
        if (!dragging) return;
        $content.css('left', (e.clientX - ox) + 'px').css('top', (e.clientY - oy) + 'px');
      });
      $(document).on('mouseup', function () { dragging = false; });

      // контролы
      $el.find('.report-int').on('click', function () {
        $el.find('.report-int').removeClass('active');
        $(this).addClass('active');
        state.interval = $(this).attr('data-int');
        render();
      });
      $el.find('.report-period').on('change', function () {
        state.period = this.value;
        load();
      });
      $el.find('#report-csv').on('click', function () {
        if (state.data) exportCsv(sortRows(), buildSummary(state.data));
      });
      $el.find('#report-pane-invest .report-table th[data-sort]').on('click', function () {
        var key = $(this).attr('data-sort');
        var src = $(this).attr('data-src') || null;
        if (state.sort.key === key && state.sort.src === src) {
          state.sort.dir = -state.sort.dir;
        } else {
          state.sort = { key: key, src: src, dir: -1 };
        }
        render();
      });

      // таб «Ошибки бота» и «Настройки» (только верхние вкладки: data-tab есть только у них)
      $el.find('.report-tab[data-tab]').on('click', function () {
        var tab = $(this).attr('data-tab');
        $el.find('.report-tab').removeClass('active');
        $(this).addClass('active');
        $('#report-pane-invest').toggle(tab === 'invest');
        $('#report-pane-bot').toggle(tab === 'bot');
        $('#report-pane-settings').toggle(tab === 'settings');
        if (tab === 'bot') loadBot();
        if (tab === 'settings') populateSettingsPane();
        // Вкладка «Инвестиции»: подгружаем данные, если они ещё не были загружены
        // (модалка могла открыться сразу на «Настройки»).
        if (tab === 'invest' && !state.data) load();
      });
      $el.find('.report-int-bot').on('click', function () {
        $el.find('.report-int-bot').removeClass('active');
        $(this).addClass('active');
        stateBot.interval = $(this).attr('data-int');
        renderBot();
      });
      $el.find('.report-period-bot').on('change', function () {
        stateBot.period = this.value;
        stateBot.loaded = false;
        loadBot();
      });
      $el.find('#bot-errors-only').on('change', function () {
        stateBot.errorsOnly = this.checked;
        renderBot();
      });
      $el.find('.report-cat-bot').on('change', function () {
        stateBot.category = this.value;
        renderBot();
      });
      $el.find('#bot-csv').on('click', function () { exportBotCsv(); });
      $el.find('.report-tab-sub').on('click', function () {
        var sub = $(this).attr('data-sub');
        $el.find('.report-tab-sub').removeClass('active');
        $(this).addClass('active');
        $('#bot-view-timeline').toggle(sub === 'timeline');
        $('#bot-view-events').toggle(sub === 'events');
      });
      $el.find('#report-pane-bot th[data-bsort]').on('click', function () {
        var key = $(this).attr('data-bsort');
        if (stateBot.sort.key === key) {
          stateBot.sort.dir = -stateBot.sort.dir;
        } else {
          stateBot.sort = { key: key, dir: -1 };
        }
        renderBot();
      });
      $el.find('#bot-view-timeline th[data-sort]').on('click', function () {
        var key = $(this).attr('data-sort');
        if (stateBot.timelineSort.key === key) {
          stateBot.timelineSort.dir = -stateBot.timelineSort.dir;
        } else {
          stateBot.timelineSort = { key: key, dir: -1 };
        }
        renderBot();
      });

      $el.find('.report-int[data-int="' + state.interval + '"]').addClass('active');
      $el.find('.report-period').val(state.period);
      $el.find('.report-int-bot[data-int="' + stateBot.interval + '"]').addClass('active');
      $el.find('.report-period-bot').val(stateBot.period);
      $el.find('.report-cat-bot').val(stateBot.category);
    }
    $el.show();
    if (tabToOpen) {
      var $tab = $el.find('.report-tab[data-tab="' + tabToOpen + '"]');
      if ($tab.length) $tab.trigger('click');
    } else {
      load();
    }
  }

  // Глобальный API для отладки
  window.Report = {
    open: open,
    load: load,
    setInterval: function (k) { state.interval = k; },
    setPeriod: function (p) { state.period = p; },
    bot: {
      open: function () {
        open();
        var $b = $('#report-modal .report-tab[data-tab="bot"]');
        if ($b.length) $b.trigger('click');
      },
      setInterval: function (k) { stateBot.interval = k; },
      setPeriod: function (p) { stateBot.period = p; },
      setErrorsOnly: function (v) { stateBot.errorsOnly = !!v; },
      setCategory: function (c) { stateBot.category = c; },
      load: loadBot
    }
  };
})();