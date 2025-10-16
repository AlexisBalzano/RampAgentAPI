const assignService = require('../services/assignService');

exports.getAssignedStand = (req, res) => {
  const { aircraftId } = req.body;
  if (!aircraftId) return res.status(400).json({ error: 'Missing aircraftId' });

  const assignedStand = assignService.getAssignedStand(aircraftId);
  if (!assignedStand) {
    return res.status(404).json({ error: 'No stand assigned to this aircraft' });
  }
  res.json({ assignedStand })
};
