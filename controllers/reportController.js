const occupancyService = require('../services/occupancyService');
const { info, error } = require('../utils/logger');
const stats = require('../services/statService');

exports.handleReport = async (req, res) => {
  stats.incrementReportCount();
  const { client, aircrafts } = req.body;
  if (!client) {
    return res.status(400).json({ error: 'Invalid client info' });
  }

  // TODO: Client validation


  if (!aircrafts || typeof aircrafts !== 'object') {
    return res.status(400).json({ error: 'Invalid aircrafts info' });
  }

  info(`Received report from ${client}, processing...`);

  try {
    await occupancyService.clientReportParse(aircrafts);
    const assignedStands = occupancyService.getAllOccupied();
    const blockedStands = occupancyService.getAllBlocked();
    res.status(200).json({ status: 'ok', assignedStands, blockedStands });
  } catch (err) {
    error(`Error processing report: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
};
