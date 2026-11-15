const jwt = require("jsonwebtoken");

/**
 * Identifies the member behind an /api/v1 call that acts for a person (stand
 * booking), from the vaccfr-core JWT the website forwards in X-User-Token.
 *
 * Runs after requireServiceKey: the service key says the website is calling,
 * this says on whose behalf. The token is verified with CORE_JWT_KEY, the same
 * secret and algorithm the session login uses - a decoded but unverified token
 * would let anyone book as anyone.
 */
function createUserTokenMiddleware(secret = process.env.CORE_JWT_KEY) {
  return function requireUserToken(req, res, next) {
    const header = req.get("X-User-Token") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (!token) return res.status(401).json({ error: "Missing X-User-Token header" });
    if (!secret) return res.status(503).json({ error: "User authentication is not configured" });

    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    } catch (err) {
      return res.status(401).json({ error: "User token is invalid or has expired" });
    }
    if (!payload || payload.cid === undefined || payload.cid === null || payload.cid === "") {
      return res.status(401).json({ error: "User token carries no cid" });
    }
    req.cid = String(payload.cid);
    next();
  };
}

module.exports = { createUserTokenMiddleware };
