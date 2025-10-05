const { info } = require("../utils/logger");

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

clientReportParse = (aircrafts) => {
  // Parse JSON of all the reported aircraft positions/states
  for (const [callsign, ac] of Object.entries(aircrafts.onGround || {})) {
    // Check if aircraft on stand
    // Placeholder
    ac.stand = 'A02';
    if (ac.stand) {
      const stand = new Stand(ac.stand, ac.origin || "UNKNOWN", callsign);
      info(
        `Registering occupied stand ${ac.stand} at ${ac.origin} for ${callsign}`
      );
      registry.addOccupied(stand);
    }
  }

  for (const [callsign, ac] of Object.entries(aircrafts.airborne || {})) {
    if (!ac.stand) {
      // Assigning stand placeholder
      if (registry.isOccupied(ac.destination, "A01")) {
        info(
          `Stand A01 at ${ac.destination} is occupied, assigning B01 to ${callsign}`
        );
        const stand = new Stand("B01", ac.destination || "UNKNOWN", callsign);
        registry.addOccupied(stand);
        continue;
      }

      const stand = new Stand("A01", ac.destination || "UNKNOWN", callsign);
      info(`Assigning stand A01 at ${ac.destination} to ${callsign}`);
      registry.addOccupied(stand);
    }
  }


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
  getGlobalOccupied
};