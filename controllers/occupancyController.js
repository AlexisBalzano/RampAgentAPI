const occupancyService = require("../services/occupancyService");
const stat = require("../services/statService");
const logger = require("../utils/logger");

let callsignCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [callsign, timestamp] of callsignCache.entries()) {
    if (now - timestamp > 10 * 60 * 1000) {
      logger.info(`Controller ${callsign} disconnected.`, { category: "Connection", callsign: callsign });
      callsignCache.delete(callsign);
    }
  }
}, 2 * 60 * 1000); // Clean up every 2 minutes

/**
 * These endpoints are polled by every connected controller, but the registry
 * only changes once per datafeed cycle. Each response body is built and
 * serialised once per registry version and replayed until it changes, so N
 * pollers cost one serialisation rather than N.
 */
const payloadCache = new Map(); // name -> { version, body }

function cachedPayload(name, build) {
  const version = occupancyService.registry.version;
  const entry = payloadCache.get(name);
  if (entry && entry.version === version) return entry.body;

  const body = JSON.stringify(build());
  payloadCache.set(name, { version, body });
  return body;
}

function sendJson(res, body) {
  res.set("Content-Type", "application/json").send(body);
}

const toStand = (s) => ({
  name: s.name,
  icao: s.icao,
  callsign: s.callsign || null,
  remark: s.remark || null,
  apronSize: s.apronSize || 0,
});

function countRequest(req) {
  if (!req.headers["x-internal-request"]) {
    stat.incrementRequestCount();
  }
}

exports.getOccupied = (req, res) => {
  try {
    countRequest(req);
    // registry.getAllOccupied returns array of Stand instances; convert to simple objects
    sendJson(
      res,
      cachedPayload("occupied", () =>
        occupancyService.registry.getAllOccupied().map(toStand)
      )
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve occupied stands" });
  }
};

exports.getAssigned = (req, res) => {
  try {
    countRequest(req);
    // registry.getAllAssigned returns array of Stand instances; convert to simple objects
    sendJson(
      res,
      cachedPayload("assigned", () =>
        occupancyService.registry.getAllAssigned().map(toStand)
      )
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve assigned stands" });
  }
};

exports.getBlocked = (req, res) => {
  try {
    countRequest(req);
    // registry.getAllBlocked returns array of Stand instances; convert to simple objects
    sendJson(
      res,
      cachedPayload("blocked", () =>
        occupancyService.registry.getAllBlocked().map(toStand)
      )
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve blocked stands" });
  }
};

exports.getAllStandsStatus = (req, res) => {
  try {
    countRequest(req);

    const callsign = req.query.callsign || "";
    if (callsign) {
      if (!callsignCache.has(callsign)) {
        logger.info(`Controller ${callsign} connected.`, { category: "Connection" });
      }
      callsignCache.set(callsign, Date.now());
    }

    sendJson(
      res,
      cachedPayload("all", () => {
        const registry = occupancyService.registry;
        return {
          occupiedStands: registry.getAllOccupied().map((s) => ({
            name: s.name,
            icao: s.icao,
            callsign: s.callsign || null,
            remark: s.remark || null,
          })),
          assignedStands: registry.getAllAssigned().map((s) => ({
            name: s.name,
            icao: s.icao,
            callsign: s.callsign || null,
          })),
          blockedStands: registry.getAllBlocked().map((s) => ({
            name: s.name,
            icao: s.icao,
            callsign: s.callsign || null,
          })),
        };
      })
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve all stands status" });
  }
};

exports.getControllersNumber = (req, res) => {
  try {
    countRequest(req);
    res.status(200).json({ count: callsignCache.size });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve controllers number" });
  }
};
