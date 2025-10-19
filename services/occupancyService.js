const { info, warn, error } = require("../utils/logger");
const airportService = require("./airportService");
const path = require("path");
const fs = require("fs");
const { get } = require("http");

// Cache for parsed coordinates to avoid repeated string splitting
const coordinateCache = new Map(); // key: "lat:lon:alt" -> { lat, lon, radius }

// Helper to parse and cache coordinates
function parseCoordinates(coordString, defaultRadius = 30) {
  if (!coordString) return null;
  
  let cached = coordinateCache.get(coordString);
  if (cached) return cached;
  
  const parts = String(coordString).split(":");
  if (parts.length < 2) return null;
  
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  
  if (isNaN(lat) || isNaN(lon)) return null;
  
  const radius = parts[2] ? parseFloat(parts[2]) : defaultRadius;
  
  cached = { lat, lon, radius };
  coordinateCache.set(coordString, cached);
  
  return cached;
}

class Stand {
  constructor(name, icao, callsign) {
    this.name = name;
    this.icao = icao;
    this.callsign = callsign;
    this.timestamp = Date.now();
  }

  // Hash function for the Stand class
  key() {
    return `${this.icao}:${this.name}`;
  }

  equals(other) {
    return (
      this.icao === other.icao &&
      this.name === other.name &&
      this.callsign === other.callsign
    );
  }
}

class StandRegistry {
  constructor() {
    this.occupied = new Map(); // key -> Stand
    this.blocked = new Map(); // key -> Stand
  }

  addOccupied(stand) {
    this.occupied.set(stand.key(), stand);
  }

  removeOccupied(stand) {
    this.occupied.delete(stand.key());
  }

  addBlocked(stand) {
    this.blocked.set(stand.key(), stand);
  }

  removeBlocked(stand) {
    this.blocked.delete(stand.key());
  }

  isOccupied(icao, name) {
    return this.occupied.has(`${icao}:${name}`);
  }

  isBlocked(icao, name) {
    return this.blocked.has(`${icao}:${name}`);
  }

  getAllOccupied() {
    return Array.from(this.occupied.values());
  }

  getAllBlocked() {
    return Array.from(this.blocked.values());
  }

  clearExpired(predicateFn) {
    // e.g. remove old stands if needed
    for (const [key, stand] of this.occupied) {
      if (predicateFn(stand)) {
        this.occupied.delete(key);
        warn(
          `Clearing expired occupied stand ${stand.name} at ${stand.icao} for ${stand.callsign}`
        );
      }
    }
    for (const [key, stand] of this.blocked) {
      if (predicateFn(stand)) {
        this.blocked.delete(key);
        warn(
          `Clearing expired blocked stand ${stand.name} at ${stand.icao} for ${stand.callsign}`
        );
      }
    }
  }
}

const registry = new StandRegistry();

const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const kPi = 3.141592653589793;
  const kR = 6371000.0;
  const rad = (d) => (d * kPi) / 180.0;
  const lat1Rad = rad(lat1);
  const lon1Rad = rad(lon1);
  const lat2Rad = rad(lat2);
  const lon2Rad = rad(lon2);
  const dLat = lat2Rad - lat1Rad;
  const dLon = lon2Rad - lon1Rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return kR * c;
};

const isAircraftOnStand = async (callsign, ac, airportSet, airportConfigCache) => {
  if (!ac || !ac.origin || !ac.position) {
    return "";
  }

  // Find current airport
  for (const airport of airportSet) {
    try {
      // Use cached airport config
      let airportJson = airportConfigCache.get(airport);
      if (!airportJson) {
        airportJson = await airportService.getAirportConfig(airport);
        if (airportJson) {
          airportConfigCache.set(airport, airportJson);
        }
      }
      
      if (airportJson && airportJson.Coordinates && airportJson.ICAO) {
        const coords = parseCoordinates(airportJson.Coordinates, 5000);
        if (!coords) continue;
        
        const aircraftDist = haversineMeters(
          ac.position.lat,
          ac.position.lon,
          coords.lat,
          coords.lon
        );
        if (aircraftDist <= coords.radius) {
          ac.origin = airportJson.ICAO;
          break;
        }
      }
    } catch (err) {
      // Skip this airport if config cannot be loaded
      warn(`Could not load config for airport ${airport}: ${err.message}`);
      continue;
    }
  }
  
  // If still N/A after checking all airports, traffic is not of interest
  if (ac.origin === "N/A") {
    return "";
  }
  
  if (!airportSet.has(ac.origin)) {
    return "";
  }

  // Load airport data from cache or service
  let airportData = airportConfigCache.get(ac.origin);
  if (!airportData) {
    airportData = await airportService.getAirportConfig(ac.origin);
    if (airportData) {
      airportConfigCache.set(ac.origin, airportData);
    }
  }
  
  if (!airportData || !airportData.Stands) {
    return "";
  }

  for (const [standName, standDef] of Object.entries(airportData.Stands)) {
    if (!standDef.Coordinates) continue;
    
    const coords = parseCoordinates(standDef.Coordinates, 30);
    if (!coords) continue;

    const aircraftDist = haversineMeters(
      ac.position.lat,
      ac.position.lon,
      coords.lat,
      coords.lon
    );

    if (aircraftDist <= coords.radius) {
      return standName;
    }
  }
  return "";
};

