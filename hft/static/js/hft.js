/* hft.js — HFT Monitor SPA: auth, панели, CRM, PanelManager.
 * Зависит от panels.js (PanelManager) и report.js (HftReport).
 */
(function () {
  'use strict';

  var state = { user: null };

  // Общий стейт приложения. panels.js тоже определяет window.HftState,
  // но hft.js загружается последним и гарантирует существование глобала
  // (даже если panels.js — старый кеш или не выполнился).
  window.HftState = window.HftState || { user: null };

  // Панели: id → {label, load, render}. report рендерит себя через HftReport.
  var PANELS = {
    capital: {
      label: 'Инвест-баннер',
      async load() { return {}; },
      render() {
        return '<div class="banner-tools">' +
          '<label>Период <select class="banner-period-sel">' +
          '<option value="-1 day">1 день</option>' +
          '<option value="-7 day">7 дней</option>' +
          '<option value="-35 day" selected>35 дней</option>' +
          '<option value="-90 day">90 дней</option>' +
          '</select></label></div>' +
          '<div class="hft-banner-host"></div>';
      }
    },
    turnover: {
      label: 'Оборот и комиссия',
      async load() { return api('/api/hft/turnover?days=14'); },
      render(data) {
        var days = data.days || {};
        var list = Object.keys(days).sort().reverse();
        if (!list.length) return '<div class="empty">Нет данных оборота</div>';
        var rows = list.map(function (day) {
          var d = days[day];
          return Object.keys(d).map(function (src) {
            var x = d[src];
            var vol = (x.buy || 0) + (x.sell || 0);
            return '<tr><td>' + esc(day) + '</td><td>' + esc(src) +
              '</td><td class="num">' + fmtRub(vol) + '</td>' +
              '<td class="num">' + fmtRub(x.commission) + '</td>' +
              '<td class="num">' + (x.count || 0) + '</td></tr>';
          }).join('');
        }).join('');
        return '<table class="turnover-table"><thead><tr><th>День</th><th>Источник</th>' +
          '<th class="num">Объём ₽</th><th class="num">Комиссия ₽</th>' +
          '<th class="num">Сделки</th></tr></thead><tbody>' + rows + '</tbody></table>';
      }
    },
    tickers: {
      label: 'Тикеры',
      async load() { return api('/api/hft/tickers'); },
      render(data) {
        var list = data.tickers || [];
        if (!list.length) return '<div class="empty">Нет котировок</div>';
        return list.slice(0, 10).map(function (t) {
          return '<div class="ticker-chip"><div class="t-name">' + esc(t.ticker) +
            '</div><div class="t-price">' + esc(t.last == null ? '—' : t.last) +
            '</div></div>';
        }).join('');
      }
    },
    feed: {
      label: 'Лента событий',
      async load() { return api('/api/hft/feed?hours=24'); },
      render(data) {
        var ev = data.events || [];
        if (!ev.length) return '<div class="empty">Нет событий за сутки</div>';
        return '<div class="feed-list">' + ev.slice().reverse().map(function (e) {
          return '<div class="feed-item lvl-' + esc(e.level || 'info') + '">' +
            '<span class="f-ts">' + fmtTs(e.ts) + '</span>' +
            '<span class="f-text">' + esc(e.text) + '</span></div>';
        }).join('') + '</div>';
      }
    },
    report: {
      label: 'Отчёт',
      async load() { return { ok: true }; },
      render() { return '<div id="report-host"></div>'; }
    },
    chart: {
      label: 'График',
      async load() { return { ok: true }; },
      render() {
        var intervals = [
          ['minute', '1M'], ['fivemin', '5M'], ['twentymin', '20M'],
          ['hour', '1H'], ['sixhour', '6H'], ['day', '1D']
        ];
        var periodOpts = [
          ['-90 day', '3 месяца'], ['-35 day', '5 недель'], ['-7 day', '1 неделя'],
          ['-3 day', '3 дня'], ['-1 day', '1.5 дня'], ['-12 hour', '12 часов'],
          ['-6 hour', '6 часов'], ['-3 hour', '3 часа'], ['-1 hour', '1 час']
        ];
        var ibtns = intervals.map(function (it) {
          return '<button data-interval="' + it[0] + '">' + it[1] + '</button>';
        }).join('');
        var sel = periodOpts.map(function (o) {
          return '<option value="' + o[0] + '">' + o[1] + '</option>';
        }).join('');
        return '<div class="chart-toolbar">' +
          '<div class="chart-interval-group">' + ibtns + '</div>' +
          '<select class="chart-period-select">' + sel + '</select>' +
          '</div>' +
          '<div class="chart-canvas-host"></div>';
      }
    },
    weather: {
      label: 'Погода',
      async load() { return { ok: true }; },
      render() { return '<div id="hft-weather-host"></div>'; }
    },
    clock: {
      label: 'Часы',
      async load() { return { ok: true }; },
      render() { return '<div id="hft-clock-host"></div>'; }
    },
    crm: {
      label: 'CRM · пользователи',
      async load() { return api('/api/crm/meta').then(function () { return api('/api/crm/users'); }); },
      render(data) {
        var users = data.users || [];
        return crmTable(users);
      }
    }
  };

  // ── утилиты ────────────────────────────────────
  function $id(id) { return document.getElementById(id); }
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtRub(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }
  function fmtTs(x) {
    if (!x) return '—';
    var d = new Date(typeof x === 'number' ? x * 1000 : Date.parse(x));
    if (isNaN(d)) return String(x);
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }
  async function api(url, opts) {
    var resp = await fetch(url, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts || {}));
    var data;
    try { data = await resp.json(); } catch (e) { data = { ok: false, error: 'bad response' }; }
    if (!resp.ok || data.ok === false) {
      var er = new Error(data.error || ('HTTP ' + resp.status));
      er.status = resp.status;
      throw er;
    }
    return data;
  }

  // ── CRM ────────────────────────────────────────
  function crmTable(users) {
    var metaPanels = metaPanelsList();
    var rows = users.map(function (u) {
      return '<tr data-uid="' + u.id + '">' +
        '<td><input type="text" class="u-login" value="' + esc(u.username) + '" disabled></td>' +
        '<td><select class="u-role">' + mkRoleSel(u.role) + '</select></td>' +
        '<td><input type="text" class="u-tg" value="' + esc(u.tg || '') + '" placeholder="@tg"></td>' +
        '<td><input type="password" class="u-pass" placeholder="новый пароль"></td>' +
        '<td><span class="crm-panel-check">' +
          metaPanels.map(function (p) {
            var on = (u.panels || []).indexOf(p) >= 0;
            return '<label><input type="checkbox" class="u-panel" value="' + p + '"' +
              (on ? ' checked' : '') + (u.role === 'admin' ? ' disabled' : '') + '>' + esc(PANELS[p] ? PANELS[p].label : p) + '</label>';
          }).join('') +
        '</span></td>' +
        '<td><span class="muted">' + fmtTs(u.last_login) + '</span></td>' +
        '<td><button class="btn save u-save">Сохранить</button> ' +
          (u.id === state.user.id ? '' : '<button class="btn danger u-del">Удалить</button>') +
        '</td></tr>';
    }).join('');

    return '<table class="crm-table"><thead><tr><th>Логин</th><th>Роль</th><th>TG</th>' +
      '<th>Пароль</th><th>Доступ к панелям</th><th>Последний вход</th><th>Действия</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="crm-new">' +
        '<input type="text" id="crm-new-login" placeholder="новый логин">' +
        '<input type="password" id="crm-new-pass" placeholder="пароль (мин 6)">' +
        '<input type="text" id="crm-new-tg" placeholder="@tg">' +
        '<select id="crm-new-role"><option value="user">user</option><option value="admin">admin</option></select>' +
        '<button class="btn add" id="crm-new-submit">Создать</button>' +
      '</div>';
  }

  // ── доступные панели ────────────────────────────────────
  // report не показывается в составе мульти-панели: «Отчёт» открывается
  // отдельной страницей (#pm-report-btn → HftReport.open()).
  function metaPanelsList() {
    return Object.keys(PANELS).filter(function (p) { return p !== 'report'; });
  }

  function mkRoleSel(role) {
    return ['admin', 'user'].map(function (r) {
      return '<option value="' + r + '"' + (r === role ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
  }

  function availablePanels() {
    var u = state.user;
    if (!u) return [];
    var src = u.role === 'admin' ? Object.keys(PANELS) : (u.panels || []).filter(function (p) { return PANELS[p]; });
    return src.filter(function (p) { return p !== 'report'; });
  }

  // видимые (не скрытые в раскладке) — рендерятся все сразу (мульти-панель)
  function visiblePanels() {
    return window.PanelManager.visibleOnly(availablePanels());
  }

  // ── хуки для модалки настроек (hft_panel_settings.js) ──────
  window.__hftPanelList = function () { return availablePanels(); };
  window.__hftPanelLabel = function (id) { return PANELS[id] ? PANELS[id].label : id; };
  window.__hftHasPanel = function (p) { return !!PANELS[p] && p !== 'report'; };
  window.__hftOnPanelVisible = function (pid, visible) {
    renderAllPanels();
    // уведомить профили об изменении раскладки
    document.dispatchEvent(new CustomEvent('hft:panel-changed'));
  };
  window.__hftOnLayoutApplied = function () {
    renderAllPanels();
  };

  // остановить виджеты всех панелей (пересборка stage)
  function stopAllWidgets() {
    if (window.HftInvestChart) { try { window.HftInvestChart.stop(); } catch (e) { /* noop */ } }
    if (window.HftWeather) { try { window.HftWeather.stop(); } catch (e) { /* noop */ } }
    if (window.HftClock) { try { window.HftClock.stop(); } catch (e) { /* noop */ } }
  }

  function startWidget(p, panel) {
    if (p === 'chart') {
      var chartHost = panel.querySelector('.chart-canvas-host');
      if (chartHost && window.HftInvestChart) window.HftInvestChart.start(chartHost);
    }
    if (p === 'weather') {
      var wxHost = panel.querySelector('#hft-weather-host');
      if (wxHost && window.HftWeather) window.HftWeather.start(wxHost);
    }
    if (p === 'clock') {
      var clkHost = panel.querySelector('#hft-clock-host');
      if (clkHost && window.HftClock) window.HftClock.start(clkHost);
    }
    if (p === 'capital') {
      var bannerHost = panel.querySelector('.hft-banner-host');
      var periodSel = panel.querySelector('.banner-period-sel');
      if (bannerHost && window.HftBanner) {
        if (periodSel) {
          periodSel.addEventListener('change', function () {
            window.HftBanner.render(bannerHost, periodSel.value);
          });
        }
        window.HftBanner.render(bannerHost, periodSel ? periodSel.value : '-35 day');
      }
    }
  }

  // мульти-панель: рендер ВСЕХ видимых панелей в #stage одновременно
  async function renderAllPanels() {
    stopAllWidgets();
    // страница «Отчёт»: закрываем без хука возврата при пересборке
    if (window.HftReport && window.HftReport.isOpen()) {
      window.HftReport.close(true);
    }
    var stage = $id('stage');
    stage.innerHTML = '';
    var list = visiblePanels();
    if (!list.length) {
      stage.innerHTML = '<div class="empty">Нет видимых панелей</div>';
      return;
    }
    var jobs = list.map(function (p) {
      return buildPanelEl(p);
    });
    var rs = await Promise.all(jobs);
    rs.forEach(function (r) {
      if (!r) return;
      stage.appendChild(r.el);
      window.PanelManager.buildEdges(r.el);
      window.PanelManager.attach(r.el, r.id);
      startWidget(r.id, r.el);
      bindPanelEvents(r.id);
    });
    // после вставки всех панелей пересчитать позиции (мульти-раскладка)
    window.PanelManager.applyAll();
  }

  async function buildPanelEl(p) {
    try {
      var data = await PANELS[p].load();
      var panel = document.createElement('section');
      panel.className = 'hft-panel';
      panel.dataset.panel = p;
      panel.innerHTML =
        '<div class="hft-panel-head"><span class="dot ok"></span>' + esc(PANELS[p].label) +
          '<span class="pm-spacer"></span>' +
          '<button class="pm-head-btn pm-hide" title="Скрыть панель">–</button></div>' +
        '<div class="pm-edges"></div>' +
        '<div class="hft-panel-body">' + PANELS[p].render(data) + '</div>';
      return { el: panel, id: p };
    } catch (e) {
      if (e.status === 401) { showLogin(); return null; }
      var panel = document.createElement('section');
      panel.className = 'hft-panel';
      panel.dataset.panel = p;
      panel.innerHTML =
        '<div class="hft-panel-head"><span class="dot ok"></span>' + esc(PANELS[p].label) +
          '<span class="pm-spacer"></span></div>' +
        '<div class="pm-edges"></div>' +
        '<div class="hft-panel-body"><div class="empty">Ошибка: ' + esc(e.message) + '</div></div>';
      return { el: panel, id: p };
    }
  }

  function bindPanelEvents(p) {
    if (p === 'crm') bindCrmEvents();
    // кнопка «–» в шапке: скрыть панель (если останется хоть одна видимая)
    var el = document.querySelector('#stage > .hft-panel[data-panel="' + p + '"]');
    if (!el) return;
    var hide = el.querySelector('.pm-hide');
    if (hide) {
      hide.addEventListener('click', function () {
        if (visiblePanels().length <= 1) { alert('Нельзя скрыть последнюю панель'); return; }
        window.PanelManager.setVisible(p, false);
        renderAllPanels();
      });
    }
  }

  // ── управление панелями (PanelManager UI) ─────
  // страница «Отчёт» рендерится прямо в main#stage (не модалка)
  function openReportPage() {
    stopAllWidgets();
    var stage = $id('stage');
    stage.innerHTML = '';
    if (window.HftReport) window.HftReport.open(stage);
  }
  // хук закрытия отчёта: возвращаемся к мульти-панели
  window.HftReportOnClose = function () {
    renderAllPanels();
  };

  function bindPanelManagerControls() {
    $id('pm-edit-btn').addEventListener('click', function () {
      window.PanelManager.toggleEditMode();
    });
    // ▦ — модалка настроек панелей (порт wclock panels-modal-content)
    var pmPanelsBtn = $id('pm-panels-btn');
    pmPanelsBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (window.HftPanelSettings) window.HftPanelSettings.open();
    });
    // Отчёт — страница в main#stage (кнопка в шапке)
    var reportBtn = $id('pm-report-btn');
    if (reportBtn) reportBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openReportPage();
    });
    $id('pm-reset-btn').addEventListener('click', function () {
      if (!confirm('Сбросить раскладку панелей к значениям по умолчанию?')) return;
      window.PanelManager.resetAll();
      renderAllPanels();
    });
  }

  // ── CRM events ─────────────────────────────────
  function bindCrmEvents() {
    $id('crm-new-submit').addEventListener('click', crmCreate);
    document.querySelectorAll('.u-save').forEach(function (b) {
      b.addEventListener('click', function () {
        var tr = b.closest('tr');
        var uid = tr.dataset.uid;
        var role = tr.querySelector('.u-role').value;
        var panels = Array.prototype.map.call(
          tr.querySelectorAll('.u-panel:checked'), function (c) { return c.value; });
        var payload = { role: role, panels: panels, tg: tr.querySelector('.u-tg').value };
        var pass = tr.querySelector('.u-pass').value;
        if (pass) payload.password = pass;
        api('/api/crm/users/' + uid, { method: 'PUT', body: JSON.stringify(payload) })
          .then(function () { renderAllPanels(); refreshUserInfo(); })
          .catch(function (er) { alert(er.message); });
      });
    });
    document.querySelectorAll('.u-del').forEach(function (b) {
      b.addEventListener('click', function () {
        var tr = b.closest('tr');
        var uid = tr.dataset.uid;
        if (!confirm('Удалить пользователя?')) return;
        api('/api/crm/users/' + uid, { method: 'DELETE' })
          .then(function () { renderAllPanels(); })
          .catch(function (er) { alert(er.message); });
      });
    });
  }

  function crmCreate() {
    var login = $id('crm-new-login').value.trim();
    var pass = $id('crm-new-pass').value;
    var tg = $id('crm-new-tg').value.trim();
    var role = $id('crm-new-role').value;
    var panels = role === 'admin' ? metaPanelsList() : ['capital', 'turnover', 'feed'];
    api('/api/crm/users', {
      method: 'POST',
      body: JSON.stringify({ username: login, password: pass, role: role, tg: tg, panels: panels })
    }).then(function () { renderAllPanels(); refreshUserInfo(); })
      .catch(function (er) { alert(er.message); });
  }

  // ── login / logout ─────────────────────────────
  function showLogin() {
    state.user = null;
    if (window.HftState) window.HftState.user = null;
    if (window.PanelManager) window.PanelManager.detach();
    $id('app').classList.add('hidden');
    $id('login-screen').classList.remove('hidden');
  }

  function showApp() {
    $id('login-screen').classList.add('hidden');
    $id('app').classList.remove('hidden');
    refreshUserInfo();
    if (!window.PanelManager) { showLogin(); return; }
    window.PanelManager.init($id('stage'));
    bindPanelManagerControls();
    renderAllPanels();
  }

  function refreshUserInfo() {
    var u = state.user;
    $id('user-info').textContent = u ? (u.username + (u.tg ? ' · ' + u.tg : '') +
      (u.role === 'admin' ? ' · admin' : '')) : '';
  }

  async function restore() {
    try {
      var data = await api('/api/auth/me');
      state.user = data.user;
      if (window.HftState) window.HftState.user = data.user;
      showApp();
    } catch (e) { showLogin(); }
  }

  $id('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var username = $id('login-username').value.trim();
    var password = $id('login-password').value;
    $id('login-error').textContent = '';
    api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) })
      .then(function (data) {
        state.user = data.user;
        if (window.HftState) window.HftState.user = data.user;
        showApp();
      })
      .catch(function (er) { $id('login-error').textContent = er.message; });
  });

  $id('logout-btn').addEventListener('click', function () {
    api('/api/auth/logout', { method: 'POST' }).finally(function () { showLogin(); });
  });

  restore();
})();