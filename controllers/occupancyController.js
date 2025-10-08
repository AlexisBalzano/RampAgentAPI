const occupancyService = require('../services/occupancyService');

exports.getOccupied = (req, res) => {
  try {
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
