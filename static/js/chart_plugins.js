/**
 * chart_plugins.js
 * Optimized reusable plugins for Chart.js
 */

(function(window) {
'use strict';

/* -------------------------------------------------- */
/* FAST TIME HELPERS                                  */
/* -------------------------------------------------- */

const toMs = (ts) => {
    if (typeof ts === 'number') return ts;
    if (ts instanceof Date) return ts.getTime();
    const d = new Date(ts);
    return d.getTime();
};

const localDayKey = (d) =>
    d.getFullYear() + "-" +
    String(d.getMonth()+1).padStart(2,'0') + "-" +
    String(d.getDate()).padStart(2,'0');

const getLocalMidnight = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/* -------------------------------------------------- */
/* BINARY SEARCH (20x faster than linear)             */
/* -------------------------------------------------- */

const findIndexForTime = (timestamps, tMs) => {

    let lo = 0;
    let hi = timestamps.length - 1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const ms = toMs(timestamps[mid]);

        if (ms < tMs) lo = mid + 1;
        else hi = mid - 1;
    }

    return lo;
};

/* -------------------------------------------------- */
/* FAST INTERPOLATION                                 */
/* -------------------------------------------------- */

const getXForTime = (timestamps, xScale, tMs, fallbackIndex=null) => {

    const idx = findIndexForTime(timestamps, tMs);

    if (idx <= 0)
        return xScale.getPixelForValue(0);

    if (idx >= timestamps.length)
        return xScale.getPixelForValue(timestamps.length - 1);

    const prevMs = toMs(timestamps[idx-1]);
    const currMs = toMs(timestamps[idx]);

    const frac = (tMs - prevMs) / (currMs - prevMs);

    const value = (idx-1) + Math.max(0, Math.min(1, frac));

    return xScale.getPixelForValue(value);
};

/* -------------------------------------------------- */
/* SCALE HELPER                                       */
/* -------------------------------------------------- */

const getYScale = (chart, datasetIndex=0) => {

    const meta = chart.getDatasetMeta(datasetIndex);

    if (meta?.yScale)
        return meta.yScale;

    const s = chart.scales;

    return s.y || s.y_portfolio || Object.values(s)[0];
};

/* Ось для конкретной метки экстремума: у каждого счёта своя y-ось */
const getExtremaYScale = (chart, ext) => {
    if (ext && ext.axis && chart.scales && chart.scales[ext.axis]) return chart.scales[ext.axis];
    return getYScale(chart);
};

/* -------------------------------------------------- */
/* EXTREMA LABELS                                     */
/* -------------------------------------------------- */

window.ExtremaPlugin = function(extremaData) {

return {

id: "extremaLabels",

afterDatasetsDraw(chart) {

    const data = extremaData ?? chart?._extrema;
    if (!data?.length) return;

    const { ctx, scales } = chart;

    const xScale = scales.x;

    if (!xScale) return;

    ctx.save();

    ctx.font = "10px verdana";
    
    // Поворачиваем текст на 90 градусов
    ctx.translate(0, 0);
    
    for (let ext of data) {

        const yScale = getExtremaYScale(chart, ext);
        if (!yScale) continue;

        const x = xScale.getPixelForValue(ext.index);
        const y = yScale.getPixelForValue(ext.value);

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 2); // 90 градусов против часовой стрелки
        
        ctx.fillStyle = ext.type === "max" ? "#15db71ad" : "#e74d3cc3";
        
        if (ext.type === "max") {
            // Максимум - текст выше точки
            ctx.translate(2, 10);
            ctx.textBaseline = "bottom";
            ctx.fillText(Math.round(ext.value).toLocaleString("ru-RU"), 0, -5);
        } else {
            // Минимум - текст ниже точки
            ctx.textBaseline = "bottom";
            ctx.translate(-65, 0);
            ctx.fillText(Math.round(ext.value).toLocaleString("ru-RU"), 0, 5);
        }
        
        ctx.restore();
    }

    ctx.restore();
}

};

};

/* -------------------------------------------------- */
/* MIDNIGHT LINES                                     */
/* -------------------------------------------------- */

window.MidnightLinesPlugin = function(timestamps) {

return {

id: "midnightLines",

afterDatasetsDraw(chart) {

    const ts = timestamps ?? chart?._midnightTimestamps;
    if (!ts?.length) return;

    const { ctx, chartArea, scales } = chart;

    const xScale = scales.x;
    if (!xScale) return;

    ctx.save();

    ctx.setLineDash([8,4]);

    let prevDay = null;

    for (let i=0;i<ts.length;i++) {

        const d = new Date(ts[i]);
        const key = localDayKey(d);

        if (prevDay && prevDay !== key) {

            const midnight = getLocalMidnight(d);
            const x = getXForTime(ts, xScale, midnight, i);

            // Воскресенье (day of week = 0) - светлее
            const isSunday = d.getDay() === 0 || d.getDay() === 6;
            ctx.strokeStyle = isSunday ? "#1f334282" : "#30afafb6";
            
            ctx.beginPath();
            ctx.moveTo(x, chartArea.bottom);
            ctx.lineTo(x, chartArea.top+120);
            ctx.stroke();
        }

        prevDay = key;
    }

    ctx.restore();
}

};

};

/* -------------------------------------------------- */
/* API ERROR POINTS (spike-фильтр источников)         */
/* -------------------------------------------------- */

