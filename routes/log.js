const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

// Get paginated filtered logs
router.get('/filter', async (req, res) => {
  try {
    const filters = {
      level: req.query.level,
      icao: req.query.icao,
      callsign: req.query.callsign,
      category: req.query.category
    };
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 100;

    const [logs, totalCount] = await Promise.all([
      logger.getFilteredLogs(filters, page, pageSize),
      logger.getLogCount(filters)
    ]);

    res.json({
      logs,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Last 1000 logs
router.get('/', (req, res) => {
  res.json(logger.getRecentLogs());
});

router.get('/icaos', async (req, res) => {
  try {
    const icaos = await logger.getUniqueICAOs();
    res.json(icaos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/callsigns', async (req, res) => {
  try {
    const callsigns = await logger.getUniqueCallsigns();
    res.json(callsigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const categories = await logger.getUniqueCategories();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;