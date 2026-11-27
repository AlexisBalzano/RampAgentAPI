const { info } = require("../utils/logger");
const redisService = require("./redisService");
const occupancy = require("./occupancyService");

/**
 * Arrival stand preferences from virtual airlines.
 *
 * A VA tells us, per flight, the stand it announced to its pilot: callsign,
 * arrival airport, stand, aircraft type and its own ETA (at most LIFETIME_MS
 * ahead). The preference is a hint to the arrival engine, never a hold:
 *
 * - Nothing goes into the registry, so the stand is not blocked for anyone,
 *   and to the plugin it is a stand like any other.
 * - When the flight is picked up by the engine, the preferred stand is taken
 *   first if it is free (not occupied, assigned or blocked by anyone else, and
 *   taking it would not block a neighbour someone holds) and the aircraft is
 *   small enough for it. Every other restriction of the stand (use, Schengen,
 *   countries, callsigns) is the VA's call and is ignored.
 * - Otherwise the flight is assigned exactly as today. If the preferred stand
 *   frees up while the assignment is still provisional, the flight moves to it.
 * - From there the provisional/firm pipeline is unchanged: an earlier arrival
 *   may still take a provisional stand, the freeze makes it firm, the TELEX
 *   goes out, and a controller's manual assignment always wins.
 *
 * A preference lives LIFETIME_MS from its last update, and is deleted as soon
 * as the flight parks at the airport, so a later flight under the same
 * callsign never inherits it. Each datafeed cycle `observe` records what the
 * flight was given, which the VA polls. Records are mirrored in Redis.
 */

const LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_PAST_MS = 30 * 60 * 1000; // an ETA already passed is accepted this long, for a late update
const MAX_PER_VA = 500;

const prefs = new Map(); // callsign -> record

function now() {
  return Date.now();
}

const iso = (t) => (t ? new Date(t).toISOString() : null);

function publicView(record) {
  return {
    callsign: record.callsign,
    arrival: record.icao,
    stand: record.stand,
    aircraftType: record.aircraftType,
    eta: iso(record.eta),
    expiresAt: iso(record.expiresAt),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    assignment: { ...record.outcome, at: iso(record.outcome.at) },
  };
}

function waiting(reason = null) {
  return { state: "waiting", stand: null, status: null, honoured: null, reason };
}

function persist(record) {
  const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - now()) / 1000));
  return redisService.setVaArrival(record.callsign, record, ttlSeconds);
}

/** Reads preferences back after a restart. */
async function loadPersisted() {
  const records = await redisService.getAllVaArrivals();
  let restored = 0;
  for (const record of records) {
    if (!record || !record.callsign || !record.icao || !record.stand) continue;
    if (!(record.expiresAt > now())) continue;
    if (!record.outcome) record.outcome = { ...waiting(), at: now() };
    prefs.set(record.callsign, record);
    restored++;
  }
  if (restored > 0) info(`Restored ${restored} arrival preference(s) from Redis`, { category: "VA Arrival" });
  return restored;
}

function drop(record, why) {
  prefs.delete(record.callsign);
  redisService.clearVaArrival(record.callsign);
  info(`Arrival preference ${record.stand} at ${record.icao} for ${record.callsign} deleted: ${why}`, {
    category: "VA Arrival",
    callsign: record.callsign,
    icao: record.icao,
  });
}

// --- engine side ------------------------------------------------------------

/** The preference the engine should apply to this flight now, or null. */
function activeFor(callsign, icao) {
  const record = prefs.get(callsign);
  if (!record || record.icao !== icao || record.expiresAt <= now()) return null;
  return record;
}

/** The engine found the filed aircraft too big for the preferred stand (or no longer). */
function setUnsuitable(callsign, value) {
  const record = prefs.get(callsign);
  if (record) record.unsuitable = !!value;
}

function sameOutcome(a, b) {
  return (
    a.state === b.state &&
    a.stand === b.stand &&
    a.status === b.status &&
    a.honoured === b.honoured &&
    a.reason === b.reason
  );
}

/** What the flight holds right now, as the VA sees it. */
function outcomeOf(record) {
  const held = occupancy.registry.firstAssignedOf(record.callsign);
  if (!held) return waiting();
  if (held.icao !== record.icao) return waiting("destination_differs");
  const honoured = held.name === record.stand;
  let reason = null;
  if (!honoured) {
    if (held.manual) reason = "controller";
    else if (record.unsuitable) reason = "aircraft_unsuitable";
    else reason = "stand_unavailable";
  }
  return { state: "assigned", stand: held.name, status: held.status, honoured, reason };
}

