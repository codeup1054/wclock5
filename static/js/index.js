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
});
