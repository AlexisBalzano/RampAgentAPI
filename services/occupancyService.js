const { info } = require("../utils/logger");
const { getAirportList, getAirportConfigPath } = require("./airportService");
const path = require("path");
const fs = require("fs");

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

  // Call getAirportList safely (don't fail if it scans wrong cwd)
  let airportList = [];
  try {
    const al = getAirportList();
    if (Array.isArray(al)) airportList = al;
  } catch (e) {
    // ignore - we'll fallback to checking the file directly
  }
  if (airportList.length && !airportList.includes(ac.origin)) {
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

clientReportParse = (aircrafts) => {
  // Parse JSON of all the reported aircraft positions/states
  for (const [callsign, ac] of Object.entries(aircrafts.onGround || {})) {
    const aircraftOnStand = isAircraftOnStand(ac);
    if (aircraftOnStand) {
      ac.stand = aircraftOnStand;
      info(`Aircraft ${callsign} is on stand ${ac.stand} at ${ac.origin}`);
      // Check if the stand is an apron by looking into json
      const airportJson = require(getAirportConfigPath(ac.origin));
      const standDef = airportJson.Stands && airportJson.Stands[ac.stand];
      if (
        standDef &&
        standDef.Apron &&
        standDef.Apron === true
      ) {
        info(`Stand ${ac.stand} at ${ac.origin} is an apron.`);
      }
      else {
        const stand = new Stand(ac.stand, ac.origin || "UNKNOWN", callsign);
        info(
          `Registering occupied stand ${ac.stand} at ${ac.origin} for ${callsign}`
        );
        registry.addOccupied(stand);
      }
    }
  }

  // for (const [callsign, ac] of Object.entries(aircrafts.airborne || {})) {
  //   if (!ac.stand) {
  //     // Assigning stand placeholder
  //     if (registry.isOccupied(ac.destination, "A01")) {
  //       info(
  //         `Stand A01 at ${ac.destination} is occupied, assigning B01 to ${callsign}`
  //       );
  //       const stand = new Stand("B01", ac.destination || "UNKNOWN", callsign);
  //       registry.addOccupied(stand);
  //       continue;
  //     }

  //     const stand = new Stand("A01", ac.destination || "UNKNOWN", callsign);
  //     info(`Assigning stand A01 at ${ac.destination} to ${callsign}`);
  //     registry.addOccupied(stand);
  //   }
  // }

  // Print current occupied stands
  info(`Currently occupied stands:`);
  for (const stand of registry.getAllOccupied()) {
    info(
      ` - ${stand.name} at ${stand.icao} occupied by ${stand.callsign || "N/A"}`
    );
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
