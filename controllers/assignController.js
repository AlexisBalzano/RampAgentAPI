const occupancyService = require('../services/occupancyService');
const stat = require('../services/statService');

exports.assignStand = (req, res) => {
    const { stand, icao, callsign } = req.query;
    try {
        stat.incrementRequestCount();
        const result = occupancyService.assignStandToPilot(stand, icao, callsign);
        res.json({ success: true, message: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};