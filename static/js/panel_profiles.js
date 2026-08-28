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
        Object.keys(config).forEach(function (panelId) {
            var cb = document.querySelector('input[data-panel="' + panelId + '"]');
            if (!cb || !(panelId in config)) return;
            var visible = config[panelId].visible !== undefined ? config[panelId].visible : true;
            cb.checked = !!visible;
        });
    }

    // Обновить видимость панели в активном профиле (+ синхронизация wclock_panels, чтобы F5 не откатывал)
    function updateVisibility(panelId, visible) {
        // Баннер: модалка управляет внешней рамкой invest_panel_banner,
        // но в профиле может быть сохранён и внутренний invest_banner — синхронизируем оба
        const panelIds = panelId === 'invest_panel_banner' ? ['invest_panel_banner', 'invest_banner'] : [panelId];
        panelIds.forEach(function (id) {
            const data = loadProfiles();
            const active = data.profiles.find(function (p) { return p.name === data.active; }) || data.profiles[0];
            active.config = active.config || {};
            active.config[id] = active.config[id] || {};
            active.config[id].visible = !!visible;
            saveProfiles(data);

            // Синхронизация с wclock_panels (применяется при загрузке страницы)
            if (typeof window.PanelResize !== 'undefined' && typeof window.PanelResize.capturePanelConfig === 'function' && typeof window.PanelResize.savePanelConfig === 'function') {
                const full = window.PanelResize.capturePanelConfig();
                if (full[id]) {
                    full[id].visible = !!visible;
                    window.PanelResize.savePanelConfig(full);
                }
            }
        });
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

        const $save = $('<button class="pp-btn pp-btn-apply">Сохранить</button>');
        const $saveAs = $('<button class="pp-btn pp-btn-saveas">Сохранить как…</button>');
        const $delete = $('<button class="pp-btn pp-btn-del">Удалить</button>');

        $save.on('click', function () {
            const id = $select.val();
            const dataNow = loadProfiles();
            const profile = dataNow.profiles.find(function (p) { return p.name === id; }) || dataNow.profiles[0];
            if (!profile) return;
            profile.config = currentConfig();
            dataNow.active = id;
            saveProfiles(dataNow);
            markRow(dirty, false);
            toast('Сохранено в «' + profile.name + '»');
        });

        $saveAs.on('click', function () {
            const name = prompt('Имя нового профиля:');
            if (!name || !name.trim()) return;
            saveCurrentToProfile(name.trim());
            rebuildOptions($select, name.trim());
            toast('Создан профиль «' + name.trim() + '»');
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

        // флаг «раскладка отличается от сохранённой» (несохранённые изменения)
        const dirty = $('<span class="pp-dirty" style="display:none;color:#ffb;font-size:11px;">изменено</span>');
        function markRow($flag, on) {
            $flag.toggle(on);
        }
        $select.on('change', function () {
            const id = $select.val();
            applyProfile(id, {
                force: true,
                done: function () {
                    markRow(dirty, false);
                }
            });
        });

        $row.append($label, $select, dirty, $save, $saveAs, $delete);

        // вставка после якоря
        if ($content) {
            const $anchor = $content.find('.panel-row').filter(function () {
                return $(this).find('[data-panel-label="' + anchorPanelId + '"]').length;
            }).first();
            if ($anchor.length) {
                $anchor.after($row);
            } else {
                $content.prepend($row);
            }
        }

        // Помечать dirty при изменении геометрии/видимости панелей
        const onDrag = function () {
            const d = loadProfiles();
            const active = d.profiles.find(function (p) { return p.name === d.active; }) || d.profiles[0];
            if (active) markRow(dirty, !configsEqual(currentConfig(), active.config));
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
        renderRow: renderRow
    };

})(window);