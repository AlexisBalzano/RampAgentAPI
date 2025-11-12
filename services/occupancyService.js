const { info, warn, error } = require("../utils/logger");
const airportService = require("./airportService");
const { haversineMeters } = require("../utils/utils");

// Cache for parsed coordinates to avoid repeated string splitting
const coordinateCache = new Map(); // key: "lat:lon:alt" -> { lat, lon, radius }

// Cache to avoid log flooding when unknown aircraft types are encountered
const aircraftTypeCache = new Set();

setInterval(() => {
  coordinateCache.clear();
  aircraftTypeCache.clear();
}, 60 * 60 * 1000); // Clear every hour

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
  constructor(name, icao, callsign, remark = "") {
    this.name = name;
    this.icao = icao;
    this.callsign = callsign;
    this.remark = remark;
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

  toJSON() {
    return {
      name: this.name,
      icao: this.icao,
      callsign: this.callsign,
      remark: this.remark,
      timestamp: this.timestamp,
    };
  }
}

class StandRegistry {
  constructor() {
    this.occupied = new Map(); // key -> Stand
    this.assigned = new Map(); // key -> Stand
    this.blocked = new Map(); // key -> Stand
    this.apron = new Map(); // key -> Stand
  }

  addOccupied(stand) {
    this.occupied.set(stand.key(), stand);
  }

  removeOccupied(stand) {
    this.occupied.delete(stand.key());
  }

  addAssigned(stand) {
    this.assigned.set(stand.key(), stand);
  }

  removeAssigned(stand) {
    this.assigned.delete(stand.key());
  }

  addBlocked(stand) {
    this.blocked.set(stand.key(), stand);
  }

  removeBlocked(stand) {
    this.blocked.delete(stand.key());
  }

  addApron(stand) {
    this.apron.set(stand.key(), stand);
  }

  removeApron(stand) {
    this.apron.delete(stand.key());
  }

  isOccupied(icao, name) {
    return this.occupied.has(`${icao}:${name}`);
  }

  isAssigned(icao, name) {
    return this.assigned.has(`${icao}:${name}`);
  }

