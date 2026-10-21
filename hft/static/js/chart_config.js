/* chart_config.js — ChartTheme (единый источник вида инвест-графика) и редактор
 * параметров «Таблица / JSON».
 * Общий для wclock (persist: cookie + сервер через getSetting/saveSettingsToServer)
 * и hft (persist: localStorage). Схема/рендер не зависят от фреймворка.
 */
(function (window, document) {
  'use strict';

  var THEME_KEY = 'chart_theme';

  var DEFAULTS = {
    font: { axis: 21, axisTitle: 42, share: 18.9, ticker: 27.3, portfolio: 21 },
    line: { ticker: 0.75, portfolio: 0.7, pct: 1.5, total: 2, layer: 0.5, ref: 0.5 },
    hatch: { spacing: 18, lineWidth: 1, alpha: 0.45 },
    color: {
      portfolio: '#2cba99',
      finam: '#5b6ee8',
      total: '#aaaaaa',
      ref: '#dc3c3c',
      tgld: '#FFD700',
      xau: '#cc7722',
      usd: '#3ba3ff',
      brent: '#556B2F'
    }
  };

  var SCHEMA = [
    { group: 'Шрифты', fields: [
      { path: 'font.axis', label: 'Метки осей', step: 1, min: 4, max: 200 },
      { path: 'font.axisTitle', label: 'Заголовки осей', step: 1, min: 4, max: 200 },
      { path: 'font.share', label: 'Ось долей, %', step: 0.1, min: 4, max: 200 },
      { path: 'font.ticker', label: 'Оси тикеров', step: 0.1, min: 4, max: 200 },
      { path: 'font.portfolio', label: 'Оси Портфеля', step: 0.1, min: 4, max: 200 }
    ]},
    { group: 'Толщины линий', fields: [
      { path: 'line.ticker', label: 'Тикеры', step: 0.05, min: 0, max: 20 },
      { path: 'line.portfolio', label: 'Портфель', step: 0.05, min: 0, max: 20 },
      { path: 'line.pct', label: 'Доли, %', step: 0.05, min: 0, max: 20 },
      { path: 'line.total', label: 'T+F / сумма', step: 0.05, min: 0, max: 20 },
      { path: 'line.layer', label: 'Слои (штрих)', step: 0.05, min: 0, max: 20 },
      { path: 'line.ref', label: 'Опорная 100%', step: 0.05, min: 0, max: 20 }
    ]},
    { group: 'Цвета линий', fields: [
      { path: 'color.portfolio', label: 'Портфель (Tinkoff)', type: 'color' },
      { path: 'color.finam', label: 'Finam', type: 'color' },
      { path: 'color.total', label: 'T+F / сумма', type: 'color' },
      { path: 'color.ref', label: 'Опорная 100%', type: 'color' }
    ]},
    { group: 'Цвета тикеров', fields: [
      { path: 'color.tgld', label: 'TGLD (золото)', type: 'color' },
      { path: 'color.xau', label: 'XAU/USD', type: 'color' },
      { path: 'color.usd', label: 'USD/RUB', type: 'color' },
      { path: 'color.brent', label: 'Brent (нефть)', type: 'color' }
    ]},
    { group: 'Штриховка', fields: [
      { path: 'hatch.spacing', label: 'Шаг (px)', step: 1, min: 4, max: 100 },
      { path: 'hatch.lineWidth', label: 'Толщина', step: 0.5, min: 0.5, max: 10 },
      { path: 'hatch.alpha', label: 'Прозрачность', step: 0.05, min: 0, max: 1 }
    ]}
  ];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function hasCookieStore() { return typeof window.getSetting === 'function'; }

  function readSaved() {
    var raw = null;
    if (hasCookieStore()) raw = window.getSetting(THEME_KEY, '{}');
    else { try { raw = window.localStorage.getItem(THEME_KEY); } catch (e) { raw = null; } }
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  function persist(json) {
    if (hasCookieStore()) {
      window.setSetting(THEME_KEY, json);
      if (typeof window.saveSettingsToServer === 'function') window.saveSettingsToServer({ chart_theme: json });
    } else {
      try { window.localStorage.setItem(THEME_KEY, json); } catch (e) { /* noop */ }
    }
  }

  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (k) {
      var bv = base[k], ov = isObj(over) ? over[k] : undefined;
      if (isObj(bv)) { out[k] = merge(bv, isObj(ov) ? ov : {}); }
      else if (typeof bv === 'number') {
        var n = Number(ov);
        out[k] = (ov !== undefined && ov !== null && !isNaN(n)) ? n : bv;
      } else {
        out[k] = (ov !== undefined && ov !== null) ? ov : bv;
      }
    });
    return out;
  }

  var ChartTheme = {
    defaults: DEFAULTS,
    schema: SCHEMA,
    values: merge(DEFAULTS, readSaved()),
    get: function (path, fallback) {
      var parts = String(path).split('.'), cur = this.values, i;
      for (i = 0; i < parts.length; i++) {
        if (cur === undefined || cur === null) return fallback;
        cur = cur[parts[i]];
      }
      return cur === undefined ? fallback : cur;
    },
    set: function (path, value) {
      var parts = String(path).split('.'), cur = this.values, i;
      for (i = 0; i < parts.length - 1; i++) {
        if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      this.save();
    },
    save: function () { persist(JSON.stringify(this.values)); },
    reset: function () { this.values = merge(DEFAULTS, {}); this.save(); },
    reload: function () { this.values = merge(DEFAULTS, readSaved()); }
  };
  window.ChartTheme = ChartTheme;

  function notifyThemeChange() {
    if (window.jQuery) window.jQuery(document).trigger('chartThemeChange');
    else document.dispatchEvent(new CustomEvent('chartThemeChange'));
  }
  window.notifyChartThemeChange = notifyThemeChange;

  function collectJSON() { return JSON.stringify({ theme: ChartTheme.values }, null, 2); }

  function applyJSON(text) {
    var obj = JSON.parse(text);
    if (isObj(obj.theme)) { ChartTheme.values = merge(DEFAULTS, obj.theme); ChartTheme.save(); }
    notifyThemeChange();
  }

  // ── настройки приложения (DPI, сглаживание) ─────────────────
  function defaultGetSetting(key, def) {
    if (typeof window.getSetting === 'function') return window.getSetting(key, def);
    try {
      var cfg = JSON.parse(window.localStorage.getItem('hft_chart_cfg') || '{}');
      return cfg[key] !== undefined ? cfg[key] : def;
    } catch (e) { return def; }
  }

  function defaultSetSetting(key, val) {
    if (typeof window.setSetting === 'function') {
      window.setSetting(key, String(val));
      if (typeof window.saveSettingsToServer === 'function') {
        var o = {}; o[key] = String(val); window.saveSettingsToServer(o);
      }
    } else {
      try {
        var cfg = JSON.parse(window.localStorage.getItem('hft_chart_cfg') || '{}');
        cfg[key] = val; window.localStorage.setItem('hft_chart_cfg', JSON.stringify(cfg));
      } catch (e) { /* noop */ }
    }
  }

  var STYLE_ID = 'chart-params-style';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.cp-tabs{display:flex;align-items:center;gap:6px;margin:6px 0 10px}',
      '.cp-tab{padding:4px 14px;border:1px solid #555;background:#222;color:#ccc;cursor:pointer;border-radius:4px;font-size:12px}',
      '.cp-tab.active{background:#ff4e07;border-color:#ff4e07;color:#fff}',
      '.cp-cols{display:flex;gap:20px;align-items:flex-start}',
      '.cp-col{flex:1;min-width:0}',
      '.cp-group-title{margin:12px 0 4px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.5px}',
      '.cp-group-title:first-child{margin-top:0}',
      '.cp-table{width:100%;border-collapse:collapse}',
      '.cp-table td{padding:3px 6px;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px;color:#ccc;vertical-align:middle}',
      '.cp-table td.cp-l{width:100%}',
      '.cp-table input[type=number]{width:110px;background:#111;color:#ffd700;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:12px}',
      '.cp-table input[type=number]:focus{border-color:#ff4e07;outline:none}',
      '.cp-table input[type=color]{width:56px;height:26px;border:1px solid #555;border-radius:3px;background:#111;padding:1px;cursor:pointer}',
      '.cp-actions{display:flex;gap:8px;margin:14px 0 4px}',
      '.cp-btn{padding:4px 14px;border:1px solid #555;background:#222;color:#ccc;cursor:pointer;border-radius:4px;font-size:12px}',
      '.cp-btn:hover{border-color:#ff9f43;color:#fff}',
      '.cp-btn.cp-primary{background:#ff4e07;border-color:#ff4e07;color:#fff}',
      '.cp-tabs .cp-apply{margin-left:auto}',
      '.cp-json{width:100%;min-height:340px;background:#111;color:#9fdc9f;border:1px solid #555;border-radius:4px;font-family:monospace;font-size:12px;padding:8px;box-sizing:border-box}',
      '.cp-hint{font-size:11px;color:#777;margin:6px 0}'
    ].join('');
    document.head.appendChild(s);
  }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* renderParamsEditor(host, opts)
   * opts.settingsSchema — массив {key,label,type:'number'|'checkbox',min,max,step,def}
   * opts.onSettingChange(key, value, type) — сохранить + сгенерировать событие
   * opts.getSetting(key,def) / opts.setSetting(key,val) — переопределение хранилища
   */
  function renderParamsEditor(host, opts) {
    opts = opts || {};
    injectStyles();
    while (host.firstChild) host.removeChild(host.firstChild);

    var settingsSchema = opts.settingsSchema || [];
    var getS = opts.getSetting || defaultGetSetting;
    var setS = opts.setSetting || defaultSetSetting;
    var onSettingChange = opts.onSettingChange || function (key, val) { setS(key, val); };

    var tabs = mk('div', 'cp-tabs');
    var bT = mk('button', 'cp-tab active', 'Таблица');
    var bJ = mk('button', 'cp-tab', 'JSON');
    tabs.appendChild(bT); tabs.appendChild(bJ);
    var bApplyTop = mk('button', 'cp-btn cp-primary cp-apply', 'Применить');
    bApplyTop.title = 'Перерисовать график с текущими значениями';
    bApplyTop.addEventListener('click', function () {
      notifyThemeChange();
      refreshJson();
    });
    tabs.appendChild(bApplyTop);
    host.appendChild(tabs);

    var paneTable = mk('div');
    var paneJson = mk('div');
    paneJson.style.display = 'none';
    host.appendChild(paneTable); host.appendChild(paneJson);

    function addRow(tbody, label, buildInput) {
      var tr = document.createElement('tr');
      tr.appendChild(mk('td', 'cp-l', label));
      var td = document.createElement('td');
      buildInput(td);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    function addNumberRow(tbody, label, cfg, getVal, setVal) {
      addRow(tbody, label, function (td) {
        var inp = document.createElement('input');
        inp.type = 'number';
        if (cfg.step != null) inp.step = cfg.step;
        if (cfg.min != null) inp.min = cfg.min;
        if (cfg.max != null) inp.max = cfg.max;
        inp.value = getVal();
        inp.addEventListener('input', function () {
          var v = parseFloat(inp.value);
          if (isNaN(v)) return;
          setVal(v);
        });
        td.appendChild(inp);
      });
    }

    function addColorRow(tbody, label, getVal, setVal) {
      addRow(tbody, label, function (td) {
        var inp = document.createElement('input');
        inp.type = 'color';
        var v = getVal();
        inp.value = (v && v.charAt(0) === '#') ? v : (v || '#888888');
        inp.addEventListener('input', function () { setVal(inp.value); });
        td.appendChild(inp);
      });
    }

    function addCheckRow(tbody, label, cfg) {
      addRow(tbody, label, function (td) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = String(getS(cfg.key, cfg.def == null ? '1' : cfg.def)) !== '0';
        cb.addEventListener('change', function () {
          onSettingChange(cfg.key, cb.checked ? '1' : '0', 'checkbox');
        });
        td.appendChild(cb);
      });
    }

    // Одна группа = <div class="cp-group-title"> + <table>. Возвращает таблицу.
    function buildGroup(title, fill) {
      var w = document.createElement('div');
      w.__groupTitle = title;
      w.appendChild(mk('div', 'cp-group-title', title));
      var t = document.createElement('table');
      t.className = 'cp-table';
      var tbody = document.createElement('tbody');
      t.appendChild(tbody);
      fill(tbody);
      w.appendChild(t);
      return w;
    }

    function buildTable() {
      while (paneTable.firstChild) paneTable.removeChild(paneTable.firstChild);
      var groups = [];

      ChartTheme.schema.forEach(function (grp) {
        groups.push(buildGroup(grp.group, function (tbody) {
          grp.fields.forEach(function (f) {
            if (f.type === 'color') {
              addColorRow(tbody, f.label,
                function () { return ChartTheme.get(f.path); },
                function (v) { ChartTheme.set(f.path, v); notifyThemeChange(); });
            } else {
              addNumberRow(tbody, f.label, f,
                function () { return ChartTheme.get(f.path); },
                function (v) { ChartTheme.set(f.path, v); notifyThemeChange(); });
            }
          });
        }));
      });

      if (settingsSchema.length) {
        groups.push(buildGroup('Настройки графика', function (tbody) {
          settingsSchema.forEach(function (f) {
            if (f.type === 'checkbox') addCheckRow(tbody, f.label, f);
            else addNumberRow(tbody, f.label, f,
              function () { return parseFloat(getS(f.key, f.def == null ? '' : f.def)) || 0; },
              function (v) { onSettingChange(f.key, v, 'number'); });
          });
        }));
      }

      // Явный порядок групп: «Настройки графика» — в первый столбец,
      // «Цвета линий» — в конец второго столбца.
      var groupOrder = ['Шрифты', 'Толщины линий', 'Настройки графика',
        'Штриховка', 'Цвета тикеров', 'Цвета линий'];
      var _byTitle = {};
      groups.forEach(function (g) { _byTitle[g.__groupTitle] = g; });
      var _ordered = [];
      groupOrder.forEach(function (t) {
        if (_byTitle[t]) { _ordered.push(_byTitle[t]); delete _byTitle[t]; }
      });
      groups.forEach(function (g) {
        if (_byTitle[g.__groupTitle]) { _ordered.push(g); delete _byTitle[g.__groupTitle]; }
      });
      groups = _ordered;

      var cols = mk('div', 'cp-cols');
      var col1 = mk('div', 'cp-col');
      var col2 = mk('div', 'cp-col');
      var half = Math.ceil(groups.length / 2);
      groups.forEach(function (g, i) { (i < half ? col1 : col2).appendChild(g); });
      cols.appendChild(col1); cols.appendChild(col2);
      paneTable.appendChild(cols);

      var actions = mk('div', 'cp-actions');
      var bReset = mk('button', 'cp-btn', 'Сбросить к умолчаниям');
      bReset.addEventListener('click', function () {
        ChartTheme.reset();
        notifyThemeChange();
        buildTable();
        refreshJson();
      });
      actions.appendChild(bReset);
      paneTable.appendChild(actions);
      paneTable.appendChild(mk('div', 'cp-hint', 'Изменения применяются сразу и сохраняются автоматически.'));
    }

    var jsonArea = document.createElement('textarea');
    jsonArea.className = 'cp-json';
    jsonArea.spellcheck = false;

    function refreshJson() { jsonArea.value = collectJSON(); }

    function buildJson() {
      while (paneJson.firstChild) paneJson.removeChild(paneJson.firstChild);
      refreshJson();
      paneJson.appendChild(jsonArea);
      var actions = mk('div', 'cp-actions');
      var bApply = mk('button', 'cp-btn cp-primary', 'Применить');
      bApply.addEventListener('click', function () {
        try {
          applyJSON(jsonArea.value);
          buildTable();
          refreshJson();
        } catch (e) {
          alert('Ошибка JSON: ' + e.message);
        }
      });
      var bReload = mk('button', 'cp-btn', 'Обновить из текущих');
      bReload.addEventListener('click', refreshJson);
      var bCopy = mk('button', 'cp-btn', 'Скопировать');
      bCopy.addEventListener('click', function () {
        jsonArea.select();
        try { document.execCommand('copy'); } catch (e) { /* noop */ }
      });
      actions.appendChild(bApply); actions.appendChild(bReload); actions.appendChild(bCopy);
      paneJson.appendChild(actions);
      paneJson.appendChild(mk('div', 'cp-hint', 'Блок theme — вид графика. Применяется после «Применить».'));
    }

    function activate(isTable) {
      bT.classList.toggle('active', isTable);
      bJ.classList.toggle('active', !isTable);
      paneTable.style.display = isTable ? '' : 'none';
      paneJson.style.display = isTable ? 'none' : '';
      if (!isTable) refreshJson();
    }
    bT.addEventListener('click', function () { activate(true); });
    bJ.addEventListener('click', function () { activate(false); });

    buildTable();
    buildJson();
    activate(true);
  }

  window.ChartConfig = {
    collectJSON: collectJSON,
    applyJSON: applyJSON,
    renderParamsEditor: renderParamsEditor
  };
  window.renderParamsEditor = renderParamsEditor;

})(window, document);