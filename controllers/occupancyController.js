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

// The per-airport entries are keyed on a path parameter, so a caller asking for
// made-up codes would otherwise mint an entry each time. A few dozen airports
// plus the fixed endpoints fit well inside this; past it the cache is dropped
// and refilled rather than allowed to grow on request.
const MAX_CACHED_PAYLOADS = 128;

function cachedPayload(name, build) {
  const version = occupancyService.registry.version;
  const entry = payloadCache.get(name);
  if (entry && entry.version === version) return entry.body;

  const body = JSON.stringify(build());
  if (payloadCache.size >= MAX_CACHED_PAYLOADS) payloadCache.clear();
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
  movement: s.movement || null,
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

/**
 * One airport's stands, for the per-airport page.
 *
 * The viewer used to pull every airport's stands to draw one board per airport;
 * a page that shows a single airport should fetch a single airport, which is a
 * fraction of the payload and of the rendering behind it.
 */
exports.getAirportStatus = (req, res) => {
  try {
    countRequest(req);

    const icao = String(req.params.icao || "").toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(icao)) {
      return res.status(400).json({ error: "Invalid ICAO" });
    }

    // An ICAO with no stands is answered with empty lists rather than a 404:
    // the airport list follows the config repo, so this endpoint has no
    // authoritative view of which codes exist. The page resolves that against
    // /api/airports.
    sendJson(
      res,
      cachedPayload(`airport:${icao}`, () => {
        const registry = occupancyService.registry;
        const forIcao = (list) =>
          list.filter((s) => s.icao === icao).map(toStand);

        return {
          icao,
          occupied: forIcao(registry.getAllOccupied()),
          assigned: forIcao(registry.getAllAssigned()),
          blocked: forIcao(registry.getAllBlocked()),
        };
      })
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve airport status" });
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
