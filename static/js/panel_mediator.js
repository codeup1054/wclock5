/* panel_mediator.js - клиент-медиатор данных (эпик EPIC_mediator_data).
 *  Полный самосинк ЭП3: дельта-шина панели поверх существующих /api/*.
 *
 * Роль: один POST /api/data_mediator в тик (5 с) вместо N периодических GET.
 *  - клиент хранит в localStorage токены секций (что он уже «знает»);
 *    при старте страницы токены сбрасываются — первый опрос приносит полные
 *    payload всех секций (локально нет данных для нового DOM), дальше дельта;
 *  - секции регистрируются через subscribe(sect, fn, opts) — к подписке
 *    привязывается provider параметров (строки запроса секции);
 *  - в v уходят только ПОДПИСАННЫЕ секции (токен или '' — «не знаю»);
 *  - при смене параметров провайдера токен секции сбрасывается — сервер
 *    вернёт секцию в changed (полный payload нового диапазона);
 *  - в ответе {changed: {секция: payload}, tokens} изменившиеся секции
 *    несут ПОЛНЫЕ данные — клиент рисует из них напрямую, без повторного
 *    GET к /api/*; неизменные секции не читаются и не рисуются (дельта).
 *
 * Секции -> рендер (подписчики):
 *   weather         -> window.renderWeatherData(payload)   (index.js)
 *   charts_data     -> window.renderWeatherChart(payload)  (weather_chart.js)
 *   battery.history -> window.renderBatteryHistory(payload)(battery.js)
 *   invest.turnover -> InvestBanner (turnoverData)
 *   invest.tickers  -> window.__investTickerCache + InvestBanner
 *   invest.history  -> InvestHistoryCache.primeFromMediator + InvestBanner
 *
 * Fallback: старые GET-рендеры остаются — виджеты при застое магазина
 * (>= медленного опроса) сами возвращаются к прямым /api/*.
 *
 * Доступ наружу:
 *   PanelMediator.subscribe(sect, fn, {params})  — добавить подписчика
 *   PanelMediator.getLatest(sect)                — последний payload секции
 *   PanelMediator.invalidate(sect)               — сбросить токен (force delta)
 *   PanelMediator.healthy                        — сервер отвечал последним разом
 */
