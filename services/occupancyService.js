const { info } = require("../utils/logger");
const { getAirportList, getConfig, getAirportConfigPath } = require("./airportService");
const path = require("path");
const fs = require("fs");
const { warn } = require("console");
const { get } = require("http");

class Stand {
  constructor(name, icao, callsign) {
    this.name = name;
    this.icao = icao;
    this.callsign = callsign;
  }

  // Hash function for the Stand class
  key() {
    return `${this.icao}:${this.name}:${this.callsign || ""}`;
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
    for (const s of this.occupied.values())
      if (s.icao === icao && s.name === name) return true;
    return false;
  }

  isBlocked(icao, name) {
    for (const s of this.blocked.values())
      if (s.icao === icao && s.name === name) return true;
    return false;
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
      if (predicateFn(stand)) this.occupied.delete(key);
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

const isAircraftOnStand = (ac) => {
  if (!ac || !ac.origin || !ac.position) {
    return "";
  }

  let airportList = [];
  try {
    const al = getAirportList();
    if (Array.isArray(al)) {
      airportList = al;
      info(`Loaded airport list: ${airportList.join(", ")}`);
    }
  } catch (e) {
    info(`Error loading airport list: ${e.message}`);
    // ignore - we'll fallback to checking the file directly
  }

  // Find current airport
  info(`Aircraft has origin N/A, trying to determine from position...`);
  for (const airport of airportList) {
    try {
      const airportJson = require(getAirportConfigPath(airport));
      if (airportJson && airportJson.Coordinates && airportJson.ICAO) {
        const parts = String(airportJson.Coordinates).split(":");
        if (parts.length < 2) continue;
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        // Validate coordinates
        if (isNaN(lat) || isNaN(lon)) continue;
        const radius = parts[2] ? parseFloat(parts[2]) : 5000; // default 5km
        const aircraftDist = haversineMeters(
          ac.position.lat,
          ac.position.lon,
          lat,
          lon
        );
        if (aircraftDist <= radius) {
          ac.origin = airportJson.ICAO;
          info(
            `Found aircraft at airport ${
              airportJson.ICAO
            } (distance: ${aircraftDist.toFixed(0)}m)`
          );
          break;
        } else {
          info(
            `Aircraft not at airport ${
              airportJson.ICAO
            } (distance: ${aircraftDist.toFixed(0)}m)`
          );
        }
      }
    } catch (error) {
      // Skip this airport if config cannot be loaded
      info(`Could not load config for airport ${airport}: ${error.message}`);
      ac.origin = "N/A";
      continue;
    }

    // If still N/A after checking all airports
    if (ac.origin === "N/A") {
      info(
        `Could not determine airport for aircraft at position ${ac.position.lat}, ${ac.position.lon}`
      );
    }
  }

  if (!airportList.includes(ac.origin)) {
    return "";
  }

  // Resolve airports directory relative to this module to avoid process.cwd() issues
  const airportsDir = path.join(__dirname, "..", "data", "airports");
  const airportPath = path.join(airportsDir, `${ac.origin}.json`);
  if (!fs.existsSync(airportPath)) {
    return "";
  }

  // Load airport data; Stands is an object keyed by stand name
  const airportData = require(airportPath);
  const airportJson = require(getAirportConfigPath(ac.origin));
  if (!airportData || !airportData.Stands) {
    return "";
  }

  for (const [standName, standDef] of Object.entries(airportData.Stands)) {
    // Parse Coordinates "lat:lon:alt" (alt optionally used as radius)
    if (!standDef.Coordinates) continue;
    const parts = String(standDef.Coordinates).split(":");
    if (parts.length < 2) continue;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const coordRadius = parts[2] ? parseFloat(parts[2]) : undefined;

    const radius = coordRadius || 30;

    const aircraftDist = haversineMeters(
      ac.position.lat,
      ac.position.lon,
      lat,
      lon
    );

    if (aircraftDist <= radius) {
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
        info(
          `Registering blocked stand ${blockedStandName} at ${icao} due to occupation of ${standName} for ${callsign}`
        );
        registry.addBlocked(blockedStand);
    }
  }
};

function isConcernedArrival(callsign, ac, config) {
  if (!ac || !ac.destination || !ac.position) {
    return false;
  }
  if (ac.position.alt > config.max_alt) {
    info(`Aircraft ${callsign} is above maximum altitude at ${ac.position.alt}`);
    return false;
  }
  if (ac.position.dist > config.max_distance) {
    info(`Aircraft ${callsign} is beyond maximum distance at ${ac.position.dist}`);
    return false;
  }
  const airportList = getAirportList();
  if (!airportList.includes(ac.destination)) {
    info(`Aircraft ${callsign} is arriving at unsupported airport ${ac.destination}`);
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
  return prefix == "LF" || // France
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
			prefix == "LR";   // Romania
}

function getAircraftCode(config, aircraftType) {
  if (!aircraftType || typeof aircraftType !== "string") return "F";
  const wingspan = config.AircraftWingspans[aircraftType.toUpperCase()];
  if (!wingspan) return "F"; // default if unknown
  if (wingspan < 15.0) return "A";
	if (wingspan < 24.0) return "B";
	if (wingspan < 36.0) return "C";
	if (wingspan < 52.0) return "D";
	if (wingspan < 65.0) return "E";
	if (wingspan < 80.0) return "F";
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

//TODO: refactor to use priority system if multiple stands match
function assignStand(airportConfig, config, callsign, ac) {
  // Check if aircraft already has a stand assigned
  const assignedStand = registry.getAllOccupied().find(s => s.callsign === callsign && s.icao === ac.destination);
  if (assignedStand) {
    info(`Aircraft ${callsign} already assigned to stand ${assignedStand.name} at ${ac.destination}`);
    return;
  }

  const schengen = isSchengen(ac.origin, ac.destination);
  if (schengen) {
    info(`Aircraft ${callsign} is a Schengen arrival at ${ac.destination}`);
  }
  const code = getAircraftCode(config, ac.aircraftType);
  info(`Aircraft ${callsign} has aircraft type ${ac.aircraftType} (code: ${code})`);
  const use = getAircraftUse(config, callsign, ac.aircraftType);
  info(`Aircraft ${callsign} has use type ${use}`);

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
      if (!standDef.Callsigns.includes(callsign.substring(0, 3).toUpperCase())) {
        continue;
      }
    }

    if (!registry.isOccupied(ac.destination, standName)) {
      if (!registry.isBlocked(ac.destination, standName)) {
        const stand = new Stand(standName, ac.destination, callsign);
        info(
          `Assigning stand ${standName} at ${ac.destination} to ${callsign}`
        );
        if (!standDef.Apron || standDef.Apron === false) {
          registry.addOccupied(stand);
          blockStands(standDef, ac.destination, callsign, standName);
        }
        return;
      }
    }
  }
  warn(`No available stands found for ${callsign} at ${ac.destination}`);
}

clientReportParse = (aircrafts) => {
  // Parse JSON of all the reported aircraft positions/states

  // Handle onGround aircraft
  for (const [callsign, ac] of Object.entries(aircrafts.onGround || {})) {
    const aircraftOnStand = isAircraftOnStand(ac);
    if (aircraftOnStand) {
      ac.stand = aircraftOnStand;
      info(`Aircraft ${callsign} is on stand ${ac.stand} at ${ac.origin}`);
      // Check if the stand is an apron by looking into json
      const airportJson = require(getAirportConfigPath(ac.origin));
      const standDef = airportJson.Stands && airportJson.Stands[ac.stand];
      if (standDef && standDef.Apron && standDef.Apron === true) {
        info(`Stand ${ac.stand} at ${ac.origin} is an apron.`);
      } else {
        const stand = new Stand(ac.stand, ac.origin || "UNKNOWN", callsign);
        info(
          `Registering occupied stand ${ac.stand} at ${ac.origin} for ${callsign}`
        );
        registry.addOccupied(stand);
        blockStands(standDef, ac.origin, callsign, ac.stand);
      }
    }
  }

  // get config.json for parameters
  const config = getConfig();
  if (!config) {
    info("No config found, skipping assignment");
    return;
  }
  
  // Handle airborne aircraft - (ie: assign stand if criterias met)
  for (const [callsign, ac] of Object.entries(aircrafts.airborne || {})) {
    // Check Assignement conditions
    if (!isConcernedArrival(callsign, ac, config)) {
      continue;
    }
  
    // Aircraft meets requirements for stand assignment
    info(
      `Processing stand assignment for ${callsign} arriving at ${ac.destination}`
    );
  
    const airportConfig = require(getAirportConfigPath(ac.destination));
    if (!airportConfig || !airportConfig.Stands) {
      info(`No stands found for airport ${ac.destination}, skipping assignment`);
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

// Export everything together
module.exports = {
  Stand,
  registry,
  clientReportParse,
  getGlobalOccupied,
};
