/**
 * invest_plot.js
 * Модуль для отображения графика динамики стоимости инвестиционного портфеля.
 * Использует Chart.js и API /api/invest/history.
 * Рисует график в canvas#investChart.
 * 
 * Особенности:
 * - Поддержка High-DPI дисплеев (Retina, 4K)
 * - Debounce/throttle для плавного ресайза
 * - Агрегация данных по интервалам (minute/hour/day)
 * - Метки экстремумов и суточного прироста
 * - Множественные оси Y для тикеров
 */

console.log('[InvestPlot] 📄 Script loaded');

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
    // Лимит DPR для снижения нагрузки на GPU (особенно на планшетах)
    function getSafeDPR() { return Math.min(window.devicePixelRatio || 1, 1.5); }

    // === Утилиты производительности ===
    
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    function throttle(func, limit) {
        let inThrottle = false;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => { inThrottle = false; }, limit);
            }
        };
    }

    // === Проверка canvas ===

    function checkCanvas() {
        const canvas = document.getElementById('investChart') ;
        if (!canvas || !canvas.isConnected || !document.body.contains(canvas)) {
            return { exists: false, reason: 'Элемент не найден или не в DOM' };
        }
        const rect = canvas.getBoundingClientRect();
        const isVisible = rect.width > 10 && rect.height > 10 &&
                         rect.top < window.innerHeight &&
                         rect.left < window.innerWidth;
        if (!isVisible) {
            return {
                exists: true,
                reason: `Невидимый (ширина: ${rect.width}, высота: ${rect.height})`,
                rect: rect
            };
        }
        return { exists: true, reason: 'OK', rect: rect };
    }

    // === Расчет прироста за сутки ===

    function calculateDailyGrowthMarks(timestamps, values) {
        const marks = [];
        const localDayKey = (d) => {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        };

        const dailyData = {};
        timestamps.forEach((tsAny, index) => {
            const ts = tsAny instanceof Date ? tsAny : new Date(tsAny);
            const dayKey = localDayKey(ts);
            if (!dailyData[dayKey]) {
                dailyData[dayKey] = { indices: [], timestamps: [], values: [] };
            }
            dailyData[dayKey].indices.push(index);
            dailyData[dayKey].timestamps.push(ts);
            dailyData[dayKey].values.push(values[index]);
        });

        const sortedDays = Object.keys(dailyData).sort();
        const dailyMidnight = {};
        sortedDays.forEach((dayKey) => {
            const day = dailyData[dayKey];
            if (!day?.timestamps?.length) return;
            let idx = day.timestamps.findIndex(d => d.getHours() === 0 && d.getMinutes() === 0);
            if (idx === -1) idx = 0;
            dailyMidnight[dayKey] = {
                index: day.indices[idx],
                timestamp: day.timestamps[idx],
                value: day.values[idx]
            };
        });

        for (let i = 1; i < sortedDays.length; i++) {
            const prevDay = sortedDays[i - 1];
            const currDay = sortedDays[i];
            const prev = dailyMidnight[prevDay];
            const curr = dailyMidnight[currDay];
            if (!prev || !curr) continue;

            const prevValue = prev.value;
            const currValue = curr.value;
            const midnightIndex = curr.index;
            const midnightTs = curr.timestamp;
            const absGrowth = currValue - prevValue;
            const pctGrowth = prevValue !== 0 ? (absGrowth / prevValue) * 100 : 0;
            const timeLabel = midnightTs.toLocaleString('ru-RU', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            marks.push({
                index: midnightIndex,
                timestamp: midnightTs,
                absGrowth: absGrowth,
                pctGrowth: pctGrowth,
                timeLabel: timeLabel,
                prevValue: prevValue,
                currValue: currValue
            });
        }

        return marks;
    }

    // === Плагин для отображения прироста за день под осью X ===
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

    // === Агрегация данных ===

    function aggregateData(timestamps, values, interval) {
        console.log(`[InvestPlot] 📊 Агрегация данных по интервалу: ${interval}`);
        const aggregated = {};

        for (let i = 0; i < timestamps.length; i++) {
            const ts = new Date(timestamps[i]);
            const bucket = new Date(ts);
            let key;

            switch (interval) {
                case 'minute':
                    bucket.setSeconds(0, 0);
                    key = String(bucket.getTime());
                    break;
                case 'hour':
                    bucket.setMinutes(0, 0, 0);
                    key = String(bucket.getTime());
                    break;
                case 'day':
                    bucket.setHours(0, 0, 0, 0);
                    key = String(bucket.getTime());
                    break;
                default:
                    key = String(ts.getTime());
            }

            if (!aggregated[key]) {
                aggregated[key] = { values: [], timestamp: bucket };
            }
            const numVal = Number(values[i]);
            aggregated[key].values.push(isNaN(numVal) ? 0 : numVal);
        }

        const sortedKeys = Object.keys(aggregated).sort((a, b) => Number(a) - Number(b));
        
        const resultLabels = [];
        const resultValues = [];
        const resultTimestamps = [];

        let lastValidValue = null;
        let intervalMs = 3600000;
        if (interval === 'minute') intervalMs = 60000;
        if (interval === 'day') intervalMs = 86400000;

        sortedKeys.forEach(key => {
            const group = aggregated[key];
            if (group.values.length === 0) return;
            
            let currentValue = group.values[group.values.length - 1];
            
            if (currentValue === null || currentValue === 0 || isNaN(currentValue)) {
                if (lastValidValue !== null) {
                    currentValue = lastValidValue;
                }
            } else {
                lastValidValue = currentValue;
            }
            
            if (resultTimestamps.length > 0) {
                const prevTime = resultTimestamps[resultTimestamps.length - 1].getTime();
                const currTime = group.timestamp.getTime();
                const gap = currTime - prevTime;
                
                if (gap > intervalMs * 1.5) {
                    const numGaps = Math.floor(gap / intervalMs);
                    for (let g = 1; g < numGaps; g++) {
                        const interpTime = new Date(prevTime + intervalMs * g);
                        let labelFormat;
                        if (interval === 'day') {
                            labelFormat = { day: '2-digit' };
                        } else if (interval === 'hour') {
                            labelFormat = { day: '2-digit', hour: '2-digit' };
                        } else {
                            labelFormat = { day: '2-digit', hour: '2-digit', minute: '2-digit' };
                        }
                        resultLabels.push(interpTime.toLocaleString('ru-RU', labelFormat));
                        resultValues.push(lastValidValue);
                        resultTimestamps.push(interpTime);
                    }
                }
            }
            
            let labelFormat;
            if (interval === 'day') {
                labelFormat = { day: '2-digit' };
            } else if (interval === 'hour') {
                labelFormat = { day: '2-digit', hour: '2-digit' };
            } else {
                labelFormat = { day: '2-digit', hour: '2-digit', minute: '2-digit' };
            }
            
            resultLabels.push(group.timestamp.toLocaleString('ru-RU', labelFormat));
            resultValues.push(currentValue);
            resultTimestamps.push(group.timestamp);
        });

        console.log(`[InvestPlot] ✅ Данные агрегированы: ${resultLabels.length} точек`);
        return { labels: resultLabels, values: resultValues, timestamps: resultTimestamps };
    }

    // === Валидация данных ===

    function validateGraphData(data) {
        if (!data || !data.labels || !data.values) {
            return { valid: false, reason: 'Нет данных' };
        }
        if (data.labels.length === 0 || data.values.length === 0) {
            return { valid: false, reason: 'Пустые данные' };
        }
        if (data.labels.length !== data.values.length) {
            return { valid: false, reason: 'Несоответствие длины меток и значений' };
        }
        return { valid: true };
    }

    // === Настройка размера canvas для High-DPI ===

    function setupCanvasForDPR(canvas, container) {
        if (!canvas || !container) return;
        
        const rect = container.getBoundingClientRect();
        const dpr = getSafeDPR();
        
        const cssWidth = Math.max(1, Math.floor(rect.width));
        const cssHeight = Math.max(1, Math.floor(rect.height));
        
        const bufferWidth = Math.floor(cssWidth * dpr);
        const bufferHeight = Math.floor(cssHeight * dpr);
        
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
        
        return { cssWidth, cssHeight, bufferWidth, bufferHeight, dpr };
    }

    // === Создание графика ===

    function createChart(canvas, chartData, extrema) {
        const hasDatasets = Array.isArray(chartData.datasets);
        const validation = validateGraphData(hasDatasets ?
            { labels: chartData.labels, values: chartData.datasets[0]?.data } :
            chartData
        );
        if (!validation.valid) {
            console.error(`[InvestPlot] ❌ Ошибка данных графика: ${validation.reason}`);
            return null;
        }

        try {
            // Проверяем что canvas привязан к DOM
            if (!canvas || !canvas.isConnected || !document.body.contains(canvas)) {
                console.error('[InvestPlot] ❌ Canvas не найден в DOM');
                return null;
            }

            // Zero canvas after destroy to free GPU memory
            const existingChart = Chart.getChart(canvas);
            if (existingChart) {
                existingChart.destroy();
            }
            canvas.width = 0;
            canvas.height = 0;

            // Настраиваем canvas для High-DPI
            const container = canvas.parentElement;
            

            setupCanvasForDPR(canvas, container);  
            const ctx = canvas.getContext('2d');

            
            const plugins = [];

            // Плагин для прироста за день под осью X (для всех интервалов)
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
                    console.error('[InvestPlot] ❌ Ошибка инициализации плагина экстремумов:', e);
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
                    console.error('[InvestPlot] ❌ Ошибка инициализации плагина линий 00:00:', e);
                }
            }

            // === РАСЧЕТ MIN/MAX для осей ===
            const portfolioDataset = chartData.datasets?.[0];
            const portfolioValues = portfolioDataset?.data || [];
            const validValues = portfolioValues.filter(v => v != null && v > 0);
            const portfolioMin = validValues.length > 0 ? Math.min(...validValues) : 0;
            const validForMax = portfolioValues.filter(v => v != null);
            const portfolioMax = validForMax.length > 0 ? Math.max(...validForMax) : 0;
            const portfolioRange = portfolioMax - portfolioMin;
            const portfolioPadding = portfolioRange > 0 ? portfolioRange * 0.1 : Math.max(portfolioMax * 0.1, 1000);

            // === НАСТРОЙКА ОСЕЙ ===
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
                // y_tgold_change: {
                //     position: 'left',
                //     beginAtZero: false,
                //     ticks: {
                //         display: true,
                //         callback: (value) => (value >= 0 ? '+' : '') + value.toFixed(1) + '%',
                //         font: { size: 11 },
                //         color: '#FF6B6B',
                //         autoSkip: true,
                //         maxTicksLimit: 6
                //     },
                //     grid: {
                //         display: false
                //     },
                //     title: {
                //         display: true,
                //         text: 'TGLD%',
                //         color: '#FF6B6B',
                //         font: { size: 12 }
                //     }
                // }
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
                    devicePixelRatio: getSafeDPR(),
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
            console.log(`[InvestPlot] ✅ График успешно создан (точек: ${chartData.labels.length})`);
            return chart;
        } catch (error) {
            console.error('[InvestPlot] ❌ Ошибка создания графика:', error);
            return null;
        }
    }

    // === Обновление графика ===

    function updateInvestPlot() {
        const savedView = localStorage.getItem('chartView');
        if (savedView === 'energy') {
            console.log('[InvestPlot] ⏸️ График батареи активен, пропускаем обновление');
            return;
        }

        console.log('[InvestPlot] 🔄 Обновление графика');
        if (isUpdating) {
            console.warn('[InvestPlot] ⚠️ Уже выполняется обновление, пропускаем');
            return;
        }
        isUpdating = true;

        const updateTimeoutId = setTimeout(function() {
            isUpdating = false;
            console.warn('[InvestPlot] ⚠️ Таймаут 30s, isUpdating сброшен');
        }, 30000);

        const canvasCheck = checkCanvas();
        if (!canvasCheck.exists) {
            initAttempts++;
            if (initAttempts > MAX_INIT_ATTEMPTS) {
                console.error(`[InvestPlot] ❌ Canvas #investChart не найден после ${MAX_INIT_ATTEMPTS} попыток`);
                isUpdating = false;
                return;
            }
            console.log(`[InvestPlot] ⏳ Ожидание элемента #investChart (${initAttempts}/${MAX_INIT_ATTEMPTS})...`);
            setTimeout(updateInvestPlot, INIT_ATTEMPT_DELAY);
            isUpdating = false;
            return;
        }

        if (canvasCheck.reason !== 'OK') {
            console.warn(`[InvestPlot] ⚠️ Canvas проблема: ${canvasCheck.reason}`);
            initAttempts++;
            if (initAttempts > MAX_INIT_ATTEMPTS) {
                console.error(`[InvestPlot] ❌ Проблема с canvas: ${canvasCheck.reason}`);
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
        console.log(`[InvestPlot] 📅 Текущий интервал: ${currentInterval}`);

        $.getJSON(`/api/invest/history?interval=${currentInterval}`)
            .done(function(rawData) {
                console.log('[InvestPlot] 📊 Получены данные history:', Object.keys(rawData).length, 'записей');
                if (!rawData || Object.keys(rawData).length === 0) {
                    console.warn('[InvestPlot] ⚠️ Нет данных для графика инвестиций');
                    isUpdating = false;
                    clearTimeout(updateTimeoutId);
                    return;
                }

                const timestamps = Object.keys(rawData).sort();

                // === ФОРМИРОВАНИЕ portfolioValues ===
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

                // === ДАННЫЕ ПО ТИКЕРАМ ===
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

                // Передаём данные в баннер (без лишнего fetch)
                if (typeof window.InvestBanner?.renderFromData === 'function') {
                    window.InvestBanner.renderFromData(rawData);
                }

                // === АГРЕГАЦИЯ ===
                const { labels, values: aggregatedPortfolio, timestamps: aggregatedTimestamps } = 
                    aggregateData(timestamps, portfolioValues, currentInterval);

                // === МЕТКИ РОСТА и ПРИРОСТ ЗА ДЕНЬ ===
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

                // === ЭКСТРЕМУМЫ ===
                const extrema = window.findDailyExtrema
                    ? window.findDailyExtrema(aggregatedPortfolio, aggregatedTimestamps)
                    : [];

                // === ДАТАСЕТЫ ===
                const datasets = [];

                // Основной портфель (левая ось)
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

                // Отдельные тикеры
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
                        yAxisID: 'y_tgold'   // ← КРИТИЧНО
                    });
                });

                // === СОЗДАНИЕ ГРАФИКА ===
                console.log('[InvestPlot] 📊 Создание графика, labels:', labels.length, 'datasets:', datasets.length);
                investChart = createChart(canvas, {
                    labels,
                    datasets,
                    timestamps: aggregatedTimestamps
                }, extrema);

                if (!investChart) {
                    console.error('[InvestPlot] ❌ Не удалось создать график');
                } else {
                    console.log('[InvestPlot] ✅ График создан, загрузка TGLD...');
                    window.loadTgoldToChart(investChart, labels, aggregatedTimestamps);
                }

                isUpdating = false;
                clearTimeout(updateTimeoutId);
            })
            .fail(function(xhr, status, error) {
                console.error('[InvestPlot] ❌ Ошибка загрузки /api/invest/history:', status, error, 'HTTP:', xhr.status);
                isUpdating = false;
                clearTimeout(updateTimeoutId);
            });
    }

    // === Публичный метод ресайза с debounce ===

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
            
            console.log('[InvestPlot] 📐 График перерисован под новый размер');
            resizeTimeout = null;
        }, RESIZE_DEBOUNCE_MS);
    }

    // === Throttled версия для использования во время drag/resize ===
    const resizeChartsThrottled = throttle(resizeCharts, RESIZE_THROTTLE_MS);

    // === Инициализация ===

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

    // === Публичный API ===

    // Debug: добавить кнопку в консоль
    console.log('[InvestPlot] Для обновления графика введите: InvestPlot.update()');

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
                    console.log('[InvestPlot] 🛑 График остановлен и уничтожен');
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

    console.log('[InvestPlot] ✅ Модуль загружен и готов к работе');

    // === ЗАГРУЗКА TGLD@ ПОСЛЕ СОЗДАНИЯ ГРАФИКА ===
    window.loadTgoldToChart = function(chart, portfolioLabels, portfolioTimestamps) {
        console.log('[InvestPlot] 🔄 loadTgoldToChart вызвана, chart:', !!chart);
        if (!chart) return;
        
        const interval = window.currentInterval || 'hour';
        
        $.getJSON(`/api/invest/tickers?interval=${interval}`)
            .done(function(tickersData) {
                console.log('[InvestPlot] 📡 Данные получены:', tickersData);
                try {
                    if (tickersData && tickersData['TGLD@']) {
                        const tgold = tickersData['TGLD@'];
                        console.log('[InvestPlot] 💰 TGLD@ данные:', tgold);
                        if (tgold.prices && tgold.prices.length > 0) {
                            console.log('[InvestPlot] 📈 TGLD prices count:', tgold.prices.length);
                            
                            // Преобразуем цены в формат с датами
                            const tgoldPrices = tgold.prices.map(p => ({
                                x: new Date(p.timestamp),
                                y: p.price
                            })).sort((a, b) => a.x - b.x);
                            
                            // Агрегация по тому же принципу, что и для портфеля
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
                                console.warn('[InvestPlot] ⚠️ Chart canvas недоступен для добавления TGLD@');
                                return;
                            }
                            chart.data.datasets.push(tgoldDataset);
                            chart.update('none');
                            console.log('[InvestPlot] ✅ TGLD@ добавлен на график');
                        } else {
                            console.log('[InvestPlot] ⚠️ Нет данных TGLD prices');
                        }
                    } else {
                        console.log('[InvestPlot] ⚠️ Нет данных TGLD@ в tickersData');
                    }
                } catch(e) {
                    console.error('[InvestPlot] ❌ Ошибка обработки:', e);
                }
            })
            .fail(function(xhr, status, error) {
                console.error('[InvestPlot] ❌ Ошибка загрузки /api/invest/tickers:', error, xhr.status);
            });
    };
    
    // === Агрегация данных TGLD по timestamps портфеля ===
    function aggregateTgoldData(prices, portfolioTimestamps, interval) {
        if (!portfolioTimestamps || portfolioTimestamps.length === 0) {
            return { data: [] };
        }
        
        // Создаем карту цены по времени
        const priceMap = {};
        prices.forEach(p => {
            const key = p.x.getTime();
            priceMap[key] = p.y;
        });
        
        const intervalMs = interval === 'minute' ? 60000 : interval === 'hour' ? 3600000 : 86400000;
        
        // Находим ближайшую цену для каждого timestamp портфеля
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
            
            // Если ближайшая цена более чем на интервал назад - не используем
            if (minDiff > intervalMs * 1.5) {
                return null;
            }
            
            return closestPrice;
        });
        
        // Заполняем пропуски горизонтальной линией до следующего изменения
        const resultData = [];
        let lastValue = null;
        
        for (let i = 0; i < rawData.length; i++) {
            const val = rawData[i];
            
            if (val !== null) {
                // Если есть новое значение и оно отличается от последнего - обновляем
                if (lastValue === null || val !== lastValue) {
                    lastValue = val;
                }
                resultData.push(lastValue);
            } else {
                // Пропуск - заполняем последним известным значением
                resultData.push(lastValue);
            }
        }
        
        return { data: resultData };
    }

    // Экспорт функции ресайза для использования из panel_resize.js
    window.investPlotResize = resizeChartsThrottled;

})(jQuery);
