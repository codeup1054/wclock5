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
    const UPDATE_INTERVAL = 120_000; // 1 минута

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

        console.log('[Cron] Запуск оркестратора обновлений (каждые 60 сек)...');
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
            } else {
                console.log('[Cron] ⏸️ График батареи активен, пропускаем обновление InvestPlot');
            }
        } else {
            console.warn('[Cron] InvestPlot не найден — пропуск');
        }
    }, true);

    // 2. Погода (пример: WeatherWidget)
    if (window.WeatherWidget && typeof window.WeatherWidget.update === 'function') {
        registerTask('WeatherWidget', window.WeatherWidget.update, true);
    } else {
        // Можно оставить как заглушку или подключить позже
        // registerTask('WeatherWidget', () => fetch('/api/weather').then(...), true);
    }

    // 3. Другие виджеты можно добавить здесь или через внешний вызов

    // === Экспорт в глобальную область ===
    window.Cron = {
        start,
        stop,
        registerTask,
        getTaskCount: () => tasks.length
    };

    // Автозапуск при загрузке (опционально)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

})(window);