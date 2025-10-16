const express = require('express');
const statService = require('../services/statService');
const router = express.Router();

router.get('/reports-per-hour', (req, res) => {
  const stats = statService.getLast24HoursReports();
  res.json(stats);
});

router.get('/requests-per-hour', (req, res) => {
  const stats = statService.getLast24HoursRequests();
  res.json(stats);
});

module.exports = router;
