// static/js/lib.js — shared utilities

// Global state
let currentView = 'invest';
let currentInterval = 'hour';

// Настройки в cookie (на случай если localStorage не сохраняется на планшете)
function getSetting(name, def) {
    var val = getCookie(name);
    return val !== null ? val : def;
}
function setSetting(name, value, days) {
    setCookie(name, value, days || 365);
}

// Сохранение/загрузка настроек на сервер (по device_id)
function saveSettingsToServer(settingsObj) {
    var deviceId = typeof getOrCreateDeviceId === 'function' ? getOrCreateDeviceId() : '';
    if (!deviceId) return;
    try {
        fetch('/api/user_settings/' + encodeURIComponent(deviceId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: settingsObj })
        }).catch(function(err) {
            console.warn('saveSettingsToServer error:', err);
        });
    } catch(e) {
        console.warn('saveSettingsToServer error:', e);
    }
}

function loadSettingsFromServer(callback) {
    var deviceId = typeof getOrCreateDeviceId === 'function' ? getOrCreateDeviceId() : '';
    if (!deviceId) { if (callback) callback({}); return; }
    fetch('/api/user_settings/' + encodeURIComponent(deviceId))
        .then(function(r) { return r.json(); })
        .then(function(settings) {
            if (callback) callback(settings);
        })
        .catch(function(err) {
            console.warn('loadSettingsFromServer error:', err);
            if (callback) callback({});
        });
}

window.currentView = currentView;

// --- DPR / Canvas helpers ---

function getSafeDPR(maxDPI) {
    return Math.min(window.devicePixelRatio || 1, maxDPI || 2.0);
}

function setupCanvasForDPR(canvas, container, maxDPI) {
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = getSafeDPR(maxDPI);
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const bufferWidth = Math.floor(cssWidth * dpr);
    const bufferHeight = Math.floor(cssHeight * dpr);
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = bufferWidth;
    canvas.height = bufferHeight;
    return { cssWidth, cssHeight, bufferWidth, bufferHeight, dpr };
}

function destroyChartSafe(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    try {
        const existing = Chart.getChart(canvas);
        if (existing) existing.destroy();
    } catch (e) { /* ignore */ }
}

// --- Touch / Mouse helpers ---

function getClientPos(e) {
    if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
}

// --- Debounce / Throttle ---

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function throttle(func, limit) {
    let inThrottle = false;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => { inThrottle = false; }, limit);
        }
    };
}

// --- Button disable helper (for drag/resize) ---

function setButtonsDisabled(disabled) {
    const fullscreen = document.getElementById('fullscreen');
    const reload = document.getElementById('reload');
    if (fullscreen) fullscreen.classList.toggle('panel-dragging', disabled);
    if (reload) reload.classList.toggle('panel-dragging', disabled);
}

// --- Logger ---

window.log = function (msg, consoleLog = true) {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('log') !== '1') return;
    const now = new Date().toLocaleTimeString();
    if (consoleLog) console.log('log:', msg);
    const _msg = JSON.stringify(msg, null, 2);
    $('#console').prepend(`<div>[${now}] ${_msg}</div>`);
    const $divs = $('#console div');
    if ($divs.length > 70) $divs.last().remove();
};

/**
 * Сохраняет состояние в cookie
 */
function saveChartState() {
    try {
        setSetting('chartView', currentView);
        setSetting('chartInterval', currentInterval);
    } catch (e) {
        console.warn('Не удалось сохранить состояние:', e);
    }
}

/**
 * Загружает состояние из cookie
 */
