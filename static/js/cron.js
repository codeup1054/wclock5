/**
 * cron.js — оркестратор периодических обновлений
 * 
 * Поддерживает:
 * - Обновление графика инвестиций (InvestPlot)
 * - Обновление погоды (WeatherWidget)
 * - Расширяемость через registerTask()
 */

(function (window) {
    'use strict';

    // Список задач для выполнения по расписанию
    const tasks = [];

    let masterInterval = null;
    const UPDATE_INTERVAL = 120_000; // 2 минуты между циклами

    /**
     * Регистрирует новую задачу для периодического выполнения
     * @param {string} name — имя задачи (для отладки)
     * @param {Function} fn — функция обновления
     * @param {boolean} runImmediately — запустить сразу?
     */
    function registerTask(name, fn, runImmediately = false) {
        if (typeof fn !== 'function') {
            console.error(`[Cron] Задача "${name}" не является функцией`);
            return;
        }

        tasks.push({ name, fn });

        if (runImmediately) {
            try {
                fn();
            } catch (e) {
                console.error(`[Cron] Ошибка при немедленном запуске "${name}":`, e);
            }
        }
    }

    /**
     * Выполняет все зарегистрированные задачи
     */
    function executeAllTasks() {
        tasks.forEach(task => {
            try {
                task.fn();
            } catch (e) {
                console.error(`[Cron] Ошибка в задаче "${task.name}":`, e);
            }
        });
    }

    /**
     * Запускает центральный таймер
     */
    function start() {
        if (masterInterval) {
            console.warn('[Cron] Уже запущен');
            return;
        }

        console.log(`[Cron] Запуск оркестратора обновлений (каждые ${UPDATE_INTERVAL/1000} сек)...`);
        executeAllTasks(); // Первое обновление сразу
        masterInterval = setInterval(executeAllTasks, UPDATE_INTERVAL);
    }

    /**
     * Останавливает все обновления
     */
    function stop() {
        if (masterInterval) {
            clearInterval(masterInterval);
            masterInterval = null;
            console.log('[Cron] Оркестратор обновлений остановлен');
        }
    }

    // === Регистрация стандартных задач ===

    // 1. График инвестиций (с проверкой текущего режима)
    // Проверяем наличие InvestPlot внутри функции, а не при загрузке
    registerTask('InvestPlot', function() {
        if (window.InvestPlot && typeof window.InvestPlot.update === 'function') {
            const savedView = localStorage.getItem('chartView');
            if (!savedView || savedView === 'invest') {
                window.InvestPlot.update();
            }
        }
    });

    if (window.WeatherWidget && typeof window.WeatherWidget.update === 'function') {
        registerTask('WeatherWidget', window.WeatherWidget.update);
    }

    if (window.InvestBanner && typeof window.InvestBanner.update === 'function') {
        registerTask('InvestBanner', window.InvestBanner.update);
    }

    // 2. График батареи: сначала отправка на сервер, потом обновление (только в режиме energy)
    registerTask('Battery', function() {
        const savedView = localStorage.getItem('chartView');
        if (savedView === 'energy') {
            window.sendBatteryLevel().done(function() {
                if (typeof window.updateBatteryChart === 'function') {
                    window.updateBatteryChart();
                }
            });
        }
    });

    // 3. Другие виджеты можно добавить здесь или через внешний вызов

    // === Экспорт в глобальную область ===
    window.Cron = {
        start,
        stop,
        registerTask,
        getTaskCount: () => tasks.length
    };

    // Запуск — вызывается из index.js после регистрации задач

})(window);