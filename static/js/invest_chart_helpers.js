/**
 * invest_chart_helpers.js
 * Pure helper functions for investment chart data processing.
 * Dependencies: lib.js (getSafeDPR, debounce, throttle)
 */

function checkCanvas() {
    const canvas = document.getElementById('investChart');
    if (!canvas || !canvas.isConnected || !document.body.contains(canvas)) {
        return { exists: false, reason: 'Canvas not found or not in DOM' };
    }
    const rect = canvas.getBoundingClientRect();
    const isVisible = rect.width > 10 && rect.height > 10 &&
                     rect.top < window.innerHeight &&
                     rect.left < window.innerWidth;
    if (!isVisible) {
        return {
            exists: true,
            reason: 'Invisible (w:' + rect.width + ', h:' + rect.height + ')',
            rect: rect
        };
    }
    return { exists: true, reason: 'OK', rect: rect };
}

function calculateDailyGrowthMarks(timestamps, values) {
    const marks = [];
    const localDayKey = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return yyyy + '-' + mm + '-' + dd;
    };

    const dailyData = {};
    timestamps.forEach((tsAny, index) => {
        const ts = tsAny instanceof Date ? tsAny : new Date(tsAny);
        const dayKey = localDayKey(ts);
        if (!dailyData[dayKey]) {
            dailyData[dayKey] = { indices: [], timestamps: [], values: [] };
        }
        dailyData[dayKey].indices.push(index);
        dailyData[dayKey].timestamps.push(ts);
        dailyData[dayKey].values.push(values[index]);
    });

    const sortedDays = Object.keys(dailyData).sort();
    const dailyMidnight = {};
    sortedDays.forEach((dayKey) => {
        const day = dailyData[dayKey];
        if (!day?.timestamps?.length) return;
        let idx = day.timestamps.findIndex(d => d.getHours() === 0 && d.getMinutes() === 0);
        if (idx === -1) idx = 0;
        dailyMidnight[dayKey] = {
            index: day.indices[idx],
            timestamp: day.timestamps[idx],
            value: day.values[idx]
        };
    });

    for (let i = 1; i < sortedDays.length; i++) {
        const prevDay = sortedDays[i - 1];
        const currDay = sortedDays[i];
        const prev = dailyMidnight[prevDay];
        const curr = dailyMidnight[currDay];
        if (!prev || !curr) continue;

        const prevValue = prev.value;
        const currValue = curr.value;
        const midnightIndex = curr.index;
        const midnightTs = curr.timestamp;
        const absGrowth = currValue - prevValue;
        const pctGrowth = prevValue !== 0 ? (absGrowth / prevValue) * 100 : 0;
        const timeLabel = midnightTs.toLocaleString('ru-RU', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        marks.push({
            index: midnightIndex,
            timestamp: midnightTs,
            absGrowth: absGrowth,
            pctGrowth: pctGrowth,
            timeLabel: timeLabel,
            prevValue: prevValue,
            currValue: currValue
        });
    }

    return marks;
}

