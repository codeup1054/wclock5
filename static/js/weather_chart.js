function drawWeatherChart() {
    // Prevent concurrent calls
    if (window._weatherChartDrawing) {
        console.log('[WeatherChart] Draw already in progress, skipping');
        return;
    }
    window._weatherChartDrawing = true;
    
    const canvas = document.getElementById('weatherChart');
    if (!canvas) {
        window._weatherChartDrawing = false;
        return;
    }
    
    // Destroy any existing Chart.js instance - check by canvas AND by chart ID
    try {
        // First try to get chart by canvas
        let existingChart = Chart.getChart(canvas);
        if (existingChart) {
            existingChart.destroy();
        }
        // Also try to get chart by ID (Chart.js registers charts with IDs)
        if (window.weatherChart && typeof window.weatherChart.destroy === 'function') {
            window.weatherChart.destroy();
        }
    } catch (e) {
        console.warn('[WeatherChart] Error destroying existing chart:', e);
    }
    
    // Reset canvas dimensions and clear completely
    canvas.width = 0;
    canvas.height = 0;
    canvas.width = canvas.offsetWidth * 2;  // DPR for proper sizing
    canvas.height = canvas.offsetHeight * 2;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const FONT_SIZE = 24;
    let tempRange = [-15, 25];
    try {
        tempRange = JSON.parse(localStorage.getItem('weather_panel_range')) || [-15, 25];
    } catch (e) {}
    const tempMin = tempRange[0];
    const tempMax = tempRange[1];
    const DPR_MULTIPLIER = 2;

    const pressMin = 720 ;
    const pressMax = 770;

    const windMin = -2.27
    const windMax = 6

    function setupCanvasForDPR(canvas, container) {
        if (!canvas || !container) return;
        
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const renderScale = DPR_MULTIPLIER;
        
        const cssWidth = Math.max(1, Math.floor(rect.width));
        const cssHeight = Math.max(1, Math.floor(rect.height));
        
        const bufferWidth = Math.floor(cssWidth * dpr * renderScale);
        const bufferHeight = Math.floor(cssHeight * dpr * renderScale);
        
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
        
        return { cssWidth, cssHeight, bufferWidth, bufferHeight, dpr, renderScale };
    }

    $.getJSON('api/charts_data', function(data) {
        // console.log('📊 Данные графика:', data);

        if (!Array.isArray(data)) {
            console.warn('❗ Неверный формат данных');
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
            formattedLabels.push(`${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}`);
            tempData.push(point.temperature ?? null);
            feelsLikeData.push(point.feels_like ?? null);
            humidityData.push(point.humidity ?? null);
            pressureData.push(point.pressure ?? null);
            precipData.push(point.precip_prob ?? null);
            windSpeedData.push(point.wind_speed ?? null);
        });
        
        // Re-get canvas after data loaded (ensure it's still valid)
        const canvas = document.getElementById('weatherChart');
        if (!canvas) {
            window._weatherChartDrawing = false;
            return;
        }
        const ctx = canvas.getContext('2d');
        
        const container = canvas.parentElement;
        setupCanvasForDPR(canvas, container);
        
        const now = new Date();

        const closestIndex = rawTimestamps.findIndex(ts => new Date(ts) > now);
        const prevIndex = Math.max(closestIndex - 1, 1);

        const prevDate = new Date(rawTimestamps[prevIndex]);


        logg(['closestIndex:', closestIndex, 'prevIndex:', prevIndex, 'now:', (now-prevDate)/1000/120, 'prevDate:', prevDate ]);

        // Плагин для линии "сейчас" и кастомных X-меток
        const customXAxisPlugin = {
            id: 'customXAxisPlugin',
            afterDraw: (chart) => {
                const { ctx, scales } = chart;
                const { x, y_temp, y_wind } = scales;
                if (!x || !y_temp || !y_wind) return;



                // --- вертикальная линия "сейчас" ---
                const prevIndex = Math.max(closestIndex - 1, 1);
                
                const tPrev = new Date(rawTimestamps[prevIndex]).getTime();
                const tNext = new Date(rawTimestamps[closestIndex]).getTime();
                const currentTime = new Date();
                const nowTime = currentTime.getTime();

                const ratio = (nowTime - tPrev) / (tNext - tPrev );
                

                // logg(['closestIndex:', closestIndex, 'prevIndex:', prevIndex, 'now:', (nowTime - prevDate) / 1000 / 120, 'prevDate:', prevDate]);


                ctx.save();
                
                // --- горизонтальная линия температуры 0°C ---
                const yTemp0 = scales.y_temp.getPixelForValue(0);
                ctx.strokeStyle = '#ff5900ff'; // цвет линии температуры
                ctx.lineWidth = 5;
                ctx.setLineDash([63, 4]);
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yTemp0);
                ctx.lineTo(chart.chartArea.right, yTemp0);
                ctx.stroke();

                // --- горизонтальная линия ветра 0 ---
                const yWind0 = scales.y_wind.getPixelForValue(0);
                ctx.strokeStyle = '#ffffffaa'; // цвет линии ветра
                ctx.lineWidth = 4;
                ctx.setLineDash([60, 7]);
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yWind0);
                ctx.lineTo(chart.chartArea.right, yWind0);
                ctx.stroke();

                // --- вертикальная линия "сейчас" ---
                // const xNow = scales.x.getPixelForTick(prevIndex)  + ratio * (scales.x.getPixelForTick(closestIndex) - scales.x.getPixelForTick(prevIndex));
                
                const xNow = scales.x.getPixelForTick(closestIndex - 1 ) + ratio * (scales.x.getPixelForTick(closestIndex) - scales.x.getPixelForTick(prevIndex));
                ctx.strokeStyle = '#ffc941ff';
                ctx.lineWidth = 3;
                ctx.setLineDash([32, 6]);
                ctx.beginPath();
                ctx.moveTo(xNow, chart.chartArea.top);
                ctx.lineTo(xNow, yWind0);
                ctx.stroke();

                // --- вертикальная линия через 5 шагов прогноза ---
                const xForecast = scales.x.getPixelForTick(closestIndex + 5);
                ctx.strokeStyle = '#ffc531ff';
                ctx.lineWidth = 3;
                ctx.setLineDash([12, 3]);
                ctx.beginPath();
                ctx.moveTo(xForecast, chart.chartArea.top);
                ctx.lineTo(xForecast, yWind0);
                ctx.stroke();



                
                // --- X метки с поворотом 60° ---
                const yTempMin = scales.y_temp.getPixelForValue(tempMin-0.5);
                ctx.fillStyle = 'rgba(182, 238, 255, 0.9)';
                ctx.font = `${FONT_SIZE}px sans-serif`;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';

                scales.x.ticks.forEach((tick, i) => {
                    const x = scales.x.getPixelForTick(i);
                    ctx.save();
                    ctx.translate(x, yTempMin);
                    ctx.rotate(-Math.PI / 3); // 60°
                    ctx.fillText(tick.label, 0, 0);
                    ctx.restore();
                });

                ctx.restore();
            }
        };


        window.weatherChart = new Chart(ctx, {
            type: 'line',
            id: 'weatherChart',
            data: {
                labels: formattedLabels,
                datasets: [
                    {
                        label: 'Температура (°C)',
                        data: tempData,
                        borderColor: '#ff4800ff',
                        backgroundColor: 'rgba(255,160,47,0.1)',
                        yAxisID: 'y_temp',
                        tension: 0.5,
                        pointRadius: 0,
                        borderWidth: 10,
                        spanGaps: true
                    },
                    {
                        label: 'Feels like (°C)',
                        data: feelsLikeData,
                        borderColor: '#ff4800ff',
                        backgroundColor: 'rgba(255,160,47,0.1)',
                        yAxisID: 'y_temp',
                        tension: 0.5,
                        pointRadius: 0,
                        borderDash: [30,8],
                        borderWidth: 5,
                        spanGaps: true
                    },
                    {
                        label: 'Ветер',
                        data: windSpeedData,
                        fill: false,
                        backgroundColor: 'rgba(0, 110, 255, 0.2)',
                        borderColor: 'rgba(255,255,255,0.7)',
                        yAxisID: 'y_wind',
                        tension: 0.6,
                        pointRadius: 0,
                        borderWidth: 10,
                        borderDash: [50,8],
                        spanGaps: true
                    },
                    {
                        label: 'Влажность (%)',
                        data: humidityData,
                        borderColor: '#55ccff99',
                        backgroundColor: 'rgba(85,204,255,0.1)',
                        yAxisID: 'y_humidity',
                        tension: 0.4,
                        pointRadius: 0,
                        borderWidth: 6,
                        spanGaps: true
                    },
                    {
                        label: 'Давление (мм)',
                        data: pressureData,
                        borderColor: '#31e378',
                        backgroundColor: 'rgba(255,255,136,0.1)',
                        yAxisID: 'y_pressure',
                        tension: 0.4,
                        pointRadius: 0,
                        borderWidth: 11,
                        spanGaps: true
                    },
                    {
                        label: 'Осадки (%)',
                        data: precipData,
                        borderColor: '#5ceefbff',
                        fill: true,
                        backgroundColor: 'rgba(0, 110, 255, 0.2)',
                        yAxisID: 'y_precip',
                        tension: 0.4,
                        pointRadius: 0,
                        borderDash: [12,9],
                        borderWidth: 7,
                        spanGaps: true
                    }
                ]
            },
            options: {
                responsive: false,
                maintainAspectRatio: false,
                animation: false,
                devicePixelRatio: (window.devicePixelRatio || 1) * DPR_MULTIPLIER,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        position: 'top',
                        grid: { color: '#ffffff33', lineWidth: 1, drawOnChartArea: true, drawTicks: false },
                        // ticks: { font: { size: FONT_SIZE }, maxRotation: 60, minRotation: 60, autoSkip: false }
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
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { font: { size: FONT_SIZE  }, color: '#55ccff', padding: 0 }
                    },
                    y_precip: {
                        type: 'linear', display: true, position: 'right', min: 0, max: 100, offset: true,
                        grid: { drawOnChartArea: false, lineWidth: 1 }, ticks: { font: { size: FONT_SIZE * 0}, color: '#a0ffef', padding: -1 } }
                }
            },
            plugins: [customXAxisPlugin]
        });

        window._weatherChartDrawing = false;
    }).fail(() => { 
        console.error('Не удалось загрузить данные погоды'); 
        window._weatherChartDrawing = false;
    });
}

$(document).on('panelTempRangeChange', function(e) {
    if (e.panel === 'weather_panel') {
        drawWeatherChart();
    }
});

// Слушатель изменения диапазона температур
$(document).on('weatherTempRangeChange', function(e, min, max) {
    console.log('[Weather] Диапазон изменён:', min, max);
    drawWeatherChart();
});

// Слушатель ресайза панелей - перерисовать график с правильным DPI
$(document).on('weatherChartResize', function() {
    console.log('[Weather] Panel resized, redrawing chart');
    drawWeatherChart();
});
