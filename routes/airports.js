const express = require('express');
const airportService = require('../services/airportService');
const router = express.Router();

router.get('/', (req, res) => {
  const airportList = airportService.getAirportListAndCoordinates();
  res.json(airportList);
});

router.get('/config/:icao', (req, res) => {
  const icao = req.params.icao;
  const airportConfig = require(airportService.getAirportConfigPath(icao.toUpperCase()));
  res.json({ airportConfig });
});

router.get('/stands', (req, res) => {
  const stands = airportService.getAllStands();
  res.json(stands);
});

router.get('/:icao/stands', (req, res) => {
  const icao = req.params.icao;
  const stands = airportService.getStandsByIcao(icao.toUpperCase());
  res.json(stands);
});

module.exports = router;