function aggregateData(timestamps, values, interval, labelMode) {
    console.log('[InvestPlot] Aggregating data by interval:', interval, 'labelMode:', labelMode);
    const aggregated = {};

    for (let i = 0; i < timestamps.length; i++) {
        const ts = new Date(timestamps[i]);
        const bucket = new Date(ts);
        let key;

        switch (interval) {
            case 'minute':
                bucket.setSeconds(0, 0);
                key = String(bucket.getTime());
                break;
            case 'fivemin':
                bucket.setMinutes(Math.floor(bucket.getMinutes() / 5) * 5, 0, 0);
                key = String(bucket.getTime());
                break;
            case 'twentymin':
                bucket.setMinutes(Math.floor(bucket.getMinutes() / 20) * 20, 0, 0);
                key = String(bucket.getTime());
                break;
            case 'hour':
                bucket.setMinutes(0, 0, 0);
                key = String(bucket.getTime());
                break;
            case 'sixhour':
                bucket.setHours(Math.floor(bucket.getHours() / 6) * 6, 0, 0, 0);
                key = String(bucket.getTime());
                break;
            case 'day':
                bucket.setHours(0, 0, 0, 0);
                key = String(bucket.getTime());
                break;
            default:
                key = String(ts.getTime());
        }

        if (!aggregated[key]) {
            aggregated[key] = { values: [], timestamp: bucket };
        }
        const rawVal = values[i];
        let numVal = null;
        if (rawVal !== null && rawVal !== undefined) {
            numVal = Number(rawVal);
            if (isNaN(numVal)) numVal = null;
        }
        aggregated[key].values.push(numVal);
    }

    const sortedKeys = Object.keys(aggregated).sort((a, b) => Number(a) - Number(b));
    
    let resultValues = [];
    let resultTimestamps = [];

    let lastValidValue = null;
    let intervalMs = 3600000;
    if (interval === 'minute') intervalMs = 60000;
    if (interval === 'fivemin') intervalMs = 300000;
    if (interval === 'twentymin') intervalMs = 1200000;
    if (interval === 'sixhour') intervalMs = 21600000;
    if (interval === 'day') intervalMs = 86400000;

    sortedKeys.forEach(key => {
        const group = aggregated[key];
        if (group.values.length === 0) return;
        
        let currentValue = group.values[group.values.length - 1];
        
        if (currentValue === null || isNaN(currentValue)) {
            if (lastValidValue !== null) {
                currentValue = lastValidValue;
            }
        } else {
            lastValidValue = currentValue;
        }
        
        if (resultTimestamps.length > 0) {
            const prevTime = resultTimestamps[resultTimestamps.length - 1].getTime();
            const currTime = group.timestamp.getTime();
            const gap = currTime - prevTime;
            
            if (gap > intervalMs * 1.5) {
                const numGaps = Math.floor(gap / intervalMs);
                for (let g = 1; g < numGaps; g++) {
                    const interpTime = new Date(prevTime + intervalMs * g);
                    resultValues.push(lastValidValue);
                    resultTimestamps.push(interpTime);
                }
            }
        }
        
        resultValues.push(currentValue);
        resultTimestamps.push(group.timestamp);
    });

    // Ограничиваем число точек: при ручном выборе мелкого интервала (minute/fivemin)
    // на длинном периоде агрегация раздувается (десятки тысяч точек) и блокирует
    // главный поток >30с (график/портфели не отрисовываются). Прореживаем равномерно.
    var MAX_AGG_POINTS = 3000;
    if (resultValues.length > MAX_AGG_POINTS) {
        var step = Math.ceil(resultValues.length / MAX_AGG_POINTS);
        var dsV = [], dsT = [];
        for (var si = 0; si < resultValues.length; si += step) {
            dsV.push(resultValues[si]);
            dsT.push(resultTimestamps[si]);
        }
        var lastV = resultValues[resultValues.length - 1];
        if (dsV[dsV.length - 1] !== lastV) {
            dsV.push(lastV);
            dsT.push(resultTimestamps[resultTimestamps.length - 1]);
        }
        resultValues = dsV;
        resultTimestamps = dsT;
    }

    // Build labels based on mode
    const timeLabels = resultTimestamps.map(d => {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
    });
    const changeLabels = buildGrowthLabels(resultValues);

    var resultLabels;
    if (labelMode === 'both') {
        resultLabels = timeLabels.map((t, i) => t + '||' + changeLabels[i]);
    } else if (labelMode === 'change') {
        resultLabels = changeLabels;
    } else {
        resultLabels = timeLabels;
    }

    console.log('[InvestPlot] Aggregated:', resultLabels.length, 'points');
    return { labels: resultLabels, values: resultValues, timestamps: resultTimestamps };
}

function buildGrowthLabels(values) {
    const labels = [];
    let firstValid = null;
    for (let i = 0; i < values.length; i++) {
        if (firstValid === null && values[i] != null && values[i] > 0) {
            firstValid = values[i];
        }
        if (firstValid !== null && firstValid > 0 && values[i] != null) {
            const growth = ((values[i] - firstValid) / firstValid) * 100;
            const sign = growth >= 0 ? '+' : '';
            labels.push(sign + growth.toFixed(2));
        } else {
            labels.push('');
        }
    }
    return labels;
}

