/* hft_banner.js — инвест-баннер HFT (порт wclock invest_banner.js на fetch).
 * Полный баннер: строки портфелей по источникам (F/T) с блоками оборота
 * (xN / объём / комиссия % ₽ + тарифный тултип Finam), бары ассетов,
 * таблица изменений T+F (день / неделя / период, абс и %), строки тикеров
 * TGLD / TMON / XAU. Данные: /api/hft/history, /api/hft/chart_tickers,
 * /api/hft/turnover.
 */
(function (window) {
  'use strict';

  var COLORS = {
    capital: '#8d9d9d',
    positive: '#1fc163',
    negative: '#e74c3c',
    ticker: '#ddd',
    rubTicker: '#1da067',
    tgold: '#FFD700',
    coral: '#ff7f50',
    tinvest: '#43e893',
    finamBlue: '#5b6ee8',
    assetColors: ['#3498db', '#e74c3c', '#1fc163', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e']
  };

  var FINAM_TIERS = [
    { cap: 1e6, rate: 0.025, label: 'до 1 млн' },
    { cap: 5e6, rate: 0.015, label: '1–5 млн' },
    { cap: 3e7, rate: 0.01, label: '5–30 млн' },
    { cap: 1e8, rate: 0.005, label: '30–100 млн' },
    { cap: 2.5e8, rate: 0.0025, label: '100–250 млн' },
    { cap: Infinity, rate: 0.001, label: '> 250 млн' }
  ];

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatCurrency(v) {
    return Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  }

  function formatChange(v) {
    var n = Number(v || 0);
    return (n >= 0 ? '+' : '-') + formatCurrency(Math.abs(n));
  }

  function formatPercent(v) {
    var n = Number(v || 0);
    return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2) + '%';
  }

  function formatPrice(v) { return Number(v || 0).toFixed(2); }
  function formatTickerAbs(v) {
    var n = Number(v || 0);
    return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2);
  }

  function formatCompactRub(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'М';
    if (n >= 1e3) {
      var k = n / 1e3;
      return (k >= 100 ? Math.round(k).toString() : k.toFixed(k >= 10 ? 1 : 2)).replace('.', ',') + 'к';
    }
    return String(Math.round(n));
  }

  function sumEntryBySource(entry, source) {
    if (!Array.isArray(entry)) return 0;
    return entry.reduce(function (sum, p) {
      if (!p || p.source !== source) return sum;
      var v = Number(p.value);
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
  }

  function portfolioTotalsBySource(positions) {
    var totals = {};
    if (Array.isArray(positions)) {
      positions.forEach(function (p) {
        if (!p || !p.source) return;
        var v = Number(p.value);
        if (!isNaN(v)) totals[p.source] = (totals[p.source] || 0) + v;
      });
    }
    return totals;
  }

  function getAssetsDataBySource(positions, source) {
    if (!Array.isArray(positions)) return [];
    var list = positions.filter(function (p) { return p.source === source; });
    if (!list.length) return [];
    var totalValue = list.reduce(function (s, p) { return s + (Number(p.value) || 0); }, 0);
    if (totalValue <= 0) return [];
    var ASSET_ORDER = ['TGLD', 'RUB', 'TMON'];
    function rankOf(t) {
      for (var i = 0; i < ASSET_ORDER.length; i++) if (t.indexOf(ASSET_ORDER[i]) >= 0) return i;
      return -1;
    }
    return list.map(function (p) {
      return {
        ticker: (p.name || '???').slice(0, 4),
        name: p.name || '???',
        value: Number(p.value) || 0,
        percent: ((Number(p.value) || 0) / totalValue) * 100
      };
    }).sort(function (a, b) {
      var ia = rankOf(a.ticker), ib = rankOf(b.ticker);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return b.value - a.value;
    }).slice(0, 5);
  }

  function calculateBaselineTotal(historyData, timestamps, source) {
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (var i = 0; i < timestamps.length; i++) {
      var ts = timestamps[i];
      var entry = historyData[ts];
      if (new Date(ts).getTime() >= todayStart.getTime() && Array.isArray(entry)) {
        var v = sumEntryBySource(entry, source);
        if (v > 0) return v;
      }
    }
    var yesterdayEnd = new Date(todayStart.getTime() - 1);
    for (i = timestamps.length - 1; i >= 0; i--) {
      entry = historyData[timestamps[i]];
      if (new Date(timestamps[i]).getTime() <= yesterdayEnd.getTime() && Array.isArray(entry)) {
        v = sumEntryBySource(entry, source);
        if (v > 0) return v;
      }
    }
    var firstEntry = historyData[timestamps[0]];
    return Array.isArray(firstEntry) ? sumEntryBySource(firstEntry, source) : 0;
  }

  function calculatePeriodBaselineTotal(historyData, timestamps, periodMs, source) {
    var now = new Date();
    var periodStart = new Date(now.getTime() - periodMs);
    for (var i = 0; i < timestamps.length; i++) {
      var ts = timestamps[i];
      var entry = historyData[ts];
      if (new Date(ts).getTime() >= periodStart.getTime() && Array.isArray(entry)) {
        var v = sumEntryBySource(entry, source);
        if (v > 0) return v;
      }
    }
    var firstEntry = historyData[timestamps[0]];
    return Array.isArray(firstEntry) ? sumEntryBySource(firstEntry, source) : 0;
  }

  function calculatePeriodMs(period) {
    if (!period) return 35 * 86400000;
    var hm = period.match(/-(\d+)\s*hour/);
    if (hm) return parseInt(hm[1], 10) * 3600000;
    var m = period.match(/-(\d+)\s*day/);
    if (m) return parseInt(m[1], 10) * 86400000;
    if (period.indexOf('1.5') >= 0) return 1.5 * 86400000;
    return 35 * 86400000;
  }

  function findTickerBaseline(prices, lookbackMs) {
    if (!prices || prices.length < 2) return null;
    var now = new Date(prices[prices.length - 1].timestamp);
    var target = new Date(now.getTime() - lookbackMs);
    var closest = null, minDiff = Infinity;
    for (var i = 0; i < prices.length; i++) {
      var diff = Math.abs(new Date(prices[i].timestamp).getTime() - target.getTime());
      if (diff < minDiff) { minDiff = diff; closest = prices[i]; }
    }
    return closest;
  }

  function buildFinamTariffTip(total) {
    var activeIdx = 0;
    for (var i = 0; i < FINAM_TIERS.length; i++) {
      if (total <= FINAM_TIERS[i].cap) { activeIdx = i; break; }
    }
    var rows = FINAM_TIERS.map(function (t, idx) {
      var cls = idx === activeIdx ? ' class="finam-tariff-active"' : '';
      var arrow = idx === activeIdx ? ' ←' : '';
      var rate = t.rate + 0.01;
      return '<tr' + cls + '><td>' + t.label + '</td><td>' +
        rate.toFixed(4).replace('.', ',') + ' %' + arrow + '</td></tr>';
    }).join('');
    return '<div class="finam-tariff-css-tip">' +
      '<b>Finam «Трейдер n6» — ставка брокера + 0,01 % СПБ</b>' +
      '<table><tbody>' + rows + '</tbody></table>' +
      '<span class="finam-tariff-note">сумма в скобках — оборот дня; ' +
      'тариф: брекет дневного оборота + урегулирование СПБ 0,01 %</span></div>';
  }

  function buildTurnoverHtml(turnoverData, source, capital) {
    if (!turnoverData || !capital) return '';
    var t = turnoverData[source] || {};
    var total = t.total || 0;
    var comm = t.commission || 0;
    var x = total / capital;
    var xStr = x >= 10 ? x.toFixed(0) : x.toFixed(1).replace('.', ',');
    var pct = total > 0 ? comm / total * 100 : 0;
    var pctStr = pct > 0 ? Number(pct.toPrecision(3)).toString().replace('.', ',') : '0';
    var sourceClass = source === 'tinkoff' ? ' tinvest' : ' finam';
    var tipAttr = source === 'finam'
      ? ' data-tariff-tip="' + esc(buildFinamTariffTip(total)) + '"' : '';
    return '<table class="banner-turnover-block' + sourceClass + '"><tbody>' +
      '<tr><td>x' + xStr + '</td><td class="tb-col2">' + formatCompactRub(total) + '</td></tr>' +
      '<tr><td class="finam-tariff-hover"' + tipAttr + '>' + pctStr +
      ' %</td><td class="tb-col2">' + formatCompactRub(comm) + '</td></tr>' +
      '</tbody></table>';
  }

  function renderAssetRow(ticker, color, tickersData, period) {
    var t = tickersData[ticker];
    if (!t) return '';
    var price = t.current_price || 0;
    var dayBase = t.day_base || 0;
    var dayPct = dayBase ? (price - dayBase) / dayBase * 100 : 0;
    var periodMs = calculatePeriodMs(period);
    var weekBase = findTickerBaseline(t.prices, 7 * 86400000);
    var weekAbs = weekBase && weekBase.price ? price - weekBase.price : null;
    var weekPct = weekBase && weekBase.price ? (weekAbs / weekBase.price * 100) : null;
    var periodBase = findTickerBaseline(t.prices, periodMs);
    var periodAbs = periodBase && periodBase.price ? price - periodBase.price : null;
    var periodPct = periodBase && periodBase.price ? (periodAbs / periodBase.price * 100) : null;
    var dayCls = dayPct >= 0 ? 'change-positive' : 'change-negative';
    var weekCls = weekPct !== null ? (weekPct >= 0 ? 'change-positive' : 'change-negative') : '';
    var periodCls = periodPct !== null ? (periodPct >= 0 ? 'change-positive' : 'change-negative') : '';
    return '<tr>' +
      '<td class="banner-td-empty"></td>' +
      '<td class="banner-td-num" style="color:' + color + '">' + formatPrice(price) + '</td>' +
      '<td class="banner-td-pct ' + dayCls + '">' + formatPercent(dayPct) + '</td>' +
      '<td class="banner-td-change ' + dayCls + '" style="opacity:.2">' +
        formatTickerAbs(price - dayBase) + '</td>' +
      '<td class="banner-td-pct ' + weekCls + '">' +
        (weekPct !== null ? formatPercent(weekPct) : '—') + '</td>' +
      '<td class="banner-td-change ' + weekCls + '" style="opacity:.2">' +
        (weekAbs !== null ? formatTickerAbs(weekAbs) : '—') + '</td>' +
      '<td class="banner-td-pct ' + periodCls + '">' +
        (periodPct !== null ? formatPercent(periodPct) : '—') + '</td>' +
      '</tr>';
  }

  // Рендер полного баннера в один контейнер (capital header + assets + table)
  function renderBanner(opts) {
    var historyData = opts.historyData || {};
    var refHistory = opts.refHistory || historyData;
    var tickersData = opts.tickersData || {};
    var turnoverData = opts.turnoverData || {};
    var period = opts.period || '-35 day';

    var timestamps = Object.keys(historyData).filter(function (k) { return k !== '_prev'; }).sort();
    var refTimestamps = Object.keys(refHistory).filter(function (k) { return k !== '_prev'; }).sort();
    if (!timestamps.length) {
      return '<div class="empty">Нет данных</div>';
    }
    var latestTs = timestamps[timestamps.length - 1];
    var latestPositions = historyData[latestTs];
    if (!Array.isArray(latestPositions) || !latestPositions.length) {
      return '<div class="empty">Нет позиций</div>';
    }
    var totals = portfolioTotalsBySource(latestPositions);
    var srcs = ['finam', 'tinkoff'].filter(function (s) { return totals[s] > 0; });
    var periodMs = calculatePeriodMs(period);

    var rows = srcs.map(function (src) {
      var cur = totals[src];
      var base = calculateBaselineTotal(refHistory, refTimestamps, src);
      var baseW = calculatePeriodBaselineTotal(refHistory, refTimestamps, 7 * 86400000, src);
      var baseP = calculatePeriodBaselineTotal(historyData, timestamps, periodMs, src);
      return {
        source: src,
        label: src === 'finam' ? 'Finam' : 'Тинвест',
        marker: src === 'finam' ? 'F' : 'T',
        color: src === 'finam' ? COLORS.finamBlue : COLORS.tinvest,
        cssClass: src === 'finam' ? 'banner-row-portfolio-finam' : 'banner-row-portfolio-tinvest',
        currentTotal: cur,
        assets: getAssetsDataBySource(latestPositions, src),
        change: { cls: cur - base >= 0 ? 'change-positive' : 'change-negative', abs: cur - base, pct: base !== 0 ? (cur - base) / base * 100 : 0 },
        changeW: { cls: cur - baseW >= 0 ? 'change-positive' : 'change-negative', abs: cur - baseW, pct: baseW !== 0 ? (cur - baseW) / baseW * 100 : 0 },
        changeP: { cls: cur - baseP >= 0 ? 'change-positive' : 'change-negative', abs: cur - baseP, pct: baseP !== 0 ? (cur - baseP) / baseP * 100 : 0 }
      };
    });

    var capHtml = '';
    capHtml += '<div class="banner-capital"><div class="banner-capital-title">Капитал</div>';
    rows.forEach(function (r) {
      capHtml += '<div class="banner-capital-line">' +
        '<span class="banner-capital-marker" style="color:' + r.color + '">' + r.marker + '</span>' +
        '<span class="banner-capital-value">' + formatCurrency(r.currentTotal) + '</span>' +
        buildTurnoverHtml(turnoverData, r.source, r.currentTotal) +
        '</div>';
    });
    capHtml += '</div>';

    if (rows.length) {
      var totalCap = rows.reduce(function (s, r) { return s + r.currentTotal; }, 0);
      capHtml += '<div class="banner-assets-row">' +
        '<div class="banner-total-capital">' + formatCurrency(totalCap) + '</div>' +
        '<div class="banner-assets">';
      rows.forEach(function (r) {
        if (!r.assets.length) return;
        capHtml += '<div class="asset-row">' +
          '<span class="asset-row-label" style="color:' + r.color + '">' + r.marker + '</span>' +
          '<div class="asset-bar-container">';
        r.assets.forEach(function (a) {
          var barClass = '';
          if (a.ticker.indexOf('TGLD') >= 0) barClass = 'asset-bar-tgld';
          else if (a.ticker.indexOf('TMON') >= 0) barClass = 'asset-bar-tmon';
          else if (a.ticker.indexOf('LQDT') >= 0) barClass = 'asset-bar-lqdt';
          else if (a.ticker.indexOf('RUB') >= 0 || a.name.indexOf('Руб') >= 0) barClass = 'asset-bar-rub';
          else barClass = 'asset-bar-other';
          capHtml += '<span class="asset-bar ' + barClass + '" style="width:' + Math.max(a.percent, 1) +
            '%">' +
            '<span class="asset-bar-label">' + a.percent.toFixed(1) + '%</span></span>';
        });
        capHtml += '</div></div>';
      });
      capHtml += '</div></div>';
    }

    var tblHtml = '<table class="banner-table"><tbody>';
    if (rows.length) {
      function sumForAll(hist, stamps, fn) {
        return srcs.reduce(function (s, src) { return s + fn(hist, stamps, src); }, 0);
      }
      var tfCur = rows.reduce(function (s, r) { return s + r.currentTotal; }, 0);
      var tfBase = sumForAll(refHistory, refTimestamps, calculateBaselineTotal);
      var tfBaseW = sumForAll(refHistory, refTimestamps, function (h, st, src) {
        return calculatePeriodBaselineTotal(h, st, 7 * 86400000, src);
      });
      var tfBaseP = sumForAll(historyData, timestamps, function (h, st, src) {
        return calculatePeriodBaselineTotal(h, st, periodMs, src);
      });
      var tfAbs = tfCur - tfBase, tfPct = tfBase !== 0 ? tfAbs / tfBase * 100 : 0;
      var tfAbsW = tfCur - tfBaseW, tfPctW = tfBaseW !== 0 ? tfAbsW / tfBaseW * 100 : 0;
      var tfAbsP = tfCur - tfBaseP, tfPctP = tfBaseP !== 0 ? tfAbsP / tfBaseP * 100 : 0;
      tblHtml += '<tr class="banner-row-portfolio-total">' +
        '<td class="banner-td-num">T+F</td>' +
        '<td class="banner-td-change ' + (tfAbs >= 0 ? 'change-positive' : 'change-negative') + '">' + formatChange(tfAbs) + '</td>' +
        '<td class="banner-td-pct ' + (tfAbs >= 0 ? 'change-positive' : 'change-negative') + '">' + formatPercent(tfPct) + '</td>' +
        '<td class="banner-td-change ' + (tfAbsW >= 0 ? 'change-positive' : 'change-negative') + '">' + formatChange(tfAbsW) + '</td>' +
        '<td class="banner-td-pct ' + (tfAbsW >= 0 ? 'change-positive' : 'change-negative') + '">' + formatPercent(tfPctW) + '</td>' +
        '<td class="banner-td-change ' + (tfAbsP >= 0 ? 'change-positive' : 'change-negative') + '">' + formatChange(tfAbsP) + '</td>' +
        '<td class="banner-td-pct ' + (tfAbsP >= 0 ? 'change-positive' : 'change-negative') + '">' + formatPercent(tfPctP) + '</td>' +
        '</tr>';
    }
    rows.forEach(function (r) {
      tblHtml += '<tr class="' + r.cssClass + '" style="opacity:.78">' +
        '<td class="banner-td-num" style="color:' + r.color + ';font-weight:bold">' + r.marker + '</td>' +
        '<td class="banner-td-change ' + r.change.cls + '">' + formatChange(r.change.abs) + '</td>' +
        '<td class="banner-td-pct ' + r.change.cls + '">' + formatPercent(r.change.pct) + '</td>' +
        '<td class="banner-td-change ' + r.changeW.cls + '">' + formatChange(r.changeW.abs) + '</td>' +
        '<td class="banner-td-pct ' + r.changeW.cls + '">' + formatPercent(r.changeW.pct) + '</td>' +
        '<td class="banner-td-change ' + r.changeP.cls + '">' + formatChange(r.changeP.abs) + '</td>' +
        '<td class="banner-td-pct ' + r.changeP.cls + '">' + formatPercent(r.changeP.pct) + '</td>' +
        '</tr>';
    });
    tblHtml += renderAssetRow('TGLD@', COLORS.tgold, tickersData, period);
    tblHtml += renderAssetRow('TMON@', '#e74c3c', tickersData, period);
    tblHtml += renderAssetRow('XAU/USD', '#cc7722', tickersData, period);
    tblHtml += '</tbody></table>';

    return capHtml + tblHtml;
  }

  async function apiGet(url) {
    var resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var d = await resp.json().catch(function () { return null; });
    if (!d) throw new Error('bad response');
    return d;
  }

  // Сворачивает /api/hft/turnover (days→src) в {src: {total, commission}} за последние сутки
  function reduceTurnover(days) {
    var out = {};
    var last = null;
    Object.keys(days || {}).forEach(function (day) {
      if (!last || day > last) last = day;
    });
    if (!last) return out;
    Object.keys(days[last] || {}).forEach(function (src) {
      var x = days[last][src];
      out[src] = {
        total: (x.buy || 0) + (x.sell || 0),
        commission: x.commission || 0
      };
    });
    return out;
  }

  // дневная база тикера — цена ~сутки назад из hourly-ряда
  function addDayBase(tickersData, hourly) {
    Object.keys(tickersData || {}).forEach(function (k) {
      var t = tickersData[k];
      var base = findTickerBaseline(t.prices, 86400000);
      if (!base && hourly && hourly[k]) {
        base = findTickerBaseline(hourly[k].prices, 86400000);
      }
      t.day_base = base ? base.price : null;
    });
  }

  async function loadAll(period) {
    period = period || '-35 day';
    var apiPeriod = period === '-1 day' ? '-1.5 day' : period;
    var interval = {
      '-90 day': 'day', '-35 day': 'hour', '-7 day': 'hour', '-1 day': 'hour',
      '-12 hour': 'fivemin', '-6 hour': 'fivemin', '-3 hour': 'minute', '-1 hour': 'minute'
    }[period] || 'hour';
    var ref = await apiGet('/api/hft/history?interval=hour&period=' + encodeURIComponent('-8 day'));
    var dyn = await apiGet('/api/hft/history?interval=' + interval + '&period=' + encodeURIComponent(apiPeriod));
    var tk = await apiGet('/api/hft/chart_tickers?interval=day&period=' + encodeURIComponent('-35 day'));
    var tkDay = await apiGet('/api/hft/chart_tickers?interval=hour&period=' + encodeURIComponent('-2 day'));
    var turn = await apiGet('/api/hft/turnover?days=1');
    addDayBase(tk, tkDay);
    return {
      refHistory: ref,
      historyData: dyn,
      tickersData: tk,
      turnoverData: reduceTurnover(turn.days)
    };
  }

  async function render(host, period) {
    if (!host) return;
    try {
      var data = await loadAll(period);
      var periodMs = calculatePeriodMs(data.opts && data.opts.period || period);
      host.innerHTML = renderBanner({
        historyData: data.historyData,
        refHistory: data.refHistory,
        tickersData: data.tickersData,
        turnoverData: data.turnoverData,
        period: period
      });
      host.classList.add('banner-ready');
    } catch (e) {
      host.innerHTML = '<div class="empty">Баннер: ' + esc(e && e.message ? e.message : String(e)) + '</div>';
    }
  }

  window.HftBanner = {
    render: render,
    renderBanner: renderBanner,
    buildTurnoverHtml: buildTurnoverHtml,
    _reduceTurnover: reduceTurnover
  };
})(window);