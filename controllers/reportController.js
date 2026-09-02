const occupancyService = require('../services/occupancyService');
const airportService = require('../services/airportService');
const airportIndex = require('../services/airportIndex');
const { info, warn, error } = require('../utils/logger');
const stats = require('../services/statService');
const { haversineMeters, M_PER_DEG_LAT } = require('../utils/utils');

const DATAFEED_URL = 'https://data.vatsim.net/v3/vatsim-data.json';

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
 * a fixed FL200 cut kept max_alt_extended (FL400) from ever taking effect.
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

  const assignRadiusNm = Math.max(
    config.max_distance || 0,
    config.max_distance_extended || 0
  );
  const radius = Math.max(
    MIN_RADIUS_METERS,
    furthestAirport + assignRadiusNm * NM_TO_METERS
  );
  const maxAltitude = Math.max(
    config.max_alt || 0,
    config.max_alt_extended || 0,
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
 * Splits the global pilot list into the traffic worth processing. Single pass,
 * with a latitude-band rejection ahead of the haversine so the great majority
 * of the world's traffic costs a subtraction and a compare.
 */
function filterDatafeed(pilots, scope = DEFAULT_SCOPE) {
  const radius = scope.radius;
  const maxAltitude = scope.maxAltitude;
  const latBand = radius / M_PER_DEG_LAT;

  const onGround = [];
  const airborne = [];

  for (let i = 0; i < pilots.length; i++) {
    const pilot = pilots[i];
    if (!(pilot.altitude < maxAltitude)) continue;

    const lat = pilot.latitude;
    const lon = pilot.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const dLat = lat > CENTER_LAT ? lat - CENTER_LAT : CENTER_LAT - lat;
    if (dLat > latBand) continue;
    if (haversineMeters(lat, lon, CENTER_LAT, CENTER_LON) > radius) continue;

    if (pilot.groundspeed < 2) onGround.push(pilot);
    else airborne.push(pilot);
  }

  return { onGround, airborne };
}

// The datafeed regenerates every 15 s. If a cycle ever runs longer than that,
// overlapping runs would mutate the registry concurrently, so the next tick is
// skipped instead.
let inFlight = false;

// Handle incoming reports from datafeed
exports.getDatafeed = async () => {
  if (inFlight) {
    warn('Previous datafeed cycle still running, skipping this tick', {
      category: 'Report',
    });
    return;
  }
  inFlight = true;

  // Everything after the flag is set lives inside the try, so the flag is
  // always released: leaving it set would silently stop every later cycle and
  // stand assignment would just quietly stop happening.
  try {
    // Increment only if valid report
    stats.incrementReportCount();

    const response = await fetch(DATAFEED_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();

    // Validate and process data
    if (!data || !data.pilots || data.pilots.length === 0) {
      error('Invalid datafeed format', { category: 'Report' });
      return;
    }

    const scope = await getDatafeedScope();
    // Process aircraft data, then pass to occupancy service
    await occupancyService.processDatafeed(filterDatafeed(data.pilots, scope));
  } catch (err) {
    error(`Error fetching datafeed: ${err}`, { category: 'Report' });
  } finally {
    inFlight = false;
  }
};

// Exported for benchmarking/tests
exports.filterDatafeed = filterDatafeed;
exports.getDatafeedScope = getDatafeedScope;
