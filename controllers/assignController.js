const occupancyService = require('../services/occupancyService');
const stat = require('../services/statService');
const { verifyToken } = require('./authController');

exports.assignStand = async (req, res) => {
    const { stand, icao, callsign, token, client } = req.query;

    if (!stand || !icao || !callsign || !token || !client) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    if (verifyToken(token, client) === false) {
        return res.status(403).json({ success: false, message: 'Invalid token' });
    }

    try {
        stat.incrementRequestCount();
        const result = await occupancyService.assignStandToPilot(stand, icao, callsign, client);
        res.json({ success: true, message: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};