const express = require("express");
const router = express.Router();
const v1 = require("../controllers/v1Controller");
const booking = require("../controllers/bookingController");
const { createUserTokenMiddleware } = require("../middleware/userToken");

// Mounted behind requireServiceKey in index.js. Routes acting for a member also
// need their core JWT, forwarded by the website in X-User-Token.
const requireUserToken = createUserTokenMiddleware();

router.get("/airports", v1.listAirports);
router.get("/airports/:icao/stands", v1.getStands);
router.get("/airports/:icao/status", v1.getStatus);
router.post("/airports/:icao/suggest", v1.suggestRateLimit, v1.suggest);

router.post("/airports/:icao/bookings", requireUserToken, v1.suggestRateLimit, booking.book);
router.get("/me/booking", requireUserToken, booking.myBooking);
router.delete("/me/booking", requireUserToken, booking.cancel);
router.get("/me/prefiles", requireUserToken, booking.myPrefiles);

module.exports = router;
