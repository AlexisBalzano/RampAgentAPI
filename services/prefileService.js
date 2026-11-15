const { warn } = require("../utils/logger");

/**
 * VATSIM prefiles, from the data platform.
 *
 * A prefile is a flight plan filed before the pilot connects; it disappears
 * from the feed once they do. Each carries the pilot's CID, which is what ties a
 * stand booking to the signed-in member: a booking is only accepted for a flight
 * the member has actually prefiled.
 *
 * Fetched on demand (a booking, a member asking for their flights), never per
 * datafeed cycle, and shared for a few seconds so a burst of requests costs one
 * call.
 */

const DATAPLATFORM_URL = (process.env.DATAPLATFORM_URL || "http://dataplatform:8080").replace(/\/+$/, "");
const PREFILES_PATH = "/api/v1/current/vatsim/prefiles";
const CACHE_MS = 15_000;
const TIMEOUT_MS = 8_000;
const LIMIT = 5000; // the endpoint defaults to 100; the whole network has a few hundred

let cache = null; // { at, value: Promise<Prefile[]> }

/** The fields a booking needs, from one data platform prefile. */
function toPrefile(raw) {
  const plan = (raw && raw.flight_plan) || {};
  const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : "");
  return {
    cid: raw && raw.cid !== undefined && raw.cid !== null ? String(raw.cid) : "",
    callsign: upper(raw && raw.callsign),
    aircraftType: upper(plan.aircraft_short),
    departure: upper(plan.departure),
    arrival: upper(plan.arrival),
    deptime: typeof plan.deptime === "string" ? plan.deptime : null,
    remarks: typeof plan.remarks === "string" ? plan.remarks : "",
  };
}

async function fetchAll() {
  const response = await fetch(`${DATAPLATFORM_URL}${PREFILES_PATH}?limit=${LIMIT}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`data platform answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("data platform prefiles is not a list");
  return body.map(toPrefile).filter((p) => p.cid && p.callsign);
}

/** Every current prefile. Rejects when the data platform cannot be reached. */
function all() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = fetchAll();
  cache = { at: Date.now(), value };
  value.catch((err) => {
    if (cache && cache.value === value) cache = null; // the next caller retries
    warn(`Prefile fetch failed: ${err.message}`, { category: "Booking" });
  });
  return value;
}

/** The member's prefiles, newest feed first. */
async function forCid(cid) {
  const wanted = String(cid);
  return (await all()).filter((p) => p.cid === wanted);
}

// Exposed for the tests, which replace the fetch.
function _setSource(source) {
  cache = source ? { at: Infinity, value: Promise.resolve(source.map(toPrefile)) } : null;
}

module.exports = { all, forCid, toPrefile, _setSource };
