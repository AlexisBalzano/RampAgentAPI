const crypto = require("crypto");
const { info, warn } = require("../utils/logger");

/**
 * Service-to-service authentication for /api/v1.
 *
 * Keys come from SERVICE_API_KEYS, a comma-separated list of name:key pairs
 * ("website:3f9c...,other:..."), the same convention vaccfr-core uses. The
 * per-user keys in the api_keys table expire after 30 days, so they cannot
 * serve a backend that calls us unattended.
 *
 * Missing header -> 401, wrong key -> 403. With no keys configured every call
 * is refused: an unconfigured deployment must not be an open one.
 */

function parseServiceKeys(raw) {
  const keys = [];
  for (const entry of String(raw || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0 || sep === trimmed.length - 1) continue; // "name:key", both non-empty
    keys.push({
      name: trimmed.slice(0, sep).trim(),
      key: Buffer.from(trimmed.slice(sep + 1).trim()),
    });
  }
  return keys;
}

/** The service name owning `presented`, or null. Constant-time per key. */
function matchServiceKey(keys, presented) {
  const candidate = Buffer.from(presented);
  let match = null;
  for (const entry of keys) {
    // timingSafeEqual throws on a length mismatch, so lengths are compared
    // first. That reveals only the key length, which is not secret.
    if (entry.key.length !== candidate.length) continue;
    if (crypto.timingSafeEqual(entry.key, candidate)) match = entry.name;
  }
  return match;
}

function createServiceKeyMiddleware(raw) {
  const keys = parseServiceKeys(raw);
  if (keys.length === 0) {
    warn(
      "SERVICE_API_KEYS is not set - every /api/v1 request will be refused",
      { category: "Service" }
    );
  }

  const seen = new Set();

  return function requireServiceKey(req, res, next) {
    const presented = req.get("X-Service-Key");
    if (!presented) {
      return res.status(401).json({ error: "Missing X-Service-Key header" });
    }
    const name = keys.length > 0 ? matchServiceKey(keys, presented) : null;
    if (!name) {
      warn(`Rejected /api/v1 request with an invalid service key (${req.method} ${req.originalUrl})`, {
        category: "Service",
      });
      return res.status(403).json({ error: "Invalid service key" });
    }

    req.service = name;
    // Logged once per service per process: the website polls every 30 s, and a
    // line per poll would drown the log. Suggest calls are logged individually.
    if (!seen.has(name)) {
      seen.add(name);
      info(`Service "${name}" authenticated on /api/v1`, { category: "Service" });
    }
    next();
  };
}

module.exports = {
  parseServiceKeys,
  matchServiceKey,
  createServiceKeyMiddleware,
};
