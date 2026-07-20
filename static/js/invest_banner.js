// static/js/invest_banner.js
// HTML-версия баннера (без Chart.js)
console.log("🚀 invest_banner.js загружен (HTML version)");

(function($) {
    'use strict';

    let tgoldData = null;

    const COLORS = {
        capital: '#8d9d9d',
        positive: '#2ecc71',
        negative: '#e74c3c',
        ticker: '#ddd',
        rubTicker: '#26aa71',
        tgold: '#FFD700',
        barBackground: 'rgba(100, 100, 100, 0.5)',
        assetColors: ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e']
    };

    function formatCurrency(value) {
        return value.toLocaleString('ru-RU', { 
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }

    function formatChange(value) {
        const sign = value >= 0 ? '+' : '';
        return `${sign}${formatCurrency(Math.abs(value))}`;
    }

    function formatPercent(value) {
        const sign = value >= 0 ? '+' : '';
        return `${sign}${Math.abs(value).toFixed(2)}%`;
    }

    function getAssetsData(positions) {
        if (!Array.isArray(positions) || positions.length === 0) return [];

        const totalValue = positions.reduce((sum, p) => sum + (p.value || 0), 0);
        
        return positions
            .map(p => ({
                ticker: p.name?.slice(0, 4) || '???',
                name: p.name || '???',
                quantity: p.quantity || 0,
                value: p.value || 0,
                percent: totalValue > 0 ? ((p.value || 0) / totalValue) * 100 : 0
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5);
    }

    function calculateBaselineTotal(historyData, timestamps) {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        for (const ts of timestamps) {
            const entry = historyData[ts];
            if (new Date(ts) >= todayStart && Array.isArray(entry) && entry.length > 0) {
                return entry.reduce((sum, p) => sum + (p.value || 0), 0);
            }
        }
        
        const yesterdayEnd = new Date(todayStart.getTime() - 1);
        for (let i = timestamps.length - 1; i >= 0; i--) {
            const entry = historyData[timestamps[i]];
            if (new Date(timestamps[i]) <= yesterdayEnd && Array.isArray(entry) && entry.length > 0) {
                return entry.reduce((sum, p) => sum + (p.value || 0), 0);
            }
        }
        
        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry)
            ? firstEntry.reduce((sum, p) => sum + (p.value || 0), 0)
            : 0;
    }

    function calculateWeekBaselineTotal(historyData, timestamps) {
        const now = new Date();
        const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);

        for (const ts of timestamps) {
            const entry = historyData[ts];
            if (new Date(ts) >= weekAgo && Array.isArray(entry) && entry.length > 0) {
                return entry.reduce((sum, p) => sum + (p.value || 0), 0);
            }
        }

        const firstEntry = historyData[timestamps[0]];
        return Array.isArray(firstEntry)
            ? firstEntry.reduce((sum, p) => sum + (p.value || 0), 0)
            : 0;
    }

    function loadTgoldData(callback) {
        $.getJSON('/api/invest/ticker/TGLD@')
            .done(function(data) {
                if (data && !data.error) {
                    tgoldData = data;
                    console.log('[InvestBanner] TGLD@ data loaded:', data);
                    if (callback) callback(data);
                } else {
                    console.warn('[InvestBanner] TGLD@: Нет данных:', data?.error);
                }
            })
            .fail(function(err) {
                console.error('[InvestBanner] TGLD@ Ошибка загрузки:', err);
            });
    }

    function renderBanner(historyData) {
        const $banner = $('#invest_banner');
        
        if (!historyData || Object.keys(historyData).length === 0) {
            $banner.html('<div class="banner-message">Нет данных</div>');
            return;
        }

        const timestamps = Object.keys(historyData).sort();
        if (timestamps.length === 0) {
            $banner.html('<div class="banner-message">Нет данных</div>');
            return;
        }

        const latestTs = timestamps[timestamps.length - 1];
        const latestPositions = historyData[latestTs];
        
        if (!Array.isArray(latestPositions) || latestPositions.length === 0) {
            $banner.html('<div class="banner-message">Нет позиций</div>');
            return;
        }

        const currentTotal = latestPositions.reduce((sum, p) => sum + (p.value || 0), 0);
        const baselineTotal = calculateBaselineTotal(historyData, timestamps);
        const baselineWeekTotal = calculateWeekBaselineTotal(historyData, timestamps);
        
        const absChange = currentTotal - baselineTotal;
        const pctChange = baselineTotal !== 0 ? (absChange / baselineTotal * 100) : 0;
        const absChangeWeek = currentTotal - baselineWeekTotal;
        const pctChangeWeek = baselineWeekTotal !== 0 ? (absChangeWeek / baselineWeekTotal * 100) : 0;

        const assets = getAssetsData(latestPositions);

        let html = '';

        // === CAPITAL ===
        const dayChangeClass = absChange >= 0 ? 'change-positive' : 'change-negative';
        const weekChangeClass = absChangeWeek >= 0 ? 'change-positive' : 'change-negative';

        html += `<div class="banner-capital">${formatCurrency(currentTotal)}</div>`;

        // === CHANGES ===
        html += `<div class="banner-changes">`;
        html += `<span class="${dayChangeClass}">Д: ${formatChange(absChange)} ${formatPercent(pctChange)}</span>`;
        html += `<span class="${weekChangeClass}">7д: ${formatChange(absChangeWeek)} ${formatPercent(pctChangeWeek)}</span>`;
        
        // === TGLD@ ===
        if (tgoldData) {
            const dayPct = (tgoldData.day_change_pct || 0).toFixed(2);
            const monthPct = (tgoldData.month_change_pct || 0).toFixed(2);
            const weekRow = document.getElementById('tgold-week-change');
            const daySign = (tgoldData.day_change || 0) >= 0 ? '+' : '';
            const monthSign = (tgoldData.month_change || 0) >= 0 ? '+' : '';
            html += `<span class="tgold-data">TGLD: ${(tgoldData.current_price || 0).toFixed(2)}  Д: ${daySign}${dayPct}%  М: ${monthSign}${monthPct}%</span>`;
        }
        html += `</div>`;

        // === ASSETS BARS ===
        if (assets.length > 0) {
            html += `<div class="banner-assets">`;
            
            assets.forEach((asset, index) => {
                let color = COLORS.assetColors[index % COLORS.assetColors.length];
                if (asset.ticker.includes('TGLD')) color = '#ffb700';
                if (asset.ticker.includes('RUB')) color = COLORS.rubTicker;

                html += `<div class="asset-row">`;
                html += `<div class="asset-info">`;
                html += `<span class="asset-ticker">${asset.ticker}</span>`;
                html += `<span class="asset-value">${formatCurrency(asset.value)} ₽</span>`;
                html += `<span class="asset-percent">${asset.percent.toFixed(1)}%</span>`;
                html += `</div>`;
                html += `<div class="asset-bar-container">`;
                html += `<div class="asset-bar-bg"></div>`;
                html += `<div class="asset-bar" style="width: ${asset.percent}%; background-color: ${color};"></div>`;
                html += `</div>`;
                html += `</div>`;
            });
            
            html += `</div>`;
        }

        $banner.html(html);
        console.log('[InvestBanner] Banner rendered, capital:', currentTotal, 'assets:', assets.length);
    }

    function updateInvestBanner() {
        console.log('[InvestBanner] updateInvestBanner called');
        
        const $banner = $('#invest_banner');
        
        loadTgoldData(function() {
            $.getJSON('/api/invest/history', function(historyData) {
                console.log('[InvestBanner] Data received, keys:', Object.keys(historyData).length);
                renderBanner(historyData);
            }).fail(function(xhr, status, error) {
                console.error('[InvestBanner] Ошибка загрузки истории:', status, error);
                $('#invest_banner').html('<div class="banner-message error">Ошибка загрузки</div>');
            });
        });
    }

    function init() {
        console.log('[InvestBanner] init called');
        
        loadTgoldData();
        updateInvestBanner();
    }

    // Принимает готовые данные (из invest_chart.js), без повторного fetch
    function renderFromData(historyData, tgoldPrices) {
        if (tgoldPrices && tgoldPrices.current_price) {
            tgoldData = tgoldPrices;
        }
        renderBanner(historyData);
    }

    $(document).ready(init);

    window.InvestBanner = {
        update: updateInvestBanner,
        renderFromData: renderFromData
    };

})(jQuery);
