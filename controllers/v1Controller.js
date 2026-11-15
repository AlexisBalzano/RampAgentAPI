/**
 * /api/v1 - the contract the vACC website's stand finder relies on.
 *
 * Every route sits behind requireServiceKey (see middleware/serviceKey.js). The
 * unversioned routes used by the viewer and the EuroScope plugin are untouched;
 * anything here may evolve only in backwards-compatible ways.
 *
 * Resource root is /api/v1/airports/:icao/..., which stand booking will extend.
 */
const airportService = require("../services/airportService");
const airportIndex = require("../services/airportIndex");
const occupancyService = require("../services/occupancyService");
const stat = require("../services/statService");
const { info, warn, error } = require("../utils/logger");
const { cachedPayload } = require("./occupancyController");

const ICAO_PARAM = /^[A-Z0-9]{4}$/;

function notFound(res) {
  return res.status(404).json({ error: "Unknown airport" });
}

/**
 * The compiled airport for a path ICAO, or null when there is no such airport.
 * Compiles on demand through the same path the datafeed loop uses, so an
 * airport present in the config repo but not yet loaded is not an error.
 */
async function resolveAirport(rawIcao) {
  const icao = String(rawIcao || "").toUpperCase();
  if (!ICAO_PARAM.test(icao)) return null;
  if (!airportService.getAirportList().includes(icao)) return null;
  const airport = await airportIndex.get(icao);
  return airport && airport.stands ? airport : null;
}

// ---------------------------------------------------------------------------
// GET /api/v1/airports

