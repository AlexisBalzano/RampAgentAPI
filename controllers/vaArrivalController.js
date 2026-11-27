/**
 * /api/v1/va/arrivals: arrival stand preferences from virtual airlines.
 *
 * Only VA keys (req.vaIntegration, set by requireServiceKey) may call these,
 * and only for callsigns under their prefixes. The preference is per flight,
 * not per pilot, so no X-Pilot-Cid is needed. See services/vaArrivalService
 * for what a preference does.
 */
const airportService = require("../services/airportService");
const airportIndex = require("../services/airportIndex");
const occupancyService = require("../services/occupancyService");
const vaArrivals = require("../services/vaArrivalService");
const { error } = require("../utils/logger");

const ICAO = /^[A-Z0-9]{4}$/;
const STAND = /^[A-Z0-9-]{1,10}$/i;
const CALLSIGN = /^[A-Z0-9]{2,10}$/;
const TYPE = /^[A-Z0-9]{2,4}$/;

/** Rejects any key that is not a VA's. */
exports.requireVa = (req, res, next) => {
  const va = req.vaIntegration;
  if (!va || !Array.isArray(va.prefixes) || va.prefixes.length === 0) {
    return res.status(403).json({ error: "Only virtual airline keys may do this", code: "va_only" });
  }
  next();
};

/** The callsign from the path, upper-cased, when it is the VA's; otherwise answers and returns null. */
function ownedCallsign(req, res) {
  const callsign = String(req.params.callsign || "").trim().toUpperCase();
  if (!CALLSIGN.test(callsign)) {
    res.status(400).json({ error: "Malformed callsign", field: "callsign" });
    return null;
  }
  if (!req.vaIntegration.prefixes.some((p) => callsign.startsWith(p))) {
    res.status(403).json({ error: `${callsign} is not under this airline's callsigns`, code: "callsign_not_allowed" });
    return null;
  }
  return callsign;
}

/** GET /api/v1/va/arrivals */
exports.list = (req, res) => {
  res.json(vaArrivals.listFor(req.vaIntegration.id));
};

/** GET /api/v1/va/arrivals/:callsign */
exports.get = (req, res) => {
  const callsign = ownedCallsign(req, res);
  if (!callsign) return;
  const preference = vaArrivals.getFor(req.vaIntegration.id, callsign);
  if (!preference) return res.status(404).json({ error: "No preference for this flight", code: "no_preference" });
  res.json(preference);
};

/** PUT /api/v1/va/arrivals/:callsign { arrival, stand, aircraftType, eta } */
exports.put = async (req, res) => {
  try {
    const callsign = ownedCallsign(req, res);
    if (!callsign) return;

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const icao = typeof body.arrival === "string" ? body.arrival.trim().toUpperCase() : "";
    if (!ICAO.test(icao)) return res.status(400).json({ error: "arrival must be an ICAO code", field: "arrival" });
    const standName = typeof body.stand === "string" ? body.stand.trim() : "";
    if (!STAND.test(standName)) return res.status(400).json({ error: "stand is required", field: "stand" });
    const aircraftType = typeof body.aircraftType === "string" ? body.aircraftType.trim().toUpperCase() : "";
    if (!TYPE.test(aircraftType)) {
      return res.status(400).json({ error: "aircraftType must be an ICAO type designator", field: "aircraftType" });
    }
    const eta = typeof body.eta === "string" ? Date.parse(body.eta) : NaN;
    if (!Number.isFinite(eta)) {
      return res.status(400).json({ error: "eta must be an ISO 8601 date-time", field: "eta" });
    }

    if (!airportService.getAirportList().includes(icao)) {
      return res.status(404).json({ error: "Unknown airport", code: "unknown_airport" });
    }
    const airport = await airportIndex.get(icao);
    if (!airport) return res.status(404).json({ error: "Unknown airport", code: "unknown_airport" });
    const config = await airportService.getConfig();
    if (!config) return res.status(503).json({ error: "Configuration not loaded" });

    // The stand's own spelling, so "a12" names "A12".
    const exact = [...airport.standsByName.keys()].find((n) => n.toUpperCase() === standName.toUpperCase());
    if (!exact) {
      return res.status(404).json({ error: `Stand ${standName} does not exist at ${icao}`, code: "unknown_stand" });
    }
    const size = occupancyService.checkStandSize(airport, airportIndex.deriveConfig(config), aircraftType, exact);
    if (!size.known) {
      return res.status(422).json({ error: `Unknown aircraft type ${aircraftType}`, code: "unknown_aircraft_type", field: "aircraftType" });
    }

    const result = vaArrivals.upsert({
      va: req.vaIntegration,
      callsign,
      airport,
      standName: exact,
      aircraftType,
      eta,
      fits: size.fits,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code, ...(result.field ? { field: result.field } : {}) });
    }
    res.status(result.created ? 201 : 200).json(result.preference);
  } catch (err) {
    error(`Arrival preference failed: ${err.message}`, { category: "VA Arrival" });
    res.status(500).json({ error: "Failed to save the preference" });
  }
};

/** DELETE /api/v1/va/arrivals/:callsign */
exports.remove = (req, res) => {
  const callsign = ownedCallsign(req, res);
  if (!callsign) return;
  if (!vaArrivals.remove(req.vaIntegration.id, callsign)) {
    return res.status(404).json({ error: "No preference for this flight", code: "no_preference" });
  }
  res.status(204).end();
};
