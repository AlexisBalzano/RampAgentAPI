const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const redisService = require('./redisService');

const AIRPORTS_DIR = path.join(__dirname, '..', 'data', 'airports');

// Airport configs and the global config are static between version bumps, but
// the datafeed loop needs them once per aircraft. Going to Redis (round trip +
// JSON.parse of files up to ~190 kB) on every lookup dominated the cycle, so
// they are held in process and dropped explicitly when a version bump lands.
const airportCache = new Map(); // ICAO -> config object
let configCache = null;

// getAirportList() is a readdirSync; it is called every datafeed cycle and by
// the version poller, so the listing is memoised until the config repo changes.
let airportListCache = null;
let airportListFailed = false;

/**
 * Reads the airports directory, keeping the last known good listing if it
 * cannot be read.
 *
 * The config lives on a mounted volume populated at container start, so this
 * directory can legitimately be missing or briefly unreadable. Throwing from
 * here reached callers inside timers, where it surfaced as an unhandled
 * rejection and took the whole process down - the API would disappear because
 * a config directory blipped. Degrading instead keeps it serving, and the next
 * tick picks the config back up.
 */
function readAirportList() {
  try {
    const files = fs.readdirSync(AIRPORTS_DIR);
    airportListCache = files
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5).toUpperCase());
    if (airportListFailed) {
      logger.info(`Airport config directory readable again (${airportListCache.length} airports)`, {
        category: 'System',
      });
      airportListFailed = false;
    }
    return airportListCache;
  } catch (err) {
    // Warn once per outage rather than every ten seconds.
    if (!airportListFailed) {
      logger.error(
        `Cannot read airport config directory ${AIRPORTS_DIR}: ${err.message} - keeping ${airportListCache ? airportListCache.length + ' known airports' : 'no airports'}`,
        { category: 'System' }
      );
      airportListFailed = true;
    }
    return airportListCache;
  }
}

exports.getAirportList = () => {
  if (airportListCache) return airportListCache;
  return readAirportList() || [];
};

// Re-reads the directory, picking up airports added since startup.
exports.refreshAirportList = () => readAirportList() || [];

exports.getAirportListAndCoordinates = async () => {
  // Return a list of available airport ICAO codes and coordinates based on existing JSON files
  const icaoList = this.getAirportList();
  const airports = [];

  for (const icao of icaoList) {
    const airportData = await this.getAirportConfig(icao);
    if (airportData) {
      const coordinatesStr = airportData.Coordinates || "";
      const parts = coordinatesStr.split(':');
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        airports.push({
          name: icao,
          coords: [lat, lon],
          // Capacity, so clients can show occupancy as a share of the airport
          // rather than a raw count.
          standCount: airportData.Stands
            ? Object.keys(airportData.Stands).length
            : 0
        });
      }
    }
  }
  return airports;
};

exports.getAllStands = async () => {
  // Return a list of all stands from all airport JSON files
  const icaoList = this.getAirportList();
  const stands = [];

  for (const icao of icaoList) {
    const airportData = await this.getAirportConfig(icao);
    if (!airportData) continue;

    const standsObj = airportData.Stands;
    if (standsObj && typeof standsObj === 'object') {
      for (const [standName, standDef] of Object.entries(standsObj)) {
        const coordinatesStr = (standDef && standDef.Coordinates) ? String(standDef.Coordinates) : "";
        const parts = coordinatesStr.split(':').map(s => s.trim());
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        const radius = (parts.length > 2) ? parseFloat(parts[2]) : 15;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          stands.push({
            name: `${icao}-${standName}`, // include ICAO to avoid duplicate names across airports
            icao: icao,
            coords: [lat, lon],
            radius: radius,
            schengen: standDef.Schengen || "",
            apron: standDef.Apron || false,
          });
        }
      }
    }
  }
  return stands;
};

exports.getStandsByIcao = async (icao) => {
  // Return the list of all stands of a specific airport ICAO
  const airportConfig = await this.getAirportConfig(icao);
  return airportConfig ? airportConfig.Stands : null;
};

exports.getConfig = async () => {
  if (configCache) return configCache;
  const data = await redisService.getConfig();
  if (data) configCache = data;
  return data;
};

// Synchronous read of the already-cached global config (null when never loaded).
exports.peekConfig = () => configCache;

exports.getAirportConfig = async (icao) => {
  const cached = airportCache.get(icao);
  if (cached !== undefined) return cached;

  const data = await redisService.getAirportConfig(icao);
  // Cache negatives too: a missing/invalid ICAO otherwise retries Redis and the
  // filesystem for every aircraft that reports it.
  airportCache.set(icao, data);
  return data;
};

// Synchronous read of an already-cached airport config (undefined when not loaded).
exports.peekAirportConfig = (icao) => airportCache.get(icao);

exports.checkAirportVersion = async (icao) => {
  return await redisService.checkAndUpdateVersion(icao);
};

// Drop in-process copies so the next read picks up a new config version.
exports.invalidateAirport = (icao) => {
  airportCache.delete(icao);
};

exports.invalidateConfig = () => {
  configCache = null;
};

exports.invalidateAll = () => {
  airportCache.clear();
  configCache = null;
  airportListCache = null;
};
