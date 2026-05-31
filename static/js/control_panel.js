// static/js/control_panel.js

function createControlPanel() {
  console.log('[ControlPanel] createControlPanel called');
  const panelHook = document.getElementById('chart_control_panel');
  if (!panelHook) {
    console.log('[ControlPanel] panelHook not found, retrying...');
    setTimeout(createControlPanel, 100);
    return;
  }

  const existing = panelHook.querySelector('.chart-control-panel');
  console.log('[ControlPanel] existing:', existing);
  if (existing) {
    console.log('[ControlPanel] already has chart-control-panel');
    return;
  }

  const $panel = $('<div class="chart-control-panel"></div>');
  console.log('[ControlPanel] created $panel:', $panel.length);

  // Toggle chart view button (slider style)
  const $toggleBtn = $('<label class="switch toggle-btn-label"><input type="checkbox" id="toggle-chart-btn"><span class="slider"></span></label>')
    .on('change click touchend', function(e) {
      if (e.type === 'touchend') {
        e.preventDefault();
        const checkbox = this.querySelector('input');
        checkbox.checked = !checkbox.checked;
      }
      if (typeof toggleChartView === 'function') {
        toggleChartView();
      }
    });
  $panel.append($toggleBtn);

  // Panels list button
  const $panelsBtn = $('<button id="panels-list-btn" class="toggle-btn" title="Показать/скрыть панели">☰</button>')
    .on('click', togglePanelsModal);
  $panel.append($panelsBtn);

  // Reload browser button (left side)
  const $reloadBrowserBtn = $('<button id="reload_browser_btn" title="Перезагрузить страницу">↻</button>')
    .on('click touchend', function(e) {
      e.preventDefault();
      location.reload();
    });
  $panel.prepend($reloadBrowserBtn);

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
    { key: 'minute', label: 'М' },
    { key: 'hour',   label: 'Ч' },
    { key: 'day',    label: 'Д' }
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

  // Restore saved interval
  const savedInterval = localStorage.getItem('chartInterval') || 'hour';
  $panel.find(`[data-interval="${savedInterval}"]`).addClass('active');
  window.currentInterval = savedInterval;

  // Sync toggle with currentView
  const $toggleCheckbox = $panel.find('#toggle-chart-btn');
  $toggleCheckbox.prop('checked', currentView === 'energy');

  panelHook.appendChild($panel[0]);
  console.log('[ControlPanel] appended, children:', panelHook.children.length);
}

// No separate hide all panels button - each panel has its own hide button

window.chartPanel = {
  create: createControlPanel
};

$(document).ready(function() {
  console.log('[ControlPanel] document.ready');
  createControlPanel();
});
