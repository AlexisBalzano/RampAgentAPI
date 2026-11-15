const reportCounts = new Map(); // hourIndex -> count (hourIndex = Math.floor(ts / 3600000))
const requestCounts = new Map(); // hourIndex -> count (hourIndex = Math.floor(ts / 3600000))

function _currentHourIndex() {
    return Math.floor(Date.now() / 3600000);
}

function incrementReportCount(by = 1) {
    const idx = _currentHourIndex();
    reportCounts.set(idx, (reportCounts.get(idx) || 0) + by);
    // prune older than 48 hours occasionally
    if (reportCounts.size > 100) {
        const minIdx = idx - 48;
        for (const k of [...reportCounts.keys()]) if (k < minIdx) reportCounts.delete(k);
    }
}

function incrementRequestCount(by = 1) {
    const idx = _currentHourIndex();
    requestCounts.set(idx, (requestCounts.get(idx) || 0) + by);
    // prune older than 48 hours occasionally
    if (requestCounts.size > 100) {
        const minIdx = idx - 48;
        for (const k of [...requestCounts.keys()]) if (k < minIdx) requestCounts.delete(k);
    }
}

// Stand-finder suggestions, counted apart from requestCounts so the website's
// traffic does not distort the plugin/viewer request chart.
const suggestCounts = new Map(); // hourIndex -> count

function incrementSuggestCount(by = 1) {
    const idx = _currentHourIndex();
    suggestCounts.set(idx, (suggestCounts.get(idx) || 0) + by);
    if (suggestCounts.size > 100) {
        const minIdx = idx - 48;
        for (const k of [...suggestCounts.keys()]) if (k < minIdx) suggestCounts.delete(k);
    }
}

function getSuggestCountLast24Hours() {
    const minIdx = _currentHourIndex() - 23;
    let total = 0;
    for (const [idx, count] of suggestCounts) if (idx >= minIdx) total += count;
    return total;
}

function getLast24HoursReports() {
    const nowIdx = _currentHourIndex();
    const result = [];
    for (let i = nowIdx - 23; i <= nowIdx; i++) {
        const ts = i * 3600000;
        result.push({
            hourIndex: i,
            hourIso: new Date(ts).toISOString(), // server-side ISO label
            count: reportCounts.get(i) || 0,
        });
    }
    return result;
}

function getLast24HoursRequests() {
    const nowIdx = _currentHourIndex();
    const result = [];
    for (let i = nowIdx - 23; i <= nowIdx; i++) {
        const ts = i * 3600000;
        result.push({
            hourIndex: i,
            hourIso: new Date(ts).toISOString(), // server-side ISO label
            count: requestCounts.get(i) || 0,
        });
    }
    return result;
}

module.exports = {
    incrementReportCount,
    incrementRequestCount,
    incrementSuggestCount,
    getSuggestCountLast24Hours,
    getLast24HoursReports,
    getLast24HoursRequests,
};