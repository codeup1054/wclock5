/**
 * cron.js — оркестратор периодических обновлений
 *
 * Интервалы заданы в MS в начале файла
 */

(function (window) {
    'use strict';

    // ========== Интервалы (в миллисекундах) ==========
    var BATTERY_INTERVAL   = 15 * 60 * 1000;  // 15 мин — обновление графика батареи
    var PAGE_REFRESH       = 4 * 24 * 60 * 60 * 1000; // 4 дня — полная перезагрузка страницы
    var INVEST_WIDGET      = 3 * 60 * 1000;   // 3 мин — виджет инвестиций
    var INVEST_CHART       = 7 * 60 * 1000;   // 7 мин — график инвестиций

    // Список для совместимости с registerTask()
    var extraTasks = [];
    var extraTimer = null;
    var EXTRA_INTERVAL = 10 * 60 * 1000; // 10 мин для задач из registerTask (по умолчанию)

    var timers = [];

    /**
     * Регистрирует дополнительную задачу (для совместимости с index.js)
     * @param {string} name
     * @param {Function} fn
     * @param {boolean} runImmediately
     */
    function registerTask(name, fn, runImmediately) {
        if (typeof fn !== 'function') {
            console.error('[Cron] Задача "' + name + '" не является функцией');
            return;
        }
        extraTasks.push({ name: name, fn: fn });
        if (runImmediately) {
            try { fn(); } catch (e) {
                console.error('[Cron] Ошибка при немедленном запуске "' + name + '":', e);
            }
        }
    }

    function executeExtraTasks() {
        extraTasks.forEach(function(task) {
            try { task.fn(); } catch (e) {
                console.error('[Cron] Ошибка в задаче "' + task.name + '":', e);
            }
        });
    }

    function start() {
        if (timers.length > 0) {
            console.warn('[Cron] Уже запущен');
            return;
        }

        // 1. Батарея — 15 мин
        timers.push(setInterval(function() {
            if (typeof window.sendBatteryLevel === 'function') {
                window.sendBatteryLevel();
            }
            var savedView = getSetting('chartView');
            if (savedView === 'energy' && typeof batteryLevel === 'function') {
                batteryLevel();
            }
            var bp = document.getElementById('battery_chart_panel');
            if (bp && bp.style.display !== 'none' && typeof updateBatteryChart === 'function') {
                updateBatteryChart();
            }
        }, BATTERY_INTERVAL));

        // 2. Полная перезагрузка страницы — 4 дня (только не на планшете)
        var _isTablet = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
        if (!_isTablet) {
            timers.push(setInterval(function() {
                location.reload();
            }, PAGE_REFRESH));
        }

        // 4. Виджет инвестиций — 3 мин
        timers.push(setInterval(function() {
            if (window.InvestBanner && typeof window.InvestBanner.update === 'function') {
                window.InvestBanner.update();
            }
        }, INVEST_WIDGET));

        // 5. График инвестиций — 7 мин
        timers.push(setInterval(function() {
            if (window.InvestPlot && typeof window.InvestPlot.update === 'function') {
                var savedView = getSetting('chartView');
                if (!savedView || savedView === 'invest') {
                    window.InvestPlot.update();
                }
            }
        }, INVEST_CHART));

        // Задачи из registerTask() — 2 мин
        executeExtraTasks(); // Немедленный первый запуск
        extraTimer = setInterval(executeExtraTasks, EXTRA_INTERVAL);

        console.log('[Cron] Запущен: батарея ' + (BATTERY_INTERVAL/60000) + 'мин, инвестиции ' + (INVEST_CHART/60000) + 'мин, виджет ' + (INVEST_WIDGET/60000) + 'мин, релоад ' + (PAGE_REFRESH/3600000) + 'ч');
    }

    function stop() {
        timers.forEach(function(t) { clearInterval(t); });
        timers = [];
        if (extraTimer) {
            clearInterval(extraTimer);
            extraTimer = null;
        }
        console.log('[Cron] Остановлен');
    }

    window.Cron = {
        start: start,
        stop: stop,
        registerTask: registerTask,
        getTaskCount: function() { return extraTasks.length; }
    };

})(window);
