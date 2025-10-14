const express = require('express');
const airportService = require('../services/airportService');
const router = express.Router();

router.get('/', (req, res) => {
  const airportList = airportService.getAirportListAndCoordinates();
  res.json(airportList);
});

module.exports = router;
