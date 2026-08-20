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
            case 'hour':
                bucket.setMinutes(0, 0, 0);
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
    
    const resultValues = [];
    const resultTimestamps = [];

    let lastValidValue = null;
    let intervalMs = 3600000;
    if (interval === 'minute') intervalMs = 60000;
    if (interval === 'day') intervalMs = 86400000;

    sortedKeys.forEach(key => {
        const group = aggregated[key];
        if (group.values.length === 0) return;
        
        let currentValue = group.values[group.values.length - 1];
        
        if (currentValue === null || isNaN(currentValue)) {
            if (lastValidValue !== null) {
                currentValue = lastValidValue;
            }
        } else if (currentValue === 0) {
            if (lastValidValue !== null) {
                currentValue = lastValidValue;
            } else {
                lastValidValue = 0;
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
    
    const intervalMs = interval === 'minute' ? 60000 : interval === 'hour' ? 3600000 : 86400000;
    
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
