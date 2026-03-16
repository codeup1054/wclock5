
// js/battery.js

/**
 * Отправляет уровень заряда батареи на сервер
 * Вызывается независимо от видимости графика
 */
window.sendBatteryLevel = function sendBatteryLevel() {
    const deviceId = getOrCreateDeviceId();
    
    // Получаем уровень батареи
    if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
            const level = Math.round(battery.level * 100);
            $.ajax({
                url: '/api/battery',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ device_id_local: deviceId, value: level }),
            })
            .done(() => {
                // logg(`🔋 Уровень ${level}% отправлен`);
            })
            .fail(xhr => {
                console.warn(`⚠️ Ошибка отправки уровня батареи: ${xhr.responseText || xhr.statusText}`);
            });
        }).catch(err => {
            console.warn("⚠️ navigator.getBattery недоступен:", err);
        });
    }
};

/**
 * Отрисовывает график батареи
 * Вызывается только при переключении на график батареи
 */
function batteryLevel() {
    const deviceId = getOrCreateDeviceId();
    // const deviceId ='mozilla50linuxuandro_mgj59o8h';

    const renderChart = (level) => {
        // 🔥 Уничтожаем график инвестиций
        if (window.InvestPlot && typeof window.InvestPlot.stop === 'function') {
            window.InvestPlot.stop();
        }
        
        const currentInterval = window.currentInterval || 'hour';
        
        $.getJSON(`/api/battery?device_id_local=${deviceId}&interval=${currentInterval}`)
                .done(dataArray => {
                    const labels = [];
                    const values = [];
                    const timestamps = [];

                    dataArray.reverse().forEach(e => {
                        const dt = new Date(e.datetime || e.timestamp);
                        labels.push(isNaN(dt) ? 'N/A' : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
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

                        for (let i = 1; i < n - 1; i++) {
                            const prev = values[i - 1];
                            const curr = values[i];
                            const next = values[i + 1];

                            // Локальный максимум
                            if (curr > prev && curr > next) {
                                extrema.push({ type: 'max', index: i, value: curr, label: labels[i] });
                            }
                            // Локальный минимум
                            else if (curr < prev && curr < next) {
                                extrema.push({ type: 'min', index: i, value: curr, label: labels[i] });
                            }
                        }

                        return extrema;
                    }


                    const extrema = findExtrema(values, labels);



                    // Создаём массив для точек экстремумов
                    const extremaPoints = Array(values.length).fill(null);
                    const extremaColors = [];

                    // Кастомный плагин для отрисовки меток экстремумов
                    const extremaPlugin = {
                        id: 'extremaLabels',
                        afterDatasetsDraw(chart, args, options) {
                            const { ctx, chartArea: { top, bottom, left, right }, scales } = chart;
                            const xScale = scales.x;
                            const yScale = scales.y;

                            // Получаем данные из первого датасета (основной график)
                            const values = chart.data.datasets[0].data;
                            const extrema = findExtrema(values, chart.data.labels);

                            ctx.save();
                            ctx.font = 'bold 24px sans-serif';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'bottom';

                            extrema.forEach(ext => {
                                const x = xScale.getPixelForValue(ext.index);
                                const y = yScale.getPixelForValue(ext.value);

                                // Смещаем текст немного вверх
                                const offsetY = ext.type === 'max' ? 0 : 25;

                                // Цвет: красный для максимума, зелёный для минимума
                                ctx.fillStyle = ext.type === 'max' ? 'rgba(194, 161, 30, 1)' : 'rgba(194, 161, 30, 1)';

                                // Текст: "87% ▲" или "42% ▼"
                                const text = `${Math.round(ext.value)}`; // % ${ext.type === 'max' ? '▲' : '▼'
                                ctx.fillText(text, x, y + offsetY);
                            });

                            ctx.restore();
                        }
                    };

                    // extrema.forEach(ext => {
                    //     extremaPoints[ext.index] = ext.value;
                    //     extremaColors.push(ext.type === 'max' ? '#ff0000' : '#00ff00'); // красный — макс, зелёный — мин
                    // });


                    // Подготовим список плагинов (extrema + midnight если доступен)
                    const plugins = [extremaPlugin];
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
                                borderColor: 'rgba(255, 204, 0, 1)',
                                backgroundColor: 'rgba(255,204,0,0.05)',
                                borderWidth: 5,
                                tension: 0.3,
                                pointRadius: 0,
                                fill: true
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
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
                                        borderWidth: 5,
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
                                    ticks: { stepSize: 25, font: { size: 20 } },
                                    grid: { color: '#ffffff33', lineWidth: 2 }
                                },
                                x: {
                                    ticks: { maxTicksLimit: 8, font: { size: 12 } }
                                }
                            }
                        }
                    });

                    // logg('📊 График батареи обновлён');
                })
                .fail(xhr => logg(`⚠️ Ошибка загрузки истории: ${xhr.responseText || xhr.statusText}`));
    };

    // 🪫 Получаем уровень батареи для отрисовки графика
    if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
            const level = Math.round(battery.level * 100);
            renderChart(level);
        }).catch(err => {
            console.warn("⚠️ navigator.getBattery недоступен:", err);
            renderChart(50); // fallback значение для отрисовки
        });
    } else {
        // fallback
        renderChart(50);
    }
    
    updateToggleButtonText();
}
