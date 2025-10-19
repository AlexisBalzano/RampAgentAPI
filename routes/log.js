const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

router.get('/', (req, res) => {
  res.json(logger.getLogs());
});

router.get('/filter', (req, res) => {
  const filters = {
    level: req.query.level,
    icao: req.query.icao,
    callsign: req.query.callsign,
    category: req.query.category
  };
  res.json(logger.getFilteredLogs(filters));
});

router.get('/icaos', (req, res) => {
  res.json(logger.getUniqueICAOs());
});

router.get('/callsigns', (req, res) => {
  res.json(logger.getUniqueCallsigns());
});

router.get('/categories', (req, res) => {
  res.json(logger.getUniqueCategories());
});

module.exports = router;