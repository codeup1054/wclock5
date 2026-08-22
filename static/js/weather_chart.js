function drawWeatherChart() {
    if (window._weatherChartDrawing) return;
    window._weatherChartDrawing = true;
    
    const canvas = document.getElementById('weatherChart');
    if (!canvas) {
        window._weatherChartDrawing = false;
        return;
    }

    const FONT_SIZE = dpiFont(24, 'weather');
    let tempRange = [-15, 25];
    try {
        tempRange = JSON.parse(localStorage.getItem('weather_panel_range')) || [-15, 25];
    } catch (e) {}
    const tempMin = tempRange[0];
    const tempMax = tempRange[1];
    const pressMin = 720;
    const pressMax = 770;
    const windMin = -2.27;
    const windMax = 6;

    const container = canvas.parentElement;
    setupCanvasForDPR(canvas, container, chartDpiValue('weather'));

    $.getJSON('api/charts_data', function(data) {
        if (!Array.isArray(data)) {
            console.warn('Invalid data format');
            window._weatherChartDrawing = false;
            return;
        }

        const sortedData = data.sort((a, b) =>
            new Date(a.timestamp) - new Date(b.timestamp)
        );

        const rawTimestamps = [];
        const formattedLabels = [];
        const tempData = [];
        const feelsLikeData = [];
        const humidityData = [];
        const pressureData = [];
        const precipData = [];
        const windSpeedData = [];

        sortedData.forEach((point) => {
            rawTimestamps.push(point.timestamp);
            const d = new Date(point.timestamp);
            formattedLabels.push(d.getDate().toString().padStart(2,'0') + ' ' + d.getHours().toString().padStart(2,'0'));
            tempData.push(point.temperature ?? null);
            feelsLikeData.push(point.feels_like ?? null);
            humidityData.push(point.humidity ?? null);
            pressureData.push(point.pressure ?? null);
            precipData.push(point.precip_prob ?? null);
            windSpeedData.push(point.wind_speed ?? null);
        });

        const now = new Date();
        const closestIndex = rawTimestamps.findIndex(ts => new Date(ts) > now);
        const prevDate = new Date(rawTimestamps[Math.max(closestIndex - 1, 1)]);

        log(['closestIndex:', closestIndex, 'prevIndex:', Math.max(closestIndex - 1, 1), 'now:', (now - prevDate) / 1000 / 120, 'prevDate:', prevDate]);

        // Lightweight update if chart exists
        if (window.weatherChart && window.weatherChart.data) {
            const chart = window.weatherChart;
            chart._rawTimestamps = rawTimestamps;
            chart._closestIndex = closestIndex;
            chart._tempMin = tempMin;
            chart._FONT_SIZE = FONT_SIZE;
            chart.data.labels = formattedLabels;
            chart.data.datasets[0].data = tempData;
            chart.data.datasets[1].data = feelsLikeData;
            chart.data.datasets[2].data = windSpeedData;
            chart.data.datasets[3].data = humidityData;
            chart.data.datasets[4].data = pressureData;
            chart.data.datasets[5].data = precipData;
            chart.update('none');
            window._weatherChartDrawing = false;
            return;
        }
        // Stale reference — clean up
        if (window.weatherChart) {
            try { window.weatherChart.destroy(); } catch(e) {}
            window.weatherChart = null;
        }

        // Full creation
        const ctx = canvas.getContext('2d');

        const customXAxisPlugin = {
            id: 'customXAxisPlugin',
            afterDraw: (chart) => {
                const { ctx, scales } = chart;
                const { x, y_temp, y_wind } = scales;
                if (!x || !y_temp || !y_wind) return;

                const ts = chart._rawTimestamps || rawTimestamps;
                const tMin = chart._tempMin ?? tempMin;
                const fSize = chart._FONT_SIZE ?? FONT_SIZE;

                ctx.save();

                const yTemp0 = scales.y_temp.getPixelForValue(0);
                ctx.strokeStyle = '#ff5900ff';
                ctx.lineWidth = 5 * chartFontScale('weather');
                ctx.setLineDash([63, 4]);
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yTemp0);
                ctx.lineTo(chart.chartArea.right, yTemp0);
                ctx.stroke();

                const yWind0 = scales.y_wind.getPixelForValue(0);
                ctx.strokeStyle = '#ffffffaa';
                ctx.lineWidth = 4 * chartFontScale('weather');
                ctx.setLineDash([60, 7]);
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yWind0);
                ctx.lineTo(chart.chartArea.right, yWind0);
                ctx.stroke();

                // Линия текущего времени: позиция интерполируется по ВРЕМЕНИ между
                // соседними точками данных (пиксели точек, а не тиков оси!)
                let xNow = null;
                let fcIndex = -1;
                if (Array.isArray(ts) && ts.length >= 2) {
                    const nowTime = Date.now();
                    let ci = -1;
                    for (let i = 0; i < ts.length; i++) {
                        if (new Date(ts[i]).getTime() > nowTime) { ci = i; break; }
                    }
                    if (ci <= 0) {
                        xNow = chart.chartArea.left;
                    } else if (ci >= ts.length) {
                        xNow = chart.chartArea.right;
                    } else {
                        const tPrev = new Date(ts[ci - 1]).getTime();
                        const tNext = new Date(ts[ci]).getTime();
                        let ratio = tNext > tPrev ? (nowTime - tPrev) / (tNext - tPrev) : 0;
                        ratio = Math.max(0, Math.min(1, ratio));
                        const pPrev = scales.x.getPixelForValue(ci - 1);
                        const pNext = scales.x.getPixelForValue(ci);
                        if (isFinite(pPrev) && isFinite(pNext)) {
                            xNow = pPrev + ratio * (pNext - pPrev);
                            if (ci + 5 < ts.length) fcIndex = ci + 5;
                        }
                    }
                }

                if (xNow !== null && isFinite(xNow)) {
                    ctx.strokeStyle = '#ffc94166';
                    ctx.lineWidth = 16 * chartFontScale('weather');
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.moveTo(xNow, chart.chartArea.top);
                    ctx.lineTo(xNow, yWind0);
                    ctx.stroke();
                }

                if (fcIndex > 0) {
                    const xForecast = scales.x.getPixelForValue(fcIndex);
                    if (isFinite(xForecast)) {
                        ctx.strokeStyle = '#ffc531cc';
                        ctx.lineWidth = 3 * chartFontScale('weather');
                        ctx.setLineDash([]);
                        ctx.beginPath();
                        ctx.moveTo(xForecast, chart.chartArea.top);
                        ctx.lineTo(xForecast, yWind0);
                        ctx.stroke();
                    }
                }

                ctx.restore();
            }
        };

        window.weatherChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: formattedLabels,
                datasets: [
                    {
                        label: 'Temp (C)',
                        data: tempData,
                        borderColor: '#ff4800ff',
                        backgroundColor: 'rgba(255,160,47,0.1)',
                        yAxisID: 'y_temp',
                        tension: 0.5,
                        pointRadius: 0,
                        borderWidth: Math.max(1, 10 * chartFontScale('weather')),
                        spanGaps: true
                    },
                    {
                        label: 'Feels like (C)',
                        data: feelsLikeData,
                        borderColor: '#ff4800ff',
                        backgroundColor: 'rgba(255,160,47,0.1)',
                        yAxisID: 'y_temp',
                        tension: 0.5,
                        pointRadius: 0,
                        borderDash: [30, 8],
                        borderWidth: Math.max(1, 5 * chartFontScale('weather')),
                        spanGaps: true
                    },
                    {
                        label: 'Wind',
                        data: windSpeedData,
                        fill: false,
                        backgroundColor: 'rgba(0, 110, 255, 0.2)',
                        borderColor: 'rgba(255,255,255,0.7)',
                        yAxisID: 'y_wind',
                        tension: 0.6,
                        pointRadius: 0,
                        borderWidth: Math.max(1, 10 * chartFontScale('weather')),
                        borderDash: [50, 8],
                        spanGaps: true
                    },
                    {
                        label: 'Humidity (%)',
                        data: humidityData,
                        borderColor: '#55ccff99',
                        backgroundColor: 'rgba(85,204,255,0.1)',
                        yAxisID: 'y_humidity',
                        tension: 0.4,
                        pointRadius: 0,
                        borderWidth: Math.max(1, 6 * chartFontScale('weather')),
                        spanGaps: true
                    },
                    {
                        label: 'Pressure (mm)',
                        data: pressureData,
                        borderColor: '#31e378',
                        backgroundColor: 'rgba(255,255,136,0.1)',
                        yAxisID: 'y_pressure',
                        tension: 0.4,
                        pointRadius: 0,
                        borderWidth: Math.max(1, 11 * chartFontScale('weather')),
                        spanGaps: true
                    },
                    {
                        label: 'Precip (%)',
                        data: precipData,
                        borderColor: '#5ceefbff',
                        fill: true,
                        backgroundColor: 'rgba(0, 110, 255, 0.2)',
                        yAxisID: 'y_precip',
                        tension: 0.4,
                        pointRadius: 0,
                        borderDash: [12, 9],
                        borderWidth: Math.max(1, 7 * chartFontScale('weather')),
                        spanGaps: true
                    }
                ]
            },
            options: {
                responsive: false,
                maintainAspectRatio: false,
                animation: false,
                devicePixelRatio: Math.min(chartDpiValue('weather'), 6.0) * (window.devicePixelRatio || 1),
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        position: 'top',
                        grid: { color: '#ffffff33', lineWidth: 1, drawOnChartArea: true, drawTicks: false },
                    },
                    y_temp: {
                        type: 'linear', display: true, position: 'left', min: tempMin, max: tempMax, offset: true,
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { font: { size: FONT_SIZE * 1.3 }, color: '#ff5c38ff', padding: 2 }
                    },
                    y_pressure: {
                        type: 'linear', display: true, position: 'left', min: pressMin, max: pressMax, offset: true,
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { font: { size: FONT_SIZE }, color: '#31e378', padding: -1 }
                    },
                    y_wind: {
                        type: 'linear', display: true, position: 'right', min: windMin, max: windMax, offset: true,
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { stepSize: 1, font: { size: FONT_SIZE }, color: '#ffffffdd', padding: -2 }
                    },
                    y_humidity: {
                        type: 'linear', display: true, position: 'right', min: 0, max: 100, offset: true,
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { font: { size: FONT_SIZE }, color: '#55ccff', padding: 0 }
                    },
                    y_precip: {
                        type: 'linear', display: true, position: 'right', min: 0, max: 100, offset: true,
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { font: { size: FONT_SIZE * 0 }, color: '#a0ffef', padding: -1 } }
                }
            },
            plugins: [customXAxisPlugin]
        });

        window._weatherChartDrawing = false;
    }).fail(() => {
        console.error('Failed to load weather data');
        window._weatherChartDrawing = false;
    });
}

