const { info, warn } = require("../utils/logger");
const redisService = require("./redisService");
const occupancy = require("./occupancyService");

/**
 * Departure stand bookings.
 *
 * A member with a prefile departing one of our airports may hold one stand
 * there for HOLD_MS. Inside that window they must connect on it; occupancy then
 * keeps the stand like any other parked aircraft and the booking is done. If
 * they don't, or connect elsewhere, or someone else takes the stand first, the
 * booking is removed. Arrivals cannot book: the engine assigns them.
 *
 * While held, a booking is an assigned stand in the registry (status "booked",
 * firm, flagged manual) with its Block neighbours blocked - so the arrival
 * engine, suggestions, the plugin and the viewer all see it as taken without
 * knowing anything about bookings. It is written back into the registry every
 * datafeed cycle (applyBookings), which also keeps it clear of the registry's
 * two-minute expiry.
 *
 * Bookings are mirrored in Redis with a TTL equal to what is left of the hold,
 * so a restart neither loses nor extends one.
 */

const HOLD_MS = 10 * 60 * 1000;
const OUTCOME_TTL_MS = 30 * 60 * 1000;

const bookings = new Map(); // cid -> booking
const outcomes = new Map(); // cid -> { status, icao, stand, callsign, at }

function now() {
  return Date.now();
}

function publicView(booking) {
  if (!booking) return null;
  return {
    icao: booking.icao,
    stand: booking.stand,
    callsign: booking.callsign,
    aircraftType: booking.aircraftType,
    destination: booking.destination,
    createdAt: new Date(booking.createdAt).toISOString(),
    expiresAt: new Date(booking.expiresAt).toISOString(),
  };
}

function lastOutcome(cid) {
  const outcome = outcomes.get(cid);
  if (!outcome) return null;
  if (now() - outcome.at > OUTCOME_TTL_MS) {
    outcomes.delete(cid);
    return null;
  }
  return { ...outcome, at: new Date(outcome.at).toISOString() };
}

/** The member's current booking and how their last one ended. */
function forCid(cid) {
  const booking = bookings.get(String(cid));
  const live = booking && booking.expiresAt > now() ? booking : null;
  return { booking: publicView(live), last: lastOutcome(String(cid)) };
}

/** The booking holding a stand, if any. */
function atStand(icao, stand) {
  for (const booking of bookings.values()) {
    if (booking.icao === icao && booking.stand === stand) return booking;
  }
  return null;
}

// --- registry -------------------------------------------------------------

/** Writes a booking into the registry as a held stand, refreshing its timestamps. */
function materialize(booking, airport) {
  const registry = occupancy.registry;
  const compiled = airport && airport.standsByName.get(booking.stand);
  if (!compiled) return;

  const existing = registry.firstAssignedOf(booking.callsign);
  const t = now();
  if (existing && existing.icao === booking.icao && existing.name === booking.stand) {
    existing.timestamp = t;
  } else {
    registry.removeAllAssignedOf(booking.callsign);
    registry.removeAllBlockedOf(booking.callsign);
    const stand = new occupancy.Stand(booking.stand, booking.icao, booking.callsign, "", compiled.apronSize);
    stand.status = "booked";
    stand.manual = true; // never moved or taken by the engine
    registry.addAssigned(stand);
    occupancy.blockStandsFor(compiled, booking.icao, booking.callsign);
  }
  const blocked = registry.blockedOf(booking.callsign);
  if (blocked) for (const s of blocked) s.timestamp = t;
}

/** Takes a booking's stand back out of the registry. */
function dematerialize(booking) {
  const registry = occupancy.registry;
  const held = registry.firstAssignedOf(booking.callsign);
  if (held && held.status === "booked") {
    registry.removeAllAssignedOf(booking.callsign);
    registry.removeAllBlockedOf(booking.callsign);
  }
}

// --- persistence ----------------------------------------------------------

function persist(booking) {
  const ttlSeconds = Math.max(1, Math.ceil((booking.expiresAt - now()) / 1000));
  return redisService.setStandBooking(booking.cid, booking, ttlSeconds);
}

/** Reads held bookings back after a restart, before the first datafeed cycle. */
async function loadPersisted() {
  const records = await redisService.getAllStandBookings();
  let restored = 0;
  for (const booking of records) {
    if (!booking || !booking.cid || !(booking.expiresAt > now())) continue;
    bookings.set(String(booking.cid), booking);
    restored++;
  }
  if (restored > 0) {
    info(`Restored ${restored} stand booking(s) from Redis`, { category: "Booking" });
  }
  return restored;
}

// --- lifecycle ------------------------------------------------------------

function end(booking, status, reason) {
  bookings.delete(booking.cid);
  dematerialize(booking);
  redisService.clearStandBooking(booking.cid);
  outcomes.set(booking.cid, {
    status,
    icao: booking.icao,
    stand: booking.stand,
    callsign: booking.callsign,
    at: now(),
  });
  info(
    `Booking of stand ${booking.stand} at ${booking.icao} for ${booking.callsign} ${status}${reason ? ` - ${reason}` : ""}`,
    { category: "Booking", callsign: booking.callsign, icao: booking.icao }
  );
}

