const { info } = require("../utils/logger");

const counts = new Map(); // hourIndex -> count (hourIndex = Math.floor(ts / 3600000))

function _currentHourIndex() {
    return Math.floor(Date.now() / 3600000);
}

function incrementReportCount(by = 1) {
    const idx = _currentHourIndex();
    counts.set(idx, (counts.get(idx) || 0) + by);
    // prune older than 48 hours occasionally
    if (counts.size > 100) {
        const minIdx = idx - 48;
        for (const k of [...counts.keys()]) if (k < minIdx) counts.delete(k);
    }
}

function getLast24Hours() {
    const nowIdx = _currentHourIndex();
    const result = [];
    for (let i = nowIdx - 23; i <= nowIdx; i++) {
        const ts = i * 3600000;
        result.push({
            hourIndex: i,
            hourIso: new Date(ts).toISOString(), // server-side ISO label
            count: counts.get(i) || 0,
        });
    }
    return result;
}

module.exports = {
    incrementReportCount,
    getLast24Hours,
};