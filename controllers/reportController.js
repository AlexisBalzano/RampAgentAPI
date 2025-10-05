const occupancyService = require('../services/occupancyService');
const { info } = require('../utils/logger');

exports.handleReport = (req, res) => {
  const { callsign, occupied } = req.body;
  if (!callsign || !Array.isArray(occupied)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  info(`Received report for ${callsign}: ${occupied.length} occupied spots`);

  occupancyService.updateClientReport(callsign, occupied);
  res.json({ status: 'ok' });
};