const blockStands = (standDef, icao, callsign, standName) => {
  if (standDef && standDef.Block && Array.isArray(standDef.Block)) {
    for (const blockedStandName of standDef.Block) {
      const blockedStand = new Stand(
        blockedStandName,
        icao || "UNKNOWN",
        callsign
      );
      registry.addBlocked(blockedStand);
    }
  }
};

function isConcernedArrival(callsign, ac, config, airportSet) {
  if (!ac || !ac.destination || !ac.position) {
    return false;
  }
  if (ac.position.alt > config.max_alt) {
    return false;
  }
  if (ac.position.dist > config.max_distance) {
    return false;
  }
  if (!airportSet.has(ac.destination)) {
    return false;
  }
  return true;
}

function isSchengen(origin, destination) {
  if (!origin || !destination) return false;
  const originPrefix = origin.substring(0, 2).toUpperCase();
  const destPrefix = destination.substring(0, 2).toUpperCase();
  return isSchengenPrefix(originPrefix) && isSchengenPrefix(destPrefix);
}

function isSchengenPrefix(prefix) {
  return (
    prefix == "LF" || // France
    prefix == "LS" || // Switzerland
    prefix == "ED" || // Germany (civil)
    prefix == "ET" || // Germany (military)
    prefix == "LO" || // Austria
    prefix == "EB" || // Belgium
    prefix == "EL" || // Luxembourg
    prefix == "EH" || // Netherlands
    prefix == "EK" || // Denmark
    prefix == "ES" || // Sweden
    prefix == "EN" || // Norway
    prefix == "EF" || // Finland
    prefix == "EE" || // Estonia
    prefix == "EV" || // Latvia
    prefix == "EY" || // Lithuania
    prefix == "EP" || // Poland
    prefix == "LK" || // Czech Republic
    prefix == "LZ" || // Slovakia
    prefix == "LH" || // Hungary
    prefix == "LJ" || // Slovenia
    prefix == "LD" || // Croatia
    prefix == "LI" || // Italy
    prefix == "LG" || // Greece
    prefix == "LE" || // Spain
    prefix == "LP" || // Portugal
    prefix == "LM" || // Malta
    prefix == "BI" || // Iceland
    prefix == "LB" || // Bulgaria
    prefix == "LR"
  ); // Romania
}

function getAircraftWingspan(config, aircraftType) {
  if (!aircraftType || typeof aircraftType !== "string") return 81;
  const wingspan = config.AircraftWingspans[aircraftType.toUpperCase()];
  if (!wingspan) {
    warn(`Unknown wingspan for aircraft type ${aircraftType}`);
    return 81; // default if unknown
  }
  return wingspan;
}

function getAircraftCode(config, aircraftType) {
  const wingspan = getAircraftWingspan(config, aircraftType);
  if (wingspan < 15.0) return "A";
  if (wingspan < 24.0) return "B";
  if (wingspan < 36.0) return "C";
  if (wingspan < 52.0) return "D";
  if (wingspan < 65.0) return "E";
  if (wingspan < 80.0) return "F";
  return "F"; // default to F if larger
}

function getAircraftUse(config, callsign, aircraftType) {
  if (callsign.length < 3) {
    return "P"; // general aviation
  }

  if (callsign[1] === "-" || callsign[2] === "-") {
    return "P"; // general aviation
  }

  if (config.CargoOperator.includes(callsign.substring(0, 3).toUpperCase())) {
    return "C"; // cargo
  }

  if (config.Helicopters.includes(aircraftType.toUpperCase())) {
    return "H"; // helicopter
  }

  if (config.Military.includes(aircraftType.toUpperCase())) {
    return "M"; // military
  }

  if (config.GeneralAviation.includes(aircraftType.toUpperCase())) {
    return "P"; // general aviation
  }

  return "A"; // default to airliner
}