exports.listAirports = async (req, res) => {
  try {
    const airports = await airportService.getAirportListAndCoordinates();
    res.json(
      airports.map((a) => ({ icao: a.name, coords: a.coords, standCount: a.standCount }))
    );
  } catch (err) {
    error(`v1 airport list failed: ${err.message}`, { category: "Service" });
    res.status(500).json({ error: "Failed to list airports" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/airports/:icao/stands

// Stand definitions as the website sees them. This is the only place that
// knows the config-file format; the website never parses raw config strings.
const DEFAULT_STAND_RADIUS = 15; // same fallback as airportService.getAllStands

const letters = (value) =>
  typeof value === "string" && value.length > 0 ? value.toUpperCase().split("") : null;

const stringList = (value) =>
  Array.isArray(value) && value.length > 0 ? value.map((v) => String(v)) : null;

/** Remark is keyed by code lists ("CD": "..."); expanded to one entry per code letter. */
function normalizeRemark(remark) {
  if (typeof remark === "string") return remark || null;
  if (!remark || typeof remark !== "object") return null;
  const byCode = {};
  for (const [codeList, text] of Object.entries(remark)) {
    for (const code of String(codeList).toUpperCase()) {
      if (!(code in byCode)) byCode[code] = String(text);
    }
  }
  return Object.keys(byCode).length > 0 ? byCode : null;
}

/** One stand definition, normalized, or null (with a warning) when unusable. */
function normalizeStand(icao, name, def) {
  const parts = String((def && def.Coordinates) || "").split(":").map((s) => s.trim());
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    warn(`Stand ${name} at ${icao} has unusable coordinates, left out of /api/v1`, {
      category: "Missing Data",
      icao,
    });
    return null;
  }
  const radius = parts.length > 2 ? parseFloat(parts[2]) : NaN;

  return {
    name,
    lat,
    lon,
    radius: Number.isFinite(radius) ? radius : DEFAULT_STAND_RADIUS,
    codes: letters(def.Code),
    uses: letters(def.Use),
    schengen: typeof def.Schengen === "boolean" ? def.Schengen : null,
    maxWingspan: typeof def.Wingspan === "number" && def.Wingspan > 0 ? def.Wingspan : null,
    callsigns: stringList(def.Callsigns),
    countries: stringList(def.Countries),
    apron: def.Apron !== undefined,
    // Same rule as the engine (CompiledStand): only a positive integer counts.
    priority: Number.isInteger(def.Priority) && def.Priority > 0 ? def.Priority : null,
    remark: normalizeRemark(def.Remark),
  };
}

function normalizeAirportStands(raw) {
  const icao = raw.ICAO;
  const stands = [];
  for (const [name, def] of Object.entries(raw.Stands || {})) {
    const stand = normalizeStand(icao, name, def || {});
    if (stand) stands.push(stand);
  }
  return { icao, version: raw.version ?? null, stands };
}

// Serialized per ICAO; dropped when the config changes (version bump or webhook).
const standsCache = new Map(); // ICAO -> JSON body
airportIndex.onInvalidate((icao) => {
  if (icao === null) standsCache.clear();
  else standsCache.delete(icao);
});

exports.getStands = async (req, res) => {
  try {
    const airport = await resolveAirport(req.params.icao);
    if (!airport) return notFound(res);

    const icao = String(req.params.icao).toUpperCase();
    let body = standsCache.get(icao);
    if (!body) {
      body = JSON.stringify(normalizeAirportStands(airport.raw));
      standsCache.set(icao, body);
    }
    res.type("application/json").send(body);
  } catch (err) {
    error(`v1 stands failed: ${err.message}`, { category: "Service" });
    res.status(500).json({ error: "Failed to load stands" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/airports/:icao/status

function buildStatus(icao) {
  const registry = occupancyService.registry;
  const stands = {};

  // Precedence: occupied over assigned over blocked. Aprons hold several
  // aircraft, so they also carry how many places are used out of how many.
  const put = (stand, state) => {
    if (stand.icao !== icao) return;
    let entry = stands[stand.name];
    if (!entry) {
      entry = stands[stand.name] = { state, callsign: stand.callsign || null };
    }
    if (stand.apronSize > 0 && state !== "blocked") {
      entry.used = (entry.used || 0) + 1;
      entry.capacity = stand.apronSize;
    }
  };
  for (const s of registry.getAllOccupied()) put(s, "occupied");
  // A departure booking is an assigned stand underneath; the website shows it
  // as booked.
  for (const s of registry.getAllAssigned()) put(s, s.status === "booked" ? "booked" : "assigned");
  for (const s of registry.getAllBlocked()) put(s, "blocked");

  const cycleAt = occupancyService.getLastCycleAt();
  return {
    icao,
    updatedAt: cycleAt ? new Date(cycleAt).toISOString() : null,
    stands,
  };
}

exports.getStatus = async (req, res) => {
  try {
    const airport = await resolveAirport(req.params.icao);
    if (!airport) return notFound(res);

    const icao = String(req.params.icao).toUpperCase();
    // The cycle time is part of the cache key: updatedAt moves every cycle even
    // when no stand changed.
    const body = cachedPayload(`v1status:${icao}`, () => buildStatus(icao), occupancyService.getLastCycleAt());
    res.type("application/json").send(body);
  } catch (err) {
    error(`v1 status failed: ${err.message}`, { category: "Service" });
    res.status(500).json({ error: "Failed to retrieve airport status" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/airports/:icao/suggest

const CALLSIGN = /^[A-Z0-9-]{2,10}$/;
const AIRCRAFT_TYPE = /^[A-Z0-9]{2,4}$/;
const ORIGIN = /^[A-Z]{4}$/;
const MAX_REMARKS = 500;
const MAX_ALTERNATIVES = 5;

const badRequest = (res, field, message) => res.status(400).json({ error: message, field });

/** The validated suggest input, or null after answering 400. */
function readSuggestBody(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : "");

  const callsign = upper(body.callsign);
  if (!CALLSIGN.test(callsign)) {
    badRequest(res, "callsign", "callsign must be 2-10 characters: letters, digits or '-'");
    return null;
  }
  const aircraftType = upper(body.aircraftType);
  if (!AIRCRAFT_TYPE.test(aircraftType)) {
    badRequest(res, "aircraftType", "aircraftType must be 2-4 letters or digits");
    return null;
  }
  // Arrival (the default) needs where the flight comes from; departure, where
  // it goes. The other end is always this airport.
  const direction = body.direction === undefined || body.direction === null ? "arrival" : body.direction;
  if (direction !== "arrival" && direction !== "departure") {
    badRequest(res, "direction", "direction must be 'arrival' or 'departure'");
    return null;
  }
  const otherField = direction === "arrival" ? "origin" : "destination";
  const otherAirport = upper(body[otherField]);
  if (!ORIGIN.test(otherAirport)) {
    badRequest(res, otherField, `${otherField} must be a 4-letter ICAO code`);
    return null;
  }
  let remarks = null;
  if (body.remarks !== undefined && body.remarks !== null) {
    if (typeof body.remarks !== "string" || body.remarks.length > MAX_REMARKS) {
      badRequest(res, "remarks", `remarks must be a string of at most ${MAX_REMARKS} characters`);
      return null;
    }
    remarks = body.remarks;
  }
  return { callsign, aircraftType, direction, otherAirport, remarks };
}

/** Turns an evaluation into the response body. Pure, so it is unit-tested directly. */
function buildSuggestion(icao, evaluation, now = new Date()) {
  const { profile, fitCount, candidates } = evaluation;
  const free = evaluation.free || candidates;

  let suggested = null;
  let alternatives = [];
  let reason = null;
  if (candidates.length > 0) {
    // pickTightest, as the engine uses it: random among the tightest equals.
    const chosen = occupancyService.pickTightest(candidates);
    suggested = chosen.name;
    // The rest of the best tier first, then the lower tiers in Priority order:
    // a lone stand in its tier still leaves the pilot somewhere to go.
    alternatives = occupancyService
      .orderByPreference(free)
      .filter((stand) => stand !== chosen)
      .slice(0, MAX_ALTERNATIVES)
      .map((stand) => stand.name);
  } else if (fitCount === 0) {
    reason = profile.typeKnown ? "no_compatible_stand" : "unknown_type";
  } else {
    reason = "all_compatible_occupied";
  }

  return {
    icao,
    direction: evaluation.direction || "arrival",
    profile: {
      use: profile.use,
      code: profile.code,
      wingspan: profile.wingspan,
      typeKnown: profile.typeKnown,
      schengen: profile.schengen,
      company: profile.compagnyPrefix,
      // Country of the other end: the origin of an arrival, the destination of a departure.
      otherCountry: profile.originPrefix,
    },
    suggested,
    alternatives,
    reason,
    evaluatedAt: now.toISOString(),
  };
}

exports.suggest = async (req, res) => {
  try {
    const airport = await resolveAirport(req.params.icao);
    if (!airport) return notFound(res);

    const input = readSuggestBody(req, res);
    if (!input) return;

    const config = await airportService.getConfig();
    if (!config) {
      return res.status(503).json({ error: "Configuration not loaded" });
    }
    const derived = airportIndex.deriveConfig(config);

    const evaluation = occupancyService.evaluateStand(airport, derived, input);
    const result = buildSuggestion(airport.icao, { ...evaluation, direction: input.direction });

    stat.incrementSuggestCount();
    const p = result.profile;
    const route = input.direction === "departure" ? `to ${input.otherAirport}` : `from ${input.otherAirport}`;
    info(
      `Suggest ${input.direction} for ${input.callsign} (${input.aircraftType} ${route}) at ${airport.icao}: ` +
        `${result.suggested || "none"}${result.reason ? ` (${result.reason})` : ""} - ` +
        `Use ${p.use}, Code ${p.code}, Wingspan ${p.wingspan}m${p.typeKnown ? "" : " (unknown type)"}, ` +
        `Schengen ${p.schengen}, Service ${req.service}`,
      { category: "Suggest", callsign: input.callsign, icao: airport.icao }
    );

    res.json(result);
  } catch (err) {
    error(`v1 suggest failed: ${err.message}`, { category: "Suggest" });
    res.status(500).json({ error: "Failed to evaluate stand" });
  }
};

// ---------------------------------------------------------------------------
// Per-service rate limit for /suggest. The website applies its own per-user
// limits; this is a safety net against a runaway caller.

const SUGGEST_LIMIT_PER_MINUTE = (() => {
  const configured = parseInt(process.env.SUGGEST_RATE_LIMIT, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 600;
})();

function createRateLimiter(limit, windowMs = 60_000, now = Date.now) {
  const windows = new Map(); // service -> { start, count }
  return function rateLimit(req, res, next) {
    const key = req.service || "unknown";
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    if (w.count >= limit) {
      res.set("Retry-After", String(Math.ceil((w.start + windowMs - t) / 1000)));
      return res.status(429).json({ error: "Rate limit exceeded" });
    }
    w.count++;
    next();
  };
}

exports.suggestRateLimit = createRateLimiter(SUGGEST_LIMIT_PER_MINUTE);

// Exposed for the unit tests.
exports._internal = {
  normalizeStand,
  normalizeAirportStands,
  readSuggestBody,
  buildSuggestion,
  buildStatus,
  createRateLimiter,
  standsCache,
};
