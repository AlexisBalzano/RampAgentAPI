const occupancyService = require('../services/occupancyService');

exports.handleReport = (req, res) => {
  const { callsign, occupied } = req.body;
  if (!callsign || !Array.isArray(occupied)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  occupancyService.updateClientReport(callsign, occupied);
  res.json({ status: 'ok' });
};
