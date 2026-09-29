/* hft_weather.js — панель «Погода» для HFT (порт wclock weather_chart.js на ванильный JS).
 * Данные: /api/hft/weather (факт+прогноз) и /api/hft/charts_data (таймлайн для графика).
 * Публичный API: window.HftWeather = { start(host), stop(), refresh() }.
 */
(function (window) {
  'use strict';

  var currentHost = null;
  var chart = null;
  var factTimer = null;
  var nowLineTimer = null;
  var alive = false;

  function getTempRange() {
    try {
      var raw = localStorage.getItem('hft_weather_range');
      if (raw) {
        var a = JSON.parse(raw);
        if (Array.isArray(a) && a.length === 2 && isFinite(a[0]) && isFinite(a[1]) && a[0] < a[1]) return a;
      }
    } catch (e) { /* ignore */ }
    return [-15, 25];
  }

  function $id(id) { return document.getElementById(id); }
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function api(url) {
    var resp = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
    var data;
    try { data = await resp.json(); } catch (e) { data = { ok: false, error: 'bad response' }; }
    if (!resp.ok || data.ok === false) {
      var er = new Error(data.error || ('HTTP ' + resp.status));
      er.status = resp.status;
      throw er;
    }
    return data;
  }

  // ── факт + прогноз ───────────────────────────────────────────
  function renderFact(fact, forecast) {
    if (!fact) return '<div class="empty">Нет данных погоды</div>';
    var windDir = fact.wind_direction || fact.wind_dir || '';
    var iconUrl = fact.icon_url || fact.icon_url_day;
    var forecastPart = forecast && forecast.parts && forecast.parts[0] ? forecast.parts[0] : null;
    return '<div class="wx-fact">' +
      (iconUrl ? '<img class="wx-ico" src="https://pogoda.mail.ru' + esc(iconUrl) + '" alt="">' : '') +
      '<span class="wx-temp">' + esc(fact.temperature) + '°C</span>' +
      '<span class="wx-sub">ощущается ' + esc(fact.feels_like) + '°C</span>' +
      '<span class="wx-meta">' +
        '<span>💧 ' + esc(fact.humidity) + '%</span>' +
        '<span>☁ ' + esc(fact.pressure) + ' мм</span>' +
        '<span>💨 ' + esc(fact.wind_speed) + ' м/с ' + esc(windDir) + '</span>' +
        '<span>🌧 ' + esc(fact.precip_prob) + '%</span>' +
      '</span>' +
      (forecastPart ? '<span class="wx-fc">Прогноз: ' + esc(forecastPart.temperature) + '°C, осадки ' +
        esc(forecastPart.precip_prob) + '%</span>' : '') +
      '</div>';
  }

  // ── график таймлайна (порт drawWeatherChart) ─────────────────
  function drawChart() {
    var canvas = $id('hft-weather-chart');
    if (!canvas || !currentHost) return;

    fetch('/api/hft/charts_data', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!alive) return;
        var rows = (data && data.rows) || [];
        if (!rows.length) {
          if (chart) { try { chart.destroy(); } catch (e) { /* noop */ } chart = null; }
          return;
        }
        var sorted = rows.slice().sort(function (a, b) {
          return new Date(a.timestamp) - new Date(b.timestamp);
        });
        var labels = [], temp = [], feels = [], wind = [], hum = [], pres = [], prec = [];
        sorted.forEach(function (p) {
          var d = new Date(p.timestamp);
          labels.push(String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0'));
          temp.push(p.temperature != null ? p.temperature : null);
          feels.push(p.feels_like != null ? p.feels_like : null);
          wind.push(p.wind_speed != null ? p.wind_speed : null);
          hum.push(p.humidity != null ? p.humidity : null);
          pres.push(p.pressure != null ? p.pressure : null);
          prec.push(p.precip_prob != null ? p.precip_prob : null);
        });

        if (chart) {
          chart.data.labels = labels;
          chart.data.datasets[0].data = temp;
          chart.data.datasets[1].data = feels;
          chart.data.datasets[2].data = wind;
          chart.data.datasets[3].data = hum;
          chart.data.datasets[4].data = pres;
          chart.data.datasets[5].data = prec;
          chart.update('none');
          return;
        }

        var customXAxisPlugin = {
          id: 'customXAxisPlugin',
          afterDraw: function (c) {
            var ctx = c.ctx, scales = c.scales;
            var x = scales.x, yWind = scales.y_wind;
            if (!x || !yWind) return;
            ctx.save();
            // линия текущего времени
            var nowTime = Date.now();
            var raw = sorted.map(function (p) { return new Date(p.timestamp).getTime(); });
            var xNow = null;
            for (var i = 0; i < raw.length; i++) {
              if (raw[i] > nowTime) {
                var prev = i > 0 ? raw[i - 1] : raw[i];
                var ratio = i > 0 ? (nowTime - prev) / (raw[i] - prev) : 0;
                ratio = Math.max(0, Math.min(1, ratio));
                var pPrev = x.getPixelForValue(i > 0 ? i - 1 : i);
                var pNext = x.getPixelForValue(i);
                if (isFinite(pPrev) && isFinite(pNext)) xNow = pPrev + ratio * (pNext - pPrev);
                break;
              }
              if (i === raw.length - 1) xNow = c.chartArea.right;
            }
            if (xNow === null && raw.length) xNow = c.chartArea.left;
            if (xNow != null && isFinite(xNow)) {
              ctx.strokeStyle = '#ffc941aa';
              ctx.lineWidth = 3;
              ctx.beginPath();
              ctx.moveTo(xNow, c.chartArea.top);
              ctx.lineTo(xNow, c.chartArea.bottom);
              ctx.stroke();
            }
            ctx.restore();
          }
        };

        var ctx = canvas.getContext('2d');
        var tr = getTempRange();
        chart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              { label: 'Temp', data: temp, borderColor: '#ff4800', backgroundColor: 'rgba(255,160,47,.1)', yAxisID: 'y_temp', tension: .5, pointRadius: 0, borderWidth: 2, spanGaps: true },
              { label: 'Feels', data: feels, borderColor: '#ff4800', backgroundColor: 'rgba(255,160,47,.1)', yAxisID: 'y_temp', tension: .5, pointRadius: 0, borderDash: [6, 3], borderWidth: 2, spanGaps: true },
              { label: 'Wind', data: wind, borderColor: 'rgba(255,255,255,.7)', backgroundColor: 'rgba(0,110,255,.2)', yAxisID: 'y_wind', tension: .6, pointRadius: 0, borderDash: [10, 4], borderWidth: 2, spanGaps: true },
              { label: 'Humidity', data: hum, borderColor: '#55ccff', backgroundColor: 'rgba(85,204,255,.1)', yAxisID: 'y_humidity', tension: .4, pointRadius: 0, borderWidth: 1.5, spanGaps: true },
              { label: 'Pressure', data: pres, borderColor: '#31e378', backgroundColor: 'rgba(255,255,136,.1)', yAxisID: 'y_pressure', tension: .4, pointRadius: 0, borderWidth: 1.5, spanGaps: true },
              { label: 'Precip', data: prec, borderColor: '#5ceefb', backgroundColor: 'rgba(0,110,255,.2)', yAxisID: 'y_precip', tension: .4, pointRadius: 0, borderDash: [5, 4], borderWidth: 1.5, spanGaps: true }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: {
              x: { position: 'top', grid: { color: '#ffffff22' }, ticks: { color: '#a6b0c3', font: { size: 10 } } },
              y_temp: { position: 'left', min: tr[0], max: tr[1], grid: { color: '#ffffff22' }, ticks: { color: '#ff5c38', font: { size: 10 }, padding: 2 } },
              y_pressure: { display: true, position: 'left', grid: { drawOnChartArea: false }, ticks: { color: '#31e378', font: { size: 10 } } },
              y_wind: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#ffffff', font: { size: 10 } } },
              y_humidity: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#55ccff', font: { size: 10 } } },
              y_precip: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#a0ffef', font: { size: 10 } } }
            }
          },
          plugins: [customXAxisPlugin]
        });
      })
      .catch(function () { /* молчим */ });
  }

  // ── основной рендер ──────────────────────────────────────────
  async function render() {
    if (!currentHost || !alive) return;
    try {
      var d = await api('/api/hft/weather');
      if (!alive) return;
      var factEl = $id('hft-weather-fact');
      if (factEl) factEl.innerHTML = renderFact(d.fact, d.forecast_summary);
    } catch (e) {
      if (!alive) return;
      if (e.status === 401) return;
      var f2 = $id('hft-weather-fact');
      if (f2) f2.innerHTML = '<div class="empty">Погода: ' + esc(e.message) + '</div>';
    }
    drawChart();
  }

  function start(host) {
    stop();
    if (!host) return;
    currentHost = host;
    alive = true;
    host.innerHTML =
      '<div class="wx-wrap">' +
        '<div id="hft-weather-fact" class="wx-fact-host">Загрузка…</div>' +
        '<div class="wx-chart-host"><canvas id="hft-weather-chart"></canvas></div>' +
      '</div>';
    render();
    // обновление факта и линии «сейчас» раз в минуту
    factTimer = setInterval(function () { if (alive) render(); }, 60000);
    nowLineTimer = setInterval(function () {
      if (alive && chart && typeof chart.update === 'function') chart.update('none');
    }, 60000);
    // перерисовка при изменении размера панели (PanelManager)
    document.addEventListener('hft:panel-resized', onResize);
    document.addEventListener('hftTempRangeChange', onTempRangeChange);
  }

  function onResize() {
    if (!alive || !chart) return;
    try { chart.resize(); } catch (e) { /* noop */ }
  }

  function onTempRangeChange(e) {
    if (!alive || !chart) return;
    var d = e && e.detail;
    if (!d || !isFinite(d.min) || !isFinite(d.max)) return;
    var y = chart.options.scales && chart.options.scales.y_temp;
    if (!y) return;
    y.min = d.min;
    y.max = d.max;
    try { chart.update('none'); } catch (er) { /* noop */ }
  }

  function stop() {
    alive = false;
    currentHost = null;
    if (factTimer) { clearInterval(factTimer); factTimer = null; }
    if (nowLineTimer) { clearInterval(nowLineTimer); nowLineTimer = null; }
    if (chart) { try { chart.destroy(); } catch (e) { /* noop */ } chart = null; }
    document.removeEventListener('hft:panel-resized', onResize);
    document.removeEventListener('hftTempRangeChange', onTempRangeChange);
  }

  window.HftWeather = {
    start: start,
    stop: stop,
    refresh: render
  };
})(window);