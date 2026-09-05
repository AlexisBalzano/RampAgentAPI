const occupancyService = require('../services/occupancyService');
const airportService = require('../services/airportService');
const airportIndex = require('../services/airportIndex');
const { info, warn, error } = require('../utils/logger');
const stats = require('../services/statService');
const { haversineMeters, M_PER_DEG_LAT } = require('../utils/utils');
const {
  DatafeedScheduler,
  parseTimestampMs,
} = require('../services/datafeedScheduler');

// Traffic comes from the data platform on the internal network rather than
// straight from VATSIM. It carries the same generation timestamps, delivered
// about one generation later, and can filter by radius server-side.
const DATAPLATFORM_URL = (
  process.env.DATAPLATFORM_URL || 'http://dataplatform:8080'
).replace(/\/+$/, '');

const STATS_PATH = '/api/v1/current/vatsim/network/stats';
const PILOTS_PATH = '/api/v1/current/vatsim/pilots/within-radius';

// The plain /pilots endpoint caps at 1000 rows against a network of ~1700, so
// the radius endpoint is not just cheaper - it is the only one that returns a
// complete answer without undocumented paging. This ceiling is a tripwire: if a
// response ever reaches it, the result is silently truncated.
const PILOT_LIMIT = 5000;

const REQUEST_TIMEOUT_MS = 8000;

// Rough centre of the covered area; the pre-filter is a coarse "could this
// aircraft possibly matter" test before the real work starts.
const CENTER_LAT = 46.22545;
const CENTER_LON = 2.10924;

// Floor for the pre-filter, so coverage never shrinks below what it was.
const MIN_RADIUS_METERS = 600_000;
const NM_TO_METERS = 1852;

const DEFAULT_SCOPE = { radius: MIN_RADIUS_METERS, maxAltitude: 20000 };

let scopeCache = null;
let scopeSource = null;

/**
 * Derives the pre-filter envelope from the assignment envelope, rather than
 * hard-coding it.
 *
 * An aircraft is assignable if it is within max_distance of a tracked airport,
 * so the pre-filter has to reach the furthest tracked airport plus that
 * distance - otherwise raising the assignment radius silently does nothing
 * because the traffic was already dropped here. Same for the altitude ceiling:
 * a fixed FL200 cut kept a higher max_alt from ever taking effect.
 */
async function getDatafeedScope() {
  const config = await airportService.getConfig();
  if (!config) return DEFAULT_SCOPE;
  if (scopeCache && scopeSource === config) return scopeCache;

  let furthestAirport = 0;
  try {
    const airports = await airportIndex.preload(airportService.getAirportList());
    for (const airport of airports) {
      if (!airport.hasCoords) continue;
      const distance = haversineMeters(
        CENTER_LAT,
        CENTER_LON,
        airport.lat,
        airport.lon
      );
      if (distance > furthestAirport) furthestAirport = distance;
    }
  } catch (err) {
    warn(`Could not measure airport spread: ${err.message}`, { category: 'System' });
  }

  const assignRadiusNm = occupancyService.maxDistanceNm(config);
  const radius = Math.max(
    MIN_RADIUS_METERS,
    furthestAirport + assignRadiusNm * NM_TO_METERS
  );
  const maxAltitude = Math.max(
    occupancyService.maxAltitudeFt(config),
    DEFAULT_SCOPE.maxAltitude
  );

  if (
    !scopeCache ||
    scopeCache.radius !== radius ||
    scopeCache.maxAltitude !== maxAltitude
  ) {
    info(
      `Datafeed scope: ${(radius / 1000) | 0} km around the coverage centre, below ${maxAltitude} ft`,
      { category: 'System' }
    );
  }

  scopeCache = { radius, maxAltitude };
  scopeSource = config;
  return scopeCache;
}

/**
 * Splits the pilot list into the traffic worth processing. Single pass, with a
 * latitude-band rejection ahead of the haversine so anything outside the scope
 * costs a subtraction and a compare.
 *
 * The data platform omits zero-valued fields, so a parked aircraft arrives with
 * no `groundspeed` key at all rather than `groundspeed: 0`. Reading it directly
 * would compare `undefined < 2`, which is false, and every stationary aircraft
 * would be classified as airborne - occupancy would quietly stop working
 * altogether. Missing means zero here, for the same reason on altitude.
 */
function filterDatafeed(pilots, scope = DEFAULT_SCOPE) {
  const radius = scope.radius;
  const maxAltitude = scope.maxAltitude;
  const latBand = radius / M_PER_DEG_LAT;

  const onGround = [];
  const airborne = [];

  for (let i = 0; i < pilots.length; i++) {
    const pilot = pilots[i];
    const altitude = pilot.altitude ?? 0;
    if (!(altitude < maxAltitude)) continue;

    const lat = pilot.latitude;
    const lon = pilot.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const dLat = lat > CENTER_LAT ? lat - CENTER_LAT : CENTER_LAT - lat;
    if (dLat > latBand) continue;
    if (haversineMeters(lat, lon, CENTER_LAT, CENTER_LON) > radius) continue;

    if ((pilot.groundspeed ?? 0) < 2) onGround.push(pilot);
    else airborne.push(pilot);
  }

  return { onGround, airborne };
}

