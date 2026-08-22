
/**
 * Sends battery level to server
 * Called independently of chart visibility
 */
window.sendBatteryLevel = function sendBatteryLevel() {
    const dfd = $.Deferred();
    const deviceId = getOrCreateDeviceId();

    if (!navigator.getBattery) {
        dfd.resolve();
        return dfd.promise();
    }

    navigator.getBattery().then(battery => {
        const level = Math.round(battery.level * 100);
        $.ajax({
            url: '/api/battery',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ device_id_local: deviceId, value: level }),
        }).done(() => dfd.resolve()).fail(xhr => {
            console.warn('Battery send error:', xhr.responseText || xhr.statusText);
            dfd.reject(xhr);
        });
    }).catch(err => {
        console.warn('navigator.getBattery unavailable:', err);
        dfd.resolve();
    });

    return dfd.promise();
};

/**
 * Renders battery chart
 * Called on switch to battery chart view
 */
function batteryLevel() {
    const deviceId = getOrCreateDeviceId();
        const renderChart = (level) => {
        const currentInterval = window.currentInterval || 'hour';
        const batteryPeriod = getSetting('battery_chart_period', '-7 day');
        
        $.getJSON(`/api/battery?device_id_local=${deviceId}&interval=${currentInterval}&period=${encodeURIComponent(batteryPeriod)}`)
                .done(dataArray => {
                    const labels = [];
                    const values = [];
                    const timestamps = [];

                    dataArray.reverse().forEach(e => {
                        const dt = new Date(e.datetime || e.timestamp);
                        labels.push(isNaN(dt) ? 'N/A' : dt.toLocaleDateString([], { day: '2-digit' }));
                        values.push(Number(e.battery_level ?? 0));
                        timestamps.push(dt);
                    });

                    const canvas = document.getElementById('volumeChart');
                    if (!canvas) return logg("⚠️ Canvas #volumeChart не найден");

                    const ctx = canvas.getContext('2d');
                    if (window.batteryChart) window.batteryChart.destroy();

                    function findExtrema(values, labels) {
                        const extrema = [];
                        const n = values.length;
                        if (n === 0) return extrema;

                        const dayMap = {};
                        for (let i = 0; i < n; i++) {
                            const day = labels[i];
                            if (!dayMap[day]) dayMap[day] = { maxIdx: i, minIdx: i, maxVal: values[i], minVal: values[i] };
                            else {
                                if (values[i] > dayMap[day].maxVal) { dayMap[day].maxVal = values[i]; dayMap[day].maxIdx = i; }
                                if (values[i] < dayMap[day].minVal) { dayMap[day].minVal = values[i]; dayMap[day].minIdx = i; }
                            }
                        }

                        Object.keys(dayMap).forEach(day => {
                            const d = dayMap[day];
                            extrema.push({ type: 'max', index: d.maxIdx, value: d.maxVal, label: day });
                            extrema.push({ type: 'min', index: d.minIdx, value: d.minVal, label: day });
                        });

                        return extrema;
                    }


                    const extrema = findExtrema(values, labels);

                    // Custom plugin for day labels inside chart at y=25
                    const dayLabelPlugin = {
                        id: 'dayLabels',
                        afterDatasetsDraw(chart) {
                            const { ctx, scales } = chart;
                            const xScale = scales.x;
                            const yScale = scales.y;
                            const labels = chart.data.labels;
                            const shown = new Set();
                            const targetY = yScale.getPixelForValue(25);

                            ctx.save();
                            ctx.font = 'bold 10px sans-serif';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';

                            labels.forEach((label, idx) => {
                                if (!label || label === 'N/A') return;
                                if (shown.has(label)) return;
                                shown.add(label);
                                const x = xScale.getPixelForValue(idx);
                                ctx.fillText(label, x, targetY);
                            });

                            ctx.restore();
                        }
                    };

                    // Custom plugin for drawing extrema labels
                    const extremaPlugin = {
                        id: 'extremaLabels',
                        afterDatasetsDraw(chart, args, options) {
                            const { ctx, chartArea: { top, bottom, left, right }, scales } = chart;
                            const xScale = scales.x;
                            const yScale = scales.y;

                            // Get data from first dataset
                            const values = chart.data.datasets[0].data;
                            const extrema = findExtrema(values, chart.data.labels);

                            ctx.save();
                            ctx.font = 'bold 14px sans-serif';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'bottom';

                            extrema.forEach(ext => {
                                const x = xScale.getPixelForValue(ext.index);
                                const y = yScale.getPixelForValue(ext.value);

                                const offsetY = ext.type === 'max' ? 0 : 25;

                                ctx.fillStyle = 'rgba(194, 161, 30, 1)';

                                const text = `${Math.round(ext.value)}`;
                                ctx.fillText(text, x, y + offsetY);
                            });

                            ctx.restore();
                        }
                    };

                    // Prepare plugin list (dayLabel + extrema + midnight if available)
                    const plugins = [dayLabelPlugin, extremaPlugin];
                    if (window.MidnightLinesPlugin) {
                        try {
                            const midnightPlugin = window.initChartPlugin(window.MidnightLinesPlugin(timestamps,0.70), { enabled: true });
                            if (midnightPlugin) plugins.push(midnightPlugin);
                        } catch (e) {
                            console.error('[BatteryChart] ❌ Ошибка инициализации MidnightLinesPlugin:', e);
                        }
                    }

                    window.batteryChart = new Chart(ctx, {
                        type: 'line',
                        plugins: plugins,
                        data: {
                            labels,
                            datasets: [{
                                data: values,
                                borderColor: '#FFB74D',
                                backgroundColor: 'rgba(255,183,77,0.12)',
                                borderWidth: 0.7,
                                tension: chartTension(0.3),
                                pointRadius: 0,
                                fill: true
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            devicePixelRatio: Math.min(parseFloat(getSetting('chart_dpi', '2')) || 2, 6.0) * (window.devicePixelRatio || 1),
                            plugins: {
                                legend: { display: false },
                                tooltip: { enabled: false },
                             annotation: {
                                annotations: {
                                    level: {
                                        type: 'box',
                                        yMin: 35,
                                        yMax: 55,
                                        backgroundColor: 'rgba(20, 59, 150, 0.5)',
                                        borderColor: 'rgba(236, 48, 6, 0.9)',
                                        borderWidth: 3,
                                        borderDash: [17, 7],
                                        drawTime: 'beforeDatasetsDraw'
                                        }
                                }
                            }
                        },
                            scales: {
                                y: {
                                    min: 0,
                                    max: 105,
                                    ticks: { stepSize: 25, font: { size: 12 } },
                                    grid: { color: '#ffffff33', lineWidth: 1 }
                                },
                                x: {
                                    ticks: {
                                        font: { size: 8 },
                                        callback: () => ''
                                    }
                                }
                            }
                        }
                    });

                })
                .fail(xhr => {
                    console.warn(`⚠️ Ошибка загрузки истории: ${xhr.responseText || xhr.statusText}`);
                });
    };

    // Get battery level for chart render
    if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
            const level = Math.round(battery.level * 100);
            renderChart(level);
        }).catch(err => {
            console.warn("navigator.getBattery unavailable:", err);
            renderChart(50);
        });
    } else {
        renderChart(50);
    }
    
    if (typeof updateToggleButtonText === 'function') updateToggleButtonText();
}