function loadChartState() {
    try {
        const savedView = getSetting('chartView');
        const savedInterval = getSetting('chartInterval');
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
    const saved = JSON.parse(getSetting('weather_panel_range') || '[-15, 25]');
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
        setSetting('weather_panel_range', JSON.stringify([min, max]));
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
        'invest_banner': 'Инвестиции (баннер)',
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
    const saved = JSON.parse(getSetting('weather_panel_range') || '[-15, 25]');
            labelText = 'Погода';
        }
        
        const $label = $('<span></span>').text(labelText).attr('data-panel-label', panelId);
        const $toggle = $('<label class="switch"></label>');
        const $checkbox = $('<input type="checkbox">').attr('data-panel', panelId);
        
        const panel = document.getElementById(panelId);
        const isVisible = panel && panel.style.display !== 'none' && getComputedStyle(panel).display !== 'none';
        $checkbox.prop('checked', isVisible);
        
        $checkbox.on('change', function() {
            const p = document.getElementById(panelId);
            if (p) {
                const display = panelId === 'invest_banner' ? 'flex' : 'block';
                p.style.display = this.checked ? display : 'none';
            }
            if (this.checked) {
                if (panelId === 'battery_chart_panel' && typeof batteryLevel === 'function') {
                    var bp = document.getElementById('battery_chart_panel');
                    var cv = document.getElementById('volumeChart');
                    console.warn('[BatteryChart] включён', {
                        panel: bp ? { top: bp.style.top, left: bp.style.left, w: bp.offsetWidth, h: bp.offsetHeight } : null,
                        canvas: cv ? { w: cv.offsetWidth, h: cv.offsetHeight, dpr: window.devicePixelRatio } : null,
                        interval: window.currentInterval || 'hour'
                    });
                    setTimeout(batteryLevel, 500);
                }
                if (panelId === 'invest_panel' && typeof window.InvestPlot !== 'undefined' && typeof window.InvestPlot.update === 'function') {
                    window.InvestPlot.update();
                }
            }
            // Save visibility state to cookie
            try {
                const config = JSON.parse(getSetting('wclock_panel_config') || '{}');
                config[panelId] = config[panelId] || {};
                config[panelId].visible = this.checked;
                setSetting('wclock_panel_config', JSON.stringify(config));
                // Also save to server
                saveSettingsToServer({ wclock_panel_config: JSON.stringify(config) });
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
                // Для инвестиций — чекбоксы вместо select
            if (panelId === 'invest_panel') {
                var $timeLabel = $('<label class="extrema-toggle"><input type="checkbox" id="invest_time"> время</label>');
                var timeEnabled = getSetting('invest_panel_time', '1') !== '0';
                $timeLabel.find('input').prop('checked', timeEnabled);
                $timeLabel.find('input').on('change', function() {
                    setSetting('invest_panel_time', this.checked ? '1' : '0');
                    saveSettingsToServer({ invest_panel_time: this.checked ? '1' : '0' });
                    $(document).trigger('panelViewChange', { panel: panelId, view: 'mode' });
                });
                $settings.append($timeLabel);

                var $changeLabel = $('<label class="extrema-toggle"><input type="checkbox" id="invest_change"> изменения размера портфеля</label>');
                var changeEnabled = getSetting('invest_panel_change', '1') !== '0';
                $changeLabel.find('input').prop('checked', changeEnabled);
                $changeLabel.find('input').on('change', function() {
                    setSetting('invest_panel_change', this.checked ? '1' : '0');
                    saveSettingsToServer({ invest_panel_change: this.checked ? '1' : '0' });
                    $(document).trigger('panelViewChange', { panel: panelId, view: 'mode' });
                });
                $settings.append($changeLabel);

                // Экстремумы
                var $extremaLabel = $('<label class="extrema-toggle"><input type="checkbox" id="extrema-toggle"> Экстремумы</label>');
                var extremaEnabled = getSetting('invest_panel_extrema', '0') !== '0';
                $extremaLabel.find('input').prop('checked', extremaEnabled);
                $extremaLabel.find('input').on('change', function() {
                    setSetting('invest_panel_extrema', this.checked ? '1' : '0');
                    saveSettingsToServer({ invest_panel_extrema: this.checked ? '1' : '0' });
                    $(document).trigger('panelViewChange', { panel: panelId, view: 'extrema' });
                });
                $settings.append($extremaLabel);

                // Interval period
                var $periodLabel = $('<label class="extrema-toggle" style="margin-top:8px">Период: </label>');
                var $periodSelect = $('<select class="panel-view-select" style="margin-left:4px"></select>');
                var periodOpts = [
                    { value: '-90 day', label: '3 месяца' },
                    { value: '-35 day', label: '5 недель' },
                    { value: '-7 day', label: '1 неделя' },
                    { value: '-1 day', label: '1 день' }
                ];
                periodOpts.forEach(function(opt) {
                    $periodSelect.append($('<option></option>').attr('value', opt.value).text(opt.label));
                });
                var savedPeriod = getSetting('invest_panel_period', '-35 day');
                $periodSelect.val(savedPeriod);
                $periodSelect.on('change', function() {
                    setSetting('invest_panel_period', this.value);
                    saveSettingsToServer({ invest_panel_period: this.value });
                    $(document).trigger('panelViewChange', { panel: 'invest_panel', view: 'period' });
                });
                $periodLabel.append($periodSelect);
                $settings.append($periodLabel);
            } else if (panelId === 'battery_chart_panel') {
                var $batPeriodLabel = $('<label class="extrema-toggle" style="margin-top:8px">Период: </label>');
                var $batPeriodSelect = $('<select class="panel-view-select" style="margin-left:4px"></select>');
                var batPeriodOpts = [
                    { value: '-1 day', label: '1 день' },
                    { value: '-7 day', label: '1 неделя' },
                    { value: '-35 day', label: '5 недель' },
                    { value: '-90 day', label: '3 месяца' }
                ];
                batPeriodOpts.forEach(function(opt) {
                    $batPeriodSelect.append($('<option></option>').attr('value', opt.value).text(opt.label));
                });
                var savedBatPeriod = getSetting('battery_chart_period', '-7 day');
                $batPeriodSelect.val(savedBatPeriod);
                $batPeriodSelect.on('change', function() {
                    setSetting('battery_chart_period', this.value);
                    saveSettingsToServer({ battery_chart_period: this.value });
                    if (typeof window.updateBatteryChart === 'function') {
                        window.updateBatteryChart();
                    }
                });
                $batPeriodLabel.append($batPeriodSelect);
                $settings.append($batPeriodLabel);
            } else {
                // Стандартный select для других панелей
                const $select = $('<select class="panel-view-select"></select>').attr('data-panel', panelId);
                
                panelSettings[panelId].forEach(opt => {
                const $opt = $('<option></option>').attr('value', opt.value).text(opt.label);
                $select.append($opt);
            });
            
            // Загружаем сохраненное значение
            const savedValue = getSetting(panelId + '_view', 'percent');
            $select.val(savedValue);
            
            $select.on('change', function() {
                setSetting(panelId + '_view', this.value);
                $(document).trigger('panelViewChange', { panel: panelId, view: this.value });
            });
            
            $settings.append($select);
            }

            } // end else
            
            $row.append($settings);
        }
        
        $row.append($toggle);
        $content.append($row);
    });
    
    // Глобальная настройка DPI для графиков
    var $dpiRow = $('<div class="panel-row"><span>DPI графиков</span></div>');
    var $dpiSlider = $('<input type="range" min="1" max="6" step="0.5" value="' + (getSetting('chart_dpi', '2')) + '" style="width:80px">');
    var $dpiVal = $('<span style="min-width:24px;text-align:center;color:#ffd700">' + $dpiSlider.val() + '</span>');
    $dpiSlider.on('input', function() {
        $dpiVal.text(this.value);
        setSetting('chart_dpi', this.value);
        saveSettingsToServer({ chart_dpi: this.value });
        $(document).trigger('dpiChange', { dpi: parseFloat(this.value) });
    });
    $dpiRow.append($dpiSlider, $dpiVal);
    $content.append($dpiRow);

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
    
    // Применяем сохранённую видимость панелей (из модалки ☰)
    try {
        var savedConfig = JSON.parse(getSetting('wclock_panel_config') || '{}');
        Object.keys(savedConfig).forEach(function(panelId) {
            var p = document.getElementById(panelId);
            if (!p || !savedConfig[panelId]) return;
            p.style.display = savedConfig[panelId].visible ? '' : 'none';
        });
    } catch(e) {}

    // Догружаем настройки с сервера (перезаписывают cookie)
    loadSettingsFromServer(function(serverSettings) {
        if (serverSettings.wclock_panel_config) {
            try {
                var serverConfig = JSON.parse(serverSettings.wclock_panel_config);
                Object.keys(serverConfig).forEach(function(panelId) {
                    var p = document.getElementById(panelId);
                    if (!p || !serverConfig[panelId]) return;
                    p.style.display = serverConfig[panelId].visible ? '' : 'none';
                });
            } catch(e) {}
        }
        // Применяем остальные настройки с сервера (перезаписывают cookie)
        ['chart_dpi', 'invest_panel_extrema'].forEach(function(key) {
            if (serverSettings[key] !== undefined) {
                setSetting(key, serverSettings[key]);
            }
        });
    });

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

    // Если панель батареи видна — рисуем график
    var $batteryPanel = document.getElementById('battery_chart_panel');
    if ($batteryPanel && $batteryPanel.style.display !== 'none' && typeof batteryLevel === 'function') {
        setTimeout(batteryLevel, 500);
    }
});

