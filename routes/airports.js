const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const airportList = airportService.getAirportList();
  res.json(airportList);
});

module.exports = router;
