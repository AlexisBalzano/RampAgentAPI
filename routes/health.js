const express = require('express');
const router = express.Router();
const redisService = require('../services/redisService');

// Basic health endpoint for load balancer
router.get('/', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      redis: redisService.isConnected ? 'connected' : 'disconnected'
    }
  };

  // Redis is optional (graceful degradation), so mark as degraded if down
  if (!redisService.isConnected) {
    health.status = 'degraded';
  }

  res.status(200).json(health);
});

module.exports = router;
