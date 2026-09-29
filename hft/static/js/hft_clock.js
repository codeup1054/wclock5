/* hft_clock.js — панель «Часы» для HFT (порт wclock clock/date/moon/sun на ванильный JS).
 * Чистый frontend: часы, дата, фаза луны, время восхода/захода (SunCalc).
 * Публичный API: window.HftClock = { start(host), stop() }.
 */
(function (window) {
  'use strict';

  var currentHost = null;
  var timer = null;
  var alive = false;
  var _prevClock = null, _prevDay = null, _prevMonth = null, _prevWeekday = null;

  var MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда',
    'четверг', 'пятница', 'суббота'];

  function moonPhaseIndex(date) {
    var epoch = new Date(Date.UTC(2000, 0, 6, 18, 14));
    var days = (new Date(date) - epoch) / (1000 * 60 * 60 * 24);
    var phase = days % 29.530588853;
    return (Math.floor(phase / (29.530588853 / 16)) + 8) % 16;
  }

  function sunTimes() {
    var lat = 55.6667, lng = 37.2667;
    if (typeof SunCalc === 'undefined') return null;
    var t = SunCalc.getTimes(new Date(), lat, lng);
    var fmt = function (d) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    };
    var ms = t.sunset - t.sunrise;
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return {
      sunrise: fmt(t.sunrise),
      sunset: fmt(t.sunset),
      daylight: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
    };
  }

  function update() {
    if (!currentHost || !alive) return;
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var ss = String(now.getSeconds()).padStart(2, '0');
    var dd = String(now.getDate()).padStart(2, '0');

    var clock = hh + ':' + mm;
    var day = dd;
    var month = MONTHS[now.getMonth()];
    var weekday = WEEKDAYS[now.getDay()];

    var cls = {
      clock: 'hft-clock-time',
      sec: 'hft-clock-sec',
      day: 'hft-clock-day',
      month: 'hft-clock-month',
      weekday: 'hft-clock-weekday'
    };

    if (clock !== _prevClock) {
      var c = currentHost.querySelector('.' + cls.clock);
      if (c) c.textContent = clock;
      _prevClock = clock;
    }
    var s = currentHost.querySelector('.' + cls.sec);
    if (s) s.textContent = ss;
    if (day !== _prevDay) {
      var d = currentHost.querySelector('.' + cls.day);
      if (d) d.textContent = day;
      _prevDay = day;
    }
    if (month !== _prevMonth) {
      var mo = currentHost.querySelector('.' + cls.month);
      if (mo) mo.textContent = month;
      _prevMonth = month;
    }
    if (weekday !== _prevWeekday) {
      var w = currentHost.querySelector('.' + cls.weekday);
      if (w) w.textContent = weekday;
      _prevWeekday = weekday;
    }

    // луна и солнце — раз в сутки достаточно
    updateAstro(now);
  }

  function updateAstro(now) {
    var moon = currentHost.querySelector('.hft-clock-moon');
    if (moon) {
      var idx = moonPhaseIndex(now);
      var need = idx !== moon.dataset.phase;
      if (need) {
        moon.dataset.phase = idx;
        moon.innerHTML = '🌙 ' + String(idx + 1).padStart(2, '0');
      }
    }
    var sun = currentHost.querySelector('.hft-clock-sun');
    if (sun) {
      var dayKey = now.getDate() + '-' + now.getMonth();
      if (sun.dataset.day !== dayKey) {
        sun.dataset.day = dayKey;
        var st = sunTimes();
        if (st) {
          sun.innerHTML = '☀ ' + st.sunrise + ' – ' + st.sunset + ' · день ' + st.daylight;
        }
      }
    }
  }

  function render() {
    return '<div class="hft-clock">' +
      '<div class="hft-clock-body">' +
        '<div class="' + 'hft-clock-time' + '">--:--</div>' +
        '<div class="' + 'hft-clock-sec' + '">--</div>' +
      '</div>' +
      '<div class="hft-clock-date">' +
        '<span class="' + 'hft-clock-day' + '">--</span> ' +
        '<span class="' + 'hft-clock-month' + '">—</span>' +
      '</div>' +
      '<div class="' + 'hft-clock-weekday' + '">—</div>' +
      '<div class="hft-clock-astro">' +
        '<span class="hft-clock-moon">🌙</span>' +
        '<span class="hft-clock-sun">☀</span>' +
      '</div>' +
    '</div>';
  }

  function start(host) {
    stop();
    if (!host) return;
    currentHost = host;
    alive = true;
    host.innerHTML = render();
    update();
    timer = setInterval(function () { if (alive) update(); }, 1000);
  }

  function stop() {
    alive = false;
    currentHost = null;
    _prevClock = _prevDay = _prevMonth = _prevWeekday = null;
    if (timer) { clearInterval(timer); timer = null; }
  }

  window.HftClock = {
    start: start,
    stop: stop
  };
})(window);