// static/js/invest_banner.js
// HTML-версия баннера (без Chart.js)
console.log("🚀 invest_banner.js загружен (HTML version)");

(function($) {
    'use strict';

    let tickersData = {};
    let refHistory = null;   // фиксированный срез hour/-8day для статичных колонок (сутки/неделя)

    const COLORS = {
        capital: '#8d9d9d',
        positive: '#1fc163',
        negative: '#e74c3c',
        ticker: '#ddd',
        rubTicker: '#1da067',
        tgold: '#FFD700',
        coral: '#ff7f50',
        finam: '#8e44ad',
        finamBlue: '#5b6ee8',
        tinvest: '#43e893',
        barBackground: 'rgba(100, 100, 100, 0.5)',
        assetColors: ['#3498db', '#e74c3c', '#1fc163', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e']
    };

    function formatCurrency(value) {
        return value.toLocaleString('ru-RU', { 
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }

    function formatChange(value) {
        const sign = value >= 0 ? '+' : '-';
        return `${sign}${formatCurrency(Math.abs(value))}`;
    }

    function formatPercent(value) {
        const sign = value >= 0 ? '+' : '-';
        return `${sign}${Math.abs(value).toFixed(2)}%`;
    }

    function formatPrice(value) {
        return value.toFixed(2);
    }

    function formatTickerAbs(value) {
        const sign = value >= 0 ? '+' : '-';
        return `${sign}${Math.abs(value).toFixed(2)}`;
    }

    function sumEntryBySource(entry, source) {
        if (!Array.isArray(entry)) return 0;
        return entry.reduce(function(sum, p) {
            if (!p || p.source !== source) return sum;
            const val = Number(p.value);
            return sum + (isNaN(val) ? 0 : val);
        }, 0);
    }

    function portfolioTotalsBySource(positions) {
        const totals = {};
        if (Array.isArray(positions)) {
            positions.forEach(function(p) {
                if (!p || !p.source) return;
                const val = Number(p.value);
                if (!isNaN(val)) totals[p.source] = (totals[p.source] || 0) + val;
            });
        }
        return totals;
    }

    function getAssetsDataBySource(positions, source) {
        if (!Array.isArray(positions)) return [];

        const list = positions.filter(p => p.source === source);
        if (list.length === 0) return [];

        const totalValue = list.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
        if (totalValue <= 0) return [];

        const ASSET_ORDER = ['TGLD', 'RUB', 'TMON'];
        const assetRank = function(t) {
            for (let i = 0; i < ASSET_ORDER.length; i++) {
                if (t.includes(ASSET_ORDER[i])) return i;
            }
            return -1;
        };

        return list
            .map(p => ({
                ticker: p.name?.slice(0, 4) || '???',
                name: p.name || '???',
                quantity: p.quantity || 0,
                value: Number(p.value) || 0,
                source: p.source || '',
                percent: ((Number(p.value) || 0) / totalValue) * 100
            }))
            .sort((a, b) => {
                const ia = assetRank(a.ticker);
                const ib = assetRank(b.ticker);
                if (ia !== -1 && ib !== -1) return ia - ib;
                if (ia !== -1) return -1;
                if (ib !== -1) return 1;
                return b.value - a.value;
            })
            .slice(0, 5);
    }

    function calculateBaselineTotal(historyData, timestamps, source) {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        for (const ts of timestamps) {
            const entry = historyData[ts];
            if (new Date(ts) >= todayStart && Array.isArray(entry)) {
                const v = sumEntryBySource(entry, source);
                if (v > 0) return v;
            }
        }
        
        const yesterdayEnd = new Date(todayStart.getTime() - 1);
        for (let i = timestamps.length - 1; i >= 0; i--) {
            const entry = historyData[timestamps[i]];
            if (new Date(timestamps[i]) <= yesterdayEnd && Array.isArray(entry)) {
                const v = sumEntryBySource(entry, source);
                if (v > 0) return v;
            }
        }
        
        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry) ? sumEntryBySource(firstEntry, source) : 0;
    }

    function calculateWeekBaselineTotal(historyData, timestamps, source) {
        return calculatePeriodBaselineTotal(historyData, timestamps, 7 * 86400000, source);
    }

    function calculatePeriodMs(period) {
        if (!period) return 35 * 86400000;
        const hm = period.match(/-(\d+)\s*hour/);
        if (hm) return parseInt(hm[1]) * 3600000;
        const match = period.match(/-(\d+)\s*day/);
        if (match) return parseInt(match[1]) * 86400000;
        if (period.includes('1.5')) return 1.5 * 86400000;
        return 35 * 86400000;
    }

    function calculatePeriodBaselineTotal(historyData, timestamps, periodMs, source) {
        const now = new Date();
        const periodStart = new Date(now.getTime() - periodMs);

        for (const ts of timestamps) {
            const entry = historyData[ts];
            if (new Date(ts) >= periodStart && Array.isArray(entry)) {
                const v = sumEntryBySource(entry, source);
                if (v > 0) return v;
            }
        }

        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry) ? sumEntryBySource(firstEntry, source) : 0;
    }

    function findTickerBaseline(prices, lookbackMs) {
        if (!prices || prices.length < 2) return null;
        const now = new Date(prices[prices.length - 1].timestamp);
        const target = new Date(now.getTime() - lookbackMs);
        let closest = null;
        let minDiff = Infinity;
        for (let i = 0; i < prices.length; i++) {
            const diff = Math.abs(new Date(prices[i].timestamp).getTime() - target.getTime());
            if (diff < minDiff) {
                minDiff = diff;
                closest = prices[i];
            }
        }
        return closest;
    }

    function loadTickersData(callback, period) {
        const p = period || getSetting('invest_panel_period', '-35 day');
        const apiPeriod = p === '-1 day' ? '-1.5 day' : p;
        $.getJSON('/api/invest/tickers?period=' + encodeURIComponent(apiPeriod))
            .done(function(data) {
                if (data && !data.error) {
                    tickersData = data;
                    console.log('[InvestBanner] Tickers loaded:', Object.keys(data));
                } else {
                    console.warn('[InvestBanner] Tickers: no data');
                }
            })
            .fail(function(err) {
                console.error('[InvestBanner] Tickers error:', err);
            })
            .always(function() {
                if (callback) callback();
            });
    }

    // === Обороты сделок (заполняется из /api/invest/turnover) ===
    let turnoverData = null;

    function formatCompactRub(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'М';
        if (n >= 1000) {
            const k = n / 1000;
            return (k >= 100 ? Math.round(k).toString() : k.toFixed(k >= 10 ? 1 : 2)).replace('.', ',') + 'к';
        }
        return String(Math.round(n));
    }

    const FINAM_TIERS = [
        { cap: 1_000_000,   rate: 0.025,  label: 'до 1 млн' },
        { cap: 5_000_000,   rate: 0.015,  label: '1–5 млн' },
        { cap: 30_000_000,  rate: 0.01,   label: '5–30 млн' },
        { cap: 100_000_000, rate: 0.005,  label: '30–100 млн' },
        { cap: 250_000_000, rate: 0.0025, label: '100–250 млн' },
        { cap: Infinity,    rate: 0.001,  label: '> 250 млн' },
    ];

    function buildFinamTariffTip(total) {
        const rows = FINAM_TIERS.map(function(t) {
            const cls = total <= t.cap ? ' class="finam-tariff-active"' : '';
            const arrow = total <= t.cap ? ' ←' : '';
            return '<tr' + cls + '><td>' + t.label + '</td><td>' + t.rate.toFixed(3).replace('.', ',') + ' %' + arrow + '</td></tr>';
        }).join('');
        return '<div class="finam-tariff-css-tip">' +
            '<b>Finam «Трейдер n6» — ставка брокера</b>' +
            '<table><tbody>' + rows + '</tbody></table>' +
            '<span class="finam-tariff-note">+ урегулирование: СПБ 0,01 %</span>' +
            '</div>';
    }

    function renderTurnoverBlock(source, capital) {
        if (!turnoverData || !capital) {
            console.warn('[TurnoverBlock] SKIP:', source, 'turnoverData=', !!turnoverData, 'capital=', capital);
            return '';
        }
        const t = turnoverData[source] || {};
        const total = t.total || 0;
        const comm = t.commission || 0;
        const x = total / capital;
        const xStr = x >= 10 ? x.toFixed(0) : x.toFixed(1).replace('.', ',');
        const pct = total > 0 ? comm / total * 100 : 0;
        const pctStr = pct > 0 ? Number(pct.toPrecision(3)).toString().replace('.', ',') : '0';
        const sourceClass = source === 'tinkoff' ? ' tinvest' : ' finam';
        const tipAttr = source === 'finam'
            ? ` data-tariff-tip="${encodeURIComponent(buildFinamTariffTip(total))}"`
            : '';
        return `<table class="banner-turnover-block${sourceClass}"><tr>` +
            `<td>x${xStr}</td><td class="tb-col2">${formatCompactRub(total)}</td></tr>` +
            `<tr><td class="finam-tariff-hover"${tipAttr}>${pctStr} %</td><td class="tb-col2">${formatCompactRub(comm)}</td></tr>` +
            `</table>`;
    }

    // ================================================================
    // TARIFF TOOLTIP — вынесен в <body>, чтобы его не перекрывали панели
    // ================================================================
    (function initTariffTip() {
        if (window.__tariffTipInit) return;
        window.__tariffTipInit = true;
        var tipEl = null;
        var CELL_SEL = '.finam-tariff-hover[data-tariff-tip]';

        // Над ячейкой может лежать невидимый оверлей (#browser_reload),
        // поэтому ищем ячейку геометрически, а не через e.target
        function cellAt(x, y) {
            var cells = document.querySelectorAll(CELL_SEL);
            for (var i = 0; i < cells.length; i++) {
                var r = cells[i].getBoundingClientRect();
                if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return cells[i];
            }
            return null;
        }

        function hide() {
            if (tipEl) { tipEl.remove(); tipEl = null; }
        }
        function showFor(cell, e) {
            hide();
            tipEl = document.createElement('div');
            tipEl.className = 'finam-tariff-css-tip';
            try {
                tipEl.innerHTML = decodeURIComponent(cell.getAttribute('data-tariff-tip'));
            } catch (err) {
                tipEl.innerHTML = cell.getAttribute('data-tariff-tip');
            }
            tipEl._cell = cell;
            document.body.appendChild(tipEl);
            move(e);
        }
        function move(e) {
            if (!tipEl) return;
            const r = tipEl.getBoundingClientRect();
            let x = e.clientX + 14, y = e.clientY + 14;
            if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
            if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
            tipEl.style.left = x + 'px';
            tipEl.style.top = y + 'px';
        }

        document.addEventListener('mousemove', function(e) {
            const cell = cellAt(e.clientX, e.clientY);
            if (cell) {
                if (!tipEl || !tipEl.isConnected || tipEl._cell !== cell) showFor(cell, e);
                else move(e);
            } else {
                hide();
            }
        });
        document.addEventListener('wheel', hide, { passive: true });
        document.addEventListener('touchstart', hide, { passive: true });
        window.addEventListener('blur', hide);
    })();

    function renderAssetRow(ticker, color, label) {
        const t = tickersData[ticker];
        if (!t) return '';
        const price = t.current_price || 0;
        const dayAbs = t.day_change || 0;
        const dayPct = t.day_change_pct || 0;
        const period = getSetting('invest_panel_period', '-35 day');
        const periodMs = calculatePeriodMs(period);

        const weekBase = findTickerBaseline(t.prices, 7 * 86400000);
        const weekAbs = weekBase && weekBase.price ? price - weekBase.price : null;
        const weekPct = weekBase && weekBase.price ? (weekAbs / weekBase.price * 100) : null;

        const periodBase = findTickerBaseline(t.prices, periodMs);
        const periodAbs = periodBase && periodBase.price ? price - periodBase.price : null;
        const periodPct = periodBase && periodBase.price ? (periodAbs / periodBase.price * 100) : null;

        const dayClass = dayPct >= 0 ? 'change-positive' : 'change-negative';
        const weekClass = weekPct !== null ? (weekPct >= 0 ? 'change-positive' : 'change-negative') : '';
        const periodClass = periodPct !== null ? (periodPct >= 0 ? 'change-positive' : 'change-negative') : '';
        const absColor = (v) => v >= 0 ? COLORS.positive : COLORS.negative;

        const absStyle = 'opacity:0.2';

        return `<tr>
            <td class="banner-td-empty"></td>
            <td class="banner-td-num" style="color:${color}">${formatPrice(price)}</td>
            <td class="banner-td-pct ${dayClass}">${formatPercent(dayPct)}</td>
            <td class="banner-td-change ${dayClass}" style="${absStyle}">${formatTickerAbs(dayAbs)}</td>
            <td class="banner-td-pct ${weekClass}">${weekPct !== null ? formatPercent(weekPct) : '—'}</td>
            <td class="banner-td-change ${weekClass}" style="${absStyle}">${weekAbs !== null ? formatTickerAbs(weekAbs) : '—'}</td>
            <td class="banner-td-pct ${periodClass}">${periodPct !== null ? formatPercent(periodPct) : '—'}</td>
        </tr>`;
    }

    function renderBanner(historyData, dynData) {
        console.log('[renderBanner] called, turnoverData=', !!turnoverData, 'keys=', turnoverData ? Object.keys(turnoverData) : 'null');
        const $capHost = $('#invest_banner_capital_content');
        const $tblHost = $('#invest_banner_table_content');

        function emptyState(msg) {
            const cls = msg.startsWith('Ошибка') ? ' error' : '';
            if ($capHost.length) $capHost.html(`<div class="banner-message${cls}">${msg}</div>`);
            if ($tblHost.length) $tblHost.html(`<div class="banner-message${cls}">${msg}</div>`);
        }

        if (!historyData || Object.keys(historyData).length === 0) {
            emptyState('Нет данных');
            return;
        }

        const timestamps = Object.keys(historyData).filter(k => k !== '_prev').sort();
        if (timestamps.length === 0) {
            emptyState('Нет данных');
            return;
        }

        const latestTs = timestamps[timestamps.length - 1];
        const latestPositions = historyData[latestTs];
        
        if (!Array.isArray(latestPositions) || latestPositions.length === 0) {
            emptyState('Нет позиций');
            return;
        }

        const totals = portfolioTotalsBySource(latestPositions);
        const presentSources = ['finam', 'tinkoff'].filter(s => totals[s] > 0);

        const period = getSetting('invest_panel_period', '-35 day');
        const periodMs = calculatePeriodMs(period);

        // Динамический датасет выбранного периода — только для колонок 5-6
        const dynHistory = dynData || historyData;
        const dynTimestamps = Object.keys(dynHistory).sort();

        // Показатели по каждому портфелю отдельно
        const portfolioRows = presentSources.map(function(src) {
            const currentTotal = totals[src];
            const baselineTotal = calculateBaselineTotal(historyData, timestamps, src);
            const baselineWeekTotal = calculateWeekBaselineTotal(historyData, timestamps, src);
            const baselinePeriodTotal = calculatePeriodBaselineTotal(dynHistory, dynTimestamps, periodMs, src);
            const absChange = currentTotal - baselineTotal;
            const pctChange = baselineTotal !== 0 ? (absChange / baselineTotal * 100) : 0;
            const absChangeWeek = currentTotal - baselineWeekTotal;
            const pctChangeWeek = baselineWeekTotal !== 0 ? (absChangeWeek / baselineWeekTotal * 100) : 0;
            const absChangePeriod = currentTotal - baselinePeriodTotal;
            const pctChangePeriod = baselinePeriodTotal !== 0 ? (absChangePeriod / baselinePeriodTotal * 100) : 0;
            return {
                source: src,
                label: src === 'finam' ? 'Finam' : 'Тинвест',
                marker: src === 'finam' ? 'F' : 'T',
                color: src === 'finam' ? COLORS.finamBlue : COLORS.tinvest,
                cssClass: src === 'finam' ? 'banner-row-portfolio-finam' : 'banner-row-portfolio-tinvest',
                currentTotal: currentTotal,
                assets: getAssetsDataBySource(latestPositions, src),
                dayChangeClass: absChange >= 0 ? 'change-positive' : 'change-negative',
                weekChangeClass: absChangeWeek >= 0 ? 'change-positive' : 'change-negative',
                periodChangeClass: absChangePeriod >= 0 ? 'change-positive' : 'change-negative',
                absChange: absChange,
                pctChange: pctChange,
                absChangeWeek: absChangeWeek,
                pctChangeWeek: pctChangeWeek,
                absChangePeriod: absChangePeriod,
                pctChangePeriod: pctChangePeriod
            };
        });

        let capHtml = '';
        let tblHtml = '';

        // === CAPITAL: отдельные строки портфелей (цвет = источник) ===
        capHtml += `<div class="banner-capital" id="invest-banner-capital" style="text-align:right;">`;
        portfolioRows.forEach(function(row) {
            capHtml += `<div class="banner-capital-line"><span class="banner-capital-value">${formatCurrency(row.currentTotal)}</span>${renderTurnoverBlock(row.source, row.currentTotal)}</div>`;
        });
        capHtml += `</div>`;

        // === ASSETS BARS: капитал слева + бары справа ===
        if (portfolioRows.length > 0) {
            const totalCapital = portfolioRows.reduce(function(s, r) { return s + r.currentTotal; }, 0);
            capHtml += `<div class="banner-assets-row">`;
            capHtml += `<div class="banner-total-capital">${formatCurrency(totalCapital)}</div>`;
            capHtml += `<div class="banner-assets" id="invest-assets-bars">`;
            portfolioRows.forEach(function(row) {
                if (row.assets.length === 0) return;
                capHtml += `<div class="asset-row">`;
                capHtml += `<span class="asset-row-label" style="color:${row.color};font-size:10px;font-weight:bold;margin: 0px 4px 0px 5px;min-width:18px;">${row.marker}</span>`;
                capHtml += `<div class="asset-bar-container">`;
                row.assets.forEach(function(asset, index) {
                    let color = COLORS.assetColors[index % COLORS.assetColors.length];
                    if (asset.ticker.includes('TGLD')) color = '#efad05';
                    else if (asset.ticker.includes('TMON')) color = COLORS.coral;
                    else if (asset.ticker.includes('RUB') || asset.name.includes('Руб')) color = COLORS.rubTicker;

                    let assetTitle = asset.name;
                    if (assetTitle.includes('TGLD')) assetTitle = 'Золото (TGLD)';
                    else if (assetTitle.includes('TMON')) assetTitle = 'Обл. Минфин (TMON)';
                    else if (assetTitle.includes('RUB')) assetTitle = 'Рубль';

                    capHtml += `<span class="asset-bar" title="${assetTitle}" style="width: ${Math.max(asset.percent, 1)}%; background-color: ${color};"><span class="asset-bar-label">${asset.percent.toFixed(1)}%</span></span>`;
                });
                capHtml += `</div>`;
                capHtml += `</div>`;
            });
            capHtml += `</div>`;
            capHtml += `</div>`;
        }

        // === TABLE: banner-row-portfolio — T+F итого + строки по источникам ===
        tblHtml += `<table class="banner-table" id="invest-banner-table"><tbody>`;

        // --- T+F итого (первая строка) ---
        if (portfolioRows.length > 0) {
            var tfCurrent = portfolioRows.reduce(function(s, r) { return s + r.currentTotal; }, 0);

            function sumBaselineForAll(hist, stamps, srcArr, fn) {
                return srcArr.reduce(function(s, src) { return s + fn(hist, stamps, src); }, 0);
            }
            var tfBase = sumBaselineForAll(historyData, timestamps, presentSources, calculateBaselineTotal);
            var tfBaseWeek = sumBaselineForAll(historyData, timestamps, presentSources, calculateWeekBaselineTotal);
            var tfBasePeriod = sumBaselineForAll(dynHistory, dynTimestamps, presentSources, function(h, s, src) {
                return calculatePeriodBaselineTotal(h, s, periodMs, src);
            });

            var tfAbs = tfCurrent - tfBase;
            var tfPct = tfBase !== 0 ? (tfAbs / tfBase * 100) : 0;
            var tfAbsW = tfCurrent - tfBaseWeek;
            var tfPctW = tfBaseWeek !== 0 ? (tfAbsW / tfBaseWeek * 100) : 0;
            var tfAbsP = tfCurrent - tfBasePeriod;
            var tfPctP = tfBasePeriod !== 0 ? (tfAbsP / tfBasePeriod * 100) : 0;
            var tfDayCls = tfAbs >= 0 ? 'change-positive' : 'change-negative';
            var tfWeekCls = tfAbsW >= 0 ? 'change-positive' : 'change-negative';
            var tfPeriodCls = tfAbsP >= 0 ? 'change-positive' : 'change-negative';

            tblHtml += `<tr class="banner-row-portfolio-total">
            <td class="banner-td-num" style="color:#999;font-size:10px;min-width:16px;text-align:left;">T+F</td>
            <td class="banner-td-change ${tfDayCls}">${formatChange(tfAbs)}</td>
            <td class="banner-td-pct ${tfDayCls}">${formatPercent(tfPct)}</td>
            <td class="banner-td-change ${tfWeekCls}">${formatChange(tfAbsW)}</td>
            <td class="banner-td-pct ${tfWeekCls}">${formatPercent(tfPctW)}</td>
            <td class="banner-td-change ${tfPeriodCls}">${formatChange(tfAbsP)}</td>
            <td class="banner-td-pct ${tfPeriodCls}">${formatPercent(tfPctP)}</td>
        </tr>`;
        }

        portfolioRows.forEach(function(row) {
            tblHtml += `<tr class="${row.cssClass}" style="opacity:0.7;">
            <td class="banner-td-num" style="color:${row.color};font-size:10px;font-weight:bold;min-width:16px;text-align:left;">${row.marker}</td>
            <td class="banner-td-change ${row.dayChangeClass}">${formatChange(row.absChange)}</td>
            <td class="banner-td-pct ${row.dayChangeClass}">${formatPercent(row.pctChange)}</td>
            <td class="banner-td-change ${row.weekChangeClass}">${formatChange(row.absChangeWeek)}</td>
            <td class="banner-td-pct ${row.weekChangeClass}">${formatPercent(row.pctChangeWeek)}</td>
            <td class="banner-td-change ${row.periodChangeClass}">${formatChange(row.absChangePeriod)}</td>
            <td class="banner-td-pct ${row.periodChangeClass}">${formatPercent(row.pctChangePeriod)}</td>
        </tr>`;
        });

        tblHtml += renderAssetRow('TGLD@', COLORS.tgold, 'TGLD');
        tblHtml += renderAssetRow('TMON@', '#e74c3c', 'TMON');
        tblHtml += renderAssetRow('XAU/USD', '#cc7722', 'XAU');

        tblHtml += `</tbody></table>`;

        if ($capHost.length) $capHost.html(capHtml);
        if ($tblHost.length) $tblHost.html(tblHtml);
        console.log('[InvestBanner] Banner rendered, sources:', presentSources, 'capital:', totals, 'assets:', portfolioRows.map(r => r.assets.length));
    }

    function loadRefHistory(callback) {
        $.getJSON('/api/invest/history?interval=hour&period=-8%20day')
            .done(function(d) { refHistory = d; })
            .fail(function() { console.warn('[InvestBanner] ref history failed'); })
            .always(function() { if (callback) callback(); });
    }

    function updateInvestBanner() {
        console.log('[InvestBanner] updateInvestBanner called');

        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const cacheBust = '&_=' + Date.now();
        const turnoverUrl = '/api/invest/turnover?since=' + Math.floor(midnight.getTime() / 1000) + cacheBust;

        function renderWithTurnover() {
            loadRefHistory(function() {
            loadTickersData(function() {
                const period = getSetting('invest_panel_period', '-35 day');
                const interval = {
                    '-90 day': 'day',
                    '-35 day': 'hour',
                    '-7 day': 'hour',
                    '-1 day': 'hour',
                    '-12 hour': 'fivemin',
                    '-6 hour': 'fivemin',
                    '-3 hour': 'minute',
                    '-1 hour': 'minute'
                }[period] || 'hour';
                $.getJSON('/api/invest/history?interval=' + interval + '&period=' + encodeURIComponent(period), function(historyData) {
                    console.log('[InvestBanner] Data received, keys:', Object.keys(historyData).length);
                    renderBanner(refHistory || historyData, historyData);
                }).fail(function(xhr, status, error) {
                    console.error('[InvestBanner] Ошибка загрузки истории:', status, error);
                    ['#invest_banner_capital_content', '#invest_banner_table_content'].forEach(function(sel) {
                        $(sel).html('<div class="banner-message error">Ошибка загрузки</div>');
                    });
                });
            });
            });
        }

        $.getJSON(turnoverUrl)
            .done(function(d) { turnoverData = d; console.log('[Turnover] fetched OK, keys=', Object.keys(d)); })
            .fail(function(xhr, status, err) { console.warn('[Turnover] FAILED:', status, err, 'xhr.status=', xhr.status); })
            .always(function() { renderWithTurnover(); });
    }

    function init() {
        console.log('[InvestBanner] init called');
        
        loadTickersData();
        updateInvestBanner();
    }

    // Принимает готовые данные (из invest_chart.js), без повторного fetch
    function renderFromData(historyData, externalTickers) {
        if (externalTickers && typeof externalTickers === 'object') {
            $.extend(tickersData, externalTickers);
        }
        const render = function() {
            renderBanner(refHistory || historyData, historyData);
        };
        if (!refHistory) {
            loadRefHistory(function() {
                if (Object.keys(tickersData).length === 0) {
                    loadTickersData(render);
                } else {
                    render();
                }
            });
        } else if (Object.keys(tickersData).length === 0) {
            loadTickersData(render);
        } else {
            render();
        }
    }

    $(document).ready(init);

    $(document).on('panelViewChange', function(e, data) {
        if (data && (data.panel === 'invest_panel' || data.panel === 'invest_banner_capital' || data.panel === 'invest_banner_table')) {
            updateInvestBanner();
        }
    });

    window.InvestBanner = {
        update: updateInvestBanner,
        renderFromData: renderFromData
    };

})(jQuery);
