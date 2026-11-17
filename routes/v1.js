const express = require("express");
const router = express.Router();
const v1 = require("../controllers/v1Controller");
const booking = require("../controllers/bookingController");
const { createPilotIdentityMiddleware } = require("../middleware/pilotIdentity");

// Mounted behind requireServiceKey in index.js. Routes acting for a member also
// need to know who: their core JWT in X-User-Token (the website), or their CID
// in X-Pilot-Cid from a trusted virtual airline (see middleware/pilotIdentity).
const requirePilot = createPilotIdentityMiddleware();

router.get("/airports", v1.listAirports);
router.get("/airports/:icao/stands", v1.getStands);
router.get("/airports/:icao/status", v1.getStatus);
router.post("/airports/:icao/suggest", v1.suggestRateLimit, v1.suggest);

router.post("/airports/:icao/bookings", requirePilot, v1.suggestRateLimit, booking.book);
router.get("/me/booking", requirePilot, booking.myBooking);
router.delete("/me/booking", requirePilot, booking.cancel);
router.get("/me/prefiles", requirePilot, booking.myPrefiles);

module.exports = router;
