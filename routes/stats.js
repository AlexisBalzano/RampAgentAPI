const express = require('express');
const statService = require('../services/statService');
const router = express.Router();

router.get('/reports-per-hour', (req, res) => {
  const stats = statService.getLast24Hours();
  res.json(stats);
});

module.exports = router;
