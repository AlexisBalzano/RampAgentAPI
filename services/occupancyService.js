const { info, warn, error } = require("../utils/logger");
const airportService = require("./airportService");
const airportIndex = require("./airportIndex");
const { haversineMeters, withinRadius } = require("../utils/utils");

// Caches that only exist to stop log flooding when the same condition repeats
// on every datafeed cycle.
const aircraftTypeCache = new Set();
const noStandFoundCache = new Set();
const searchLoggedCache = new Set();
const missingCoordsCache = new Set();

setInterval(() => {
  aircraftTypeCache.clear();
  noStandFoundCache.clear();
  searchLoggedCache.clear();
  missingCoordsCache.clear();
}, 60 * 60 * 1000); // Clear every hour

const MAX_DISTANCE = Number.MAX_SAFE_INTEGER;
const METERS_TO_NM = 0.00053996;

class Stand {
  constructor(name, icao, callsign, remark = "", apronSize = 0) {
    this.name = name;
    this.icao = icao;
    this.callsign = callsign;
    this.remark = remark;
    this.apronSize = apronSize;
    this.timestamp = Date.now();

    // Identity fields never change after construction, so both keys are built
    // once here rather than on every registry lookup.
    this.slot = `${icao}:${name}`;
    this._key = apronSize > 0 ? `${this.slot}:${callsign}` : this.slot;
  }

  // Hash function for the Stand class
  key() {
    return this._key;
  }

  equals(other) {
    return (
      this.icao === other.icao &&
      this.name === other.name &&
      this.callsign === other.callsign &&
      this.apronSize === other.apronSize
    );
  }

  toJSON() {
    return {
      name: this.name,
      icao: this.icao,
      callsign: this.callsign,
      remark: this.remark,
      apronSize: this.apronSize,
      timestamp: this.timestamp,
    };
  }
}

