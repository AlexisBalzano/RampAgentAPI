const { info, warn, error } = require("../utils/logger");
const airportService = require("./airportService");
const hoppieService = require("./hoppieService");
const { haversineMeters } = require("../utils/utils");

// Cache for parsed coordinates to avoid repeated string splitting
const coordinateCache = new Map(); // key: "lat:lon:alt" -> { lat, lon, radius }

// Cache to avoid log flooding when unknown aircraft types are encountered
const aircraftTypeCache = new Set();

// Cache for no stand found error
const noStandFoundCache = new Set();

setInterval(() => {
  coordinateCache.clear();
  aircraftTypeCache.clear();
  noStandFoundCache.clear();
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
  constructor(name, icao, callsign, remark = "", apronSize = 0) {
    this.name = name;
    this.icao = icao;
    this.callsign = callsign;
    this.remark = remark;
    this.apronSize = apronSize;
    this.timestamp = Date.now();
  }

  // Hash function for the Stand class
  key() {
    return this.apronSize > 0
      ? `${this.icao}:${this.name}:${this.callsign}`
      : `${this.icao}:${this.name}`;
  }

  equals(other) {
    return (
      this.icao === other.icao &&
      this.name === other.name &&
      this.callsign === other.callsign && 
      this.apronSize === other.apronSize
    );
  }

  toJSON() {
    return {
      name: this.name,
      icao: this.icao,
      callsign: this.callsign,
      remark: this.remark,
      apronSize: this.apronSize,
      timestamp: this.timestamp,
    };
  }
}

class StandRegistry {
  constructor() {
    this.occupied = new Map(); // key -> Stand
    this.assigned = new Map(); // key -> Stand
    this.blocked = new Map(); // key -> Stand
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

  getApronOccupancyLevel(standName, icao) {
    // Count how many pilot have this stand assigned or occupied
    let count = 0;
    for (const stand of this.occupied.values()) {
      if (stand.name === standName && stand.icao === icao && stand.apronSize > 0) {
        count++;
      }
    }
    for (const stand of this.assigned.values()) {
      if (stand.name === standName && stand.icao === icao && stand.apronSize > 0) {
        count++;
      }
    }
    return count;
  }

  isOccupied(icao, name) {
    // For non-apron stands, check simple key
    const simpleOccupied = Array.from(this.occupied.values()).find(
      s => s.icao === icao && s.name === name && s.apronSize === 0
    );
    if (simpleOccupied) return true;

    // For apron stands, check if capacity is reached
    const apronStand = Array.from(this.occupied.values()).filter(
      s => s.icao === icao && s.name === name && s.apronSize > 0
    );
    if (apronStand.length > 0) {
      if(this.getApronOccupancyLevel(name, icao) >= apronStand[0].apronSize) {
        return true;
      }
    }

    return false;
  }

  isAssigned(icao, name) {
    // For non-apron stands, check simple key
    const simpleAssigned = Array.from(this.assigned.values()).find(
      s => s.icao === icao && s.name === name && s.apronSize === 0
    );
    if (simpleAssigned) return true;

    // For apron stands, check if capacity is reached
    const apronStand = Array.from(this.assigned.values()).filter(
      s => s.icao === icao && s.name === name && s.apronSize > 0
    );
    if (apronStand.length > 0) {
      if(this.getApronOccupancyLevel(name, icao) >= apronStand[0].apronSize) {
        return true;
      }
    }

    return false;
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

  clearExpired(predicateFn) {
    // e.g. remove old stands if needed
    for (const [key, stand] of this.occupied) {
      if (predicateFn(stand)) {
        this.occupied.delete(key);
        info(
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
        info(
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
        info(
          `Clearing expired blocked stand ${stand.name} at ${stand.icao} for ${stand.callsign}`,
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

// Tracks Hoppie gate-terminal TELEX notification lifecycle per callsign, independent of
// StandRegistry (a Stand object is replaced, not mutated, on reassignment, so a flag stored
// on it would not survive a stand swap and could cause a resend).
// status: 'pending' (below 10,000ft, or not yet confirmed connected to Hoppie) | 'sent'
const notificationState = new Map();
const HOPPIE_MIN_ALTITUDE_FT = 10000;
const HOPPIE_RECHECK_TICKS = 4; // ~60s at a 15s datafeed tick, to bound Hoppie API call volume

// Determines whether an assigned stand qualifies for a Hoppie notification: both the stand
// (Terminal) and the airport (Hoppie.MessageTemplate) must opt in via config. Absence of either
// is the sole scoping mechanism - no separate enable flag exists.
function getHoppieEligibility(standDef, airportConfig) {
  if (!standDef || !standDef.Terminal) return null;
  if (!airportConfig || !airportConfig.Hoppie || !airportConfig.Hoppie.MessageTemplate) {
    return null;
  }
  return {
    terminal: standDef.Terminal,
    briefingUrl: airportConfig.Hoppie.BriefingUrl || "",
    messageTemplate: airportConfig.Hoppie.MessageTemplate,
  };
}

function buildHoppieMessage(messageTemplate, terminal, briefingUrl) {
  return messageTemplate
    .replace(/{terminal}/g, terminal)
    .replace(/{briefingUrl}/g, briefingUrl);
}

// Confirms Hoppie presence and sends the TELEX. Never throws - best-effort, fire-and-forget.
async function attemptHoppieNotification(callsign, state) {
  try {
    const connected = await hoppieService.isConnected(callsign);
    if (!connected) {
      return; // stays 'pending', retried on a later re-check window
    }
    const message = buildHoppieMessage(
      state.messageTemplate,
      state.terminal,
      state.briefingUrl
    );
    const sent = await hoppieService.sendTelex(callsign, message);
    if (sent) {
      state.status = "sent";
      info(
        `Hoppie gate-terminal notification sent to ${callsign} (Terminal ${state.terminal})`,
        { category: "Hoppie", callsign }
      );
    }
  } catch (err) {
    error(`Hoppie notification attempt failed for ${callsign}: ${err.message}`, {
      category: "Hoppie",
      callsign,
    });
  }
}

// Registers a callsign as eligible for a Hoppie notification the first time it's automatically
// assigned a Terminal-bearing stand. Sends immediately if already above the altitude threshold.
function registerHoppieEligibility(callsign, standDef, airportConfig) {
  if (notificationState.has(callsign)) return; // already tracked this session
  const eligibility = getHoppieEligibility(standDef, airportConfig);
  if (!eligibility) return;

  const state = {
    status: "pending",
    terminal: eligibility.terminal,
    briefingUrl: eligibility.briefingUrl,
    messageTemplate: eligibility.messageTemplate,
    ticksSinceCheck: 0,
  };
  notificationState.set(callsign, state);
}

// Re-checked on every tick an already-assigned callsign is seen again; only actually evaluates
// (altitude + Hoppie ping) every HOPPIE_RECHECK_TICKS ticks to bound Hoppie API call volume.
function checkPendingHoppieNotification(ac) {
  const state = notificationState.get(ac.callsign);
  if (!state || state.status !== "pending") return;

  state.ticksSinceCheck += 1;
  if (state.ticksSinceCheck < HOPPIE_RECHECK_TICKS) return;
  state.ticksSinceCheck = 0;

  if (typeof ac.altitude === "number" && ac.altitude >= HOPPIE_MIN_ALTITUDE_FT) {
    attemptHoppieNotification(ac.callsign, state);
  }
}

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

    if (
      standDef.Apron &&
      standDef.Apron.Coordinates &&
      Array.isArray(standDef.Apron.Coordinates)
    ) {
      // Check if aircraft is inside apron polygon
      const apronCoords = standDef.Apron.Coordinates.map((coordString) => {
        const coord = parseCoordinates(coordString);
        return coord ? { lat: coord.lat, lon: coord.lon } : null;
      }).filter((c) => c !== null);

      if (
        isPointInPolygon({ lat: ac.latitude, lon: ac.longitude }, apronCoords)
      ) {
        return standName;
      }
    }
    if (aircraftDist <= coords.radius) {
      if (
        !ac.flight_plan ||
        !ac.flight_plan.aircraft_short ||
        ac.flight_plan.aircraft_short === "UNKNOWN" ||
        ac.flight_plan.aircraft_short === ""
      ) {
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
        const wingspan = getAircraftWingspan(
          config,
          ac.flight_plan.aircraft_short
        );
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
        callsign,
        "",
        0
      );
      registry.addBlocked(blockedStand);
    }
  }
};

function isPointInPolygon(point, polygon) {
  // Ray casting algorithm for point-in-polygon
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon,
      yi = polygon[i].lat;
    const xj = polygon[j].lon,
      yj = polygon[j].lat;

    const x = point.lon,
      y = point.lat;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

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
  if (
    !ac.flight_plan ||
    !ac.flight_plan.arrival ||
    !ac.latitude ||
    !ac.longitude
  ) {
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
  if (!airportSet.has(ac.destination)) {
    return false;
  }
  if (config.extended_icaos && config.extended_icaos.includes(ac.destination)) {
    if (ac.altitude > config.max_alt_extended) {
      return false;
    }
    ac.remainingDistance = await calculateRemainingDistance(ac);
    if (ac.remainingDistance * 0.00053996 > config.max_distance_extended) {
      // convert to nautical miles
      return false;
    }
    
  } else {
    if (ac.altitude > config.max_alt) {
      return false;
    }
    ac.remainingDistance = await calculateRemainingDistance(ac);
    if (ac.remainingDistance * 0.00053996 > config.max_distance) {
      // convert to nautical miles
      return false;
    }
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
    // Check wingspan of any derivative types (atyp = XXX*) that may match
    const matchingTypes = Object.keys(config.AircraftWingspans).filter((type) =>
      type.startsWith(aircraftType.toUpperCase().slice(0, 3))
    );
    if (matchingTypes.length > 0) {
      return config.AircraftWingspans[matchingTypes[0]];
    }
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

function getAircraftUse(config, callsign, aircraftType, remarks) {
  if (callsign.length < 3) {
    return "P"; // general aviation
  }

  if (callsign[1] === "-" || callsign[2] === "-") {
    return "P"; // general aviation
  }

  if (aircraftType == "A3ST") {
    return "C"; // cargo
  }

  if (remarks) {
    const remarkText = String(remarks).toLowerCase();
    if (remarkText.includes("cargo") || remarkText.includes("freight") || remarkText.includes("cargoflight")) {
      return "C"; // cargo
    }
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
  if (assignedStand) {
    if (
      assignedStand &&
      (registry.isOccupied(ac.destination, assignedStand.name) ||
        registry.isBlocked(ac.destination, assignedStand.name))
    ) {
      registry.removeAssigned(assignedStand);
    } else {
        assignedStand.timestamp = Date.now();
        for (const s of blockedStands) {
          s.timestamp = Date.now();
        }
      return;
    }
  }

  const schengen = isSchengen(ac.origin, ac.destination);
  const wingspan = getAircraftWingspan(config, ac.flight_plan.aircraft_short);
  const code = getAircraftCode(wingspan);
  const use = getAircraftUse(
    config,
    ac.callsign,
    ac.flight_plan.aircraft_short,
    ac.flight_plan.remarks
  );
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
      const cs = (ac.callsign || "").toUpperCase();
      let match = false;
      // check prefixes from length 3 up to full callsign
      for (let len = 3; len <= cs.length; len++) {
        const prefix = cs.substring(0, len);
        if (standDef.Callsigns.includes(prefix)) {
          match = true;
          break;
        }
      }
      if (!match) {
        continue;
      }
    }
    if (standDef.Apron === undefined) {
      if (registry.isOccupied(ac.destination, standName)) {
        continue;
      }
      if (registry.isAssigned(ac.destination, standName)) {
        continue;
      }
      if (registry.isBlocked(ac.destination, standName)) {
        continue;
      }
    } else {
      const apronSize = standDef.Apron.Size;
      const currentApronOccupancy = registry.getApronOccupancyLevel(
        standName,
        airportConfig.ICAO
      );
      if (currentApronOccupancy >= apronSize) {
        // Apron is full
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
    const stand = new Stand(standName, airportConfig.ICAO, ac.callsign, "", selectedStandDef.Apron === undefined ? 0 : selectedStandDef.Apron.Size);
    info(`Assigning Stand ${standName} to ${ac.callsign}`, {
      category: "Assignation",
      callsign: ac.callsign,
      icao: airportConfig.ICAO,
    });
    registry.addAssigned(stand);
    blockStands(selectedStandDef, ac.destination, ac.callsign);
    if (noStandFoundCache.has(ac.callsign)) {
      noStandFoundCache.delete(ac.callsign);
    }
    return;
  }
  if (!noStandFoundCache.has(ac.callsign)) {
    warn(`No available stands found for ${ac.callsign} at ${ac.destination}`, {
      category: "Assignation",
      callsign: ac.callsign,
      icao: airportConfig.ICAO,
    });
    noStandFoundCache.add(ac.callsign);
  }
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
      if (!standDef) {
        warn(
          `Stand definition for stand ${ac.stand} not found at airport ${ac.origin}, skipping occupancy`,
          { category: "Assignation", callsign: ac.callsign, icao: ac.origin }
        );
        continue;
      }
      let aircraftCode = "UNKNOWN";
      if (
        ac.flight_plan &&
        ac.flight_plan.aircraft_short &&
        ac.flight_plan.aircraft_short !== "UNKNOWN" &&
        ac.flight_plan.aircraft_short !== ""
      ) {
        aircraftCode = getAircraftCode(
          getAircraftWingspan(config, ac.flight_plan.aircraft_short)
        );
      }
      let remark = "";
      if (standDef.Remark && typeof standDef.Remark === "object") {
        // Iterate through all keys in the Remark object
        for (const [codeList, remarkText] of Object.entries(standDef.Remark)) {
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
        remark,
        standDef.Apron === undefined ? 0 : standDef.Apron.Size
      );

      registry.addOccupied(stand);
      blockStands(standDef, ac.origin, ac.callsign);
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
    if (!(await isConcernedArrival(ac, config, airportSet))) {
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
  if (standName === "None") {
    info(`Removed stand assignment for ${callsign}, Requester: ${client}`, {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao,
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
      if (
        airportConfig &&
        airportConfig.Stands &&
        airportConfig.Stands[standName]
      ) {
        return airportConfig.Stands[standName];
      }
      return null;
    });

  if (!standDef) {
    warn(`Stand ${standName} not found at ${icao}, Requester: ${client}`, {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao,
    });
    return {
      action: "not_found",
      stand: standName,
      callsign: callsign,
      icao: icao,
      message: `Stand ${standName} does not exist at ${icao}`,
    };
  }

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
    // If stand is blocked by the same callsign, allow assignment
    if (registry.getBlocked(icao, standName).callsign === callsign) {
      registry.removeBlocked(registry.getBlocked(icao, standName));
    } else {
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
  const stand = new Stand(standName, icao, callsign, "", standDef.Apron === undefined ? 0 : standDef.Apron.Size);
  registry.addAssigned(stand);
  // Block stands
  blockStands(standDef, icao, callsign);
  info(
    `Manually assigned stand ${standName} at ${icao} to ${callsign}, Requester: ${client}`,
    {
      category: "Manual Assign",
      callsign: callsign,
      icao: icao,
    }
  );

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
  getAllOccupied: () => registry.getAllOccupied(),
  getAllAssigned: () => registry.getAllAssigned(),
  getAllBlocked: () => registry.getAllBlocked(),
  isOccupied: (icao, name) => registry.isOccupied(icao, name),
  isAssigned: (icao, name) => registry.isAssigned(icao, name),
  isBlocked: (icao, name) => registry.isBlocked(icao, name),
};