function assignStand(airportConfig, config, callsign, ac) {
  // Check if aircraft already has a stand assigned
  const assignedStand = registry
    .getAllOccupied()
    .find((s) => s.callsign === callsign);
  const blockedStands = registry
    .getAllBlocked()
    .filter((s) => s.callsign === callsign);
  if (assignedStand) {
    assignedStand.timestamp = Date.now();
    for (const s of blockedStands) {
      s.timestamp = Date.now();
    }
    return;
  }

  const schengen = isSchengen(ac.origin, ac.destination);
  const code = getAircraftCode(config, ac.aircraftType);
  const use = getAircraftUse(config, callsign, ac.aircraftType);

  let availableStandList = [];

  for (const [standName, standDef] of Object.entries(airportConfig.Stands)) {
    // Implements checks
    if (standDef.Use && standDef.Use !== use) {
      continue;
    }
    if (standDef.Code && standDef.Code.includes(code) === false) {
      continue;
    }
    if (standDef.Schengen && standDef.Schengen !== schengen) {
      continue;
    }
    if (standDef.Countries && Array.isArray(standDef.Countries)) {
      const originPrefix = ac.origin.substring(0, 2).toUpperCase();
      if (!standDef.Countries.includes(originPrefix)) {
        continue;
      }
    }
    if (standDef.Callsigns && Array.isArray(standDef.Callsigns)) {
      if (
        !standDef.Callsigns.includes(callsign.substring(0, 3).toUpperCase())
      ) {
        continue;
      }
    }
    if (registry.isOccupied(ac.destination, standName)) {
      continue;
    }
    if (registry.isBlocked(ac.destination, standName)) {
      continue;
    }
    availableStandList.push(standDef);
  }

  // Priority filtering
  let anyPriority = false;
  let lowestPriority = Number.MAX_SAFE_INTEGER;
  for (const standDef of availableStandList) {
    if (standDef.Priority && Number.isInteger(standDef.Priority)) {
      anyPriority = true;
      if (standDef.Priority < lowestPriority) {
        lowestPriority = standDef.Priority;
      }
    }
  }

  if (anyPriority) {
    availableStandList = availableStandList.filter(
      (standDef) => standDef.Priority && standDef.Priority === lowestPriority
    );
  }

  if (availableStandList.length > 0) {
    let bestMaxCode = "F";
    let anyCode = false;
    let selectedStandDef = availableStandList[0];
    for (const standDef of availableStandList) {
      if (standDef.Code) {
        anyCode = true;
        const maxCode = standDef.Code.split("").reduce((a, b) =>
          a > b ? a : b
        );
        if (maxCode < bestMaxCode) {
          bestMaxCode = maxCode;
          selectedStandDef = standDef;
        }
      }
    }

    const standName = Object.keys(airportConfig.Stands).find(
      (name) => airportConfig.Stands[name] === selectedStandDef
    );
    const stand = new Stand(standName, airportConfig.ICAO, callsign);
    if (!selectedStandDef.Apron || selectedStandDef.Apron === false) {
      registry.addOccupied(stand);
      blockStands(selectedStandDef, ac.destination, callsign, standName);
    }
    return;
  }
  warn(`No available stands found for ${callsign} at ${ac.destination}`);
}