$(document).on('panelTempRangeChange', function(e) {
    if (e.panel === 'weather_panel') {
        drawWeatherChart();
    }
});

$(document).on('weatherTempRangeChange', function(e, min, max) {
    console.log('[Weather] Temp range changed:', min, max);
    drawWeatherChart();
});

let _lastWeatherSize = { w: 0, h: 0 };

$(document).on('weatherDpiChange', function() {
    if (window.weatherChart) {
        try { window.weatherChart.destroy(); } catch(e) {}
        window.weatherChart = null;
    }
    if (typeof drawWeatherChart === 'function') drawWeatherChart();
});

$(document).on('weatherChartResize', function() {
    const canvas = document.getElementById('weatherChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w === _lastWeatherSize.w && h === _lastWeatherSize.h) return;
    _lastWeatherSize = { w, h };
    // Force full recreation on resize (canvas dimensions changed)
    if (window.weatherChart && typeof window.weatherChart.destroy === 'function') {
        try { window.weatherChart.destroy(); } catch(e) {}
    }
    window.weatherChart = null;
    drawWeatherChart();
});

// Живая линия текущего времени: перерисовка раз в минуту без пересборки данных
if (!window._weatherNowLineTimer) {
    window._weatherNowLineTimer = setInterval(function() {
        const c = window.weatherChart;
        if (c && typeof c.update === 'function' && document.getElementById('weatherChart')) {
            c.update('none');
        }
    }, 60000);
}
