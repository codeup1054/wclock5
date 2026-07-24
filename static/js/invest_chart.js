/**
 * invest_chart.js
 * Investment portfolio chart using Chart.js and /api/invest/history.
 * High-DPI support, data aggregation, extrema labels, daily growth marks.
 */

console.log('[InvestPlot] Script loaded');

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

    // === X-axis labels plugin (handles mode-based rendering) ===
    // === Daily growth label plugin (below X axis) ===
    const dailyGrowthLabelsPlugin = {
        id: 'dailyGrowthLabels',
        afterDatasetsDraw(chart) {
            const bars = chart._dailyBars;
            if (!bars || !bars.length) return;
            const { ctx, chartArea } = chart;
            
            const xScale = chart.scales.x;
            if (!xScale) return;
            
            ctx.save();
            ctx.font = '12px sans-serif';
            
            const chartWidth = chartArea.right - chartArea.left;
            const labelSpacing = chartWidth / bars.length;
            
            bars.forEach((bar, index) => {
                const x = chartArea.left + (index + 0.5) * labelSpacing;
                const y = bar.isPositive ?  chartArea.bottom + 20 : chartArea.bottom + 23;
                
                ctx.fillStyle = bar.isPositive ? '#4caf50' : '#f44336';
                
                const label = bar.value.toFixed(2);
                
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, 0, 0);
                ctx.restore();
            });
            
            ctx.restore();
        }
    };

    // === Chart creation ===

    function createChart(canvas, chartData, extrema, labelMode) {
        const hasDatasets = Array.isArray(chartData.datasets);
        const validation = validateGraphData(hasDatasets ?
            { labels: chartData.labels, values: chartData.datasets[0]?.data } :
            chartData
        );
        if (!validation.valid) {
            console.error('[InvestPlot] Chart data error:', validation.reason);
            return null;
        }

        try {
            // Verify canvas is in DOM
            if (!canvas || !canvas.isConnected || !document.body.contains(canvas)) {
                console.error('[InvestPlot] Canvas not found in DOM');
                return null;
            }

            // Zero canvas after destroy to free GPU memory
            const existingChart = Chart.getChart(canvas);
            if (existingChart) {
                existingChart.destroy();
            }
            canvas.width = 0;
            canvas.height = 0;

            // Setup canvas for High-DPI
            const container = canvas.parentElement;
            

            setupCanvasForDPR(canvas, container);  
            const ctx = canvas.getContext('2d');

            
            const plugins = [];

            // Plugin for daily growth below X axis (all intervals)
            if (currentInterval === 'day' || currentInterval === 'hour' || currentInterval === 'minute') {
                plugins.push(dailyGrowthLabelsPlugin);
            }

            if (window.ExtremaPlugin && getSetting('invest_panel_extrema', '0') !== '0') {
                try {
                    const extremaPlugin = window.initChartPlugin(
                        window.ExtremaPlugin(null),
                        { enabled: true }
                    );
                    if (extremaPlugin) plugins.push(extremaPlugin);
                } catch (e) {
                    console.error('[InvestPlot] Extrema plugin init error:', e);
                }
            }

            if (window.MidnightLinesPlugin) {
                try {
                    const midnightPlugin = window.initChartPlugin(
                        window.MidnightLinesPlugin(null),
                        { enabled: true }
                    );
                    if (midnightPlugin) plugins.push(midnightPlugin);
                } catch (e) {
                    console.error('[InvestPlot] MidnightLines plugin init error:', e);
                }
            }

            // === MIN/MAX calculation for axes ===
            const portfolioDataset = chartData.datasets?.[0];
            const portfolioValues = portfolioDataset?.data || [];
            const validValues = portfolioValues.filter(v => v != null && v > 0);
            const portfolioMin = validValues.length > 0 ? Math.min(...validValues) : 0;
            const validForMax = portfolioValues.filter(v => v != null);
            const portfolioMax = validForMax.length > 0 ? Math.max(...validForMax) : 0;
            const portfolioRange = portfolioMax - portfolioMin;
            const portfolioPadding = portfolioRange > 0 ? portfolioRange * 0.1 : Math.max(portfolioMax * 0.1, 1000);

            // === AXIS CONFIG ===
            const scales = {
                x: {
                    stacked: false,
                    ticks: {
                        display: true,
                        maxRotation: 0,
                        minRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 24,
                        font: { size: 10 },
                        color: '#ffd900',
                        callback: function(val, idx, ticks) {
                            var labels = this.chart.data.labels;
                            var label = (labels && labels[val] != null) ? String(labels[val]) : String(val);
                            return label.includes('||') ? label.split('||') : label;
                        }
                    },
                    grid: {
                        display: false
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
                        callback: (value) => {
                            if (value >= 1e6) return '' + (value / 1e6).toFixed(2) + '';
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
                    title: {
                        display: false,
                        text: 'Портфель',
                        color: '#2cbaa3',
                        font: { size: 14 }
                    }
                },
                y_tgold: {
                    position: 'left',
                    stacked: false,
                    ticks: {
                        display: true,
                        callback: (value) => value.toFixed(2),
                        font: { size: 13 },
                        color: '#ffd9007e',
                        autoSkip: true,
                        padding: -1,
                        maxTicksLimit: 6
                    },
                    grid: {
                        display: false
                    },
                    title: {
                        display: false,
                        text: 'TGLD@',
                        color: '#FFD700',
                        font: { size: 14 }, 
                        padding: -10
                    }
                },
                y_xau: {
                    position: 'left',
                    stacked: false,
                    ticks: {
                        display: true,
                        callback: (value) => '$' + value.toFixed(0),
                        font: { size: 13 },
                        color: '#5dade2',
                        autoSkip: true,
                        padding: -1,
                        maxTicksLimit: 6
                    },
                    grid: {
                        display: false
                    },
                    title: {
                        display: false,
                        text: 'XAU',
                        color: '#5dade2',
                        font: { size: 14 },
                        padding: -10
                    }
                },
            };

            const config = {
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
                        padding: { top: 40, right: 10, bottom: 60, left: 10 }
                    },
                    plugins: {
                        legend: { 
                            display: false, 
                            labels: { 
                                font: { size: 4 },
                                padding: 5
                            } 
                        },
                        tooltip: {
                            enabled: true,
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: (items) => (items[0]?.label || '').replace(/\|\|/g, ' '),
                                label: (ctx) => {
                                    const value = Number(ctx.parsed?.y);
                                    const dataset = ctx.dataset;
                                    let unit = '';
                                    if (dataset.yAxisID === 'y_portfolio') unit = '₽';
                                    else if (dataset.yAxisID === 'y_xau') unit = '$';
                                    return `${dataset.label}: ${unit}${value.toLocaleString('ru-RU')}`;
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
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    scales: scales,
                    elements: {
                        line: {
                            borderCapStyle: 'round',
                            borderJoinStyle: 'round'
                        },
                        point: {
                            hitRadius: 10
                        }
                    }
                }
            };

            const chart = new Chart(ctx, config);
            chart._extrema = extrema;
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

    // === Chart update flow ===

    function updateInvestPlot() {
        const savedView = getSetting('chartView');
        if (savedView === 'energy') {
            console.log('[InvestPlot] Battery chart active, skip update');
            return;
        }

        console.log('[InvestPlot] Updating chart');
        if (isUpdating) {
            console.warn('[InvestPlot] Update already in progress, skipping');
            return;
        }
        isUpdating = true;

        const updateTimeoutId = setTimeout(function() {
            isUpdating = false;
            console.warn('[InvestPlot] Timeout 30s, isUpdating reset');
        }, 30000);

        const canvasCheck = checkCanvas();
        if (!canvasCheck.exists) {
            initAttempts++;
            if (initAttempts > MAX_INIT_ATTEMPTS) {
                console.error('[InvestPlot] Canvas #investChart not found after', MAX_INIT_ATTEMPTS, 'attempts');
                isUpdating = false;
                return;
            }
            console.log('[InvestPlot] Waiting for #investChart (' + initAttempts + '/' + MAX_INIT_ATTEMPTS + ')...');
            setTimeout(updateInvestPlot, INIT_ATTEMPT_DELAY);
            isUpdating = false;
            return;
        }

        if (canvasCheck.reason !== 'OK') {
            console.warn('[InvestPlot] Canvas issue:', canvasCheck.reason);
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
        const canvas = document.getElementById('investChart');
        const container = canvas.parentElement;
        const ctx = canvas.getContext('2d');

        const currentInterval = window.currentInterval || 'hour';
        console.log('[InvestPlot] Current interval:', currentInterval);

        var period = getSetting('invest_panel_period', '-35 day');
        $.getJSON(`/api/invest/history?interval=${currentInterval}&period=${encodeURIComponent(period)}`)
            .done(function(rawData) {
                console.log('[InvestPlot] Got history data:', Object.keys(rawData).length, 'records');
                if (!rawData || Object.keys(rawData).length === 0) {
                    console.warn('[InvestPlot] No data for investment chart');
                    isUpdating = false;
                    clearTimeout(updateTimeoutId);
                    return;
                }

                const timestamps = Object.keys(rawData).sort();

                // portfolio values
                const portfolioValues = [];
                let lastValidTotal = 0;

                for (const ts of timestamps) {
                    const entry = rawData[ts];
                    let total = 0;

                    if (Array.isArray(entry)) {
                        total = entry.reduce((sum, p) => {
                            const val = Number(p.value);
                            return sum + (isNaN(val) ? 0 : val);
                        }, 0);
                        lastValidTotal = total;
                    } else {
                        total = lastValidTotal;
                    }

                    portfolioValues.push(total);
                }

                showDataFreshness(timestamps);

                // === TICKER DATA ===
                const TRACKED_TICKERS = ['TGLD@'];
                const tickerData = {};
                TRACKED_TICKERS.forEach(ticker => tickerData[ticker] = []);

                timestamps.forEach(ts => {
                    const entry = rawData[ts];
                    if (!Array.isArray(entry)) {
                        TRACKED_TICKERS.forEach(ticker => {
                            tickerData[ticker].push(null);
                        });
                        return;
                    }

                    const tickerMap = {};
                    entry.forEach(p => {
                        if (p.name && p.value != null) {
                            tickerMap[p.name] = Number(p.value);
                        }
                    });

                    TRACKED_TICKERS.forEach(ticker => {
                        tickerData[ticker].push(tickerMap[ticker] || null);
                    });
                });

                // Pass data to banner (no extra fetch)
                if (typeof window.InvestBanner?.renderFromData === 'function') {
                    window.InvestBanner.renderFromData(rawData);
                }

                // === AGGREGATION ===
                const showTime = getSetting('invest_panel_time', '1') !== '0';
                const showChange = getSetting('invest_panel_change', '1') !== '0';
                const labelMode = showTime && showChange ? 'both' : showChange ? 'change' : 'time';
                const { labels, values: aggregatedPortfolio, timestamps: aggregatedTimestamps } = 
                    aggregateData(timestamps, portfolioValues, currentInterval, labelMode);

                // === GROWTH MARKS ===
                if (currentInterval === 'minute' || currentInterval === 'hour' || currentInterval === 'day') {
                    dailyGrowthMarks = calculateDailyGrowthMarks(aggregatedTimestamps, aggregatedPortfolio);
                    dailyBars = dailyGrowthMarks.map(m => ({
                        value: m.pctGrowth,
                        isPositive: m.pctGrowth >= 0
                    }));
                } else {
                    dailyGrowthMarks = [];
                    dailyBars = [];
                }

                // === EXTREMA ===
                var extrema = [];
                if (getSetting('invest_panel_extrema', '0') !== '0' && window.findDailyExtrema) {
                    extrema = window.findDailyExtrema(aggregatedPortfolio, aggregatedTimestamps);
                }

                // === DATASETS ===
                const datasets = [];

                // Main portfolio (right axis)
                datasets.push({
                    label: 'Стоимость портфеля, ₽',
                    data: aggregatedPortfolio,
                    borderColor: '#2cba99',
                    backgroundColor: 'rgba(25, 150, 89, 0.15)',
                    borderWidth: 3,
                    tension: 0.2,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    yAxisID: 'y_portfolio'
                });

                // Individual tickers
                const TICKER_COLORS = {
                    'TGLD@': '#FFD700',
                };

                TRACKED_TICKERS.forEach(ticker => {
                    datasets.push({
                        label: `${ticker}, ₽`,
                        data: tickerData[ticker],
                        borderColor: TICKER_COLORS[ticker] || '#ccc',
                        borderWidth: 2,
                        tension: 0.2,
                        fill: false,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        borderDash: [15, 5],
                        hidden: true,
                        yAxisID: 'y_tgold'
                    });
                });

                // === CHART CREATION / UPDATE ===
                if (investChart && investChart._currentInterval === currentInterval) {
                    investChart._dailyBars = dailyBars;
                    investChart._extrema = extrema;
                    investChart._midnightTimestamps = aggregatedTimestamps;
                    investChart._labelMode = labelMode;
                    investChart.data.labels = labels;
                    investChart.data.datasets[0].data = aggregatedPortfolio;
                    while (investChart.data.datasets.length > 1) {
                        investChart.data.datasets.pop();
                    }
                    setupCanvasForDPR(canvas, container);
                    investChart.resize();
                    investChart.update('none');
                    console.log('[InvestPlot] Chart updated (' + labels.length + ' points)');
                    window.loadTgoldToChart(investChart, labels, aggregatedTimestamps);
                } else {
                    console.log('[InvestPlot] Creating chart, labels:', labels.length, 'datasets:', datasets.length);
                    investChart = createChart(canvas, {
                        labels,
                        datasets,
                        timestamps: aggregatedTimestamps
                    }, extrema, labelMode);

                    if (!investChart) {
                        console.error('[InvestPlot] Failed to create chart');
                    } else {
                        console.log('[InvestPlot] Chart created, loading TGLD...');
                        window.loadTgoldToChart(investChart, labels, aggregatedTimestamps);
                    }
                }

                isUpdating = false;
                clearTimeout(updateTimeoutId);
            })
            .fail(function(xhr, status, error) {
                console.error('[InvestPlot] Error loading /api/invest/history:', status, error, 'HTTP:', xhr.status);
                isUpdating = false;
                clearTimeout(updateTimeoutId);
            });
    }

    // === Public resize method with debounce ===

    function resizeCharts() {
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
        }
        
        resizeTimeout = setTimeout(() => {
            const canvas = document.getElementById('investChart');
            const container = canvas?.parentElement;
            if (!canvas || !container || !investChart) return;
            
            setupCanvasForDPR(canvas, container);
            
            investChart.resize();
            investChart.update('none');
            
            console.log('[InvestPlot] Chart resized');
            resizeTimeout = null;
        }, RESIZE_DEBOUNCE_MS);
    }

    // === Throttled version for drag/resize ===
    const resizeChartsThrottled = throttle(resizeCharts, RESIZE_THROTTLE_MS);

    // === Init ===

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

    // === Public API ===

    // Debug
    console.log('[InvestPlot] For chart update type: InvestPlot.update()');

    window.InvestPlot = {
        update: function() {
            if (!window.InvestPlot.initialized) {
                window.InvestPlot.initialized = true;
            }
            updateInvestPlot();
        },
        stop: function() {
            $(window).off('resize.investPlot');
            const canvas = document.getElementById('investChart');
            if (canvas) {
                const existing = Chart.getChart(canvas);
                if (existing) {
                    console.log('[InvestPlot] Chart stopped and destroyed');
                    existing.destroy();
                }
            }
            investChart = null;
            isUpdating = false;
            dailyGrowthMarks = [];
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
                resizeTimeout = null;
            }
        },
        getChart: function() {
            return investChart;
        },
        resize: resizeCharts,
        resizeNow: resizeChartsThrottled
    };

    console.log('[InvestPlot] Module loaded');

    // === Load TGLD@ after chart creation ===
    window.loadTgoldToChart = function(chart, portfolioLabels, portfolioTimestamps) {
        console.log('[InvestPlot] loadTgoldToChart called, chart:', !!chart);
        if (!chart) return;
        
        const interval = window.currentInterval || 'hour';
        
        var tPeriod = getSetting('invest_panel_period', '-35 day');
        $.getJSON(`/api/invest/tickers?interval=${interval}&period=${encodeURIComponent(tPeriod)}`)
            .done(function(tickersData) {
                console.log('[InvestPlot] Ticker data received:', tickersData);
                try {
                    // === TGLD@ ===
                    if (tickersData && tickersData['TGLD@']) {
                        const tgold = tickersData['TGLD@'];
                        console.log('[InvestPlot] TGLD@ data:', tgold);
                        if (tgold.prices && tgold.prices.length > 0) {
                            console.log('[InvestPlot] TGLD prices count:', tgold.prices.length);
                            
                            const tgoldPrices = tgold.prices.map(p => ({
                                x: new Date(p.timestamp),
                                y: p.price
                            })).sort((a, b) => a.x - b.x);
                            
                            const aggregated = aggregateTgoldData(tgoldPrices, portfolioTimestamps, interval);
                            
                            const tgoldDataset = {
                                label: 'TGLD@',
                                data: aggregated.data,
                                borderColor: '#FFD700',
                                borderWidth: 1.5,
                                tension: 0.2,
                                fill: false,
                                pointRadius: 0,
                                yAxisID: 'y_tgold'
                            };
                            
                            if (!chart || !chart.canvas || !chart.canvas.isConnected) {
                                console.warn('[InvestPlot] Chart canvas unavailable for TGLD@');
                                return;
                            }
                            const existingTgoldIdx = chart.data.datasets.findIndex(ds => ds.label === 'TGLD@');
                            if (existingTgoldIdx >= 0) {
                                chart.data.datasets[existingTgoldIdx].data = tgoldDataset.data;
                            } else {
                                chart.data.datasets.push(tgoldDataset);
                            }
                            console.log('[InvestPlot] TGLD@', existingTgoldIdx >= 0 ? 'updated' : 'added', 'to chart');
                        } else {
                            console.log('[InvestPlot] No TGLD prices data');
                        }
                    } else {
                        console.log('[InvestPlot] No TGLD@ in tickersData');
                    }

                    // === XAU/USD ===
                    if (tickersData && tickersData['XAU/USD']) {
                        const xau = tickersData['XAU/USD'];
                        console.log('[InvestPlot] XAU/USD data:', xau);
                        if (xau.prices && xau.prices.length > 0) {
                            console.log('[InvestPlot] XAU prices count:', xau.prices.length);
                            
                            const xauPrices = xau.prices.map(p => ({
                                x: new Date(p.timestamp),
                                y: p.price
                            })).sort((a, b) => a.x - b.x);
                            
                            const aggregated = aggregateTgoldData(xauPrices, portfolioTimestamps, interval);
                            
                            const xauDataset = {
                                label: 'XAU/USD',
                                data: aggregated.data,
                                borderColor: '#5dade2',
                                borderWidth: 2,
                                borderDash: [10, 5],
                                tension: 0.2,
                                fill: false,
                                pointRadius: 0,
                                pointHoverRadius: 4,
                                hidden: true,
                                yAxisID: 'y_xau'
                            };
                            
                            if (!chart || !chart.canvas || !chart.canvas.isConnected) {
                                console.warn('[InvestPlot] Chart canvas unavailable for XAU/USD');
                                return;
                            }
                            const existingXauIdx = chart.data.datasets.findIndex(ds => ds.label === 'XAU/USD');
                            if (existingXauIdx >= 0) {
                                chart.data.datasets[existingXauIdx].data = xauDataset.data;
                            } else {
                                chart.data.datasets.push(xauDataset);
                            }
                            console.log('[InvestPlot] XAU/USD', existingXauIdx >= 0 ? 'updated' : 'added', 'to chart');
                        } else {
                            console.log('[InvestPlot] No XAU prices data');
                        }
                    } else {
                        console.log('[InvestPlot] No XAU/USD in tickersData');
                    }

                    chart.resize();
                    chart.update('none');
                } catch(e) {
                    console.error('[InvestPlot] Ticker processing error:', e);
                }
            })
            .fail(function(xhr, status, error) {
                console.error('[InvestPlot] Error loading /api/invest/tickers:', error, xhr.status);
            });
    };
    
    // === Aggregate TGLD data by portfolio timestamps ===
    function aggregateTgoldData(prices, portfolioTimestamps, interval) {
        if (!portfolioTimestamps || portfolioTimestamps.length === 0) {
            return { data: [] };
        }
        
        const intervalMs = interval === 'minute' ? 60000 : interval === 'hour' ? 3600000 : 86400000;
        
        // For each portfolio timestamp (bucket start), find the latest TGLD price
        // within its interval bucket [bucketStart, bucketStart + intervalMs).
        // This ensures hourly buckets show the actual price within that hour,
        // not a price from the previous hour that happens to be closer by time.
        const resultData = [];
        let priceIdx = 0;
        let lastValidPrice = null;
        
        for (let i = 0; i < portfolioTimestamps.length; i++) {
            const bucketStart = portfolioTimestamps[i].getTime();
            const bucketEnd = bucketStart + intervalMs;
            
            // Skip TGLD prices before this bucket
            while (priceIdx < prices.length && prices[priceIdx].x.getTime() < bucketStart) {
                priceIdx++;
            }
            
            // Find the latest TGLD price within this bucket
            let priceInBucket = null;
            let j = priceIdx;
            while (j < prices.length && prices[j].x.getTime() < bucketEnd) {
                priceInBucket = prices[j].y;
                j++;
            }
            
            if (priceInBucket !== null) {
                lastValidPrice = priceInBucket;
            }
            resultData.push(lastValidPrice);
        }
        
        return { data: resultData };
    }

    // Export resize function for panel_resize.js
    window.investPlotResize = resizeChartsThrottled;

    // === Data freshness indicator ===

    function showDataFreshness(rawTimestamps) {
        if (!rawTimestamps || rawTimestamps.length === 0) return;
        var panel = document.getElementById('invest_panel');
        if (!panel) return;
        var el = document.getElementById('invest_freshness');
        if (!el) {
            el = document.createElement('div');
            el.id = 'invest_freshness';
            el.style.cssText = 'position:absolute;top:2px;right:4px;font-size:11px;color:#888;z-index:15;font-family:helvetica,arial,sans-serif;pointer-events:none;';
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
            el.innerHTML = '⚠ ' + timeStr + ' (' + ageMin + 'мин)';
            el.style.color = '#f44336';
            el.style.fontWeight = 'bold';
        } else {
            el.innerHTML = '✓ ' + timeStr;
            el.style.color = '#888';
            el.style.fontWeight = 'normal';
        }
    }

})(jQuery);
