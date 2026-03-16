// static/js/invest_banner.js
console.log("🚀 invest_banner.js загружен");

(function($) {
    'use strict';

    let investBannerInterval = null;

    function formatCurrency(value) {
        return value.toLocaleString('ru-RU', { 
            style: 'decimal', // 'currency' or 'decimal'
            currency: 'RUB',
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

    function updateInvestBanner() {
        // Получаем историю (все снимки)
        $.getJSON('/api/invest/history', function(historyData) {
            if (!historyData || Object.keys(historyData).length === 0) {
                $('#invest_banner').html('<p>Нет данных</p>');
                return;
            }

            // Получаем все временные метки и сортируем по возрастанию
            const timestamps = Object.keys(historyData).sort();
            if (timestamps.length === 0) {
                $('#invest_banner').html('<p>Нет данных</p>');
                return;
            }

            // Последний снимок — текущее состояние
            const latestTs = timestamps[timestamps.length - 1];
            const latestPositions = historyData[latestTs];

            // Считаем общую стоимость последнего снимка
            const currentTotal = latestPositions.reduce((sum, p) => sum + p.value, 0);

            // Находим первый снимок после 00:00 сегодняшнего дня
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            let baselineTotal = currentTotal; // по умолчанию — текущее значение

            for (const ts of timestamps) {
                const tsDate = new Date(ts); // строка вида "2026-01-18T10:20:53.204828+00:00"
                if (tsDate >= todayStart) {
                    baselineTotal = historyData[ts].reduce((sum, p) => sum + p.value, 0);
                    break;
                }
            }

            // Вычисляем изменение
            const absChange = currentTotal - baselineTotal;
            const pctChange = baselineTotal !== 0 ? (absChange / baselineTotal * 100) : 0;

            // Формируем HTML
            let html = '';

            // Строка TOTAL с изменением
            const changeClass = absChange >= 0 ? 'change-positive' : 'change-negative';    

            html += `<div class="flex-row total-row ${changeClass}">
                <span class="tick_val">${formatCurrency(currentTotal)}</span>
                <span class="tick_change">${formatChange(absChange)} ${formatPercent(pctChange)}</span>
            </div>`;

            // Остальные позиции — из последнего снимка //${p.quantity.toLocaleString('ru-RU')}</span>
            latestPositions.forEach(p => {
                const rowClass = p.name === 'RUB000UTSTOM' ? 'rub-currency' : '';
                html += `<div class="flex-row ${rowClass}">
                    <span class="tick_name">${p.name.slice(0, 4)}</span>
                    <span class="tick_qnt">${formatCurrency(p.quantity)}</span> 
                    <span class="tick_val">${formatCurrency(p.value)}</span>
                </div>`;
            });

            $('#invest_banner').html(html);

        }).fail(function(xhr, status, error) {
            console.error('Ошибка загрузки истории:', error);
            $('#invest_banner').html('<p>❌ Ошибка загрузки портфеля</p>');
        });
    }

    function init() {
        updateInvestBanner();
        investBannerInterval = setInterval(updateInvestBanner, 120000); // каждые 2 минуты

        $(window).on('beforeunload', () => {
            if (investBannerInterval) {
                clearInterval(investBannerInterval);
                investBannerInterval = null;
            }
        });
    }

    $(document).ready(init);

    window.InvestBanner = {
        update: updateInvestBanner,
        stop: () => {
            if (investBannerInterval) {
                clearInterval(investBannerInterval);
                investBannerInterval = null;
            }
        }
    };

})(jQuery);