// invest_chart_banner.js — модуль отображения капитала и распределения на графике
(function(window) {
    'use strict';

    // Константы для стилизации
    const COLORS = {
        background: 'rgba(0, 0, 0, 0.1)',
        border: 'rgba(50, 50, 50, 0.7)',
        shadow: 'rgba(0, 0, 0, 0.6)',
        capital: '#8d9d9d',
        positive: '#2ecc71',
        negative: '#e74c3c',
        time: '#7eb1c7',
        ticker: '#ddd',
        rubTicker: '#888',
        percent: '#dddddd',
        barBackground: 'rgba(100, 100, 100, 0.5)',
        barHigh: '#4CAF50',
        barLow: '#FFC107',
        assetColors: ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e']
    };

    const IS_BAR = true;

    const SIZES = {
        bannerWidth: 600,
        rowHeight: 36,
        barWidth: 80,
        barHeight: 8,
        offsetX: 30,
        offsetY: 20
    };

    // Глобальные данные баннера
    window.ChartBannerData = {
        capital: 0,
        absChange: 0,
        pctChange: 0,
        absChangeWeek: 0,
        pctChangeWeek: 0,
        assets: [],
        updateTime: new Date(),
        tgoldData: null
    };

    // Форматирование чисел
    const formatters = {
        currency: value => value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
        quantity: value => value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
        change: value => `${value >= 0 ? '+' : ''}${formatters.currency(Math.abs(value))}`,
        percent: value => `${value >= 0 ? '+' : '- '}${Math.abs(value).toFixed(2)}%`,
        time: date => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    // Расчет данных по активам
    function getAssetsData(positions) {
        if (!Array.isArray(positions) || positions.length === 0) return [];

        const totalValue = positions.reduce((sum, p) => sum + (p.value || 0), 0);
        
        return positions
            .map(p => ({
                ticker: p.name?.slice(0, 4) || '???',
                quantity: p.quantity || 0,
                value: p.value || 0,
                percent: totalValue > 0 ? ((p.value || 0) / totalValue) * 100 : 0
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5);
    }

    // Плагин для Chart.js
    window.ChartBannerPlugin = {
        id: 'chartBanner',
        
        afterDraw(chart) {
            // Only draw on main chart, not on separate banner canvas
            const { ctx, chartArea } = chart;
            const { top, left, bottom, right } = chartArea;
            const data = window.ChartBannerData;
            if (!data || !data.assets || !data.assets.length) return;
            
            const { capital, absChange, pctChange, absChangeWeek, pctChangeWeek, assets, updateTime } = data;
            
            ctx.save();
            this.drawBannerBackground(ctx, right, bottom, assets.length);
            this.drawTime(ctx, right, top, bottom);
            this.drawAssets(ctx, right, bottom, assets);
            this.drawCapitalAndChange(ctx, top, right, bottom, left, capital, absChange, pctChange, absChangeWeek, pctChangeWeek, assets.length);
            ctx.restore();
        },

        drawBannerBackground(ctx, right, bottom, assetsCount) {
            const bannerHeight = Math.min(assetsCount * SIZES.rowHeight + 200, 250);
            const bannerY = bottom - SIZES.offsetY - bannerHeight + 190;
            const bannerX = right - SIZES.bannerWidth - SIZES.offsetX;
            
            ctx.fillStyle = COLORS.background;
            ctx.beginPath();
            ctx.roundRect(bannerX, bannerY, SIZES.bannerWidth, bannerHeight, 20);
            ctx.fill();
            
            ctx.strokeStyle = COLORS.border;
            ctx.lineWidth = 1;
            ctx.stroke();
        },

        drawTime(ctx, right, top, bottom) {
            ctx.font = '60px monospace';
            ctx.fillStyle = COLORS.time;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            // ctx.fillText(formatters.time(window.ChartBannerData.updateTime), 20 , bottom - 10);
        },

        drawAssets(ctx, right, bottom, assets) {
            if (!assets || !assets.length) {
                // console.log('[ChartBannerPlugin] drawAssets: no assets');
                return;
            }
            
            // console.log('[ChartBannerPlugin] drawAssets: rendering', assets.length, 'assets');
            
            const tab_padding = -20;
            const col = right;

            if (IS_BAR) {
                const maxBarWidth = 560;
                const barY = bottom + 10;
                const barHeight = SIZES.rowHeight - 7;

                assets.forEach((asset, index) => {
                    const currentY = barY - index * SIZES.rowHeight;
                    const barWidth = (asset.percent / 100) * maxBarWidth;
                    
                    let color = COLORS.assetColors[index % COLORS.assetColors.length];
                    if (asset.ticker.includes('TGLD')) {
                        color = '#ffb700';
                    }
                    if (asset.ticker.includes('RUB')) {
                        color = '#26aa71';
                    }
                    ctx.fillStyle = COLORS.barBackground;
                    ctx.beginPath();
                    ctx.roundRect(right - maxBarWidth - 40, currentY - barHeight / 2, maxBarWidth, barHeight, 4);
                    ctx.fill();

                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.roundRect(right - maxBarWidth - 40, currentY - barHeight / 2, barWidth, barHeight, 4);
                    ctx.fill();

                    ctx.font = '24px helvetica';
                    ctx.fillStyle = COLORS.ticker;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(asset.ticker, right - maxBarWidth + 152, currentY+2);

                    ctx.font = '24px helvetica';
                    ctx.textAlign = 'right';
                    const valueText = `${formatters.currency(asset.value)} ₽`;
                    const percentText = `${asset.percent.toFixed(1)}%`;
                    ctx.fillText(valueText + '  ' + percentText, right - 40, currentY);
                });
            } else {
                let currentY = bottom + 10;
                ctx.font = '32px helvetica';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';

                assets.forEach(asset => {
                    ctx.fillStyle = asset.ticker.includes('RUB') ? COLORS.rubTicker : COLORS.ticker;
                    ctx.fillText(asset.ticker, col + tab_padding*2, currentY);
                    ctx.fillText(`${formatters.currency(asset.value)} ₽`, col + tab_padding*7, currentY);
                    ctx.fillText(`${asset.percent.toFixed(0)}%`, col + tab_padding*17, currentY);
                    currentY -= SIZES.rowHeight;
                });
            }
        },
        
        drawCapitalAndChange(ctx, top, right, bottom, left, capital, absChange, pctChange, absChangeWeek, pctChangeWeek, assetsCount) {
            let currentY = bottom - 40;
            ctx.font = '130px helvetica';
            ctx.fillStyle = COLORS.capital;
            ctx.textAlign = 'right';
            currentY -= (assetsCount * SIZES.rowHeight - 0);
            ctx.fillText(`${formatters.currency(capital)}`, right - SIZES.offsetX - 16, currentY);
            
            currentY -= 20;
            ctx.font = '40px helvetica';
            ctx.fillStyle = absChange >= 0 ? COLORS.positive : COLORS.negative;
            ctx.textAlign = 'right';
            ctx.fillText(`${formatters.change(absChange)} ${formatters.percent(pctChange)}`, 
                       right - SIZES.offsetX - 16,
                       currentY - assetsCount * SIZES.rowHeight);

            currentY -= 42;
            ctx.font = '40px helvetica';
            ctx.fillStyle = absChangeWeek >= 0 ? COLORS.positive : COLORS.negative;
            ctx.textAlign = 'right';
            ctx.fillText(`7д: ${formatters.change(absChangeWeek)} ${formatters.percent(pctChangeWeek)}`,
                       right - SIZES.offsetX - 16,
                       currentY - assetsCount * SIZES.rowHeight);

            // Рисуем TGLD@ данные (одной строкой)
            if (window.ChartBannerData && window.ChartBannerData.tgoldData) {
                const tgold = window.ChartBannerData.tgoldData;
                const dayPct = (tgold.day_change_pct || 0).toFixed(2);
                const weekPct = (tgold.week_change_pct || 0).toFixed(2);
                const daySign = (tgold.day_change || 0) >= 0 ? '+' : '';
                const weekSign = (tgold.week_change || 0) >= 0 ? '+' : '';
                
                currentY -= 50;
                
                // Одна строка: цена TGLD@ + дневной + недельный прирост
                ctx.font = '36px helvetica';
                ctx.fillStyle = '#FFD700';
                ctx.textAlign = 'right';
                ctx.fillText(`${(tgold.current_price || 0).toFixed(2)}  Д: ${daySign}${dayPct}%  Н: ${weekSign}${weekPct}%`, 
                           right - SIZES.offsetX - 16,
                           currentY - assetsCount * SIZES.rowHeight);
            }
        },

        drawBannerOnCanvas(ctx, w, h, capital, absChange, pctChange, absChangeWeek, pctChangeWeek, assets) {
            const padding = 10;
            const bannerW = w - padding * 2;
            const bannerH = h - padding * 2;
            
            // Skip drawing internal background/border - panel already has its own border
            
            const contentX = w - padding - 20;
            let currentY = h - padding - 20;
            
            
            // currentY -= 40;
            ctx.textAlign = 'left';
            ctx.font = '21px helvetica';
            ctx.fillStyle = absChange >= 0 ? COLORS.positive : COLORS.negative;
            ctx.fillText(`${formatters.percent(pctChange)} ${formatters.change(absChange)} `, 30, currentY);
            
            currentY -= 30;
            ctx.font = '21px helvetica';
            ctx.fillStyle = absChangeWeek >= 0 ? COLORS.positive : COLORS.negative;
            ctx.fillText(`${formatters.percent(pctChangeWeek)} ${formatters.change(absChangeWeek)} `, 30, currentY);
            
            console.log("`tgold`", window.ChartBannerData?.tgoldData, contentX, currentY);
            
            if (window.ChartBannerData && window.ChartBannerData.tgoldData) {
                const tgold = window.ChartBannerData.tgoldData;
                const dayPct = (tgold.day_change_pct || 0).toFixed(2);
                const weekPct = (tgold.week_change_pct || 0).toFixed(2);
                
                currentY -= 30;
                ctx.font = '21px helvetica';
                ctx.fillStyle = '#FFD700';
                
                ctx.fillText(`${formatters.percent(dayPct)}  w: ${formatters.percent(weekPct)} ${(tgold.current_price || 0).toFixed(2)} `,30, currentY);
            }
            
            currentY -= 32;

            ctx.font = '70px helvetica';
            ctx.fillStyle = COLORS.capital;
            ctx.textAlign = 'left';
            ctx.fillText(formatters.currency(capital), 30, currentY);

            currentY -= 75;

            const maxBarWidth = bannerW - 30;
            const barX = padding + 20;
            const barHeight = 14;
            

            assets.forEach((asset, index) => {
                const currentBarY = currentY  - index * (barHeight+3);
                const barWidth = (asset.percent / 100) * maxBarWidth;
                
                let color = COLORS.assetColors[index % COLORS.assetColors.length];
                if (asset.ticker.includes('TGLD')) color = '#ffb700';
                if (asset.ticker.includes('RUB')) color = '#26aa71';
                
                ctx.fillStyle = COLORS.barBackground;
                ctx.beginPath();
                ctx.roundRect(barX, currentBarY, maxBarWidth, barHeight, 4);
                ctx.fill();
                
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.roundRect(barX, currentBarY, barWidth, barHeight, 4);
                ctx.fill();
                
                ctx.font = '12px helvetica';
                ctx.fillStyle = COLORS.ticker;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(asset.ticker, barX + 5, currentBarY + barHeight / 2);
                
                ctx.textAlign = 'right';
                ctx.fillText(`${formatters.currency(asset.value)} ₽  ${asset.percent.toFixed(1)}%`, barX + maxBarWidth - 5, currentBarY + barHeight / 2);
            });
        }
    };

    // Standalone render function for invest_panel_banner canvas
    window.renderInvestBanner = function() {
        const overlay = document.getElementById('investBanner');
        if (!overlay) return;
        
        const ctx = overlay.getContext('2d');
        if (!ctx) return;
        
        const w = overlay.clientWidth;
        const h = overlay.clientHeight;
        if (!w || !h || w < 10 || h < 10) return;
        
        const dpr = window.devicePixelRatio || 1;
        overlay.width = w * dpr;
        overlay.height = h * dpr;
        ctx.scale(dpr, dpr);
        
        ctx.clearRect(0, 0, w, h);
        
        const data = window.ChartBannerData;
        if (!data || !data.assets || !data.assets.length) {
            ctx.fillStyle = '#888';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Загрузка...', w/2, h/2);
            return;
        }
        
        const plugin = window.ChartBannerPlugin;
        if (plugin && plugin.drawBannerOnCanvas) {
            plugin.drawBannerOnCanvas(ctx, w, h, data.capital, data.absChange, data.pctChange, data.absChangeWeek, data.pctChangeWeek, data.assets);
        }
    };

    // Обновление данных баннера
    window.updateInvestBannerData = function(historyData) {
        if (!historyData || Object.keys(historyData).length === 0) return null;

        const timestamps = Object.keys(historyData).sort();
        if (timestamps.length === 0) return null;

        // Последний снимок — текущее состояние
        const latestTs = timestamps[timestamps.length - 1];
        const latestPositions = historyData[latestTs]; // ← Это уже массив!
        const currentTotal = Array.isArray(latestPositions)
            ? latestPositions.reduce((sum, p) => sum + (p.value || 0), 0)
            : 0;

        // Базовое значение (на начало дня)
        const baselineTotal = calculateBaselineTotal(historyData, timestamps);
        const baselineWeekTotal = calculateWeekBaselineTotal(historyData, timestamps);
        
        const absChange = currentTotal - baselineTotal;
        const pctChange = baselineTotal !== 0 ? (absChange / baselineTotal * 100) : 0;
        const absChangeWeek = currentTotal - baselineWeekTotal;
        const pctChangeWeek = baselineWeekTotal !== 0 ? (absChangeWeek / baselineWeekTotal * 100) : 0;
        
        return {
            capital: currentTotal,
            absChange: absChange,
            pctChange: pctChange,
            absChangeWeek: absChangeWeek,
            pctChangeWeek: pctChangeWeek,
            assets: getAssetsData(latestPositions),
            updateTime: new Date()
        };
    };

    // Расчет базового значения (первый снимок сегодня)
    function calculateBaselineTotal(historyData, timestamps) {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Ищем первый снимок сегодня
        for (const ts of timestamps) {
            const entry = historyData[ts];
            if (new Date(ts) >= todayStart && Array.isArray(entry) && entry.length > 0) {
                return entry.reduce((sum, p) => sum + (p.value || 0), 0);
            }
        }
        
        // Если нет — ищем последний снимок вчера
        const yesterdayEnd = new Date(todayStart.getTime() - 1);
        for (let i = timestamps.length - 1; i >= 0; i--) {
            const entry = historyData[timestamps[i]];
            if (new Date(timestamps[i]) <= yesterdayEnd && Array.isArray(entry) && entry.length > 0) {
                return entry.reduce((sum, p) => sum + (p.value || 0), 0);
            }
        }
        
        // Фоллбек: самый ранний снимок
        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry)
            ? firstEntry.reduce((sum, p) => sum + (p.value || 0), 0)
            : 0;
    }

    // База за неделю
    function calculateWeekBaselineTotal(historyData, timestamps) {
        const now = new Date();
        const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);

        for (const ts of timestamps) {
            const entry = historyData[ts];
            if (new Date(ts) >= weekAgo && Array.isArray(entry) && entry.length > 0) {
                return entry.reduce((sum, p) => sum + (p.value || 0), 0);
            }
        }

        // Фоллбек: самый ранний снимок
        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry)
            ? firstEntry.reduce((sum, p) => sum + (p.value || 0), 0)
            : 0;
    }

    // Загрузка данных TGLD@
    window.loadTgoldData = function(callback) {
        $.getJSON('/api/invest/ticker/TGLD@')
            .done(function(data) {
                if (data && !data.error) {
                    window.ChartBannerData.tgoldData = data;
                    if (callback) callback(data);
                    setTimeout(window.renderInvestBanner, 100);
                } else {
                    console.warn('[TGLD@] Нет данных:', data?.error);
                }
            })
            .fail(function(err) {
                console.error('[TGLD@] Ошибка загрузки:', err);
            });
    };

    // Обновление данных TGLD@ при инициализации
    if (typeof $ !== 'undefined') {
        $(document).ready(function() {
            window.loadTgoldData();
            // Рендер баннера при загрузке
            setTimeout(window.renderInvestBanner, 500);
            // Обновляем каждые 5 минут
            setInterval(function() {
                window.loadTgoldData();
            }, 300000);
        });
    }

    // Auto-render wrapper - call renderInvestBanner when data is updated
    (function() {
        const originalUpdate = window.updateInvestBannerData;
        if (originalUpdate) {
            window.updateInvestBannerData = function(historyData) {
                const result = originalUpdate.apply(this, arguments);
                if (result) {
                    const savedTgold = window.ChartBannerData?.tgoldData;
                    window.ChartBannerData = result;
                    window.ChartBannerData.tgoldData = savedTgold || null;
                    setTimeout(window.renderInvestBanner, 100);
                }
                return result;
            };
        }
    })();

})(window);
