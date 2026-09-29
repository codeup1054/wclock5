/* analytics_chart_kit.js — визуальный движок для «Аналитики рынка» (hft-app, /analytics).
 * Портировано из invest_chart.js (wclock5 + hft) и очищено от инвест-специфики:
 *   - плавающая легенда (toggle кликом, drag, сворачивание, состояние в localStorage)
 *   - X-zoom выделением + кнопка Reset Zoom
 *   - период-чипы «старт / финал + Δ%» по каждой видимой серии
 *   - умные время-тики (5/15/30 мин, час, день) по диапазону
 *   - тултип сверху (topFixed), %-нормализация, DPR-скейлинг
 * Не зависит от jQuery и состояния панелей. Публичный API: window.AnalyticsChartKit.
 */
(function () {
  'use strict';

  var LS_LEGEND_KEY = 'analytics_legend';
  var LS_COLLAPSE_KEY = 'analytics_legend_collapsed';
  var LS_POS_KEY = 'analytics_legend_pos';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsGetJSON(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSetJSON(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} }

  // ================================================================
  // DPR
  // ================================================================
  function setupCanvasForDPR(canvas, container) {
    if (!canvas || !container) return;
    var rect = container.getBoundingClientRect();
    var base = window.devicePixelRatio || 1;
    var dpr = Math.min(Math.max(base, 0.5), 4);
    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }

  // ================================================================
  // Умные время-тики
  // ================================================================
  function computeTimeTickStep(tsArr) {
    if (!tsArr || tsArr.length === 0) return 'hour';
    var first = new Date(tsArr[0]).getTime();
    var last = new Date(tsArr[tsArr.length - 1]).getTime();
    var rangeMs = Math.max(1, last - first);
    var h = 3600000;
    if (rangeMs <= 1 * h) return '5min';
    if (rangeMs <= 3 * h) return '15min';
    if (rangeMs <= 24 * h) return '30min';
    if (rangeMs <= 72 * h) return 'hour';
    return 'day';
  }

  function isTimeAligned(d, step) {
    switch (step) {
      case '5min': return d.getMinutes() % 5 === 0 && d.getSeconds() === 0;
      case '15min': return d.getMinutes() % 15 === 0 && d.getSeconds() === 0;
      case '30min': return d.getMinutes() % 30 === 0 && d.getSeconds() === 0;
      case 'hour': return d.getMinutes() === 0 && d.getSeconds() === 0;
      case 'day': return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    }
    return true;
  }

  function smartTimeScale() {
    return {
      stacked: false,
      position: 'bottom',
      afterBuildTicks: function (axis) {
        var tsArr = axis.chart.data.timestamps;
        if (!tsArr || !tsArr.length) return;
        var step = computeTimeTickStep(tsArr);
        axis._timeTickStep = step;
        var ticks = [];
        for (var i = 0; i < tsArr.length; i++) {
          var d = tsArr[i] instanceof Date ? tsArr[i] : new Date(tsArr[i]);
          if (!d || isNaN(d.getTime())) continue;
          if (isTimeAligned(d, step)) ticks.push({ value: i });
        }
        if (!ticks.length) return;
        if (ticks.length > 20) {
          var picked = [];
          var skip = Math.ceil(ticks.length / 20);
          for (var t = 0; t < ticks.length; t += skip) picked.push(ticks[t]);
          var last = ticks[ticks.length - 1];
          if (picked[picked.length - 1].value !== last.value) picked.push(last);
          ticks = picked.slice(0, 20);
        }
        axis.ticks = ticks;
      },
      ticks: {
        display: true,
        maxRotation: 0,
        minRotation: 0,
        autoSkip: true,
        maxTicksLimit: 20,
        font: { size: 10 },
        color: '#9aa0c7',
        callback: function (val) {
          var tsArr = this.chart.data.timestamps;
          var ts = (tsArr && tsArr[val] != null) ? tsArr[val] : null;
          var d = ts instanceof Date ? ts : (ts != null ? new Date(ts) : null);
          if (!d || isNaN(d.getTime())) return '';
          if (this.chart.scales && this.chart.scales.x && this.chart.scales.x._timeTickStep === 'day') {
            var dd = String(d.getDate()).padStart(2, '0');
            var mo = String(d.getMonth() + 1).padStart(2, '0');
            return dd + '.' + mo;
          }
          var hh = String(d.getHours()).padStart(2, '0');
          var mm = String(d.getMinutes()).padStart(2, '0');
          return hh + ':' + mm;
        }
      },
      grid: {
        display: true,
        color: 'rgba(38, 48, 90, 0.55)',
        lineWidth: 1
      }
    };
  }

  // ================================================================
  // Тултип сверху
  // ================================================================
  if (window.Chart && Chart.Tooltip && Chart.Tooltip.positioners) {
    Chart.Tooltip.positioners.topFixed = function (active) {
      if (!active || !active.length) return false;
      var x = active[0].element ? active[0].element.x : 0;
      return { x: x, y: 20, caretPadding: 4 };
    };
  }

  function tooltipModeIndex(dateFmt) {
    dateFmt = dateFmt || function (d) {
      var s = String(d.getMonth() + 1).padStart(2, '0') + '-' +
              String(d.getDate()).padStart(2, '0');
      if (d.getHours() !== 0 || d.getMinutes() !== 0) {
        s += ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
      return s;
    };
    return {
      enabled: true,
      position: 'topFixed',
      mode: 'index',
      intersect: false,
      callbacks: {
        title: function (items) {
          if (!items || !items.length) return '';
          var tsArr = items[0].chart.data.timestamps;
          var ts = (tsArr && tsArr[items[0].dataIndex] != null) ? tsArr[items[0].dataIndex] : null;
          var d = ts instanceof Date ? ts : (ts != null ? new Date(ts) : null);
          return (d && !isNaN(d.getTime())) ? dateFmt(d) : (items[0].label || '');
        },
        label: function (ctx) {
          var v = Number(ctx.parsed && ctx.parsed.y);
          return String(ctx.dataset.label || '') + ': ' + (isNaN(v) ? '—' : v.toLocaleString('ru-RU'));
        }
      },
      displayColors: true,
      backgroundColor: 'rgba(0, 0, 0, 0.85)',
      titleColor: '#fff',
      bodyColor: '#fff',
      padding: 10,
      titleFont: { size: 13 },
      bodyFont: { size: 13 },
      cornerRadius: 6
    };
  }

  // ================================================================
  // Плавающая легенда
  // ================================================================
  var inlineLegendPlugin = {
    id: 'analyticsInlineLegend',
    afterTooltipDraw: function (chart) {
      var ctx = chart.ctx;
      var chartArea = chart.chartArea;
      var datasets = chart.data.datasets;
      if (!datasets || !datasets.length) return;
      ctx.save();

      var rootFont = parseFloat(window.getComputedStyle(document.body).fontSize) || 16;
      var fs = 12;
      var padX = 14;
      var padTop = 12;
      var swatchW = 14;
      var swatchH = 3;
      var labelGap = 8;
      var itemH = Math.round(fs * 1.5);
      var rowGap = 4;
      var collapseBtnSize = 20;

      function isCollapseBtn() {
        try { return lsGet(LS_COLLAPSE_KEY) === '1'; } catch (e) { return false; }
      }
      function setCollapse(v) { lsSet(LS_COLLAPSE_KEY, v ? '1' : '0'); }
      function legendState() { return lsGetJSON(LS_LEGEND_KEY) || {}; }
      function saveState() {
        var st = {};
        for (var i = 0; i < chart.data.datasets.length; i++) {
          var dd = chart.data.datasets[i];
          if (dd && dd.label) st[dd.label] = dd.hidden === true;
        }
        lsSetJSON(LS_LEGEND_KEY, st);
      }

      var items = [];
      for (var i = 0; i < datasets.length; i++) {
        var ds = datasets[i];
        if (ds.label) items.push({ index: i, label: ds.label });
      }
      if (!items.length) { ctx.restore(); return; }

      var pos = chart._legendPos || { x: chartArea.left, y: chartArea.top + 6 };
      var collapsed = isCollapseBtn();

      if (collapsed) {
        var bX = pos.x;
        var bY = pos.y;
        ctx.fillStyle = 'rgba(24, 28, 44, 0.85)';
        ctx.fillRect(bX, bY, collapseBtnSize, collapseBtnSize);
        ctx.fillStyle = '#ccc';
        ctx.font = Math.round(fs * 0.7) + 'px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText('\u25B6', bX + collapseBtnSize / 2, bY + collapseBtnSize / 2);
        ctx.restore();
        chart._legendCollapseBtn = { x: bX, y: bY, w: collapseBtnSize, h: collapseBtnSize };
        chart._legendHitAreas = [];
        chart._legendRect = null;
        return;
      }

      chart._legendCollapseBtn = null;

      var maxLabelW = 0;
      ctx.font = 'bold ' + fs + 'px sans-serif';
      for (var n = 0; n < items.length; n++) {
        var w = ctx.measureText(items[n].label).width;
        if (w > maxLabelW) maxLabelW = w;
      }
      var colW = swatchW + labelGap + maxLabelW;
      var MAX_ROWS = 14;
      var totalW = colW + padX * 2 + collapseBtnSize + 6;
      var rows = items.length;
      var totalH = rows * itemH + (rows - 1) * rowGap + padTop + 10;
      var availW = chartArea.right - chartArea.left;
      var availH = chartArea.bottom - chartArea.top;
      if (rows > MAX_ROWS) { rows = MAX_ROWS; totalH = rows * itemH + (rows - 1) * rowGap + padTop + 10; }

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      pos.x = Math.min(Math.max(pos.x, 0), Math.max(chart.width - totalW, 0));
      pos.y = Math.min(Math.max(pos.y, 0), Math.max(chart.height - totalH, 0));
      var bx = pos.x;
      var by = pos.y;

      ctx.fillStyle = 'rgba(24, 28, 44, 0.85)';
      ctx.fillRect(bx, by, totalW, totalH);

      ctx.fillStyle = '#aaa';
      ctx.font = Math.round(fs * 0.7) + 'px sans-serif';
      ctx.fillText('\u25C0', bx + totalW - collapseBtnSize + 3, by + totalH / 2);
      chart._legendCollapseBtn = { x: bx + totalW - collapseBtnSize, y: by, w: collapseBtnSize, h: totalH };

      ctx.font = 'bold ' + fs + 'px sans-serif';
      var areas = [];
      var visibleCount = 0;
      for (var m = 0; m < items.length && m < MAX_ROWS; m++) {
        var it = items[m];
        var dset = datasets[it.index];
        var color = dset.borderColor || dset.backgroundColor || '#ccc';
        var hidden = dset.hidden === true;
        if (!hidden) visibleCount++;
        var x = bx + padX;
        var y = by + padTop + itemH / 2 + m * (itemH + rowGap);

        ctx.globalAlpha = hidden ? 0.4 : 1;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - swatchH, swatchW, swatchH);
        ctx.fillStyle = hidden ? '#777' : '#ddd';
        ctx.fillText(dset.label, x + swatchW + labelGap, y);

        areas.push({
          x: x - 6,
          y: y - itemH / 2 - rowGap / 2,
          width: colW + 12,
          height: itemH + rowGap,
          datasetIndex: it.index
        });
      }
      ctx.globalAlpha = 1;

      ctx.restore();
      chart._legendRect = { x: bx, y: by, w: totalW, h: totalH };
      chart._legendHitAreas = areas;
      chart._analyticsVisibleCount = visibleCount;
      chart.saveLegendState = saveState;
    }
  };

  // ================================================================
  // X-zoom
  // ================================================================
  var investZoomUiPlugin = {
    id: 'analyticsZoom',
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      var area = chart.chartArea;

      if (chart._zoomSel) {
        var z = chart._zoomSel;
        ctx.save();
        ctx.fillStyle = 'rgba(108, 140, 255, 0.18)';
        ctx.fillRect(Math.min(z.x0, z.x1), area.top,
                     Math.abs(z.x1 - z.x0), area.bottom - area.top);
        ctx.restore();
      }

      if (chart._zoomRange) {
        var text = 'Reset Zoom';
        ctx.save();
        ctx.font = 'bold 12px sans-serif';
        var w = ctx.measureText(text).width + 16;
        var h = 22;
        var bx = area.right - w - 4;
        var by = area.top + 4;
        ctx.fillStyle = 'rgba(24, 28, 44, 0.9)';
        ctx.fillRect(bx, by, w, h);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + w / 2, by + h / 2);
        ctx.restore();
        chart._resetZoomRect = { x: bx, y: by, w: w, h: h };
      } else {
        chart._resetZoomRect = null;
      }
    }
  };

  function hitRect(rect, ev, canvas) {
    if (!rect) return false;
    var r = canvas.getBoundingClientRect();
    var x = ev.clientX - r.left;
    var y = ev.clientY - r.top;
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  function resetZoom(chart) {
    if (!chart._zoomRange) return;
    var orig = chart._zoomOrig || {};
    chart.options.scales.x.min = orig.min;
    chart.options.scales.x.max = orig.max;
    chart._zoomRange = null;
    chart._zoomOrig = null;
    chart.update('none');
  }

  // ================================================================
  // Период-чипы «старт / финал + Δ%» для видимых серий
  // ================================================================
  function fmtCap(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2).replace('.', ',') + '\u041C';
    if (a >= 1e3) return Math.round(v / 1e3) + '\u043A';
    return String(Math.round(v));
  }

  function drawChip(ctx, x, y, valueText, valueColor, pctText, pctColor, alignRight) {
    var padX = 5, padY = 3;
    var wValue = ctx.measureText(valueText).width;
    var wPct = pctText ? ctx.measureText(pctText).width : 0;
    var w = wValue + (pctText ? 8 : 0) + wPct + padX * 2;
    var h = 12 + padY * 2;
    var bx = alignRight ? x - w : x;
    var by = Math.max(y - h / 2, 2);
    ctx.fillStyle = 'rgba(18, 20, 24, 0.82)';
    ctx.fillRect(bx, by, w, h);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = valueColor;
    ctx.fillText(valueText, bx + padX, y);
    if (pctText) {
      ctx.fillStyle = pctColor;
      ctx.fillText(pctText, bx + padX + wValue + 8, y);
    }
  }

  var periodEndpointsPlugin = {
    id: 'analyticsPeriodEndpoints',
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      var area = chart.chartArea;
      var dsList = chart.data.datasets;
      if (!dsList || dsList.length < 1) return;
      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      for (var d = 0; d < dsList.length; d++) {
        var ds = dsList[d];
        var sc = chart.scales[ds.yAxisID || 'y'];
        if (!ds || !sc || !ds.data || ds.data.length < 2) continue;
        if (ds.hidden === true || ds._noChips === true) continue;
        if (chart._analyticsVisibleCount > 6) continue;
        var firstVal = null, lastVal = null;
        for (var i = 0; i < ds.data.length; i++) {
          var p = ds.data[i];
          var v = Number(p && p.y != null ? p.y : p);
          if (isNaN(v)) continue;
          if (firstVal === null) firstVal = v;
          lastVal = v;
        }
        if (firstVal === null || isNaN(lastVal)) continue;

        var color = ds.borderColor || '#cccccc';
        drawChip(ctx, area.left + 2, sc.getPixelForValue(firstVal),
                 fmtCap(firstVal), color, null, null, false);

        var pct = firstVal !== 0 ? (lastVal - firstVal) / Math.abs(firstVal) * 100 : 0;
        var pctTxt = (pct >= 0 ? '+' : '') + pct.toFixed(2).replace('.', ',') + '%';
        drawChip(ctx, area.right - 2, sc.getPixelForValue(lastVal),
                 fmtCap(lastVal), color, pctTxt,
                 pct >= 0 ? '#4caf50' : '#f44336', true);
      }
      ctx.restore();
    }
  };

  // ================================================================
  // Интерактив: легенда (toggle+drag) + zoom. Привязка per-chart.
  // ================================================================
  function attachInteractions(chart) {
    if (!chart || !chart.canvas) return chart;
    if (chart._analyticsHitCleanup) chart._analyticsHitCleanup();
    var canvas = chart.canvas;

    chart._legendPos = lsGetJSON(LS_POS_KEY) || null;

    // --- клик: reset zoom / collapse / toggle серии ---
    var onClick = function (event) {
      if (hitRect(chart._resetZoomRect, event, canvas)) { resetZoom(chart); return; }
      if (chart._selectionDragged) { chart._selectionDragged = false; return; }
      if (chart._legendDragMoved) { chart._legendDragMoved = false; return; }

      var rect = canvas.getBoundingClientRect();
      var x = event.clientX - rect.left;
      var y = event.clientY - rect.top;

      var btn = chart._legendCollapseBtn;
      if (btn && x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
        var collapsed = lsGet(LS_COLLAPSE_KEY) === '1';
        lsSet(LS_COLLAPSE_KEY, collapsed ? '0' : '1');
        chart.update();
        return;
      }

      var areas = chart._legendHitAreas;
      if (!areas || !areas.length) return;
      for (var i = 0; i < areas.length; i++) {
        var a = areas[i];
        if (x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) {
          var ds = chart.data.datasets[a.datasetIndex];
          if (!ds) return;
          ds.hidden = !ds.hidden;
          chart.update();
          if (chart.saveLegendState) chart.saveLegendState();
          return;
        }
      }
    };
    canvas.addEventListener('click', onClick);

    // --- drag легенды ---
    var dragging = false, moved = false, lastX = 0, lastY = 0;
    function hitLegend(ev) {
      var r = chart._legendRect;
      if (!r) return false;
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var y = ev.clientY - rect.top;
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    var onPointerDown = function (e) {
      if (!hitLegend(e)) return;
      dragging = true;
      moved = false;
      chart._legendDragMoved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      e.preventDefault();
    };
    var onWindowPointerMove = function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      moved = true;
      chart._legendDragMoved = true;
      if (!chart._legendRect) return;
      var p = chart._legendPos || (chart._legendPos = { x: chart._legendRect.x, y: chart._legendRect.y });
      p.x += dx;
      p.y += dy;
      chart.draw();
      lastX = e.clientX;
      lastY = e.clientY;
    };
    var onWindowPointerUp = function () {
      if (dragging && moved && chart._legendPos) {
        lsSetJSON(LS_POS_KEY, { x: Math.round(chart._legendPos.x), y: Math.round(chart._legendPos.y) });
      }
      dragging = false;
    };
    var onCanvasPointerMove = function (e) {
      if (!dragging) canvas.style.cursor = hitLegend(e) ? 'move' : '';
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    canvas.addEventListener('pointermove', onCanvasPointerMove);

    // --- X-zoom выделением ---
    var sel = null;
    var onZoomDown = function (e) {
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var area = chart.chartArea;
      if (x < area.left || x > area.right || y < area.top || y > area.bottom) return;
      if (hitRect(chart._legendRect, e, canvas)) return;
      if (hitRect(chart._resetZoomRect, e, canvas)) return;
      sel = { x0: x, x1: x };
      chart._zoomSel = sel;
      e.preventDefault();
    };
    var onZoomMove = function (e) {
      if (!sel) return;
      var rect = canvas.getBoundingClientRect();
      var x = Math.min(Math.max(e.clientX - rect.left, chart.chartArea.left), chart.chartArea.right);
      sel.x1 = x;
      chart.draw();
    };
    var onZoomUp = function () {
      if (!sel) return;
      var dragged = Math.abs(sel.x1 - sel.x0) > 8;
      if (dragged && chart.data.labels && chart.data.labels.length > 2) {
        var i0 = Math.round(chart.scales.x.getValueForPixel(Math.min(sel.x0, sel.x1)));
        var i1 = Math.round(chart.scales.x.getValueForPixel(Math.max(sel.x0, sel.x1)));
        i0 = Math.max(0, Math.min(i0, chart.data.labels.length - 1));
        i1 = Math.max(0, Math.min(i1, chart.data.labels.length - 1));
        if (i1 - i0 >= 1) {
          if (!chart._zoomRange) {
            chart._zoomOrig = { min: chart.options.scales.x.min, max: chart.options.scales.x.max };
          }
          chart.options.scales.x.min = i0;
          chart.options.scales.x.max = i1;
          chart._zoomRange = { i0: i0, i1: i1 };
          chart._selectionDragged = true;
          chart.update('none');
        }
      }
      chart._zoomSel = null;
      sel = null;
      chart.draw();
    };
    canvas.addEventListener('pointerdown', onZoomDown);
    window.addEventListener('pointermove', onZoomMove);
    window.addEventListener('pointerup', onZoomUp);

    chart._analyticsHitCleanup = function () {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onCanvasPointerMove);
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      canvas.removeEventListener('pointerdown', onZoomDown);
      window.removeEventListener('pointermove', onZoomMove);
      window.removeEventListener('pointerup', onZoomUp);
    };

    return chart;
  }

  // ================================================================
  // Утилиты
  // ================================================================
  function toPctSeries(series) {
    var base = null;
    for (var i = 0; i < series.length; i++) {
      if (series[i] != null && series[i] > 0) { base = series[i]; break; }
    }
    if (!base) return series.map(function () { return null; });
    return series.map(function (v) {
      if (v == null || v <= 0) return null;
      return (v / base - 1) * 100;
    });
  }

  var PALETTE = [
    '#3498db', '#e74c3c', '#1fc163', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#5b6ee8', '#ff7f50'
  ];

  window.AnalyticsChartKit = {
    version: 2,
    setupCanvasForDPR: setupCanvasForDPR,
    smartTimeScale: smartTimeScale,
    computeTimeTickStep: computeTimeTickStep,
    tooltipModeIndex: tooltipModeIndex,
    toPctSeries: toPctSeries,
    resetZoom: resetZoom,
    palette: PALETTE,
    plugins: [
      inlineLegendPlugin,
      investZoomUiPlugin,
      periodEndpointsPlugin
    ],
    attachInteractions: attachInteractions
  };
})();