(function () {
    'use strict';

    var URL_MEDIATOR = '/api/data_mediator';
    var LS_KEY = 'wclock5_mediator_tokens';
    var POLL_MS = 5000;                  // 5 c — единый тик дашборда (пик инвеста 1с)
    var MAX_CHANGED = 16;                // предохранитель

    var tokens = {};                     // {секция: токен} — что клиент уже знает
    var subscribed = {};                 // {секция: true} — секции в v-слое
    var listeners = {};                  // {секция: [fn(payload)]}
    var paramProviders = {};             // {секция: fn() -> {..} | null}
    var latest = {};                     // {секция: последний payload}
    var latestAt = {};                   // {секция: ts доставки} — для getLatest
    var lastParamsKey = {};              // {секция: string} — для инвалидации токена
    var saving = false;
    var healthy = true;                  // последний опрос успешен

    // ---------------- подписка ----------------
    function subscribe(sect, fn, opts) {
        opts = opts || {};
        if (!listeners[sect]) listeners[sect] = [];
        if (typeof fn === 'function' && listeners[sect].indexOf(fn) === -1) {
            listeners[sect].push(fn);
        }
        if (typeof opts.params === 'function') {
            paramProviders[sect] = opts.params;
        }
        subscribed[sect] = true;
        // Гонка при старте: секция могла быть доставлена ДО подписки
        // (первый опрос раньше DOM-ready). Отдаём подписчику уже известный
        // payload сразу — иначе при неизменном токене повторной выдачи не будет.
        if (latest[sect] !== undefined) {
            try { fn(latest[sect], sect); }
            catch (e) { if (window.console) window.console.warn('[mediator] prime ' + sect + ': ' + e); }
        }
    }

    function invalidate(sect) {
        delete tokens[sect];
    }

    function getLatest(sect) {
        return latest[sect];
    }

    function getLatestAt(sect) {
        return latestAt[sect] || 0;
    }

    // Write-секция (battery и др.): отдельный POST с {write: {sect: payload}}.
    // Сервер сам решает apply/skip (интервал write_interval_*).
    function write(sect, payload) {
        var dfd = $.Deferred();
        var w = {};
        w[sect] = payload;
        $.ajax({
            url: URL_MEDIATOR,
            method: 'POST',
            contentType: 'application/json',
            dataType: 'json',
            data: JSON.stringify({ write: w }),
            timeout: 15000
        })
            .done(function (res) {
                var r = (res && res.writes && res.writes[sect]) || { applied: true };
                dfd.resolve(r);
            })
            .fail(function (xhr) {
                dfd.reject(xhr);
            });
        return dfd.promise();
    }

    function keyParams(p) {
        try { return JSON.stringify(p || {}); } catch (e) { return ''; }
    }

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

    // ---------------- дистрибуция changed ----------------
    function deliver(sect, payload) {
        latest[sect] = payload;
        latestAt[sect] = Date.now();
        var subs = listeners[sect];
        if (!subs) return;
        for (var i = 0; i < subs.length; i++) {
            try { subs[i](payload, sect); }
            catch (e) { if (window.console) window.console.warn('[mediator] sub ' + sect + ': ' + e); }
        }
    }

    function activate(changed) {
        if (!changed || typeof changed !== 'object') return;
        var keys = Object.keys(changed);
        for (var i = 0; i < keys.length && i < MAX_CHANGED; i++) {
            deliver(keys[i], changed[keys[i]]);
        }
    }

    // ---------------- опрос ----------------
    function buildBody() {
        var body = { v: {} };
        Object.keys(subscribed).forEach(function (sect) {
            body.v[sect] = tokens[sect] || '';
        });
        var pKeys = Object.keys(paramProviders);
        if (pKeys.length) {
            var params = {};
            pKeys.forEach(function (sect) {
                var p = paramProviders[sect]();
                var pk = keyParams(p);
                if (lastParamsKey[sect] !== undefined && lastParamsKey[sect] !== pk) {
                    invalidate(sect);             // параметры сменились → force delta
                }
                lastParamsKey[sect] = pk;
                if (p && typeof p === 'object' && Object.keys(p).length) params[sect] = p;
            });
            if (Object.keys(params).length) body.params = params;
        }
        return body;
    }

    function poll() {
        if (saving) return;
        if (document.hidden) {                      // скрытая вкладка — не дёргаем сервер
            setTimeout(poll, POLL_MS);
            return;
        }
        saving = true;
        $.ajax({
            url: URL_MEDIATOR,
            method: 'POST',
            contentType: 'application/json',
            dataType: 'json',
            data: JSON.stringify(buildBody()),
            timeout: 15000
        })
            .done(function (res) {
                saving = false;
                healthy = true;
                if (!res || typeof res !== 'object') return;
                if (res.tokens && typeof res.tokens === 'object') {
                    var before = JSON.stringify(tokens);
                    tokens = res.tokens;            // сервер — источник истины
                    if (JSON.stringify(tokens) !== before) saveTokens();
                }
                if (res.changed) activate(res.changed);
            })
            .fail(function () {
                saving = false;
                healthy = false;                    // медиатор недоступен — виджеты
            });                                     // возвращаются к GET-fallback
    }

    // ---------------- старт ----------------
    // Дефолтные подписки (обратная совместимость): weather/charts/battery
    // рендерятся глобальными функциями (index.js/weather_chart.js/battery.js).
    subscribe('weather', function (p) {
        if (typeof window.renderWeatherData === 'function') window.renderWeatherData(p);
    });
    subscribe('charts_data', function (p) {
        if (typeof window.renderWeatherChart === 'function') window.renderWeatherChart(p);
    });
    subscribe('battery.history', function (p) {
        if (typeof window.renderBatteryHistory === 'function') window.renderBatteryHistory(p);
    }, {
        params: function () {
            var deviceId = null;
            if (typeof window.getOrCreateDeviceId === 'function') {
                deviceId = window.getOrCreateDeviceId();
            } else if (typeof getOrCreateDeviceId === 'function') {
                deviceId = getOrCreateDeviceId();
            }
            if (deviceId) {
                var p = { device_id: deviceId };
                if (window.currentInterval) p.interval = window.currentInterval;
                if (typeof window.getSetting === 'function') {
                    p.period = window.getSetting('battery_chart_period', '-7 day');
                }
                return p;
            }
            return null;
        }
    });

    function start() {
        loadTokens();
        tokens = {};                          // после загрузки страницы DOM чистый:
                                              // персистентные токены не перенесли payload
                                              // в разметку — первый опрос возвращает ПОЛНУЮ
                                              // выдачу всех секций (дальше — обычная дельта).
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

    // наружу (отладка + подписки виджетов)
    window.PanelMediator = {
        poll: poll,
        subscribe: subscribe,
        unsubscribe: function (sect, fn) {
            if (!listeners[sect]) return;
            var idx = listeners[sect].indexOf(fn);
            if (idx !== -1) listeners[sect].splice(idx, 1);
        },
        invalidate: invalidate,
        getLatest: getLatest,
        getLatestAt: getLatestAt,
        write: write,
        getTokens: function () { return tokens; },
        healthy: function () { return healthy; }
    };
})();