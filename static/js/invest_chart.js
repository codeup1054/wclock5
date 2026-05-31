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

    // === Daily growth label plugin (below X axis) ===
    const dailyGrowthLabelsPlugin = {
        id: 'dailyGrowthLabels',
        afterDatasetsDraw(chart) {
            const { ctx, chartArea } = chart;
            
            if (!dailyBars.length) return;
            
            const xScale = chart.scales.x;
            if (!xScale) return;
            
            ctx.save();
            ctx.font = '12px sans-serif';
            
            const chartWidth = chartArea.right - chartArea.left;
            const labelSpacing = chartWidth / dailyBars.length;
            
            dailyBars.forEach((bar, index) => {
                // Находим примерную позицию X
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

    function createChart(canvas, chartData, extrema) {
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

            if (extrema.length > 0 && window.ExtremaPlugin) {
                try {
                    const extremaPlugin = window.initChartPlugin(
                        window.ExtremaPlugin(extrema),
                        { enabled: true }
                    );
                    if (extremaPlugin) plugins.push(extremaPlugin);
                } catch (e) {
                    console.error('[InvestPlot] Extrema plugin init error:', e);
                }
            }

            if (chartData.timestamps && chartData.timestamps.length > 0 && window.MidnightLinesPlugin) {
                try {
                    const midnightPlugin = window.initChartPlugin(
                        window.MidnightLinesPlugin(chartData.timestamps),
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
                        display: false,
                        maxRotation: 0,
                        minRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 0
                    },
                    grid: {
                        display: false
                    }
                },
                y_portfolio: {
                    position: 'right',
                    stacked: false,
                    beginAtZero: true,
                    min: Math.max(0, portfolioMin - portfolioPadding),
                    max: Math.max(portfolioMax * 0.85, portfolioMax - portfolioPadding),
                    display: true,
                    ticks: {
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
                    beginAtZero: false,
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
                    maintainAspectRatio: false, // Ключевая настройка!
                    devicePixelRatio: getSafeDPR(1.5),
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
                                title: (items) => items[0]?.label || '',
                                label: (ctx) => {
                                    const value = Number(ctx.parsed?.y);
                                    const dataset = ctx.dataset;
                                    const unit = dataset.yAxisID === 'y_portfolio' ? '₽' : '';
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
            console.log('[InvestPlot] Chart created (' + chartData.labels.length + ' points)');
            return chart;
        } catch (error) {
            console.error('[InvestPlot] Chart creation error:', error);
            return null;
        }
    }

    // === Chart update flow ===

    function updateInvestPlot() {
        const savedView = localStorage.getItem('chartView');
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
        
        // Очищаем контекст перед рендером
        
        const container = canvas.parentElement;
        
        setupCanvasForDPR(canvas, container);

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const currentInterval = window.currentInterval || 'hour';
        console.log('[InvestPlot] Current interval:', currentInterval);

        $.getJSON(`/api/invest/history?interval=${currentInterval}`)
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
                const { labels, values: aggregatedPortfolio, timestamps: aggregatedTimestamps } = 
                    aggregateData(timestamps, portfolioValues, currentInterval);

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
                const extrema = window.findDailyExtrema
                    ? window.findDailyExtrema(aggregatedPortfolio, aggregatedTimestamps)
                    : [];

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

                // === CHART CREATION ===
                console.log('[InvestPlot] Creating chart, labels:', labels.length, 'datasets:', datasets.length);
                investChart = createChart(canvas, {
                    labels,
                    datasets,
                    timestamps: aggregatedTimestamps
                }, extrema);

                if (!investChart) {
                    console.error('[InvestPlot] Failed to create chart');
                } else {
                    console.log('[InvestPlot] Chart created, loading TGLD...');
                    window.loadTgoldToChart(investChart, labels, aggregatedTimestamps);
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
            localStorage.setItem('invest_panel_view', data.view);
            updateInvestPlot();
        }
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
        
        $.getJSON(`/api/invest/tickers?interval=${interval}`)
            .done(function(tickersData) {
                console.log('[InvestPlot] Ticker data received:', tickersData);
                try {
                    if (tickersData && tickersData['TGLD@']) {
                        const tgold = tickersData['TGLD@'];
                        console.log('[InvestPlot] TGLD@ data:', tgold);
                        if (tgold.prices && tgold.prices.length > 0) {
                            console.log('[InvestPlot] TGLD prices count:', tgold.prices.length);
                            
                            // Преобразуем цены в формат с датами
                            const tgoldPrices = tgold.prices.map(p => ({
                                x: new Date(p.timestamp),
                                y: p.price
                            })).sort((a, b) => a.x - b.x);
                            
                            // Aggregate by same logic as portfolio
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
                            chart.data.datasets.push(tgoldDataset);
                            chart.update('none');
                            console.log('[InvestPlot] TGLD@ added to chart');
                        } else {
                            console.log('[InvestPlot] No TGLD prices data');
                        }
                    } else {
                        console.log('[InvestPlot] No TGLD@ in tickersData');
                    }
                } catch(e) {
                    console.error('[InvestPlot] TGLD processing error:', e);
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
        
        // Create price map by time
        const priceMap = {};
        prices.forEach(p => {
            const key = p.x.getTime();
            priceMap[key] = p.y;
        });
        
        const intervalMs = interval === 'minute' ? 60000 : interval === 'hour' ? 3600000 : 86400000;
        
        // Find closest price for each portfolio timestamp
        const rawData = portfolioTimestamps.map(ts => {
            const tsTime = ts.getTime();
            
            let closestPrice = null;
            let minDiff = Infinity;
            
            prices.forEach(p => {
                const diff = Math.abs(p.x.getTime() - tsTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestPrice = p.y;
                }
            });
            
            // If closest price is more than interval away - skip
            if (minDiff > intervalMs * 1.5) {
                return null;
            }
            
            return closestPrice;
        });
        
        // Fill gaps with last known value
        const resultData = [];
        let lastValue = null;
        
        for (let i = 0; i < rawData.length; i++) {
            const val = rawData[i];
            
            if (val !== null) {
                // New value and different from last - update
                if (lastValue === null || val !== lastValue) {
                    lastValue = val;
                }
                resultData.push(lastValue);
            } else {
                // Gap - fill with last known
                resultData.push(lastValue);
            }
        }
        
        return { data: resultData };
    }

    // Export resize function for panel_resize.js
    window.investPlotResize = resizeChartsThrottled;

})(jQuery);