  isBlocked(icao, name) {
    return this.blocked.has(`${icao}:${name}`);
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

  getAllApron() {
    return Array.from(this.apron.values());
  }

  clearExpired(predicateFn) {
    // e.g. remove old stands if needed
    for (const [key, stand] of this.occupied) {
      if (predicateFn(stand)) {
        this.occupied.delete(key);
        warn(
          `Clearing expired occupied stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
          {
            category: "Stand Management",
            callsign: stand.callsign,
            icao: stand.icao,
          }
        );
      }
    }
    for (const [key, stand] of this.assigned) {
      if (predicateFn(stand)) {
        this.assigned.delete(key);
        warn(
          `Clearing expired assigned stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
          {
            category: "Stand Management",
            callsign: stand.callsign,
            icao: stand.icao,
          }
        );
      }
    }
    for (const [key, stand] of this.blocked) {
      if (predicateFn(stand)) {
        this.blocked.delete(key);
        warn(
          `Clearing expired blocked stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
          {
            category: "Stand Management",
            callsign: stand.callsign,
            icao: stand.icao,
          }
        );
      }
    }
    for (const [key, stand] of this.apron) {
      if (predicateFn(stand)) {
        this.apron.delete(key);
        warn(
          `Clearing expired Apron stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
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

const isAircraftOnStand = async (
  config,
  ac,
  airportSet,
  airportConfigCache
) => {
  if (!ac || !ac.latitude || !ac.longitude) {
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
          ac.latitude,
          ac.longitude,
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
      warn(`Could not load config for airport ${airport}: ${err.message}`, {
        category: "System",
        icao: airport,
      });
      continue;
    }
  }

  // If still N/A after checking all airports, traffic is not of interest
  if (!ac.origin || ac.origin === "N/A" || ac.origin === "") {
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
      ac.latitude,
      ac.longitude,
      coords.lat,
      coords.lon
    );

    if (aircraftDist <= coords.radius) {
      if (!ac.flight_plan || !ac.flight_plan.aircraft_short || ac.flight_plan.aircraft_short === "UNKNOWN" || ac.flight_plan.aircraft_short === "") {
        if (ac.flight_plan) {
          warn(
            `Aircraft ${ac.callsign} on ground at ${ac.origin} has unknown type`,
            { category: "Missing Data", callsign: ac.callsign, icao: ac.origin }
          );
        }
        return standName;
      }
      if (!standDef.Block) {
        return standName;
      }

      // Convert Block array to Set for easier manipulation
      const potentialStands = new Set(standDef.Block);
      potentialStands.add(standName); // Include the original stand as potential
      // Remove stands where aircraft is not located
      for (const potentialStandName of potentialStands) {
        const potentialStandDef = airportData.Stands[potentialStandName];
        if (!potentialStandDef || !potentialStandDef.Coordinates) {
          potentialStands.delete(potentialStandName);
          continue;
        }

        const coords = parseCoordinates(potentialStandDef.Coordinates, 30);
        if (!coords) {
          potentialStands.delete(potentialStandName);
          continue;
        }

        const dist = haversineMeters(
          ac.latitude,
          ac.longitude,
          coords.lat,
          coords.lon
        );

        if (dist > coords.radius) {
          potentialStands.delete(potentialStandName);
        }
      }

      // We have a list of all stands on which the aircraft is located
      // Now select the most appropriate one based on criteria
      let bestPriority = Number.MAX_SAFE_INTEGER;

      for (const potentialStandName of potentialStands) {
        const wingspan = getAircraftWingspan(config, ac.flight_plan.aircraft_short);
        const aircraftCode = getAircraftCode(wingspan);
        const potentialStandDef = airportData.Stands[potentialStandName];

        // Remove stands that don't match aircraft code
        if (
          potentialStandDef.Code &&
          !potentialStandDef.Code.includes(aircraftCode)
        ) {
          potentialStands.delete(potentialStandName);
          continue;
        }

        // Find the lowest priority
        const priority = potentialStandDef.Priority || Number.MAX_SAFE_INTEGER;
        if (priority < bestPriority) {
          bestPriority = priority;
        }
      }

      // Keep only stands with the lowest priority
      for (const potentialStandName of potentialStands) {
        const potentialStandDef = airportData.Stands[potentialStandName];
        const priority = potentialStandDef.Priority || Number.MAX_SAFE_INTEGER;
        if (priority > bestPriority) {
          potentialStands.delete(potentialStandName);
        }
      }
      // If no potential stands remain, return the original stand
      if (potentialStands.size === 0) {
        return standName;
      }

      // Return first stand from potential stands
      return potentialStands.values().next().value;
    }
  }
  return "";
};

const blockStands = (standDef, icao, callsign) => {
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

async function getAirportCoordinates(icao) {
  const airport = await airportService.getAirportConfig(icao);
  if (!airport || !airport.Coordinates) {
    error(`Cannot retrieve coordinates for airport ${icao}`, {
      category: "Assignation",
      icao: icao,
    });
    return null;
  }
  let coordinates = parseCoordinates(airport.Coordinates, 5000);
  return coordinates;
}

async function calculateRemainingDistance(ac) {
  if (!ac.flight_plan || !ac.flight_plan.arrival || !ac.latitude || !ac.longitude) {
    return Number.MAX_SAFE_INTEGER;
  }
  const destCoords = await getAirportCoordinates(ac.flight_plan.arrival);
  if (!destCoords) {
    return Number.MAX_SAFE_INTEGER;
  }
  const dist = haversineMeters(
    ac.latitude,
    ac.longitude,
    destCoords.lat,
    destCoords.lon
  );
  return dist; // distance in meters
}

async function isConcernedArrival(ac, config, airportSet) {
  if (!ac || !ac.destination || !ac.longitude || !ac.latitude) {
    return false;
  }
  if (ac.altitude > config.max_alt) {
    return false;
  }
  if (!airportSet.has(ac.destination)) {
    return false;
  }
  ac.remainingDistance = await calculateRemainingDistance(ac);
  if (ac.remainingDistance * 0.00053996 > config.max_distance) { // convert to nautical miles
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
  if (
    !aircraftType ||
    typeof aircraftType !== "string" ||
    aircraftType === "ZZZZ"
  )
    return 81;
  const wingspan = config.AircraftWingspans[aircraftType.toUpperCase()];
  if (!wingspan) {
    if (!aircraftTypeCache.has(aircraftType)) {
      warn(`Unknown wingspan for aircraft type ${aircraftType}`, {
        category: "Missing Data",
      });
      aircraftTypeCache.add(aircraftType);
    }
    return 81; // default if unknown
  }
  return wingspan;
}

function getAircraftCode(wingspan) {
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

function shuffleArray(array) {
  const shuffled = [...array]; // Create a copy to avoid mutating original
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; // Swap elements
  }
  return shuffled;
}

function assignStand(airportConfig, config, ac) {
  // Check if aircraft already has a stand assigned
  const assignedStand = registry
    .getAllAssigned()
    .find((s) => s.callsign === ac.callsign);
  const blockedStands = registry
    .getAllBlocked()
    .filter((s) => s.callsign === ac.callsign);
  const apronStands = registry
    .getAllApron()
    .find((s) => s.callsign === ac.callsign);
  if (assignedStand || apronStands) {
    if (assignedStand && (registry.isOccupied(ac.destination, assignedStand.name) || registry.isBlocked(ac.destination, assignedStand.name))) {
      registry.removeAssigned(assignedStand);
    } else {
      if (apronStands) {
        apronStands.timestamp = Date.now();
      } else {
        assignedStand.timestamp = Date.now();
        for (const s of blockedStands) {
          s.timestamp = Date.now();
        }
      }
      return;
    }
  }

  const schengen = isSchengen(ac.origin, ac.destination);
  const wingspan = getAircraftWingspan(config, ac.flight_plan.aircraft_short);
  const code = getAircraftCode(wingspan);
  const use = getAircraftUse(config, ac.callsign, ac.flight_plan.aircraft_short);
  const originPrefix = ac.origin.substring(0, 2).toUpperCase();
  const compagnyPrefix = ac.callsign.substring(0, 3).toUpperCase();

  info(
    `Searching stand for ${ac.callsign} at ${ac.destination} (Use: ${use}, Code: ${code}, Schengen: ${schengen}, Compagny: ${compagnyPrefix}, Origin Country: ${originPrefix}, Wingspan: ${wingspan}m, AircraftType: ${ac.flight_plan.aircraft_short})`,
    { category: "Assignation", callsign: ac.callsign, icao: airportConfig.ICAO }
  );

  let availableStandList = [];

  for (const [standName, standDef] of Object.entries(airportConfig.Stands)) {
    // Implements checks
    if (standDef.Use && standDef.Use.includes(use) === false) {
      continue;
    }
    if (standDef.Code && standDef.Code.includes(code) === false) {
      continue;
    }
    if (standDef.Schengen !== undefined && standDef.Schengen !== schengen) {
      continue;
    }
    if (standDef.Wingspan && standDef.Wingspan < wingspan) {
      continue;
    }
    if (standDef.Countries && Array.isArray(standDef.Countries)) {
      if (!standDef.Countries.includes(originPrefix)) {
        continue;
      }
    }
    if (standDef.Callsigns && Array.isArray(standDef.Callsigns)) {
      if (!standDef.Callsigns.includes(compagnyPrefix)) {
        continue;
      }
    }
    if (standDef.Apron === undefined || standDef.Apron === false) {
      if (registry.isOccupied(ac.destination, standName)) {
        continue;
      }
      if (registry.isAssigned(ac.destination, standName)) {
        continue;
      }
      if (registry.isBlocked(ac.destination, standName)) {
        continue;
      }
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
    let availableStandListShuffled = shuffleArray(availableStandList);
    let selectedStandDef = availableStandListShuffled[0];
    let bestMaxCode = "F";
    for (const standDef of availableStandListShuffled) {
      if (standDef.Code) {
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
    const stand = new Stand(standName, airportConfig.ICAO, ac.callsign);
    info(`Assigning Stand ${standName} to ${ac.callsign}`, {
      category: "Assignation",
      callsign: ac.callsign,
      icao: airportConfig.ICAO,
    });
    if (selectedStandDef.apron === undefined || selectedStandDef.apron === false) {
      registry.addAssigned(stand);
      blockStands(selectedStandDef, ac.destination, ac.callsign);
    } else {
      registry.addApron(stand);
    }
    return;
  }
  warn(`No available stands found for ${ac.callsign} at ${ac.destination}`, {
    category: "Assignation",
    callsign: ac.callsign,
    icao: airportConfig.ICAO,
  });
}

processDatafeed = async (aircrafts) => {
  // Parse JSON of all the reported aircraft positions/states
  let airportSet = new Set();
  const airportConfigCache = new Map(); // Cache airport configs to avoid repeated loads

  try {
    const al = airportService.getAirportList();
    if (Array.isArray(al)) {
      airportSet = new Set(al);
    }
  } catch (e) {
    error(`Error loading airport list: ${e.message}`, {
      category: "Missing Data",
    });
  }

  // get config.json for parameters
  const config = await airportService.getConfig();
  if (!config) {
    error("No config found, skipping assignment", { category: "Missing Data" });
    return;
  }

  // Handle onGround aircraft
  for (let ac of Object.values(aircrafts.onGround || {})) {
    const previouslyOnStand = registry
      .getAllOccupied()
      .find((s) => s.callsign === ac.callsign);

    if (previouslyOnStand) {
      registry.removeOccupied(previouslyOnStand);

      // Unblock any stands that were blocked due to this stand
      const standsToUnblock = registry
        .getAllBlocked()
        .filter((s) => s.callsign === ac.callsign);

      standsToUnblock.forEach((s) => {
        registry.removeBlocked(s);
      });
    }

    const aircraftOnStand = await isAircraftOnStand(
      config,
      ac,
      airportSet,
      airportConfigCache
    );
    if (aircraftOnStand) {
      ac.stand = aircraftOnStand;
      // Use cached config
      let airportJson = airportConfigCache.get(ac.origin);
      if (!airportJson) {
        airportJson = await airportService.getAirportConfig(ac.origin);
        if (airportJson) {
          airportConfigCache.set(ac.origin, airportJson);
        }
      }

      // remove any existing occupied / blocked / assigned stands for this callsign
      const existingOccupied = registry
        .getAllOccupied()
        .filter((s) => s.callsign === ac.callsign);
      existingOccupied.forEach((s) => {
        registry.removeOccupied(s);
      });
      const existingBlocked = registry
        .getAllBlocked()
        .filter((s) => s.callsign === ac.callsign);
      existingBlocked.forEach((s) => {
        registry.removeBlocked(s);
      });
      const existingAssigned = registry
        .getAllAssigned()
        .filter((s) => s.callsign === ac.callsign);
      existingAssigned.forEach((s) => {
        registry.removeAssigned(s);
      });

      const standDef =
        airportJson && airportJson.Stands && airportJson.Stands[ac.stand];
      if (
        standDef &&
        (standDef.Apron === undefined || standDef.Apron === false)
      ) {
        let aircraftCode = "UNKNOWN";
        if (ac.flight_plan && ac.flight_plan.aircraft_short && ac.flight_plan.aircraft_short !== "UNKNOWN" && ac.flight_plan.aircraft_short !== "") {
          aircraftCode = getAircraftCode(
            getAircraftWingspan(config, ac.flight_plan.aircraft_short)
          );
        }
        let remark = "";
        if (standDef.Remark && typeof standDef.Remark === "object") {
          // Iterate through all keys in the Remark object
          for (const [codeList, remarkText] of Object.entries(
            standDef.Remark
          )) {
            // Check if the aircraft code is in this key
            if (codeList.includes(aircraftCode)) {
              remark = remarkText;
              break;
            }
          }
        }
        const stand = new Stand(
          ac.stand,
          ac.origin || "UNKNOWN",
          ac.callsign,
          remark
        );
        // Remove preceeding entry if any
        registry.removeOccupied(stand);
        registry.addOccupied(stand);

        blockStands(standDef, ac.origin, ac.callsign);
      } else {
        registry.addApron(new Stand(ac.stand, ac.origin, ac.callsign));
      }
    }
  }

  // Handle airborne aircraft - (ie: assign stand if criterias met)
  for (let ac of Object.values(aircrafts.airborne || {})) {
    if (!ac.flight_plan) {
      continue;
    }
    ac.origin = ac.flight_plan.departure;
    ac.destination = ac.flight_plan.arrival;
    // Check Assignement conditions
    if (!await isConcernedArrival(ac, config, airportSet)) {
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
        `No stands found for airport ${ac.destination}, skipping assignment`,
        { category: "Assignation", callsign: ac.callsign, icao: ac.destination }
      );
      continue;
    }

    assignStand(airportConfig, config, ac);
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

async function assignStandToPilot(standName, icao, callsign, client) {
  // Remove any existing assignment
  const existingStand = registry
  .getAllAssigned()
  .filter((s) => s.callsign === callsign);
  existingStand.forEach((existingStand) => {
    registry.removeAssigned(existingStand);
  });
  const blockedStands = registry
  .getAllBlocked()
  .filter((s) => s.callsign === callsign);
  blockedStands.forEach((s) => {
    registry.removeBlocked(s);
  });
  const apronStands = registry
  .getAllApron()
  .filter((s) => s.callsign === callsign);
  apronStands.forEach((s) => {
    registry.removeApron(s);
  });
  if (standName === "None") {
    info(`Removed stand assignment for ${callsign}, Requester: ${client}`, {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao
    });
    return {
      action: "free",
      stand: standName,
      callsign: callsign,
      icao: icao,
      message: `Asssigned Stand has been freed from ${callsign}`,
    };
  }
  const standDef = await airportService
    .getAirportConfig(icao)
    .then((airportConfig) => {
      if (airportConfig && airportConfig.Stands && airportConfig.Stands[standName]) {
        return airportConfig.Stands[standName];
      }
      return null;
    });

  if (!standDef) {
    warn(`Stand ${standName} not found at ${icao}, Requester: ${client}`, {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao
    });
    return {
    action: "not_found",
    stand: standName,
    callsign: callsign,
    icao: icao,
    message: `Stand ${standName} does not exist at ${icao}`,
  };
}

  if (standDef.Apron === undefined || standDef.Apron === false) {
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
  const stand = new Stand(standName, icao, callsign);
  registry.addAssigned(stand);
  // Block stands
  blockStands(standDef, icao, callsign);
  info(`Manually assigned stand ${standName} at ${icao} to ${callsign}, Requester: ${client}`, {
    category: "Manual Assign",
    callsign: callsign,
    icao: icao,
  });
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
}

setInterval(standCleanup, 60 * 1000); // every minute

// Export everything together
module.exports = {
  Stand,
  registry,
  processDatafeed,
  assignStandToPilot,
  getGlobalOccupied,
  getAllOccupied: registry.getAllOccupied.bind(registry),
  getAllAssigned: registry.getAllAssigned.bind(registry),
  getAllBlocked: registry.getAllBlocked.bind(registry),
  isOccupied: registry.isOccupied.bind(registry),
  isBlocked: registry.isBlocked.bind(registry),
  isBlocked: registry.isBlocked.bind(registry),
};