window.ApiErrorLinesPlugin = function(apiErrors) {

return {

id: "apiErrorPoints",

afterDatasetsDraw(chart) {

    const errs = apiErrors ?? chart?._apiErrors;
    if (!errs?.length) return;

    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    const ts = chart?.data?.timestamps ?? chart?._midnightTimestamps;

    if (!xScale || !ts?.length) return;

    ctx.save();

    const points = [];

    for (let er of errs) {

        const tMs = toMs(er.ts_epoch * 1000);
        if (tMs < toMs(ts[0]) || tMs > toMs(ts[ts.length-1])) continue;

        const x = getXForTime(ts, xScale, tMs);

        // Красная точка на верхней оси X (граница области графика)
        const y = chartArea.top;
        ctx.fillStyle = "#e74c3c";
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();

        points.push({ x, y, tMs, text: er.text || '' });
    }

    chart._apiErrorPoints = points;

    ctx.restore();
},

afterEvent(chart, args) {

    const e = args?.event;
    const points = chart?._apiErrorPoints;
    if (!e || !points) return;

    if (e.type === 'mouseout' || e.type === 'pointerleave') {
        hideApiErrorTip(chart);
        return;
    }
    if (e.type !== 'mousemove') return;

    const match = nearestPoint(chart, points, e.x, e.y, 7);
    if (!match) {
        hideApiErrorTip(chart);
        return;
    }
    showApiErrorTip(chart, match);
},

destroy(chart) {
    hideApiErrorTip(chart);
    if (chart) delete chart._apiErrorPoints;
}

};

};

function nearestPoint(chart, points, mx, my, radius) {
    let best = null;
    for (const p of points) {
        const dx = p.x - mx;
        const dy = p.y - my;
        if (dx * dx + dy * dy <= radius * radius) {
            if (!best || Math.abs(dy) < Math.abs(best.dy)) {
                p.dy = p.y - my;
                best = p;
            }
        }
    }
    return best;
}

function parseSpikePct(text) {
    const m = /\d+(?:\.\d+)?%/.exec(text || '');
    return m ? m[0] : '';
}

function formatSpikeTime(tMs) {
    const d = new Date(tMs);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function apiErrorTipEl(chart) {
    if (!chart._apiErrorTipEl) {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;' +
            'background:rgba(18,20,24,0.94);color:#fff;border-radius:4px;' +
            'padding:5px 8px;font:12px/1.4 sans-serif;display:none;' +
            'box-shadow:0 2px 8px rgba(0,0,0,0.5);white-space:nowrap;';
        document.body.appendChild(el);
        chart._apiErrorTipEl = el;
    }
    return chart._apiErrorTipEl;
}

function showApiErrorTip(chart, p) {
    const el = apiErrorTipEl(chart);
    const pct = parseSpikePct(p.text);
    el.innerHTML = '<b>' + formatSpikeTime(p.tMs) + '</b>' +
        (pct ? ' · ' + pct + ' скачок' : ' · spike');
    el.style.display = 'block';
    const rect = chart.canvas.getBoundingClientRect();
    let tx = rect.left + p.x + 8;
    let ty = rect.top + p.y - el.offsetHeight - 6;
    if (ty < 0) ty = rect.top + p.y + 8;
    el.style.left = tx + 'px';
    el.style.top = ty + 'px';
}

function hideApiErrorTip(chart) {
    if (chart && chart._apiErrorTipEl) chart._apiErrorTipEl.style.display = 'none';
}

/* -------------------------------------------------- */
/* DAILY GROWTH LABELS                                */
/* -------------------------------------------------- */

window.DailyGrowthPlugin = function(marks, timestamps) {

return {

id: "dailyGrowth",

afterDatasetsDraw(chart) {

    if (!marks?.length) return;

    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;

    if (!xScale) return;

    ctx.save();

    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";

    const baseY = chartArea.bottom + 10;

    for (let m of marks) {

        if (typeof m.index !== "number") continue;

        let x;

        if (timestamps && m.timestamp) {

            const d = new Date(m.timestamp);
            const midnight = getLocalMidnight(d);

            x = getXForTime(timestamps, xScale, midnight, m.index);

        } else {

            x = xScale.getPixelForValue(m.index);
        }

        const sign = m.pctGrowth >= 0 ? "+" : "";

        ctx.fillStyle = m.pctGrowth >= 0 ? "#1fc163" : "#e74c3c";

        ctx.fillText(
            `${sign}${m.pctGrowth.toFixed(2)}%`,
            x,
            baseY
        );
    }

    ctx.restore();
}

};

};

/* -------------------------------------------------- */
/* PERIOD LABELS (initial/final values relative to Y-axis) */
/* -------------------------------------------------- */
/* PeriodLabelsPlugin — определён в invest_chart.js   */
/* -------------------------------------------------- */

/* -------------------------------------------------- */
/* EXTREMA FINDER (2-3x faster)                       */
/* -------------------------------------------------- */

window.findDailyExtrema = function(values, timestamps) {

const days = {};

for (let i=0;i<values.length;i++) {

    const d = new Date(timestamps[i]);
    const key = localDayKey(d);

    if (!days[key]) days[key] = [];

    days[key].push(i);
}

const extrema = [];

for (let k in days) {

    const idx = days[k];

    let minI = idx[0];
    let maxI = idx[0];

    for (let i of idx) {

        if (values[i] < values[minI]) minI = i;
        if (values[i] > values[maxI]) maxI = i;
    }

    extrema.push({
        index:minI,
        value:values[minI],
        type:"min"
    });

    if (maxI !== minI) {

        extrema.push({
            index:maxI,
            value:values[maxI],
            type:"max"
        });
    }
}

extrema.sort((a,b)=>a.index-b.index);

return extrema;

};

/* -------------------------------------------------- */

window.initChartPlugin = function(plugin, customOptions = {}) {

    if (!plugin) return null;

    plugin.options = {
        ...(plugin.defaults || {}),
        ...(customOptions || {})
    };

    return plugin;
};


console.log("[ChartPlugins] optimized plugins loaded");

})(window);