clientReportParse = async (aircrafts) => {
  // Parse JSON of all the reported aircraft positions/states
  // Use Set for O(1) lookup performance instead of Array.includes()
  let airportSet = new Set();
  const airportConfigCache = new Map(); // Cache airport configs to avoid repeated loads
  
  try {
    const al = airportService.getAirportList();
    if (Array.isArray(al)) {
      airportSet = new Set(al);
    }
  } catch (e) {
    error(`Error loading airport list: ${e.message}`);
    // ignore - we'll fallback to checking the file directly
  }

  // Handle onGround aircraft
  for (const [callsign, ac] of Object.entries(aircrafts.onGround || {})) {
    const previouslyOnStand = registry
      .getAllOccupied()
      .find((s) => s.callsign === callsign);

    if (previouslyOnStand) {
      registry.removeOccupied(previouslyOnStand);

      // Unblock any stands that were blocked due to this stand
      const standsToUnblock = registry
        .getAllBlocked()
        .filter((s) => s.callsign === callsign);

      standsToUnblock.forEach((s) => {
        registry.removeBlocked(s);
      });
    }

    const aircraftOnStand = await isAircraftOnStand(callsign, ac, airportSet, airportConfigCache);
    if (aircraftOnStand) {
      ac.stand = aircraftOnStand;
      // Check if the stand is an apron by looking into json
      // Use cached config
      let airportJson = airportConfigCache.get(ac.origin);
      if (!airportJson) {
        airportJson = await airportService.getAirportConfig(ac.origin);
        if (airportJson) {
          airportConfigCache.set(ac.origin, airportJson);
        }
      }
      
      const standDef = airportJson && airportJson.Stands && airportJson.Stands[ac.stand];
      if (standDef && (!standDef.Apron || standDef.Apron === false)) {
        const stand = new Stand(ac.stand, ac.origin || "UNKNOWN", callsign);
        // Remove preceeding entry if any
        registry.removeOccupied(stand);
        registry.addOccupied(stand);

        blockStands(standDef, ac.origin, callsign, ac.stand);
      }
    }
  }

  // get config.json for parameters
  const config = await airportService.getConfig();
  if (!config) {
    error("No config found, skipping assignment");
    return;
  }

  // Handle airborne aircraft - (ie: assign stand if criterias met)
  for (const [callsign, ac] of Object.entries(aircrafts.airborne || {})) {
    // Check Assignement conditions
    if (!isConcernedArrival(callsign, ac, config, airportSet)) {
      continue;
    }

    // Aircraft meets requirements for stand assignment
    // Use cached config
    let airportConfig = airportConfigCache.get(ac.destination);
    if (!airportConfig) {
      airportConfig = await airportService.getAirportConfig(ac.destination);
      if (airportConfig) {
        airportConfigCache.set(ac.destination, airportConfig);
      }
    }
    
    if (!airportConfig || !airportConfig.Stands) {
      warn(
        `No stands found for airport ${ac.destination}, skipping assignment`
      );
      continue;
    }

    assignStand(airportConfig, config, callsign, ac);
  }
};

const getGlobalOccupied = () => {
  const now = Date.now();
  const occupied = new Set();

  for (const [_, data] of clients.entries()) {
    if (now - data.lastUpdate < 10_000) {
      data.occupied.forEach((s) => occupied.add(s));
    }
  }

  return Array.from(occupied);
};

function assignStandToPilot(standName, icao, callsign) {
  // Remove any existing assignment
  const existingStand = registry
  .getAllOccupied()
  .filter((s) => s.callsign === callsign);
  existingStand.forEach((existingStand) => {
    registry.removeOccupied(existingStand);
  });
  const blockedStands = registry
  .getAllBlocked()
  .filter((s) => s.callsign === callsign);
  blockedStands.forEach((s) => {
    registry.removeBlocked(s);
  });
  if (standName === "None") {
    info(`Removed stand assignment for ${callsign}`);
    return true;
  }
  if (registry.isOccupied(icao, standName)) {
    warn(
      `Cannot assign stand ${standName} at ${icao} to ${callsign} - already occupied`
    );
    return false;
  }
  if (registry.isBlocked(icao, standName)) {
    warn(
      `Cannot assign stand ${standName} at ${icao} to ${callsign} - already blocked`
    );
    return false;
  }
  const stand = new Stand(standName, icao, callsign);
  registry.addOccupied(stand);
  info(`Manually assigned stand ${standName} at ${icao} to ${callsign}`);
  return true;
}


function standCleanup() {
  // Remove occupied stands if timestamp is older than 2 minutes without update
  const now = Date.now();
  registry.clearExpired((stand) => now - stand.timestamp > 2 * 60 * 1000);
}

setInterval(standCleanup, 60 * 1000); // every minute

// Export everything together
module.exports = {
  Stand,
  registry,
  clientReportParse,
  assignStandToPilot,
  getGlobalOccupied,
  getAllOccupied: registry.getAllOccupied.bind(registry),
  getAllBlocked: registry.getAllBlocked.bind(registry),
  isOccupied: registry.isOccupied.bind(registry),
  isBlocked: registry.isBlocked.bind(registry),
  isBlocked: registry.isBlocked.bind(registry),
};
