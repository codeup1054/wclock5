// static/js/lib.js

// Глобальное состояние
let currentView = 'invest'; // ← по умолчанию инвестиции
let currentInterval = 'hour';

// Экспортируем в window для доступа из других модулей
window.currentView = currentView;

/**
 * Сохраняет состояние в localStorage
 */
function saveChartState() {
    try {
        localStorage.setItem('chartView', currentView);
        localStorage.setItem('chartInterval', currentInterval);
    } catch (e) {
        console.warn('Не удалось сохранить состояние:', e);
    }
}

/**
 * Загружает состояние из localStorage
 */
function loadChartState() {
    try {
        const savedView = localStorage.getItem('chartView');
        const savedInterval = localStorage.getItem('chartInterval');
        if (savedView === 'invest' || savedView === 'energy') {
            currentView = savedView;
            window.currentView = currentView; // Обновляем глобальную переменную
        }
        if (savedInterval === 'minute' || savedInterval === 'hour' || savedInterval === 'day') {
            currentInterval = savedInterval;
        }
        // Устанавливаем для совместимости с invest_chart.js
        window.currentInterval = currentInterval;
    } catch (e) {
        console.warn('Не удалось загрузить состояние:', e);
    }
}

/**
 * Переключает между графиками
 */
function toggleChartView() {
    if (currentView === 'energy') {
        currentView = 'invest';
        window.currentView = currentView;
        saveChartState();
        $('#battery_chart_panel').hide();
        $('#invest_panel').show();
        if (typeof window.InvestPlot !== 'undefined' && typeof window.InvestPlot.update === 'function') {
            window.InvestPlot.update();
        }
    } else {
        currentView = 'energy';
        window.currentView = currentView;
        saveChartState();
        $('#battery_chart_panel').show();
        $('#invest_panel').hide();
        if (typeof batteryLevel === 'function') {
            batteryLevel();
        }
    }

    // ✅ Обновляем текст кнопки
    // updateToggleButtonText();
    
    // Sync toggle checkbox
    const $toggle = $('#toggle-chart-btn');
    if ($toggle.length) {
        $toggle.prop('checked', currentView === 'energy');
    }
}

/**
 * Обновляет текст кнопки переключения
 */
// function updateToggleButtonText() {
//     const $btn = $('#toggle-chart-btn');
//     let text = '█';
//     let align = currentView === 'energy' ? 'left' : 'right'; 

//     if ($btn.length === 0) {
//         const $container = $('#volumeChart').parent();
//         $('<button></button>')
//             .attr('id', 'toggle-chart-btn')
//             .addClass('toggle-btn')
//             .css('text-align', align)
//             .text(text)
//             .on('click', toggleChartView)
//             .appendTo($container);
//     } else {
//         $btn.css('text-align', align);
//         $btn.text(text);
//     }
// }

/**
 * Переключает видимость модального окна со списком панелей
 */
function togglePanelsModal() {
    const $modal = $('#panels-modal');
    
    if ($modal.length > 0 && $modal.is(':visible')) {
        $modal.hide();
        return;
    }
    
    if ($modal.length === 0) {
        createPanelsModal();
        $('#panels-modal').show();
    } else {
        $modal.show();
    }
}

window.togglePanelsModal = togglePanelsModal;

/**
 * Создает настройки температуры (двойной слайдер)
 */
function createTempRangeSettings() {
    const saved = JSON.parse(localStorage.getItem('weather_panel_range') || '[-15, 25]');
    const $div = $('<div class="panel-settings temp-range-settings"></div>');
    
    const $valuesDisplay = $('<div class="temp-range-display">' + saved[0] + '°C ... ' + saved[1] + '°C</div>');
    const $sliderContainer = $('<div class="dual-range-slider"></div>');
    
    const $minSlider = $('<input type="range">').attr('class', 'range-min')
        .attr('min', -20).attr('max', 30).attr('step', 5).val(saved[0]);
    const $maxSlider = $('<input type="range">').attr('class', 'range-max')
        .attr('min', -20).attr('max', 30).attr('step', 5).val(saved[1]);
    const $track = $('<div class="range-track"></div>');
    
    $sliderContainer.append($track, $minSlider, $maxSlider);
    
    function updateRange() {
        let min = parseInt($minSlider.val());
        let max = parseInt($maxSlider.val());
        
        if (min > max - 5) { min = max - 5; $minSlider.val(min); }
        if (max < min + 5) { max = min + 5; $maxSlider.val(max); }
        
        const range = 50;
        const minPercent = ((min + 20) / range) * 100;
        const maxPercent = ((max + 20) / range) * 100;
        
        $track[0].style.left = minPercent + '%';
        $track[0].style.width = (maxPercent - minPercent) + '%';
        $valuesDisplay.text(min + '°C ... ' + max + '°C');
    }
    
    $minSlider.on('input', updateRange);
    $maxSlider.on('input', updateRange);
    
    const $applyBtn = $('<button class="apply-temp-range">✓</button>');
    $applyBtn.on('click', function() {
        const min = parseInt($minSlider.val());
        const max = parseInt($maxSlider.val());
        localStorage.setItem('weather_panel_range', JSON.stringify([min, max]));
        $(document).trigger('weatherTempRangeChange', [min, max]);
        
        const $label = $('[data-panel-label="weather_panel"]');
        if ($label.length) {
            $label.text('Погода');
        }
    });
    
    $div.append($valuesDisplay, $sliderContainer, $applyBtn);
    setTimeout(updateRange, 0);
    return $div;
}

