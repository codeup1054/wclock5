/**
 * ticker_charts_plugin.js
 * Плагин Chart.js для отображения отдельных тикеров с собственными осями Y.
 */

(function(window) {
    'use strict';

    const TickerChartsPlugin = {
        id: 'tickerCharts',

        // Сохраняем ссылки на данные между вызовами
        _data: null,

        // Устанавливаем данные извне
        setData(data) {
            this._data = data;
        },

        beforeInit(chart) {
            // Можно инициализировать что-то до создания графика
        },

        beforeUpdate(chart, args, options) {
            try {
                if (!this._data || !Array.isArray(this._data.datasets)) return;

                const { datasets } = this._data;
                const mainDataset = datasets[0]; // Основной портфель
                if (!mainDataset) return;

                // Извлекаем только тикер-датасеты (пропускаем основной)
                const tickerDatasets = datasets.slice(1);
                if (tickerDatasets.length === 0) return;

                // Настройка осей Y
                const yAxes = {};
                
                // Сохраняем существующую ось y если она есть
                if (chart.options?.scales?.y) {
                    yAxes.y = chart.options.scales.y;
                } else {
                    yAxes.y = {
                        position: 'left',
                        beginAtZero: false,
                        ticks: {
                            callback: (value) => {
                                if (value >= 1e6) return '₽' + (value / 1e6).toFixed(2) + 'M';
                                return '₽' + Number(value).toLocaleString('ru-RU');
                            },
                            font: { size: 20 }
                        },
                        grid: {
                            color: 'rgba(0,100, 255, 0.3)',
                            lineWidth: 1
                        }
                    };
                }

                // Добавляем ось для каждого тикера
                tickerDatasets.forEach((dataset, idx) => {
                    const axisId = `y_ticker_${idx + 1}`;
                    
                    yAxes[axisId] = {
                        type: 'linear',
                        position: idx % 2 === 0 ? 'right' : 'left',
                        beginAtZero: false,
                        suggestedMin: 0,
                        ticks: {
                            callback: (value) => Number(value).toLocaleString('ru-RU'),
                            font: { size: 14 },
                            color: dataset.borderColor || '#FFD700'
                        },
                        grid: {
                            display: false
                        },
                        title: {
                            display: true,
                            text: dataset.label?.replace(/, ₽$/, '') || `Ticker ${idx + 1}`,
                            font: { size: 12 },
                            color: dataset.borderColor || '#FFD700'
                        }
                    };
                    
                    // Привязываем датасет к своей оси
                    dataset.yAxisID = axisId;
                });

                // Обновляем конфиг графика
                chart.options.scales = { ...chart.options.scales, ...yAxes };
                chart.data.datasets = [mainDataset, ...tickerDatasets];
                
                console.log('[TickerChartsPlugin] ✅ Добавлено тикеров:', tickerDatasets.length);
            } catch (e) {
                console.error('[TickerChartsPlugin] ❌ Ошибка:', e.message);
                // Не ломаем основной график - просто пропускаем
            }
        }
    };

    // Экспорт (без авто-регистрации)
    window.TickerChartsPlugin = TickerChartsPlugin;

    // НЕ регистрируем глобально - применяем только явно в invest_chart.js

})(window);