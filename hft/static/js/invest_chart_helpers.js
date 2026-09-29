/* invest_chart_helpers.js (hft) — чистые функции обработки данных графика.
 * Порт из wclock5 ohne jQuery: checkCanvas, calculateDailyGrowthMarks,
 * aggregateData, buildGrowthLabels, validateGraphData. */
'use strict';

function checkCanvas() {
    var canvas = document.getElementById('investChart');
    if (!canvas || !canvas.isConnected || !document.body.contains(canvas)) {
        return { exists: false, reason: 'Canvas not found or not in DOM' };
    }
    var rect = canvas.getBoundingClientRect();
    var isVisible = rect.width > 10 && rect.height > 10 &&
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
    var marks = [];
    var localDayKey = function (d) {
        var yyyy = d.getFullYear();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return yyyy + '-' + mm + '-' + dd;
    };

    var dailyData = {};
    timestamps.forEach(function (tsAny, index) {
        var ts = tsAny instanceof Date ? tsAny : new Date(tsAny);
        var dayKey = localDayKey(ts);
        if (!dailyData[dayKey]) {
            dailyData[dayKey] = { indices: [], timestamps: [], values: [] };
        }
        dailyData[dayKey].indices.push(index);
        dailyData[dayKey].timestamps.push(ts);
        dailyData[dayKey].values.push(values[index]);
    });

    var sortedDays = Object.keys(dailyData).sort();
    var dailyMidnight = {};
    sortedDays.forEach(function (dayKey) {
        var day = dailyData[dayKey];
        if (!day || !day.timestamps.length) return;
        var idx = day.timestamps.findIndex(function (d) { return d.getHours() === 0 && d.getMinutes() === 0; });
        if (idx === -1) idx = 0;
        dailyMidnight[dayKey] = {
            index: day.indices[idx],
            timestamp: day.timestamps[idx],
            value: day.values[idx]
        };
    });

    for (var i = 1; i < sortedDays.length; i++) {
        var prevDay = sortedDays[i - 1];
        var currDay = sortedDays[i];
        var prev = dailyMidnight[prevDay];
        var curr = dailyMidnight[currDay];
        if (!prev || !curr) continue;

        var prevValue = prev.value;
        var currValue = curr.value;
        var midnightIndex = curr.index;
        var midnightTs = curr.timestamp;
        var absGrowth = currValue - prevValue;
        var pctGrowth = prevValue !== 0 ? (absGrowth / prevValue) * 100 : 0;
        var timeLabel = midnightTs.toLocaleString('ru-RU', {
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
    var aggregated = {};

    for (var i = 0; i < timestamps.length; i++) {
        var ts = new Date(timestamps[i]);
        var bucket = new Date(ts);
        var key;

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
        var rawVal = values[i];
        var numVal = null;
        if (rawVal !== null && rawVal !== undefined) {
            numVal = Number(rawVal);
            if (isNaN(numVal)) numVal = null;
        }
        aggregated[key].values.push(numVal);
    }

    var sortedKeys = Object.keys(aggregated).sort(function (a, b) { return Number(a) - Number(b); });

    var resultValues = [];
    var resultTimestamps = [];

    var lastValidValue = null;
    var intervalMs = 3600000;
    if (interval === 'minute') intervalMs = 60000;
    if (interval === 'fivemin') intervalMs = 300000;
    if (interval === 'twentymin') intervalMs = 1200000;
    if (interval === 'sixhour') intervalMs = 21600000;
    if (interval === 'day') intervalMs = 86400000;

    sortedKeys.forEach(function (key) {
        var group = aggregated[key];
        if (group.values.length === 0) return;

        var currentValue = group.values[group.values.length - 1];

        if (currentValue === null || isNaN(currentValue)) {
            if (lastValidValue !== null) {
                currentValue = lastValidValue;
            }
        } else {
            lastValidValue = currentValue;
        }

        if (resultTimestamps.length > 0) {
            var prevTime = resultTimestamps[resultTimestamps.length - 1].getTime();
            var currTime = group.timestamp.getTime();
            var gap = currTime - prevTime;

            if (gap > intervalMs * 1.5) {
                var numGaps = Math.floor(gap / intervalMs);
                for (var g = 1; g < numGaps; g++) {
                    var interpTime = new Date(prevTime + intervalMs * g);
                    resultValues.push(lastValidValue);
                    resultTimestamps.push(interpTime);
                }
            }
        }

        resultValues.push(currentValue);
        resultTimestamps.push(group.timestamp);
    });

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

    var timeLabels = resultTimestamps.map(function (d) {
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
    });
    var changeLabels = buildGrowthLabels(resultValues);

    var resultLabels;
    if (labelMode === 'both') {
        resultLabels = timeLabels.map(function (t, i) { return t + '||' + changeLabels[i]; });
    } else if (labelMode === 'change') {
        resultLabels = changeLabels;
    } else {
        resultLabels = timeLabels;
    }

    return { labels: resultLabels, values: resultValues, timestamps: resultTimestamps };
}

function buildGrowthLabels(values) {
    var labels = [];
    var firstValid = null;
    for (var i = 0; i < values.length; i++) {
        if (firstValid === null && values[i] != null && values[i] > 0) {
            firstValid = values[i];
        }
        if (firstValid !== null && firstValid > 0 && values[i] != null) {
            var growth = ((values[i] - firstValid) / firstValid) * 100;
            var sign = growth >= 0 ? '+' : '';
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