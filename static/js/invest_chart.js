/**
 * invest_chart.js
 * Investment portfolio chart using Chart.js.
 * Registry-driven: adding a new ticker = one entry in TICKER_REGISTRY.
 */

(function($) {
    'use strict';

    let investChart = null;
    let isUpdating = false;
    let initAttempts = 0;
    let dailyGrowthMarks = [];
    let dailyBars = [];
    let resizeTimeout = null;
    let updateTimeout = null;

    const MAX_INIT_ATTEMPTS = 15;
    const INIT_ATTEMPT_DELAY = 200;
    const CANVAS_CHECK_DELAY = 50;
    const RESIZE_DEBOUNCE_MS = 250;
    const RESIZE_THROTTLE_MS = 100;

    // ================================================================
    // TICKER REGISTRY — single source of truth for external tickers
    // To add a new ticker: just add an entry here.
    // ================================================================

    const TICKER_REGISTRY = {
        'TGLD@': {
            label: 'TGLD',
            figi: 'TCS80A101X50',
            color: '#FFD700',
            yAxisID: 'y_tgold',
            tickColor: '#ffd9007e',
            tickFormat: function(v) { return v.toFixed(1); },
            borderWidth: 0.75,
            borderDash: [],
            pointRadius: 0,
            hidden: false,
            aggregation: 'last',
            axisPosition: 'left',
            maxTicksLimit: 6,
        },
        'XAU/USD': {
            label: 'XAU',
            color: '#cc7722',
            yAxisID: 'y_xau',
            tickColor: '#cc7722',
            tickFormat: function(v) { return v >= 1000 ? (v / 1000).toFixed(1) + '\u043A' : v.toFixed(0); },
            borderWidth: 0.75,
            borderDash: [1, 1],
            pointRadius: 0,
            hidden: true,
            aggregation: 'last',
            axisPosition: 'left',
            maxTicksLimit: 6,
        }
    };

    // ================================================================
    // UNIFIED AGGREGATION — single function for all tickers
    // ================================================================

    function aggregateTickerPrices(prices, portfolioTimestamps, method) {
        if (!portfolioTimestamps || portfolioTimestamps.length === 0 || !prices || prices.length === 0) {
            return [];
        }

        var intervalMs = 86400000;
        if (window.currentInterval === 'minute') intervalMs = 60000;
        else if (window.currentInterval === 'fivemin') intervalMs = 300000;
        else if (window.currentInterval === 'twentymin') intervalMs = 1200000;
        else if (window.currentInterval === 'hour') intervalMs = 3600000;
        else if (window.currentInterval === 'sixhour') intervalMs = 21600000;

        var threshold = intervalMs * 2;

        if (method === 'last') {
            // Step-before: latest price <= timestamp (no lookahead, no lag)
            var pi = 0;
            var result = [];
            for (var i = 0; i < portfolioTimestamps.length; i++) {
                var tsMs = portfolioTimestamps[i].getTime();
                while (pi < prices.length - 1 && prices[pi + 1].x.getTime() <= tsMs) {
                    pi++;
                }
                if (prices[pi].x.getTime() <= tsMs && (tsMs - prices[pi].x.getTime()) < threshold) {
                    result.push(prices[pi].y);
                } else {
                    result.push(result.length > 0 ? result[result.length - 1] : null);
                }
            }
            return result;
        }

        // Default: closest (original behavior)
        var rawData = portfolioTimestamps.map(function(ts) {
            var tsMs = ts.getTime();
            var closest = null;
            var minDiff = Infinity;
            for (var k = 0; k < prices.length; k++) {
                var diff = Math.abs(prices[k].x.getTime() - tsMs);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = prices[k].y;
                }
            }
            return minDiff < threshold ? closest : null;
        });

        var result = [];
        var lastValid = null;
        for (var i = 0; i < rawData.length; i++) {
            if (rawData[i] !== null) {
                lastValid = rawData[i];
            }
            result.push(lastValid);
        }
        return result;
    }

    // ================================================================
    // DYNAMIC SCALE BUILDER — generates y-axes from registry
    // ================================================================

    function computeTimeTickStep(tsArr) {
        if (!tsArr || tsArr.length === 0) return 'hour';
        var first = new Date(tsArr[0]).getTime();
        var last = new Date(tsArr[tsArr.length - 1]).getTime();
        var rangeMs = Math.max(1, last - first);
        var h = 3600000;
        if (rangeMs <= 1 * h) return '5min';
        if (rangeMs <= 3 * h) return '15min';
        if (rangeMs <= 24 * h) return '30min';
        if (rangeMs <= 72 * h) return 'hour';
        return 'day';
    }

    function isTimeAligned(d, step) {
        switch (step) {
            case 'minute': return d.getSeconds() === 0 && d.getMilliseconds() === 0;
            case '5min': return d.getMinutes() % 5 === 0 && d.getSeconds() === 0;
            case '15min': return d.getMinutes() % 15 === 0 && d.getSeconds() === 0;
            case '30min': return d.getMinutes() % 30 === 0 && d.getSeconds() === 0;
            case 'hour': return d.getMinutes() === 0 && d.getSeconds() === 0;
            case 'day': return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
        }
        return true;
    }

    function buildScales(portfolioMin, portfolioMax, showTime, finamMin, finamMax) {
        var portfolioRange = portfolioMax - portfolioMin;
        var portfolioPadding = portfolioRange > 0 ? portfolioRange * 0.1 : Math.max(portfolioMax * 0.1, 1000);

        var xTickColor = function(ctx) {
            if (showTime) return '#ffd900';
            var labels = ctx.chart.data.labels;
            var idx = ctx.tick.value;
            var label = (labels && labels[idx] != null) ? String(labels[idx]) : '';
            var changeStr = label.includes('||') ? label.split('||')[1] : label;
            if (changeStr) {
                var val = parseFloat(changeStr);
                if (!isNaN(val) && val < 0) return '#f44336';
                if (!isNaN(val)) return '#4caf50';
            }
            return '#ffd900';
        };

        var xTickCallback = function(val, idx, ticks) {
            if (showTime) {
                var step = (this.chart.scales && this.chart.scales.x) ? this.chart.scales.x._timeTickStep : 'hour';
                var tsArr = this.chart.data.timestamps || this.chart._midnightTimestamps;
                var ts = (tsArr && tsArr[val] != null) ? tsArr[val] : null;
                var d = ts instanceof Date ? ts : (ts != null ? new Date(ts) : null);
                if (d && !isNaN(d.getTime())) {
                    var hh = String(d.getHours()).padStart(2, '0');
                    var mm = String(d.getMinutes()).padStart(2, '0');
                    var dd = String(d.getDate()).padStart(2, '0');
                    var mo = String(d.getMonth() + 1).padStart(2, '0');
                    if (step === 'day') return dd + '.' + mo;
                    return hh + ':' + mm;
                }
                return '';
            }
            var labels = this.chart.data.labels;
            var label = (labels && labels[val] != null) ? String(labels[val]) : String(val);
            if (label.includes('||')) {
                var parts = label.split('||');
                return parts[1] || parts[0];
            }
            return label;
        };

        var scales = {
            x: {
                stacked: false,
                position: showTime ? 'top' : 'bottom',
                afterBuildTicks: function(axis) {
                    if (!showTime) return;
                    var tsArr = axis.chart.data.timestamps || axis.chart._midnightTimestamps;
                    if (!tsArr || !tsArr.length) return;
                    var step = computeTimeTickStep(tsArr);
                    axis._timeTickStep = step;
                    var ticks = [];
                    for (var i = 0; i < tsArr.length; i++) {
                        var d = tsArr[i] instanceof Date ? tsArr[i] : new Date(tsArr[i]);
                        if (!d || isNaN(d.getTime())) continue;
                        if (isTimeAligned(d, step)) ticks.push({ value: i });
                    }
                    if (ticks.length === 0) return;
                    if (ticks.length > 20) {
                        var picked = [];
                        var skip = Math.ceil(ticks.length / 20);
                        for (var t = 0; t < ticks.length; t += skip) picked.push(ticks[t]);
                        var last = ticks[ticks.length - 1];
                        if (picked[picked.length - 1].value !== last.value) picked.push(last);
                        ticks = picked.slice(0, 20);
                    }                    axis.ticks = ticks;
                },
            ticks: {
                display: true,
                maxRotation: 0,
                minRotation: 0,
                padding: showTime ? 0 : -30,
                    autoSkip: true,
                    maxTicksLimit: showTime ? 20 : 30,
                    font: { size: dpiFont(10) },
                    color: xTickColor,
                    callback: xTickCallback
                },
                grid: {
                    display: true,
                    color: 'rgba(46, 167, 151, 0.15)',
                    lineWidth: 1
                }
            },
            y_portfolio: {
                position: 'right',
                stacked: false,
                min: Math.max(0, portfolioMin - portfolioPadding),
                max: Math.max(portfolioMax + portfolioPadding, portfolioMin + 100),
                display: true,
                ticks: {
                    beginAtZero: false,
                    display: true,
                    callback: function(value) {
                        if (value >= 1e6) return '' + (value / 1e6).toFixed(2);
                        return '' + Number(value).toLocaleString('ru-RU');
                    },
                    font: { size: dpiFont(10) },
                    color: '#2cba99',
                    autoSkip: true,
                    padding: -1,
                    maxTicksLimit: 8
                },
                grid: {
                    display: true,
                    color: 'rgba(46, 167, 151, 0.28)',
                    lineWidth: 1
                },
                title: { display: false, text: 'Портфель', color: '#2cbaa3', font: { size: dpiFont(14) } }
            }
        };

        // Отдельная правая ось для капитала Finam (розовые метки), если есть данные
        if (finamMax > 0) {
            var finamRange = finamMax - finamMin;
            var finamPadding = finamRange > 0 ? finamRange * 0.1 : Math.max(finamMax * 0.1, 100);
            scales.y_finam = {
                position: 'right',
                stacked: false,
                min: Math.max(0, finamMin - finamPadding),
                max: Math.max(finamMax + finamPadding, finamMin + 100),
                display: true,
                ticks: {
                    beginAtZero: false,
                    display: true,
                    callback: function(value) {
                        return '' + (value / 1e6).toFixed(3).replace('.', ',');
                    },
                    font: { size: dpiFont(10) },
                    color: '#5b6ee8',
                    autoSkip: true,
                    padding: -1,
                    maxTicksLimit: 8
                },
                grid: { display: false },
                title: { display: false }
            };
        }

        // TGLD share axis: 100% доли = 30% высоты графика (max = 100/0.3)
        scales.y_tgld = {
            position: 'left',
            min: 0,
            max: 333.33,
            beginAtZero: true,
            display: false,
            stacked: true,
            ticks: {
                display: true,
                callback: function(value) { return value + '%'; },
                font: { size: dpiFont(9) },
                color: '#888',
                stepSize: 25
            },
            grid: { display: false },
            title: { display: false }
        };

        // Finam share axis — mirrored, independent from Tinkoff
        scales.y_tgld_finam = {
            position: 'right',
            min: 0,
            max: 333.33,
            beginAtZero: true,
            display: false,
            stacked: true,
            ticks: { display: false },
            grid: { display: false },
            title: { display: false }
        };

        // Reference line axis — separate to avoid interference with stacked data
        scales.y_ref = {
            position: 'right',
            min: 0,
            max: 333.33,
            beginAtZero: true,
            display: false,
            stacked: false,
            ticks: { display: false },
            grid: { display: false },
            title: { display: false }
        };

        // Generate scales from registry
        var addedAxes = {};
        Object.keys(TICKER_REGISTRY).forEach(function(key) {
            var cfg = TICKER_REGISTRY[key];
            if (!addedAxes[cfg.yAxisID]) {
                addedAxes[cfg.yAxisID] = true;
                scales[cfg.yAxisID] = {
                    position: cfg.axisPosition || 'left',
                    stacked: false,
                    ticks: {
                        display: true,
                        callback: cfg.tickFormat,
                        font: { size: dpiFont(13) },
                        color: cfg.tickColor,
                        autoSkip: true,
                        padding: -1,
                        maxTicksLimit: cfg.maxTicksLimit || 6
                    },
                    grid: { display: false },
                    title: {
                        display: false,
                        text: cfg.label.replace(/\/.*/, ''),
                        color: cfg.tickColor,
                        font: { size: dpiFont(14) },
                        padding: -10
                    }
                };
            }
        });

        return scales;
    }

    // ================================================================
    // DYNAMIC DATASET BUILDER — generates placeholder datasets from registry
    // ================================================================

    function buildPlaceholderDatasets() {
        var datasets = [];
        Object.keys(TICKER_REGISTRY).forEach(function(key) {
            var cfg = TICKER_REGISTRY[key];
            datasets.push({
                label: cfg.label,
                data: [],
                borderColor: cfg.color,
                borderWidth: cfg.borderWidth || 2,
                borderDash: cfg.borderDash || [],
                tension: chartTension(0.2),
                fill: false,
                pointRadius: cfg.pointRadius || 0,
                pointHoverRadius: 5,
                spanGaps: true,
                hidden: true,
                yAxisID: cfg.yAxisID
            });
        });
        return datasets;
    }

    // Ряд итогов портфеля по конкретному источнику (tinkoff/finam)
    function buildPortfolioSeriesBySource(rawData, timestamps, source) {
        var values = [];
        var tgldShares = [];
        var tmonShares = [];
        var lqdtShares = [];
        var lastValid = null;
        var lastTgld = null, lastTmon = null, lastLqdt = null;
        for (var i = 0; i < timestamps.length; i++) {
            var entry = rawData[timestamps[i]];
            var sum = 0;
            var found = false;
            var tg = null, tm = null, lq = null;
            if (Array.isArray(entry)) {
                for (var k = 0; k < entry.length; k++) {
                    var p = entry[k];
                    if (p && p.source === source) {
                        var val = Number(p.value);
                        if (!isNaN(val)) {
                            sum += val;
                            found = true;
                        }
                        if (p.tgld_share != null || p.tmon_share != null || p.lqdt_share != null) {
                            tg = Number(p.tgld_share) || 0;
                            tm = Number(p.tmon_share) || 0;
                            lq = Number(p.lqdt_share) || 0;
                        }
                    }
                }
            }
            if (found) {
                lastValid = sum;
                values.push(sum);
            } else {
                values.push(lastValid !== null ? lastValid : null);
            }
            tgldShares.push(tg !== null ? tg : lastTgld);
            tmonShares.push(tm !== null ? tm : lastTmon);
            lqdtShares.push(lq !== null ? lq : lastLqdt);
            if (tg !== null) lastTgld = tg;
            if (tm !== null) lastTmon = tm;
            if (lq !== null) lastLqdt = lq;
        }
        return { values: values, tgldShares: tgldShares, tmonShares: tmonShares, lqdtShares: lqdtShares };
    }

    function aggregateTgldShares(timestamps, shares, aggregatedTimestamps) {
        var result = [];
        var j = 0;
        var lastVal = null;
        for (var i = 0; i < aggregatedTimestamps.length; i++) {
            var target = new Date(aggregatedTimestamps[i]).getTime();
            while (j < timestamps.length && new Date(timestamps[j]).getTime() <= target) {
                if (shares[j] != null) lastVal = shares[j];
                j++;
            }
            result.push(lastVal !== null ? lastVal : 0);
        }
        return result;
    }

    function toPctSeries(series) {
        var base = null;
        for (var i = 0; i < series.length; i++) {
            if (series[i] != null && series[i] > 0) { base = series[i]; break; }
        }
        if (!base) return series.map(function() { return null; });
        return series.map(function(v) {
            if (v == null || v <= 0) return null;
            return (v / base - 1) * 100;
        });
    }

    function buildTgldDatasets(tinkoffAgg, finamAgg, includeFinam) {
        var TICKER_COLORS = {
            tgld: 'rgba(44, 186, 153, 0.8)',
            tmon: 'rgba(255, 120, 0, 0.8)',
            lqdt: 'rgba(220, 100, 140, 0.8)'
        };
        var FILL_ALPHA = 0;
        var HATCH_ALPHA = 0.35;
        var SPACING = 16;
        var LINE_W = 1;

        var _patCtx = null;
        function patCtx() {
            if (!_patCtx) _patCtx = document.createElement('canvas').getContext('2d');
            return _patCtx;
        }

        function rgba(base, alpha) {
            if (base.charAt(0) === '#') {
                var r = parseInt(base.slice(1, 3), 16);
                var g = parseInt(base.slice(3, 5), 16);
                var b = parseInt(base.slice(5, 7), 16);
                return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
            }
            return base.replace(/[\d.]+\)$/, alpha + ')');
        }

        var _patternCache = {};
        function hatchPattern(color, angleDeg) {
            var key = color + '|' + angleDeg;
            if (_patternCache[key]) return _patternCache[key];
            var dpr = (window.devicePixelRatio || 1) / 4;
            var rad = angleDeg * Math.PI / 180;
            var cos = Math.cos(rad);
            var sin = Math.sin(rad);
            var tileW = 23;
            var tileH = 23;
            var c = document.createElement('canvas');
            c.width = tileW * dpr;
            c.height = tileH * dpr;
            var ctx = c.getContext('2d');
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, tileW, tileH);
            ctx.strokeStyle = rgba(color, HATCH_ALPHA);
            ctx.lineWidth = 1;
            var normalX = -sin;
            var normalY = cos;
            var diag = tileW + tileH;
            for (var t = -diag; t < diag * 2; t += SPACING) {
                var px = normalX * t;
                var py = normalY * t;
                ctx.beginPath();
                ctx.moveTo(px - cos * diag, py - sin * diag);
                ctx.lineTo(px + cos * diag, py + sin * diag);
                ctx.stroke();
            }
            _patternCache[key] = patCtx().createPattern(c, 'repeat');
            return _patternCache[key];
        }

        function makeLayer(name, pctArr, color, stack, axisId, dashed, hatchDir) {
            var bg = hatchPattern(color, hatchDir);
            return {
                label: name,
                data: pctArr,
                borderColor: rgba(color, 0.5),
                backgroundColor: bg,
                borderWidth: 0.5,
                borderDash: [],
                tension: chartTension(0.2),
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: true,
                yAxisID: axisId || 'y_tgld',
                stack: stack
            };
        }

        var ds = [];
        var tgldArr = tinkoffAgg['tgld'];
        var tmonArr = tinkoffAgg['tmon'];
        var lqdtArr = tinkoffAgg['lqdt'];
        var len = tgldArr.length;
        var tgldPct = [], tmonPct = [], lqdtPct = [];
        for (var i = 0; i < len; i++) {
            tgldPct.push((tgldArr[i] || 0) * 100);
            tmonPct.push((tmonArr[i] || 0) * 100);
            lqdtPct.push((lqdtArr[i] || 0) * 100);
        }
        ds.push(makeLayer('\u0422:LQDT', lqdtPct, TICKER_COLORS.lqdt, 'tf', null, false, -45));
        ds.push(makeLayer('\u0422:TMON', tmonPct, TICKER_COLORS.tmon, 'tf', null, false, -45));
        ds.push({
            label: '\u0422:TGLD', data: tgldPct,
            borderColor: rgba(TICKER_COLORS.tgld, 0.5),
            backgroundColor: rgba(TICKER_COLORS.tgld, 0.05),
            borderWidth: 0.5, borderDash: [], tension: chartTension(0.2),
            fill: true, pointRadius: 0, pointHoverRadius: 0,
            spanGaps: true, yAxisID: 'y_tgld', stack: 'tf'
        });

        if (includeFinam) {
            var ftgldArr = finamAgg['tgld'];
            var ftmonArr = finamAgg['tmon'];
            var flqdtArr = finamAgg['lqdt'];
            var fLen = ftgldArr.length;
            var fTgldPct = [], fTmonPct = [], fLqdtPct = [];
            for (var i = 0; i < fLen; i++) {
                fTgldPct.push((ftgldArr[i] || 0) * 100);
                fTmonPct.push((ftmonArr[i] || 0) * 100);
                fLqdtPct.push((flqdtArr[i] || 0) * 100);
            }
            ds.push(makeLayer('\u0424:LQDT', fLqdtPct, TICKER_COLORS.lqdt, 'fn', 'y_tgld_finam', true, 45));
            ds.push(makeLayer('\u0424:TMON', fTmonPct, TICKER_COLORS.tmon, 'fn', 'y_tgld_finam', true, 45));
            ds.push({
                label: '\u0424:TGLD', data: fTgldPct,
                borderColor: rgba('#5b6ee8', 0.5),
                backgroundColor: rgba('#5b6ee8', 0.05),
                borderWidth: 0.5, borderDash: [], tension: chartTension(0.2),
                fill: true, pointRadius: 0, pointHoverRadius: 0,
                spanGaps: true, yAxisID: 'y_tgld_finam', stack: 'fn'
            });
        }

        return ds;
    }

    // ================================================================
    // TICKER DATA LOADER — replaces loadTgoldToChart
    // ================================================================

    window.loadTickersToChart = function(chart, portfolioTimestamps) {
        if (!chart || !chart.canvas || !chart.canvas.isConnected) return;

        var interval = window.currentInterval || 'hour';
        var tPeriod = getSetting('invest_panel_period', '-35 day');
        var tApiPeriod = tPeriod === '-1 day' ? '-1.5 day' : tPeriod;

        $.getJSON('/api/invest/tickers?interval=' + interval + '&period=' + encodeURIComponent(tApiPeriod))
            .done(function(tickersData) {
                if (!chart || !chart.canvas || !chart.canvas.isConnected) return;

                var legendState = getLegendState();

                Object.keys(TICKER_REGISTRY).forEach(function(key) {
                    var cfg = TICKER_REGISTRY[key];
                    var tickerData = tickersData && tickersData[key];
                    if (!tickerData || !tickerData.prices || tickerData.prices.length === 0) return;

                    try {
                        var prices = tickerData.prices.map(function(p) {
                            return { x: new Date(p.timestamp), y: p.price };
                        }).sort(function(a, b) { return a.x - b.x; });

                        var filledData = aggregateTickerPrices(prices, portfolioTimestamps, cfg.aggregation);

                        var existingIdx = -1;
                        for (var i = 0; i < chart.data.datasets.length; i++) {
                            if (chart.data.datasets[i].label === cfg.label) {
                                existingIdx = i;
                                break;
                            }
                        }

                        if (existingIdx >= 0) {
                            chart.data.datasets[existingIdx].data = filledData;
                            chart.data.datasets[existingIdx].hidden = (legendState[cfg.label] !== undefined) ? legendState[cfg.label] === true : cfg.hidden;
                        } else {
                            chart.data.datasets.push({
                                label: cfg.label,
                                data: filledData,
                                borderColor: cfg.color,
                                borderWidth: cfg.borderWidth || 2,
                                borderDash: cfg.borderDash || [],
                                tension: chartTension(0.2),
                                fill: false,
                                pointRadius: cfg.pointRadius || 0,
                                pointHoverRadius: 5,
                                spanGaps: true,
                                hidden: (legendState[cfg.label] !== undefined) ? legendState[cfg.label] === true : cfg.hidden,
                                yAxisID: cfg.yAxisID
                            });
                        }
                    } catch (e) {
                        console.error('[InvestPlot] ' + key + ' error:', e);
                    }
                });

                try {
                    chart.resize();
                    chart.update('none');
                } catch (e) {
                    console.error('[InvestPlot] Chart update error:', e);
                }
            })
            .fail(function(xhr, status, error) {
                console.error('[InvestPlot] Error loading tickers:', error, xhr.status);
            });
    };

    // ================================================================
    // CHART CREATION
    // ================================================================

    // Кастомная позиция тултипа: фиксированная высота top:20, x следует за точкой
    if (window.Chart && Chart.Tooltip && Chart.Tooltip.positioners) {
        Chart.Tooltip.positioners.topFixed = function(active) {
            if (!active || !active.length) return false;
            var x = active[0].element ? active[0].element.x : 0;
            var tt = this;
            return { x: x, y: 20, caretPadding: 4 };
        };
    }

    // Plugin for period labels (initial/final values relative to Y-axis)
    window.PeriodLabelsPlugin = function(initialSources) {

    return {

    id: "periodLabels",

    afterDatasetsDraw(chart) {

        const { ctx, scales, chartArea } = chart;
        var sources = chart._periodSources || initialSources;
        if (!sources || !sources.length) return;

        ctx.save();
        ctx.font = "bold 11px sans-serif";

        var labels = [];

        for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s.initialValue && !s.finalValue) continue;
            var yScale = scales[s.yAxisID];
            if (!yScale) continue;

            var initialVal = s.initialValue || 0;
            var finalVal = s.finalValue || 0;
            var delta = s.delta || 0;
            var color = s.color || '#2cba99';

            function fmt(v) {
                if (v >= 1e6) return (v / 1e6).toFixed(3).replace('.', ',') + 'М';
                if (v >= 1e3) return (v / 1e3).toFixed(3).replace('.', ',') + 'К';
                return String(Math.round(v));
            }

            var LABEL_RIGHT_X = chartArea.left + 78;
            var initialY = yScale.getPixelForValue(s.posInitial != null ? s.posInitial : initialVal);
            if (!isFinite(initialY)) initialY = chartArea.top + (chartArea.bottom - chartArea.top) / 2;
            var initDeltaStr = s.prevDelta != null ? (s.prevDelta >= 0 ? ' +' + s.prevDelta.toFixed(2) + '%' : ' ' + s.prevDelta.toFixed(2) + '%') : '';
            labels.push({ x: LABEL_RIGHT_X, y: initialY, text: fmt(initialVal) + initDeltaStr, align: 'right', color: color, source: i });

            var finalY = yScale.getPixelForValue(s.posFinal != null ? s.posFinal : finalVal);
            if (!isFinite(finalY)) finalY = chartArea.top + (chartArea.bottom - chartArea.top) / 2;
            var deltaStr = delta >= 0 ? ' +' + delta.toFixed(2) + '%' : ' ' + delta.toFixed(2) + '%';
            labels.push({ x: LABEL_RIGHT_X, y: finalY, text: fmt(finalVal) + deltaStr, align: 'right', color: color, delta: delta, source: i });
        }

        var MIN_GAP = 14;
        labels.sort(function(a, b) { return a.y - b.y; });
        for (var j = 1; j < labels.length; j++) {
            var diff = labels[j].y - labels[j - 1].y;
            if (Math.abs(diff) < MIN_GAP) {
                var shift = (MIN_GAP - Math.abs(diff)) / 2;
                labels[j - 1].y -= shift;
                labels[j].y += shift;
            }
        }

        for (var k = 0; k < labels.length; k++) {
            var lb = labels[k];
            ctx.font = "bold 11px sans-serif";
            ctx.textAlign = lb.align;
            var tw = ctx.measureText(lb.text).width;
            var pad = 4;
            var bx = lb.align === 'right' ? lb.x - tw - pad : lb.x - pad;
            var by = lb.y - 11;
            var bh = 15;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(bx, by, tw + pad * 2, bh);
            ctx.fillStyle = lb.color;
            ctx.fillText(lb.text, lb.x, lb.y);
        }

        ctx.restore();
    }

    };

    };

    function createChart(canvas, chartData, extrema, labelMode, periodSources) {
        var hasDatasets = Array.isArray(chartData.datasets);
        var validation = validateGraphData(hasDatasets ?
            { labels: chartData.labels, values: chartData.datasets[0] && chartData.datasets[0].data } :
            chartData
        );
        if (!validation.valid) {
            console.error('[InvestPlot] Chart data error:', validation.reason);
            return null;
        }

        try {
            if (!canvas || !canvas.isConnected || !document.body.contains(canvas)) {
                console.error('[InvestPlot] Canvas not found in DOM');
                return null;
            }

            var existingChart = Chart.getChart(canvas);
            if (existingChart) existingChart.destroy();
            canvas.width = 0;
            canvas.height = 0;

            var container = canvas.parentElement;
            setupCanvasForDPR(canvas, container);
            var ctx = canvas.getContext('2d');

            var plugins = [];

            if (window.ExtremaPlugin && getSetting('invest_panel_extrema', '0') !== '0') {
                try {
                    var extremaPlugin = window.initChartPlugin(
                        window.ExtremaPlugin(null), { enabled: true }
                    );
                    if (extremaPlugin) plugins.push(extremaPlugin);
                } catch (e) {
                    console.error('[InvestPlot] Extrema plugin init error:', e);
                }
            }

            if (window.MidnightLinesPlugin) {
                try {
                    var midnightPlugin = window.initChartPlugin(
                        window.MidnightLinesPlugin(null), { enabled: true }
                    );
                    if (midnightPlugin) plugins.push(midnightPlugin);
                } catch (e) {
                    console.error('[InvestPlot] MidnightLines plugin init error:', e);
                }
            }

            // Inline legend inside chart area
            if (window.inlineLegendPlugin) {
                plugins.push(window.inlineLegendPlugin);
            }

            // Plugin for daily growth below X axis
            if (window.dailyGrowthLabelsPlugin) {
                plugins.push(window.dailyGrowthLabelsPlugin);
            }

            // Period labels plugin
            if (window.PeriodLabelsPlugin) {
                try {
                    var periodLabelsPlugin = window.PeriodLabelsPlugin(periodSources);
                    if (periodLabelsPlugin) plugins.push(periodLabelsPlugin);
                } catch (e) {
                    console.error('[InvestPlot] PeriodLabelsPlugin error:', e);
                }
            }

            // Свой zoom: подсветка выделения + кнопка Reset Zoom
            if (window.investZoomUiPlugin) {
                plugins.push(window.investZoomUiPlugin);
            }

            var config = {
                type: 'line',
                plugins: plugins,
                data: {
                    labels: chartData.labels,
                    datasets: chartData.datasets,
                    timestamps: chartData.timestamps
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: false,
                    devicePixelRatio: Math.min(chartDpiValue('invest'), 6.0) * (window.devicePixelRatio || 1),
                    clip: false,
                    layout: {
                        padding: { top: 4, right: 6, bottom: 23, left: 10 }
                    },
                    plugins: {
                        legend: { display: false },
                        crosshair: {
                            line: { color: '#888888', width: 1, dashPattern: [4, 4] },
                            sync: { enabled: false },
                            zoom: {
                                enabled: false
                            }
                        },
                        tooltip: {
                            enabled: true,
                            position: 'topFixed',
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: function(items) {
                                    if (!items || !items.length) return '';
                                    var tsArr = items[0].chart._midnightTimestamps || items[0].chart.data.timestamps;
                                    var ts = (tsArr && tsArr[items[0].dataIndex] != null) ? tsArr[items[0].dataIndex] : null;
                                    var d = ts instanceof Date ? ts : (ts != null ? new Date(ts) : null);
                                    if (d && !isNaN(d.getTime())) {
                                        return String(d.getMonth() + 1).padStart(2, '0') + '-' +
                                               String(d.getDate()).padStart(2, '0') + ' ' +
                                               String(d.getHours()).padStart(2, '0') + ':' +
                                               String(d.getMinutes()).padStart(2, '0');
                                    }
                                    return (items[0].label || '').replace(/\|\|/g, ' ');
                                },
                                label: function(ctx) {
                                    var value = Number(ctx.parsed && ctx.parsed.y);
                                    var name = String(ctx.dataset.label || '').replace(/^Портфель\s+/, '');
                                    return name + ': ' + value.toLocaleString('ru-RU');
                                }
                            },
                            displayColors: true,
                            backgroundColor: 'rgba(0, 0, 0, 0.85)',
                            titleColor: '#fff',
                            bodyColor: '#fff',
                            padding: 10,
                            titleFont: { size: 13 },
                            bodyFont: { size: 13 },
                            cornerRadius: 6
                        }
                    },
                    interaction: { mode: 'index', intersect: false },
                    scales: chartData.scales,
                    elements: {
                        line: { borderCapStyle: 'round', borderJoinStyle: 'round' },
                        point: { hitRadius: 10 }
                    }
                }
            };

            var chart = new Chart(ctx, config);
            chart.canvas.addEventListener('click', function(event) {
                if (hitRect(chart._resetZoomRect, event, canvas)) {
                    resetInvestZoom(chart);
                    return;
                }
                if (chart._selectionDragged) {
                    chart._selectionDragged = false;
                    return;
                }
                if (chart._legendDragMoved) {
                    chart._legendDragMoved = false;
                    return;
                }
                toggleLegendDataset(chart, event);
            });
            chart._legendPos = getLegendPos();
            attachLegendDrag(chart);
            attachInvestZoom(chart);
            chart._extrema = extrema;
            chart._dailyGrowthMarks = dailyGrowthMarks;
            chart._midnightTimestamps = chartData.timestamps;
            chart._currentInterval = currentInterval;
            chart._labelMode = labelMode;
            chart._periodSources = periodSources;
            console.log('[InvestPlot] Chart created (' + chartData.labels.length + ' points)');
            return chart;
        } catch (error) {
            console.error('[InvestPlot] Chart creation error:', error);
            return null;
        }
    }

    // ================================================================
    // MAIN UPDATE FLOW
    // ================================================================

    function updateInvestPlot() {
        var savedView = getSetting('chartView');
        if (savedView === 'energy') {
            console.log('[InvestPlot] Battery chart active, skip update');
            return;
        }

        if (isUpdating) {
            console.warn('[InvestPlot] Update already in progress, skipping');
            return;
        }
        isUpdating = true;

        var updateTimeoutId = setTimeout(function() {
            isUpdating = false;
            console.warn('[InvestPlot] Timeout 30s, isUpdating reset');
        }, 30000);

        var canvasCheck = checkCanvas();
        if (!canvasCheck.exists) {
            initAttempts++;
            if (initAttempts > MAX_INIT_ATTEMPTS) {
                console.error('[InvestPlot] Canvas #investChart not found after', MAX_INIT_ATTEMPTS, 'attempts');
                isUpdating = false;
                return;
            }
            setTimeout(updateInvestPlot, INIT_ATTEMPT_DELAY);
            isUpdating = false;
            return;
        }

        if (canvasCheck.reason !== 'OK') {
            // Панель скрыта (display:none) — тихий выход, не накапливаем попытки
            var invPanel = document.getElementById('invest_panel');
            if (invPanel && invPanel.style.display === 'none') {
                initAttempts = 0;
                isUpdating = false;
                return;
            }
            initAttempts++;
            if (initAttempts > MAX_INIT_ATTEMPTS) {
                console.error('[InvestPlot] Canvas problem:', canvasCheck.reason);
                isUpdating = false;
                return;
            }
            setTimeout(updateInvestPlot, CANVAS_CHECK_DELAY);
            isUpdating = false;
            return;
        }

        initAttempts = 0;
        var canvas = document.getElementById('investChart');
        var container = canvas.parentElement;

        var currentInterval = window.currentInterval || 'hour';
        var period = getSetting('invest_panel_period', '-35 day');

        // For '1 day' period, request 1.5 days of data from API
        var apiPeriod = period === '-1 day' ? '-1.5 day' : period;

        // Fetch history + tickers in parallel
        var historyUrl = '/api/invest/history?interval=' + currentInterval + '&period=' + encodeURIComponent(apiPeriod);
        var tickersUrl = '/api/invest/tickers?interval=' + currentInterval + '&period=' + encodeURIComponent(apiPeriod);

        $.when(
            $.getJSON(historyUrl),
            $.getJSON(tickersUrl)
        ).done(function(historyResult, tickersResult) {
            var rawData = historyResult[0];
            var tickersData = tickersResult[0];

            if (!rawData || Object.keys(rawData).length === 0) {
                console.warn('[InvestPlot] No data for investment chart');
                isUpdating = false;
                clearTimeout(updateTimeoutId);
                return;
            }

            var timestamps = Object.keys(rawData).filter(function(k) { return k !== '_prev'; }).sort();

            // Portfolio values
            var portfolioValues = [];
            var lastValidTotal = 0;
            for (var i = 0; i < timestamps.length; i++) {
                var entry = rawData[timestamps[i]];
                var total = 0;
                if (Array.isArray(entry)) {
                    total = entry.reduce(function(sum, p) {
                        var val = Number(p.value);
                        return sum + (isNaN(val) ? 0 : val);
                    }, 0);
                    lastValidTotal = total;
                } else {
                    total = lastValidTotal;
                }
                portfolioValues.push(total);
            }

            showDataFreshness(timestamps);
            updateSourceBadge(rawData);

            // Aggregation
            var showTime = getSetting('invest_panel_time', '1') !== '0';
            var showChange = getSetting('invest_panel_change', '1') !== '0';
            var labelMode = showTime && showChange ? 'both' : showChange ? 'time' : 'change';
            var aggResult = aggregateData(timestamps, portfolioValues, currentInterval, labelMode);
            var labels = aggResult.labels;
            var aggregatedPortfolio = aggResult.values;
            var aggregatedTimestamps = aggResult.timestamps;

            // Filter X-axis labels: show only 00:00 midnight growth values
            if (currentInterval === 'hour' || currentInterval === 'minute' || currentInterval === 'fivemin' || currentInterval === 'twentymin' || currentInterval === 'sixhour') {
                var origLabels = labels.slice();
                var midnightIndices = [];
                for (var i = 0; i < origLabels.length; i++) {
                    var ts = aggregatedTimestamps[i];
                    if (ts instanceof Date && ts.getHours() === 0 && ts.getMinutes() === 0) {
                        midnightIndices.push(i);
                    }
                }
                for (var i = 0; i < labels.length; i++) {
                    labels[i] = '';
                }
                for (var j = 1; j < midnightIndices.length - 1; j++) {
                    var mi = midnightIndices[j];
                    var rawLabel = origLabels[mi];
                    labels[mi] = (rawLabel && rawLabel.includes('||')) ? rawLabel.split('||')[1] || '' : rawLabel || '';
                }
            }

            // Growth marks (only when "изменения размера портфеля" is enabled)
            if (showChange && (currentInterval === 'minute' || currentInterval === 'fivemin' || currentInterval === 'twentymin' || currentInterval === 'hour' || currentInterval === 'sixhour' || currentInterval === 'day')) {
                dailyGrowthMarks = calculateDailyGrowthMarks(aggregatedTimestamps, aggregatedPortfolio);
                dailyBars = dailyGrowthMarks.map(function(m) {
                    return { value: m.pctGrowth, isPositive: m.pctGrowth >= 0 };
                });
            } else {
                dailyGrowthMarks = [];
                dailyBars = [];
            }

            // Extrema
            var extrema = [];
            if (getSetting('invest_panel_extrema', '0') !== '0' && window.findDailyExtrema) {
                extrema = window.findDailyExtrema(aggregatedPortfolio, aggregatedTimestamps);
            }

            // Build datasets: отдельные линии портфелей Tinkoff и Finam
            // Сырые ряды по источникам, затем та же агрегация, что и у суммарного ряда
            var tinkoffRawObj = buildPortfolioSeriesBySource(rawData, timestamps, 'tinkoff');
            var finamRawObj = buildPortfolioSeriesBySource(rawData, timestamps, 'finam');
            var tinkoffRaw = tinkoffRawObj.values;
            var finamRaw = finamRawObj.values;
            var tinkoffTgldShares = tinkoffRawObj.tgldShares;
            var tinkoffTmonShares = tinkoffRawObj.tmonShares;
            var tinkoffLqdtShares = tinkoffRawObj.lqdtShares;
            var finamTgldShares = finamRawObj.tgldShares;
            var finamTmonShares = finamRawObj.tmonShares;
            var finamLqdtShares = finamRawObj.lqdtShares;
            var tinkoffAgg = aggregateData(timestamps, tinkoffRaw, currentInterval, 'time');
            var finamAgg = aggregateData(timestamps, finamRaw, currentInterval, 'time');
            var tinkoffSeries = tinkoffAgg.values;
            var finamSeries = finamAgg.values;

            // Aggregate TGLD/TMON/LQDT shares to match aggregated timestamps
            var tinkoffTgldAgg = aggregateTgldShares(timestamps, tinkoffTgldShares, aggregatedTimestamps);
            var tinkoffTmonAgg = aggregateTgldShares(timestamps, tinkoffTmonShares, aggregatedTimestamps);
            var tinkoffLqdtAgg = aggregateTgldShares(timestamps, tinkoffLqdtShares, aggregatedTimestamps);
            var finamTgldAgg = aggregateTgldShares(timestamps, finamTgldShares, aggregatedTimestamps);
            var finamTmonAgg = aggregateTgldShares(timestamps, finamTmonShares, aggregatedTimestamps);
            var finamLqdtAgg = aggregateTgldShares(timestamps, finamLqdtShares, aggregatedTimestamps);

            // Calculate initial/final values for period labels — per source
            var tinkoffInit = 0, tinkoffFinal = 0, tinkoffDelta = 0;
            var finamInit = 0, finamFinal = 0, finamDelta = 0;
            for (var p = 0; p < tinkoffSeries.length; p++) {
                if (tinkoffSeries[p] != null && tinkoffSeries[p] > 0) { tinkoffInit = tinkoffSeries[p]; break; }
            }
            for (var p = tinkoffSeries.length - 1; p >= 0; p--) {
                if (tinkoffSeries[p] != null && tinkoffSeries[p] > 0) { tinkoffFinal = tinkoffSeries[p]; break; }
            }
            for (var p = 0; p < finamSeries.length; p++) {
                if (finamSeries[p] != null && finamSeries[p] > 0) { finamInit = finamSeries[p]; break; }
            }
            for (var p = finamSeries.length - 1; p >= 0; p--) {
                if (finamSeries[p] != null && finamSeries[p] > 0) { finamFinal = finamSeries[p]; break; }
            }
            tinkoffDelta = tinkoffInit > 0 ? ((tinkoffFinal - tinkoffInit) / tinkoffInit) * 100 : 0;
            finamDelta = finamInit > 0 ? ((finamFinal - finamInit) / finamInit) * 100 : 0;

            // Previous period delta: from server _prev block (prev_cutoff..cutoff per source)
            var _prev = rawData['_prev'] || null;
            var tinkoffPrevDelta = null, finamPrevDelta = null;
            if (_prev && _prev.tinkoff && tinkoffInit > 0) {
                var prevEnd = _prev.tinkoff.end;
                if (prevEnd > 0) tinkoffPrevDelta = ((tinkoffInit - prevEnd) / prevEnd) * 100;
            }
            if (_prev && _prev.finam && finamInit > 0) {
                var prevEndF = _prev.finam.end;
                if (prevEndF > 0) finamPrevDelta = ((finamInit - prevEndF) / prevEndF) * 100;
            }

            // Нормированные копии рядов (% от старта периода) — видимость через легенду
            var tinkoffPct = toPctSeries(tinkoffSeries);
            var finamPct = toPctSeries(finamSeries);

            // Min/max для осей: каждый график нормирован по своему диапазону
            var validTinkoff = tinkoffSeries.filter(function(v) { return v != null && v > 0; });
            var portfolioMin = validTinkoff.length > 0 ? Math.min.apply(null, validTinkoff) : 0;
            var portfolioMax = validTinkoff.length > 0 ? Math.max.apply(null, validTinkoff) : 0;
            var validFinam = finamSeries.filter(function(v) { return v != null && v > 0; });
            var finamMin = validFinam.length > 0 ? Math.min.apply(null, validFinam) : 0;
            var finamMax = validFinam.length > 0 ? Math.max.apply(null, validFinam) : 0;

            // Build scales from registry
            var scales = buildScales(portfolioMin, portfolioMax, showTime, finamMin, finamMax);

            // Change y_portfolio to left position for labels to appear on left Y-axis
            if (scales.y_portfolio) {
                scales.y_portfolio.position = 'left';
            }

            // Скрытая авто-ось для нормированных рядов (%)
            scales.y_pct = { position: 'right', display: false };

            var finamAxis = finamMax > 0 ? 'y_finam' : 'y_portfolio';

            var periodSources = [
                {
                    label: 'Tinkoff',
                    initialValue: tinkoffInit,
                    finalValue: tinkoffFinal,
                    delta: tinkoffDelta,
                    prevDelta: tinkoffPrevDelta,
                    yAxisID: 'y_portfolio',
                    color: '#2cba99'
                }
            ];
            if (finamMax > 0) {
                periodSources.push({
                    label: 'Finam',
                    initialValue: finamInit,
                    finalValue: finamFinal,
                    delta: finamDelta,
                    prevDelta: finamPrevDelta,
                    yAxisID: finamAxis,
                    color: '#5b6ee8'
                });
            }

            var datasets = [
                {
                    label: 'Tinkoff, \u20BD',
                    data: tinkoffSeries,
                    borderColor: '#2cba99',
                    backgroundColor: 'rgba(25, 150, 89, 0.15)',
                    borderWidth: 2,
                    tension: chartTension(0.2),
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    yAxisID: 'y_portfolio',
                    hidden: true
                },
                {
                    label: 'Finam, \u20BD',
                    data: finamSeries,
                    borderColor: '#5b6ee8',
                    backgroundColor: 'rgba(91, 110, 232, 0.12)',
                    borderWidth: 2,
                    tension: chartTension(0.2),
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    yAxisID: finamAxis,
                    hidden: true
                },
                {
                    label: 'Tinkoff, %',
                    data: tinkoffPct,
                    borderColor: '#2cba99',
                    borderDash: [6, 4],
                    borderWidth: 1.5,
                    tension: chartTension(0.2),
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    hidden: true,
                    yAxisID: 'y_pct'
                },
                {
                    label: 'Finam, %',
                    data: finamPct,
                    borderColor: '#5b6ee8',
                    borderDash: [6, 4],
                    borderWidth: 1.5,
                    tension: chartTension(0.2),
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    hidden: true,
                    yAxisID: 'y_pct'
                },
                {
                    label: 'T+F, \u20BD',
                    data: (function() {
                        var len = Math.max(tinkoffSeries.length, finamSeries.length);
                        var r = [];
                        for (var i = 0; i < len; i++) r.push((tinkoffSeries[i] || 0) + (finamSeries[i] || 0));
                        return r;
                    })(),
                    borderColor: '#aaa',
                    borderWidth: 2,
                    tension: chartTension(0.2),
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    yAxisID: 'y_portfolio',
                    hidden: true
                },
                {
                    label: 'T+F, %',
                    data: (function() {
                        var len = Math.max(tinkoffSeries.length, finamSeries.length);
                        var sum = [];
                        for (var i = 0; i < len; i++) sum.push((tinkoffSeries[i] || 0) + (finamSeries[i] || 0));
                        return toPctSeries(sum);
                    })(),
                    borderColor: '#aaa',
                    borderDash: [6, 4],
                    borderWidth: 1.5,
                    tension: chartTension(0.2),
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    hidden: true,
                    yAxisID: 'y_pct'
                }
            ];

            // Stacked share overlay datasets (TGLD/TMON/LQDT × 2 sources)
            datasets.push.apply(datasets, buildTgldDatasets(
                { tgld: tinkoffTgldAgg, tmon: tinkoffTmonAgg, lqdt: tinkoffLqdtAgg },
                { tgld: finamTgldAgg, tmon: finamTmonAgg, lqdt: finamLqdtAgg },
                finamMax > 0
            ));

            // Add ticker placeholder datasets from registry
            var placeholders = buildPlaceholderDatasets();
            datasets = datasets.concat(placeholders);

            // 100% reference line — always last in legend
            datasets.push({
                label: '100%',
                data: labels.map(function() { return 100; }),
                borderColor: 'rgba(220, 60, 60, 0.7)',
                borderDash: [4, 3],
                borderWidth: 0.5,
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: true,
                hidden: false,
                yAxisID: 'y_ref'
            });

            // Chart update or create
            if (investChart && investChart._currentInterval === currentInterval) {
                investChart._dailyBars = dailyBars;
                investChart._dailyGrowthMarks = dailyGrowthMarks;
                investChart._extrema = extrema;
                investChart._midnightTimestamps = aggregatedTimestamps;
                investChart._labelMode = labelMode;
                investChart.data.labels = labels;

                // Update period label sources
                var newSources = [
                    { label: 'Tinkoff', initialValue: tinkoffInit, finalValue: tinkoffFinal, delta: tinkoffDelta, prevDelta: tinkoffPrevDelta, yAxisID: 'y_portfolio', color: '#2cba99' }
                ];
                if (finamMax > 0) {
                    newSources.push({ label: 'Finam', initialValue: finamInit, finalValue: finamFinal, delta: finamDelta, prevDelta: finamPrevDelta, yAxisID: finamAxis, color: '#5b6ee8' });
                }
                investChart._periodSources = newSources;

                // Update portfolio in place, remove old ticker + tgld datasets
                if (investChart.data.datasets[0]) investChart.data.datasets[0].data = tinkoffSeries;
                if (investChart.data.datasets[1]) investChart.data.datasets[1].data = finamSeries;
                if (investChart.data.datasets[2]) investChart.data.datasets[2].data = tinkoffPct;
                if (investChart.data.datasets[3]) investChart.data.datasets[3].data = finamPct;

                // Update T+F datasets (indices 4,5)
                var tplusfRb = (function() {
                    var len = Math.max(tinkoffSeries.length, finamSeries.length);
                    var r = [];
                    for (var i = 0; i < len; i++) r.push((tinkoffSeries[i] || 0) + (finamSeries[i] || 0));
                    return r;
                })();
                var tplusfPct = toPctSeries(tplusfRb);
                if (investChart.data.datasets[4]) investChart.data.datasets[4].data = tplusfRb;
                if (investChart.data.datasets[5]) investChart.data.datasets[5].data = tplusfPct;

                // Remove all datasets after the main 6 (T+F + ticker placeholders + tgld + 100%)
                while (investChart.data.datasets.length > 6) {
                    investChart.data.datasets.pop();
                }

                // Re-add stacked share overlay datasets
                var shareDatasets = buildTgldDatasets(
                    { tgld: tinkoffTgldAgg, tmon: tinkoffTmonAgg, lqdt: tinkoffLqdtAgg },
                    { tgld: finamTgldAgg, tmon: finamTmonAgg, lqdt: finamLqdtAgg },
                    finamMax > 0
                );
                for (var s = 0; s < shareDatasets.length; s++) {
                    investChart.data.datasets.push(shareDatasets[s]);
                }

                // Add fresh ticker placeholder datasets
                for (var p = 0; p < placeholders.length; p++) {
                    investChart.data.datasets.push(placeholders[p]);
                }

                // 100% reference line — always last
                investChart.data.datasets.push({
                    label: '100%',
                    data: labels.map(function() { return 100; }),
                    borderColor: 'rgba(220, 60, 60, 0.7)',
                    borderDash: [4, 3],
                    borderWidth: 0.5,
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    spanGaps: true,
                    hidden: false,
                    yAxisID: 'y_ref'
                });

                // Load ticker data into chart
                window.loadTickersToChart(investChart, aggregatedTimestamps);
            } else {
                investChart = createChart(canvas, {
                    labels: labels,
                    datasets: datasets,
                    timestamps: aggregatedTimestamps,
                    scales: scales
                }, extrema, labelMode, periodSources);

                if (!investChart) {
                    console.error('[InvestPlot] Failed to create chart');
                } else {
                    applyLegendState(investChart);
                    window.loadTickersToChart(investChart, aggregatedTimestamps);
                }
            }

            isUpdating = false;
            clearTimeout(updateTimeoutId);
        }).fail(function(xhr, status, error) {
            console.error('[InvestPlot] Error loading data:', status, error, 'HTTP:', xhr.status);
            isUpdating = false;
            clearTimeout(updateTimeoutId);
        });
    }

    // ================================================================
    // RESIZE
    // ================================================================

    function resizeCharts() {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function() {
            var canvas = document.getElementById('investChart');
            var container = canvas && canvas.parentElement;
            if (!canvas || !container || !investChart) return;
            setupCanvasForDPR(canvas, container);
            investChart.resize();
            investChart.update('none');
            resizeTimeout = null;
        }, RESIZE_DEBOUNCE_MS);
    }

    var resizeChartsThrottled = throttle(resizeCharts, RESIZE_THROTTLE_MS);

    // ================================================================
    // DAILY GROWTH LABELS PLUGIN
    // ================================================================

    window.inlineLegendPlugin = {
        id: 'inlineLegend',
        afterTooltipDraw: function(chart) {
            var ctx = chart.ctx;
            var chartArea = chart.chartArea;
            var datasets = chart.data.datasets;
            if (!datasets || !datasets.length) return;

            ctx.save();

            var rootFont = parseFloat(window.getComputedStyle(document.body).fontSize) || 16;
            var fs = 12;

            var padX = 16;
            var padTop = 14;
            var swatchW = 12;
            var swatchH = 2;
            var labelGap = 10;
            var cellGapX = 32;
            var cellGapY = 12;
            var collapseBtnSize = 20;

            var colGroups = [[], [], []];
            for (var i = 0; i < datasets.length; i++) {
                var ds = datasets[i];
                if (!ds.label) continue;
                var lb = ds.label;
                if (lb.indexOf('\u0424:') === 0 || lb.indexOf('Finam') === 0) colGroups[0].push({ index: i, label: lb });
                else if (lb.indexOf('\u0422:') === 0 || lb.indexOf('Tinkoff') === 0) colGroups[1].push({ index: i, label: lb });
                else colGroups[2].push({ index: i, label: lb });
            }
            var items = [];
            var itemCol = [];
            for (var g = 0; g < 3; g++) {
                for (var k = 0; k < colGroups[g].length; k++) {
                    items.push(colGroups[g][k]);
                    itemCol.push(g);
                }
            }
            if (!items.length) { ctx.restore(); return; }

            var pos = chart._legendPos || { x: chartArea.left, y: chartArea.bottom - 14 };
            var collapsed = isLegendCollapsed();

            if (collapsed) {
                var btnX = pos.x;
                var btnY = pos.y;
                ctx.fillStyle = 'rgba(18, 20, 24, 0.78)';
                ctx.fillRect(btnX, btnY, collapseBtnSize, collapseBtnSize);
                ctx.fillStyle = '#999';
                ctx.font = Math.round(fs * 0.7) + 'px sans-serif';
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'center';
                ctx.fillText('\u25B6', btnX + collapseBtnSize / 2, btnY + collapseBtnSize / 2);
                ctx.restore();
                chart._legendCollapseBtn = { x: btnX, y: btnY, w: collapseBtnSize, h: collapseBtnSize };
                chart._legendHitAreas = [];
                chart._legendRect = null;
                return;
            }

            chart._legendCollapseBtn = null;

            var cols = 3;
            var rows, colW, totalW, totalH;

            function layout(fontPx) {
                ctx.font = 'bold ' + fontPx + 'px sans-serif';
                rows = Math.max(colGroups[0].length, colGroups[1].length, colGroups[2].length);
                colW = [];
                for (var c = 0; c < cols; c++) {
                    var maxW = 0;
                    for (var r = 0; r < colGroups[c].length; r++) {
                        maxW = Math.max(maxW, ctx.measureText(colGroups[c][r].label).width);
                    }
                    colW.push(swatchW + labelGap + maxW);
                }
                totalW = 0;
                for (var c = 0; c < cols; c++) totalW += colW[c];
                totalW += (cols - 1) * cellGapX + padX * 2 + collapseBtnSize + 6;
                var itemH = Math.round(fontPx * 1.6);
                totalH = rows * itemH + (rows - 1) * cellGapY + padTop + 8;
                return itemH;
            }

            var itemH = layout(fs);
            var availW = chartArea.right - chartArea.left;
            while (totalW > availW && fs > 14) {
                fs = Math.round(fs * 0.9);
                itemH = layout(fs);
            }

            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';

            pos.x = Math.min(Math.max(pos.x, 0), Math.max(chart.width - totalW, 0));
            pos.y = Math.min(Math.max(pos.y, 0), Math.max(chart.height - totalH, 0));
            var bx = pos.x;
            var by = pos.y;

            ctx.fillStyle = 'rgba(18, 20, 24, 0.78)';
            ctx.fillRect(bx, by, totalW, totalH);

            ctx.fillStyle = '#999';
            ctx.font = Math.round(fs * 0.7) + 'px sans-serif';
            ctx.fillText('\u25C0', bx + totalW - collapseBtnSize + 2, by + totalH / 2);
            chart._legendCollapseBtn = { x: bx + totalW - collapseBtnSize, y: by, w: collapseBtnSize, h: totalH };

            ctx.font = 'bold ' + fs + 'px sans-serif';

            var areas = [];
            for (var n = 0; n < items.length; n++) {
                var it = items[n];
                var cIdx = itemCol[n];
                var rIdx = n - 0;
                for (var g2 = 0; g2 < cIdx; g2++) rIdx -= colGroups[g2].length;
                var x = bx + padX;
                for (var g2 = 0; g2 < cIdx; g2++) x += colW[g2] + cellGapX;
                var y = by + padTop + itemH / 2 + rIdx * (itemH + cellGapY);
                var dset = datasets[it.index];
                var color = dset.borderColor || dset.backgroundColor || '#ccc';
                var hidden = dset.hidden === true;

                ctx.globalAlpha = hidden ? 0.4 : 1;
                ctx.fillStyle = color;
                ctx.fillRect(x, y - swatchH, swatchW, swatchH);
                ctx.fillStyle = hidden ? '#666' : '#ccc';
                ctx.fillText(dset.label, x + swatchW + labelGap, y);

                areas.push({
                    x: x - cellGapX / 2,
                    y: y - itemH / 2,
                    width: colW[cIdx] + cellGapX,
                    height: itemH + cellGapY / 2,
                    datasetIndex: it.index
                });
            }

            ctx.restore();
            chart._legendRect = { x: bx, y: by, w: totalW, h: totalH };
            chart._legendHitAreas = areas;
        }
    };

    // === Legend state persistence (cookies) ===
    var LEGEND_STATE_COOKIE = 'wclock_invest_legend';
    var LEGEND_COLLAPSE_COOKIE = 'wclock_invest_legend_collapsed';

    function getLegendState() {
        try {
            var m = document.cookie.match(new RegExp('(?:^|; )' + LEGEND_STATE_COOKIE + '=([^;]*)'));
            return m ? JSON.parse(decodeURIComponent(m[1])) : {};
        } catch (e) {
            return {};
        }
    }

    function isLegendCollapsed() {
        try {
            var m = document.cookie.match(new RegExp('(?:^|; )' + LEGEND_COLLAPSE_COOKIE + '=([^;]*)'));
            return m ? m[1] === '1' : false;
        } catch (e) { return false; }
    }

    function setLegendCollapsed(v) {
        document.cookie = LEGEND_COLLAPSE_COOKIE + '=' + (v ? '1' : '0') +
            '; path=/; max-age=31536000; SameSite=Lax';
    }

    function applyLegendState(chart) {
        if (!chart || !chart.data || !chart.data.datasets) return;
        var state = getLegendState();
        if (Object.keys(state).length === 0) return;
        for (var i = 0; i < chart.data.datasets.length; i++) {
            var ds = chart.data.datasets[i];
            if (!ds || !ds.label) continue;
            if (state[ds.label] !== undefined) {
                ds.hidden = state[ds.label] === true;
            }
        }
    }

    function saveLegendState() {
        try {
            var chart = investChart;
            if (!chart || !chart.data || !chart.data.datasets) return;
            var state = {};
            for (var i = 0; i < chart.data.datasets.length; i++) {
                var ds = chart.data.datasets[i];
                if (ds && ds.label) state[ds.label] = ds.hidden === true;
            }
            document.cookie = LEGEND_STATE_COOKIE + '=' + encodeURIComponent(JSON.stringify(state)) + '; path=/; max-age=31536000';
        } catch (e) {}
    }

    function toggleLegendDataset(chart, event) {
        var rect = chart.canvas.getBoundingClientRect();
        var x = event.clientX - rect.left;
        var y = event.clientY - rect.top;

        // Collapse button hit test
        var btn = chart._legendCollapseBtn;
        if (btn && x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
            setLegendCollapsed(!isLegendCollapsed());
            chart.update();
            return;
        }

        var areas = chart._legendHitAreas;
        if (!areas || !areas.length) return;
        for (var i = 0; i < areas.length; i++) {
            var a = areas[i];
            if (x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) {
                var ds = chart.data.datasets[a.datasetIndex];
                if (!ds) return;
                ds.hidden = !ds.hidden;
                chart.update();
                saveLegendState();
                return;
            }
        }
    }

    // === Legend position persistence (cookie) + drag ===
    var LEGEND_POS_COOKIE = 'wclock_invest_legend_pos';
    var _legendDragBound = false;

    function getLegendPos() {
        try {
            var m = document.cookie.match(new RegExp('(?:^|; )' + LEGEND_POS_COOKIE + '=([^;]*)'));
            return m ? JSON.parse(decodeURIComponent(m[1])) : null;
        } catch (e) {
            return null;
        }
    }

    function saveLegendPos(pos) {
        document.cookie = LEGEND_POS_COOKIE + '=' +
            encodeURIComponent(JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) })) +
            '; path=/; max-age=31536000; SameSite=Lax';
    }

    function attachLegendDrag(chart) {
        if (_legendDragBound || !chart || !chart.canvas) return;
        _legendDragBound = true;
        var canvas = chart.canvas;
        var dragging = false, moved = false, lastX = 0, lastY = 0;

        function hitLegend(ev) {
            var r = chart._legendRect;
            if (!r) return false;
            var rect = canvas.getBoundingClientRect();
            var x = ev.clientX - rect.left;
            var y = ev.clientY - rect.top;
            return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
        }

        canvas.addEventListener('pointerdown', function(e) {
            if (!hitLegend(e)) return;
            dragging = true;
            moved = false;
            chart._legendDragMoved = false;
            lastX = e.clientX;
            lastY = e.clientY;
            e.preventDefault();
        });

        window.addEventListener('pointermove', function(e) {
            if (!dragging) return;
            var dx = e.clientX - lastX;
            var dy = e.clientY - lastY;
            if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
            moved = true;
            chart._legendDragMoved = true;
            if (!chart._legendRect) return;
            var p = chart._legendPos || (chart._legendPos = { x: chart._legendRect.x, y: chart._legendRect.y });
            p.x += dx;
            p.y += dy;
            chart.draw();
            lastX = e.clientX;
            lastY = e.clientY;
        });

        window.addEventListener('pointerup', function() {
            if (dragging && moved && chart._legendPos) saveLegendPos(chart._legendPos);
            dragging = false;
        });

        canvas.addEventListener('pointermove', function(e) {
            if (!dragging) canvas.style.cursor = hitLegend(e) ? 'move' : '';
        });
    }

    // === Свой X-zoom: drag-выделение + своя кнопка Reset Zoom ===
    window.investZoomUiPlugin = {
        id: 'investZoomUi',
        afterDatasetsDraw: function(chart) {
            var ctx = chart.ctx;
            var area = chart.chartArea;

            if (chart._zoomSel) {
                var s = chart._zoomSel;
                ctx.save();
                ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
                ctx.fillRect(Math.min(s.x0, s.x1), area.top,
                             Math.abs(s.x1 - s.x0), area.bottom - area.top);
                ctx.restore();
            }

            if (chart._zoomRange) {
                var text = 'Reset Zoom';
                ctx.save();
                ctx.font = 'bold 12px sans-serif';
                var w = ctx.measureText(text).width + 16;
                var h = 22;
                var bx = area.right - w - 4;
                var by = area.top + 4;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(bx, by, w, h);
                ctx.fillStyle = '#000000';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, bx + w / 2, by + h / 2);
                ctx.restore();
                chart._resetZoomRect = { x: bx, y: by, w: w, h: h };
            } else {
                chart._resetZoomRect = null;
            }
        }
    };

    function hitRect(rect, ev, canvas) {
        if (!rect) return false;
        var r = canvas.getBoundingClientRect();
        var x = ev.clientX - r.left;
        var y = ev.clientY - r.top;
        return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    }

    function resetInvestZoom(chart) {
        if (!chart._zoomRange) return;
        var orig = chart._zoomOrig || {};
        chart.options.scales.x.min = orig.min;
        chart.options.scales.x.max = orig.max;
        chart._zoomRange = null;
        chart._zoomOrig = null;
        chart.update('none');
    }

    var _investZoomBound = false;

    function attachInvestZoom(chart) {
        if (_investZoomBound || !chart || !chart.canvas) return;
        _investZoomBound = true;
        var canvas = chart.canvas;
        var sel = null;

        canvas.addEventListener('pointerdown', function(e) {
            var rect = canvas.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var y = e.clientY - rect.top;
            var area = chart.chartArea;
            if (x < area.left || x > area.right || y < area.top || y > area.bottom) return;
            if (hitRect(chart._legendRect, e, canvas)) return;
            if (hitRect(chart._resetZoomRect, e, canvas)) return;
            sel = { x0: x, x1: x };
            chart._zoomSel = sel;
            e.preventDefault();
        });

        window.addEventListener('pointermove', function(e) {
            if (!sel) return;
            var rect = canvas.getBoundingClientRect();
            var x = Math.min(Math.max(e.clientX - rect.left, chart.chartArea.left), chart.chartArea.right);
            sel.x1 = x;
            chart.draw();
        });

        window.addEventListener('pointerup', function() {
            if (!sel) return;
            var dragged = Math.abs(sel.x1 - sel.x0) > 8;
            if (dragged && chart.data.labels && chart.data.labels.length > 2) {
                var i0 = Math.round(chart.scales.x.getValueForPixel(Math.min(sel.x0, sel.x1)));
                var i1 = Math.round(chart.scales.x.getValueForPixel(Math.max(sel.x0, sel.x1)));
                i0 = Math.max(0, Math.min(i0, chart.data.labels.length - 1));
                i1 = Math.max(0, Math.min(i1, chart.data.labels.length - 1));
                if (i1 - i0 >= 1) {
                    if (!chart._zoomRange) {
                        chart._zoomOrig = { min: chart.options.scales.x.min, max: chart.options.scales.x.max };
                    }
                    chart.options.scales.x.min = i0;
                    chart.options.scales.x.max = i1;
                    chart._zoomRange = { i0: i0, i1: i1 };
                    chart._selectionDragged = true;
                    chart.update('none');
                }
            }
            chart._zoomSel = null;
            sel = null;
            chart.draw();
        });
    }

    window.dailyGrowthLabelsPlugin = {
        id: 'dailyGrowthLabels',
        afterDatasetsDraw: function(chart) {
            var marks = chart._dailyGrowthMarks;
            if (!marks || !marks.length) return;
            var ctx = chart.ctx;
            var chartArea = chart.chartArea;
            var xScale = chart.scales.x;
            if (!xScale) return;

            ctx.save();
            ctx.font = '12px sans-serif';

            for (var i = 0; i < marks.length; i++) {
                var m = marks[i];
                if (typeof m.index !== 'number') continue;
                var x = xScale.getPixelForValue(m.index);
                if (x < chartArea.left || x > chartArea.right) continue;
                var y = chartArea.bottom + 10;
                ctx.fillStyle = m.pctGrowth >= 0 ? '#4caf50' : '#f44336';
                var sign = m.pctGrowth >= 0 ? '+' : '';
                var label = sign + m.pctGrowth.toFixed(2);

                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, 0, 0);
                ctx.restore();
            }
            ctx.restore();
        }
    };

    // ================================================================
    // PERIOD ENDPOINTS — начальный (слева) и конечный + дельта % (справа)
    // капитал на линиях Tinkoff/Finam для выбранного периода
    // ================================================================

    function fmtCap(v) {
        var a = Math.abs(v);
        if (a >= 1e6) return (v / 1e6).toFixed(2).replace('.', ',') + '\u041C';
        if (a >= 1e3) return Math.round(v / 1e3) + '\u043A';
        return String(Math.round(v));
    }

    function drawChip(ctx, x, y, valueText, valueColor, pctText, pctColor, alignRight) {
        var padX = 5, padY = 3;
        var wValue = ctx.measureText(valueText).width;
        var wPct = pctText ? ctx.measureText(pctText).width : 0;
        var w = wValue + (pctText ? 8 : 0) + wPct + padX * 2;
        var h = 12 + padY * 2;
        var bx = alignRight ? x - w : x;
        var by = Math.max(y - h / 2, 2);
        ctx.fillStyle = 'rgba(18, 20, 24, 0.82)';
        ctx.fillRect(bx, by, w, h);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = valueColor;
        ctx.fillText(valueText, bx + padX, y);
        if (pctText) {
            ctx.fillStyle = pctColor;
            ctx.fillText(pctText, bx + padX + wValue + 8, y);
        }
    }

    window.periodEndpointsPlugin = {
        id: 'periodEndpoints',
        afterDatasetsDraw: function(chart) {
            var ctx = chart.ctx;
            var area = chart.chartArea;
            var dsList = chart.data.datasets;
            if (!dsList || dsList.length < 1) return;
            var defs = [
                { idx: 0, axis: 'y_portfolio' },
                { idx: 1, axis: 'y_finam' }
            ];
            ctx.save();
            ctx.font = 'bold 12px sans-serif';
            for (var d = 0; d < defs.length; d++) {
                var ds = dsList[defs[d].idx];
                var sc = chart.scales[defs[d].axis];
                if (!ds || !sc || !ds.data || ds.data.length < 2 || ds.hidden === true) continue;
                var firstVal = null, lastVal = null;
                for (var i = 0; i < ds.data.length; i++) {
                    var p = ds.data[i];
                    var v = Number(p && p.y != null ? p.y : p);
                    if (isNaN(v)) continue;
                    if (firstVal === null) firstVal = v;
                    lastVal = v;
                }
                if (firstVal === null || isNaN(lastVal)) continue;

                drawChip(ctx, area.left + 2, sc.getPixelForValue(firstVal),
                         fmtCap(firstVal), ds.borderColor || '#cccccc', null, null, false);

                var pct = firstVal !== 0 ? (lastVal - firstVal) / Math.abs(firstVal) * 100 : 0;
                var pctTxt = (pct >= 0 ? '+' : '') + pct.toFixed(2).replace('.', ',') + '%';
                drawChip(ctx, area.right - 2, sc.getPixelForValue(lastVal),
                         fmtCap(lastVal), ds.borderColor || '#cccccc', pctTxt,
                         pct >= 0 ? '#4caf50' : '#f44336', true);
            }
            ctx.restore();
        }
    };

    // ================================================================
    // DATA FRESHNESS INDICATOR
    // ================================================================

    function showDataFreshness(rawTimestamps) {
        if (!rawTimestamps || rawTimestamps.length === 0) return;
        var panel = document.getElementById('invest_panel');
        if (!panel) return;
        var el = document.getElementById('invest_freshness');
        if (!el) {
            el = document.createElement('div');
            el.id = 'invest_freshness';
            el.style.cssText = 'position:absolute;bottom:2px;left:4px;font-size:11px;color:#888;z-index:15;font-family:helvetica,arial,sans-serif;pointer-events:none;';
            panel.appendChild(el);
        }
        var latestRaw = rawTimestamps[rawTimestamps.length - 1];
        var latestDt;
        var num = Number(latestRaw);
        if (!isNaN(num) && num > 1e10) {
            latestDt = new Date(num * 1000);
        } else if (!isNaN(num)) {
            latestDt = new Date(num);
        } else {
            latestDt = new Date(latestRaw);
        }
        if (!latestDt || isNaN(latestDt.getTime())) return;
        var ageMs = Date.now() - latestDt.getTime();
        var ageMin = Math.floor(ageMs / 60000);
        var maxAgeMin = currentInterval === 'minute' ? 3 : currentInterval === 'day' ? 120 : 10;
        var timeStr = latestDt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        if (ageMin > maxAgeMin) {
            el.innerHTML = '\u26A0 ' + timeStr + ' (' + ageMin + '\u043C\u0438\u043D)';
            el.style.color = '#f44336';
            el.style.fontWeight = 'bold';
        } else {
            el.innerHTML = '\u2713 ' + timeStr;
            el.style.color = '#888';
            el.style.fontWeight = 'normal';
        }
    }

    // ================================================================
    // DATA SOURCE BADGE — Finam / Tinkoff / оба
    // ================================================================

    function updateSourceBadge(rawData) {
        var el = document.getElementById('invest_source');
        if (el) { el.remove(); }
    }

    // ================================================================
    // INIT & EVENT HANDLERS
    // ================================================================

    function init() {
        if (window.InvestPlot.initialized) return;
        window.InvestPlot.initialized = true;
    }

    $(document).ready(function() {
        init();
        $(window).on('resize.investPlot', resizeCharts);
    });

    $(document).on('panelViewChange', function(e, data) {
        if (data.panel === 'invest_panel') {
            if (data.view === 'extrema' || data.view === 'period') {
                if (investChart) {
                    investChart.destroy();
                    investChart = null;
                }
            }
            updateInvestPlot();
        }
    });

    $(document).on('investDpiChange', function() {
        if (investChart) {
            investChart.destroy();
            investChart = null;
        }
        updateInvestPlot();
    });

    // ================================================================
    // PUBLIC API
    // ================================================================

    window.investPlotResize = resizeChartsThrottled;

    window.InvestPlot = {
        update: function() {
            if (!window.InvestPlot.initialized) {
                window.InvestPlot.initialized = true;
            }
            updateInvestPlot();
        },
        stop: function() {
            $(window).off('resize.investPlot');
            var canvas = document.getElementById('investChart');
            if (canvas) {
                var existing = Chart.getChart(canvas);
                if (existing) existing.destroy();
            }
            investChart = null;
            isUpdating = false;
            dailyGrowthMarks = [];
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
                resizeTimeout = null;
            }
        },
        getChart: function() { return investChart; },
        resize: resizeCharts,
        resizeNow: resizeChartsThrottled,
        registry: TICKER_REGISTRY
    };

})(jQuery);
