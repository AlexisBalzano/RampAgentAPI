const express = require("express");
const router = express.Router();
const v1 = require("../controllers/v1Controller");

// Mounted behind requireServiceKey in index.js.
router.get("/airports", v1.listAirports);
router.get("/airports/:icao/stands", v1.getStands);
router.get("/airports/:icao/status", v1.getStatus);
router.post("/airports/:icao/suggest", v1.suggestRateLimit, v1.suggest);

module.exports = router;
