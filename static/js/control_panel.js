// static/js/control_panel.js

function createControlPanel() {
  console.log('[ControlPanel] createControlPanel called');
  const panelHook = document.getElementById('chart_control_panel');
  if (!panelHook) {
    console.log('[ControlPanel] panelHook not found, retrying...');
    setTimeout(createControlPanel, 100);
    return;
  }

  const existing = panelHook.querySelector('#panels-list-btn');
  if (existing) {
    console.log('[ControlPanel] already populated');
    return;
  }

  // Элементы кладём непосредственно в #chart_control_panel
  const $panel = $(panelHook);

  // Panels list button — открывает единую модалку Отчётов (вкладка «Настройки»)
  const $panelsBtn = $('<button id="panels-list-btn" class="toggle-btn" title="Отчёты и настройки">☰</button>')
    .on('click', function() {
      if (window.Report && typeof window.Report.open === 'function') {
        window.Report.open('settings');
        return;
      }
      togglePanelsModal();
    });
  $panel.append($panelsBtn);

  // Panel buttons (edit, reset, export)
  const $panelButtons = $('<div class="panel-buttons"></div>');
  
  const $editBtn = $('<button id="edit_mode_btn" title="Режим редактирования">✎</button>')
    .on('click touchend', function(e) {
      e.preventDefault();
      if (typeof window.toggleEditMode === 'function') {
        window.toggleEditMode();
      }
    });
  $panelButtons.append($editBtn);

  $panel.append($panelButtons);

  // Interval buttons + auto-shift period toward more detail
  const $intervalGroup = $('<div class="interval-group"></div>');

  const intervals = [
    { key: 'minute',  label: '1M' },
    { key: 'fivemin', label: '5M' },
    { key: 'twentymin', label: '20M' },
    { key: 'hour',    label: '1H' },
    { key: 'sixhour', label: '6H' },
    { key: 'day',     label: '1D' }
  ];

  // Период по умолчанию (максимально допустимый) для детализации по интервалу:
  // чем чаще интервал, тем короче период.
  const maxPeriodByInterval = {
    minute:   '-6 hour',
    fivemin:  '-1 day',
    twentymin:'-3 day',
    hour:     '-7 day',
    sixhour:  '-35 day',
    day:      '-90 day'
  };
  // Период, в который укорачиваем, если текущий слишком длинный для интервала.
  const defaultPeriodByInterval = {
    minute:   '-6 hour',
    fivemin:  '-1 day',
    twentymin:'-3 day',
    hour:     '-7 day',
    sixhour:  '-35 day',
    day:      '-90 day'
  };
  const _UNIT_SEC = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
  function periodToSec(p) {
    if (typeof p !== 'string') return 0;
    const m = String(p).match(/([\d.]+)\s*(second|minute|hour|day|week)s?/);
    if (!m) return 0;
    return Math.abs(parseFloat(m[1])) * (_UNIT_SEC[m[2]] || 0);
  }
  // === Диапазон (Kibana-style): только «с/по» + пресеты для заполнения ===
  const PRESETS = [
    { label: '1 час',   sec: 3600 },
    { label: '3 часа',  sec: 3 * 3600 },
    { label: '6 часов', sec: 6 * 3600 },
    { label: '12 часов',sec: 12 * 3600 },
    { label: '1 день',  sec: 86400 },
    { label: '2 дня',   sec: 2 * 86400 },
    { label: '3 дня',   sec: 3 * 86400 },
    { label: '1 неделя',sec: 7 * 86400 },
    { label: '2 недели',sec: 14 * 86400 },
    { label: '4 недели',sec: 28 * 86400 },
    { label: '3 месяца',sec: 90 * 86400 }
  ];

  // Текущая длина диапазона в секундах (из start/end; иначе из invest_panel_period)
  function currentRangeSec() {
    var s = getSetting('invest_panel_start_ts', null);
    var e = getSetting('invest_panel_end_ts', null);
    if (s && e) {
      var eSec = (e === 'live') ? Math.floor(Date.now() / 1000) : parseInt(e, 10);
      var sec = eSec - parseInt(s, 10);
      return sec > 0 ? sec : 0;
    }
    return periodToSec(getSetting('invest_panel_period', '-35 day'));
  }

  // Запомненный диапазон по интервалу (локально)
  function loadRangeByInterval() {
    try { return JSON.parse(localStorage.getItem('invest_range_by_interval') || '{}'); } catch (e) { return {}; }
  }
  function rememberRangeForInterval(intvKey, sEpoch, eEpoch) {
    var map = loadRangeByInterval();
    map[intvKey] = sEpoch + ':' + eEpoch;
    try { localStorage.setItem('invest_range_by_interval', JSON.stringify(map)); } catch (e) {}
  }
  function rememberRange(sEpoch, eEpoch) {
    if (!window.currentInterval) return;
    rememberRangeForInterval(window.currentInterval, sEpoch, eEpoch);
  }

  // Обратная пара «диапазон → интервал»: при выборе периода восстанавливаем
  // сохранённый интервал для этого диапазона.
  function loadIntervalByRange() {
    try { return JSON.parse(localStorage.getItem('invest_interval_by_range') || '{}'); } catch (e) { return {}; }
  }
  function rememberIntervalForRange(sEpoch, eEpoch) {
    if (!window.currentInterval) return;
    var map = loadIntervalByRange();
    map[sEpoch + ':' + eEpoch] = window.currentInterval;
    try { localStorage.setItem('invest_interval_by_range', JSON.stringify(map)); } catch (e) {}
  }
  function restoreIntervalForRange(sEpoch, eEpoch) {
    var iv = loadIntervalByRange()[sEpoch + ':' + eEpoch];
    if (!iv || iv === window.currentInterval) return false;
    window.currentInterval = iv;
    try { localStorage.setItem('chartInterval', iv); } catch (e) {}
    $('.interval-btn').removeClass('active');
    $('.interval-btn[data-interval="' + iv + '"]').addClass('active');
    return true;
  }
  // Восстановленный диапазон для интервала {s, e} или null
  function savedRangeForInterval(intvKey) {
    var r = loadRangeByInterval()[intvKey];
    if (!r) return null;
    var p = r.split(':');
    var s = parseInt(p[0], 10), e = parseInt(p[1], 10);
    if (!s || !e || e <= s) return null;
    return { s: s, e: e };
  }

  // Применяет сдвиг диапазона, если текущий длиннее допустимого для интервала.
  // Учитывает последний сохранённый пользователем диапазон для этого интервала.
  // Сохраняет живой конец ('live'), если он был выбран.
  function applyPeriodForInterval(intvKey) {
    // Всегда фиксируем «текущий диапазон → выбранный интервал»
    var s = getSetting('invest_panel_start_ts', null);
    var e = getSetting('invest_panel_end_ts', null);
    if (s && e) {
      var eNum = (e === 'live') ? Math.floor(Date.now() / 1000) : parseInt(e, 10);
      rememberRangeForInterval(intvKey, parseInt(s, 10), eNum);
      rememberIntervalForRange(parseInt(s, 10), eNum);
    }
    var maxSec = periodToSec(maxPeriodByInterval[intvKey]);
    if (currentRangeSec() <= maxSec) return; // уже подходит
    var live = getSetting('invest_panel_end_ts', null) === 'live';
    var saved = savedRangeForInterval(intvKey);
    var eRange = live ? 'live' : Math.floor(Date.now() / 1000);
    var endNum = (eRange === 'live') ? Math.floor(Date.now() / 1000) : eRange;
    var sRange = saved ? saved.s : (endNum - Math.min(maxSec, periodToSec(defaultPeriodByInterval[intvKey])));
    applyRangeRaw(sRange, eRange);
  }

  // Применяет диапазон {s,e} без повторной проверки длины.
  // eEpoch может быть числом (фикс. конец) или 'live' (живой конец = текущий момент).
  function applyRangeRaw(sEpoch, eEpoch) {
    var eNum = (eEpoch === 'live') ? Math.floor(Date.now() / 1000) : parseInt(eEpoch, 10);
    if (!sEpoch || eNum == null || isNaN(eNum) || eNum <= parseInt(sEpoch, 10)) return;
    var eStore = (eEpoch === 'live') ? 'live' : String(eEpoch);
    setSetting('invest_panel_start_ts', String(sEpoch));
    setSetting('invest_panel_end_ts', eStore);
    saveSettingsToServer({ invest_panel_start_ts: String(sEpoch), invest_panel_end_ts: eStore });
    rememberRange(sEpoch, eNum);
    rememberIntervalForRange(sEpoch, eNum);
    if (typeof syncRangeInputs === 'function') syncRangeInputs(sEpoch, eStore);
    // Оповещаем баннер, чтобы колонки «за период» пересчитались под новое окно графика.
    $(document).trigger('panelViewChange', { panel: 'invest_panel', view: 'range', sEpoch: sEpoch, eEpoch: eStore });
  }

  intervals.forEach(intv => {
    const $btn = $('<button class="interval-btn"></button>')
      .attr('data-interval', intv.key)
      .text(intv.label)
      .on('click', function() {
        $('.interval-btn').removeClass('active');
        $(this).addClass('active');
        currentInterval = $(this).attr('data-interval');
        window.currentInterval = currentInterval;
        try { localStorage.setItem('chartInterval', currentInterval); } catch (e) {}

        applyPeriodForInterval(currentInterval);
        saveChartState();

        if (currentView === 'invest') {
          window.InvestPlot?.update();
        } else {
          batteryLevel();
        }
      });
    $intervalGroup.append($btn);
  });

  $panel.append($intervalGroup);

  // === Период: Kibana-style (пресеты заполняют календарь «с/по», всё применяется как диапазон) ===
  function toDatetimeLocal(ts) {
    var d = new Date(ts);
    var pad = function(n){ return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function toEpoch(dtLocalVal) {
    if (!dtLocalVal) return null;
    var d = new Date(dtLocalVal);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }

  // === Период: триггер-кнопка → dropdown-модалка (пресеты + календарь «с/по») ===
  const $periodBtn = $('<button class="period-trigger" title="Период графика"></button>');
  $panel.append($periodBtn);

  const $rangeModal = $('<div class="period-range-modal" style="display:none;"></div>');
  const $rmHeader = $('<div class="period-range-modal-header"><span>Период графика</span><button class="period-range-close" type="button">&times;</button></div>');
  const $presetSelect = $('<select class="panel-view-select" title="Быстрый период"></select>');
  $presetSelect.append($('<option></option>').attr('value', '__none__').text('Быстрый период...'));
  PRESETS.forEach(function(p, i) {
    $presetSelect.append($('<option></option>').attr('value', String(i)).text(p.label));
  });
  const $rangeBody = $('<div class="period-range-body"></div>');
  const $from = $('<input type="datetime-local" class="period-range-input" title="С">');
  const $to = $('<input type="datetime-local" class="period-range-input" title="По">');
  const $liveChk = $('<input type="checkbox" class="period-range-live" title="До текущего момента (живое обновление)">');
  const $liveLabel = $('<label class="period-range-live-label">сейчас</label>');
  const $rangeRow = $('<div class="period-range-row"></div>');
  $rangeRow.append($('<span>с</span>'), $from, $('<span>по</span>'), $to, $liveLabel.append($liveChk));
  const $applyBtn = $('<button class="period-range-apply" type="button">Применить</button>');
  // Применить — сверху, чтобы не перекрывался контролом календаря.
  $rangeBody.append($applyBtn, $presetSelect, $rangeRow);
  $rangeModal.append($rmHeader, $rangeBody);
  $('body').append($rangeModal);

  // Позиционирование dropdown-модалки под панелью
  function positionModal() {
    var el = panelHook;
    var r = el.getBoundingClientRect();
    var mw = $rangeModal.outerWidth() || 300;
    var left = r.left + r.width - mw;
    if (left < 8) left = 8;
    var top = r.bottom + 4;
    if (top + $rangeModal.outerHeight() > window.innerHeight - 8) {
      top = r.top - $rangeModal.outerHeight() - 4;
      if (top < 8) top = Math.max(8, window.innerHeight - $rangeModal.outerHeight() - 8);
    }
    $rangeModal.css({ left: left + 'px', top: top + 'px' });
  }
  function toggleModal(force) {
    var show = force !== undefined ? force : ($rangeModal.css('display') === 'none');
    if (show) {
      positionModal();
      $rangeModal.show();
    } else {
      $rangeModal.hide();
    }
  }
  $periodBtn.on('click', function(e) { e.stopPropagation(); toggleModal(); });
  $rangeModal.find('.period-range-close').on('click', function() { toggleModal(false); });
  $(document).on('click', function(e) {
    if (!$rangeModal[0].contains(e.target) && !$periodBtn[0].contains(e.target)) {
      toggleModal(false);
    }
  });
  $(window).on('resize', function() { if ($rangeModal.css('display') !== 'none') positionModal(); });

  // Перетаскивание dropdown-модалки за шапку
  var dragState = null;
  $rangeModal.find('.period-range-modal-header').on('mousedown', function(e) {
    if ($(e.target).hasClass('period-range-close')) return;
    dragState = { dx: e.clientX - $rangeModal[0].offsetLeft, dy: e.clientY - $rangeModal[0].offsetTop };
    e.preventDefault();
  });
  $(document).on('mousemove', function(e) {
    if (!dragState) return;
    $rangeModal.css({ left: (e.clientX - dragState.dx) + 'px', top: (e.clientY - dragState.dy) + 'px' });
  });
  $(document).on('mouseup', function() { dragState = null; });

  // Обновить поля календаря из диапазона {s,e}. e может быть 'live'.
  function syncRangeInputs(sEpoch, eEpoch) {
    var live = (eEpoch === 'live');
    $from.val(toDatetimeLocal(parseInt(sEpoch, 10) * 1000));
    if (live) {
      $to.val(toDatetimeLocal(Date.now())).prop('disabled', true);
      $liveChk.prop('checked', true);
    } else {
      $to.val(toDatetimeLocal(parseInt(eEpoch, 10) * 1000)).prop('disabled', false);
      $liveChk.prop('checked', false);
    }
    $periodBtn.text(summaryLabel(sEpoch, eEpoch));
  }
  function summaryLabel(sEpoch, eEpoch) {
    var d = function(ts) {
      var x = new Date(ts * 1000);
      var mm = x.getMonth() + 1 < 10 ? '0' + (x.getMonth() + 1) : '' + (x.getMonth() + 1);
      var dd = x.getDate() < 10 ? '0' + x.getDate() : '' + x.getDate();
      return dd + '.' + mm;
    };
    if (eEpoch === 'live') return d(sEpoch) + '–' + 'сейчас';
    return d(sEpoch) + '–' + d(eEpoch);
  }

  // Применить выбранный пресет (быстрый период): конец по умолчанию — «сейчас».
  function applyPreset(index) {
    var p = PRESETS[index];
    if (!p) return;
    var now = Math.floor(Date.now() / 1000);
    restoreIntervalForRange(now - p.sec, Math.floor(Date.now() / 1000));
    applyRangeRaw(now - p.sec, 'live');
    triggerRender();
  }
  $presetSelect.on('change', function() {
    var v = this.value;
    if (v === '__none__') return;
    applyPreset(parseInt(v, 10));
    this.value = '__none__';
    toggleModal(false);
  });

  // Применить ручной диапазон из календаря.
  function applyRange() {
    var s = toEpoch($from.val());
    var live = $liveChk.is(':checked');
    var e = live ? 'live' : toEpoch($to.val());
    if (s == null || (!live && (e == null || e <= s))) { alert('Укажи корректные «с» и «по» даты'); return; }
    restoreIntervalForRange(s, live ? Math.floor(Date.now() / 1000) : e);
    applyRangeRaw(s, e);
    triggerRender();
    toggleModal(false);
  }
  $applyBtn.on('click', applyRange);

  // Включение/выключение «сейчас»: блокирует/разблокирует поле «по».
  $liveChk.on('change', function() {
    if (this.checked) {
      $to.prop('disabled', true);
    } else {
      $to.prop('disabled', false);
      if (!$to.val()) $to.val(toDatetimeLocal(Date.now()));
    }
  });

  function triggerRender() {
    if (currentView === 'invest') {
      window.InvestPlot && window.InvestPlot.update();
    } else {
      batteryLevel();
    }
  }

  // Инициализация: если есть сохранённый диапазон — показать его, иначе применить fallback период.
  var initS = getSetting('invest_panel_start_ts', null);
  var initE = getSetting('invest_panel_end_ts', null);
  if (initS && initE) {
    syncRangeInputs(parseInt(initS, 10), initE);
  } else {
    // Первый запуск / нет диапазона: применяем сохранённый относительный период (fallback)
    var fb = periodToSec(getSetting('invest_panel_period', '-35 day')) || (7 * 86400);
    var now = Math.floor(Date.now() / 1000);
    applyRangeRaw(now - fb, now);
  }

  // Restore saved interval
  const savedInterval = getSetting('chartInterval', 'hour');
  $panel.find(`[data-interval="${savedInterval}"]`).addClass('active');
  window.currentInterval = savedInterval;

  console.log('[ControlPanel] populated, children:', panelHook.children.length);
}

// No separate hide all panels button - each panel has its own hide button

window.chartPanel = {
  create: createControlPanel
};

$(document).ready(function() {
  console.log('[ControlPanel] document.ready');
  createControlPanel();
});
