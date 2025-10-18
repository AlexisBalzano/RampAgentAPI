const express = require('express');
const airportService = require('../services/airportService');
const router = express.Router();

router.get('/', async (req, res) => {
  const airportList = await airportService.getAirportListAndCoordinates();
  res.json(airportList);
});

router.get('/config/:icao', async (req, res) => {
  const icao = req.params.icao;
  const airportConfig = await airportService.getAirportConfig(icao.toUpperCase());
  res.json({ airportConfig });
});

router.get('/stands', async (req, res) => {
  const stands = await airportService.getAllStands();
  res.json(stands);
});

router.get('/:icao/stands', async (req, res) => {
  const icao = req.params.icao;
  const stands = await airportService.getStandsByIcao(icao.toUpperCase());
  res.json(stands);
});

module.exports = router;