/**
 * Создает модальное окно со списком панелей
 */
function createPanelsModal() {
    const panelNames = {
        'clock_panel': 'Часы',
        'date_panel': 'Дата',
        'moon_panel': 'Луна',
        'weather_panel': 'Погода',
        'press_humidity_temp_panel': 'Давление/Влажность/Темп',
        'wind_cond_precip_panel': 'Ветер/Осадки',
        'sun_panel': 'Солнце',
        'battery_indicator_panel': 'Батарея (индикатор)',
        'battery_chart_panel': 'Батарея (график)',
        'invest_panel': 'Инвестиции',
        'chart_control_panel': 'Панель управления'
    };
    
    const panelSettings = {
        'invest_panel': [
            { value: 'percent', label: '%' },
            { value: 'growth', label: 'Прирост' },
            { value: 'both', label: 'Оба' }
        ],
        'weather_panel': 'tempRange'
    };
    
    // Функция для создания настроек температуры
    
    const $modal = $('<div id="panels-modal" class="panels-modal"></div>');
    const $content = $('<div class="panels-modal-content"></div>');
    const $header = $('<div class="panels-modal-header"><h3>Панели</h3><button class="close-modal">&times;</button></div>');
    
    $content.append($header);
    
    Object.keys(panelNames).forEach(panelId => {
        const $row = $('<div class="panel-row"></div>');
        
        let labelText = panelNames[panelId];
        if (panelId === 'weather_panel') {
            const saved = JSON.parse(localStorage.getItem('weather_panel_range') || '[-15, 25]');
            labelText = 'Погода';
        }
        
        const $label = $('<span></span>').text(labelText).attr('data-panel-label', panelId);
        const $toggle = $('<label class="switch"></label>');
        const $checkbox = $('<input type="checkbox">').attr('data-panel', panelId);
        
        const panel = document.getElementById(panelId);
        const isVisible = panel && panel.style.display !== 'none';
        $checkbox.prop('checked', isVisible);
        
        $checkbox.on('change', function() {
            const p = document.getElementById(panelId);
            if (p) {
                p.style.display = this.checked ? '' : 'none';
            }
            // Save visibility state
            try {
                const config = JSON.parse(localStorage.getItem('wclock_panel_config') || '{}');
                config[panelId] = config[panelId] || {};
                config[panelId].visible = this.checked;
                localStorage.setItem('wclock_panel_config', JSON.stringify(config));
            } catch(e) {}
        });
        
        $toggle.append($checkbox);
        $toggle.append('<span class="slider"></span>');
        $row.append($label);
        
        // Добавляем выпадающий список для панелей с настройками
        if (panelSettings[panelId]) {
            const $settings = $('<div class="panel-settings"></div>');
            
            // Особый случай для диапазона температур
            if (panelSettings[panelId] === 'tempRange') {
                $settings.append(createTempRangeSettings());
            } else {
                // Стандартный select для других панелей
                const $select = $('<select class="panel-view-select"></select>').attr('data-panel', panelId);
                
                panelSettings[panelId].forEach(opt => {
                const $opt = $('<option></option>').attr('value', opt.value).text(opt.label);
                $select.append($opt);
            });
            
            // Загружаем сохраненное значение
            const savedValue = localStorage.getItem(panelId + '_view') || 'percent';
            $select.val(savedValue);
            
            $select.on('change', function() {
                localStorage.setItem(panelId + '_view', this.value);
                // Оповещаем об изменении
                $(document).trigger('panelViewChange', { panel: panelId, view: this.value });
            });
            
            $settings.append($select);
            } // end else
            
            $row.append($settings);
        }
        
        $row.append($toggle);
        $content.append($row);
    });
    
    $modal.append($content);
    $('body').append($modal);
    
    // Make modal draggable
    $header.css('cursor', 'move');
    
    let isDragging = false;
    let dragOffsetX, dragOffsetY;
    
    $header.on('mousedown', function(e) {
        if (e.target.classList.contains('close-modal')) return;
        isDragging = true;
        dragOffsetX = e.clientX - $modal[0].offsetLeft;
        dragOffsetY = e.clientY - $modal[0].offsetTop;
    });
    
    $(document).on('mousemove', function(e) {
        if (!isDragging) return;
        $modal.css('left', (e.clientX - dragOffsetX) + 'px');
        $modal.css('top', (e.clientY - dragOffsetY) + 'px');
    });
    
    $(document).on('mouseup', function() {
        isDragging = false;
    });
    
    $modal.find('.close-modal').on('click', function() {
        $modal.hide();
    });
    
    $modal.on('click', function(e) {
        if (e.target === $modal[0]) {
            $modal.hide();
        }
    });
}

// Инициализация
$(document).ready(function() {
    console.log('[Lib] Инициализация...');
    
    // Загружаем сохраненное состояние
    loadChartState();
    
    // Обновляем текст кнопки переключения
    if (typeof updateToggleButtonText === 'function') updateToggleButtonText();

    // Показываем/скрываем панель батареи в зависимости от режима
    if (currentView === 'energy') {
        $('#battery_chart_panel').show();
        $('#invest_panel').hide();
    } else {
        $('#battery_chart_panel').hide();
        $('#invest_panel').show();
    }

    // Рисуем график в зависимости от сохраненного состояния
    if (currentView === 'energy') {
        if (typeof batteryLevel === 'function') {
            batteryLevel();
        }
    } else {
        if (typeof window.InvestPlot !== 'undefined' && typeof window.InvestPlot.update === 'function') {
            window.InvestPlot.update();
        }
    }
});

