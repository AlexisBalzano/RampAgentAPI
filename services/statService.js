const { info } = require("../utils/logger");

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
    getLast24HoursReports,
    getLast24HoursRequests,
};