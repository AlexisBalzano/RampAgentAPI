const express = require('express');
const airportService = require('../services/airportService');
const router = express.Router();

router.get('/', (req, res) => {
  const airportList = airportService.getAirportListAndCoordinates();
  res.json(airportList);
});

router.get('/stands', (req, res) => {
  const stands = airportService.getAllStands();
  res.json(stands);
});

module.exports = router;
