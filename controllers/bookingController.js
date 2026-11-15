/**
 * /api/v1 departure stand booking, on behalf of a signed-in member.
 *
 * Every route runs behind requireServiceKey (the website is calling) and
 * requireUserToken (req.cid: for whom). Only members with a prefile departing
 * one of our airports can book; arrivals are left to the assignment engine.
 */
const airportService = require("../services/airportService");
const airportIndex = require("../services/airportIndex");
const prefileService = require("../services/prefileService");
const bookingService = require("../services/bookingService");
const { error } = require("../utils/logger");

const ICAO = /^[A-Z0-9]{4}$/;
const STAND = /^[A-Z0-9-]{1,10}$/i;

const unavailable = (res) =>
  res.status(503).json({ error: "Prefiled flight plans are unavailable right now", code: "prefiles_unavailable" });

async function covered() {
  return new Set(airportService.getAirportList());
}

/** GET /api/v1/me/prefiles - the member's prefiles departing an airport we cover. */
exports.myPrefiles = async (req, res) => {
  let mine;
  try {
    mine = await prefileService.forCid(req.cid);
  } catch (err) {
    return unavailable(res);
  }
  try {
    const airports = await covered();
    res.json(
      mine
        .filter((p) => airports.has(p.departure))
        .map((p) => ({
          callsign: p.callsign,
          aircraftType: p.aircraftType,
          departure: p.departure,
          arrival: p.arrival,
          deptime: p.deptime,
        }))
    );
  } catch (err) {
    error(`Prefile listing failed: ${err.message}`, { category: "Booking" });
    res.status(500).json({ error: "Failed to list prefiles" });
  }
};

/** GET /api/v1/me/booking - the member's held booking and how their last one ended. */
exports.myBooking = (req, res) => {
  res.json(bookingService.forCid(req.cid));
};

/** DELETE /api/v1/me/booking */
exports.cancel = (req, res) => {
  if (!bookingService.cancel(req.cid)) {
    return res.status(404).json({ error: "You have no stand booked", code: "no_booking" });
  }
  res.status(204).end();
};

/**
 * POST /api/v1/airports/:icao/bookings { stand, callsign? }
 *
 * The flight is the member's prefile departing :icao (the one named by
 * `callsign` when they have several). Type, destination and remarks come from
 * the prefile, never from the request.
 */
exports.book = async (req, res) => {
  try {
    const icao = String(req.params.icao || "").toUpperCase();
    if (!ICAO.test(icao) || !airportService.getAirportList().includes(icao)) {
      return res.status(404).json({ error: "Unknown airport" });
    }
    const airport = await airportIndex.get(icao);
    if (!airport) return res.status(404).json({ error: "Unknown airport" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const standName = typeof body.stand === "string" ? body.stand.trim() : "";
    if (!STAND.test(standName)) {
      return res.status(400).json({ error: "stand is required", field: "stand" });
    }
    const wantedCallsign = typeof body.callsign === "string" ? body.callsign.trim().toUpperCase() : "";

    let mine;
    try {
      mine = await prefileService.forCid(req.cid);
    } catch (err) {
      return unavailable(res);
    }
    const departing = mine.filter(
      (p) => p.departure === icao && (!wantedCallsign || p.callsign === wantedCallsign)
    );
    if (departing.length === 0) {
      return res.status(422).json({
        error: `No prefiled flight plan departing ${icao} on your VATSIM account. File one, then book.`,
        code: "no_prefile",
      });
    }
    if (departing.length > 1 && !wantedCallsign) {
      return res.status(422).json({
        error: "You have several prefiles departing here: say which callsign",
        code: "several_prefiles",
        field: "callsign",
      });
    }

    const config = await airportService.getConfig();
    if (!config) return res.status(503).json({ error: "Configuration not loaded" });

    // The stand's own spelling, so "a12" books "A12".
    const exact = [...airport.standsByName.keys()].find((n) => n.toUpperCase() === standName.toUpperCase());

    const result = bookingService.book({
      cid: req.cid,
      prefile: departing[0],
      airport,
      derived: airportIndex.deriveConfig(config),
      standName: exact || standName,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }
    res.status(201).json(result.booking);
  } catch (err) {
    error(`Booking failed: ${err.message}`, { category: "Booking" });
    res.status(500).json({ error: "Failed to book the stand" });
  }
};
