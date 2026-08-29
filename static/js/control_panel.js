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

  // Panels list button
  const $panelsBtn = $('<button id="panels-list-btn" class="toggle-btn" title="Показать/скрыть панели">☰</button>')
    .on('click', togglePanelsModal);
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

  // Interval buttons
  const $intervalGroup = $('<div class="interval-group"></div>');

  const intervals = [
    { key: 'minute',  label: '1M' },
    { key: 'fivemin', label: '5M' },
    { key: 'twentymin', label: '20M' },
    { key: 'hour',    label: '1H' },
    { key: 'sixhour', label: '6H' },
    { key: 'day',     label: '1D' }
  ];

  intervals.forEach(intv => {
    const $btn = $('<button class="interval-btn"></button>')
      .attr('data-interval', intv.key)
      .text(intv.label)
      .on('click', function() {
        $('.interval-btn').removeClass('active');
        $(this).addClass('active');
        currentInterval = $(this).attr('data-interval');
        window.currentInterval = currentInterval;
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

  // Invest period selector (moved from invest panel settings popup)
  const $periodSelect = $('<select class="panel-view-select" title="Период графика"></select>');
  const periodOpts = [
    { value: '-90 day', label: '3 месяца' },
    { value: '-35 day', label: '5 недель' },
    { value: '-7 day', label: '1 неделя' },
    { value: '-3 day', label: '3 дня' },
    { value: '-1 day', label: '1.5 дня' },
    { value: '-12 hour', label: '12 часов' },
    { value: '-6 hour', label: '6 часов' },
    { value: '-3 hour', label: '3 часа' },
    { value: '-1 hour', label: '1 час' }
  ];
  periodOpts.forEach(opt => {
    $periodSelect.append($('<option></option>').attr('value', opt.value).text(opt.label));
  });
  $periodSelect.val(getSetting('invest_panel_period', '-35 day'));
  $periodSelect.on('change', function() {
    setSetting('invest_panel_period', this.value);
    saveSettingsToServer({ invest_panel_period: this.value });

    // Auto-switch interval to default for the selected range
    const defaultInterval = {
      '-90 day': 'day',
      '-35 day': 'day',
      '-7 day': 'hour',
      '-3 day': 'hour',
      '-1 day': 'hour',
      '-12 hour': 'fivemin',
      '-6 hour': 'fivemin',
      '-3 hour': 'minute',
      '-1 hour': 'minute'
    }[this.value] || 'hour';
    window.currentInterval = defaultInterval;
    try { localStorage.setItem('chartInterval', defaultInterval); } catch(e) {}
    $('.interval-btn').removeClass('active');
    $('.interval-btn[data-interval="' + defaultInterval + '"]').addClass('active');

    $(document).trigger('panelViewChange', { panel: 'invest_panel', view: 'period' });
  });
  $panel.append($periodSelect);

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
