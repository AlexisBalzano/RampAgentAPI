const { info, warn, error } = require("../utils/logger");
const airportService = require("./airportService");
const airportIndex = require("./airportIndex");
const redisService = require("./redisService");
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
}, 60 * 60 * 1000).unref(); // Clear every hour. unref: housekeeping must not keep a process alive

const MAX_DISTANCE = Number.MAX_SAFE_INTEGER;
const METERS_TO_NM = 0.00053996;

class Stand {
  // `movement` is "departure" or "arrival" for an aircraft physically on the
  // stand, taken from its flight plan - occupancy alone cannot tell the two
  // apart, and a per-airport board wants them in separate columns. Null when
  // unknown, and unused for assigned and blocked stands.
  constructor(name, icao, callsign, remark = "", apronSize = 0, movement = null) {
    this.name = name;
    this.icao = icao;
    this.callsign = callsign;
    this.remark = remark;
    this.apronSize = apronSize;
    this.movement = movement;
    this.timestamp = Date.now();

    // Identity fields never change after construction, so both keys are built
    // once here rather than on every registry lookup.
    this.slot = `${icao}:${name}`;
    this._key = apronSize > 0 ? `${this.slot}:${callsign}` : this.slot;

    // Assigned stands only. status is "provisional" (another aircraft with an
    // earlier ETA may still take it) or "firm" (never taken); null otherwise.
    // eta is in minutes. telexStale means the pilot was sent a TELEX naming
    // something other than this stand and no correction could be sent.
    this.status = null;
    this.eta = null;
    this.manual = false;
    this.telexStale = false;
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
      status: this.status,
      eta: this.eta,
      telexStale: this.telexStale,
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

  /** Marks a change made in place on a held Stand, so cached payloads rebuild. */
  touch() {
    this.version++;
  }

  /** The stand assigned on a non-apron slot, or undefined. */
  assignedAt(icao, name) {
    return this.assigned.get(`${icao}:${name}`);
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
//
// Process-local, so a restart used to wipe it: the registry came back empty,
// every inbound aircraft was assigned a stand again, and nothing remembered its
// pilot had already been told the gate. 'sent' entries are therefore mirrored
// into Redis and read back before the first datafeed cycle - see
// loadPersistedNotifications - so the repeat is prevented instead of sent.
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
  const hoppie = airportConfig.Hoppie;
  return {
    terminal: standDef.Terminal,
    briefingUrl: hoppie.BriefingUrl || "",
    messageTemplate: hoppie.MessageTemplate,
    info: standDef.Info || "",
    maxMessages: hoppieMaxMessages(hoppie),
  };
}

// Hard cap on TELEX messages per callsign per session: the first message plus
// at most MaxMessages - 1 corrections. 1 turns corrections off.
const HOPPIE_DEFAULT_MAX_MESSAGES = 2;

function hoppieMaxMessages(hoppie) {
  const configured = hoppie && hoppie.MaxMessages;
  return Number.isInteger(configured) && configured >= 1
    ? configured
    : HOPPIE_DEFAULT_MAX_MESSAGES;
}

// No correction once the aircraft is this close: the pilot is busy with the
// approach and ground gives the stand by voice anyway.
const HOPPIE_DEFAULT_CORRECTION_CUTOFF_MINUTES = 15;

function hoppieCorrectionCutoffMinutes(hoppie) {
  const configured = hoppie && hoppie.CorrectionCutoffMinutes;
  return typeof configured === "number" && configured >= 0
    ? configured
    : HOPPIE_DEFAULT_CORRECTION_CUTOFF_MINUTES;
}

// A correction is only sent once the new stand has held this long, so a burst
// of changes (a wave of pilots connecting onto stands) costs one message.
const CORRECTION_SETTLE_MS = 2 * 60 * 1000;

/** The message a stand would produce for this airport, or null if it produces none. */
function renderTelexFor(standDef, airportConfig) {
  const eligibility = getHoppieEligibility(standDef, airportConfig);
  if (!eligibility) return null;
  return buildTelexMessage(
    eligibility.messageTemplate,
    eligibility.terminal,
    eligibility.briefingUrl,
    eligibility.info
  );
}

function correctionText(hoppie, message) {
  const template =
    hoppie && typeof hoppie.CorrectionTemplate === "string" && hoppie.CorrectionTemplate
      ? hoppie.CorrectionTemplate
      : "REVISED {message}";
  return template.replace(/{message}/g, message);
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

    if (state.inFlight) return;
    state.inFlight = true;
    let outcome;
    try {
      if (!(await reserveTelexSlot(callsign, state))) {
        state.status = "capped";
        warn(`Telex for ${callsign} not sent - message cap reached`, {
          category: "Telex",
          callsign,
        });
        return;
      }
      outcome = await postTelex(callsign, message);
      if (outcome !== "sent") await releaseTelexSlot(callsign, state);
    } finally {
      state.inFlight = false;
    }

    if (outcome === "sent") {
      state.status = "sent";
      state.sentMessage = message;
      // Written straight after the POST, so the window in which a restart could
      // lose the fact that this pilot has been notified is as small as it gets.
      state.telexRecord = {
        terminal: state.terminal,
        stand: state.standName || "",
        message,
        count: state.sentCount,
        sentAt: new Date().toISOString(),
      };
      await persistNotification(callsign, state);
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

// Takes one of the callsign's TELEX slots, or returns false when the cap is
// reached. Every send goes through here, so nothing upstream - a bug, a restart,
// a storm of stand changes - can take a pilot past Hoppie.MaxMessages. The
// in-process count covers Redis being down; the Redis count covers a restart.
async function reserveTelexSlot(callsign, state) {
  const max = state.maxMessages || HOPPIE_DEFAULT_MAX_MESSAGES;
  if ((state.sentCount || 0) >= max) return false;

  const shared = await redisService.incrTelexCount(callsign);
  if (shared !== null && shared > max) {
    await redisService.decrTelexCount(callsign);
    state.sentCount = max;
    return false;
  }
  state.sentCount = Math.max((state.sentCount || 0) + 1, shared || 0);
  return true;
}

async function releaseTelexSlot(callsign, state) {
  state.sentCount = Math.max(0, (state.sentCount || 0) - 1);
  await redisService.decrTelexCount(callsign);
}

// Sends one correction naming the aircraft's new stand. Same rules as the first
// message: capped, validated, and recorded so a restart does not resend it.
async function sendTelexCorrection(callsign, state, message, hoppie) {
  if (state.inFlight) return;
  const standName = state.correction ? state.correction.standName : "";
  const text = correctionText(hoppie, message);
  const reason = telexRejectionReason(callsign, text);
  if (reason) {
    state.correction = null;
    state.correctionBlocked = true;
    error(`Telex correction for ${callsign} not sent - ${reason}`, {
      category: "Telex",
      callsign,
    });
    return;
  }

  state.inFlight = true;
  let outcome;
  try {
    if (!(await reserveTelexSlot(callsign, state))) {
      state.correction = null;
      state.correctionBlocked = true;
      info(`Telex correction for ${callsign} not sent - message cap reached`, {
        category: "Telex",
        callsign,
      });
      return;
    }
    outcome = await postTelex(callsign, text);
    if (outcome !== "sent") await releaseTelexSlot(callsign, state);
  } finally {
    state.inFlight = false;
  }

  if (outcome === "sent") {
    state.sentMessage = message;
    state.standName = standName;
    state.correction = null;
    state.telexRecord = {
      ...(state.telexRecord || {}),
      stand: standName,
      message,
      count: state.sentCount,
      correctedAt: new Date().toISOString(),
    };
    const held = registry.firstAssignedOf(callsign);
    if (held && held.name === standName) setTelexStale(held, false);
    await persistNotification(callsign, state);
    info(`Telex correction sent to ${callsign} (stand ${standName})`, {
      category: "Telex",
      callsign,
    });
  } else if (outcome === "rejected") {
    state.correction = null;
    state.correctionBlocked = true;
  }
  // "failed" keeps the correction pending for a later cycle
}

// Registers a callsign as eligible for a Hoppie notification the first time it's automatically
// assigned a Terminal-bearing stand.
function registerHoppieEligibility(callsign, standDef, airportConfig, standName) {
  if (notificationState.has(callsign)) return; // already tracked this session
  const eligibility = getHoppieEligibility(standDef, airportConfig);
  if (!eligibility) return;

  notificationState.set(callsign, {
    status: "pending",
    terminal: eligibility.terminal,
    briefingUrl: eligibility.briefingUrl,
    messageTemplate: eligibility.messageTemplate,
    info: eligibility.info || "",
    maxMessages: eligibility.maxMessages,
    standName: standName || "",
    sentCount: 0,
    ticksSinceCheck: 0,
    missedCycles: 0,
    persistedAt: 0,
  });
}

// Provisional mode: the message must describe the stand the aircraft holds when
// it is sent, so a not-yet-sent record follows the firm stand around instead of
// staying pinned to whichever stand registered it first. A record for a stand
// that no longer produces a message is dropped.
function syncPendingEligibility(callsign, standDef, airportConfig, standName) {
  const state = notificationState.get(callsign);
  if (!state) {
    registerHoppieEligibility(callsign, standDef, airportConfig, standName);
    return;
  }
  if (state.status !== "pending") return;

  const eligibility = getHoppieEligibility(standDef, airportConfig);
  if (!eligibility) {
    notificationState.delete(callsign);
    return;
  }
  state.terminal = eligibility.terminal;
  state.briefingUrl = eligibility.briefingUrl;
  state.messageTemplate = eligibility.messageTemplate;
  state.info = eligibility.info || "";
  state.maxMessages = eligibility.maxMessages;
  state.standName = standName || "";
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

// The Redis record expires an hour after it was last written, and that hour is
// meant to run from the end of the session rather than from the send - a pilot
// who lands, parks and stays connected is still in session. Rewriting it at
// half the TTL keeps it alive for one command per callsign per half hour,
// instead of one per callsign per cycle.
const NOTIFICATION_REFRESH_INTERVAL_MS =
  (redisService.telexNotifiedTtlSeconds * 1000) / 2;

// Writes the whole record rather than only pushing its expiry back, so the same
// call also heals one that never landed - Redis unreachable at send time - or
// that has since gone missing. Never rejects: the write reports failure by
// returning false.
async function persistNotification(callsign, state) {
  state.persistedAt = Date.now(); // optimistic, so a slow write is not repeated
  const written = await redisService.setTelexNotified(callsign, state.telexRecord);
  if (!written) state.persistedAt = 0; // retry on the next cycle it is seen
}

function expireNotificationsNotSeen(seenCallsigns) {
  const now = Date.now();

  for (const [callsign, state] of notificationState) {
    if (seenCallsigns.has(callsign)) {
      state.missedCycles = 0;
      if (
        state.status === "sent" &&
        now - state.persistedAt >= NOTIFICATION_REFRESH_INTERVAL_MS
      ) {
        persistNotification(callsign, state);
      }
      continue;
    }
    state.missedCycles += 1;
    if (state.missedCycles < NOTIFICATION_ABSENT_CYCLES) continue;

    const stillHoldsStands =
      registry.occupiedByCallsign.has(callsign) ||
      registry.assignedByCallsign.has(callsign) ||
      registry.blockedByCallsign.has(callsign);
    if (!stillHoldsStands) {
      notificationState.delete(callsign);
      // Redis mirrors the Map, so the session ending has to clear both -
      // otherwise the record outlives the session and blocks the notification a
      // genuinely new one is owed.
      redisService.clearTelexNotified(callsign);
    }
  }
}

/**
 * Restores the 'sent' records from Redis into the in-process Map.
 *
 * Must complete before the first datafeed cycle, or the restart it exists to
 * cover re-notifies in that cycle. Only 'sent' is persisted, so everything read
 * back is 'sent': both registerHoppieEligibility and
 * checkPendingHoppieNotification bail out on a record in that state, which is
 * what turns the resend into a no-op. The eligibility fields go unread for such
 * a record, but the shape is kept whole so nothing downstream has to special-
 * case a restored one.
 *
 * From here the records live and die exactly like any other: absence from the
 * datafeed for NOTIFICATION_ABSENT_CYCLES ends the session and clears both
 * copies, so a restart does not leave anything pinned.
 */
async function loadPersistedNotifications() {
  if (!redisService.isConnected) {
    warn(
      "Redis unavailable, Telex notification records not restored - a callsign " +
        "notified before this restart may be notified again",
      { category: "Telex" }
    );
    return 0;
  }

  const records = await redisService.getAllTelexNotified();
  const now = Date.now();
  let restored = 0;

  for (const { callsign, record } of records) {
    if (notificationState.has(callsign)) continue;
    const restoredRecord = record && typeof record === "object" ? record : {};
    notificationState.set(callsign, {
      status: "sent",
      terminal: restoredRecord.terminal || "",
      briefingUrl: "",
      messageTemplate: "",
      info: "",
      // Records written before these fields existed carry none of them: no
      // message means corrections are never attempted for that session, and a
      // missing count is taken as the one message the record proves was sent.
      standName: restoredRecord.stand || "",
      sentMessage: restoredRecord.message,
      sentCount: Number.isInteger(restoredRecord.count) ? restoredRecord.count : 1,
      maxMessages: HOPPIE_DEFAULT_MAX_MESSAGES,
      ticksSinceCheck: 0,
      missedCycles: 0,
      persistedAt: now,
      telexRecord: restoredRecord,
    });
    restored++;
  }

  info(`Restored ${restored} Telex notification record(s) from Redis`, {
    category: "Telex",
  });
  return restored;
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

// Below this ground speed an aircraft is on the ground (parked, pushing back,
// taxiing), not flying towards us.
function minAirborneGroundSpeedKt(config) {
  return config.min_airborne_gs ?? 50;
}

// ...unless it is this close to the destination: then it is taxiing in here.
function groundNearDestinationNm(config) {
  return config.ground_near_destination_nm ?? 20;
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
  const remainingNm = ac.remainingDistance * METERS_TO_NM;
  if (remainingNm > maxDistance) {
    return false;
  }
  // Still on the ground at its origin: a departure from a nearby airport (LFLL
  // is 165 nm from LFMN) would otherwise hold a stand here from the gate on,
  // with an ETA of days at taxi speed. It is picked up once airborne.
  if (
    typeof ac.groundspeed === "number" &&
    ac.groundspeed < minAirborneGroundSpeedKt(config) &&
    remainingNm > groundNearDestinationNm(config)
  ) {
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

// Assumed for a type with no wingspan data: the largest, so an unknown type is
// only ever given a stand that fits anything.
const UNKNOWN_WINGSPAN = 81;

/** The wingspan known for a type, or undefined. No logging; unknowns are not cached. */
function resolveWingspan(derived, aircraftType) {
  if (!aircraftType || typeof aircraftType !== "string" || aircraftType === "ZZZZ") {
    return undefined;
  }

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
  if (wingspan !== undefined) derived.wingspanCache.set(upper, wingspan);
  return wingspan;
}

function getAircraftWingspan(derived, aircraftType) {
  const wingspan = resolveWingspan(derived, aircraftType);
  if (wingspan !== undefined) return wingspan;

  if (aircraftType && typeof aircraftType === "string" && aircraftType !== "ZZZZ") {
    if (!aircraftTypeCache.has(aircraftType)) {
      warn(`Unknown wingspan for aircraft type ${aircraftType}`, {
        category: "Missing Data",
      });
      aircraftTypeCache.add(aircraftType);
    }
  }
  return UNKNOWN_WINGSPAN; // default if unknown
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

/** What the stand filters need to know about an aircraft, computed once per search. */
function aircraftProfile(derived, ac) {
  // Called for the warning it logs on an unknown type; the profile itself is
  // built from plain fields, so the stand finder computes exactly the same one.
  getAircraftWingspan(derived, ac.flight_plan.aircraft_short);
  return buildProfile(derived, {
    callsign: ac.callsign,
    aircraftType: ac.flight_plan.aircraft_short,
    origin: ac.origin,
    destination: ac.destination,
    remarks: ac.flight_plan.remarks,
  });
}

/**
 * Aircraft profile from plain fields - no datafeed object, no logging, no
 * cache writes. Shared by the engine (through aircraftProfile) and the
 * stand finder (through evaluateStand).
 */
function buildProfile(derived, { callsign, aircraftType, origin, destination, remarks }) {
  const known = resolveWingspan(derived, aircraftType);
  const wingspan = known === undefined ? UNKNOWN_WINGSPAN : known;
  const upper = String(callsign || "").toUpperCase();
  return {
    aircraftType,
    typeKnown: known !== undefined,
    schengen: isSchengen(origin, destination),
    wingspan,
    code: getAircraftCode(wingspan),
    use: getAircraftUse(derived, callsign, aircraftType, remarks),
    originPrefix: origin ? origin.substring(0, 2).toUpperCase() : "",
    callsign: upper,
    compagnyPrefix: upper.substring(0, 3),
  };
}

/**
 * Whether a stand is free for `callsign` right now. Stands the same callsign
 * already holds or blocks count as free: they are its own.
 */
function standAvailableFor(icao, stand, callsign) {
  if (stand.hasApron) {
    return registry.getApronOccupancyLevel(stand.name, icao) < stand.apronSize;
  }
  if (registry.isOccupied(icao, stand.name)) return false;
  const holder = registry.assignedAt(icao, stand.name);
  if (holder && holder.callsign !== callsign) return false;
  const blocking = registry.getBlocked(icao, stand.name);
  if (blocking && blocking.callsign !== callsign) return false;
  // Taking this stand would block its neighbours: never one booked by someone
  // else, which would knock that booking off its stand.
  if (stand.block) {
    for (let i = 0; i < stand.block.length; i++) {
      const neighbour = registry.assignedAt(icao, stand.block[i]);
      if (neighbour && neighbour.status === "booked" && neighbour.callsign !== callsign) return false;
    }
  }
  return true;
}

/**
 * Whether one named stand would take this aircraft right now: `fits` (its
 * restrictions admit the profile) and `available` (free for this callsign).
 * Same input as evaluateStand. Used to check a stand a pilot picked, which
 * need not be the engine's first choice.
 */
function checkStandFor(airport, derived, input, standName) {
  const { profile } = evaluateStand(airport, derived, input);
  const stand = airport.standsByName.get(standName);
  if (!stand) return { profile, fits: false, available: false };
  return {
    profile,
    fits: standFits(stand, profile),
    available: standAvailableFor(airport.icao, stand, profile.callsign),
  };
}

/**
 * Which stands `profile` could be given right now, without assigning anything.
 *
 * Returns { fitCount, candidates, free }: how many stands admit the profile at
 * all, the free ones among them at the best Priority tier - the set greedy
 * assignment picks from with pickTightest - and every free one at any tier,
 * which the stand finder lists as fallbacks (the engine ignores it). Pure:
 * reads the registry, writes nothing, logs nothing.
 */
function evaluateProfile(airport, profile) {
  const icao = airport.icao;
  const stands = airport.stands;
  let fitCount = 0;
  let bestTier = MAX_DISTANCE + 1;
  const free = [];

  for (let i = 0; i < stands.length; i++) {
    const stand = stands[i];
    if (!standFits(stand, profile)) continue;
    fitCount++;
    if (!standAvailableFor(icao, stand, profile.callsign)) continue;
    const tier = tierOf(stand);
    if (tier < bestTier) bestTier = tier;
    free.push(stand);
  }

  const candidates = [];
  for (const stand of free) if (tierOf(stand) === bestTier) candidates.push(stand);
  return { fitCount, candidates, free };
}

/**
 * Free fitting stands in preference order: best Priority tier first, and
 * within a tier the order pickTightest prefers. What a pilot should try next
 * when the suggested stand is not wanted or gets taken.
 */
function orderByPreference(stands) {
  const byTier = new Map();
  for (const stand of stands) {
    const tier = tierOf(stand);
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(stand);
  }
  return [...byTier.keys()]
    .sort((a, b) => a - b)
    .flatMap((tier) => orderByTightness(byTier.get(tier)));
}

/**
 * Dry run of the assignment engine for the stand finder: which stand would an
 * aircraft be given if it arrived now - or, for a departure, which free stand
 * it should start from. `input` is plain fields
 * ({ callsign, aircraftType, direction, otherAirport, remarks }); `airport`
 * is this end of the flight. `origin` alone is still read as an arrival.
 * Free of request and auth concerns, so stand booking can reuse it.
 *
 * A departure uses the same fit rules: Schengen is decided by both ends, and a
 * stand restricted to certain countries is matched against the airport at the
 * other end (the destination), as an arrival matches its origin.
 *
 * In provisional mode this is deliberately more conservative than the engine.
 * A suggestion has no ETA, so it cannot take a provisional stand from a
 * later-arriving aircraft the way assignStandProvisional can: every stand held
 * by another callsign, firm or provisional, counts as unavailable here.
 */
function evaluateStand(airport, derived, input) {
  const departure = input.direction === "departure";
  const other = input.otherAirport ?? input.origin ?? "";
  const profile = buildProfile(derived, {
    ...input,
    origin: departure ? airport.icao : other,
    destination: departure ? other : airport.icao,
  });
  if (departure) profile.originPrefix = other.substring(0, 2).toUpperCase();
  return { profile, ...evaluateProfile(airport, profile) };
}

/** Stands in the order pickTightest prefers them: tightest code first, config order within. */
function orderByTightness(stands) {
  const key = (stand) =>
    stand.maxCode !== null && stand.maxCode < "F" ? stand.maxCode : "F";
  return stands
    .map((stand, index) => ({ stand, index }))
    .sort((a, b) => {
      const ka = key(a.stand);
      const kb = key(b.stand);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.stand);
}

/** Whether a stand's configured restrictions admit this aircraft. */
function standFits(stand, p) {
  if (stand.use && stand.use.includes(p.use) === false) return false;
  if (stand.code && stand.code.includes(p.code) === false) return false;
  if (stand.schengen !== undefined && stand.schengen !== p.schengen) return false;
  if (stand.wingspan && stand.wingspan < p.wingspan) return false;
  if (stand.countries && !stand.countries.has(p.originPrefix)) return false;
  if (stand.callsigns && !stand.matchesCallsign(p.callsign)) return false;
  return true;
}

function logSearchOnce(ac, airport, p) {
  // Logged once per callsign: with a wide assignment radius this line would
  // otherwise repeat every cycle for every aircraft that cannot be placed.
  if (searchLoggedCache.has(ac.callsign)) return;
  searchLoggedCache.add(ac.callsign);
  info(
    `Searching stand for ${ac.callsign} at ${ac.destination} (Use: ${p.use}, Code: ${p.code}, Schengen: ${p.schengen}, Compagny: ${p.compagnyPrefix}, Origin Country: ${p.originPrefix}, Wingspan: ${p.wingspan}m, AircraftType: ${p.aircraftType})`,
    { category: "Assignation", callsign: ac.callsign, icao: airport.icao }
  );
}

function assignStand(airport, derived, ac) {
  if (airport.assignment && airport.assignment.provisional) {
    assignStandProvisional(airport, derived, ac, airport.assignment);
    return;
  }

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

  const profile = aircraftProfile(derived, ac);
  logSearchOnce(ac, airport, profile);

  // The same evaluation the stand finder runs (evaluateStand), so a suggestion
  // and the real assignment cannot drift apart.
  const { candidates } = evaluateProfile(airport, profile);
  if (candidates.length === 0) {
    warnNoStandOnce(ac, airport);
    return;
  }

  const selected = pickTightest(candidates);

  const stand = new Stand(
    selected.name,
    airport.icao,
    ac.callsign,
    "",
    selected.apronSize
  );
  stand.status = "firm"; // greedy mode never takes a stand back
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
  registerHoppieEligibility(ac.callsign, selected.def, airport.raw, selected.name);
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

function warnNoStandOnce(ac, airport) {
  if (noStandFoundCache.has(ac.callsign)) return;
  warn(`No available stands found for ${ac.callsign} at ${ac.destination}`, {
    category: "Assignation",
    callsign: ac.callsign,
    icao: airport.icao,
  });
  noStandFoundCache.add(ac.callsign);
}

// Prefer the tightest-fitting stand: the lowest "highest code letter" on
// offer, picked at random among equals. Anything at or above code F is no
// better than an arbitrary pick, which is what the shuffle used to give.
// `standOf` maps a list item to its compiled stand, for lists of wrappers.
function pickTightest(list, standOf = (item) => item) {
  const count = list.length;
  let bestMaxCode = "F";
  let hasBetter = false;
  for (let i = 0; i < count; i++) {
    const maxCode = standOf(list[i]).maxCode;
    if (maxCode !== null && maxCode < bestMaxCode) {
      bestMaxCode = maxCode;
      hasBetter = true;
    }
  }

  if (!hasBetter) return list[(Math.random() * count) | 0];

  let ties = 0;
  for (let i = 0; i < count; i++) {
    if (standOf(list[i]).maxCode === bestMaxCode) ties++;
  }
  let pick = (Math.random() * ties) | 0;
  for (let i = 0; i < count; i++) {
    if (standOf(list[i]).maxCode !== bestMaxCode) continue;
    if (pick-- === 0) return list[i];
  }
  return undefined;
}

/*
 * Provisional mode
 * ================
 *
 * Greedy mode hands stands out in the order aircraft are first seen, so with a
 * wide radius a long-haul seen an hour out takes the best stand ahead of a short
 * hop that lands first. In provisional mode an assignment stays "provisional"
 * until the holder's ETA drops under FreezeMinutes, and until then an aircraft
 * arriving at least PreemptMarginMinutes earlier may take it if it is a strictly
 * better tier (Priority) than anything free. The displaced aircraft is searched
 * again in the same cycle - aircraft are processed in ETA order, so it is always
 * still to come.
 *
 * At the freeze the stand becomes "firm": it is never taken again, and that is
 * when the TELEX goes out, so the message (which may name the gate) describes a
 * stand that will hold. A firm stand can still be lost to an aircraft parking on
 * it; the pilot then gets at most Hoppie.MaxMessages - 1 corrections, each only
 * after the new stand has held for CORRECTION_SETTLE_MS, never inside
 * CorrectionCutoffMinutes of arrival, and only when the text actually differs.
 */

/** Lower is better; a stand with no Priority ranks after every stand that has one. */
function tierOf(compiledStand) {
  return compiledStand.priority > 0 ? compiledStand.priority : MAX_DISTANCE;
}

/** Minutes to destination at the current ground speed, or null when unknown. */
function etaMinutes(ac) {
  const gs = ac.groundspeed;
  const distance = ac.remainingDistance;
  if (!(gs > 0) || !Number.isFinite(distance) || distance >= MAX_DISTANCE) return null;
  return ((distance * METERS_TO_NM) / gs) * 60;
}

function roundEta(eta) {
  return eta === null ? null : Math.round(eta * 10) / 10;
}

function isFrozen(ac, settings) {
  return ac.eta !== null && ac.eta <= settings.freezeMinutes;
}

/** Whether an aircraft with `eta` may take `holder`'s stand. */
function canPreempt(holder, eta, settings) {
  if (!holder || holder.status !== "provisional" || holder.manual) return false;
  if (holder.apronSize > 0) return false; // aprons share capacity, there is no one holder
  if (holder.eta === null || eta === null) return false;
  if (holder.eta < eta + settings.preemptMarginMinutes) return false;
  const state = notificationState.get(holder.callsign);
  return !(state && state.status === "sent");
}

function addDisplace(list, stand) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].callsign === stand.callsign) return;
  }
  list.push(stand);
}

/**
 * Whether `callsign` could hold stand `name`, collecting into `displace` the
 * provisional holders that would have to give way. False when the stand, or a
 * stand it blocks, is held by someone who cannot be moved.
 */
function claimable(icao, compiled, callsign, eta, settings, displace) {
  const name = compiled.name;
  if (registry.isOccupied(icao, name)) return false;

  const blocking = registry.getBlocked(icao, name);
  if (blocking && blocking.callsign !== callsign) {
    // Blocked by a neighbour's holder: only free if that holder can be moved.
    // A stand blocked by a parked aircraft has no assigned holder, so it stays out.
    const blocker = registry.firstAssignedOf(blocking.callsign);
    if (!blocker || blocker.icao !== icao || !canPreempt(blocker, eta, settings)) {
      return false;
    }
    addDisplace(displace, blocker);
  }

  const holder = registry.assignedAt(icao, name);
  if (holder && holder.callsign !== callsign) {
    if (!canPreempt(holder, eta, settings)) return false;
    addDisplace(displace, holder);
  }

  // Taking this stand blocks its neighbours, which must not knock a firm
  // assignment off its stand - that is exactly a lost firm stand.
  if (compiled.block) {
    for (let i = 0; i < compiled.block.length; i++) {
      const neighbour = compiled.block[i];
      if (neighbour === name) continue;
      const neighbourHolder = registry.assignedAt(icao, neighbour);
      if (!neighbourHolder || neighbourHolder.callsign === callsign) continue;
      if (!canPreempt(neighbourHolder, eta, settings)) return false;
      addDisplace(displace, neighbourHolder);
    }
  }
  return true;
}

/**
 * Best stand for `ac` in provisional mode, as { stand, tier, displace }, or null.
 *
 * Only stands of a tier strictly better than `mustBeat` are considered. A stand
 * is only taken from another aircraft when that gives a strictly better tier
 * than the best free one, so nobody is moved for a sideways swap. With
 * `sentState` (the pilot was already sent a TELEX) the stand it named, then
 * any stand producing the same message, are preferred over everything else.
 */
function findStandProvisional(airport, derived, ac, settings, mustBeat, sentState) {
  const profile = aircraftProfile(derived, ac);
  logSearchOnce(ac, airport, profile);

  const icao = airport.icao;
  let entries = [];
  const stands = airport.stands;
  for (let i = 0; i < stands.length; i++) {
    const stand = stands[i];
    if (!standFits(stand, profile)) continue;
    const tier = tierOf(stand);
    if (tier >= mustBeat) continue;

    if (stand.hasApron) {
      if (registry.getApronOccupancyLevel(stand.name, icao) >= stand.apronSize) continue;
      entries.push({ stand, tier, displace: [] });
      continue;
    }

    const displace = [];
    if (!claimable(icao, stand, ac.callsign, ac.eta, settings, displace)) continue;
    entries.push({ stand, tier, displace });
  }

  if (sentState) {
    const named = entries.filter((e) => e.stand.name === sentState.standName);
    if (named.length > 0) {
      entries = named;
    } else if (sentState.sentMessage !== undefined) {
      const same = entries.filter(
        (e) => renderTelexFor(e.stand.def, airport.raw) === sentState.sentMessage
      );
      if (same.length > 0) entries = same;
    }
  }

  if (entries.length === 0) return null;

  let bestFree = MAX_DISTANCE + 1;
  let bestAny = MAX_DISTANCE + 1;
  for (const e of entries) {
    if (e.tier < bestAny) bestAny = e.tier;
    if (e.displace.length === 0 && e.tier < bestFree) bestFree = e.tier;
  }

  let pool;
  if (bestAny < bestFree) {
    // Taking a stand: among the best tier, disturb as few aircraft as possible.
    pool = entries.filter((e) => e.tier === bestAny);
    let fewest = Infinity;
    for (const e of pool) if (e.displace.length < fewest) fewest = e.displace.length;
    pool = pool.filter((e) => e.displace.length === fewest);
  } else {
    pool = entries.filter((e) => e.tier === bestFree && e.displace.length === 0);
  }
  return pickTightest(pool, (e) => e.stand);
}

function releaseAll(callsign) {
  registry.removeAllAssignedOf(callsign);
  registry.removeAllBlockedOf(callsign);
}

function placeProvisional(airport, ac, settings, choice, telexSent) {
  const icao = airport.icao;
  for (const holder of choice.displace) {
    releaseAll(holder.callsign);
    info(
      `Stand ${holder.name} taken from ${holder.callsign} (ETA ${holder.eta} min) ` +
        `for ${ac.callsign} (ETA ${roundEta(ac.eta)} min)`,
      { category: "Assignation", callsign: holder.callsign, icao }
    );
  }

  releaseAll(ac.callsign);
  const selected = choice.stand;
  const stand = new Stand(selected.name, icao, ac.callsign, "", selected.apronSize);
  stand.eta = roundEta(ac.eta);
  // A pilot already told where to go keeps a firm stand: after a restart, or
  // when the one they were told about was lost.
  stand.status = telexSent || isFrozen(ac, settings) ? "firm" : "provisional";
  registry.addAssigned(stand);
  blockStands(selected, icao, ac.callsign);
  noStandFoundCache.delete(ac.callsign);
  info(
    `Assigning Stand ${selected.name} to ${ac.callsign} (${stand.status}, ETA ${stand.eta} min)`,
    { category: "Assignation", callsign: ac.callsign, icao }
  );
  return stand;
}

/** A held stand is lost once someone parks on it or another holder blocks it. */
function standLost(stand, callsign) {
  if (registry.isOccupied(stand.icao, stand.name)) return true;
  const blocking = registry.getBlocked(stand.icao, stand.name);
  return !!blocking && blocking.callsign !== callsign;
}

function setTelexStale(stand, value) {
  if (stand.telexStale === value) return;
  stand.telexStale = value;
  registry.touch();
}

function assignStandProvisional(airport, derived, ac, settings) {
  const callsign = ac.callsign;
  ac.eta = etaMinutes(ac);
  const state = notificationState.get(callsign);
  const telexSent = !!state && state.status === "sent";

  let current = registry.firstAssignedOf(callsign);
  if (current && current.icao !== airport.icao) {
    releaseAll(callsign); // destination changed
    current = undefined;
  }
  if (current && standLost(current, callsign)) {
    info(`Stand ${current.name} for ${callsign} is no longer available`, {
      category: "Assignation",
      callsign,
      icao: airport.icao,
    });
    releaseAll(callsign);
    current = undefined;
  }

  if (current) {
    const now = Date.now();
    current.timestamp = now;
    const blockedStands = registry.blockedOf(callsign);
    if (blockedStands) for (const stand of blockedStands) stand.timestamp = now;
    current.eta = roundEta(ac.eta);

    if (current.status === "provisional" && (telexSent || isFrozen(ac, settings))) {
      current.status = "firm";
      registry.touch();
      info(`Stand ${current.name} for ${callsign} is now firm (ETA ${current.eta} min)`, {
        category: "Assignation",
        callsign,
        icao: airport.icao,
      });
    }

    // Moving to a better stand is fine until the pilot has been told one.
    if (!current.manual && !telexSent) {
      const compiled = airport.standsByName.get(current.name);
      const better =
        compiled &&
        findStandProvisional(airport, derived, ac, settings, tierOf(compiled), null);
      if (better) {
        const previous = current.name;
        current = placeProvisional(airport, ac, settings, better, false);
        info(`${callsign} moved from stand ${previous} to better stand ${current.name}`, {
          category: "Assignation",
          callsign,
          icao: airport.icao,
        });
      }
    }
  } else {
    const choice = findStandProvisional(
      airport,
      derived,
      ac,
      settings,
      MAX_DISTANCE + 1,
      telexSent ? state : null
    );
    if (!choice) {
      warnNoStandOnce(ac, airport);
      return;
    }
    current = placeProvisional(airport, ac, settings, choice, telexSent);
  }

  handleTelexProvisional(airport, derived, ac, current);
}

function handleTelexProvisional(airport, derived, ac, stand) {
  const callsign = ac.callsign;
  const compiled = airport.standsByName.get(stand.name);
  const existing = notificationState.get(callsign);

  if (existing && existing.status === "sent") {
    trackCorrection(airport, derived, ac, stand, compiled, existing);
    return;
  }
  // Manual assignments never notify; provisional ones are not a promise yet.
  if (stand.manual || stand.status !== "firm" || !compiled) return;

  syncPendingEligibility(callsign, compiled.def, airport.raw, stand.name);
  const state = notificationState.get(callsign);
  if (!state || state.status !== "pending") return;

  if (!existing) {
    // Just frozen: try straight away rather than waiting out a recheck window.
    if (typeof ac.altitude === "number" && ac.altitude >= hoppieMinAltitudeFt(derived.config)) {
      sendTelexNotification(callsign, state);
    }
    return;
  }
  checkPendingHoppieNotification(ac, derived.config);
}

function trackCorrection(airport, derived, ac, stand, compiled, state) {
  const hoppie = airport.raw && airport.raw.Hoppie;
  state.maxMessages = hoppieMaxMessages(hoppie); // restored records carry the default

  // A record from before messages were stored: nothing to compare against.
  if (state.sentMessage === undefined) return;

  const message = compiled ? renderTelexFor(compiled.def, airport.raw) : null;
  const stale = message !== state.sentMessage;
  setTelexStale(stand, stale);
  if (!stale) {
    state.correction = null;
    return;
  }
  if (!message || state.correctionBlocked || state.inFlight) return;

  const now = Date.now();
  if (!state.correction || state.correction.standName !== stand.name) {
    state.correction = { standName: stand.name, since: now };
    return;
  }
  if (now - state.correction.since < CORRECTION_SETTLE_MS) return;
  if (ac.eta === null || ac.eta < hoppieCorrectionCutoffMinutes(hoppie)) return;
  if (!(typeof ac.altitude === "number" && ac.altitude >= hoppieMinAltitudeFt(derived.config))) {
    return;
  }
  sendTelexCorrection(ac.callsign, state, message, hoppie);
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

// When the last datafeed cycle finished processing; null before the first.
let lastCycleAt = null;

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

    // A departure booking ends here: fulfilled on its stand, released on any
    // other. Required lazily - bookingService depends on this module.
    require("./bookingService").onParked(ac, ac.origin, standName);

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

    // Which way this aircraft is going, read off the flight plan it filed: the
    // airport it is parked at appears as either the departure or the arrival.
    const plan = ac.flight_plan;
    const movement = !plan
      ? null
      : plan.departure === ac.origin
        ? "departure"
        : plan.arrival === ac.origin
          ? "arrival"
          : null;

    registry.addOccupied(
      new Stand(
        standName,
        ac.origin || "UNKNOWN",
        ac.callsign,
        resolveRemark(stand.def, aircraftCode),
        stand.apronSize,
        movement
      )
    );
    blockStands(stand, ac.origin, ac.callsign);
  }

  // Held departure bookings go into the registry before arrivals are assigned,
  // so no arrival is given a booked stand.
  require("./bookingService").applyBookings(airportByIcao);

  // Handle airborne aircraft - (ie: assign stand if criterias met).
  // Candidates are gathered first and served in ETA order, not datafeed order,
  // so the aircraft that lands first chooses first. Provisional mode depends on
  // it: an aircraft displaced from its stand always has a later ETA than the one
  // that took it, so it is still to come in this same cycle.
  const arrivals = [];
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

    ac.eta = etaMinutes(ac);
    arrivals.push({ ac, destination });
  }

  arrivals.sort((a, b) => {
    const ea = a.ac.eta === null ? Infinity : a.ac.eta;
    const eb = b.ac.eta === null ? Infinity : b.ac.eta;
    return ea - eb;
  });
  for (const { ac, destination } of arrivals) {
    assignStand(destination, derived, ac);
  }

  lastCycleAt = Date.now();

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
  // A controller outranks the engine's provisional guess: the aircraft holding
  // it is moved off and searched again on the next cycle.
  // A controller also outranks a pilot's booking: the booking is cancelled.
  const bookedHolder = registry.assignedAt(icao, standName);
  if (bookedHolder && bookedHolder.status === "booked" && bookedHolder.callsign !== callsign) {
    require("./bookingService").overrideAt(icao, standName, callsign);
  }

  const provisionalHolder = registry.assignedAt(icao, standName);
  if (
    provisionalHolder &&
    provisionalHolder.callsign !== callsign &&
    provisionalHolder.status === "provisional" &&
    !provisionalHolder.manual
  ) {
    registry.removeAllAssignedOf(provisionalHolder.callsign);
    registry.removeAllBlockedOf(provisionalHolder.callsign);
    info(
      `Provisional stand ${standName} at ${icao} released from ${provisionalHolder.callsign} for manual assignment to ${callsign}, Requester: ${client}`,
      { category: "Manual Assign", callsign: provisionalHolder.callsign, icao: icao }
    );
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

  // Manual assignments are firm: never taken by the engine, never moved by it.
  const manualStand = new Stand(standName, icao, callsign, "", stand.apronSize);
  manualStand.status = "firm";
  manualStand.manual = true;
  registry.addAssigned(manualStand);
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

setInterval(standCleanup, 60 * 1000).unref(); // every minute

// Export everything together
module.exports = {
  Stand,
  registry,
  processDatafeed,
  isConcernedArrival,
  evaluateStand,
  checkStandFor,
  blockStandsFor: blockStands,
  orderByTightness,
  orderByPreference,
  pickTightest,
  getLastCycleAt: () => lastCycleAt,
  // Exposed for the bench scripts only.
  _notificationState: notificationState,
  loadPersistedNotifications,
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
