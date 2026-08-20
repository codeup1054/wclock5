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
            borderWidth: 1.5,
            borderDash: [],
            pointRadius: 0,
            hidden: false,
            aggregation: 'closest-forward',
            axisPosition: 'left',
            maxTicksLimit: 6,
        },
        'XAU/USD': {
            label: 'XAU',
            color: '#5dade2',
            yAxisID: 'y_xau',
            tickColor: '#5dade2',
            tickFormat: function(v) { return v >= 1000 ? (v / 1000).toFixed(1) + '\u043A' : v.toFixed(0); },
            borderWidth: 2,
            borderDash: [1, 1],
            pointRadius: 0,
            hidden: false,
            aggregation: 'closest-forward',
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
        else if (window.currentInterval === 'hour') intervalMs = 3600000;

        var threshold = intervalMs * 2;
        var priceIdx = 0;

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
        if (rangeMs <= 3 * h) return 'minute';
        if (rangeMs <= 24 * h) return '10min';
        if (rangeMs <= 72 * h) return 'hour';
        return 'day';
    }

    function isTimeAligned(d, step) {
        switch (step) {
            case 'minute': return d.getSeconds() === 0 && d.getMilliseconds() === 0;
            case '10min': return d.getMinutes() % 10 === 0 && d.getSeconds() === 0;
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
                    if (ticks.length > 10) {
                        var picked = [];
                        var skip = Math.ceil(ticks.length / 10);
                        for (var t = 0; t < ticks.length; t += skip) picked.push(ticks[t]);
                        var last = ticks[ticks.length - 1];
                        if (picked[picked.length - 1].value !== last.value) picked.push(last);
                        ticks = picked.slice(0, 10);
                    }
                    axis.ticks = ticks;
                },
                ticks: {
                    display: true,
                    maxRotation: 0,
                    minRotation: 0,
                    padding: -30,
                    autoSkip: true,
                    maxTicksLimit: showTime ? 10 : 30,
                    font: { size: 10 },
                    color: xTickColor,
                    callback: xTickCallback
                },
                grid: { display: false }
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
                    font: { size: 10 },
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
                title: { display: false, text: 'Портфель', color: '#2cbaa3', font: { size: 14 } }
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
                        if (value >= 1e6) return '' + (value / 1e6).toFixed(2);
                        return '' + Number(value).toLocaleString('ru-RU');
                    },
                    font: { size: 10 },
                    color: '#e84393',
                    autoSkip: true,
                    padding: -1,
                    maxTicksLimit: 8
                },
                grid: { display: false },
                title: { display: false }
            };
        }

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
                        font: { size: 13 },
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
                        font: { size: 14 },
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
                tension: 0.2,
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
        var lastValid = null;
        for (var i = 0; i < timestamps.length; i++) {
            var entry = rawData[timestamps[i]];
            var sum = 0;
            var found = false;
            if (Array.isArray(entry)) {
                for (var k = 0; k < entry.length; k++) {
                    var p = entry[k];
                    if (p && p.source === source) {
                        var val = Number(p.value);
                        if (!isNaN(val)) {
                            sum += val;
                            found = true;
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
        }
        return values;
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
                            chart.data.datasets[existingIdx].hidden = cfg.hidden;
                        } else {
                            chart.data.datasets.push({
                                label: cfg.label,
                                data: filledData,
                                borderColor: cfg.color,
                                borderWidth: cfg.borderWidth || 2,
                                borderDash: cfg.borderDash || [],
                                tension: 0.2,
                                fill: false,
                                pointRadius: cfg.pointRadius || 0,
                                pointHoverRadius: 5,
                                spanGaps: true,
                                hidden: cfg.hidden,
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

    function createChart(canvas, chartData, extrema, labelMode) {
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
                    devicePixelRatio: Math.min(parseFloat(getSetting('chart_dpi', '2')) || 2, 6.0) * (window.devicePixelRatio || 1),
                    clip: false,
                    layout: {
                        padding: { top: 4, right: 6, bottom: 23, left: 10 }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            enabled: true,
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: function(items) { return (items[0] && items[0].label || '').replace(/\|\|/g, ' '); },
                                label: function(ctx) {
                                    var value = Number(ctx.parsed && ctx.parsed.y);
                                    var dataset = ctx.dataset;
                                    var unit = '';
                                    if (dataset.yAxisID === 'y_portfolio') unit = '\u20BD';
                                    else if (dataset.yAxisID === 'y_xau') unit = '$';
                                    return dataset.label + ': ' + unit + value.toLocaleString('ru-RU');
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
                toggleLegendDataset(chart, event);
            });
            chart._extrema = extrema;
            chart._dailyGrowthMarks = dailyGrowthMarks;
            chart._midnightTimestamps = chartData.timestamps;
            chart._currentInterval = currentInterval;
            chart._labelMode = labelMode;
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

            var timestamps = Object.keys(rawData).sort();

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

            // Pass data to banner
            if (typeof window.InvestBanner !== 'undefined' && typeof window.InvestBanner.renderFromData === 'function') {
                window.InvestBanner.renderFromData(rawData, tickersData);
            }

            // Aggregation
            var showTime = getSetting('invest_panel_time', '1') !== '0';
            var showChange = getSetting('invest_panel_change', '1') !== '0';
            var labelMode = showTime && showChange ? 'both' : showChange ? 'change' : 'time';
            var aggResult = aggregateData(timestamps, portfolioValues, currentInterval, labelMode);
            var labels = aggResult.labels;
            var aggregatedPortfolio = aggResult.values;
            var aggregatedTimestamps = aggResult.timestamps;

            // Filter X-axis labels: show only 00:00 midnight growth values
            if (currentInterval === 'hour' || currentInterval === 'minute') {
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
            if (showChange && (currentInterval === 'minute' || currentInterval === 'hour' || currentInterval === 'day')) {
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
            var tinkoffRaw = buildPortfolioSeriesBySource(rawData, timestamps, 'tinkoff');
            var finamRaw = buildPortfolioSeriesBySource(rawData, timestamps, 'finam');
            var tinkoffAgg = aggregateData(timestamps, tinkoffRaw, currentInterval, 'time');
            var finamAgg = aggregateData(timestamps, finamRaw, currentInterval, 'time');
            var tinkoffSeries = tinkoffAgg.values;
            var finamSeries = finamAgg.values;

            // Min/max для осей: каждый график нормирован по своему диапазону
            var validTinkoff = tinkoffSeries.filter(function(v) { return v != null && v > 0; });
            var portfolioMin = validTinkoff.length > 0 ? Math.min.apply(null, validTinkoff) : 0;
            var portfolioMax = validTinkoff.length > 0 ? Math.max.apply(null, validTinkoff) : 0;
            var validFinam = finamSeries.filter(function(v) { return v != null && v > 0; });
            var finamMin = validFinam.length > 0 ? Math.min.apply(null, validFinam) : 0;
            var finamMax = validFinam.length > 0 ? Math.max.apply(null, validFinam) : 0;

            // Build scales from registry
            var scales = buildScales(portfolioMin, portfolioMax, showTime, finamMin, finamMax);

            var finamAxis = finamMax > 0 ? 'y_finam' : 'y_portfolio';

            var datasets = [
                {
                    label: '\u041F\u043E\u0440\u0442\u0444\u0435\u043B\u044C Tinkoff',
                    data: tinkoffSeries,
                    borderColor: '#2cba99',
                    backgroundColor: 'rgba(25, 150, 89, 0.15)',
                    borderWidth: 2,
                    tension: 0.2,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    yAxisID: 'y_portfolio'
                },
                {
                    label: '\u041F\u043E\u0440\u0442\u0444\u0435\u043B\u044C Finam',
                    data: finamSeries,
                    borderColor: '#e84393',
                    backgroundColor: 'rgba(232, 67, 147, 0.12)',
                    borderWidth: 2,
                    tension: 0.2,
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    yAxisID: finamAxis
                }
            ];

            // Add ticker placeholder datasets from registry
            var placeholders = buildPlaceholderDatasets();
            datasets = datasets.concat(placeholders);

            // Chart update or create
            if (investChart && investChart._currentInterval === currentInterval) {
                investChart._dailyBars = dailyBars;
                investChart._dailyGrowthMarks = dailyGrowthMarks;
                investChart._extrema = extrema;
                investChart._midnightTimestamps = aggregatedTimestamps;
                investChart._labelMode = labelMode;
                investChart.data.labels = labels;

                // Update portfolio in place, remove old ticker datasets
                if (investChart.data.datasets[0]) investChart.data.datasets[0].data = tinkoffSeries;
                if (investChart.data.datasets[1]) investChart.data.datasets[1].data = finamSeries;
                while (investChart.data.datasets.length > 2) {
                    investChart.data.datasets.pop();
                }

                // Add fresh ticker placeholder datasets
                for (var p = 0; p < placeholders.length; p++) {
                    investChart.data.datasets.push(placeholders[p]);
                }

                // Load ticker data into chart
                window.loadTickersToChart(investChart, aggregatedTimestamps);
            } else {
                investChart = createChart(canvas, {
                    labels: labels,
                    datasets: datasets,
                    timestamps: aggregatedTimestamps,
                    scales: scales
                }, extrema, labelMode);

                if (!investChart) {
                    console.error('[InvestPlot] Failed to create chart');
                } else {
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
        // Рисуем ПОСЛЕ тултипа/линии значений, чтобы легенда была поверх всех слоёв
        afterTooltipDraw: function(chart) {
            var ctx = chart.ctx;
            var chartArea = chart.chartArea;
            var datasets = chart.data.datasets;
            if (!datasets || !datasets.length) return;

            var x = chartArea.left + 10;
            var y = chartArea.top + 20;
            var lineHeight = 14;
            var areas = [];

            ctx.save();
            ctx.font = '11px sans-serif';
            ctx.textBaseline = 'middle';

            // Подложка для читаемости поверх линий
            ctx.fillStyle = 'rgba(18, 20, 24, 0.78)';
            ctx.fillRect(chartArea.left, chartArea.top + 10, 130, datasets.length * lineHeight + 6);

            for (var i = 0; i < datasets.length; i++) {
                var ds = datasets[i];
                if (!ds.label) continue;
                var color = ds.borderColor || ds.backgroundColor || '#ccc';
                var hidden = ds.hidden === true;
                var alpha = hidden ? 0.4 : 1;

                ctx.globalAlpha = alpha;
                ctx.fillStyle = color;
                ctx.fillRect(x, y - 4, 12, 2);
                ctx.fillStyle = hidden ? '#666' : '#ccc';
                ctx.fillText(ds.label, x + 18, y);

                areas.push({
                    x: chartArea.left,
                    y: y - 6,
                    width: 130,
                    height: lineHeight,
                    datasetIndex: i
                });
                y += lineHeight;
            }

            ctx.restore();
            chart._legendHitAreas = areas;
        }
    };

    function toggleLegendDataset(chart, event) {
        var areas = chart._legendHitAreas;
        if (!areas || !areas.length) return;
        var rect = chart.canvas.getBoundingClientRect();
        var x = event.clientX - rect.left;
        var y = event.clientY - rect.top;
        for (var i = 0; i < areas.length; i++) {
            var a = areas[i];
            if (x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) {
                var ds = chart.data.datasets[a.datasetIndex];
                if (!ds) return;
                ds.hidden = !ds.hidden;
                chart.update();
                return;
            }
        }
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
        var panel = document.getElementById('invest_panel');
        if (!panel) return;
        var el = document.getElementById('invest_source');
        if (!el) {
            el = document.createElement('div');
            el.id = 'invest_source';
            el.style.cssText = 'position:absolute;top:2px;right:4px;font-size:10px;z-index:15;font-family:helvetica,arial,sans-serif;padding:1px 6px;border-radius:8px;background:rgba(40,40,40,0.65);letter-spacing:.3px;pointer-events:none;';
            panel.appendChild(el);
        }
        var timestamps = Object.keys(rawData || {}).sort();
        if (!timestamps.length) { el.style.display = 'none'; return; }
        var latest = rawData[timestamps[timestamps.length - 1]];
        if (!Array.isArray(latest)) { el.style.display = 'none'; return; }
        var sources = {};
        for (var i = 0; i < latest.length; i++) {
            if (latest[i] && latest[i].source) sources[latest[i].source] = true;
        }
        var keys = Object.keys(sources);
        if (keys.length === 0) { el.style.display = 'none'; return; }
        var hasFinam = !!sources['finam'];
        var hasTinkoff = !!sources['tinkoff'];
        var label = hasFinam && hasTinkoff ? 'Finam + Tinkoff' : hasFinam ? 'Finam' : hasTinkoff ? 'Tinkoff' : '';
        if (!label) { el.style.display = 'none'; return; }
        el.textContent = '\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A: ' + label;
        el.style.display = 'block';
        el.style.color = hasFinam ? '#7cb7ff' : '#aaa';
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

    $(document).on('dpiChange', function() {
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
