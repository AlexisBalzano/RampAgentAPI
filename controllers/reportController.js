const occupancyService = require('../services/occupancyService');
const { info, error } = require('../utils/logger');
const stats = require('../services/statService');
const authController = require('./authController');


let onlineControllers = new Map(); // key: callsign, value: last seen timestamp and report count

// Configuration
const CONTROLLER_TIMEOUT = 60 * 1000; // 1 minutes timeout
const CLEANUP_INTERVAL = 59 * 1000; // Check every 59 seconds

function cleanupOfflineControllers() {
  const now = Date.now();
  for (const [callsign, data] of onlineControllers.entries()) {
    if (now - data.lastSeen > CONTROLLER_TIMEOUT) { // 1 minutes timeout
      onlineControllers.delete(callsign);
      info(`Controller disconnected: ${callsign}`, { category: 'Report', callsign });
    }
  }
}

setInterval(cleanupOfflineControllers, CLEANUP_INTERVAL);

// Handle incoming reports from clients
exports.handleReport = async (req, res) => {
  stats.incrementReportCount();
  const { client, token, cid, aircrafts } = req.body;
  if (!client) {
    return res.status(400).json({ error: 'Invalid client info' });
  }

  if (!authController.verifyToken(token, cid, client)) {
    error(`Invalid token from client: ${client}, token was: ${token}`, { category: 'Report', callsign: client });
    return res.status(403).json({ error: 'Invalid token' });
  }


  if (!aircrafts || typeof aircrafts !== 'object') {
    return res.status(400).json({ error: 'Invalid aircrafts info' });
  }

  // Track controller activity
  const isNewController = !onlineControllers.has(client);
  const now = Date.now();
  
  if (isNewController) {
    info(`Controller connected: ${client}`, { category: 'Report', callsign: client });
    onlineControllers.set(client, { lastSeen: now, reportCount: 1 });
  } else {
    const data = onlineControllers.get(client);
    data.lastSeen = now;
    data.reportCount++;
  }

  try {
    await occupancyService.clientReportParse(aircrafts);
    const occupiedStands = occupancyService.getAllOccupied();
    const assignedStands = occupancyService.getAllAssigned();
    const blockedStands = occupancyService.getAllBlocked();
    res.status(200).json({ status: 'ok', occupiedStands, assignedStands, blockedStands });
  } catch (err) {
    error(`Error processing report: ${err.message}`, { category: 'Report', callsign: client });
    res.status(500).json({ error: 'Internal server error' });
  }
};
