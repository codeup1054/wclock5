/* hft_panel_settings.js — модалка «Настройки панелей» для HFT
 * (порт wclock panels-modal-content на ванильный JS).
 * Содержимое: список панелей с переключателями видимости + настройки
 * (DPI графика, сглаживание) + профили раскладки (PanelProfiles-порт).
 * Хранилище: localStorage 'hft_panel_profiles_' + активный профиль в
 * /api/hft/layout (PanelManager). Вызывается из hft.js: kнопка ▦.
 */
(function (window) {
  'use strict';

  var PROFILES_KEY = 'hft_panel_profiles';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function storageKey() {
    var u = window.HftState && window.HftState.user;
    return PROFILES_KEY + '_' + (u ? u.id : 'anon');
  }

  // Стаб-хуки: переопределяются в hft.js (подключается позже).
  // Определены здесь, чтобы контракт глобалов не ругался на порядок загрузки
  // (гуарды is_guarded тестер не учитывает).
  window.__hftPanelList = window.__hftPanelList || function () { return []; };
  window.__hftPanelLabel = window.__hftPanelLabel || function (id) { return id; };
  window.__hftHasPanel = window.__hftHasPanel || function () { return false; };
  window.__hftOnPanelVisible = window.__hftOnPanelVisible || function () {};
  window.__hftOnLayoutApplied = window.__hftOnLayoutApplied || function () {};

  function getSetting(key, def) {
    try { var v = localStorage.getItem(key); return v !== null ? v : def; } catch (e) { return def; }
  }
  function setSetting(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { /* noop */ } }

  // ── профили ─────────────────────────────────────────────────
  function loadProfiles() {
    var raw = null;
    try { raw = localStorage.getItem(storageKey()); } catch (e) { /* noop */ }
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    if (!data || !Array.isArray(data.profiles) || !data.profiles.length) {
      data = { active: 'Вариант 1', profiles: [
        { name: 'Вариант 1', layout: window.PanelManager.layoutSnapshot() },
        { name: 'Вариант 2', layout: window.PanelManager.layoutSnapshot() }
      ] };
    }
    return data;
  }

  function saveProfiles(data) {
    try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (e) { /* noop */ }
  }

  function currentLayout() { return window.PanelManager.getLayout(); }

  function configsEqual(a, b) {
    var sa = JSON.stringify(a);
    var sb = typeof b === 'string' ? b : JSON.stringify(b);
    try { if (typeof b === 'string') JSON.parse(sb); } catch (e) { return false; }
    return sa === sb;
  }

  function applyProfile(name, opts) {
    opts = opts || {};
    var data = loadProfiles();
    var profile = null;
    data.profiles.forEach(function (p) { if (p.name === name) profile = p; });
    if (!profile) profile = data.profiles[0];
    if (!profile) return;
    window.PanelManager.applyLayoutRaw(profile.layout);
    data.active = profile.name;
    saveProfiles(data);
    if (window.__hftOnLayoutApplied) window.__hftOnLayoutApplied();
    if (opts.done) opts.done();
  }

  function saveCurrentToProfile(name) {
    var data = loadProfiles();
    var layout = window.PanelManager.layoutSnapshot();
    var existing = null;
    data.profiles.forEach(function (p) { if (p.name === name) existing = p; });
    if (existing) existing.layout = layout;
    else data.profiles.push({ name: name, layout: layout });
    data.active = name;
    saveProfiles(data);
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

  function toast(msg) {
    var old = document.getElementById('hft-pp-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'hft-pp-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1800);
  }

  // ── панели для модалки (доступные текущему пользователю) ───
  // Хук __hftPanelList переопределён в hft.js (availablePanels).
  // Здесь стаб на случай прямого вызова до загрузки hft.js.
  function panelListSafe() {
    if (window.__hftPanelList) {
      var list = window.__hftPanelList();
      if (list && list.length) return list;
    }
    var fallback = ['capital', 'turnover', 'feed', 'tickers', 'chart', 'weather', 'clock', 'crm', 'orderbook'];
    return fallback.filter(function (p) {
      return window.__hftHasPanel ? window.__hftHasPanel(p) : true;
    });
  }

  // ── суммарная информация о панелях (ана. hft.js PANELS) ────
  var LABELS = {
    capital: 'Инвест-баннер', turnover: 'Оборот и комиссия', tickers: 'Тикеры',
    feed: 'Лента', chart: 'График', weather: 'Погода', clock: 'Часы',
    crm: 'CRM', report: 'Отчёт', orderbook: 'Стакан'
  };
  function labelOf(id) {
    if (window.__hftPanelLabel) { var l = window.__hftPanelLabel(id); if (l) return l; }
    return LABELS[id] || id;
  }

  // ── построение модалки ──────────────────────────────────────
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

    var profilesRow = buildProfilesRow(content);
    header.after(profilesRow);

    var list = panelListSafe();
    list.forEach(function (pid) {
      var row = buildPanelRow(pid);
      content.appendChild(row);
    });

    content.appendChild(buildDpiRow());
    content.appendChild(buildSmoothRow());
    content.appendChild(buildResetRow());

    document.body.appendChild(modal);

    // закрытие
    $('.close-modal', modal).addEventListener('click', function () { close(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    // drag по заголовку
    makeDraggable(content, header);

    return modal;
  }

  function buildPanelRow(pid) {
    var row = document.createElement('div');
    row.className = 'panel-row';
    var label = document.createElement('span');
    label.textContent = labelOf(pid);
    var toggle = document.createElement('label');
    toggle.className = 'switch';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.panel = pid;
    cb.checked = window.PanelManager.isVisible(pid);
    var slider = document.createElement('span');
    slider.className = 'slider';
    toggle.appendChild(cb);
    toggle.appendChild(slider);

    cb.addEventListener('change', function () {
      var visiblePrev = window.PanelManager.isVisible(pid);
      window.PanelManager.setVisible(pid, cb.checked);
      if (!window.PanelManager.visibleOnly(panelListSafe()).length) {
        window.PanelManager.setVisible(pid, true);
        cb.checked = true;
        alert('Нельзя скрыть последнюю панель');
        return;
      }
      if (window.__hftOnPanelVisible) window.__hftOnPanelVisible(pid, cb.checked);
      if (visiblePrev !== cb.checked) syncProfilesVisibility(pid, cb.checked);
    });

    row.appendChild(label);
    var settings = panelSettings(pid);
    if (settings) row.appendChild(settings);
    row.appendChild(toggle);
    return row;
  }

  // настройки отдельных панелей (порт panelSettings из wclock)
  function panelSettings(pid) {
    if (pid === 'capital') {
      return null; // селект периода уже есть в самом баннере (hft.js)
    }
    if (pid === 'chart') {
      return buildChartFlagsSettings(); // подписи на свечах: время / изменение
    }
    if (pid === 'orderbook') {
      return buildObSettings(); // глубина стакана + частота обновления
    }
    if (pid === 'weather') {
      return buildWeatherRangeSettings(); // диапазон температур на графике погоды
    }
    return null;
  }

  // ── настройки панели «Погода»: диапазон температур ───────────
  // (порт createTempRangeSettings из wclock, ванильный, автоприменение
  //  вместо кнопки ✓; событие hftTempRangeChange слушает hft_weather.js)
  function getWeatherRange() {
    var def = [-15, 25];
    var raw = getSetting('hft_weather_range', null);
    if (raw === null) { try { raw = localStorage.getItem('hft_weather_range'); } catch (e) { raw = null; } }
    if (raw) {
      try {
        var a = JSON.parse(raw);
        if (Array.isArray(a) && a.length === 2 && isFinite(a[0]) && isFinite(a[1]) && a[0] < a[1]) return a;
      } catch (e) { /* ignore */ }
    }
    return def;
  }

  function buildWeatherRangeSettings() {
    var rng = getWeatherRange();
    var div = document.createElement('div');
    div.className = 'panel-settings temp-range-settings';

    var disp = document.createElement('span');
    disp.className = 'temp-range-display';

    var wrap = document.createElement('div');
    wrap.className = 'dual-range-slider';
    var track = document.createElement('div');
    track.className = 'range-track';
    var minS = document.createElement('input');
    minS.type = 'range'; minS.className = 'range-min';
    minS.min = '-30'; minS.max = '30'; minS.step = '5'; minS.value = String(rng[0]);
    var maxS = document.createElement('input');
    maxS.type = 'range'; maxS.className = 'range-max';
    maxS.min = '-30'; maxS.max = '30'; maxS.step = '5'; maxS.value = String(rng[1]);
    wrap.appendChild(track);
    wrap.appendChild(minS);
    wrap.appendChild(maxS);

    function paint() {
      var lo = parseInt(minS.value, 10) || -15;
      var hi = parseInt(maxS.value, 10) || 25;
      disp.textContent = lo + '°C … ' + hi + '°C';
      var span = 60;
      var lp = ((lo + 30) / span) * 100;
      var hp = ((hi + 30) / span) * 100;
      track.style.left = lp + '%';
      track.style.width = (hp - lp) + '%';
    }

    function commit(adjust) {
      var lo = parseInt(minS.value, 10) || -15;
      var hi = parseInt(maxS.value, 10) || 25;
      if (adjust) {
        if (lo > hi - 5) { lo = hi - 5; minS.value = String(lo); }
        if (hi < lo + 5) { hi = lo + 5; maxS.value = String(hi); }
      }
      setSetting('hft_weather_range', JSON.stringify([lo, hi]));
      paint();
      document.dispatchEvent(new CustomEvent('hftTempRangeChange', { detail: { min: lo, max: hi } }));
    }

    minS.addEventListener('input', function () { commit(true); });
    maxS.addEventListener('input', function () { commit(true); });

    div.appendChild(disp);
    div.appendChild(wrap);
    setTimeout(paint, 0);
    return div;
  }

  // ── настройки панели «График»: подписи время/изменение ───────
  // (порт showTime/showChange из wclock; событие hftChartFlagsChange
  //  применяет настройки к живому графику в invest_chart.js)
  function buildChartFlagsSettings() {
    var div = document.createElement('div');
    div.className = 'panel-settings chart-flags-settings';
    var cfg = chartCfg();

    function mkToggle(key, label, def) {
      var wrap = document.createElement('label');
      wrap.className = 'chart-flag-toggle';
      var span = document.createElement('span');
      span.textContent = label;
      var sw = document.createElement('label');
      sw.className = 'switch switch-sm';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = cfg[key] !== undefined ? !!cfg[key] : def;
      var slider = document.createElement('span');
      slider.className = 'slider';
      sw.appendChild(cb);
      sw.appendChild(slider);
      cb.addEventListener('change', function () {
        var detail = {};
        detail[key] = cb.checked;
        document.dispatchEvent(new CustomEvent('hftChartFlagsChange', { detail: detail }));
      });
      wrap.appendChild(span);
      wrap.appendChild(sw);
      div.appendChild(wrap);
    }

    mkToggle('showTime', 'Подпись времени', true);
    mkToggle('showChange', 'Подпись изменения', true);
    return div;
  }

  // ── настройки панели «Стакан»: глубина + частота обновления ──
  // (cобытие hftObCfgChange применяет настройки к виджету стакана)
  function getObCfg() {
    var def = { depth: 10, refreshSec: 2 };
    try {
      var raw = localStorage.getItem('hft_ob_cfg');
      if (raw) {
        var o = JSON.parse(raw);
        if (typeof o.depth === 'number' && o.depth >= 1 && o.depth <= 40) def.depth = o.depth;
        if (typeof o.refreshSec === 'number' && o.refreshSec >= 1 && o.refreshSec <= 60) def.refreshSec = o.refreshSec;
      }
    } catch (e) { /* ignore */ }
    return def;
  }

  function buildObSettings() {
    var cfg = getObCfg();
    var div = document.createElement('div');
    div.className = 'panel-settings ob-settings';

    var dLab = document.createElement('span');
    dLab.className = 'ob-settings-label';
    dLab.textContent = 'Глубина';
    var dSlider = document.createElement('input');
    dSlider.type = 'range';
    dSlider.min = '3';
    dSlider.max = '30';
    dSlider.step = '1';
    dSlider.value = String(cfg.depth);
    var dVal = document.createElement('span');
    dVal.className = 'ob-settings-val';
    dVal.textContent = cfg.depth + ' ур.';

    function commitDepth() {
      var v = parseInt(dSlider.value, 10) || 10;
      dVal.textContent = v + ' ур.';
      localStorage.setItem('hft_ob_cfg', JSON.stringify({
        depth: v, refreshSec: getObCfg().refreshSec
      }));
      document.dispatchEvent(new CustomEvent('hftObCfgChange', { detail: { depth: v } }));
    }
    dSlider.addEventListener('input', commitDepth);

    var rLab = document.createElement('span');
    rLab.className = 'ob-settings-label';
    rLab.textContent = 'Обновление';
    var rSel = document.createElement('select');
    [1, 2, 3, 5, 10].forEach(function (s) {
      var o = document.createElement('option');
      o.value = String(s);
      o.textContent = s + ' с';
      rSel.appendChild(o);
    });
    rSel.value = String(cfg.refreshSec);

    function commitRefresh() {
      var v = parseInt(rSel.value, 10) || 2;
      localStorage.setItem('hft_ob_cfg', JSON.stringify({
        depth: getObCfg().depth, refreshSec: v
      }));
      document.dispatchEvent(new CustomEvent('hftObCfgChange', { detail: { refreshSec: v } }));
    }
    rSel.addEventListener('change', commitRefresh);

    var rWrap = document.createElement('span');
    rWrap.className = 'ob-settings-refresh';
    rWrap.appendChild(rLab);
    rWrap.appendChild(rSel);

    div.appendChild(dLab);
    div.appendChild(dSlider);
    div.appendChild(dVal);
    div.appendChild(rWrap);
    return div;
  }

  // ── профили: строка в модалке ──────────────────────────────
  function buildProfilesRow(content) {
    var data = loadProfiles();
    var row = document.createElement('div');
    row.className = 'panel-row panel-profiles-row';
    var label = document.createElement('span');
    label.textContent = 'Профиль';
    var select = document.createElement('select');
    select.className = 'panel-profiles-select';
    data.profiles.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      select.appendChild(o);
    });
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
      prof.layout = window.PanelManager.layoutSnapshot();
      d.active = id;
      saveProfiles(d);
      mark(false);
      toast('Сохранено в «' + prof.name + '»');
    });

    saveAsBtn.addEventListener('click', function () {
      var name = prompt('Имя нового профиля:');
      if (!name || !name.trim()) return;
      saveCurrentToProfile(name.trim());
      rebuildOptions(select, name.trim());
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
        rebuildOptions(select);
        onDrag();
      }
    });

    select.addEventListener('change', function () {
      applyProfile(select.value, {
        force: true,
        done: function () { mark(false); if (window.__hftOnPanelVisible) window.__hftOnPanelVisible(null, null); }
      });
    });

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(saveBtn);
    row.appendChild(saveAsBtn);
    row.appendChild(delBtn);

    // подсветка «Сохранить» при несохранённых изменениях
    function onDrag() {
      var d = loadProfiles();
      var active = null;
      d.profiles.forEach(function (p) { if (p.name === d.active) active = p; });
      if (!active) active = d.profiles[0];
      if (active) mark(!configsEqual(currentLayout(), active.layout));
    }
    window.addEventListener('hft:panel-changed', onDrag);
    setTimeout(onDrag, 300);

    function rebuildOptions(sel, forceActive) {
      sel.innerHTML = '';
      var d = loadProfiles();
      d.profiles.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.value = forceActive || d.active || (d.profiles[0] ? d.profiles[0].name : '');
    }

    return row;
  }

  // синхронизация видимости в активном профиле (порт updateVisibility)
  function syncProfilesVisibility(panelId, visible) {
    var data = loadProfiles();
    var active = null;
    data.profiles.forEach(function (p) { if (p.name === data.active) active = p; });
    if (!active) active = data.profiles[0];
    if (!active || !active.layout) return;
    var panels;
    if (typeof active.layout === 'string') {
      try { panels = JSON.parse(active.layout); } catch (e) { return; }
    } else if (active.layout && active.layout.panels) {
      panels = active.layout.panels;
    } else {
      panels = active.layout;
    }
    if (!panels || typeof panels !== 'object') return;
    if (panels[panelId]) panels[panelId].visible = visible;
    else panels[panelId] = { visible: visible === false ? false : true };
    active.layout = JSON.stringify(panels);
    saveProfiles(data);
  }

  // ── остальные строки (DPI, сглаживание, сброс) ──────────────
  function chartCfg() {
    try { return JSON.parse(localStorage.getItem('hft_chart_cfg') || '{}'); } catch (e) { return {}; }
  }
  function chartCfgSet(obj) {
    var cfg = chartCfg();
    Object.keys(obj).forEach(function (k) { cfg[k] = obj[k]; });
    try { localStorage.setItem('hft_chart_cfg', JSON.stringify(cfg)); } catch (e) { /* noop */ }
  }

  function buildDpiRow() {
    var row = document.createElement('div');
    row.className = 'panel-row';
    var label = document.createElement('span');
    label.textContent = 'DPI инвест-графика';
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.5';
    slider.max = '3';
    slider.step = '0.1';
    var saved = Number(chartCfg().dpi || '1');
    slider.value = String(saved);
    var val = document.createElement('span');
    val.className = 'pp-dpi-val';
    val.textContent = slider.value;
    slider.addEventListener('input', function () {
      val.textContent = slider.value;
      chartCfgSet({ dpi: parseFloat(slider.value) });
      document.dispatchEvent(new CustomEvent('hftDpiChange', { detail: { dpi: parseFloat(slider.value) } }));
      if (window.HftInvestChart && window.HftInvestChart.resize) window.HftInvestChart.resize();
    });
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(val);
    return row;
  }

  function buildSmoothRow() {
    var row = document.createElement('div');
    row.className = 'panel-row';
    var label = document.createElement('span');
    label.textContent = 'Сглаживание графиков';
    var toggle = document.createElement('label');
    toggle.className = 'switch';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = chartCfg().smoothing !== false;
    var slider = document.createElement('span');
    slider.className = 'slider';
    toggle.appendChild(cb);
    toggle.appendChild(slider);
    cb.addEventListener('change', function () {
      chartCfgSet({ smoothing: cb.checked });
      document.dispatchEvent(new CustomEvent('hftSmoothingChange', { detail: { on: cb.checked } }));
      if (window.HftInvestChart) {
        window.HftInvestChart.update && window.HftInvestChart.update();
      }
    });
    row.appendChild(label);
    row.appendChild(toggle);
    return row;
  }

  function buildResetRow() {
    var row = document.createElement('div');
    row.className = 'panel-row panel-reset-row';
    var btn = document.createElement('button');
    btn.className = 'btn danger';
    btn.textContent = 'Сбросить раскладку';
    btn.addEventListener('click', function () {
      if (!confirm('Сбросить раскладку панелей к значениям по умолчанию?')) return;
      window.PanelManager.resetAll();
      if (window.__hftOnPanelVisible) window.__hftOnPanelVisible(null, null);
    });
    row.appendChild(btn);
    return row;
  }

  // ── открытие/закрытие/drag ──────────────────────────────────
  function open() {
    var modal = document.getElementById('panels-modal');
    if (!modal) modal = build();
    modal.style.display = 'flex';
    refreshRows();
  }

  function refreshRows() {
    var modal = document.getElementById('panels-modal');
    if (!modal) return;
    $all('input[data-panel]', modal).forEach(function (cb) {
      cb.checked = window.PanelManager.isVisible(cb.dataset.panel);
    });
  }

  function close() {
    var modal = document.getElementById('panels-modal');
    if (modal) modal.style.display = 'none';
  }

  function makeDraggable(content, header) {
    header.style.cursor = 'move';
    var isDragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('close-modal')) return;
      isDragging = true;
      dx = e.clientX - content.getBoundingClientRect().left;
      dy = e.clientY - content.getBoundingClientRect().top;
    });
    window.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      content.style.left = (e.clientX - dx) + 'px';
      content.style.top = (e.clientY - dy) + 'px';
    });
    window.addEventListener('mouseup', function () { isDragging = false; });
  }

  window.HftPanelSettings = {
    open: open,
    close: close,
    refreshRows: refreshRows,
    loadProfiles: loadProfiles,
    applyProfile: applyProfile,
    saveCurrentToProfile: saveCurrentToProfile,
    deleteProfile: deleteProfile,
    currentLayout: currentLayout,
    panelList: panelListSafe
  };
})(window);