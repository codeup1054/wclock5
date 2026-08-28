/**
 * panel_resize.js
 * Drag and resize functionality for panels with cookie persistence
 * Configs are stored in panel_configs.js
 */

(function(window) {
    'use strict';

    const PANEL_COOKIE = 'wclock_panels';
    const EDIT_MODE_COOKIE = 'wclock_edit_mode';
    const PANEL_IDS = ['invest_panel', 'invest_panel_banner', 'weather_panel', 'battery_indicator_panel', 'battery_chart_panel', 'press_humidity_temp_panel', 'wind_cond_precip_panel', 'sun_panel', 'clock_panel', 'seconds_panel', 'date_panel', 'moon_panel', 'chart_control_panel'];
    // Default per-panel chart scales (0.0..1.0). Panels with charts: weather_panel, invest_panel
    const DEFAULT_PANEL_CHART_SCALES = {
        weather_panel: 1,
        invest_panel: 1,
        invest_panel_banner: 1,
        chart_control_panel: 1
    };

    // Use configs from panel_configs.js (loaded before this script)
    const DEFAULT_PANEL_CONFIG_DESKTOP = typeof PANEL_CONFIG_DESKTOP !== 'undefined' ? PANEL_CONFIG_DESKTOP : {};
    const DEFAULT_PANEL_CONFIG_TABLET = typeof PANEL_CONFIG_TABLET !== 'undefined' ? PANEL_CONFIG_TABLET : {};

    function getDefaultPanelConfig() {
        const width = window.innerWidth;
        if (width >= 1024) return DEFAULT_PANEL_CONFIG_DESKTOP;
        return DEFAULT_PANEL_CONFIG_TABLET;
    }

    const DEFAULT_PANEL_CONFIG = getDefaultPanelConfig();

    

    // Load panel positions from cookie
    function loadPanelConfig() {
        console.log('[EditMode] loadPanelConfig called, looking for:', PANEL_COOKIE);
        try {
            const saved = localStorage.getItem(PANEL_COOKIE);
            console.log('[EditMode] localStorage value:', saved);
            return saved ? JSON.parse(saved) : null;
        } catch (e) {
            console.warn('[PanelResize] Ошибка загрузки:', e);
            return null;
        }
    }

    // Save panel positions to cookie
    function savePanelConfig(config) {
        console.log('[EditMode] savePanelConfig called with:', config);
        try {
            localStorage.setItem(PANEL_COOKIE, JSON.stringify(config));
            console.log('[EditMode] Saved to localStorage:', PANEL_COOKIE);
        } catch (e) {
            console.warn('[PanelResize] Ошибка сохранения:', e);
        }
    }

    // Load edit mode from cookie
    function loadEditMode() {
        return localStorage.getItem(EDIT_MODE_COOKIE) === 'true';
    }

    // Save edit mode to cookie
    function saveEditMode(enabled) {
        localStorage.setItem(EDIT_MODE_COOKIE, enabled ? 'true' : 'false');
    }

    // Apply panel configuration
    function applyPanelConfig() {
        console.log('[EditMode] applyPanelConfig called');
        
        // First check localStorage
        const localConfig = loadPanelConfig();
        console.log('[EditMode] localConfig:', localConfig);
        if (localConfig) {
            console.log('[EditMode] Applying localStorage config');
            applyConfigToPanels(localConfig);
            return;
        }
        
        // If not in localStorage, try API with device_id
        const isDesktop = window.innerWidth >= 1024;
        const configType = isDesktop ? 'desktop' : 'tablet';
        const deviceId = typeof getOrCreateDeviceId === 'function' ? getOrCreateDeviceId() : 'default';
        console.log('[EditMode] deviceId:', deviceId, 'configType:', configType);
        
        fetch(`/api/panel_config/${deviceId}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Config not found');
                }
                return response.json();
            })
            .then(data => {
                console.log('[EditMode] DB config found:', data);
                const dbConfig = data.config_json;
                applyConfigToPanels(dbConfig);
                // Also save to localStorage for quick access
                savePanelConfig(dbConfig);
            })
            .catch(err => {
                console.log('[EditMode] No DB config, applying defaults:', err.message);
                applyDefaultPanelConfig();
            });
    }

    function applyConfigToPanels(config) {
        PANEL_IDS.forEach(panelId => {
            const panel = document.getElementById(panelId);
            if (!panel) return;

            const defaults = DEFAULT_PANEL_CONFIG[panelId] || {};
            const pos = config[panelId] || {};

            panel.style.top = pos.top || defaults.top || '';
            panel.style.left = pos.left || defaults.left || '';
            panel.style.width = pos.width || defaults.width || '';
            panel.style.height = pos.height || defaults.height || '';
            panel.style.right = pos.right || '';
            panel.style.bottom = pos.bottom || '';
            // Don't normalize - keep exact saved dimensions
            
            const visible = pos.visible !== undefined ? pos.visible : (defaults.visible !== false);
            panel.style.display = visible ? '' : 'none';
            
            const defaultScale = DEFAULT_PANEL_CHART_SCALES[panelId] || 1;
            panel.dataset.chartScale = defaultScale;
        });

        PANEL_IDS.forEach(panelId => {
            if (config[panelId]) return;
            const panel = document.getElementById(panelId);
            if (panel) applyDefaultPanel(panel, panelId);
        });
    }

    function applyDefaultPanel(panel, panelId) {
        const pos = DEFAULT_PANEL_CONFIG[panelId] || {};
        panel.style.top = pos.top || panel.style.top || '';
        panel.style.left = pos.left || panel.style.left || '';
        panel.style.width = pos.width || panel.style.width || '';
        panel.style.height = pos.height || panel.style.height || '';
        panel.style.right = '';
        panel.style.bottom = '';
        // Apply visibility
        panel.style.display = pos.visible !== false ? '' : 'none';
        // ensure default chart scale for this panel if charts are present
        panel.dataset.chartScale = DEFAULT_PANEL_CHART_SCALES[panelId] || 1;
        normalizePanelPosition(panel);
    }

    function applyDefaultPanelConfig() {
        PANEL_IDS.forEach(panelId => {
            const panel = document.getElementById(panelId);
            if (!panel) return;
            applyDefaultPanel(panel, panelId);
        });

        saveCurrentConfig();
    }

    function toNumberValue(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isNaN(parsed) ? fallback : parsed;
    }

function normalizePanelPosition(panel) {
        const minMargin = 5;
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;

        let top = toNumberValue(panel.style.top, minMargin);
        let left = toNumberValue(panel.style.left, minMargin);
        let width = toNumberValue(panel.style.width, panel.offsetWidth || 120);
        let height = toNumberValue(panel.style.height, panel.offsetHeight || 60);

        if (panel.style.right) panel.style.right = '';
        if (panel.style.bottom) panel.style.bottom = '';

        if (width > viewportW - minMargin * 2) {
            width = Math.max(80, viewportW - minMargin * 2);
        }
        if (height > viewportH - minMargin * 2) {
            height = Math.max(60, viewportH - minMargin * 2);
        }

        left = Math.max(minMargin, Math.min(left, Math.max(minMargin, viewportW - width - minMargin)));
        top = Math.max(minMargin, Math.min(top, Math.max(minMargin, viewportH - height - minMargin)));

        panel.style.top = `${Math.round(top)}px`;
        panel.style.left = `${Math.round(left)}px`;
        panel.style.width = `${Math.round(width)}px`;
        panel.style.height = `${Math.round(height)}px`;
    }

    // Adjust text sizes inside press_humidity_temp_panel to be proportional
    function adjustTextSizesForPressPanel(panel) {
        const p = panel || document.getElementById('press_humidity_temp_panel');
        if (!p) return;
        const ids = ['fact_pressure_mm','forecast_1_pressure_mm','fact_humidity','forecast_1_humidity','fact_temperature','fact_feels_like','forecast_1_temperature','forecast_1_feels_like'];
        const height = p.clientHeight || 100;
        const scale = Math.max(0.6, Math.min(1.2, height / 150));
        const base = 80;
        ids.forEach(id => {
            const el = p.querySelector('#' + id);
            if (el){
                el.style.fontSize = Math.round(base * scale) + 'px';
                el.style.lineHeight = Math.round(base * scale * 0.9) + 'px';
            }
            
        });
        const tempGroup = p.querySelector('#temp');
        if (tempGroup) {
            const inner = tempGroup.querySelectorAll('#fact_temperature, #fact_feels_like, #forecast_1_temperature, #forecast_1_feels_like');
            inner.forEach(node => {
                if (node) node.style.fontSize = Math.round(base * scale * 1.1) + 'px';
            });
        }
    }

    // Toggle fullscreen for a panel
    function toggleFullscreen(panel) {
        panel.classList.toggle('panel-fullscreen');
        
        if (panel.classList.contains('panel-fullscreen')) {
            panel.dataset.prevWidth = panel.style.width;
            panel.dataset.prevHeight = panel.style.height;
            panel.dataset.prevTop = panel.style.top;
            panel.dataset.prevLeft = panel.style.left;
            panel.dataset.prevRight = panel.style.right;
            panel.dataset.prevBottom = panel.style.bottom;
        } else {
            // Restore previous position
            if (panel.dataset.prevWidth) panel.style.width = panel.dataset.prevWidth;
            if (panel.dataset.prevHeight) panel.style.height = panel.dataset.prevHeight;
            if (panel.dataset.prevTop) panel.style.top = panel.dataset.prevTop;
            if (panel.dataset.prevLeft) panel.style.left = panel.dataset.prevLeft;
            if (panel.dataset.prevRight) panel.style.right = panel.dataset.prevRight;
            if (panel.dataset.prevBottom) panel.style.bottom = panel.dataset.prevBottom;
        }
        
        resizeCharts();
    }

    // Initialize fullscreen button for a panel
    function initFullscreenButton(panel) {
        const btn = document.createElement('div');
        btn.className = 'panel-fullscreen-btn';
        
        // Special case for charts - fullscreen works without edit mode
        if (panel.id === 'invest_panel' || panel.id === 'invest_panel_banner' || panel.id === 'weather_panel') {
            btn.classList.add('panel-fullscreen-btn-chart');
        }
        
        btn.innerHTML = '⛶';
        btn.title = 'Toggle fullscreen';
        
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleFullscreen(panel);
        });
        
        panel.appendChild(btn);
    }

    // Initialize resize handles for a panel (all edges and corners)
    function initResizeHandle(panel) {
        const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        
        handles.forEach(pos => {
            const handle = document.createElement('div');
            handle.className = 'panel-resize-handle panel-resize-' + pos;
            handle.dataset.pos = pos;
            panel.appendChild(handle);
        });

        let isResizing = false;
        let currentHandle = null;
        let startX, startY, startWidth, startHeight, startTop, startLeft;

        function onResizeStart(e) {
            if (!document.body.classList.contains('edit-mode')) return;
            if (panel.classList.contains('panel-fullscreen')) return;
            
            isResizing = true;
            currentHandle = e.target.dataset.pos;
            const pos = getClientPos(e);
            startX = pos.x;
            startY = pos.y;
            startWidth = panel.offsetWidth;
            startHeight = panel.offsetHeight;
            startTop = panel.offsetTop;
            startLeft = panel.offsetLeft;
            setButtonsDisabled(true);
            
            e.preventDefault();
            e.stopPropagation();
        }

        panel.querySelectorAll('.panel-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', onResizeStart);
            handle.addEventListener('touchstart', onResizeStart, { passive: false });
        });

        function onResizeMove(e) {
            if (!isResizing) return;
            
            const pos = getClientPos(e);
            const dx = pos.x - startX;
            const dy = pos.y - startY;
            const pos_ = currentHandle;
            
            // Width
            if (pos_.includes('e')) {
                panel.style.width = Math.max(50, startWidth + dx) + 'px';
            }
            if (pos_.includes('w')) {
                const newWidth = Math.max(50, startWidth - dx);
                panel.style.width = newWidth + 'px';
                panel.style.left = (startLeft + dx) + 'px';
            }
            
            // Height
            if (pos_.includes('s')) {
                panel.style.height = Math.max(30, startHeight + dy) + 'px';
            }
            if (pos_.includes('n')) {
                const newHeight = Math.max(30, startHeight - dy);
                panel.style.height = newHeight + 'px';
                panel.style.top = (startTop + dy) + 'px';
            }
            
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        document.addEventListener('mousemove', onResizeMove);
        document.addEventListener('touchmove', onResizeMove, { passive: false });

        function onResizeEnd() {
            if (!isResizing) return;
            isResizing = false;
            currentHandle = null;
            setButtonsDisabled(false);
            normalizePanelPosition(panel);
            resizeCharts();
        }

        document.addEventListener('mouseup', onResizeEnd);
        document.addEventListener('touchend', onResizeEnd);
    }

    // Initialize drag functionality
    function initDrag(panel) {
        let isDragging = false;
        let startX, startY, startTop, startLeft;

        function onDragStart(e) {
            if (!document.body.classList.contains('edit-mode')) return;
            if (e.target.classList.contains('panel-fullscreen-btn')) return;
            if (e.target.classList.contains('panel-resize-handle')) return;
            if (panel.classList.contains('panel-fullscreen')) return;
            
            isDragging = true;
            panel.classList.add('dragging');
            
            const pos = getClientPos(e);
            startX = pos.x;
            startY = pos.y;
            startTop = panel.offsetTop;
            startLeft = panel.offsetLeft;
            setButtonsDisabled(true);
            
            e.preventDefault();
        }

        panel.addEventListener('mousedown', onDragStart);
        panel.addEventListener('touchstart', onDragStart, { passive: false });

        function onDragMove(e) {
            if (!isDragging) return;
            
            const pos = getClientPos(e);
            const dx = pos.x - startX;
            const dy = pos.y - startY;
            
            panel.style.top = (startTop + dy) + 'px';
            panel.style.left = (startLeft + dx) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('touchmove', onDragMove, { passive: false });

        function onDragEnd() {
            if (!isDragging) return;
            
            isDragging = false;
            panel.classList.remove('dragging');
            setButtonsDisabled(false);
            normalizePanelPosition(panel);
            resizeCharts();
        }

        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchend', onDragEnd);
    }

    function capturePanelConfig() {
        const config = {};
        PANEL_IDS.forEach(id => {
            const panel = document.getElementById(id);
            if (!panel) return;
            const isVisible = panel.style.display !== 'none';
            config[id] = {
                top: panel.style.top || '',
                left: panel.style.left || '',
                right: panel.style.right || '',
                bottom: panel.style.bottom || '',
                width: panel.style.width || '',
                height: panel.style.height || '',
                visible: isVisible
            };
        });
        return config;
    }

    // Save current configuration
    function saveCurrentConfig() {
        console.log('[EditMode] saveCurrentConfig called');
        const config = capturePanelConfig();

        console.log('[EditMode] Config to save:', config);
        
        // Save to localStorage
        savePanelConfig(config);
        
        // Save to database
        if (typeof window.savePanelConfigToDb === 'function') {
            window.savePanelConfigToDb();
        }
    }

    // Toggle edit mode
    function toggleEditMode() {
        console.log('[EditMode] toggleEditMode called');
        const body = document.body;
        const btn = document.getElementById('edit_mode_btn');
        const wasEdit = body.classList.contains('edit-mode');
        const isEdit = body.classList.toggle('edit-mode');
        
        console.log('[EditMode] wasEdit:', wasEdit, 'isEdit:', isEdit);
        
        if (btn) {
            btn.classList.toggle('active', isEdit);
        }
        
        if (wasEdit && !isEdit) {
            // Show custom modal instead of confirm()
            showSaveModal();
        }
        
        saveEditMode(isEdit);
    }
    
    // Custom modal for save confirmation
    function showSaveModal() {
        const existing = document.getElementById('save-confirm-modal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.id = 'save-confirm-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 20000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        
        const content = document.createElement('div');
        content.style.cssText = `
            background: #1a1a2e;
            border: 2px solid #ffd700;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            color: #fff;
        `;
        
        content.innerHTML = '<p style="margin-bottom:20px;font-size:16px;">Сохранить изменения панелей?</p>';
        
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display:flex;gap:10px;justify-content:center;';
        
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Сохранить';
        saveBtn.style.cssText = 'background:#2cba99;border:none;border-radius:4px;color:#fff;padding:8px 16px;cursor:pointer;font-size:14px;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Отмена';
        cancelBtn.style.cssText = 'background:#444;border:none;border-radius:4px;color:#fff;padding:8px 16px;cursor:pointer;font-size:14px;';
        
        saveBtn.onclick = function() {
            console.log('[EditMode] User chose to save, calling saveCurrentConfig');
            saveCurrentConfig();
            modal.remove();
        };
        
        cancelBtn.onclick = function() {
            console.log('[EditMode] User chose to cancel, reloading');
            modal.remove();
            location.reload();
        };
        
        btnContainer.appendChild(saveBtn);
        btnContainer.appendChild(cancelBtn);
        content.appendChild(btnContainer);
        modal.appendChild(content);
        document.body.appendChild(modal);
    }

    // Reset panels to default positions
    function resetPanels() {
        localStorage.removeItem(PANEL_COOKIE);

        PANEL_IDS.forEach(id => {
            const pos = DEFAULT_PANEL_CONFIG[id];
            const panel = document.getElementById(id);
            if (!panel) return;
            if (!pos) return;
            
            panel.style.top = pos.top;
            panel.style.left = pos.left;
            panel.style.width = pos.width;
            panel.style.height = pos.height;
            panel.style.right = '';
            panel.style.bottom = '';
            normalizePanelPosition(panel);
        });
        
        saveCurrentConfig();
        resizeCharts();
    }

    // Initialize reset button
    function initResetButton() {
        const resetBtn = document.getElementById('reset_panels_btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', resetPanels);
        }

        const exportBtn = document.getElementById('export_panels_btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', doExportPanels);
        }
    }

    // Content scaling for panels during resize
    const PANEL_CONTENT_SELECTORS = {
        'wind_cond_precip_panel': '#wind_cond_precip',
        'press_humidity_temp_panel': '#press_humidity_temp',
        'sun_panel': '#sun',
        'clock_panel': '#clock',
        'date_panel': '#day',
        'moon_panel': '#moon_phase'
    };
    
    const PANEL_BASE_SIZES = {
        'wind_cond_precip_panel': { width: 457, height: 179 },
        'press_humidity_temp_panel': { width: 469, height: 172 },
        'sun_panel': { width: 492, height: 58 },
        'clock_panel': { width: 445, height: 167 },
        'moon_panel': { width: 200, height: 200 }
    };
    
    function initContentScaling(panel) {
        if (panel.id === 'clock_panel') {
            const observer = new ResizeObserver(() => {
                adjustClockFontSize();
            });
            observer.observe(panel);
            return;
        }

        const contentSelector = PANEL_CONTENT_SELECTORS[panel.id];
        if (!contentSelector) return;
        
        const content = panel.querySelector(contentSelector);
        if (!content) return;
        
        const baseSize = PANEL_BASE_SIZES[panel.id] || { width: 400, height: 150 };
        
        const observer = new ResizeObserver(entries => {
            for (let entry of entries) {
                const scaleX = entry.contentRect.width / baseSize.width;
                const scaleY = entry.contentRect.height / baseSize.height;
                const scale = Math.min(scaleX, scaleY, 1.5); // max scale 1.5
                
                content.style.transform = `scale(${scale})`;
                content.style.transformOrigin = 'top left';
                content.style.width = baseSize.width + 'px';
                content.style.height = baseSize.height + 'px';
            }
        });
        
        observer.observe(panel);
    }
    
    // Initialize all panels
    function initPanels() {
        PANEL_IDS.forEach(id => {
            const panel = document.getElementById(id);
            if (!panel) return;
            
            panel.classList.add('clock-panel');
            if (panel.id === 'weather_panel') {
                panel.addEventListener('click', function(e) {
                    e.stopPropagation();
                });
            }
            const defaultScale = DEFAULT_PANEL_CHART_SCALES[id] || 1;
            panel.dataset.chartScale = defaultScale;
            initFullscreenButton(panel);
            initResizeHandle(panel);
            initDrag(panel);
            initContentScaling(panel);
        });
        
        // Apply saved configuration
        applyPanelConfig();
        
        // Set edit mode from cookie
        const editMode = loadEditMode();
        if (editMode) {
            document.body.classList.add('edit-mode');
            const btn = document.getElementById('edit_mode_btn');
            if (btn) btn.classList.add('active');
        }
    }

    // Toggle chart-control-panel collapse
    function toggleControlPanelCollapse() {
        const panel = document.querySelector('.chart-control-panel');
        const btn = document.querySelector('.collapse-btn');
        if (panel) {
            const isCollapsed = panel.classList.toggle('collapsed');
            if (btn) {
                btn.textContent = isCollapsed ? '▶' : '◀';
                btn.dataset.collapsed = isCollapsed ? 'true' : 'false';
            }
        }
    }

    // Initialize edit mode button
    function initEditButton() {
        const btn = document.getElementById('edit_mode_btn');
        
        if (btn) {
            btn.addEventListener('click', toggleEditMode);
            btn.addEventListener('touchend', function(e) {
                e.preventDefault();
                toggleEditMode();
            });
        }
        
        // Collapse buttons
        const collapseBtns = document.querySelectorAll('.collapse-btn');
        collapseBtns.forEach(btn => {
            btn.addEventListener('click', toggleControlPanelCollapse);
        });
    }

    function adjustClockFontSize() {
        const panel = document.getElementById('clock_panel');
        if (!panel) return;
        const clock = document.getElementById('clock');
        if (!clock) return;
        const w = panel.clientWidth;
        const h = panel.clientHeight;
        if (w < 10 || h < 10) return;
        const fontSize = Math.max(12, Math.min(w * 0.85, h * 0.85));
        clock.style.fontSize = fontSize + 'px';
    }

    let _resizeRAF = null;

    function resizeCharts() {
        if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
        _resizeRAF = requestAnimationFrame(() => {
            _resizeRAF = null;
            if (typeof $ !== 'undefined') {
                $(document).trigger('weatherChartResize');
            }
            adjustTextSizesForPressPanel();
            adjustClockFontSize();
        });
    }

    // Initialize on DOM ready
    function init() {
        initPanels();
        initEditButton();
        initResetButton();
        
        setTimeout(resizeCharts, 100);
        window.addEventListener('resize', resizeCharts);
    }

    // Export functions for buttons
    function doExportPanels() {
        const config = {};
        PANEL_IDS.forEach(id => {
            const panel = document.getElementById(id);
            if (!panel) return;
            
            config[id] = {
                top: panel.style.top || '',
                left: panel.style.left || '',
                right: panel.style.right || '',
                bottom: panel.style.bottom || '',
                width: panel.style.width || '',
                height: panel.style.height || ''
            };
        });

        // Create tablet config with scale 0.7
        const tabletConfig = {};
        Object.keys(config).forEach(key => {
            const c = config[key];
            tabletConfig[key] = {
                top: c.top,
                left: c.left,
                right: c.right,
                bottom: c.bottom,
                width: c.width ? Math.round(parseInt(c.width) * 0.7) + 'px' : '',
                height: c.height ? Math.round(parseInt(c.height) * 0.7) + 'px' : ''
            };
        });

        const output = `/**
 * panel_configs.js
 * Panel configurations for different device types
 */

const PANEL_CONFIG_DESKTOP = ${JSON.stringify(config, null, 4)};

const PANEL_CONFIG_TABLET = ${JSON.stringify(tabletConfig, null, 4)};
`;
        
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(output);
            console.log('Configs copied to clipboard! Save to panel_configs.js');
        } else {
            console.log(output);
        }
    }

    // Save panel config to database
    function doSavePanelConfigToDb() {
        const config = {};
        PANEL_IDS.forEach(id => {
            const panel = document.getElementById(id);
            if (!panel) return;
            
            const isVisible = panel.style.display !== 'none';
            
            config[id] = {
                top: panel.style.top || '',
                left: panel.style.left || '',
                right: panel.style.right || '',
                bottom: panel.style.bottom || '',
                width: panel.style.width || '',
                height: panel.style.height || '',
                visible: isVisible
            };
        });

        // Detect device type
        const isDesktop = window.innerWidth >= 1024;
        const configType = isDesktop ? 'desktop' : 'tablet';
        const deviceId = typeof getOrCreateDeviceId === 'function' ? getOrCreateDeviceId() : 'default';

        // Save to database with device_id
        fetch(`/api/panel_config/${deviceId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                config_type: configType,
                config_json: config 
            })
        })
        .then(response => response.json())
        .then(data => {
            console.log('Config saved to DB for device:', deviceId, 'type:', configType);
            // Also save to localStorage
            savePanelConfig(config);
        })
        .catch(err => {
            console.error('Error saving config to DB:', err);
        });
    }

    // Export
    window.PanelResize = {
        init: init,
        toggleEditMode: toggleEditMode,
        toggleFullscreen: toggleFullscreen,
        saveConfig: saveCurrentConfig,
        resetPanels: resetPanels,
        resizeCharts: resizeCharts,
        capturePanelConfig: capturePanelConfig,
        applyConfigToPanels: applyConfigToPanels,
        savePanelConfig: savePanelConfig,
        loadPanelConfig: loadPanelConfig,
        applyDefaultPanelConfig: applyDefaultPanelConfig
    };

    window.exportPanels = doExportPanels;
    window.savePanelConfigToDb = doSavePanelConfigToDb;

})(window);
