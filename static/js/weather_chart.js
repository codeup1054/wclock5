function drawWeatherChart() {
    if (window._weatherChartDrawing) return;
    window._weatherChartDrawing = true;
    
    const canvas = document.getElementById('weatherChart');
    if (!canvas) {
        window._weatherChartDrawing = false;
        return;
    }
    
    destroyChartSafe(canvas);
    
    const FONT_SIZE = 24;
    let tempRange = [-15, 25];
    try {
        tempRange = JSON.parse(localStorage.getItem('weather_panel_range')) || [-15, 25];
    } catch (e) {}
    const tempMin = tempRange[0];
    const tempMax = tempRange[1];

    const pressMin = 720 ;
    const pressMax = 770;

    const windMin = -2.27
    const windMax = 6

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


        log(['closestIndex:', closestIndex, 'prevIndex:', prevIndex, 'now:', (now-prevDate)/1000/120, 'prevDate:', prevDate ]);

        // "now" line plugin
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
                

                // log(['closestIndex:', closestIndex, 'prevIndex:', prevIndex, 'now:', (nowTime - prevDate) / 1000 / 120, 'prevDate:', prevDate]);


                ctx.save();
                
                // --- horizontal 0°C temp line ---
                const yTemp0 = scales.y_temp.getPixelForValue(0);
                ctx.strokeStyle = '#ff5900ff'; // цвет линии температуры
                ctx.lineWidth = 5;
                ctx.setLineDash([63, 4]);
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yTemp0);
                ctx.lineTo(chart.chartArea.right, yTemp0);
                ctx.stroke();

                // --- horizontal 0 wind line ---
                const yWind0 = scales.y_wind.getPixelForValue(0);
                ctx.strokeStyle = '#ffffffaa'; // цвет линии ветра
                ctx.lineWidth = 4;
                ctx.setLineDash([60, 7]);
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yWind0);
                ctx.lineTo(chart.chartArea.right, yWind0);
                ctx.stroke();

                // --- vertical "now" line ---
                const xNow = scales.x.getPixelForTick(closestIndex - 1 ) + ratio * (scales.x.getPixelForTick(closestIndex) - scales.x.getPixelForTick(prevIndex));
                ctx.strokeStyle = '#ffc941ff';
                ctx.lineWidth = 3;
                ctx.setLineDash([32, 6]);
                ctx.beginPath();
                ctx.moveTo(xNow, chart.chartArea.top);
                ctx.lineTo(xNow, yWind0);
                ctx.stroke();

                // --- vertical forecast line (5 steps ahead) ---
                const xForecast = scales.x.getPixelForTick(closestIndex + 5);
                ctx.strokeStyle = '#ffc531ff';
                ctx.lineWidth = 3;
                ctx.setLineDash([12, 3]);
                ctx.beginPath();
                ctx.moveTo(xForecast, chart.chartArea.top);
                ctx.lineTo(xForecast, yWind0);
                ctx.stroke();



                
                // --- X labels with 60° rotation ---
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
                devicePixelRatio: 1,
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
        console.error('Failed to load weather data'); 
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
    console.log('[Weather] Temp range changed:', min, max);
    drawWeatherChart();
});

let _lastWeatherSize = { w: 0, h: 0 };

$(document).on('weatherChartResize', function() {
    const canvas = document.getElementById('weatherChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w === _lastWeatherSize.w && h === _lastWeatherSize.h) return;
    _lastWeatherSize = { w, h };
    drawWeatherChart();
});
