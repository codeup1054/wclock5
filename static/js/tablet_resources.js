/* Баннер ресурсов планшета под графиком погоды (GET /api/tablet/stats). */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var timer = null;

    function setText(id, text) {
        var el = $(id);
        if (el) el.textContent = text;
    }

    function setStatus(level, text) {
        var el = $('tr_status');
        if (!el) return;
        el.textContent = text;
        el.className = level >= 2 ? 'tr-alert' : level >= 1 ? 'tr-warn' : 'tr-ok';
    }

    function offline(host, port) {
        setText('tr_cpu', '—');
        setText('tr_rss', '—');
        setText('tr_hist', '—');
        setText('tr_eta', '—');
        setStatus(2, 'недоступен');
        var el = $('tablet_resources');
        if (el) el.title = (host ? host + ':' + (port || '') + ' — ' : '') + 'планшет не отвечает';
    }

    function render(d) {
        if (!d || !d.ok) {
            offline(d && d.host, d && d.port);
            return;
        }
        document.getElementById('tablet_resources').title =
            'Планшет ' + (d.host || '') + ':' + (d.port || '') +
            ' · режим ' + (d.mode || '?') +
            ' · обновлено ' + (d.ageSec || 0) + ' с назад';

        var cpu = Number(d.cpu || 0);
        var rss = Number(d.rssMb || 0);
        var kb = Number(d.histKb != null ? d.histKb : (d.histBytes || 0) / 1024);
        var pts = Number(d.histPoints || 0);
        var eta = Number(d.daysToLimit);
        var level = Number(d.level || 0);

        setText('tr_cpu', cpu.toFixed(1) + '%');
        setText('tr_rss', Math.round(rss) + ' МБ');
        setText('tr_hist', Math.round(kb) + ' КБ · ' + pts + ' т.');
        setText('tr_eta', (!isFinite(eta) || eta >= 900) ? '—' : Math.round(eta) + ' сут');
        setStatus(level, level >= 2 ? 'ALERT' : level >= 1 ? 'WARN' : 'OK');
    }

    function poll() {
        fetch('/api/tablet/stats?_=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { render(d); })
            .catch(function () { offline(); });
    }

    function start() {
        if (!$('tablet_resources')) return;
        poll();
        if (timer) clearInterval(timer);
        timer = setInterval(poll, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
