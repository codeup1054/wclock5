/**
 * invest_sources.js — реестр портфелей (источников данных) investChart.
 *
 * Один источник = один токен брокера (см. sh/invest_tokens.py).
 * Добавление нового портфеля: запись здесь + демон, который пишет
 * portfolio_positions с полем source = id. Секретов в этом файле нет.
 *
 * Поля:
 *   id      — значение source в БД (source='tdiv')
 *   label   — подпись в легенде/таблицах ('С5 TDIV')
 *   marker  — однобуквенный маркер строки в баннере
 *   color   — цвет линии; colorKey — ключ в ChartTheme (приоритетнее)
 *   axis    — id оси Y (tinkoff → y_portfolio, finam → y_finam)
 *   enabled — показывать строку в настройках «Сбор данных через API»
 */
(function (window) {
    'use strict';

    var SOURCES = [
        // Порядок = порядок строк в баннере и колонок легенды.
        // marker — буква БРОКЕРА: T = Тинвест (все его счета), F = Финам.
        // shortLabel — необязательная подпись для первой колонки таблицы
        // (по умолчанию берётся крупнейший инструмент счёта).
        { id: 'finam',   label: 'Finam',    marker: 'F', broker: 'finam',   colorKey: 'finam',     color: '#5b6ee8', axis: 'y_finam',     enabled: true },
        { id: 'tinkoff', label: 'Tinkoff',  marker: 'T', broker: 'tinkoff', colorKey: 'portfolio', color: '#2cba99', axis: 'y_portfolio', enabled: true },
        { id: 'tdiv',    label: 'С5 TDIV',  marker: 'T', broker: 'tinkoff', colorKey: 'tdiv',      color: '#e8a33d', axis: 'y_tdiv',      enabled: true },
        { id: 'trnd',    label: 'С3 TRND',  marker: 'T', broker: 'tinkoff', colorKey: 'trnd',      color: '#7b6bd6', axis: 'y_trnd',      enabled: true, shortLabel: 'C3 TRND' },
        { id: 'funit',   label: 'Единый счёт', marker: 'F', broker: 'finam', colorKey: 'funit',    color: '#c04ad0', axis: 'y_funit',     enabled: true, shortLabel: 'Единый' }
    ];

    var byId = {};
    SOURCES.forEach(function (s) { byId[s.id] = s; });

    window.InvestSources = {
        list: function () { return SOURCES.slice(); },
        ids: function () { return SOURCES.map(function (s) { return s.id; }); },
        get: function (id) { return byId[id] || null; },
        // Цвет источника: сначала из темы (color.<colorKey>), затем поле color.
        color: function (id, fallback) {
            var s = byId[id];
            if (!s) return fallback || '#888';
            if (s.colorKey && window.ChartTheme && typeof ChartTheme.get === 'function') {
                var c = ChartTheme.get('color.' + s.colorKey, null);
                if (c) return c;
            }
            return s.color || fallback || '#888';
        }
    };
})(window);
