/**
 * Shared test setup: a silent logger in place of the real one (which opens the
 * SQLite log database), and an in-memory airport/config source in place of the
 * config repo. Require this before anything from services/ or controllers/.
 */
const Module = require("module");

const logged = [];
const loggerPath = require.resolve("../../utils/logger");
const stub = new Module(loggerPath);
stub.filename = loggerPath;
stub.loaded = true;
stub.exports = {
  info: (message, tags) => logged.push({ level: "info", message, tags }),
  warn: (message, tags) => logged.push({ level: "warn", message, tags }),
  error: (message, tags) => logged.push({ level: "error", message, tags }),
  getRecentLogs: () => [],
  cleanupOldLogs: () => {},
  flush: () => {},
};
require.cache[loggerPath] = stub;

const airportService = require("../../services/airportService");
const airportIndex = require("../../services/airportIndex");

const airports = new Map(); // ICAO -> raw config
let config = null;

airportService.getConfig = async () => config;
airportService.getAirportList = () => [...airports.keys()];
airportService.getAirportConfig = async (icao) => airports.get(icao) || null;

const baseConfig = {
  max_alt: 45000,
  max_distance: 1000,
  AircraftWingspans: { A320: 35.8, B738: 35.9, A333: 60.3, B744: 64.4, C172: 11, EC35: 10.2 },
  CargoOperator: ["FDX"],
  Helicopters: ["EC35"],
  Military: [],
  GeneralAviation: ["C172"],
};

/** Installs airports (raw configs) and the global config for one test file. */
function useAirports(raws, overrides = {}) {
  airports.clear();
  for (const raw of raws) airports.set(raw.ICAO, raw);
  config = { ...baseConfig, ...overrides };
  airportIndex.invalidateAll();
  return { config, derived: airportIndex.deriveConfig(config) };
}

/** Empties the stand registry between tests. */
function clearRegistry(registry) {
  for (const s of registry.getAllAssigned()) registry.removeAssigned(s);
  for (const s of registry.getAllOccupied()) registry.removeOccupied(s);
  for (const s of registry.getAllBlocked()) registry.removeBlocked(s);
}

/** A stand definition in the config-file format. */
function stand(lat, extra = {}) {
  return { Coordinates: `${lat}:5.0:25`, ...extra };
}

module.exports = { logged, useAirports, clearRegistry, stand };
