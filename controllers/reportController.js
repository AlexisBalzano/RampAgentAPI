const occupancyService = require('../services/occupancyService');
const { info } = require('../utils/logger');
const stats = require('../services/statService');

exports.handleReport = (req, res) => {
  stats.incrementReportCount();
  const { client, aircrafts } = req.body;
  if (!client) {
    return res.status(400).json({ error: 'Invalid client info' });
  }

  if (!aircrafts || typeof aircrafts !== 'object') {
    return res.status(400).json({ error: 'Invalid aircrafts info' });
  }

  info(`Received report from ${client}, processing...`);

  occupancyService.clientReportParse(aircrafts);
  res.status(200).json({ status: 'ok' });
};