/**
 * Once per datafeed cycle, after arrivals are assigned: deletes preferences
 * whose flight parked at the airport or whose lifetime is over, and records
 * what the others were given.
 */
function observe() {
  const t = now();
  const registry = occupancy.registry;
  for (const record of Array.from(prefs.values())) {
    const parked = registry.firstOccupiedOf(record.callsign);
    if (parked && parked.icao === record.icao) {
      drop(record, parked.name === record.stand ? "fulfilled" : `parked on ${parked.name} instead`);
      continue;
    }
    if (record.expiresAt <= t) {
      drop(record, "expired");
      continue;
    }

    const next = outcomeOf(record);
    if (sameOutcome(next, record.outcome)) continue;
    record.outcome = { ...next, at: t };
    persist(record);
  }
}

// --- API side -----------------------------------------------------------------

/** This VA's live preferences. */
function listFor(vaId) {
  const t = now();
  return [...prefs.values()]
    .filter((r) => r.vaId === vaId && r.expiresAt > t)
    .sort((a, b) => a.eta - b.eta)
    .map(publicView);
}

function getFor(vaId, callsign) {
  const record = prefs.get(callsign);
  return record && record.vaId === vaId && record.expiresAt > now() ? publicView(record) : null;
}

/**
 * Creates or replaces the preference for `callsign`.
 *
 * `airport` is the compiled arrival airport, `standName` its exact spelling
 * there, `fits` the size check already run by the caller. Returns
 * { ok, created, preference } or { ok: false, status, code, error }.
 */
function upsert({ va, callsign, airport, standName, aircraftType, eta, fits }) {
  const t = now();
  let existing = prefs.get(callsign);
  if (existing && existing.expiresAt <= t) existing = null;
  if (existing && existing.vaId !== va.id) {
    return { ok: false, status: 409, code: "callsign_claimed", error: `${callsign} already has a preference from another airline` };
  }
  if (!fits) {
    return { ok: false, status: 422, code: "stand_unsuitable", error: `${aircraftType} is too big for stand ${standName}` };
  }
  if (!(eta >= t - MAX_PAST_MS) || eta > t + LIFETIME_MS) {
    return {
      ok: false,
      status: 422,
      code: "eta_out_of_range",
      error: "eta must be between 30 minutes ago and 2 hours from now",
      field: "eta",
    };
  }
  if (!existing) {
    let count = 0;
    for (const r of prefs.values()) if (r.vaId === va.id && r.expiresAt > t) count++;
    if (count >= MAX_PER_VA) {
      return { ok: false, status: 429, code: "too_many_preferences", error: `At most ${MAX_PER_VA} live preferences per airline` };
    }
  }

  // Parked here already, or holding another stand firm (frozen, or the pilot
  // was sent it): the preference can no longer change anything.
  const registry = occupancy.registry;
  const parked = registry.firstOccupiedOf(callsign);
  const held = registry.firstAssignedOf(callsign);
  if (parked && parked.icao === airport.icao) {
    return { ok: false, status: 409, code: "too_late", error: `${callsign} is already parked on stand ${parked.name}` };
  }
  if (held && held.icao === airport.icao && held.status !== "provisional" && held.name !== standName) {
    return { ok: false, status: 409, code: "too_late", error: `${callsign} already has stand ${held.name} for good` };
  }

  const record = {
    callsign,
    icao: airport.icao,
    stand: standName,
    aircraftType,
    eta,
    expiresAt: t + LIFETIME_MS,
    vaId: va.id,
    vaName: va.name,
    createdAt: existing ? existing.createdAt : t,
    updatedAt: t,
    unsuitable: false,
  };
  record.outcome = { ...outcomeOf(record), at: t };
  prefs.set(callsign, record);
  persist(record);
  info(
    `${existing ? "Updated" : "New"} arrival preference from ${va.name}: ${callsign} on stand ${standName} at ${airport.icao} (${aircraftType}, ETA ${iso(eta)})`,
    { category: "VA Arrival", callsign, icao: airport.icao }
  );
  return { ok: true, created: !existing, preference: publicView(record) };
}

/** Deletes the VA's preference. False when it has none for this callsign. */
function remove(vaId, callsign) {
  const record = prefs.get(callsign);
  if (!record || record.vaId !== vaId || record.expiresAt <= now()) return false;
  drop(record, `withdrawn by ${record.vaName}`);
  return true;
}

// For the tests.
function _reset() {
  prefs.clear();
}

module.exports = {
  LIFETIME_MS,
  activeFor,
  setUnsuitable,
  observe,
  listFor,
  getFor,
  upsert,
  remove,
  loadPersisted,
  _reset,
};
