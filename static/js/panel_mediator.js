/* panel_mediator.js - клиент-медиатор данных (эпик EPIC_mediator, итер. 2,
 *  полный самосинк ЭП3).
 *
 * Роль: дельта-шина панели поверх существующих /api/*.
 *  - клиент хранит в localStorage токены секций (что он уже «знает»);
 *  - раз в POLL_MS шлёт POST /api/data_mediator телом
 *        {"v": {секция: токен}, "params": {секция: {device_id: ...}}}
 *  - в ответе {changed: {секция: payload}, tokens: {...}, ts} изменившиеся
 *    секции несут ПОЛНЫЕ данные (НЕ флаги) - клиент рисует ИЗ НИХ напрямую,
 *    без повторного GET к /api/*;
 *  - неизменные секции не читаются и не рисуются вовсе (дельта = 0 лишних
 *    запросов, один POST в минуту на все секции сразу).
 *
 * Секции -> рендер-функция (получает payload как аргумент):
 *   weather         -> window.renderWeatherData(payload)   (index.js)
 *   charts_data     -> window.renderWeatherChart(payload)  (weather_chart.js)
 *   battery.history -> window.renderBatteryHistory(payload)(battery.js)
 *
 * Важно: НЕ дублируем старые GET-рендеры (updateWeatherData и пр. ходят в
 * /api/* сами). Здесь НОВЫЕ render-функции, которые принимают payload и
 * рисуют «из рук» - так панель обновляется одним медиатор-POST без лишних
 * N-запросов к /api/*, когда данные не менялись.
 */
(function () {
    'use strict';

    var URL_MEDIATOR = '/api/data_mediator';
    var LS_KEY = 'wclock5_mediator_tokens';
    var POLL_MS = 60000;                 // 60 c — совпадает с write-интервалом батареи
    var MAX_CHANGED = 16;                // предохранитель

    var BATT_DEVICE_ID = null;           // device_id батареи (из window.__batteryDeviceId)
    var tokens = {};                     // {секция: токен} — что клиент уже знает
    var saving = false;

    // ---------------- активаторы (получают payload из changed) ----------------
    var ACTIVATORS = {
        'weather': function (payload) {
            if (typeof window.renderWeatherData === 'function') window.renderWeatherData(payload);
        },
        'charts_data': function (payload) {
            if (typeof window.renderWeatherChart === 'function') window.renderWeatherChart(payload);
        },
        'battery.history': function (payload) {
            if (typeof window.renderBatteryHistory === 'function') window.renderBatteryHistory(payload);
        }
    };

    // ---------------- localStorage ----------------
    function loadTokens() {
        var raw = null;
        try { raw = localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
        tokens = {};
        if (!raw) return;
        try { tokens = JSON.parse(raw) || {}; } catch (e) { tokens = {}; }
        if (typeof tokens !== 'object' || Array.isArray(tokens)) tokens = {};
    }

    function saveTokens() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(tokens)); } catch (e) { /* приватный режим */ }
    }

    // ---------------- активация changed ----------------
    function activate(changed) {
        if (!changed || typeof changed !== 'object') return;
        Object.keys(changed).slice(0, MAX_CHANGED).forEach(function (sect) {
            var fn = ACTIVATORS[sect];
            if (!fn) return;                        // секция без клиентского активатора — skip
            try { fn(changed[sect]); }
            catch (e) { if (window.console) window.console.warn('[mediator] ' + sect + ': ' + e); }
        });
    }

    // ---------------- опрос ----------------
    function poll() {
        if (saving) return;
        if (document.hidden) {                      // скрытая вкладка — не дёргаем сервер
            setTimeout(poll, POLL_MS);
            return;
        }
        if (typeof window.__batteryDeviceId === 'string' && window.__batteryDeviceId) {
            BATT_DEVICE_ID = window.__batteryDeviceId;
        }
        saving = true;
        var body = { v: tokens };
        if (BATT_DEVICE_ID) {
            body.params = { 'battery.history': { device_id: BATT_DEVICE_ID } };
        }
        $.ajax({
            url: URL_MEDIATOR,
            method: 'POST',
            contentType: 'application/json',
            dataType: 'json',
            data: JSON.stringify(body),
            timeout: 15000
        })
            .done(function (res) {
                saving = false;
                if (!res || typeof res !== 'object') return;
                if (res.tokens && typeof res.tokens === 'object') {
                    var before = JSON.stringify(tokens);
                    tokens = res.tokens;            // сервер — источник истины
                    if (JSON.stringify(tokens) !== before) saveTokens();
                }
                if (res.changed) activate(res.changed);
            })
            .fail(function () {
                saving = false;                    // медиатор недоступен — существующие таймеры
            });                                    // index.js/battery.js остаются fallback'ом
    }

    // ---------------- старт ----------------
    function start() {
        loadTokens();
        poll();                                    // первый срез сразу
        setInterval(poll, POLL_MS);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) setTimeout(poll, 250);
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }

    // наружу (отладка)
    window.PanelMediator = {
        poll: poll,
        getTokens: function () { return tokens; }
    };
})();