// Small helpers for the "key -> count" secondary indexes.
function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}
function drop(map, key) {
  const n = map.get(key);
  if (n === undefined) return;
  if (n <= 1) map.delete(key);
  else map.set(key, n - 1);
}
function addTo(map, key, value) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}
function removeFrom(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

/**
 * Stand bookkeeping for every tracked airport.
 *
 * The three primary Maps are the source of truth. Everything else is a
 * secondary index kept in step by add/remove, so that the questions the
 * datafeed loop asks thousands of times per cycle - "is this slot taken?",
 * "what does this callsign hold?", "how full is this apron?" - are O(1)
 * instead of a linear scan (and an array allocation) over the whole registry.
 */
class StandRegistry {
  constructor() {
    this.occupied = new Map(); // key -> Stand
    this.assigned = new Map(); // key -> Stand
    this.blocked = new Map(); // key -> Stand

    this.occupiedByCallsign = new Map(); // callsign -> Set<Stand>
    this.assignedByCallsign = new Map();
    this.blockedByCallsign = new Map();

    // Per slot ("ICAO:name") counters, split by whether the stand is an apron.
    this.occupiedSimple = new Map(); // slot -> count
    this.occupiedApron = new Map(); // slot -> count
    this.assignedSimple = new Map();
    this.assignedApron = new Map();
    this.apronCapacity = new Map(); // slot -> declared apron size

    // Bumped on every mutation so read endpoints can cache their serialised
    // payload and skip rebuilding it between datafeed cycles.
    this.version = 0;
  }

  _index(stand, byCallsign, simple, apron) {
    addTo(byCallsign, stand.callsign, stand);
    if (stand.apronSize > 0) {
      bump(apron, stand.slot);
      this.apronCapacity.set(stand.slot, stand.apronSize);
    } else {
      bump(simple, stand.slot);
    }
  }

  _unindex(stand, byCallsign, simple, apron) {
    removeFrom(byCallsign, stand.callsign, stand);
    if (stand.apronSize > 0) drop(apron, stand.slot);
    else drop(simple, stand.slot);
  }

  addOccupied(stand) {
    const key = stand.key();
    const previous = this.occupied.get(key);
    if (previous) {
      this._unindex(
        previous,
        this.occupiedByCallsign,
        this.occupiedSimple,
        this.occupiedApron
      );
    }
    this.occupied.set(key, stand);
    this._index(
      stand,
      this.occupiedByCallsign,
      this.occupiedSimple,
      this.occupiedApron
    );
    this.version++;
  }

  removeOccupied(stand) {
    const key = stand.key();
    const current = this.occupied.get(key);
    if (!current) return;
    this.occupied.delete(key);
    this._unindex(
      current,
      this.occupiedByCallsign,
      this.occupiedSimple,
      this.occupiedApron
    );
    this.version++;
  }

  addAssigned(stand) {
    const key = stand.key();
    const previous = this.assigned.get(key);
    if (previous) {
      this._unindex(
        previous,
        this.assignedByCallsign,
        this.assignedSimple,
        this.assignedApron
      );
    }
    this.assigned.set(key, stand);
    this._index(
      stand,
      this.assignedByCallsign,
      this.assignedSimple,
      this.assignedApron
    );
    this.version++;
  }

  removeAssigned(stand) {
    const key = stand.key();
    const current = this.assigned.get(key);
    if (!current) return;
    this.assigned.delete(key);
    this._unindex(
      current,
      this.assignedByCallsign,
      this.assignedSimple,
      this.assignedApron
    );
    this.version++;
  }

  addBlocked(stand) {
    const key = stand.key();
    const previous = this.blocked.get(key);
    if (previous) removeFrom(this.blockedByCallsign, previous.callsign, previous);
    this.blocked.set(key, stand);
    addTo(this.blockedByCallsign, stand.callsign, stand);
    this.version++;
  }

  removeBlocked(stand) {
    const key = stand.key();
    const current = this.blocked.get(key);
    if (!current) return;
    this.blocked.delete(key);
    removeFrom(this.blockedByCallsign, current.callsign, current);
    this.version++;
  }

  /** First occupied stand held by a callsign, or undefined. */
  firstOccupiedOf(callsign) {
    const set = this.occupiedByCallsign.get(callsign);
    if (!set) return undefined;
    return set.values().next().value;
  }

  /** First assigned stand held by a callsign, or undefined. */
  firstAssignedOf(callsign) {
    const set = this.assignedByCallsign.get(callsign);
    if (!set) return undefined;
    return set.values().next().value;
  }

  blockedOf(callsign) {
    return this.blockedByCallsign.get(callsign);
  }

  removeAllOccupiedOf(callsign) {
    const set = this.occupiedByCallsign.get(callsign);
    if (!set) return;
    for (const stand of Array.from(set)) this.removeOccupied(stand);
  }

  removeAllAssignedOf(callsign) {
    const set = this.assignedByCallsign.get(callsign);
    if (!set) return;
    for (const stand of Array.from(set)) this.removeAssigned(stand);
  }

  removeAllBlockedOf(callsign) {
    const set = this.blockedByCallsign.get(callsign);
    if (!set) return;
    for (const stand of Array.from(set)) this.removeBlocked(stand);
  }

  apronLevelOfSlot(slot) {
    return (this.occupiedApron.get(slot) || 0) + (this.assignedApron.get(slot) || 0);
  }

  getApronOccupancyLevel(standName, icao) {
    // Count how many pilot have this stand assigned or occupied
    return this.apronLevelOfSlot(`${icao}:${standName}`);
  }

  _slotTaken(slot, simple, apron) {
    if (simple.has(slot)) return true;
    if (apron.has(slot)) {
      const capacity = this.apronCapacity.get(slot);
      if (this.apronLevelOfSlot(slot) >= capacity) return true;
    }
    return false;
  }

  isOccupied(icao, name) {
    return this._slotTaken(
      `${icao}:${name}`,
      this.occupiedSimple,
      this.occupiedApron
    );
  }

  isAssigned(icao, name) {
    return this._slotTaken(
      `${icao}:${name}`,
      this.assignedSimple,
      this.assignedApron
    );
  }

  isBlocked(icao, name) {
    return this.blocked.has(`${icao}:${name}`);
  }

  getBlocked(icao, name) {
    return this.blocked.get(`${icao}:${name}`);
  }

  getAllOccupied() {
    return Array.from(this.occupied.values());
  }

  getAllAssigned() {
    return Array.from(this.assigned.values());
  }

  getAllBlocked() {
    return Array.from(this.blocked.values());
  }

  clearExpired(predicateFn) {
    // e.g. remove old stands if needed
    for (const stand of Array.from(this.occupied.values())) {
      if (predicateFn(stand)) {
        this.removeOccupied(stand);
        info(
          `Clearing expired occupied stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
          {
            category: "Stand Management",
            callsign: stand.callsign,
            icao: stand.icao,
          }
        );
      }
    }
    for (const stand of Array.from(this.assigned.values())) {
      if (predicateFn(stand)) {
        this.removeAssigned(stand);
        info(
          `Clearing expired assigned stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
          {
            category: "Stand Management",
            callsign: stand.callsign,
            icao: stand.icao,
          }
        );
      }
    }
    for (const stand of Array.from(this.blocked.values())) {
      if (predicateFn(stand)) {
        this.removeBlocked(stand);
        info(
          `Clearing expired blocked stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
          {
            category: "Stand Management",
            callsign: stand.callsign,
            icao: stand.icao,
          }
        );
      }
    }
  }
}

const registry = new StandRegistry();

// Tracks Hoppie gate-terminal TELEX notification lifecycle per callsign, independent of
// StandRegistry (a Stand object is replaced, not mutated, on reassignment, so a flag stored
// on it would not survive a stand swap and could cause a resend).
// status: 'pending' (below the altitude threshold) | 'sent'
const notificationState = new Map();

const HOPPIE_DEFAULT_MIN_ALTITUDE_FT = 10000;
const HOPPIE_RECHECK_TICKS = 4; // ~60s at a 15s datafeed tick, to bound call volume
const TELEX_TIMEOUT_MS = 5000;

// Read per call rather than once at load. Reading it at module scope needed a
// top-level await, which turns this CommonJS file into an ESM graph and makes
// every require() of it throw - it took the whole API down, not just Hoppie.
// Reading it here also means a config version bump takes effect without a
// restart, like every other setting.
function hoppieMinAltitudeFt(config) {
  const configured = config && config.Hoppie && config.Hoppie.min_alt;
  return typeof configured === "number" && configured > 0
    ? configured
    : HOPPIE_DEFAULT_MIN_ALTITUDE_FT;
}

// Determines whether an assigned stand qualifies for a Hoppie notification: both the stand
// (Terminal) and the airport (Hoppie.MessageTemplate) must opt in via config. Absence of either
// is the sole scoping mechanism - no separate enable flag exists.
function getHoppieEligibility(standDef, airportConfig) {
  if (!standDef || !standDef.Terminal) return null;
  if (!airportConfig || !airportConfig.Hoppie || !airportConfig.Hoppie.MessageTemplate) {
    return null;
  }
  return {
    terminal: standDef.Terminal,
    briefingUrl: airportConfig.Hoppie.BriefingUrl || "",
    messageTemplate: airportConfig.Hoppie.MessageTemplate,
    info: standDef.Info || ""
  };
}

// `info` must be a parameter: without it the name resolves to the logger's
// info() imported at the top of this file, and String.replace given a function
// calls it - writing a junk log line and substituting its return value, so the
// message came out as "STAND 2A undefined" and then failed the charset check.
function buildTelexMessage(messageTemplate, terminal, briefingUrl, info) {
  return messageTemplate
    .replace(/{terminal}/g, terminal)
    .replace(/{briefingUrl}/g, briefingUrl)
    .replace(/{info}/g, info);
}

// Mirrors the rule PINEDE enforces on the rendered text: /^[A-Z0-9 .,\-@/]+$/,
// 1..220 characters. It is a security control there, not just formatting -
// PINEDE builds the Hoppie URL by concatenation and only runs encodeURI over
// it, which leaves reserved characters alone, so "&" or "=" would inject query
// parameters and "#" would truncate the packet. "/" delimits nothing inside a
// query value and is allowed.
//
// Checking it here first turns a config mistake into one explicit log line
// naming the offending characters, instead of a POST that PINEDE rejects and
// that is then retried every recheck window for the rest of the flight.
const TELEX_ALLOWED = /^[A-Z0-9 .,\-@/\n]+$/;
const TELEX_ALLOWED_CHAR = /[A-Z0-9 .,\-@/\n]/;
const TELEX_MAX_LENGTH = 220;

// PINEDE applies the same shape to the callsign. General aviation callsigns
// carry a hyphen ("F-GKXA"), so those cannot be notified at all - catching it
// here says why, instead of a bare "Bad Request".
const TELEX_CALLSIGN = /^[A-Z0-9]{2,10}$/;

function telexRejectionReason(callsign, message) {
  if (!TELEX_CALLSIGN.test(callsign || "")) {
    return `callsign ${JSON.stringify(callsign)} is not 2-10 letters or digits`;
  }
  if (!message) return "empty";
  if (message.length > TELEX_MAX_LENGTH) {
    return `too long (${message.length} > ${TELEX_MAX_LENGTH})`;
  }
  if (!TELEX_ALLOWED.test(message)) {
    const offending = [
      ...new Set([...message].filter((c) => !TELEX_ALLOWED_CHAR.test(c))),
    ].join("");
    return `unsupported characters ${JSON.stringify(offending)}`;
  }
  return null;
}

async function postTelex(callsign, message) {
  const pinedeURL = process.env.PINEDE_INTERNAL_URL || "http://vaccfr-pinede-backend:3000";
  const token = process.env.PINEDE_SERVICE_TOKEN;
  if (!token) {
    error("PINEDE_SERVICE_TOKEN is not set, cannot send Telex notification", { category: "Telex", callsign });
    return false;
  }

  try {
    const response = await fetch(`${pinedeURL}/v1/internal/telex`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      // PINEDE's schema names this field "text", not "message" - sending the
      // wrong key fails validation before the content is even looked at.
      body: JSON.stringify({ callsign, text: message }),
      // Without this an unresponsive PINEDE leaves the request outstanding
      // indefinitely while the caller keeps re-checking behind it.
      signal: AbortSignal.timeout(TELEX_TIMEOUT_MS),
    });
    if (!response.ok) {
      error(`Telex notification failed for ${callsign}: ${response.statusText}`, { category: "Telex", callsign });
      // A 4xx means PINEDE will reject this message every time - retrying just
      // repeats the same rejection once a minute until the aircraft lands.
      return response.status >= 400 && response.status < 500 ? "rejected" : "failed";
    }
    // Returning nothing here left the caller thinking the send had failed, so the
    // callsign stayed 'pending' and was re-sent every recheck window until landing.
    return "sent";
  } catch (err) {
    error(`Telex notification attempt failed for ${callsign}: ${err.message}`, { category: "Telex", callsign });
    return "failed"; // transient: stays 'pending', retried on a later window
  }
}

// Sends the TELEX. Never throws - best-effort, fire-and-forget.
async function sendTelexNotification(callsign, state) {
  try {
    const message = buildTelexMessage(
      state.messageTemplate,
      state.terminal,
      state.briefingUrl,
      state.info
    );
    const reason = telexRejectionReason(callsign, message);
    if (reason) {
      // Terminal: no retry can fix a message the config cannot express.
      state.status = "invalid";
      error(
        `Telex for ${callsign} not sent - ${reason}. Check the Hoppie MessageTemplate ` +
          `and Terminal for this airport; TELEX allows A-Z 0-9 space . , - @ / only`,
        { category: "Telex", callsign }
      );
      return;
    }

    const outcome = await postTelex(callsign, message);
    if (outcome === "sent") {
      state.status = "sent";
      info(
        `Hoppie gate-terminal notification sent to ${callsign} (Terminal ${state.terminal})`,
        { category: "Telex", callsign }
      );
    } else if (outcome === "rejected") {
      state.status = "invalid"; // terminal, see postTelex
    }
    // "failed" leaves it pending, to be retried on a later window
  } catch (err) {
    error(`Hoppie notification attempt failed for ${callsign}: ${err.message}`, { category: "Telex", callsign });
  }
}

// Registers a callsign as eligible for a Hoppie notification the first time it's automatically
// assigned a Terminal-bearing stand.
function registerHoppieEligibility(callsign, standDef, airportConfig) {
  if (notificationState.has(callsign)) return; // already tracked this session
  const eligibility = getHoppieEligibility(standDef, airportConfig);
  if (!eligibility) return;

  notificationState.set(callsign, {
    status: "pending",
    terminal: eligibility.terminal,
    briefingUrl: eligibility.briefingUrl,
    messageTemplate: eligibility.messageTemplate,
    info: eligibility.info || "",
    ticksSinceCheck: 0,
    missedCycles: 0,
  });
}

// A session ends when the callsign stops appearing in the datafeed, not when it
// stops holding stands. Those are different: an aircraft whose stand is taken
// and cannot be given another holds nothing at all, and expiring its record
// there let the next assignment notify it a second time, with a different gate.
//
// Two consecutive absences rather than one, so a single dropped or late cycle
// does not reset a live session.
//
// The record also has to outlive anything the registry still holds for the
// callsign. Registry entries survive two minutes of silence while two cycles is
// about thirty seconds, so expiring purely on absence would leave a window in
// which the record is gone but a stale assignment remains - and swapping that
// assignment to another stand would notify a second time, which is the very
// thing this guards against.
const NOTIFICATION_ABSENT_CYCLES = 2;

function expireNotificationsNotSeen(seenCallsigns) {
  for (const [callsign, state] of notificationState) {
    if (seenCallsigns.has(callsign)) {
      state.missedCycles = 0;
      continue;
    }
    state.missedCycles += 1;
    if (state.missedCycles < NOTIFICATION_ABSENT_CYCLES) continue;

    const stillHoldsStands =
      registry.occupiedByCallsign.has(callsign) ||
      registry.assignedByCallsign.has(callsign) ||
      registry.blockedByCallsign.has(callsign);
    if (!stillHoldsStands) notificationState.delete(callsign);
  }
}

// Re-checked on every tick an already-assigned callsign is seen again; only actually evaluates
// every HOPPIE_RECHECK_TICKS ticks to bound outbound call volume.
function checkPendingHoppieNotification(ac, config) {
  const state = notificationState.get(ac.callsign);
  if (!state || state.status !== "pending") return;

  state.ticksSinceCheck += 1;
  if (state.ticksSinceCheck < HOPPIE_RECHECK_TICKS) return;
  state.ticksSinceCheck = 0;

  if (typeof ac.altitude === "number" && ac.altitude >= hoppieMinAltitudeFt(config)) {
    sendTelexNotification(ac.callsign, state);
  }
}

// Scratch buffers reused across calls. Both consumers are synchronous and
// non-reentrant, so this avoids an array allocation per aircraft.
const candidateScratch = [];
const availableScratch = [];

/**
 * Finds the stand an aircraft is parked on, setting ac.origin to the airport it
 * was found at. Returns "" when it is not on a stand at a tracked airport.
 */
function findAircraftStand(derived, ac, compiledAirports) {
  if (!ac || !ac.latitude || !ac.longitude) {
    return "";
  }

  const lat = ac.latitude;
  const lon = ac.longitude;

  // Find current airport
  let airport = null;
  for (let i = 0; i < compiledAirports.length; i++) {
    const candidate = compiledAirports[i];
    if (!candidate.hasCoords) continue;
    if (withinRadius(lat, lon, candidate.lat, candidate.lon, candidate.radius)) {
      ac.origin = candidate.icao;
      airport = candidate;
      break;
    }
  }

  // If no airport matched, traffic is not of interest
  if (!airport) {
    return "";
  }

  const stands = airport.stands;
  for (let i = 0; i < stands.length; i++) {
    const stand = stands[i];
    if (!stand.hasCoords) continue;

    // Aprons are polygons, and take precedence over the radius check.
    if (stand.apronRing && stand.isInApron(lat, lon)) {
      return stand.name;
    }

    if (!withinRadius(lat, lon, stand.lat, stand.lon, stand.radius)) continue;

    const aircraftType = ac.flight_plan && ac.flight_plan.aircraft_short;
    if (!aircraftType || aircraftType === "UNKNOWN") {
      if (ac.flight_plan) {
        warn(`Aircraft ${ac.callsign} on ground at ${ac.origin} has unknown type`, {
          category: "Missing Data",
          callsign: ac.callsign,
          icao: ac.origin,
        });
      }
      return stand.name;
    }

    if (!stand.block) {
      return stand.name;
    }

    // Candidates are the stands this one blocks, then itself - the same order
    // the previous Set-based implementation produced.
    const candidates = candidateScratch;
    candidates.length = 0;
    let selfIncluded = false;
    for (let b = 0; b < stand.block.length; b++) {
      const name = stand.block[b];
      if (name === stand.name) selfIncluded = true;
      const blocked = airport.standsByName.get(name);
      if (blocked) candidates.push(blocked);
    }
    if (!selfIncluded) candidates.push(stand);

    // Keep only the stands the aircraft is actually sitting within.
    let kept = 0;
    for (let c = 0; c < candidates.length; c++) {
      const candidate = candidates[c];
      if (!candidate.hasCoords) continue;
      if (!withinRadius(lat, lon, candidate.lat, candidate.lon, candidate.radius))
        continue;
      candidates[kept++] = candidate;
    }
    candidates.length = kept;

    // Drop stands that cannot take this aircraft, tracking the best priority.
    const aircraftCode = getAircraftCode(getAircraftWingspan(derived, aircraftType));
    let bestPriority = MAX_DISTANCE;
    kept = 0;
    for (let c = 0; c < candidates.length; c++) {
      const candidate = candidates[c];
      if (candidate.code && !candidate.code.includes(aircraftCode)) continue;
      candidates[kept++] = candidate;
      const priority = candidate.priority || MAX_DISTANCE;
      if (priority < bestPriority) bestPriority = priority;
    }
    candidates.length = kept;

    // Keep only stands with the lowest priority
    kept = 0;
    for (let c = 0; c < candidates.length; c++) {
      if ((candidates[c].priority || MAX_DISTANCE) > bestPriority) continue;
      candidates[kept++] = candidates[c];
    }
    candidates.length = kept;

    // If no potential stands remain, return the original stand
    if (candidates.length === 0) return stand.name;
    return candidates[0].name;
  }

  return "";
}

const blockStands = (compiledStand, icao, callsign) => {
  const block = compiledStand && compiledStand.block;
  if (!block) return;
  for (let i = 0; i < block.length; i++) {
    registry.addBlocked(new Stand(block[i], icao || "UNKNOWN", callsign, "", 0));
  }
};

function calculateRemainingDistance(ac, destination) {
  if (
    !ac.flight_plan ||
    !ac.flight_plan.arrival ||
    !ac.latitude ||
    !ac.longitude
  ) {
    return MAX_DISTANCE;
  }
  if (!destination || !destination.hasCoords) {
    if (!missingCoordsCache.has(ac.destination)) {
      error(`Cannot retrieve coordinates for airport ${ac.destination}`, {
        category: "Assignation",
        icao: ac.destination,
      });
      missingCoordsCache.add(ac.destination);
    }
    return MAX_DISTANCE;
  }
  return haversineMeters(ac.latitude, ac.longitude, destination.lat, destination.lon);
}

// One assignment envelope for every airport: what used to apply only to
// extended_icaos is now simply the default, and that list no longer scopes
// anything.
//
// These read max_alt / max_distance only, so the config repo must carry the
// wider values there - max_alt_extended, max_distance_extended and
// extended_icaos are no longer consulted at all. Until config.json is updated
// the envelope is whatever max_alt / max_distance already say, which is the
// narrow figure the non-extended airports used to get.
function maxAltitudeFt(config) {
  return config.max_alt ?? 20000; // default to 20,000 ft if not specified
}

function maxDistanceNm(config) {
  return config.max_distance ?? 100; // default to 100 nautical miles if not specified
}

function isConcernedArrival(ac, config, derived, destination) {
  if (!ac || !ac.destination || !ac.longitude || !ac.latitude) {
    return false;
  }
  if (!destination) {
    return false;
  }

  const maxAlt = maxAltitudeFt(config);
  const maxDistance = maxDistanceNm(config);

  if (ac.altitude > maxAlt) {
    return false;
  }
  ac.remainingDistance = calculateRemainingDistance(ac, destination);
  if (ac.remainingDistance * METERS_TO_NM > maxDistance) {
    // convert to nautical miles
    return false;
  }
  return true;
}

const SCHENGEN_PREFIXES = new Set([
  "LF", // France
  "LS", // Switzerland
  "ED", // Germany (civil)
  "ET", // Germany (military)
  "LO", // Austria
  "EB", // Belgium
  "EL", // Luxembourg
  "EH", // Netherlands
  "EK", // Denmark
  "ES", // Sweden
  "EN", // Norway
  "EF", // Finland
  "EE", // Estonia
  "EV", // Latvia
  "EY", // Lithuania
  "EP", // Poland
  "LK", // Czech Republic
  "LZ", // Slovakia
  "LH", // Hungary
  "LJ", // Slovenia
  "LD", // Croatia
  "LI", // Italy
  "LG", // Greece
  "LE", // Spain
  "LP", // Portugal
  "LM", // Malta
  "BI", // Iceland
  "LB", // Bulgaria
  "LR", // Romania
]);

function isSchengen(origin, destination) {
  if (!origin || !destination) return false;
  return (
    SCHENGEN_PREFIXES.has(origin.substring(0, 2).toUpperCase()) &&
    SCHENGEN_PREFIXES.has(destination.substring(0, 2).toUpperCase())
  );
}

function getAircraftWingspan(derived, aircraftType) {
  if (
    !aircraftType ||
    typeof aircraftType !== "string" ||
    aircraftType === "ZZZZ"
  )
    return 81;

  const upper = aircraftType.toUpperCase();
  const cached = derived.wingspanCache.get(upper);
  if (cached !== undefined) return cached;

  let wingspan = derived.wingspans[upper];
  if (wingspan === undefined) {
    // Check wingspan of any derivative types (atyp = XXX*) that may match
    if (upper.length >= 3) {
      wingspan = derived.wingspanByPrefix.get(upper.slice(0, 3));
    } else {
      const match = Object.keys(derived.wingspans).find((type) =>
        type.startsWith(upper)
      );
      wingspan = match ? derived.wingspans[match] : undefined;
    }
  }
  if (wingspan === undefined) {
    if (!aircraftTypeCache.has(aircraftType)) {
      warn(`Unknown wingspan for aircraft type ${aircraftType}`, {
        category: "Missing Data",
      });
      aircraftTypeCache.add(aircraftType);
    }
    wingspan = 81; // default if unknown
  }

  derived.wingspanCache.set(upper, wingspan);
  return wingspan;
}

function getAircraftCode(wingspan) {
  if (wingspan < 15.0) return "A";
  if (wingspan < 24.0) return "B";
  if (wingspan < 36.0) return "C";
  if (wingspan < 52.0) return "D";
  if (wingspan < 65.0) return "E";
  return "F"; // default to F if larger
}

const CARGO_REMARK = /cargo|freight/i;

function getAircraftUse(derived, callsign, aircraftType, remarks) {
  if (callsign.length < 3) {
    return "P"; // general aviation
  }

  if (callsign[1] === "-" || callsign[2] === "-") {
    return "P"; // general aviation
  }

  const type = aircraftType ? String(aircraftType).toUpperCase() : "";

  if (type === "A3ST") {
    return "C"; // cargo
  }

  if (remarks && CARGO_REMARK.test(remarks)) {
    return "C"; // cargo
  }

  if (derived.cargoOperators.has(callsign.substring(0, 3).toUpperCase())) {
    return "C"; // cargo
  }

  if (derived.helicopters.has(type)) {
    return "H"; // helicopter
  }

  if (derived.military.has(type)) {
    return "M"; // military
  }

  if (derived.generalAviation.has(type)) {
    return "P"; // general aviation
  }

  return "A"; // default to airliner
}

function assignStand(airport, derived, ac) {
  // Check if aircraft already has a stand assigned
  const assignedStand = registry.firstAssignedOf(ac.callsign);
  if (assignedStand) {
    if (
      registry.isOccupied(ac.destination, assignedStand.name) ||
      registry.isBlocked(ac.destination, assignedStand.name)
    ) {
      registry.removeAssigned(assignedStand);
    } else {
      const now = Date.now();
      assignedStand.timestamp = now;
      const blockedStands = registry.blockedOf(ac.callsign);
      if (blockedStands) {
        for (const stand of blockedStands) stand.timestamp = now;
      }
      checkPendingHoppieNotification(ac, derived.config);
      return;
    }
  }

  const aircraftType = ac.flight_plan.aircraft_short;
  const schengen = isSchengen(ac.origin, ac.destination);
  const wingspan = getAircraftWingspan(derived, aircraftType);
  const code = getAircraftCode(wingspan);
  const use = getAircraftUse(
    derived,
    ac.callsign,
    aircraftType,
    ac.flight_plan.remarks
  );
  const originPrefix = ac.origin ? ac.origin.substring(0, 2).toUpperCase() : "";
  const callsign = ac.callsign.toUpperCase();
  const compagnyPrefix = callsign.substring(0, 3);

  // Logged once per callsign: with a wide assignment radius this line would
  // otherwise repeat every cycle for every aircraft that cannot be placed.
  if (!searchLoggedCache.has(ac.callsign)) {
    searchLoggedCache.add(ac.callsign);
    info(
      `Searching stand for ${ac.callsign} at ${ac.destination} (Use: ${use}, Code: ${code}, Schengen: ${schengen}, Compagny: ${compagnyPrefix}, Origin Country: ${originPrefix}, Wingspan: ${wingspan}m, AircraftType: ${aircraftType})`,
      { category: "Assignation", callsign: ac.callsign, icao: airport.icao }
    );
  }

  const available = availableScratch;
  available.length = 0;

  const stands = airport.stands;
  let anyPriority = false;
  let lowestPriority = MAX_DISTANCE;

  for (let i = 0; i < stands.length; i++) {
    const stand = stands[i];

    // Implements checks
    if (stand.use && stand.use.includes(use) === false) continue;
    if (stand.code && stand.code.includes(code) === false) continue;
    if (stand.schengen !== undefined && stand.schengen !== schengen) continue;
    if (stand.wingspan && stand.wingspan < wingspan) continue;
    if (stand.countries && !stand.countries.has(originPrefix)) continue;
    if (stand.callsigns && !stand.matchesCallsign(callsign)) continue;

    if (!stand.hasApron) {
      if (registry.isOccupied(ac.destination, stand.name)) continue;
      if (registry.isAssigned(ac.destination, stand.name)) continue;
      if (registry.isBlocked(ac.destination, stand.name)) continue;
    } else if (
      registry.getApronOccupancyLevel(stand.name, airport.icao) >= stand.apronSize
    ) {
      continue; // Apron is full
    }

    if (stand.priority) {
      anyPriority = true;
      if (stand.priority < lowestPriority) lowestPriority = stand.priority;
    }
    available.push(stand);
  }

  // Priority filtering
  let count = available.length;
  if (anyPriority) {
    let kept = 0;
    for (let i = 0; i < count; i++) {
      if (available[i].priority !== lowestPriority) continue;
      available[kept++] = available[i];
    }
    available.length = count = kept;
  }

  if (count === 0) {
    if (!noStandFoundCache.has(ac.callsign)) {
      warn(`No available stands found for ${ac.callsign} at ${ac.destination}`, {
        category: "Assignation",
        callsign: ac.callsign,
        icao: airport.icao,
      });
      noStandFoundCache.add(ac.callsign);
    }
    return;
  }

  // Prefer the tightest-fitting stand: the lowest "highest code letter" on
  // offer, picked at random among equals. Anything at or above code F is no
  // better than an arbitrary pick, which is what the shuffle used to give.
  let bestMaxCode = "F";
  let hasBetter = false;
  for (let i = 0; i < count; i++) {
    const maxCode = available[i].maxCode;
    if (maxCode !== null && maxCode < bestMaxCode) {
      bestMaxCode = maxCode;
      hasBetter = true;
    }
  }

  let selected;
  if (hasBetter) {
    let ties = 0;
    for (let i = 0; i < count; i++) {
      if (available[i].maxCode === bestMaxCode) ties++;
    }
    let pick = (Math.random() * ties) | 0;
    for (let i = 0; i < count; i++) {
      if (available[i].maxCode !== bestMaxCode) continue;
      if (pick-- === 0) {
        selected = available[i];
        break;
      }
    }
  } else {
    selected = available[(Math.random() * count) | 0];
  }

  const stand = new Stand(
    selected.name,
    airport.icao,
    ac.callsign,
    "",
    selected.apronSize
  );
  info(`Assigning Stand ${selected.name} to ${ac.callsign}`, {
    category: "Assignation",
    callsign: ac.callsign,
    icao: airport.icao,
  });
  registry.addAssigned(stand);
  blockStands(selected, ac.destination, ac.callsign);
  noStandFoundCache.delete(ac.callsign);

  // Only the automatic engine path notifies; manual assignment via /api/assign
  // deliberately does not. Fires at most once per session however many times the
  // assigned stand later changes.
  registerHoppieEligibility(ac.callsign, selected.def, airport.raw);
  if (
    typeof ac.altitude === "number" &&
    ac.altitude >= hoppieMinAltitudeFt(derived.config)
  ) {
    const state = notificationState.get(ac.callsign);
    if (state && state.status === "pending") {
      sendTelexNotification(ac.callsign, state);
    }
  }
}

/**
 * Resolves the remark configured for an aircraft code on a stand.
 * Remark keys are code lists, e.g. { "CD": "...", "EF": "..." }.
 */
function resolveRemark(standDef, aircraftCode) {
  if (!standDef.Remark || typeof standDef.Remark !== "object") return "";
  for (const [codeList, remarkText] of Object.entries(standDef.Remark)) {
    if (codeList.includes(aircraftCode)) return remarkText;
  }
  return "";
}

const processDatafeed = async (aircrafts) => {
  // get config.json for parameters
  const config = await airportService.getConfig();
  if (!config) {
    error("No config found, skipping assignment", { category: "Missing Data" });
    return;
  }

  let icaoList = [];
  try {
    const al = airportService.getAirportList();
    if (Array.isArray(al)) icaoList = al;
  } catch (e) {
    error(`Error loading airport list: ${e.message}`, {
      category: "Missing Data",
    });
  }

  // Compile every airport up front. Once warm this is a no-op, and it is what
  // lets the rest of the cycle run without awaiting per aircraft.
  const compiledAirports = await airportIndex.preload(icaoList);
  const airportByIcao = airportIndex.byIcao();
  const derived = airportIndex.deriveConfig(config);

  // Handle onGround aircraft
  for (const ac of Object.values(aircrafts.onGround || {})) {
    const previouslyOnStand = registry.firstOccupiedOf(ac.callsign);
    if (previouslyOnStand) {
      registry.removeOccupied(previouslyOnStand);

      // Unblock any stands that were blocked due to this stand
      registry.removeAllBlockedOf(ac.callsign);
    }

    const standName = findAircraftStand(derived, ac, compiledAirports);
    if (!standName) continue;

    ac.stand = standName;
    const airport = airportByIcao.get(ac.origin);

    // remove any existing occupied / blocked / assigned stands for this callsign
    registry.removeAllOccupiedOf(ac.callsign);
    registry.removeAllBlockedOf(ac.callsign);
    registry.removeAllAssignedOf(ac.callsign);

    const stand = airport && airport.standsByName.get(standName);
    if (!stand) {
      warn(
        `Stand definition for stand ${standName} not found at airport ${ac.origin}, skipping occupancy`,
        { category: "Assignation", callsign: ac.callsign, icao: ac.origin }
      );
      continue;
    }

    let aircraftCode = "UNKNOWN";
    const aircraftType = ac.flight_plan && ac.flight_plan.aircraft_short;
    if (aircraftType && aircraftType !== "UNKNOWN") {
      aircraftCode = getAircraftCode(getAircraftWingspan(derived, aircraftType));
    }

    registry.addOccupied(
      new Stand(
        standName,
        ac.origin || "UNKNOWN",
        ac.callsign,
        resolveRemark(stand.def, aircraftCode),
        stand.apronSize
      )
    );
    blockStands(stand, ac.origin, ac.callsign);
  }

  // Handle airborne aircraft - (ie: assign stand if criterias met)
  for (const ac of Object.values(aircrafts.airborne || {})) {
    if (!ac.flight_plan) {
      continue;
    }
    ac.origin = ac.flight_plan.departure;
    ac.destination = ac.flight_plan.arrival;

    const destination = airportByIcao.get(ac.destination);

    // Check Assignement conditions
    if (!isConcernedArrival(ac, config, derived, destination)) {
      continue;
    }

    if (destination.stands.length === 0) {
      warn(
        `No stands found for airport ${ac.destination}, skipping assignment`,
        { category: "Assignation", callsign: ac.callsign, icao: ac.destination }
      );
      continue;
    }

    assignStand(destination, derived, ac);
  }

  // Every callsign this cycle carried, whether or not it was assignable - a
  // pilot still connected is still in session even when nothing was done for
  // them this pass.
  const seen = new Set();
  for (const ac of Object.values(aircrafts.onGround || {})) seen.add(ac.callsign);
  for (const ac of Object.values(aircrafts.airborne || {})) seen.add(ac.callsign);
  expireNotificationsNotSeen(seen);
};

async function assignStandToPilot(standName, icao, callsign, client) {
  // Remove any existing assignment
  registry.removeAllAssignedOf(callsign);
  registry.removeAllBlockedOf(callsign);
  searchLoggedCache.delete(callsign);

  if (standName === "None") {
    info(`Removed stand assignment for ${callsign}, Requester: ${client}`, {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao,
    });
    return {
      action: "free",
      stand: standName,
      callsign: callsign,
      icao: icao,
      message: `Asssigned Stand has been freed from ${callsign}`,
    };
  }

  const airport = await airportIndex.get(icao);
  const stand = airport && airport.standsByName.get(standName);

  if (!stand) {
    warn(`Stand ${standName} not found at ${icao}, Requester: ${client}`, {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao,
    });
    return {
      action: "not_found",
      stand: standName,
      callsign: callsign,
      icao: icao,
      message: `Stand ${standName} does not exist at ${icao}`,
    };
  }

  if (registry.isOccupied(icao, standName)) {
    warn(
      `Cannot assign stand ${standName} at ${icao} to ${callsign} - already occupied, Requester: ${client}`,
      { category: "Manual Assign", callsign: callsign, icao: icao }
    );
    return {
      action: "occupied",
      stand: standName,
      callsign: callsign,
      icao: icao,
      message: `Stand ${standName} could not be assigned to ${callsign} as it is already occupied`,
    };
  }
  if (registry.isAssigned(icao, standName)) {
    warn(
      `Cannot assign stand ${standName} at ${icao} to ${callsign} - already assigned, Requester: ${client}`,
      { category: "Manual Assign", callsign: callsign, icao: icao }
    );
    return {
      action: "assigned",
      stand: standName,
      callsign: callsign,
      icao: icao,
      message: `Stand ${standName} could not be assigned to ${callsign} as it is already assigned`,
    };
  }
  if (registry.isBlocked(icao, standName)) {
    // If stand is blocked by the same callsign, allow assignment
    const blocking = registry.getBlocked(icao, standName);
    if (blocking && blocking.callsign === callsign) {
      registry.removeBlocked(blocking);
    } else {
      warn(
        `Cannot assign stand ${standName} at ${icao} to ${callsign} - already blocked, Requester: ${client}`,
        { category: "Manual Assign", callsign: callsign, icao: icao }
      );
      return {
        action: "blocked",
        stand: standName,
        callsign: callsign,
        icao: icao,
        message: `Stand ${standName} could not be assigned to ${callsign} as it is blocked`,
      };
    }
  }

  registry.addAssigned(
    new Stand(standName, icao, callsign, "", stand.apronSize)
  );
  // Block stands
  blockStands(stand, icao, callsign);
  info(
    `Manually assigned stand ${standName} at ${icao} to ${callsign}, Requester: ${client}`,
    {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao,
    }
  );

  return {
    action: "assign",
    stand: standName,
    callsign: callsign,
    icao: icao,
    message: `Stand ${standName} successfully assigned to ${callsign} at ${icao}`,
  };
}

function standCleanup() {
  // Remove occupied stands if timestamp is older than 2 minutes without update
  const now = Date.now();
  registry.clearExpired((stand) => now - stand.timestamp > 2 * 60 * 1000);

  // Notification tracking is not expired here: holding no stands does not mean
  // the session is over. See expireNotificationsNotSeen, driven by the datafeed.
}

setInterval(standCleanup, 60 * 1000); // every minute

// Export everything together
module.exports = {
  Stand,
  registry,
  processDatafeed,
  assignStandToPilot,
  maxAltitudeFt,
  maxDistanceNm,
  getAllOccupied: () => registry.getAllOccupied(),
  getAllAssigned: () => registry.getAllAssigned(),
  getAllBlocked: () => registry.getAllBlocked(),
  isOccupied: (icao, name) => registry.isOccupied(icao, name),
  isAssigned: (icao, name) => registry.isAssigned(icao, name),
  isBlocked: (icao, name) => registry.isBlocked(icao, name),
};
