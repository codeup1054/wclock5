// static/js/report.js — Отчёт по портфелю (кнопка O в панели управления)
(function () {
  'use strict';

  var SOURCES = ['finam', 'tinkoff'];
  var SRCLABEL = { finam: 'F', tinkoff: 'T' };

  var INTERVALS = [
    { key: 'day', label: 'День' },
    { key: 'week', label: 'Неделя' },
    { key: 'month', label: 'Месяц' }
  ];

  var PERIODS = [
    { key: '-7 day', label: 'Неделя' },
    { key: '-35 day', label: 'Месяц' },
    { key: '-90 day', label: '3 месяца' },
    { key: '-365 day', label: 'Год' }
  ];

  var state = { interval: 'day', period: '-35 day', loading: false, data: null };

  function round2(x) { return Math.round(x * 100) / 100; }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseDay(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  function groupKey(date, interval) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (interval === 'day') return iso(d);
    if (interval === 'week') {
      var dow = (d.getDay() + 6) % 7;
      return iso(addDays(d, -dow));
    }
    return iso(new Date(d.getFullYear(), d.getMonth(), 1));
  }

  function fmtDateRange(a, b) { return a === b ? a : a + ' — ' + b; }
  function fmt(x) { return x == null ? '' : (typeof x === 'number' ? x.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : x); }
  function fmtPct(x) { return x == null ? '' : fmt(x) + '%'; }
  function fmtVal(x) {
    var s = fmt(x);
    return x < 0 ? '<span class="r-neg">' + s + '</span>' : s;
  }
  function fmtPctVal(x) {
    var s = fmtPct(x);
    return x < 0 ? '<span class="r-neg">' + s + '</span>' : s;
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
        rateAvg: rateAvg != null ? rateAvg : (cell.rateN ? round2(cell.rateSum / cell.rateN) : null),
        commission: cell.commission,
        avgCommission: cell.days ? round2(cell.commission / cell.days) : null
      };
    }
    SOURCES.forEach(function (src) { make(src, c[src], null); });
    make('combined', combinedCell, combinedCell.volume ? round2(combinedCell.commission / combinedCell.volume * 100) : null);
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
      ['Ставка комиссии средняя, %', function (s) { return csvValue(s.rateAvg); }],
      ['Комиссия за период, ₽', function (s) { return csvValue(s.commission); }],
      ['Комиссия средняя в день, ₽', function (s) { return csvValue(s.avgCommission); }]
    ];
    sumRows.forEach(function (r) {
      lines.push(r[0] + ';' + r[1](summary.finam) + ';' + r[1](summary.tinkoff) + ';' + r[1](summary.combined));
    });
    lines.push('');
    lines.push('ДЕТАЛИЗАЦИЯ' + (state.interval === 'day' ? ' (по дням)' : ' (по ' + state.interval + 'ам)'));
    var flat = [];
    SOURCES.forEach(function (src) {
      ['кап нач', 'кап кон', 'изм ₽', 'изм %', 'объём ₽', 'ставка %', 'комиссия ₽'].forEach(function (h) {
        flat.push(SRCLABEL[src] + ' ' + h);
      });
    });
    lines.push('Дата;Дней;' + flat.join(';'));

    rows.forEach(function (r) {
      var line = [r.label, r.cells.finam.days];
      SOURCES.forEach(function (src) {
        var c = r.cells[src];
        var rate = c.rateN ? round2(c.rateSum / c.rateN) : null;
        line.push(csvValue(c.cap_start), csvValue(c.cap_end), csvValue(c.changeRub), csvValue(c.changePct),
          csvValue(c.volume), csvValue(rate), csvValue(c.commission));
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
      row('Капитал на начало, ₽', function (s) { return fmt(s.cap_start); }) +
      row('Капитал на конец, ₽', function (s) { return fmt(s.cap_end); }) +
      row('Изменение капитала за период, ₽', function (s) { return fmtVal(s.changeRub); }) +
      row('Среднее изменение капитала в день, ₽', function (s) { return fmtVal(s.avgChangeRub); }) +
      row('Изменение капитала за период, %', function (s) { return fmtPctVal(s.changePct); }) +
      row('Среднее изменение капитала в день, %', function (s) { return fmtPctVal(s.avgChangePct); }) +
      row('Объём за период, ₽', function (s) { return fmt(s.volume); }) +
      row('Объём средний в день, ₽', function (s) { return fmt(s.avgVolume); }) +
      row('Ставка комиссии средняя, %', function (s) { return fmtPct(s.rateAvg); }) +
      row('Комиссия за период, ₽', function (s) { return fmt(s.commission); }) +
      row('Комиссия средняя в день, ₽', function (s) { return fmt(s.avgCommission); });
    $tb.html(html);
  }

  // Рендер таблицы
  function renderTable(rows) {
    var $tb = $('#report-table-tbody');
    if (!rows.length) { $tb.html('<tr><td colspan="15">Нет данных</td></tr>'); return; }
    var html = rows.map(function (r) {
      var line = '<tr><td class="r-date">' + r.label + '</td><td>' + r.cells.finam.days + '</td>';
      SOURCES.forEach(function (src) {
        var c = r.cells[src];
        var rate = c.rateN ? round2(c.rateSum / c.rateN) : null;
        line += '<td>' + fmt(c.cap_start) + '</td><td>' + fmt(c.cap_end) + '</td><td>' + fmtVal(c.changeRub) + '</td>' +
          '<td>' + fmtPctVal(c.changePct) + '</td><td>' + fmt(c.volume) + '</td><td>' + fmtPct(rate) + '</td><td>' + fmt(c.commission) + '</td>';
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
    var rows = buildRows(state.data, state.interval);
    $('#report-status').text('Период: ' + PERIODS.filter(function (p) { return p.key === state.period; })[0].label +
      ' · интервал: ' + INTERVALS.filter(function (i) { return i.key === state.interval; })[0].label +
      ' · дней в периоде: ' + Object.keys(state.data).length);
    renderSummary(summary);
    renderTable(rows);
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

  function open() {
    var $el = $('#report-modal');
    if (!$el.length) {
      $el = $('<div id="report-modal" class="panels-modal"></div>');
      var $content = $('<div class="report-modal-content"></div>');
      $content.html(
        '<div class="panels-modal-header"><h3>Отчёт по портфелю</h3><button class="close-modal">&times;</button></div>' +
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
          '<th rowspan="2">Дата</th><th rowspan="2">Дней</th>' +
          '<th colspan="7" class="r-src-f">F (Финам)</th><th colspan="7" class="r-src-t">T (Тинькофф)</th>' +
        '</tr><tr>' +
          '<th>Кап нач</th><th>Кап кон</th><th>Изм ₽</th><th>Изм %</th><th>Объём ₽</th><th>Ставка %</th><th>Комиссия ₽</th>' +
          '<th>Кап нач</th><th>Кап кон</th><th>Изм ₽</th><th>Изм %</th><th>Объём ₽</th><th>Ставка %</th><th>Комиссия ₽</th>' +
        '</tr></thead><tbody id="report-table-tbody"></tbody></table></div>'
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
        if (state.data) exportCsv(buildRows(state.data, state.interval), buildSummary(state.data));
      });

      $el.find('.report-int[data-int="' + state.interval + '"]').addClass('active');
      $el.find('.report-period').val(state.period);
    }
    $el.show();
    load();
  }

  // Кнопка O в панели управления
  function ensureButton() {
    var hook = document.getElementById('chart_control_panel');
    if (!hook) return;
    if (hook.querySelector('#report_btn')) return;
    var $btn = $('<button id="report_btn" class="interval-btn" title="Отчёт по портфелю">O</button>')
      .on('click', function (e) { e.preventDefault(); open(); });
    $(hook).append($btn);
  }

  // После того как control_panel.js создал панель — добавляем кнопку O
  function waitForPanel() {
    var hook = document.getElementById('chart_control_panel');
    if (!hook || !hook.querySelector('#panels-list-btn')) {
      setTimeout(waitForPanel, 200);
      return;
    }
    ensureButton();
  }
  $(function () { waitForPanel(); });

  // Глобальный API для отладки
  window.Report = {
    open: open,
    load: load,
    setInterval: function (k) { state.interval = k; },
    setPeriod: function (p) { state.period = p; }
  };
})();