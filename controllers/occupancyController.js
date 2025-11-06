const occupancyService = require("../services/occupancyService");
const stat = require("../services/statService");
const logger = require("../utils/logger");

let callsignCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [callsign, timestamp] of callsignCache.entries()) {
    if (now - timestamp > 10 * 60 * 1000) {
      logger.info(`Controller ${callsign} disconnected`, { category: "Connection", callsign: callsign });
      callsignCache.delete(callsign);
    }
  }
}, 2 * 60 * 1000); // Clean up every 2 minutes

exports.getOccupied = (req, res) => {
  try {
    if (!req.headers["x-internal-request"]) {
      stat.incrementRequestCount();
    }
    // registry.getAllOccupied returns array of Stand instances; convert to simple objects
    const occupied = occupancyService.registry.getAllOccupied().map((s) => ({
      name: s.name,
      icao: s.icao,
      callsign: s.callsign || null,
    }));
    res.json(occupied);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve occupied stands" });
  }
};

exports.getAssigned = (req, res) => {
  try {
    if (!req.headers["x-internal-request"]) {
      stat.incrementRequestCount();
    }
    // registry.getAllAssigned returns array of Stand instances; convert to simple objects
    const assigned = occupancyService.registry.getAllAssigned().map((s) => ({
      name: s.name,
      icao: s.icao,
      callsign: s.callsign || null,
    }));
    res.json(assigned);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve assigned stands" });
  }
};

exports.getBlocked = (req, res) => {
  try {
    if (!req.headers["x-internal-request"]) {
      stat.incrementRequestCount();
    }
    // registry.getAllBlocked returns array of Stand instances; convert to simple objects
    const blocked = occupancyService.registry.getAllBlocked().map((s) => ({
      name: s.name,
      icao: s.icao,
      callsign: s.callsign || null,
    }));
    res.json(blocked);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve blocked stands" });
  }
};

exports.getAllStandsStatus = (req, res) => {
  try {
    if (!req.headers["x-internal-request"]) {
      stat.incrementRequestCount();
    }
    // registry.getAllStands returns array of Stand instances; convert to simple objects

    const callsign = req.query.callsign || "";
    const lastRequest = Date.now();
    if (callsign) {
      if (!callsignCache.has(callsign)) {
        logger.info(`Controller ${callsign} connected`, { category: "Connection" });
      }
      callsignCache.set(callsign, lastRequest);
    }

    const assignedStands = occupancyService.registry
      .getAllAssigned()
      .map((s) => ({
        name: s.name,
        icao: s.icao,
        callsign: s.callsign || null,
      }));

    const occupiedStands = occupancyService.registry
      .getAllOccupied()
      .map((s) => ({
        name: s.name,
        icao: s.icao,
        callsign: s.callsign || null,
        remark: s.remark || null,
      }));

    const blockedStands = occupancyService.registry
      .getAllBlocked()
      .map((s) => ({
        name: s.name,
        icao: s.icao,
        callsign: s.callsign || null,
      }));

    res.status(200).json({ occupiedStands, assignedStands, blockedStands });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve all stands status" });
  }
};
