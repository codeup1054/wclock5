// static/js/invest_banner.js
// HTML-версия баннера (без Chart.js)
console.log("🚀 invest_banner.js загружен (HTML version)");

(function($) {
    'use strict';

    let tickersData = {};

    const COLORS = {
        capital: '#8d9d9d',
        positive: '#1fc163',
        negative: '#e74c3c',
        ticker: '#ddd',
        rubTicker: '#1da067',
        tgold: '#FFD700',
        barBackground: 'rgba(100, 100, 100, 0.5)',
        assetColors: ['#3498db', '#e74c3c', '#1fc163', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e']
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

    function formatPrice(value) {
        return value.toFixed(2);
    }

    function getAssetsData(positions) {
        if (!Array.isArray(positions) || positions.length === 0) return [];

        const totalValue = positions.reduce((sum, p) => sum + (p.value || 0), 0);
        
        const ASSET_ORDER = ['TGLD', 'RUB', 'TMON'];
        const assetRank = function(t) {
            for (let i = 0; i < ASSET_ORDER.length; i++) {
                if (t.includes(ASSET_ORDER[i])) return i;
            }
            return -1;
        };
        
        return positions
            .map(p => ({
                ticker: p.name?.slice(0, 4) || '???',
                name: p.name || '???',
                quantity: p.quantity || 0,
                value: p.value || 0,
                percent: totalValue > 0 ? ((p.value || 0) / totalValue) * 100 : 0
            }))
            .sort((a, b) => {
                const ia = assetRank(a.ticker);
                const ib = assetRank(b.ticker);
                if (ia !== -1 && ib !== -1) return ia - ib;
                if (ia !== -1) return -1;
                if (ib !== -1) return 1;
                return b.value - a.value;
            })
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

    function loadTickersData(callback) {
        $.getJSON('/api/invest/tickers')
            .done(function(data) {
                if (data && !data.error) {
                    tickersData = data;
                    console.log('[InvestBanner] Tickers loaded:', Object.keys(data));
                } else {
                    console.warn('[InvestBanner] Tickers: no data');
                }
            })
            .fail(function(err) {
                console.error('[InvestBanner] Tickers error:', err);
            })
            .always(function() {
                if (callback) callback();
            });
    }

    function renderAssetRow(ticker, color, label) {
        const t = tickersData[ticker];
        if (!t) return '';
        const price = t.current_price || 0;
        const dayPct = t.day_change_pct || 0;
        const monthPct = t.month_change_pct || 0;
        const dayClass = dayPct >= 0 ? 'change-positive' : 'change-negative';
        const monthClass = monthPct >= 0 ? 'change-positive' : 'change-negative';

        return `<tr>
            <td class="banner-td-num" style="color:${color}">${formatPrice(price)}</td>
            <td class="banner-td-pct ${dayClass}">${formatPercent(dayPct)}</td>
            <td class="banner-td-empty"></td>
            <td class="banner-td-pct ${monthClass}">${formatPercent(monthPct)}</td>
        </tr>`;
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
        html += `<div class="banner-capital" id="invest-banner-capital">${formatCurrency(currentTotal)}</div>`;

        // === ASSETS BARS ===
        const dayChangeClass = absChange >= 0 ? 'change-positive' : 'change-negative';
        const weekChangeClass = absChangeWeek >= 0 ? 'change-positive' : 'change-negative';

        if (assets.length > 0) {
            html += `<div class="banner-assets" id="invest-assets-bars">`;
            html += `<div class="asset-bar-container">`;

            assets.forEach((asset, index) => {
                let color = COLORS.assetColors[index % COLORS.assetColors.length];
                if (asset.ticker.includes('TGLD')) color = '#efad05';
                if (asset.ticker.includes('TMON')) color = '#e74c3c';
                if (asset.ticker.includes('RUB')) color = COLORS.rubTicker;

                let assetTitle = asset.name;
                if (assetTitle.includes('TGLD')) assetTitle = 'Золото (TGLD)';
                else if (assetTitle.includes('TMON')) assetTitle = 'Обл. Минфин (TMON)';
                else if (assetTitle.includes('RUB')) assetTitle = 'Рубль';

                html += `<span class="asset-bar" title="${assetTitle}" style="width: ${Math.max(asset.percent, 1)}%; background-color: ${color};"><span class="asset-bar-label">${asset.percent.toFixed(1)}%</span></span>`;
            });

            html += `</div>`;
            html += `</div>`;
        }

        // === TABLE ===
        html += `<table class="banner-table" id="invest-banner-table"><tbody>`;

        html += `<tr class="banner-row-portfolio">
            <td class="banner-td-change ${dayChangeClass}" style="color:#1fc163">${formatChange(absChange)}</td>
            <td class="banner-td-pct ${dayChangeClass}">${formatPercent(pctChange)}</td>
            <td class="banner-td-change ${weekChangeClass}">${formatChange(absChangeWeek)}</td>
            <td class="banner-td-pct ${weekChangeClass}">${formatPercent(pctChangeWeek)}</td>
        </tr>`;

        html += renderAssetRow('TGLD@', COLORS.tgold, 'TGLD');
        html += renderAssetRow('TMON@', '#e74c3c', 'TMON');
        html += renderAssetRow('XAU/USD', '#3498db', 'XAU');

        html += `</tbody></table>`;

        $banner.html(html);
        console.log('[InvestBanner] Banner rendered, capital:', currentTotal, 'assets:', assets.length);
    }

    function updateInvestBanner() {
        console.log('[InvestBanner] updateInvestBanner called');
        
        loadTickersData(function() {
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
        
        loadTickersData();
        updateInvestBanner();
    }

    // Принимает готовые данные (из invest_chart.js), без повторного fetch
    function renderFromData(historyData, tgoldPrices) {
        if (tgoldPrices && tgoldPrices.current_price) {
            tickersData['TGLD@'] = tgoldPrices;
        }
        // Если тикеры ещё не загружены — подгружаем
        if (Object.keys(tickersData).length === 0) {
            loadTickersData(function() {
                renderBanner(historyData);
            });
        } else {
            renderBanner(historyData);
        }
    }

    $(document).ready(init);

    window.InvestBanner = {
        update: updateInvestBanner,
        renderFromData: renderFromData
    };

})(jQuery);
