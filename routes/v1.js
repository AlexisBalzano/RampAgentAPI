const express = require("express");
const router = express.Router();
const v1 = require("../controllers/v1Controller");
const booking = require("../controllers/bookingController");
const vaArrival = require("../controllers/vaArrivalController");
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

// Arrival stand preferences, per flight: VA keys only, no pilot identity.
router.get("/va/arrivals", vaArrival.requireVa, vaArrival.list);
router.get("/va/arrivals/:callsign", vaArrival.requireVa, vaArrival.get);
router.put("/va/arrivals/:callsign", vaArrival.requireVa, v1.suggestRateLimit, vaArrival.put);
router.delete("/va/arrivals/:callsign", vaArrival.requireVa, vaArrival.remove);

module.exports = router;