function validateGraphData(data) {
    if (!data || !data.labels || !data.values) {
        return { valid: false, reason: 'No data' };
    }
    if (data.labels.length === 0 || data.values.length === 0) {
        return { valid: false, reason: 'Empty data' };
    }
    if (data.labels.length !== data.values.length) {
        return { valid: false, reason: 'Label/value length mismatch' };
    }
    return { valid: true };
}

function aggregateTgoldData(prices, portfolioTimestamps, interval) {
    if (!portfolioTimestamps || portfolioTimestamps.length === 0) {
        return { data: [] };
    }
    
    const priceMap = {};
    prices.forEach(p => {
        const key = p.x.getTime();
        priceMap[key] = p.y;
    });
    
    const intervalMs = interval === 'minute' ? 60000 : interval === 'fivemin' ? 300000 : interval === 'twentymin' ? 1200000 : interval === 'hour' ? 3600000 : interval === 'sixhour' ? 21600000 : 86400000;
    
    const rawData = portfolioTimestamps.map(ts => {
        const tsTime = ts.getTime();
        
        let closestPrice = null;
        let minDiff = Infinity;
        
        prices.forEach(p => {
            const diff = Math.abs(p.x.getTime() - tsTime);
            if (diff < minDiff) {
                minDiff = diff;
                closestPrice = p.y;
            }
        });
        
        if (minDiff > intervalMs * 1.5) {
            return null;
        }
        
        return closestPrice;
    });
    
    const resultData = [];
    let lastValue = null;
    
    for (let i = 0; i < rawData.length; i++) {
        const val = rawData[i];
        
        if (val !== null) {
            if (lastValue === null || val !== lastValue) {
                lastValue = val;
            }
            resultData.push(lastValue);
        } else {
            resultData.push(lastValue);
        }
    }
    
    return { data: resultData };
}