// The datafeed regenerates every 15 s. If a cycle ever runs longer than that,
// overlapping runs would mutate the registry concurrently, so the next tick is
// skipped instead.
let inFlight = false;

const scheduler = new DatafeedScheduler();

/**
 * Fetches once and hands the result to the scheduler.
 * Returns the scheduler's decision so the poll loop knows when to ask again.
 */
exports.getDatafeed = async () => {
  if (inFlight) {
    warn('Previous datafeed cycle still running, skipping this tick', {
      category: 'Report',
    });
    return { delayMs: scheduler.periodMs, phase: 'busy' };
  }
  inFlight = true;

  // Everything after the flag is set lives inside the try, so the flag is
  // always released: leaving it set would silently stop every later cycle and
  // stand assignment would just quietly stop happening.
  try {
    // Increment only if valid report
    stats.incrementReportCount();

    // The generation timestamp comes from a few hundred bytes of stats, so a
    // poll that turns out to be a duplicate never downloads the traffic at all.
    const statsBody = await getJson(DATAPLATFORM_URL + STATS_PATH);
    const fetchedAt = Date.now();
    const generationMs = parseTimestampMs(statsBody && statsBody.last_updated);

    if (!Number.isFinite(generationMs)) {
      error(
        `Data platform stats missing a usable last_updated (${JSON.stringify(
          statsBody && statsBody.last_updated
        )})`,
        { category: 'Report' }
      );
      return scheduler.observe({ ok: false, generationMs: null, fetchedAt });
    }

    const decision = scheduler.observe({ ok: true, generationMs, fetchedAt });
    reportSchedulerPhase(decision);

    // A repeat generation is the probe finding the delivery edge, not new
    // traffic - reprocessing it would just rewrite the registry with data it
    // already holds.
    if (!decision.isNew) return decision;

    const scope = await getDatafeedScope();
    const radiusNm = Math.ceil(scope.radius / NM_TO_METERS);
    const pilots = await getJson(
      `${DATAPLATFORM_URL}${PILOTS_PATH}?latitude=${CENTER_LAT}` +
        `&longitude=${CENTER_LON}&radius_nm=${radiusNm}&limit=${PILOT_LIMIT}`
    );

    // Validate and process data
    if (!Array.isArray(pilots) || pilots.length === 0) {
      error('Data platform returned no pilots', { category: 'Report' });
      return decision;
    }
    if (pilots.length >= PILOT_LIMIT) {
      warn(
        `Pilot list hit the ${PILOT_LIMIT} row ceiling - traffic is being truncated`,
        { category: 'Report' }
      );
    }

    // Process aircraft data, then pass to occupancy service
    await occupancyService.processDatafeed(filterDatafeed(pilots, scope));
    return decision;
  } catch (err) {
    error(`Error fetching datafeed: ${err}`, { category: 'Report' });
    return scheduler.observe({
      ok: false,
      generationMs: null,
      fetchedAt: Date.now(),
    });
  } finally {
    inFlight = false;
  }
};

/** GETs JSON with a timeout, so an unresponsive platform cannot stall a cycle. */
async function getJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

// Only transitions are worth a line. "wait" is the normal probe waiting for a
// publish to land and happens on most cycles, so logging it would add several
// rows a minute forever.
let lockLogged = false;
function reportSchedulerPhase(decision) {
  if (decision.phase === 'lock' && !lockLogged) {
    lockLogged = true;
    info(
      `Datafeed poll locked to the platform: publishing every ~${decision.periodMs} ms`,
      { category: 'Report' }
    );
  } else if (decision.phase === 'stalled') {
    warn(
      `No new publish after ${scheduler.options.maxProbes} probes - re-aiming ` +
        `(interval estimate ${decision.periodMs} ms)`,
      { category: 'Report' }
    );
  }
}

/**
 * Self-scheduling poll loop. Each poll is timed from the feed's own timestamp
 * rather than a fixed period - see services/datafeedScheduler.js.
 */
let pollTimer = null;
let polling = false;

exports.startPolling = () => {
  if (polling) return;
  polling = true;

  const tick = async () => {
    let delayMs = Math.round(scheduler.periodMs);
    try {
      const decision = await exports.getDatafeed();
      if (decision && Number.isFinite(decision.delayMs)) delayMs = decision.delayMs;
    } catch (err) {
      error(`Datafeed cycle failed: ${err && err.stack ? err.stack : err}`, {
        category: 'Report',
      });
    }
    if (!polling) return;
    pollTimer = setTimeout(tick, delayMs);
    if (pollTimer.unref) pollTimer.unref();
  };

  tick();
};

exports.stopPolling = () => {
  polling = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
};

// Exported for benchmarking/tests
exports.filterDatafeed = filterDatafeed;
exports.scheduler = scheduler;
exports.getDatafeedScope = getDatafeedScope;