window.initBatteryUI = function initBatteryUI() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
        const updateBatteryDiv = () => {
            const level = Math.round(battery.level * 100);
            const charging = battery.charging;
            const text = (charging ? '⚡' : '') + level + '%';
            
            const $el = $('#battery');
            const $panelEl = $('#battery_indicator_panel');
            const $fill = $('#battery_fill');
            const $text = $('#battery_text');
            
            $el.text(text);
            $text.text(text);
            $fill.css('width', level + '%');
            
            $panelEl.removeClass('battery-low battery-medium battery-high');
            
            if (level < 25) {
                $el.addClass('battery-low');
                $panelEl.addClass('battery-low');
            }
            else if (level < 55) {
                $el.addClass('battery-medium');
                $panelEl.addClass('battery-medium');
            }
            else {
                $el.addClass('battery-high');
                $panelEl.addClass('battery-high');
            }
            if (typeof window.sendBatteryLevel === 'function') {
                window.sendBatteryLevel();
            }
        };
        updateBatteryDiv();
        battery.addEventListener('levelchange', updateBatteryDiv);
        battery.addEventListener('chargingchange', updateBatteryDiv);
    });
};

window.updateBatteryChart = function updateBatteryChart() {
    if (!window.batteryChart) {
        batteryLevel();
        return;
    }

    const deviceId = getOrCreateDeviceId();
    const currentInterval = window.currentInterval || 'hour';
    const batteryPeriod = getSetting('battery_chart_period', '-7 day');

    $.getJSON(`/api/battery?device_id_local=${deviceId}&interval=${currentInterval}&period=${encodeURIComponent(batteryPeriod)}`)
        .done(dataArray => {
            const labels = [];
            const values = [];

            dataArray.reverse().forEach(e => {
                const dt = new Date(e.datetime || e.timestamp);
                labels.push(isNaN(dt) ? 'N/A' : dt.toLocaleDateString([], { day: '2-digit' }));
                values.push(Number(e.battery_level ?? 0));
            });

            const chart = window.batteryChart;
            chart.data.labels = labels;
            chart.data.datasets[0].data = values;
            chart.update('none');
        })
        .fail(xhr => {
            console.warn(`⚠️ Ошибка обновления графика батареи: ${xhr.responseText || xhr.statusText}`);
        });
};
