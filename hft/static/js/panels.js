/* panels.js — PanelManager: абстракция управления панелями HFT.
 * Раскладка (позиция/размер/видимость) хранится по пользователю:
 * localStorage (кэш) + сервер /api/hft/layout (hft_crm.db panel_layouts).
 * Режимы: обычный (только показ) и edit (drag по заголовку + resize 8 handles).
 * Зависимостей нет — работает поверх любого контейнера (#stage).
 */
(function (window) {
  'use strict';

  // Общий стейт приложения: определяется здесь (загружается раньше hft.js),
  // чтобы panels.js и hft.js имели единый источник user.
  window.HftState = window.HftState || { user: null };

var LAYOUT_KEY = 'hft_panel_layout_';
var EDIT_KEY = 'hft_panel_edit_mode';
var LAYOUT_VERSION = 3; // v1: x/y = центр от центра stage; v2: отступ ЛЕВ.ВЕРХ.УГЛА; v3: мультипанель (сетка по всем видимым)

  // Мультипанельная сетка: все видимые панели на stage одновременно (как wclock).
  // Позиции считаются от центра stage: x/y — отступ ЛЕВОГО ВЕРХНЕГО угла панели.
  // План по колонкам (доли ширины/высоты stage) — новые панели (weather/clock)
  // идут в правую колонку, т.е. каскадом вправо-вниз от основных.
  var GRID_PLAN = [
    { id: 'capital',  col: 0, h: 0.30 },
    { id: 'turnover', col: 0, h: 0.26 },
    { id: 'tickers',  col: 0, h: 0.20 },
    { id: 'feed',     col: 1, h: 0.34 },
    { id: 'chart',    col: 1, h: 0.52 },
    { id: 'weather',  col: 2, h: 0.34 },
    { id: 'clock',    col: 2, h: 0.24 },
    { id: 'crm',      col: 2, h: 0.30 }
  ];
  var GRID_COLS = [0.34, 0.38, 0.28];

  function defaultLayout() {
    var s = stageSize();
    var sw = Math.max(s.sw, 900), sh = Math.max(s.sh, 480);
    var mx = 12, gap = 16;
    var xs = [], colTops = {}, acc = -Math.round(sw / 2) + mx;
    GRID_COLS.forEach(function (f, i) {
      xs[i] = acc;
      colTops[i] = -Math.round(sh / 2) + mx;
      acc += Math.round(sw * f) + gap;
    });
    var panels = {};
    GRID_PLAN.forEach(function (p) {
      var w = Math.round((sw - mx * 2 - gap * 2) * GRID_COLS[p.col]);
      var h = Math.round(sh * p.h);
      panels[p.id] = {
        visible: true,
        x: xs[p.col],
        y: colTops[p.col],
        w: w,
        h: h
      };
      colTops[p.col] += h + gap;
    });
    // report — страница, в мультипанели не участвует (арендуется шапкой)
    panels.report = { visible: false, x: 40, y: 20, w: 900, h: 480 };
    return { version: LAYOUT_VERSION, panels: panels };
  }

  var MIN_W = 280, MIN_H = 180;
  var cfg = null;      // раскладка {panels: {id: {visible,x,y,w,h}}}
  var stageEl = null;  // контейнер #stage
  // Реестр прикреплённых панелей: id → .hft-panel el (несколько одновременно)
  var attached = {};
  var editMode = false;
  var saveTimer = null;

  // ── загрузка ─────────────────────────────────────────────────
  function storageKey() {
    return LAYOUT_KEY + (window.HftState && window.HftState.user ? window.HftState.user.id : 'anon');
  }

  // v2→v3: одно-панельный режим → мультипанель. Ключевые панели (weather/
  // clock), которых не было в старой раскладке, получают новые позиции
  // (каскад), а перекрывающиеся старые координаты пересобираются в сетку.
  function migrateV2toV3(panels) {
    if (!panels) return;
    var present = {};
    Object.keys(panels).forEach(function (id) {
      var p = panels[id];
      if (p) {
        present[id] = p.visible !== false;
        if (id === 'report') present[id] = false;
      }
    });
    // старые центральные позиции из v2 рассчитаны на одну панель за раз —
    // для мульти-экрана берём сетку, сохраняя видимости
    cfg = defaultLayout();
    Object.keys(present).forEach(function (id) {
      if (cfg.panels[id]) cfg.panels[id].visible = present[id];
    });
    saveLocal();
  }

  function load() {
    cfg = defaultLayout();
    try {
      var raw = localStorage.getItem(storageKey());
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.panels) {
          var v = parsed.version || 1;
          if (v < 2) migrateLayout(parsed.panels);
          if (v < LAYOUT_VERSION) {
            migrateV2toV3(parsed.panels);
            return cfg;
          }
          Object.keys(parsed.panels).forEach(function (id) {
            var p = parsed.panels[id];
            if (!p || id === 'report') return; // report — страница, не хранится в локальной раскладке
            cfg.panels[id] = Object.assign(cfg.panels[id] || {}, {
              visible: p.visible !== false,
              x: numOr(p.x, cfg.panels[id] ? cfg.panels[id].x : 0),
              y: numOr(p.y, cfg.panels[id] ? cfg.panels[id].y : 0),
              w: Math.max(numOr(p.w, cfg.panels[id] ? cfg.panels[id].w : MIN_W), MIN_W),
              h: Math.max(numOr(p.h, cfg.panels[id] ? cfg.panels[id].h : MIN_H), MIN_H)
            });
          });
        }
      }
    } catch (e) {
      console.warn('[PanelManager] local load:', e);
    }
    return cfg;
  }

  function numOr(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  // v1: x/y = центр панели от центра stage → v2: отступ левого верхнего угла
  function migrateLayout(panels) {
    if (!panels) return;
    Object.keys(panels).forEach(function (id) {
      var p = panels[id];
      if (p && typeof p.x === 'number') p.x = p.x - (p.w || MIN_W) / 2;
      if (p && typeof p.y === 'number') p.y = p.y - (p.h || MIN_H) / 2;
    });
  }

  // Объединить серверную раскладку (локальная свежее при конфликте — см. lock)
  function mergeServer(raw) {
    if (!raw) return;
    try {
      var s = JSON.parse(raw);
      if (!s || !s.panels) return;
      var v = s.version || 1;
      if (v < 2) migrateLayout(s.panels);
      if (v < LAYOUT_VERSION) {
        var present = {};
        Object.keys(s.panels).forEach(function (id) {
          present[id] = s.panels[id] ? s.panels[id].visible !== false : true;
        });
        cfg = defaultLayout();
        Object.keys(present).forEach(function (id) {
          if (cfg.panels[id]) cfg.panels[id].visible = present[id];
        });
        saveLocal();
        return;
      }
      Object.keys(s.panels).forEach(function (id) {
        var p = s.panels[id];
        if (!p) return;
        cfg.panels[id] = Object.assign(cfg.panels[id] || {}, {
          visible: p.visible !== false,
          x: numOr(p.x, cfg.panels[id] ? cfg.panels[id].x : 0),
          y: numOr(p.y, cfg.panels[id] ? cfg.panels[id].y : 0),
          w: Math.max(numOr(p.w, cfg.panels[id] ? cfg.panels[id].w : MIN_W), MIN_W),
          h: Math.max(numOr(p.h, cfg.panels[id] ? cfg.panels[id].h : MIN_H), MIN_H)
        });
      });
    } catch (e) {
      console.warn('[PanelManager] server merge:', e);
    }
  }

  function serialize() {
    return JSON.stringify({ version: LAYOUT_VERSION, panels: cfg.panels });
  }

  function saveLocal() {
    try { localStorage.setItem(storageKey(), serialize()); } catch (e) { /* noop */ }
  }

  var serverDirty = false;
  function save() {
    saveLocal();
    serverDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      serverDirty = false;
      fetch('/api/hft/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ layout: serialize() })
      }).catch(function () { /* сервер недоступен — останется локально */ });
    }, 400);
  }

  // ── конфиг отдельной панели ────────────────────────────────
  function getPanel(id) {
    if (!cfg) load();
    return cfg.panels[id] || (cfg.panels[id] = { visible: true, x: 0, y: 0, w: MIN_W, h: MIN_H });
  }

  function clonePanel(id) { return Object.assign({}, getPanel(id)); }

  function setPanel(id, patch) {
    var p = getPanel(id);
    Object.keys(patch).forEach(function (k) {
      if (k === 'visible') p.visible = !!patch[k];
      else if (k in p && typeof patch[k] === 'number' && isFinite(patch[k])) p[k] = patch[k];
    });
    p.w = Math.max(p.w, MIN_W);
    p.h = Math.max(p.h, MIN_H);
    save();
  }

  // ── привязка панели к stage ────────────────────────────────
  function stageSize() {
    if (!stageEl) return { sw: window.innerWidth, sh: window.innerHeight };
    var r = stageEl.getBoundingClientRect();
    return { sw: r.width, sh: r.height };
  }

  // viewport-координаты левого верхнего угла #stage
  // (drag/capture работают в координатах stage, а не viewport)
  function stageOrigin() {
    if (!stageEl) return { left: 0, top: 0 };
    var r = stageEl.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  function clampToStage(c) {
    var s = stageSize();
    c.w = Math.min(Math.max(c.w, MIN_W), s.sw);
    c.h = Math.min(Math.max(c.h, MIN_H), s.sh);
    var margin = 8;
    // v2: x/y — отступ ЛЕВ.ВЕРХ.УГЛА от центра stage (left = sw/2 + x).
    // Клэмп в границы stage: левый край панели ≥ left-граница, правый ≤ right-граница.
    c.x = Math.max(margin - s.sw / 2, Math.min(c.x, s.sw / 2 - c.w - margin));
    c.y = Math.max(margin - s.sh / 2, Math.min(c.y, s.sh / 2 - c.h - margin));
    return c;
  }

  // Применить конфиг к DOM: центр конфига = центр stage
  function apply(el, id) {
    var c = clampToStage(clonePanel(id));
    var s = stageSize();
    var left = Math.round(s.sw / 2 + c.x);
    var top = Math.round(s.sh / 2 + c.y);
    pan(el, left, top, c.w, c.h);
  }

  function pan(el, left, top, w, h) {
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  function capture(el, id) {
    var r = el.getBoundingClientRect();
    var o = stageOrigin();
    var s = stageSize();
    // отступ ЛЕВОГО КРАЯ панели от центра stage (координаты stage, не viewport)
    var c = getPanel(id);
    c.x = Math.round((r.left - o.left) - s.sw / 2);
    c.y = Math.round((r.top - o.top) - s.sh / 2);
    c.w = Math.round(r.width);
    c.h = Math.round(r.height);
  }

  // ── drag/resize (pointer events) ────────────────────────────
  // Мульти-панель: несколько .hft-panel одновременно в #stage,
  // реестр attached держит их параллельно без снятия соседних.
  function attach(el, id) {
    if (attached[id] && attached[id] !== el && attached[id].parentNode) {
      try { attached[id].parentNode.removeChild(attached[id]); } catch (e) { /* noop */ }
    }
    attached[id] = el;
    apply(el, id);
    el.classList.toggle('pm-edit', editMode);
    bindPointer(el, id);
    // поднять панель на передний план при фокусе
    el.addEventListener('pointerdown', function () { bringToFront(el); }, true);
  }

  function detach(el, id) {
    // конкретная панель: сохранить её позицию и снять привязку
    if (el && id) {
      if (attached[id] === el) { capture(el, id); delete attached[id]; }
      return;
    }
    // все панели (полный сброс stage)
    Object.keys(attached).forEach(function (pid) {
      var e = attached[pid];
      if (e && e.parentNode) { try { capture(e, pid); } catch (er) { /* noop */ } }
    });
    Object.keys(attached).forEach(function (pid) { delete attached[pid]; });
  }

  function bringToFront(el) {
    var maxZ = 1, base = 1;
    Object.keys(attached).forEach(function (id) {
      var e = attached[id];
      if (!e || e === el) return;
      var z = parseInt(e.style.zIndex || '', 10);
      if (isFinite(z) && z > maxZ) maxZ = z;
    });
    el.style.zIndex = String(Math.max(base, maxZ + 1));
  }

  // пересчитать и применить позицию ко ВСЕМ привязанным панелям
  // (при resize окна: панели сохраняют экранное положение и не «уплывают»
  // из stage; уехавшие за край подтягиваются обратно в границы).
  function applyAll() {
    Object.keys(attached).forEach(function (id) {
      var el = attached[id];
      if (!el || !el.parentNode) return;
      try {
        capture(el, id);
        apply(el, id);
      } catch (e) { /* noop */ }
    });
    document.dispatchEvent(new CustomEvent('hft:panel-resized'));
  }

  function bindPointer(el, id) {
    var head = el.querySelector('.hft-panel-head');
    var edges = Array.prototype.slice.call(el.querySelectorAll('.pm-edge'));
    var drag = null, rect = null, s = null;
    var startClientX = 0, startClientY = 0;

    function begin(dir, e) {
      drag = dir;
      var r = el.getBoundingClientRect();
      var o = stageOrigin();
      // переводим в координаты stage (left/top панели задаются относительно #stage)
      rect = { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
      s = stageSize();
      startClientX = e.clientX;
      startClientY = e.clientY;
      el.classList.add('pm-moving');
    }

    function move(e) {
      if (!drag) return;
      var dx = e.clientX - startClientX;
      var dy = e.clientY - startClientY;
      // база — исходные координаты; при resize правой/нижней грани
      // левый верхний угол панели остаётся на месте
      var n = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (drag === 'move') {
        n.x += dx; n.y += dy;
      } else {
        if (drag.indexOf('e') !== -1) n.w = Math.max(MIN_W, rect.w + dx);
        if (drag.indexOf('s') !== -1) n.h = Math.max(MIN_H, rect.h + dy);
        if (drag.indexOf('w') !== -1) {
          n.w = Math.max(MIN_W, rect.w - dx);
          n.x = rect.x + rect.w - n.w;
        }
        if (drag.indexOf('n') !== -1) {
          n.h = Math.max(MIN_H, rect.h - dy);
          n.y = rect.y + rect.h - n.h;
        }
      }
      pan(el, n.x, n.y, n.w, n.h);
      el.classList.add('pm-dragging');
    }

    function end() {
      if (!drag) return;
      drag = null;
      el.classList.remove('pm-dragging', 'pm-moving');
      capture(el, id);
      save();
    }

    function onDown(dir, e) {
      if (!editMode) return;
      e.preventDefault();
      begin(dir, e);
      var moveFn = function (ev) { move(ev); };
      var upFn = function (ev) {
        window.removeEventListener('pointermove', moveFn);
        window.removeEventListener('pointerup', upFn);
        window.removeEventListener('pointercancel', upFn);
        end();
      };
      window.addEventListener('pointermove', moveFn);
      window.addEventListener('pointerup', upFn);
      window.addEventListener('pointercancel', upFn);
    }

    if (head) head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.pm-del, .pm-vis, .pm-max')) return;
      if (!editMode) return;
      onDown('move', e);
    });
    edges.forEach(function (h) {
      h.addEventListener('pointerdown', function (e) { onDown(h.dataset.dir || 'se', e); });
    });
  }

  function buildEdges(el) {
    var wrap = el.querySelector('.pm-edges');
    if (!wrap) return;
    // 4 грани + 4 угла — resize тянется за край панели (без видимых хендлов)
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (d) {
      var z = document.createElement('div');
      z.className = 'pm-edge pm-e-' + d;
      z.dataset.dir = d;
      wrap.appendChild(z);
    });
  }

  // ── edit-mode ───────────────────────────────────────────────
  function visitAll(fn) {
    Object.keys(attached).forEach(function (id) { if (attached[id]) fn(attached[id]); });
  }

  function setEditMode(on) {
    editMode = !!on;
    try { localStorage.setItem(EDIT_KEY, editMode ? '1' : '0'); } catch (e) { /* noop */ }
    visitAll(function (el) {
      el.classList.toggle('pm-edit', editMode);
      el.style.cursor = editMode ? 'move' : '';
    });
    var btn = document.getElementById('pm-edit-btn');
    if (btn) btn.classList.toggle('active', editMode);
  }

  function toggleEditMode() { setEditMode(!editMode); }

  // ── видимость ───────────────────────────────────────────────
  function isVisible(id) { return getPanel(id).visible; }
  function setVisible(id, v) {
    var p = getPanel(id);
    p.visible = !!v;
    save();
  }
  function visibleOnly(ids) {
    return ids.filter(function (id) { return getPanel(id).visible; });
  }

  function resetAll() {
    cfg = defaultLayout();
    save();
  }

  // ── профили: слепок/применение раскладки ────────────────────
  function layoutSnapshot() {
    if (!cfg) load();
    return JSON.stringify(cfg.panels);
  }

  function applyLayoutRaw(raw) {
    try {
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return false;
      Object.keys(s).forEach(function (id) {
        var p = s[id];
        cfg.panels[id] = Object.assign(cfg.panels[id] || {}, {
          visible: p.visible !== false,
          x: numOr(p.x, cfg.panels[id] ? cfg.panels[id].x : 0),
          y: numOr(p.y, cfg.panels[id] ? cfg.panels[id].y : 0),
          w: Math.max(numOr(p.w, cfg.panels[id] ? cfg.panels[id].w : MIN_W), MIN_W),
          h: Math.max(numOr(p.h, cfg.panels[id] ? cfg.panels[id].h : MIN_H), MIN_H)
        });
      });
      save();
      return true;
    } catch (e) {
      console.warn('[PanelManager] applyLayout:', e);
      return false;
    }
  }

  function layoutEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // ── инициализация ───────────────────────────────────────────
  function init(stage) {
    stageEl = stage;
    load();
    try {
      editMode = localStorage.getItem(EDIT_KEY) === '1';
    } catch (e) { editMode = false; }
    var btn = document.getElementById('pm-edit-btn');
    if (btn) btn.classList.toggle('active', editMode);

    // серверная раскладка (локальная свежее при равенстве — mergeServer не переписывает отсутствующие ключи без признака)
    fetch('/api/hft/layout', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.layout) mergeServer(d.layout);
        if (Object.keys(attached).length) { applyAll(); saveLocal(); }
      })
      .catch(function () { /* сервер недоступен */ });

    window.addEventListener('resize', function () {
      if (Object.keys(attached).length) applyAll();
    });
  }

  window.PanelManager = {
    init: init,
    load: load,
    getPanel: getPanel,
    clonePanel: clonePanel,
    setPanel: setPanel,
    attach: attach,
    detach: detach,
    apply: apply,
    applyAll: applyAll,
    capture: capture,
    setEditMode: setEditMode,
    toggleEditMode: toggleEditMode,
    isEditMode: function () { return editMode; },
    isVisible: isVisible,
    setVisible: setVisible,
    visibleOnly: visibleOnly,
    resetAll: resetAll,
    applyLayoutRaw: applyLayoutRaw,
    layoutSnapshot: layoutSnapshot,
    layoutEqual: layoutEqual,
    getLayout: function () { if (!cfg) load(); return cfg.panels; },
    buildEdges: buildEdges,
    save: save
  };
})(window);