// static/js/invest_banner.js
// HTML-версия баннера (без Chart.js)
console.log("🚀 invest_banner.js загружен (HTML version)");

(function($) {
    'use strict';

    let tickersData = {};            // актуальный payload секции invest.tickers
    let lastTickersData = {};        // последние удачные тикеры — ассет-строки не мигают
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

        // Базовое значение = первая точка СЕГОДНЯ (даже если источник пуст / 0),
        // иначе изменение «с начала суток» для опустевшего источника (T) съедало бы
        // весь исторический капитал, хотя движения за сегодня не было.
        let todaySeen = false;
        let zeroBaseline = null;
        for (const ts of timestamps) {
            if (new Date(ts) < todayStart) continue;
            const entry = historyData[ts];
            if (!Array.isArray(entry)) continue;
            todaySeen = true;
            const v = sumEntryBySource(entry, source);
            if (zeroBaseline === null) zeroBaseline = v; // первая точка сегодня (может быть 0)
            if (v > 0) return v;                          // первое положительное значение дня
        }

        // Если сегодня есть снепшоты — базой служит первая точка сегодня (в т.ч. 0).
        if (todaySeen && zeroBaseline !== null) return zeroBaseline;

        // Если сегодня ещё нет снепшотов — берём последнюю положительную точку прошлого дня.
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

    // Выбранный в period-trigger интервал графика: явный диапазон (start_ts/end_ts)
    // или относительный период (invest_panel_period). Возвращает начало окна в мс.
    function resolveRangeStartMs() {
        const start = getSetting('invest_panel_start_ts', null);
        if (start) {
            const s = parseInt(start, 10);
            if (!isNaN(s)) return s * 1000;
        }
        const period = getSetting('invest_panel_period', '-35 day');
        return Date.now() - calculatePeriodMs(period);
    }

    // Базовое значение для «изменения за период» = первая точка внутри выбранного
    // окна (даже если источник там пуст/0 — тогда изменение = разница от этого уровня).
    // Окно берётся из period-trigger графика, как и на самом графике.
    function calculateRangeBaselineTotal(historyData, timestamps, rangeStartMs, source) {
        let seen = false;
        let zeroBaseline = null;
        for (const ts of timestamps) {
            const t = new Date(ts).getTime();
            if (t < rangeStartMs) continue;
            const entry = historyData[ts];
            if (!Array.isArray(entry)) continue;
            seen = true;
            const v = sumEntryBySource(entry, source);
            if (zeroBaseline === null) zeroBaseline = v;
            if (v > 0) return v;
        }
        if (seen && zeroBaseline !== null) return zeroBaseline;

        // Внутри окна данных нет — откат к последней точке перед окном.
        for (let i = timestamps.length - 1; i >= 0; i--) {
            const entry = historyData[timestamps[i]];
            if (new Date(timestamps[i]).getTime() < rangeStartMs && Array.isArray(entry)) {
                const v = sumEntryBySource(entry, source);
                if (v > 0) return v;
            }
        }
        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry) ? sumEntryBySource(firstEntry, source) : 0;
    }

    const TICKER_CACHE_TTL_MS = 3 * 60 * 1000;

    // Берём тикеры из общего кэша графика (window.__investTickerCache), если он свежий.
    // Иначе грузим свои. Полные day/week/month проценты приходят с сервера (baseline),
    // поэтому период загрузки не важен для корректности изменений.
    function loadTickersData(callback) {
        const cached = window.__investTickerCache;
        if (cached && cached.data && (Date.now() - cached.at) < TICKER_CACHE_TTL_MS) {
            tickersData = cached.data;
            lastTickersData = cached.data;
            if (callback) callback();
            return;
        }
        const p = getSetting('invest_panel_period', '-35 day');
        const apiPeriod = p === '-1 day' ? '-1.5 day' : p;
        const sTs = getSetting('invest_panel_start_ts', null);
        const eTs = getSetting('invest_panel_end_ts', null);
        let rangeQs = '';
        if (sTs) rangeQs = '&start_ts=' + encodeURIComponent(sTs) + (eTs ? ('&end_ts=' + encodeURIComponent(eTs)) : '');
        $.getJSON('/api/invest/tickers?period=' + encodeURIComponent(apiPeriod) + rangeQs)
            .done(function(data) {
                if (data && !data.error && Object.keys(data).length > 0) {
                    tickersData = data;
                    lastTickersData = data;
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
    // Хеш последнего отрисованного баннера: при совпадении DOM не перерисовываем.
    let _lastBannerHash = null;

    // === Медиатор: подписки на invest-секции (panel_mediator.js) ===
    let mediatorHistory = null;       // полный payload invest.history (текущее окно)
    let mediatorHistoryAt = 0;        // ts последней доставки истории
    let turnoverDetails = null;       // детализация оборота (invest.turnover_details)
    let turnoverDetailsAt = 0;        // ts последней доставки детализации
    let lastDataEpoch = 0;            // истинный ts последнего снапшота (_latest_epoch)
    const MEDIATOR_HISTORY_TTL_MS = 70000;

    function historyIntervalFor(period) {
        return {
            '-90 day': 'day', '-35 day': 'hour', '-7 day': 'hour', '-1 day': 'hour',
            '-12 hour': 'fivemin', '-6 hour': 'fivemin', '-3 hour': 'minute', '-1 hour': 'minute'
        }[period] || 'hour';
    }

    // Параметры секции invest.history — совпадают с окном самого баннера.
    function mediatorHistoryParams() {
        const period = getSetting('invest_panel_period', '-35 day');
        const params = { interval: historyIntervalFor(period), period: period };
        const sTs = getSetting('invest_panel_start_ts', null);
        const eTs = getSetting('invest_panel_end_ts', null);
        if (sTs) params.start_ts = sTs;
        if (eTs) params.end_ts = eTs;
        return params;
    }

    function mediatorTickersParams() {
        const p = getSetting('invest_panel_period', '-35 day');
        const apiPeriod = p === '-1 day' ? '-1.5 day' : p;
        const params = { period: apiPeriod };
        const sTs = getSetting('invest_panel_start_ts', null);
        const eTs = getSetting('invest_panel_end_ts', null);
        if (sTs) params.start_ts = sTs;
        if (eTs) params.end_ts = eTs;
        return params;
    }

    function onMediatorTickers(payload) {
        if (!payload || typeof payload !== 'object') return;
        tickersData = payload;
        if (payload && Object.keys(payload).length > 0) lastTickersData = payload;
        if (typeof window.__investTickerCache === 'undefined') window.__investTickerCache = {};
        window.__investTickerCache.data = payload;
        window.__investTickerCache.at = Date.now();
        maybeRenderFromMediator();
    }

    function onMediatorTurnover(payload) {
        if (!payload || typeof payload !== 'object') return;
        turnoverData = payload;
        maybeRenderFromMediator();
    }

    function onMediatorTurnoverDetails(payload) {
        if (!payload || typeof payload !== 'object') return;
        turnoverDetails = payload;
        turnoverDetailsAt = Date.now();
        maybeRenderFromMediator();
    }

    function onMediatorHistory(payload) {
        if (!payload || typeof payload !== 'object') return;
        if (payload._latest_epoch != null) lastDataEpoch = Number(payload._latest_epoch);
        const cache = window.InvestHistoryCache;
        const p = mediatorHistoryParams();
        if (payload._tail && cache && cache.applyMediatorTail) {
            // Хвост (дельта) медиатора: мёрджим в полный кэш, чтобы рендер
            // видел целую историю (в changed уходит только последний бакет).
            const merged = cache.applyMediatorTail(p.interval, p.period, p.start_ts, p.end_ts, payload);
            if (merged) {
                mediatorHistory = merged;
                mediatorHistoryAt = Date.now();
                maybeRenderFromMediator();
                return;
            }
            // Редкий edge: хвост пришёл, а полного кэша нет — берём полный через GET.
            cache.get(p.interval, p.period, p.start_ts, p.end_ts)
                .then(function(d) {
                    mediatorHistory = d;
                    mediatorHistoryAt = Date.now();
                    maybeRenderFromMediator();
                })
                .catch(function() {
                    mediatorHistoryAt = Date.now();
                });
            return;
        }
        mediatorHistory = payload;
        mediatorHistoryAt = Date.now();
        if (cache && cache.primeFromMediator) {
            cache.primeFromMediator(p.interval, p.period, p.start_ts, p.end_ts, payload);
        }
        maybeRenderFromMediator();
    }

    // Рендер из актуальных данных медиатора (статические колонки — refHistory 10 мин).
    function maybeRenderFromMediator() {
        if (!mediatorHistory || Object.keys(mediatorHistory).length === 0) return;
        const render = function() {
            renderBanner(refHistory || mediatorHistory, mediatorHistory);
        };
        if (!refHistory) loadRefHistory(render); else render();
    }

    // Медиатор живой и обслуживает текущее окно истории — GET-слой не нужен.
    function mediatorCanServe() {
        const pm = window.PanelMediator;
        if (!pm || typeof pm.healthy !== 'function' || !pm.healthy()) return false;
        if (!mediatorHistory) return false;
        return (Date.now() - mediatorHistoryAt) < MEDIATOR_HISTORY_TTL_MS;
    }

    function setupMediator() {
        const pm = window.PanelMediator;
        if (!pm || typeof pm.subscribe !== 'function') return;
        pm.subscribe('invest.tickers', onMediatorTickers, { params: mediatorTickersParams });
        pm.subscribe('invest.turnover', onMediatorTurnover, { params: null });
        pm.subscribe('invest.turnover_details', onMediatorTurnoverDetails, { params: null });
        pm.subscribe('invest.history', onMediatorHistory, { params: mediatorHistoryParams });
    }

    function formatCompactRub(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'М';
        if (n >= 1000) {
            const k = n / 1000;
            return (k >= 100 ? Math.round(k).toString() : k.toFixed(k >= 10 ? 1 : 2)).replace('.', ',') + 'к';
        }
        return String(Math.round(n));
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
        // Тултип из детализации оборота (секция медиатора invest.turnover_details).
        const d = (turnoverDetails && turnoverDetails[source]) || {};
        let title = '';
        if ((d.base || d.orders || d.rate_percent) &&
            (Date.now() - turnoverDetailsAt) < 12 * 60 * 60 * 1000) {
            const bits = [];
            if (d.base) bits.push('база ' + formatCompactRub(d.base));
            if (d.session) bits.push('сессия ' + formatCompactRub(d.session));
            if (d.evening) bits.push('вечер ' + formatCompactRub(d.evening));
            if (d.rate_percent) bits.push('ставка ' + String(d.rate_percent).replace('.', ',') + '%');
            if (d.orders) bits.push(d.orders + ' поручений');
            if (d.fee_per_order) bits.push(String(d.fee_per_order).replace('.', ',') + '₽/поруч');
            if (bits.length) title = ' title="' + bits.join(' · ') + '"';
        }
        return `<table class="banner-turnover-block${sourceClass}"${title}><tr>` +
            `<td>x${xStr}</td><td class="tb-col2">${formatCompactRub(total)}</td></tr>` +
            `<tr><td>${pctStr} %</td><td class="tb-col2">${formatCompactRub(comm)}</td></tr>` +
            `</table>`;
    }

    function renderAssetRow(ticker, color, label) {
        const t = tickersData[ticker] || lastTickersData[ticker];
        if (!t) return '';           // данных нет — строку не рисуем (доедут из первого полного опроса)
        const price = t.current_price || 0;
        const dayAbs = t.day_change || 0;
        const dayPct = t.day_change_pct || 0;

        const weekAbs = (t.week_change !== null && t.week_change !== undefined) ? t.week_change : null;
        const weekPct = (t.week_change_pct !== null && t.week_change_pct !== undefined) ? t.week_change_pct : null;

        // «Период» = начало выбранного пользователем интервала (первая точка
        // загруженного диапазона), а не фиксированный месяц. Серверный baseline
        // 'month' (30 дней) здесь не используется.
        let periodAbs = null;
        let periodPct = null;
        const firstPrice = (t.prices && t.prices.length) ? Number(t.prices[0].price) : null;
        if (firstPrice != null && firstPrice > 0 && t.current_price > 0) {
            periodAbs = t.current_price - firstPrice;
            periodPct = periodAbs / firstPrice * 100;
        }

        const dayClass = dayPct >= 0 ? 'change-positive' : 'change-negative';
        const weekClass = weekPct !== null ? (weekPct >= 0 ? 'change-positive' : 'change-negative') : '';
        const periodClass = periodPct !== null ? (periodPct >= 0 ? 'change-positive' : 'change-negative') : '';

        const absStyle = 'opacity:0.2';
        const rowCls = 'banner-row-asset ' + label.toLowerCase();

        return `<tr class="${rowCls}">
            <td class="banner-td-empty"></td>
            <td class="banner-td-num" style="color:${color}">${formatPrice(price)}</td>
            <td class="banner-td-pct ${dayClass}">${formatPercent(dayPct)}</td>
            <td class="banner-td-change ${dayClass}" style="${absStyle}">${formatTickerAbs(dayAbs)}</td>
            <td class="banner-td-pct ${weekClass}">${weekPct !== null ? formatPercent(weekPct) : '—'}</td>
            <td class="banner-td-change ${weekClass}" style="${absStyle}">${weekAbs !== null ? formatTickerAbs(weekAbs) : '—'}</td>
            <td class="banner-td-pct ${periodClass}">${periodPct !== null ? formatPercent(periodPct) : '—'}</td>
            <td class="banner-td-change ${periodClass}" style="${absStyle}">${periodAbs !== null ? formatTickerAbs(periodAbs) : '—'}</td>
        </tr>`;
    }

    // Метка в углу панели: время ПОСЛЕДНИХ ДАННЫХ (последний снапшот), МСК.
    // Метка живёт СВОЕЙ жизнью и не зависит от результата рендера: тикер
    // читает последний payload секции invest.history прямо из медиатора, а
    // эпоха считается как МОНОТОННЫЙ максимум всех источников (медиатор +
    // переданное окно + _med-кэш хелпера). Это чинит заморозку метки в
    // GET-fallback/чат-путях, где lastDataEpoch не обновлялся.
    let lastShownEpoch = 0;

    function epochFromData(data) {
        let maxE = 0;
        if (!data) return maxE;
        for (const k in data) {
            if (k.charAt(0) === '_') continue;
            const e = Date.parse(k) / 1000;
            if (!isNaN(e) && e > maxE) maxE = e;
        }
        return maxE;
    }

    function collectFreshnessEpoch(historyData) {
        let epoch = 0;
        if (historyData) {
            if (historyData._latest_epoch != null) {
                const me = Number(historyData._latest_epoch);
                if (!isNaN(me) && me > epoch) epoch = me;
            }
            const be = epochFromData(historyData);
            if (be > epoch) epoch = be;
        }
        if (lastDataEpoch > epoch) epoch = lastDataEpoch;
        const med = window.InvestHistoryCache && window.InvestHistoryCache._med;
        if (med && med.data) {
            const me2 = epochFromData(med.data);
            if (me2 > epoch) epoch = me2;
        }
        return epoch;
    }

    function renderFreshnessLabel(epoch) {
        if (!epoch) return;
        const d = new Date(epoch * 1000 + 3 * 3600 * 1000);
        const pad = function(n) { return (n < 10 ? '0' : '') + n; };
        const txt = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
        ['invest_banner_capital', 'invest_banner_table', 'invest_banner_total'].forEach(function(panelId) {
            const panel = document.getElementById(panelId);
            if (!panel) return;
            const key = panelId.replace('invest_banner_', '');
            let el = document.getElementById('banner_freshness_' + key);
            if (!el) {
                el = document.createElement('div');
                el.id = 'banner_freshness_' + key;
                el.style.cssText = 'position:absolute;bottom:2px;left:4px;font-size:11px;color:#888;z-index:15;font-family:helvetica,arial,sans-serif;pointer-events:none;opacity:0.45;white-space:nowrap;';
                panel.appendChild(el);
            }
            el.textContent = txt;
        });
    }

    function setBannerFreshness(historyData) {
        const epoch = collectFreshnessEpoch(historyData);
        if (!epoch || epoch <= lastShownEpoch) return;
        lastShownEpoch = epoch;
        renderFreshnessLabel(epoch);
    }

    // Альтернатива pro компонента рендера для метки свежести.
    // Явный старт-тикер: читает последний payload медиатора раз в 3 с и
    // двигает метку, даже если renderBanner упал или данные едут GET-путём.
    function startDataFreshnessTicker() {
        if (window.__bannerFreshnessTick) clearInterval(window.__bannerFreshnessTick);
        window.__bannerFreshnessTick = setInterval(function() {
            const pm = window.PanelMediator;
            const latest = pm && typeof pm.getLatest === 'function' && pm.getLatest('invest.history');
            setBannerFreshness(latest || null);
        }, 3000);
    }

    function renderBanner(historyData, dynData) {
        console.log('[renderBanner] called, turnoverData=', !!turnoverData, 'keys=', turnoverData ? Object.keys(turnoverData) : 'null');
        const t0 = performance.now();
        const $capHost = $('#invest_banner_capital_content');
        const $tblHost = $('#invest_banner_table_content');
        const $totalHost = $('#invest_banner_total_content');

        // Отдельная панель «Итого» считается видимой, если у неё не display:none.
        function isTotalPanelVisible() {
            const p = document.getElementById('invest_banner_total');
            return !!p && p.style.display !== 'none' && getComputedStyle(p).display !== 'none';
        }

        function emptyState(msg) {
            const cls = msg.startsWith('Ошибка') ? ' error' : '';
            if ($capHost.length) $capHost.html(`<div class="banner-message${cls}">${msg}</div>`);
            if ($tblHost.length) $tblHost.html(`<div class="banner-message${cls}">${msg}</div>`);
            if ($totalHost.length) $totalHost.html(`<div class="banner-message${cls}">${msg}</div>`);
        }

        if (!historyData || Object.keys(historyData).length === 0) {
            emptyState('Нет данных');
            return;
        }

        const timestamps = Object.keys(historyData).filter(k => k.charAt(0) !== '_').sort();
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
        const COLLECTION_KEY = { finam: 'invest_collection_finam_enabled', tinkoff: 'invest_collection_tinkoff_enabled' };
        const collectionEnabled = function(src) {
            const key = COLLECTION_KEY[src];
            // Если настройки нет — считаем сбор включённым.
            return !key || getSetting(key, '1') !== '0';
        };
        // Источник показываем, если у него есть данные в последней точке + сумма >= 0,
        // И сбор данных через API для него не отключён в настройках.
        const presentSources = ['finam', 'tinkoff'].filter(s => Object.prototype.hasOwnProperty.call(totals, s) && collectionEnabled(s));

        const period = getSetting('invest_panel_period', '-35 day');

        // Динамический датасет выбранного периода — только для колонок 5-6.
        // Окно периода берём из period-trigger графика (выбранный диапазон),
        // чтобы колонки «за период» совпадали с тем, что показано на графике.
        const rangeStartMs = resolveRangeStartMs();
        const dynHistory = dynData || historyData;
        const dynTimestamps = Object.keys(dynHistory).filter(k => k.charAt(0) !== '_').sort();
        const rangeBaselineTotal = function(src) {
            return calculateRangeBaselineTotal(dynHistory, dynTimestamps, rangeStartMs, src);
        };

        // Показатели по каждому портфелю отдельно
        const portfolioRows = presentSources.map(function(src) {
            const currentTotal = totals[src];
            const baselineTotal = calculateBaselineTotal(historyData, timestamps, src);
            const baselineWeekTotal = calculateWeekBaselineTotal(historyData, timestamps, src);
            const baselinePeriodTotal = rangeBaselineTotal(src);
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

        // === Хеш входных данных: если не изменился — DOM не перерисовываем.
        // Полный repaint (.html() каждый тик 60с) — лишний, когда данные статичны.
        const hashBits = [
            historyData._prev ? 'prev' : 'np',
            presentSources.join(','),
            portfolioRows.map(r => r.currentTotal.toFixed(2) + '|' + r.absChange.toFixed(2) + '|' + r.pctChange.toFixed(2) + '|' + r.pctChangeWeek.toFixed(2) + '|' + r.pctChangePeriod.toFixed(2)).join(';'),
            (turnoverData ? Object.keys(turnoverData).sort().map(k => k + ':' + (turnoverData[k].total || 0) + ':' + (turnoverData[k].commission || 0)).join(';') : ''),
            (tickersData ? Object.keys(tickersData).sort().map(k => { const t = tickersData[k]; return k + ':' + (t.current_price || 0) + ':' + (t.day_change_pct || 0); }).join(';') : ''),
            rangeStartMs.toString()
        ].join('|');
        if (hashBits === _lastBannerHash) {
            console.log('[InvestBanner] Данные не изменились — DOM пропущен');
            return;
        }
        _lastBannerHash = hashBits;
        console.log('[InvestBanner] render inputs: present=' + presentSources.join(',') +
            ' tickersRows=' + ['TGLD@', 'TMON@', 'XAU/USD'].map(function(k) { return (tickersData && tickersData[k]) ? 1 : 0; }).join('/') +
            ' histKey=' + (historyData === refHistory ? 'refHistory' : 'window') +
            ' baseTs=' + (timestamps[timestamps.length - 1] || '?'));

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
            // Отдельная панель «Итого»: только значение, без подписей.
            if ($totalHost.length) {
                $totalHost.html(`<div class="banner-total-only">${formatCurrency(totalCapital)}</div>`);
            }
            capHtml += `<div class="banner-assets-row">`;
            // Инлайн «Итого» в панели Капитала показываем только когда отдельная
            // панель «Итого» скрыта и активны 2+ источника (иначе — дублирование/избыточность).
            if (!isTotalPanelVisible() && portfolioRows.length > 1) {
                capHtml += `<div class="banner-total-capital">${formatCurrency(totalCapital)}</div>`;
            }
            capHtml += `<div class="banner-assets" id="invest-assets-bars">`;
            portfolioRows.forEach(function(row) {
                if (row.assets.length === 0) return;
                capHtml += `<div class="asset-row">`;
                capHtml += `<span class="asset-row-label" style="color:${row.color};font-size:10px;font-weight:bold;margin: 0px 4px 0px 5px;min-width:18px;">${row.marker}</span>`;
                capHtml += `<div class="asset-bar-container">`;
                row.assets.forEach(function(asset) {
                    // Класс по типу актива — цвет/прозрачность задаётся в wclock.css,
                    // чтобы не дублировать альфу в JS-копиях баннера.
                    let barClass = '';
                    if (asset.ticker.includes('TGLD')) barClass = 'asset-bar-tgld';
                    else if (asset.ticker.includes('TMON')) barClass = 'asset-bar-tmon';
                    else if (asset.ticker.includes('LQDT')) barClass = 'asset-bar-lqdt';
                    else if (asset.ticker.includes('RUB') || asset.name.includes('Руб')) barClass = 'asset-bar-rub';
                    else barClass = 'asset-bar-other';

                    let assetTitle = asset.name;
                    if (assetTitle.includes('TGLD')) assetTitle = 'Золото (TGLD)';
                    else if (assetTitle.includes('TMON')) assetTitle = 'Обл. Минфин (TMON)';
                    else if (assetTitle.includes('RUB')) assetTitle = 'Рубль';

                    capHtml += `<span class="asset-bar ${barClass}" title="${assetTitle} — ${formatCurrency(asset.percent / 100 * row.currentTotal)} ₽" style="width: ${Math.max(asset.percent, 1)}%;"><span class="asset-bar-label">${asset.percent.toFixed(1)}%</span></span>`;
                });
                capHtml += `</div>`;
                capHtml += `</div>`;
            });
            capHtml += `</div>`;
            capHtml += `</div>`;
        }

        // === TABLE: banner-row-portfolio — T+F итого + строки по источникам ===
        tblHtml += `<table class="banner-table" id="invest-banner-table"><tbody>`;

        // --- T+F итого (первая строка): только когда активны 2+ источника ---
        if (portfolioRows.length > 1) {
            var tfCurrent = portfolioRows.reduce(function(s, r) { return s + r.currentTotal; }, 0);

            function sumBaselineForAll(hist, stamps, srcArr, fn) {
                return srcArr.reduce(function(s, src) { return s + fn(hist, stamps, src); }, 0);
            }
            var tfBase = sumBaselineForAll(historyData, timestamps, presentSources, calculateBaselineTotal);
            var tfBaseWeek = sumBaselineForAll(historyData, timestamps, presentSources, calculateWeekBaselineTotal);
            var tfBasePeriod = sumBaselineForAll(dynHistory, dynTimestamps, presentSources, function(h, s, src) {
                return calculateRangeBaselineTotal(h, s, rangeStartMs, src);
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
            <td class="banner-td-num" style="color:#999;font-size:2.2cqi;min-width:16px;text-align:left;">T+F</td>
            <td class="banner-td-change ${tfDayCls}">${formatChange(tfAbs)}</td>
            <td class="banner-td-pct ${tfDayCls}">${formatPercent(tfPct)}</td>
            <td class="banner-td-change ${tfWeekCls}">${formatChange(tfAbsW)}</td>
            <td class="banner-td-pct ${tfWeekCls}">${formatPercent(tfPctW)}</td>
            <td class="banner-td-change ${tfPeriodCls}">${formatChange(tfAbsP)}</td>
            <td class="banner-td-pct ${tfPeriodCls}">${formatPercent(tfPctP)}</td>
        </tr>`;
        }

        portfolioRows.forEach(function(row) {
            const rowOpacity = row.cssClass === 'banner-row-portfolio-finam' ? 1 : 0.7;
            tblHtml += `<tr class="${row.cssClass}" style="opacity:${rowOpacity};">
            <td class="banner-td-num" style="color:${row.color};font-size:2.2cqi;font-weight:bold;min-width:16px;text-align:left;">${row.marker}</td>
            <td class="banner-td-num" style="color:${row.color};text-align:right;">${(row.currentTotal / 1e3).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}</td>
            <td class="banner-td-pct ${row.dayChangeClass}">${formatPercent(row.pctChange)}</td>
            <td class="banner-td-change ${row.dayChangeClass}">${formatChange(row.absChange)}</td>
            <td class="banner-td-pct ${row.weekChangeClass}">${formatPercent(row.pctChangeWeek)}</td>
            <td class="banner-td-change ${row.weekChangeClass}">${formatChange(row.absChangeWeek)}</td>
            <td class="banner-td-pct ${row.periodChangeClass}">${formatPercent(row.pctChangePeriod)}</td>
            <td class="banner-td-change ${row.periodChangeClass}">${formatChange(row.absChangePeriod)}</td>
        </tr>`;
        });

        tblHtml += renderAssetRow('TGLD@', COLORS.tgold, 'TGLD');
        tblHtml += renderAssetRow('XAU/USD', '#cc7722', 'XAU');

        tblHtml += `</tbody></table>`;

        const tBuild = performance.now();
        if ($capHost.length) $capHost.html(capHtml);
        if ($tblHost.length) $tblHost.html(tblHtml);
        setBannerFreshness(dynData || historyData);
        const t1 = performance.now();
        console.log('[InvestBanner] renderBanner build', (tBuild - t0).toFixed(2) + 'ms', '| dom-set', (t1 - tBuild).toFixed(2) + 'ms', '| total', (t1 - t0).toFixed(2) + 'ms');
        console.log('[InvestBanner] Banner rendered, sources:', presentSources, 'capital:', totals, 'assets:', portfolioRows.map(r => r.assets.length),
            'inLastTs', (Array.isArray(dynHistory[dynTimestamps[dynTimestamps.length - 1]]) ? dynHistory[dynTimestamps[dynTimestamps.length - 1]].map(function(p) { return p && p.source; }) : 'n/a'));
    }

    let refHistoryLoadedAt = 0;
    const REF_HISTORY_TTL_MS = 10 * 60 * 1000;

    function loadRefHistory(callback) {
        if (refHistory && (Date.now() - refHistoryLoadedAt) < REF_HISTORY_TTL_MS) {
            if (callback) callback();
            return;
        }
        $.getJSON('/api/invest/history?interval=hour&period=-8%20day')
            .done(function(d) { refHistory = d; refHistoryLoadedAt = Date.now(); })
            .fail(function() { console.warn('[InvestBanner] ref history failed'); })
            .always(function() { if (callback) callback(); });
    }

    function updateInvestBanner() {
        console.log('[InvestBanner] updateInvestBanner called');

        const cap = document.getElementById('invest_banner_capital');
        const tbl = document.getElementById('invest_banner_table');
        if ((!cap || cap.style.display === 'none') && (!tbl || tbl.style.display === 'none')) {
            return;
        }

        // Медиатор живой и обслуживает текущее окно — рендер из его данных,
        // прямые GET не нужны. Иначе — fallback: старый параллельный fetch.
        if (mediatorCanServe()) {
            maybeRenderFromMediator();
            return;
        }

        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const cacheBust = '&_=' + Date.now();
        const turnoverUrl = '/api/invest/turnover?since=' + Math.floor(midnight.getTime() / 1000) + cacheBust;

        const period = getSetting('invest_panel_period', '-35 day');
        // Явный диапазон period-trigger перекрывает относительный период,
        // чтобы колонки «за период» совпадали с окном графика.
        const startTs = getSetting('invest_panel_start_ts', null);
        const endTs = getSetting('invest_panel_end_ts', null);
        const interval = historyIntervalFor(period);

        // === Параллельный fetch: баннер не ждёт данные друг за другом ===
        // Раньше цепочка была строго последовательной
        // (turnover → refHistory → tickers → history → render) — баннер мог не
        // отрисоваться 3-12с. Теперь все грузятся одновременно, рендер по готовности.
        const tNet0 = performance.now();
        let pend = 0;
        let fd = { history: null, refHistory: null, tickers: null, turnover: null };

        function tryRender() {
            if (pend > 0) return;
            if (!fd.history && !fd.refHistory) {
                console.error('[InvestBanner] Нет истории — баннер не рендерю');
                ['#invest_banner_capital_content', '#invest_banner_table_content'].forEach(function(sel) {
                    $(sel).html('<div class="banner-message error">Ошибка загрузки</div>');
                });
                return;
            }
            const historyData = fd.history;
            console.log('[InvestBanner] Data received, keys:', Object.keys(historyData).length, '| net+render', (performance.now() - tNet0).toFixed(0) + 'ms');
            renderBanner(fd.refHistory || historyData, historyData);
        }

        pend++;
        $.getJSON(turnoverUrl)
            .done(function(d) { fd.turnover = d; turnoverData = d; console.log('[Turnover] fetched OK, keys=', Object.keys(d)); })
            .fail(function(xhr, status, err) { console.warn('[Turnover] FAILED:', status, err, 'xhr.status=', xhr.status); })
            .always(function() { pend--; tryRender(); });

        pend++;
        loadRefHistory(function() {
            fd.refHistory = refHistory;
            pend--; tryRender();
        });

        pend++;
        loadTickersData(function() {
            fd.tickers = tickersData;
            pend--; tryRender();
        });

        pend++;
        if (window.InvestHistoryCache) {
            window.InvestHistoryCache.get(interval, period, startTs, endTs)
                .then(function(data) { fd.history = data; })
                .catch(function(error) {
                    console.error('[InvestBanner] Ошибка загрузки истории:', error);
                })
                .finally(function() { pend--; tryRender(); });
        } else {
            // Fallback до полной загрузки хелпера (helpers.js ещё грузится)
            let fRangeQs = '';
            if (startTs) fRangeQs = '&start_ts=' + encodeURIComponent(startTs) + (endTs ? ('&end_ts=' + encodeURIComponent(endTs)) : '');
            $.getJSON('/api/invest/history?interval=' + interval + '&period=' + encodeURIComponent(period) + fRangeQs + cacheBust)
                .done(function(data) { fd.history = data; })
                .fail(function(xhr, status, error) {
                    console.error('[InvestBanner] Ошибка загрузки истории:', status, error);
                })
                .always(function() { pend--; tryRender(); });
        }
    }

    function init() {
        console.log('[InvestBanner] init called');

        setupMediator();
        startDataFreshnessTicker();
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
