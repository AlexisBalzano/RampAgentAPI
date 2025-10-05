const assignService = require('../services/assignService');

exports.assignStand = (req, res) => {
  const { aircraftId } = req.body;
  if (!aircraftId) return res.status(400).json({ error: 'Missing aircraftId' });

  const assigned = assignService.assignToAircraft(aircraftId);
  res.json({ assigned });
};

exports.getAssignedStand = (req, res) => {
  const { aircraftId } = req.body;
  if (!aircraftId) return res.status(400).json({ error: 'Missing aircraftId' });

  const assignedStand = ""; //Get assigned stand from DB
  res.json({ assignedStand })
};
