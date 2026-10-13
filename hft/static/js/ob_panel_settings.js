/* ob_panel_settings.js — «Настройки панелей» для страницы /orderbook
 * (порт паттерна panel settings + profiles на ванильный JS, без jQuery).
 * Панели страницы: Стакан, График, История, Сводка, Аналитика, Чат MCP.
 * Хранилище: localStorage 'hft_ob_panels' (видимость + настройки) и
 * 'hft_ob_panel_profiles_<uid>' (именованные профили раскладки).
 * Запись ⇒ оповещение: события 'ob-panels-change' и 'ob-settings-change'.
 * Публичный API: window.ObPanelSettings.
 */
(function (window) {
  'use strict';

  var PANELS_KEY = 'hft_ob_panels';
  var PROFILES_KEY = 'hft_ob_panel_profiles';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function uid() {
    var u = window.ObUserId || (window.HftState && window.HftState.user && window.HftState.user.id) || 'anon';
    return String(u);
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* noop */ } }

  // ── реестр панелей страницы (единый источник истины) ────────
  var PANELS = [
    { id: 'book',      label: 'Стакан' },
    { id: 'chart',     label: 'График' },
    { id: 'history',   label: 'История' },
    { id: 'summary',   label: 'Сводка' },
    { id: 'analytics', label: 'Аналитика' },
    { id: 'chat',      label: 'Чат MCP' }
  ];

  var SUMMARY_METRICS = [
    { key: 'bestBid',     label: 'Bid' },
    { key: 'bestAsk',     label: 'Ask' },
    { key: 'mid',         label: 'Mid' },
    { key: 'spread',      label: 'Спред' },
    { key: 'spreadPct',   label: 'Спред %' },
    { key: 'sumBid',      label: 'Σ бид' },
    { key: 'sumAsk',      label: 'Σ аск' },
    { key: 'imbalance',   label: 'Дисбаланс' },
    { key: 'bookTime',    label: 'Стакан от' },
    { key: 'updates',     label: 'Обновлений' },
    { key: 'historyRows', label: 'Строк истории' },
    { key: 'dbBytes',     label: 'Размер БД' }
  ];

  var CHART_TYPES = [
    { key: 'candles', label: 'Свечи' },
    { key: 'bars',    label: 'Бары' },
    { key: 'line',    label: 'Линия' },
    { key: 'area',    label: 'Область' }
  ];

  function defaults() {
    return {
      visible: { book: true, chart: true, history: true, summary: true, analytics: true, chat: true },
      settings: {
        book: { depth: 10, refreshSec: 2 },
        chart: { type: 'candles', showVolume: true, showLabels: true },
        history: { rows: 200 },
        summary: { metrics: ['bestBid', 'bestAsk', 'mid', 'spread', 'spreadPct', 'sumBid', 'sumAsk', 'imbalance', 'bookTime', 'updates'] },
        analytics: { embed: true },
        chat: {}
      }
    };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function loadPanels() {
    var def = defaults();
    var raw = lsGet(PANELS_KEY);
    if (!raw) return def;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') return def;
    if (data.visible) { Object.keys(def.visible).forEach(function (k) { if (typeof data.visible[k] === 'boolean') def.visible[k] = data.visible[k]; }); }
    if (data.settings) {
      Object.keys(def.settings).forEach(function (pid) {
        if (data.settings[pid] && typeof data.settings[pid] === 'object') {
          Object.keys(def.settings[pid]).forEach(function (k) {
            if (data.settings[pid][k] !== undefined) def.settings[pid][k] = data.settings[pid][k];
          });
        }
      });
    }
    return def;
  }

  function savePanels(data) { lsSet(PANELS_KEY, JSON.stringify(data)); }

  function get() { return loadPanels(); }
  function getVisible() { return loadPanels().visible; }
  function getSettings(pid) {
    var s = loadPanels().settings;
    return pid ? s[pid] : s;
  }
  function isVisible(pid) { return loadPanels().visible[pid] !== false; }

  function notifyPanels(data) {
    document.dispatchEvent(new CustomEvent('ob-panels-change', { detail: { visible: data.visible } }));
  }
  function notifySettings(data, pid) {
    document.dispatchEvent(new CustomEvent('ob-settings-change', { detail: { settings: data.settings, pid: pid } }));
  }

  function setVisible(pid, visible) {
    var data = loadPanels();
    var visibleList = PANELS.filter(function (p) { return data.visible[p.id] !== false; });
    // нельзя скрыть последнюю видимую панель
    if (!visible && visibleList.length <= 1 && data.visible[pid] !== false) {
      alert('Нельзя скрыть последнюю панель');
      return false;
    }
    data.visible[pid] = !!visible;
    savePanels(data);
    syncProfilesVisibility(pid, !!visible);
    notifyPanels(data);
    document.dispatchEvent(new CustomEvent('hft:panel-changed'));
    return true;
  }

  function setSetting(pid, key, val) {
    var data = loadPanels();
    if (!data.settings[pid]) data.settings[pid] = {};
    data.settings[pid][key] = val;
    savePanels(data);
    notifySettings(data, pid);
    document.dispatchEvent(new CustomEvent('hft:panel-changed'));
  }

  function resetPanels() {
    var data = defaults();
    savePanels(data);
    notifyPanels(data);
    notifySettings(data, null);
    document.dispatchEvent(new CustomEvent('hft:panel-changed'));
  }

  // ── профили ─────────────────────────────────────────────────
  function profilesKey() { return PROFILES_KEY + '_' + uid(); }

  function loadProfiles() {
    var raw = lsGet(profilesKey());
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    if (!data || !Array.isArray(data.profiles) || !data.profiles.length) {
      data = { active: 'Вариант 1', profiles: [
        { name: 'Вариант 1', layout: loadPanels() },
        { name: 'Вариант 2', layout: defaults() }
      ] };
    }
    return data;
  }

  function saveProfiles(data) { lsSet(profilesKey(), JSON.stringify(data)); }

  function configsEqual(a, b) {
    var sa = typeof a === 'string' ? a : JSON.stringify(a);
    var sb = typeof b === 'string' ? b : JSON.stringify(b);
    return sa === sb;
  }

  function applyProfile(name, opts) {
    opts = opts || {};
    var data = loadProfiles();
    var profile = null;
    data.profiles.forEach(function (p) { if (p.name === name) profile = p; });
    if (!profile) profile = data.profiles[0];
    if (!profile) return;
    var layout = profile.layout;
    if (typeof layout === 'string') { try { layout = JSON.parse(layout); } catch (e) { layout = defaults(); } }
    savePanels(layout);
    data.active = profile.name;
    saveProfiles(data);
    notifyPanels(layout);
    notifySettings(layout, null);
    document.dispatchEvent(new CustomEvent('hft:panel-changed'));
    if (opts.done) opts.done();
  }

  function saveCurrentToProfile(name) {
    var data = loadProfiles();
    var layout = loadPanels();
    var existing = null;
    data.profiles.forEach(function (p) { if (p.name === name) existing = p; });
    if (existing) existing.layout = layout;
    else data.profiles.push({ name: name, layout: layout });
    data.active = name;
    saveProfiles(data);
    return data;
  }

  function deleteProfile(name) {
    var data = loadProfiles();
    if (data.profiles.length <= 1) return false;
    var idx = -1;
    data.profiles.forEach(function (p, i) { if (p.name === name) idx = i; });
    if (idx === -1) return false;
    data.profiles.splice(idx, 1);
    if (data.active === name) data.active = data.profiles[0].name;
    saveProfiles(data);
    return true;
  }

  function syncProfilesVisibility(panelId, visible) {
    var data = loadProfiles();
    var active = null;
    data.profiles.forEach(function (p) { if (p.name === data.active) active = p; });
    if (!active) active = data.profiles[0];
    if (!active) return;
    var layout = active.layout;
    if (typeof layout === 'string') { try { layout = JSON.parse(layout); } catch (e) { layout = defaults(); } }
    if (!layout.visible) layout.visible = {};
    layout.visible[panelId] = visible;
    active.layout = layout;
    saveProfiles(data);
  }

  function toast(msg) {
    var old = document.getElementById('hft-pp-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'hft-pp-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1800);
  }

  // ── построение строки панели ────────────────────────────────
  function panelSettings(pid) {
    if (pid === 'book') return buildBookSettings();
    if (pid === 'chart') return buildChartSettings();
    if (pid === 'history') return buildHistorySettings();
    if (pid === 'summary') return buildSummarySettings();
    if (pid === 'analytics') return buildAnalyticsSettings();
    if (pid === 'chat') return buildChatSettings();
    return null;
  }

  function buildPanelRow(pid, label) {
    var row = document.createElement('div');
    row.className = 'panel-row';
    var lab = document.createElement('span');
    lab.textContent = label;
    var toggle = document.createElement('label');
    toggle.className = 'switch';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.panel = pid;
    cb.checked = isVisible(pid);
    var slider = document.createElement('span');
    slider.className = 'slider';
    toggle.appendChild(cb);
    toggle.appendChild(slider);

    cb.addEventListener('change', function () {
      if (!setVisible(pid, cb.checked)) cb.checked = isVisible(pid);
      markDirty();
    });

    row.appendChild(lab);
    var settings = panelSettings(pid);
    if (settings) row.appendChild(settings);
    row.appendChild(toggle);
    return row;
  }

  // Стакан: глубина строк + частота обновления
  function buildBookSettings() {
    var cfg = getSettings('book');
    var div = document.createElement('div');
    div.className = 'panel-settings ob-settings';

    var dLab = document.createElement('span');
    dLab.className = 'ob-settings-label';
    dLab.textContent = 'Глубина';
    var dSlider = document.createElement('input');
    dSlider.type = 'range'; dSlider.min = '3'; dSlider.max = '30'; dSlider.step = '1';
    dSlider.value = String(cfg.depth);
    var dVal = document.createElement('span');
    dVal.className = 'ob-settings-val';
    dVal.textContent = cfg.depth + ' ур.';
    dSlider.addEventListener('input', function () {
      var v = parseInt(dSlider.value, 10) || 10;
      dVal.textContent = v + ' ур.';
      setSetting('book', 'depth', v);
      markDirty();
    });

    var rWrap = document.createElement('span');
    rWrap.className = 'ob-settings-refresh';
    var rLab = document.createElement('span');
    rLab.className = 'ob-settings-label';
    rLab.textContent = 'Обновление';
    var rSel = document.createElement('select');
    [1, 2, 3, 5, 10].forEach(function (s) {
      var o = document.createElement('option'); o.value = String(s); o.textContent = s + ' с'; rSel.appendChild(o);
    });
    rSel.value = String(cfg.refreshSec);
    rSel.addEventListener('change', function () {
      setSetting('book', 'refreshSec', parseInt(rSel.value, 10) || 2);
      markDirty();
    });
    rWrap.appendChild(rLab);
    rWrap.appendChild(rSel);

    div.appendChild(dLab);
    div.appendChild(dSlider);
    div.appendChild(dVal);
    div.appendChild(rWrap);
    return div;
  }

  // График: тип + объёмы + подписи
  function buildChartSettings() {
    var cfg = getSettings('chart');
    var div = document.createElement('div');
    div.className = 'panel-settings chart-flags-settings';

    var typeWrap = document.createElement('label');
    typeWrap.className = 'chart-flag-toggle';
    var typeLab = document.createElement('span');
    typeLab.textContent = 'Тип';
    var typeSel = document.createElement('select');
    typeSel.className = 'panel-view-select';
    CHART_TYPES.forEach(function (t) {
      var o = document.createElement('option'); o.value = t.key; o.textContent = t.label; typeSel.appendChild(o);
    });
    typeSel.value = cfg.type;
    typeSel.addEventListener('change', function () {
      setSetting('chart', 'type', typeSel.value);
      markDirty();
    });
    typeWrap.appendChild(typeLab);
    typeWrap.appendChild(typeSel);

    function mkToggle(key, label) {
      var wrap = document.createElement('label');
      wrap.className = 'chart-flag-toggle';
      var span = document.createElement('span');
      span.textContent = label;
      var sw = document.createElement('label');
      sw.className = 'switch switch-sm';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = cfg[key] !== false;
      var slider = document.createElement('span');
      slider.className = 'slider';
      sw.appendChild(cb);
      sw.appendChild(slider);
      cb.addEventListener('change', function () {
        setSetting('chart', key, cb.checked);
        markDirty();
      });
      wrap.appendChild(span);
      wrap.appendChild(sw);
      div.appendChild(wrap);
    }

    div.appendChild(typeWrap);
    mkToggle('showVolume', 'Объёмы');
    mkToggle('showLabels', 'Подписи времени');
    return div;
  }

  // История: число строк
  function buildHistorySettings() {
    var cfg = getSettings('history');
    var div = document.createElement('div');
    div.className = 'panel-settings ob-settings';
    var lab = document.createElement('span');
    lab.className = 'ob-settings-label';
    lab.textContent = 'Строк';
    var sel = document.createElement('select');
    [50, 100, 200, 500].forEach(function (n) {
      var o = document.createElement('option'); o.value = String(n); o.textContent = n; sel.appendChild(o);
    });
    sel.value = String(cfg.rows);
    sel.addEventListener('change', function () {
      setSetting('history', 'rows', parseInt(sel.value, 10) || 200);
      markDirty();
    });
    div.appendChild(lab);
    div.appendChild(sel);
    return div;
  }

  // Сводка: какие метрики показывать
  function buildSummarySettings() {
    var cfg = getSettings('summary');
    var on = cfg.metrics || [];
    var div = document.createElement('div');
    div.className = 'panel-settings summary-settings';
    SUMMARY_METRICS.forEach(function (m) {
      var wrap = document.createElement('label');
      wrap.className = 'summary-metric-toggle';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on.indexOf(m.key) >= 0;
      cb.addEventListener('change', function () {
        var cur = (getSettings('summary').metrics || []).slice();
        var i = cur.indexOf(m.key);
        if (cb.checked && i < 0) cur.push(m.key);
        if (!cb.checked && i >= 0) cur.splice(i, 1);
        if (!cur.length) { cb.checked = true; alert('Нужна хотя бы одна метрика'); return; }
        setSetting('summary', 'metrics', cur);
        markDirty();
      });
      var span = document.createElement('span');
      span.textContent = m.label;
      wrap.appendChild(cb);
      wrap.appendChild(span);
      div.appendChild(wrap);
    });
    return div;
  }

  // Аналитика: встроить (iframe) или ссылкой
  function buildAnalyticsSettings() {
    var cfg = getSettings('analytics');
    var div = document.createElement('div');
    div.className = 'panel-settings chart-flags-settings';
    var wrap = document.createElement('label');
    wrap.className = 'chart-flag-toggle';
    var span = document.createElement('span');
    span.textContent = 'Встроить на странице';
    var sw = document.createElement('label');
    sw.className = 'switch switch-sm';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cfg.embed !== false;
    var slider = document.createElement('span');
    slider.className = 'slider';
    sw.appendChild(cb);
    sw.appendChild(slider);
    cb.addEventListener('change', function () {
      setSetting('analytics', 'embed', cb.checked);
      markDirty();
    });
    wrap.appendChild(span);
    wrap.appendChild(sw);
    div.appendChild(wrap);
    return div;
  }

  // Чат MCP: заглушка до реализации эпика
  function buildChatSettings() {
    var div = document.createElement('div');
    div.className = 'panel-settings';
    var span = document.createElement('span');
    span.className = 'ob-settings-label';
    span.textContent = 'в разработке';
    div.appendChild(span);
    return div;
  }

  // ── строка профилей ─────────────────────────────────────────
  function buildProfilesRow() {
    var data = loadProfiles();
    var row = document.createElement('div');
    row.className = 'panel-row panel-profiles-row';
    var label = document.createElement('span');
    label.textContent = 'Профиль';
    var select = document.createElement('select');
    select.className = 'panel-profiles-select';
    fillOptions(select, data);
    select.value = data.active || (data.profiles[0] ? data.profiles[0].name : '');

    var saveBtn = document.createElement('button');
    saveBtn.className = 'pp-btn pp-btn-apply';
    saveBtn.textContent = 'Сохранить';
    var saveAsBtn = document.createElement('button');
    saveAsBtn.className = 'pp-btn pp-btn-saveas';
    saveAsBtn.textContent = 'Сохранить как…';
    var delBtn = document.createElement('button');
    delBtn.className = 'pp-btn pp-btn-del';
    delBtn.textContent = 'Удалить';

    function mark(on) { saveBtn.disabled = !on; }

    saveBtn.addEventListener('click', function () {
      var id = select.value;
      var d = loadProfiles();
      var prof = null;
      d.profiles.forEach(function (p) { if (p.name === id) prof = p; });
      if (!prof) prof = d.profiles[0];
      if (!prof) return;
      prof.layout = loadPanels();
      d.active = id;
      saveProfiles(d);
      mark(false);
      toast('Сохранено в «' + prof.name + '»');
    });

    saveAsBtn.addEventListener('click', function () {
      var name = prompt('Имя нового профиля:');
      if (!name || !name.trim()) return;
      var d = saveCurrentToProfile(name.trim());
      fillOptions(select, d);
      select.value = name.trim();
      mark(false);
      toast('Создан профиль «' + name.trim() + '»');
    });

    delBtn.addEventListener('click', function () {
      var id = select.value;
      var d = loadProfiles();
      if (d.profiles.length <= 1) { alert('Должен остаться хотя бы один профиль.'); return; }
      var prof = null;
      d.profiles.forEach(function (p) { if (p.name === id) prof = p; });
      if (!prof) return;
      if (!confirm('Удалить профиль «' + prof.name + '»?')) return;
      if (deleteProfile(prof.name)) {
        fillOptions(select, loadProfiles());
        mark(false);
      }
    });

    select.addEventListener('change', function () {
      applyProfile(select.value, { done: function () { rebuild(); } });
    });

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(saveBtn);
    row.appendChild(saveAsBtn);
    row.appendChild(delBtn);

    setTimeout(markDirty, 0);
    return row;
  }

  function fillOptions(sel, data) {
    sel.innerHTML = '';
    data.profiles.forEach(function (p) {
      var o = document.createElement('option'); o.value = p.name; o.textContent = p.name; sel.appendChild(o);
    });
    sel.value = data.active || (data.profiles[0] ? data.profiles[0].name : '');
  }

  // подсветка «Сохранить», если текущий расклад отличается от активного профиля
  function markDirty() {
    var modal = document.getElementById('panels-modal');
    if (!modal) return;
    var btn = modal.querySelector('.pp-btn-apply');
    if (!btn) return;
    var d = loadProfiles();
    var active = null;
    d.profiles.forEach(function (p) { if (p.name === d.active) active = p; });
    if (!active) active = d.profiles[0];
    if (active) btn.disabled = configsEqual(loadPanels(), active.layout);
  }

  // ── сборка/пересборка модалки ───────────────────────────────
  function build() {
    var modal = document.createElement('div');
    modal.id = 'panels-modal';
    modal.className = 'panels-modal';
    var content = document.createElement('div');
    content.className = 'panels-modal-content';
    var header = document.createElement('div');
    header.className = 'panels-modal-header';
    header.innerHTML = '<h3>Настройки панелей</h3><button class="close-modal" title="Закрыть">&times;</button>';
    content.appendChild(header);
    modal.appendChild(content);

    var profilesRow = buildProfilesRow();
    header.after(profilesRow);

    PANELS.forEach(function (p) {
      content.appendChild(buildPanelRow(p.id, p.label));
    });

    content.appendChild(buildResetRow());
    document.body.appendChild(modal);

    $('.close-modal', modal).addEventListener('click', function () { close(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    makeDraggable(content, header);
    return modal;
  }

  function rebuild() {
    var old = document.getElementById('panels-modal');
    if (old) old.remove();
    var modal = build();
    modal.style.display = 'flex';
  }

  function buildResetRow() {
    var row = document.createElement('div');
    row.className = 'panel-row panel-reset-row';
    var btn = document.createElement('button');
    btn.className = 'btn danger';
    btn.textContent = 'Сбросить раскладку';
    btn.addEventListener('click', function () {
      if (!confirm('Сбросить панели и настройки к значениям по умолчанию?')) return;
      resetPanels();
      rebuild();
    });
    row.appendChild(btn);
    return row;
  }

  function refreshRows() {
    var modal = document.getElementById('panels-modal');
    if (!modal) return;
    $all('input[data-panel]', modal).forEach(function (cb) {
      cb.checked = isVisible(cb.dataset.panel);
    });
  }

  function open() {
    var modal = document.getElementById('panels-modal');
    if (!modal) modal = build();
    modal.style.display = 'flex';
    refreshRows();
  }

  function close() {
    var modal = document.getElementById('panels-modal');
    if (modal) modal.style.display = 'none';
  }

  function makeDraggable(content, header) {
    header.style.cursor = 'move';
    var dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('close-modal')) return;
      dragging = true;
      var r = content.getBoundingClientRect();
      content.style.position = 'fixed';
      content.style.left = r.left + 'px';
      content.style.top = r.top + 'px';
      content.style.margin = '0';
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      content.style.left = (e.clientX - dx) + 'px';
      content.style.top = (e.clientY - dy) + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
  }

  window.addEventListener('hft:panel-changed', markDirty);

  window.ObPanelSettings = {
    open: open,
    close: close,
    rebuild: rebuild,
    get: get,
    getVisible: getVisible,
    getSettings: getSettings,
    isVisible: isVisible,
    setVisible: setVisible,
    setSetting: setSetting,
    reset: resetPanels,
    loadProfiles: loadProfiles,
    applyProfile: applyProfile,
    saveCurrentToProfile: saveCurrentToProfile,
    deleteProfile: deleteProfile,
    PANELS: PANELS,
    SUMMARY_METRICS: SUMMARY_METRICS,
    CHART_TYPES: CHART_TYPES
  };
})(window);