// ============================================================
// InvestHistoryCache — delta-capable history cache
// ============================================================
// Full response cached for FULL_TTL_MS; between full loads only
// changed buckets (live tail) are fetched via ?after_ts=.
// Server returns: { <iso_ts>: items, _prev, _api_errors, _latest_epoch, _count }
// Client canonicalizes: max 1 key per interval-bucket (last snapshot wins).
window.InvestHistoryCache = (function() {
    var FULL_TTL_MS = 10 * 60 * 1000;
    var MAX_ENTRIES = 4;
    var MEDIATOR_TTL_MS = 70000;   // чуть больше 60с опроса медиатора
    var INTERVAL_MS = { minute: 60000, fivemin: 300000, twentymin: 1200000, hour: 3600000, sixhour: 21600000, day: 86400000 };

    var _entries = {};  // key -> { data, latestEpoch, loadedAt }
    var _inflight = {}; // key -> promise (дедуп По КЛЮЧУ: два full одного ключа невозможны)
    var _med = null;    // { key, data, latestEpoch, at } — свежее full-полно из медиатора

    function cacheKey(interval, apiPeriod, startTs, endTs) {
        return interval + '|' + apiPeriod + '|' + (startTs || '') + '|' + (endTs || '');
    }

    function evictIfNeeded() {
        // LRU-эвктикция: держим небольшой словарь кэшей (баннер + чарт + диапазоны)
        var keys = Object.keys(_entries);
        if (keys.length < MAX_ENTRIES) return;
        var oldest = null, oldestKey = null;
        for (var i = 0; i < keys.length; i++) {
            var e = _entries[keys[i]];
            if (!oldest || e.loadedAt < oldest.loadedAt) { oldest = e; oldestKey = keys[i]; }
        }
        if (oldestKey) delete _entries[oldestKey];
    }

    function bucketBoundary(epochSec, interval) {
        var ms = INTERVAL_MS[interval] || 3600000;
        return Math.floor((epochSec * 1000) / ms) * ms;
    }

    // One key per bucket: keep key with max epoch per bucket
    function canonicalize(raw, interval) {
        var buckets = {}; // boundary_ms → [ { key, epoch } ]
        var clean = {};
        var i, k, epoch, b;
        for (k in raw) {
            if (k.charAt(0) === '_') { clean[k] = raw[k]; continue; }
            epoch = Date.parse(k) / 1000;
            if (isNaN(epoch)) continue;
            b = bucketBoundary(epoch, interval);
            if (!buckets[b]) buckets[b] = [];
            buckets[b].push({ key: k, epoch: epoch });
        }
        for (b in buckets) {
            var arr = buckets[b].sort(function(a, c) { return a.epoch - c.epoch; });
            var last = arr[arr.length - 1];
            clean[last.key] = raw[last.key];
        }
        return clean;
    }

    // Merge delta into cached (replace same-bucket old keys, append new, union _api_errors)
    function mergeDelta(cached, delta, interval) {
        var merged = {};
        var k, dk, eEpoch, dEpoch, ek, eB, dB;
        for (k in cached) { if (k.charAt(0) !== '_') merged[k] = cached[k]; }
        for (dk in delta) {
            if (dk.charAt(0) === '_') continue;
            dEpoch = Date.parse(dk) / 1000;
            if (isNaN(dEpoch)) continue;
            dB = bucketBoundary(dEpoch, interval);
            for (ek in merged) {
                eEpoch = Date.parse(ek) / 1000;
                if (!isNaN(eEpoch) && bucketBoundary(eEpoch, interval) === dB && eEpoch < dEpoch) {
                    delete merged[ek];
                }
            }
            merged[dk] = delta[dk];
        }
        if (delta._prev) merged._prev = delta._prev;
        else if (cached._prev) merged._prev = cached._prev;
        // Union _api_errors (dedup by ts_epoch)
        var seen = {};
        if (cached._api_errors) for (var i = 0; i < cached._api_errors.length; i++) seen[cached._api_errors[i].ts_epoch] = cached._api_errors[i];
        if (delta._api_errors) for (var i = 0; i < delta._api_errors.length; i++) seen[delta._api_errors[i].ts_epoch] = delta._api_errors[i];
        merged._api_errors = Object.values(seen);
        return merged;
    }

    function buildUrl(interval, apiPeriod, startTs, endTs, afterTs) {
        var u = '/api/invest/history?interval=' + encodeURIComponent(interval) +
                '&period=' + encodeURIComponent(apiPeriod);
        if (startTs) u += '&start_ts=' + encodeURIComponent(startTs);
        if (endTs)   u += '&end_ts='   + encodeURIComponent(endTs);
        if (afterTs != null) u += '&after_ts=' + afterTs;
        return u;
    }

    function doFull(interval, apiPeriod, startTs, endTs) {
        return fetch(buildUrl(interval, apiPeriod, startTs, endTs, null), { cache: 'no-store' })
            .then(function(r) { if (!r.ok) throw new Error('history ' + r.status); return r.json(); })
            .then(function(raw) {
                var maxE = 0;
                for (var k in raw) { if (k.charAt(0) === '_') continue; var e = Date.parse(k) / 1000; if (e > maxE) maxE = e; }
                return { data: canonicalize(raw, interval), latestEpoch: maxE || null };
            });
    }

    function doDelta(interval, apiPeriod, startTs, endTs, afterTs) {
        return fetch(buildUrl(interval, apiPeriod, startTs, endTs, afterTs), { cache: 'no-store' })
            .then(function(r) { if (!r.ok) throw new Error('history ' + r.status); return r.json(); })
            .then(function(d) { return { delta: d, serverLatest: d._latest_epoch || null }; });
    }

    function get(interval, apiPeriod, startTs, endTs) {
        var key = cacheKey(interval, apiPeriod, startTs, endTs);
        var now = Date.now();
        var entry = _entries[key];
        var needFull = !entry || (now - entry.loadedAt) > FULL_TTL_MS;

        // Медиатор — источник полной истории: если полный payload секции
        // invest.history пришёл недавно (текущий опрос ≤ 60с), отдаём его
        // без GET-запросов. При застое медиатора > TTL — обычный full/delta.
        if (_med && _med.key === key && (now - _med.at) < MEDIATOR_TTL_MS) {
            return Promise.resolve(_med.data);
        }

        if (_inflight[key]) return _inflight[key];

        evictIfNeeded();

        var promise;
        if (needFull) {
            promise = doFull(interval, apiPeriod, startTs, endTs)
                .then(function(r) {
                    var e = { data: r.data, latestEpoch: r.latestEpoch, loadedAt: Date.now() };
                    _entries[key] = e;
                    delete _inflight[key]; return e.data;
                })
                .catch(function(e) { delete _inflight[key]; throw e; });
        } else {
            promise = doDelta(interval, apiPeriod, startTs, endTs, entry.latestEpoch)
                .then(function(r) {
                    if (r.serverLatest != null && r.serverLatest < entry.latestEpoch) {
                        // Desync: server behind → full reload
                        return doFull(interval, apiPeriod, startTs, endTs).then(function(r2) {
                            var e2 = { data: r2.data, latestEpoch: r2.latestEpoch, loadedAt: Date.now() };
                            _entries[key] = e2;
                            delete _inflight[key]; return e2.data;
                        });
                    }
                    entry.data = mergeDelta(entry.data, r.delta, interval);
                    if (r.serverLatest != null && r.serverLatest > entry.latestEpoch) entry.latestEpoch = r.serverLatest;
                    entry.loadedAt = Date.now();
                    delete _inflight[key];
                    return entry.data;
                })
                .catch(function(e) { delete _inflight[key]; throw e; });
        }
        _inflight[key] = promise;
        return promise;
    }

    function invalidate() { _entries = {}; _inflight = {}; }

    // Полный payload из медиатора (секция invest.history): кладём в _med
    // и в обычный кэш — get() ниже отдаёт его без GET, пока медиатор свежий.
    function primeFromMediator(interval, apiPeriod, startTs, endTs, raw) {
        var key = cacheKey(interval, apiPeriod, startTs, endTs);
        var data = canonicalize(raw || {}, interval);
        var maxE = 0;
        if (raw && raw._latest_epoch != null) {
            var me = Number(raw._latest_epoch);
            if (!isNaN(me)) maxE = me;
        } else {
            for (var k in raw) {
                if (k.charAt(0) === '_') continue;
                var e = Date.parse(k) / 1000;
                if (!isNaN(e) && e > maxE) maxE = e;
            }
        }
        _med = { key: key, data: data, latestEpoch: maxE, at: Date.now() };
        _entries[key] = { data: data, latestEpoch: maxE, loadedAt: Date.now() };
        return data;
    }

    // Хвост (дельта) из медиатора секции invest.history (_tail): мёрджим в
    // уже загруженный полный кэш, чтобы рендер всегда видел целую историю.
    // Если полного нет (не с чем мёрджить) — возвращаем null: вызывающий
    // должен взять полный через get().
    function applyMediatorTail(interval, apiPeriod, startTs, endTs, delta) {
        var key = cacheKey(interval, apiPeriod, startTs, endTs);
        var entry = _entries[key];
        if (!entry || !entry.data) return null;
        var merged = mergeDelta(entry.data, delta || {}, interval);
        var maxE = 0;
        if (delta && delta._latest_epoch != null) {
            var me = Number(delta._latest_epoch);
            if (!isNaN(me)) maxE = me;
        } else {
            for (var k in delta) {
                if (k.charAt(0) === '_') continue;
                var e = Date.parse(k) / 1000;
                if (!isNaN(e) && e > maxE) maxE = e;
            }
        }
        entry.data = merged;
        if (maxE > entry.latestEpoch) entry.latestEpoch = maxE;   // монотонно
        entry.loadedAt = Date.now();
        _med = { key: key, data: merged, latestEpoch: entry.latestEpoch, at: Date.now() };
        return merged;
    }

    return { get: get, invalidate: invalidate, primeFromMediator: primeFromMediator, applyMediatorTail: applyMediatorTail };
})();
