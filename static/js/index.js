/**
 * index.js — main app module
 * Initializes UI, clock, weather, battery, invest panels.
 */

$(document).ready(function () {
    'use strict';

    let wakeLock = null;

    // === CLOCK ===
    let clockTimer = null;
    let _prevClock = null, _prevDay = null, _prevMonth = null, _prevWeekday = null;

    function updateClock() {
        const months = ["january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december"];
        const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        const now = new Date();

        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const mon = months[now.getMonth()];
        const wd = weekdays[now.getDay()];

        $('#clock_seconds').text(ss);
        const clockStr = hh + ':' + mm;
        if (clockStr !== _prevClock) { $('#clock').text(clockStr); _prevClock = clockStr; }
        if (dd !== _prevDay) { $('#day').text(dd); _prevDay = dd; }
        if (mon !== _prevMonth) { $('#month').text(mon); _prevMonth = mon; }
        if (wd !== _prevWeekday) { $('#weekday').text(wd); _prevWeekday = wd; }
    }

    function scheduleNextClockTick() {
        const now = Date.now();
        const delay = 1000 - (now % 1000) + 5;
        clockTimer = setTimeout(() => {
            updateClock();
            scheduleNextClockTick();
        }, delay);
    }

    function startClock() {
        if (clockTimer) clearTimeout(clockTimer);
        updateClock();
        scheduleNextClockTick();
    }

    // === АСТРОНОМИЧЕСКИЕ ФУНКЦИИ ===
    function getMoonPhaseIndex(date) {
        const epoch = new Date(Date.UTC(2000, 0, 6, 18, 14));
        const diffMs = new Date(date) - epoch;
        const days = diffMs / (1000 * 60 * 60 * 24);
        const phase = days % 29.530588853;
        return (Math.floor(phase / (29.530588853 / 16)) + 8) % 16;
    }

    function getDaylight() {
        const lat = 55.6667, lng = 37.2667, date = new Date();
        const times = SunCalc.getTimes(date, lat, lng);
        const fmt = d => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const daylightMs = times.sunset - times.sunrise;
        const hours = Math.floor(daylightMs / (1000 * 60 * 60));
        const minutes = Math.floor((daylightMs % (1000 * 60 * 60)) / (1000 * 60));
        return {
            daylightStr: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
            sunriseStr: fmt(times.sunrise),
            sunsetStr: fmt(times.sunset)
        };
    }

    // === WEATHER ===
    window.updateWeatherData = function () {
        $.getJSON('/api/weather')
            .done(data => {
                log('weather ' + data.fact.datetime.substring(11, 16));

                const fact = data.fact;
                $('#fact_condition').attr('src', 'https://pogoda.mail.ru' + fact.icon_url);
                $('#fact_temperature').text(fact.temperature);
                $('#fact_feels_like').text(fact.feels_like);
                $('#fact_humidity').text(fact.humidity);
                $('#fact_pressure_mm').text(fact.pressure);
                $('#fact_wind_speed').text(fact.wind_speed);
                $('#fact_prec_prob').text(fact.precip_prob).addClass('v' + fact.precip_prob);

                const mailRuWindToDeg = {
                    "С": 0, "С-СВ": 0, "СВ": 45, "В-СВ": 45, "В": 90, "В-ЮВ": 135,
                    "ЮВ": 135, "Ю-ЮЗ": 225, "Ю": 180, "Ю-ЮЗ": 225, "ЮЗ": 225, "З-ЮЗ": 225,
                    "З": 270, "З-СЗ": 315, "СЗ": 315, "С-СЗ": 315
                };
                const windDeg = mailRuWindToDeg[fact.wind_direction] || 0;
                $('#fact_wind_dir').text(fact.wind_dir);
                $('#fact_wind_dir_a').css({ transform: 'rotate(' + windDeg + 'deg)' });

                const forecast = data.forecast_summary.parts[0];
                $('#forecast_1_condition').attr('src', 'https://pogoda.mail.ru' + forecast.icon_url_day);
                $('#forecast_1_temperature').text(forecast.temperature);
                $('#forecast_1_feels_like').text(forecast.feels_like);
                $('#forecast_1_humidity').text(forecast.humidity);
                $('#forecast_1_pressure_mm').text(forecast.pressure);
                $('#forecast_1_prec_prob').text(forecast.precip_prob).addClass('v' + forecast.precip_prob);
                $('#forecast_1_wind_speed').text(forecast.wind_speed);

                const forecastWindDeg = mailRuWindToDeg[forecast.wind_direction] || 0;
                $('#forecast_1_wind_dir').text(forecast.wind_dir);
                $('#forecast_1_wind_dir_a').css({ transform: 'rotate(' + forecastWindDeg + 'deg)' });

                const daylight = getDaylight();
                $('#sunset').text(daylight.sunsetStr);
                $('#sunrise').text(daylight.sunriseStr);
                $('#daylight').text(daylight.daylightStr);

                $('#moon_phase').css({
                    "background-image": "url(/static/images/moon/moon_phase_" + getMoonPhaseIndex(new Date()) + ".png)"
                });

                if (typeof drawWeatherChart === 'function') {
                    drawWeatherChart(data.timeline);
                }
            })
            .fail(() => console.error('Failed to load /api/weather'));
    };

    // === BATTERY ===
    function initBattery() {
        navigator.getBattery().then(battery => {
            const updateBatteryDiv = () => {
                const level = Math.round(battery.level * 100);
                const charging = battery.charging;
                const text = (charging ? '+' : '') + level + '%';
                
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
            };
            updateBatteryDiv();
            battery.addEventListener('levelchange', updateBatteryDiv);
            battery.addEventListener('chargingchange', updateBatteryDiv);
        });
    }

    // === WAKE LOCK & FULLSCREEN ===

    async function requestWakeLock() {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                log("WakeLock released, re-acquiring...");
                requestWakeLock();
            });
        } catch (err) {
            log("WakeLock error: " + err.message);
        }
    }

    // Re-acquire wake lock on visibility change (screen on after sleep)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !wakeLock) {
            requestWakeLock();
        }
        window._pageHidden = document.hidden;
        pageLog('visibility: ' + (document.hidden ? 'hidden' : 'visible'));
        if (!document.hidden && typeof window.updateWeatherData === 'function') {
            window.updateWeatherData();
        }
    });

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().then(requestWakeLock);
        } else document.exitFullscreen();
    }

    // === ИНИЦИАЛИЗАЦИЯ ===
    function initUI() {
        $('#browser_reload').on('click', () => location.reload());
        $('#browser_fullscreen').on('click', toggleFullscreen);
        $('#fullscreen2').on('click', toggleFullscreen);
        // Disable fullscreen toggle on clicks inside weather panel
        $('.fullscreen3').on('click', function (e) {
            if ($(this).closest('#weather_panel').length > 0) return;
            const id = this.id || '';
            if (id === 'weatherChart' || id === 'volumeChart') return;
            $(this).toggleClass('fullscreen_on').css('z-index', $(this).hasClass('fullscreen_on') ? 500 : '');
        });
        $('#forecast_1_temperature').on('click', window.updateWeatherData);
        $('#volumeChart').on('click', () => $('body').toggleClass('invest-fullscreen'));

        // Secret mode toggle
        initModeToggle();

        if (typeof updateToggleButtonText === 'function') updateToggleButtonText();

        // Interval button click handlers
        $('.interval-btn').on('click', function() {
            const interval = $(this).attr('data-interval');
            if (!interval) return;
            
            $('.interval-btn').removeClass('active');
            $(this).addClass('active');
            
            window.currentInterval = interval;
            
            // Save to localStorage
            try {
                localStorage.setItem('chartInterval', interval);
            } catch(e) {}
            
            // Update chart
            const savedView = localStorage.getItem('chartView') || 'invest';
            if (savedView === 'invest' && typeof window.InvestPlot !== 'undefined') {
                window.InvestPlot.update();
            } else if (savedView === 'energy' && typeof batteryLevel === 'function') {
                batteryLevel();
            }
        });

        // Restore active interval from localStorage
        const savedInterval = localStorage.getItem('chartInterval');
        if (savedInterval) {
            $('.interval-btn[data-interval="' + savedInterval + '"]').addClass('active');
            window.currentInterval = savedInterval;
        } else {
            // Default to hour
            $('.interval-btn[data-interval="hour"]').addClass('active');
            window.currentInterval = 'hour';
        }
    }

    // === MODE TOGGLE ===
    function initModeToggle() {
        const $btn = $('#mode_toggle');
        $btn.show();
        
        // Проверяем текущий режим
        $.getJSON('/api/get_mode', function(data) {
            if (data.mode === 'invest') {
                $btn.addClass('invest-mode');
            }
        });
        
        // Обработчик клика - 5 быстрых кликов для переключения
        let clickCount = 0;
        let clickTimer = null;
        
        $btn.on('click', function() {
            clickCount++;
            
            if (clickTimer) clearTimeout(clickTimer);
            
            clickTimer = setTimeout(function() {
                clickCount = 0;
            }, 1500);
            
            if (clickCount >= 5) {
                // Переключаем режим
                $.getJSON('/api/get_mode', function(data) {
                    const newMode = data.mode === 'invest' ? 'basic' : 'invest';
                    
                    $.ajax({
                        url: '/api/set_mode',
                        method: 'POST',
                        contentType: 'application/json',
                        data: JSON.stringify({ mode: newMode }),
                        success: function() {
                            if (newMode === 'invest') {
                                $btn.addClass('invest-mode');
                            } else {
                                $btn.removeClass('invest-mode');
                            }
                            // Перезагружаем страницу для применения режима
                            location.reload();
                        }
                    });
                });
                clickCount = 0;
            }
        });
    }

    // === ЗАПУСК ===
    startClock();
    if (typeof initBatteryUI === 'function') initBatteryUI();
    initUI();
    requestWakeLock();
    
    // Инициализация перетаскивания и изменения размеров панелей
    if (typeof PanelResize !== 'undefined') {
        PanelResize.init();
    }

    // Регистрация задач для cron.js
    if (typeof Cron !== 'undefined') {
        Cron.registerTask('Weather', window.updateWeatherData);
        Cron.start();
    } else {
        // Fallback: если cron.js не загружен
        window.updateWeatherData();
        $.getJSON('/api/settings')
            .done(settings => {
                const interval = (settings.REFRESH_DATA_INTERVAL || 1800) * 1000;
                setInterval(window.updateWeatherData, interval);
            })
            .fail(() => setInterval(window.updateWeatherData, 1800000)); // 30 мин
    }

    // === ПАМЯТЬ, ЛОГИРОВАНИЕ ЗАКРЫТИЯ, АВТОПЕРЕЗАГРУЗКА ===

    const PAGE_LOAD_TIME = Date.now();
    const RELOAD_INTERVAL = 15 * 60 * 1000; // 15 минут
    const MEM_CHECK_INTERVAL = 10 * 1000;   // 10 сек
    const CRITICAL_MEM_RATIO = 0.85;         // 85% от лимита — перезагрузка
    const FLUSH_INTERVAL = 30_000;           // сброс лога на сервер каждые 30 сек

    // --- Логирование жизненного цикла страницы с отправкой на сервер ---

    const _sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let _logBuffer = [];
    let _flushTimer = null;

    function _getContext() {
        const mem = performance.memory;
        const charts = [];
        if (window.weatherChart) charts.push('W');
        if (window.InvestPlot?.getChart?.()) charts.push('I');
        if (window.batteryChart) charts.push('B');
        return {
            mem_used: mem ? mem.usedJSHeapSize : null,
            mem_limit: mem ? mem.jsHeapSizeLimit : null,
            mem_total: mem ? mem.totalJSHeapSize : null,
            charts: charts.join(','),
            uptime_ms: Date.now() - PAGE_LOAD_TIME,
            hidden: document.hidden,
            wake_lock: !!window._wakeLockActive,
            url: location.href
        };
    }

    function pageLog(msg) {
        const entry = { t: new Date().toISOString(), m: msg };
        // В localStorage на случай если sendBeacon не сработает
        try {
            let log = JSON.parse(localStorage.getItem('wclock_page_log') || '[]');
            log.push(entry);
            if (log.length > 100) log = log.slice(-100);
            localStorage.setItem('wclock_page_log', JSON.stringify(log));
        } catch(e) {}
        // В буфер для отправки на сервер
        _logBuffer.push(entry);
    }

    // Фактическая отправка на сервер
    function _flushLog(context) {
        if (_logBuffer.length === 0) return;
        const events = _logBuffer.splice(0);
        const payload = JSON.stringify({ session: _sessionId, events, context: context || _getContext() });
        // sendBeacon надёжнее для beforeunload, fetch с keepalive — запасной вариант
        try {
            navigator.sendBeacon('/api/log', payload);
        } catch(e) {
            try { fetch('/api/log', { method: 'POST', body: payload, keepalive: true }); } catch(e2) {}
        }
    }

    // Периодический сброс
    function _startFlushTimer() {
        if (_flushTimer) clearInterval(_flushTimer);
        _flushTimer = setInterval(() => _flushLog(), FLUSH_INTERVAL);
    }

    // Вывести лог предыдущей сессии из localStorage
    try {
        const prevLog = JSON.parse(localStorage.getItem('wclock_page_log') || '[]');
        if (prevLog.length > 0) {
            console.log('[SessionLog] Previous session events (' + prevLog.length + '):');
            prevLog.slice(-20).forEach(e => console.log('  ' + e.t + ' — ' + e.m));
        }
    } catch(e) {}

    pageLog('session_start');
    _startFlushTimer();

    // События жизненного цикла — отправляем с контекстом немедленно
    window.addEventListener('beforeunload', () => {
        pageLog('beforeunload');
        _flushLog();
    });
    window.addEventListener('pagehide', () => {
        pageLog('pagehide');
        _flushLog();
    });
    document.addEventListener('visibilitychange', () => {
        pageLog('visibility: ' + (document.hidden ? 'hidden' : 'visible'));
        if (!document.hidden && typeof window.updateWeatherData === 'function') {
            window.updateWeatherData();
        }
        // При скрытии страницы — тоже сбрасываем лог (на случай убийства процесса)
        if (document.hidden) _flushLog();
    });

    // --- Индикатор памяти ---

    const $memInfo = $('#mem-info');
    let memVisible = localStorage.getItem('wclock_mem_visible') === '1';

    function fmtMB(bytes) {
        if (!bytes) return '?';
        return (bytes / (1024 * 1024)).toFixed(0);
    }

    function updateMemInfo() {
        const mem = performance.memory;
        const heapUsed = mem ? fmtMB(mem.usedJSHeapSize) : '?';
        const heapTotal = mem ? fmtMB(mem.jsHeapSizeLimit) : '?';
        const heapLimit = mem ? fmtMB(mem.totalJSHeapSize) : '?';

        const charts = document.querySelectorAll('canvas').length;
        const chartInst = [];
        if (window.weatherChart) chartInst.push('W');
        if (window.InvestPlot?.getChart?.()) chartInst.push('I');
        if (window.batteryChart) chartInst.push('B');

        const uptime = Math.floor((Date.now() - PAGE_LOAD_TIME) / 60000);
        const nextReload = Math.max(0, Math.ceil((RELOAD_INTERVAL - (Date.now() - PAGE_LOAD_TIME)) / 60000));

        $memInfo.text(
            'Mem: ' + heapUsed + '/' + heapTotal + ' MB (lim:' + heapLimit + ')\n' +
            'Charts: ' + chartInst.join('') + ' | Up: ' + uptime + 'm | Reload: ' + nextReload + 'm'
        );
        $memInfo.toggleClass('visible', memVisible);

        // Критический уровень памяти — принудительная перезагрузка
        if (mem && mem.usedJSHeapSize > mem.jsHeapSizeLimit * CRITICAL_MEM_RATIO) {
            pageLog('critical_mem: ' + fmtMB(mem.usedJSHeapSize) + '/' + fmtMB(mem.jsHeapSizeLimit) + ' MB — reloading');
            _flushLog();
            $memInfo.css('color', '#ff4444');
            setTimeout(() => location.reload(), 3000);
        }
    }

    // Включить/выключить индикатор тройным кликом по часам
    $('#clock').on('click', function() {
        let count = parseInt($(this).data('mem-click') || '0') + 1;
        $(this).data('mem-click', count);
        if (count >= 3) {
            $(this).data('mem-click', 0);
            memVisible = !memVisible;
            localStorage.setItem('wclock_mem_visible', memVisible ? '1' : '0');
            $memInfo.toggleClass('visible', memVisible);
        }
        setTimeout(() => { if ($(this).data('mem-click') == count) $(this).data('mem-click', 0); }, 1000);
    });

    setInterval(updateMemInfo, MEM_CHECK_INTERVAL);
    updateMemInfo();

    // --- Автоперезагрузка ---

    function scheduleReload() {
        const remaining = RELOAD_INTERVAL - (Date.now() - PAGE_LOAD_TIME);
        if (remaining <= 0) {
            pageLog('auto_reload_15min');
            location.reload();
            return;
        }
        setTimeout(() => {
            // Перезагружаем только если страница видима (чтобы не сбить пользователя)
            if (!document.hidden) {
                pageLog('auto_reload_15min');
                location.reload();
            } else {
                // Если скрыта — ждём ещё 30 сек и пробуем снова
                pageLog('auto_reload_deferred (hidden)');
                scheduleReload();
            }
        }, Math.min(remaining, 30000));
    }
    scheduleReload();

    // --- Уменьшаем частоту обновления графиков, когда страница скрыта ---
    window._pageHidden = false;

    // --- Подсчёт количества Chart.js инстансов (для отладки утечек) ---
    window._logChartCount = function() {
        // Chart.js хранит глобальный реестр в Chart.instances (v3) или через Chart.getChart (v4)
        let count = 0;
        document.querySelectorAll('canvas').forEach(c => {
            if (Chart.getChart(c)) count++;
        });
        pageLog('chart_instances: ' + count);
        return count;
    };
    // Проверять раз в минуту
    setInterval(window._logChartCount, 60 * 1000);
});
