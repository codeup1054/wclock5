// static/js/panel_profiles.js — профили настроек панелей
// Хранение: localStorage + сервер (user_settings). Профиль = позиции + размеры + видимость.

(function (window) {
    'use strict';

    const PROFILES_KEY = 'wclock_panel_profiles';

    function defaults() {
        const config = (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.capturePanelConfig === 'function')
            ? window.PanelResize.capturePanelConfig()
            : {};
        return {
            active: 'v1',
            profiles: [
                { name: 'Вариант 1', config: JSON.parse(JSON.stringify(config)) },
                { name: 'Вариант 2', config: JSON.parse(JSON.stringify(config)) }
            ]
        };
    }

    function loadProfiles() {
        let data = null;
        try {
            const raw = localStorage.getItem(PROFILES_KEY);
            if (raw) data = JSON.parse(raw);
        } catch (e) {
            console.warn('[PanelProfiles] load error:', e);
        }
        if (!data || !Array.isArray(data.profiles) || !data.profiles.length) {
            data = defaults();
        }
        return data;
    }

    function saveProfiles(data) {
        try {
            localStorage.setItem(PROFILES_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('[PanelProfiles] save error:', e);
        }
        saveSettingsToServer({ wclock_panel_profiles: JSON.stringify(data) });
    }

    function currentConfig() {
        if (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.capturePanelConfig === 'function') {
            return window.PanelResize.capturePanelConfig();
        }
        return {};
    }

    // Объединить профили с сервера (серверные добавляются, локальные приоритетнее по имени)
    function mergeFromServer(raw) {
        if (!raw) return;
        let server = null;
        try {
            server = JSON.parse(raw);
        } catch (e) {
            console.warn('[PanelProfiles] merge parse error:', e);
            return;
        }
        if (!server || !Array.isArray(server.profiles) || !server.profiles.length) return;
        let local = null;
        try {
            const lr = localStorage.getItem(PROFILES_KEY);
            if (lr) local = JSON.parse(lr);
        } catch (e) {}
        if (!local || !local.profiles || !local.profiles.length) {
            saveProfiles(server);
            return;
        }
        const localNames = local.profiles.map(function (p) { return p.name; });
        const merged = { profiles: local.profiles.slice() };
        server.profiles.forEach(function (sp) {
            if (localNames.indexOf(sp.name) === -1) merged.profiles.push(sp);
        });
        merged.active = local.active || server.active || (merged.profiles[0] ? merged.profiles[0].name : '');
        saveProfiles(merged);
    }

    function configsEqual(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    // Применить профиль с подтверждением, если есть несохранённые изменения
    function applyProfile(id, opts) {
        opts = opts || {};
        const data = loadProfiles();
        const profile = data.profiles.find(function (p) { return p.name === id; }) || data.profiles[0];
        if (!profile) return;

        const doApply = function () {
            if (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.applyConfigToPanels === 'function') {
                window.PanelResize.applyConfigToPanels(profile.config);
            }
            if (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.savePanelConfig === 'function') {
                window.PanelResize.savePanelConfig(profile.config);
            }
            data.active = profile.name;
            saveProfiles(data);
            syncVisibilityCheckboxes(profile.config);
            setTimeout(function () {
                if (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.resizeCharts === 'function') {
                    window.PanelResize.resizeCharts();
                }
                // Баннер: если любая из панелей видима — перерисовать контент
                if (typeof window.InvestBanner !== 'undefined' && typeof window.InvestBanner.update === 'function') {
                    const cap = document.getElementById('invest_banner_capital');
                    const tbl = document.getElementById('invest_banner_table');
                    if ((cap && cap.style.display !== 'none') || (tbl && tbl.style.display !== 'none')) {
                        window.InvestBanner.update();
                    }
                }
            }, 50);
            if (opts.done) opts.done();
        };

        if (!opts.force && !configsEqual(currentConfig(), profile.config)) {
            showConfirm(
                'Применить профиль «' + profile.name + '»?',
                'Текущая раскладка не сохранена. Применить сохранённые настройки?',
                doApply
            );
            return;
        }
        doApply();
    }

    // Сохранить текущую раскладку в профиль
    function saveCurrentToProfile(name) {
        const data = loadProfiles();
        const cfg = currentConfig();
        const existing = data.profiles.find(function (p) { return p.name === name; });
        if (existing) {
            existing.config = cfg;
        } else {
            data.profiles.push({ name: name, config: cfg });
        }
        data.active = name;
        saveProfiles(data);
    }

    // Обновить активный профиль текущей раскладкой
    function saveCurrentToActive() {
        const data = loadProfiles();
        const active = data.profiles.find(function (p) { return p.name === data.active; }) || data.profiles[0];
        active.config = currentConfig();
        saveProfiles(data);
    }

    // Удалить профиль по имени (нельзя удалить последний)
    function deleteProfile(name) {
        const data = loadProfiles();
        if (data.profiles.length <= 1) return false;
        const idx = data.profiles.findIndex(function (p) { return p.name === name; });
        if (idx === -1) return false;
        data.profiles.splice(idx, 1);
        if (data.active === name) {
            data.active = data.profiles[0].name;
        }
        saveProfiles(data);
        return true;
    }

    // Синхронизировать чекбоксы видимости в модалке с конфигом
    function syncVisibilityCheckboxes(config) {
        if (!config) return;
        // Старые ключи единого баннера -> новая панель таблицы
        if (config.invest_panel_banner && !config.invest_banner_table) {
            config = JSON.parse(JSON.stringify(config));
            config.invest_banner_table = config.invest_panel_banner;
        }
        if (config.invest_banner && !config.invest_banner_table) {
            config = JSON.parse(JSON.stringify(config));
            config.invest_banner_table = config.invest_banner;
        }
        Object.keys(config).forEach(function (panelId) {
            var cb = document.querySelector('input[data-panel="' + panelId + '"]');
            if (!cb || !(panelId in config)) return;
            var visible = config[panelId].visible !== undefined ? config[panelId].visible : true;
            cb.checked = !!visible;
        });
    }

    // Обновить видимость панели в активном профиле (+ синхронизация wclock_panels, чтобы F5 не откатывал)
    function updateVisibility(panelId, visible) {
        // Старые ключи единого баннера -> панель таблицы
        if (panelId === 'invest_panel_banner' || panelId === 'invest_banner') panelId = 'invest_banner_table';
        const data = loadProfiles();
        const active = data.profiles.find(function (p) { return p.name === data.active; }) || data.profiles[0];
        active.config = active.config || {};
        active.config[panelId] = active.config[panelId] || {};
        active.config[panelId].visible = !!visible;
        saveProfiles(data);

        // Синхронизация с wclock_panels (применяется при загрузке страницы)
        if (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.capturePanelConfig === 'function' && typeof window.PanelResize.savePanelConfig === 'function') {
            const full = window.PanelResize.capturePanelConfig();
            if (full[panelId]) {
                full[panelId].visible = !!visible;
                window.PanelResize.savePanelConfig(full);
            }
        }
    }

    function showConfirm(title, text, onYes) {
        const existing = document.getElementById('pp-confirm-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'pp-confirm-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:21000;display:flex;align-items:center;justify-content:center;';
        const content = document.createElement('div');
        content.style.cssText = 'background:#1a1a2e;border:2px solid #ffd700;border-radius:12px;padding:20px;text-align:center;color:#fff;max-width:340px;';
        content.innerHTML = '<p style="margin-bottom:4px;font-size:16px;">' + title + '</p>' +
            '<p style="margin:0 0 20px;font-size:13px;color:#aaa;">' + text + '</p>';
        const btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display:flex;gap:10px;justify-content:center;';
        const yes = document.createElement('button');
        yes.textContent = 'Да';
        yes.style.cssText = 'background:#2cba99;border:none;border-radius:4px;color:#fff;padding:8px 16px;cursor:pointer;font-size:14px;';
        const no = document.createElement('button');
        no.textContent = 'Отмена';
        no.style.cssText = 'background:#444;border:none;border-radius:4px;color:#fff;padding:8px 16px;cursor:pointer;font-size:14px;';
        yes.onclick = function () { modal.remove(); if (onYes) onYes(); };
        no.onclick = function () { modal.remove(); };
        btnWrap.appendChild(yes);
        btnWrap.appendChild(no);
        content.appendChild(btnWrap);
        modal.appendChild(content);
        document.body.appendChild(modal);
    }

    // Быстрый тост-фидбек
    function toast(msg) {
        const existing = document.getElementById('pp-toast');
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.id = 'pp-toast';
        el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#2cba99;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;z-index:22000;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 1800);
    }

    // Строка «Профили» для модалки панелей, вставляется после якорного panelId
    function renderRow($content, anchorPanelId) {
        const data = loadProfiles();
        const $row = $('<div class="panel-row panel-profiles-row"></div>');
        const $label = $('<span>Профиль</span>');
        const $select = $('<select class="panel-profiles-select"></select>');
        data.profiles.forEach(function (p) {
            $select.append($('<option></option>').attr('value', p.name).text(p.name));
        });
        $select.val(data.active || data.profiles[0].name);

        const $save = $('<button class="pp-btn pp-btn-apply" disabled>Сохранить</button>');
        const $saveAs = $('<button class="pp-btn pp-btn-saveas">Сохранить как…</button>');
        const $export = $('<button class="pp-btn pp-btn-export" title="Сохранить все настройки в profiles/<имя>.json">Экспорт</button>');
        const $import = $('<button class="pp-btn pp-btn-import" title="Загрузить профиль из JSON-файла">Импорт</button>');
        const $delete = $('<button class="pp-btn pp-btn-del">Удалить</button>');

        $save.on('click', function () {
            const id = $select.val();
            const dataNow = loadProfiles();
            const profile = dataNow.profiles.find(function (p) { return p.name === id; }) || dataNow.profiles[0];
            if (!profile) return;
            profile.config = currentConfig();
            dataNow.active = id;
            saveProfiles(dataNow);
            markRow(false);
            toast('Сохранено в «' + profile.name + '»');
        });

        $saveAs.on('click', function () {
            const name = prompt('Имя нового профиля:');
            if (!name || !name.trim()) return;
            saveCurrentToProfile(name.trim());
            rebuildOptions($select, name.trim());
            toast('Создан профиль «' + name.trim() + '»');
        });

        $export.on('click', function () {
            const id = ($select.val() || 'PC_fin').replace(/\.json$/i, '');
            // Есть нативный диалог — не тратим жест пользователя на prompt:
            // папку и имя файла выбирают прямо в окне сохранения.
            if (typeof window.showSaveFilePicker === 'function') {
                exportProfile(id);
                return;
            }
            const name = prompt('Имя файла профиля (profiles/<имя>.json):', id);
            if (!name || !name.trim()) return;
            exportProfile(name.trim().replace(/\.json$/i, ''));
        });

        $import.on('click', function () {
            pickAndImport();
        });

        $delete.on('click', function () {
            const id = $select.val();
            const dataNow = loadProfiles();
            if (dataNow.profiles.length <= 1) {
                showConfirm('Нельзя удалить', 'Должен остаться хотя бы один профиль.', null);
                return;
            }
            const profile = dataNow.profiles.find(function (p) { return p.name === id; }) || dataNow.profiles[0];
            if (!profile) return;
            showConfirm('Удалить профиль «' + profile.name + '»?', 'Удалённый профиль нельзя восстановить.', function () {
                if (deleteProfile(profile.name)) {
                    rebuildOptions($select);
                    onDrag();
                }
            });
        });

        // Подсветка кнопки «Сохранить» при несохранённых изменениях
        function markRow(on) {
            $save.prop('disabled', !on);
        }
        $select.on('change', function () {
            const id = $select.val();
            applyProfile(id, {
                force: true,
                done: function () {
                    markRow(false);
                }
            });
        });

        $row.append($label, $select, $save, $saveAs, $export, $import, $delete);

        // вставка первой строкой (сразу после заголовка модалки)
        if ($content) {
            const $header = $content.find('.panels-modal-header').first();
            if ($header.length) {
                $header.after($row);
            } else {
                $content.prepend($row);
            }
        }

        // Подсветка кнопки «Сохранить» при несохранённых изменениях
        const onDrag = function () {
            const d = loadProfiles();
            const active = d.profiles.find(function (p) { return p.name === d.active; }) || d.profiles[0];
            if (active) markRow(!configsEqual(currentConfig(), active.config));
        };
        if (typeof window.PanelResize !== 'undefined') {
            // прямое наблюдение за атрибутом style панелей
            const panelIds = (typeof window.PanelResize.capturePanelConfig === 'function')
                ? Object.keys(currentConfig())
                : [];
            panelIds.forEach(function (id) {
                const p = document.getElementById(id);
                if (!p) return;
                const obs = new MutationObserver(function (mutations) {
                    mutations.forEach(function (m) {
                        if (m.type === 'attributes' && m.attributeName === 'style') onDrag();
                    });
                });
                obs.observe(p, { attributes: true, attributeFilter: ['style'] });
            });
            setTimeout(onDrag, 300);
        }

        // показать/обновить список опций
        function rebuildOptions($sel, forceActive) {
            const d = loadProfiles();
            $sel.empty();
            d.profiles.forEach(function (p) {
                $sel.append($('<option></option>').attr('value', p.name).text(p.name));
            });
            $sel.val(forceActive || d.active || d.profiles[0].name);
        }

        return $row;
    }

    // ============================================================
    // Экспорт / импорт профиля (файлы profiles/<name>.json)
    // ============================================================

    function deviceId() {
        return (typeof getOrCreateDeviceId === 'function') ? getOrCreateDeviceId() : '';
    }

    function fetchJson(url, opts) {
        return fetch(url, opts || {}).then(function (r) {
            if (!r.ok) throw new Error(url + ' → ' + r.status);
            return r.json();
        });
    }

    // Полный снимок настроек: панели + профили + тема + серверные настройки.
    function collectSnapshot(name) {
        var did = deviceId();
        return Promise.all([
            fetchJson('/api/settings').catch(function () { return {}; }),
            did ? fetchJson('/api/user_settings/' + encodeURIComponent(did)).catch(function () { return {}; }) : Promise.resolve({})
        ]).then(function (res) {
            var data = loadProfiles();
            var theme = (window.ChartTheme && typeof ChartTheme.all === 'function') ? ChartTheme.all() : {};
            // Тема может жить только на сервере (другое устройство/новый браузер).
            if ((!theme || !Object.keys(theme).length) && res[1] && res[1].chart_theme) {
                try { theme = JSON.parse(res[1].chart_theme); } catch (e) { theme = {}; }
            }
            return {
                format: 'wclock-profile',
                version: 1,
                name: name || data.active || 'profile',
                saved_at: new Date().toISOString(),
                device_id: did,
                panels: currentConfig(),
                panel_profiles: data,
                theme: theme,
                legend: (typeof window.getLegendState === 'function') ? window.getLegendState() : null,
                settings: res[0] || {},
                user_settings: res[1] || {}
            };
        });
    }

    function downloadJson(name, obj) {
        try {
            var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        } catch (e) {
            console.warn('[PanelProfiles] download error:', e);
        }
    }

    // Запись в выбранный пользователем файл (File System Access API).
    // ВАЖНО: текст сериализуем ДО createWritable — он сразу усекает файл,
    // и любая ошибка сериализации оставила бы пустой файл на диске.
    function writeToHandle(handle, text) {
        return handle.createWritable().then(function (w) {
            return w.write(new Blob([text], { type: 'application/json' }))
                .then(function () { return w.close(); });
        });
    }

    // Выбор файла/папки до асинхронной работы: showSaveFilePicker вызывается
    // строго в обработчике клика, иначе браузер ругается на отсутствие жеста.
    function pickSaveFile(name) {
        if (typeof window.showSaveFilePicker !== 'function') return null;
        try {
            return window.showSaveFilePicker({
                suggestedName: (name || 'PC_fin') + '.json',
                types: [{ description: 'JSON-профиль настроек', accept: { 'application/json': ['.json'] } }]
            });
        } catch (e) {
            console.warn('[PanelProfiles] showSaveFilePicker:', e);
            return null;
        }
    }

    // Экспорт: снимок → файл в выбранную папку + копия в profiles/ на сервере.
    // Запись файла и серверное сохранение независимы: сбой сервера не должен
    // оставлять пользователя без файла (и наоборот).
    function exportProfile(name) {
        var picker = pickSaveFile(name);

        return (picker || Promise.resolve(null)).then(function (handle) {
            return collectSnapshot(name).then(function (snap) {
                // Сериализуем один раз и заранее.
                var text = JSON.stringify(snap, null, 2);

                var localWrite = handle
                    ? writeToHandle(handle, text)
                    : Promise.resolve(downloadJson(snap.name, snap));

                var serverSave = fetch('/api/profiles/' + encodeURIComponent(snap.name), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: text
                }).then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                }).catch(function (e) {
                    console.warn('[PanelProfiles] server save failed:', e);
                    return null;
                });

                return Promise.all([localWrite, serverSave]).then(function (res) {
                    var savedOnServer = !!res[1];
                    if (handle) {
                        toast('Файл «' + snap.name + '.json» сохранён' +
                              (savedOnServer ? ' (копия в profiles/)' : ''));
                    } else {
                        toast('Профиль «' + snap.name + '» сохранён' +
                              (savedOnServer ? ' в profiles/' : ''));
                    }
                    return snap;
                });
            });
        }).catch(function (e) {
            // Отмена выбора файла — не ошибка, молча выходим.
            if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
            console.warn('[PanelProfiles] export error:', e);
            toast('Ошибка экспорта: ' + (e && e.message ? e.message : e));
        });
    }

    function applyThemeSnapshot(theme) {
        if (!theme || !window.ChartTheme) return;
        Object.keys(theme).forEach(function (group) {
            var val = theme[group];
            if (val && typeof val === 'object') {
                Object.keys(val).forEach(function (k) {
                    try { ChartTheme.set(group + '.' + k, val[k]); } catch (e) {}
                });
            }
        });
        if (typeof window.InvestChartCore !== 'undefined' && ChartTheme.invalidatePatterns) { /* noop */ }
        if (window.InvestChartCore && typeof InvestChartCore.invalidatePatterns === 'function') {
            InvestChartCore.invalidatePatterns();
        }
    }

    // Импорт снимка: панели, профили, тема, серверные настройки.
    function importProfileObject(obj, opts) {
        opts = opts || {};
        if (!obj || typeof obj !== 'object' || !obj.panels) {
            toast('Некорректный файл профиля');
            return Promise.reject(new Error('bad profile'));
        }

        var tasks = [];
        var did = deviceId();

        if (obj.settings && Object.keys(obj.settings).length) {
            tasks.push(fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(obj.settings)
            }).catch(function (e) { console.warn('[PanelProfiles] settings import:', e); }));
        }
        if (did && obj.user_settings && Object.keys(obj.user_settings).length) {
            tasks.push(fetch('/api/user_settings/' + encodeURIComponent(did), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: obj.user_settings })
            }).catch(function (e) { console.warn('[PanelProfiles] user_settings import:', e); }));
        }

        applyThemeSnapshot(obj.theme);

        if (window.PanelResize && typeof PanelResize.applyConfigToPanels === 'function') {
            window.PanelResize.applyConfigToPanels(obj.panels);
        }
        if (window.PanelResize && typeof PanelResize.savePanelConfig === 'function') {
            window.PanelResize.savePanelConfig(obj.panels);
        }

        var name = obj.name || 'imported';
        var data = loadProfiles();
        var existing = data.profiles.find(function (p) { return p.name === name; });
        if (existing) existing.config = obj.panels;
        else data.profiles.push({ name: name, config: obj.panels });
        data.active = name;
        saveProfiles(data);

        return Promise.all(tasks).then(function () {
            toast('Профиль «' + name + '» импортирован');
            if (opts.reload !== false) {
                setTimeout(function () { location.reload(); }, 900);
            }
        });
    }

    function importFromFile(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            var obj = null;
            try { obj = JSON.parse(reader.result); } catch (e) {
                toast('Файл не является JSON');
                return;
            }
            showConfirm('Импортировать профиль «' + (obj.name || file.name) + '»?',
                'Текущие настройки панелей будут заменены.', function () {
                    importProfileObject(obj);
                });
        };
        reader.readAsText(file);
    }

    function pickAndImport() {
        var input = document.getElementById('pp-import-file');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'pp-import-file';
            input.accept = 'application/json,.json';
            input.style.display = 'none';
            input.addEventListener('change', function () {
                if (input.files && input.files[0]) importFromFile(input.files[0]);
                input.value = '';
            });
            document.body.appendChild(input);
        }
        input.click();
    }

    window.PanelProfiles = {
        loadProfiles: loadProfiles,
        saveProfiles: saveProfiles,
        currentConfig: currentConfig,
        mergeFromServer: mergeFromServer,
        applyProfile: applyProfile,
        saveCurrentToProfile: saveCurrentToProfile,
        saveCurrentToActive: saveCurrentToActive,
        deleteProfile: deleteProfile,
        updateVisibility: updateVisibility,
        renderRow: renderRow,
        collectSnapshot: collectSnapshot,
        exportProfile: exportProfile,
        importProfileObject: importProfileObject,
        importFromFile: importFromFile,
        pickAndImport: pickAndImport
    };

})(window);