/**
 * Books `standName` for the member, from their prefile.
 *
 * Returns { ok: true, booking } or { ok: false, status, code, error }.
 * The stand must fit the prefiled aircraft and be free right now; a member
 * holds one booking at a time, so a new one replaces the old.
 */
function book({ cid, prefile, airport, derived, standName, via }) {
  const icao = airport.icao;
  const compiled = airport.standsByName.get(standName);
  if (!compiled) {
    return { ok: false, status: 404, code: "unknown_stand", error: `Stand ${standName} does not exist at ${icao}` };
  }

  const check = occupancy.checkStandFor(airport, derived, {
    callsign: prefile.callsign,
    aircraftType: prefile.aircraftType,
    direction: "departure",
    otherAirport: prefile.arrival,
    remarks: prefile.remarks,
  }, standName);
  if (!check.fits) {
    return {
      ok: false,
      status: 422,
      code: "stand_unsuitable",
      error: `Stand ${standName} does not accept ${prefile.aircraftType} ${prefile.callsign}`,
    };
  }

  const holder = atStand(icao, standName);
  if ((holder && holder.cid !== cid) || !check.available) {
    return { ok: false, status: 409, code: "stand_taken", error: `Stand ${standName} is not free` };
  }

  const previous = bookings.get(cid);
  if (previous) end(previous, "replaced");

  const t = now();
  const booking = {
    cid,
    icao,
    stand: standName,
    callsign: prefile.callsign,
    aircraftType: prefile.aircraftType,
    destination: prefile.arrival,
    createdAt: t,
    expiresAt: t + HOLD_MS,
  };
  bookings.set(cid, booking);
  outcomes.delete(cid);
  materialize(booking, airport);
  persist(booking);
  info(
    `Stand ${standName} at ${icao} booked for ${booking.callsign} (${booking.aircraftType} to ${booking.destination}) until ${new Date(booking.expiresAt).toISOString()}${via ? ` (via ${via})` : ""}`,
    { category: "Booking", callsign: booking.callsign, icao }
  );
  return { ok: true, booking: publicView(booking) };
}

/** The member cancels. False when they hold nothing. */
function cancel(cid) {
  const booking = bookings.get(String(cid));
  if (!booking) return false;
  end(booking, "cancelled");
  return true;
}

/** A controller assigned the booked stand by hand: the controller wins. */
function overrideAt(icao, stand, by) {
  const booking = atStand(icao, stand);
  if (booking) end(booking, "overridden", `assigned to ${by} by a controller`);
}

/**
 * Called by the datafeed loop for an aircraft seen parked on `standName` at
 * `icao`. The member's booking is fulfilled when it is that stand (occupancy
 * keeps it from here) and released when they connected on another one.
 */
function onParked(ac, icao, standName) {
  const cid = ac.cid !== undefined && ac.cid !== null ? String(ac.cid) : null;
  let booking = cid ? bookings.get(cid) : null;
  if (!booking) {
    // A pilot connecting under the prefiled callsign but a CID the feed lacks.
    for (const b of bookings.values()) {
      if (b.callsign === ac.callsign) {
        booking = b;
        break;
      }
    }
  }
  if (!booking || booking.icao !== icao) return;
  if (booking.stand === standName) end(booking, "fulfilled");
  else end(booking, "released", `connected on stand ${standName} instead`);
}

/**
 * Once per datafeed cycle, after parked aircraft are processed and before
 * arrivals are assigned: drops expired bookings and ones whose stand someone
 * else took, and writes the rest into the registry.
 */
function applyBookings(airportByIcao) {
  const t = now();
  for (const booking of Array.from(bookings.values())) {
    if (booking.expiresAt <= t) {
      end(booking, "expired", "the pilot did not connect on it in time");
      continue;
    }
    const airport = airportByIcao.get(booking.icao);
    if (!airport) continue; // airport config not loaded this cycle: leave it as is

    // The member parking on it was handled by onParked earlier in the cycle, so
    // anyone on it now is someone else.
    const registry = occupancy.registry;
    const blocking = registry.getBlocked(booking.icao, booking.stand);
    if (
      registry.isOccupied(booking.icao, booking.stand) ||
      (blocking && blocking.callsign !== booking.callsign)
    ) {
      end(booking, "conflict", "another aircraft is on or next to the stand");
      continue;
    }
    materialize(booking, airport);
  }
}

// Exposed for the tests.
function _reset() {
  for (const booking of Array.from(bookings.values())) dematerialize(booking);
  bookings.clear();
  outcomes.clear();
}

module.exports = {
  HOLD_MS,
  book,
  cancel,
  forCid,
  atStand,
  overrideAt,
  onParked,
  applyBookings,
  loadPersisted,
  _reset,
};
