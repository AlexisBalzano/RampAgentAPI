const occupancyService = require('../services/occupancyService');
const stat = require('../services/statService');

exports.getOccupied = (req, res) => {
  try {
    if (!req.headers['x-internal-request']) {
      stat.incrementRequestCount();
    }
    // registry.getAllOccupied returns array of Stand instances; convert to simple objects
    const occupied = occupancyService.registry.getAllOccupied().map((s) => ({
      name: s.name,
      icao: s.icao,
      callsign: s.callsign || null,
    }));
    res.json(occupied);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve occupied stands' });
  }
};

exports.getBlocked = (req, res) => {
  try {
    if (!req.headers['x-internal-request']) {
      stat.incrementRequestCount();
    }
    // registry.getAllBlocked returns array of Stand instances; convert to simple objects
    const blocked = occupancyService.registry.getAllBlocked().map((s) => ({
      name: s.name,
      icao: s.icao,
      callsign: s.callsign || null,
    }));
    res.json(blocked);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve blocked stands' });
  }
};
