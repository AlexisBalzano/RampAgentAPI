const { createUserTokenMiddleware } = require("./userToken");

/**
 * Identifies the pilot behind an /api/v1 booking call.
 *
 * Two ways in, after requireServiceKey has named the calling service:
 *
 * - X-User-Token: the member's vaccfr-core JWT, as the website sends it.
 * - X-Pilot-Cid: the pilot's CID, asserted by a virtual airline's backend.
 *   Only keys of a VA integration (managed from the admin dashboard, see
 *   services/vaIntegrationService) may do this, and only for callsigns
 *   starting with one of that VA's prefixes, so a VA's key can book for its
 *   own flights and nothing else. This avoids handing VAs the core JWT secret,
 *   which would let them sign in as anyone anywhere.
 *
 * Sets req.cid, and req.callsignPrefixes when the CID was asserted.
 */

const CID = /^[0-9]{1,10}$/;

/** True when the request may act for `callsign`: always, unless it is scoped. */
function ownsCallsign(req, callsign) {
  const prefixes = req.callsignPrefixes;
  if (!prefixes) return true;
  const cs = String(callsign || "").toUpperCase();
  return prefixes.some((p) => cs.startsWith(p));
}

function createPilotIdentityMiddleware({ userToken = createUserTokenMiddleware() } = {}) {
  return function requirePilot(req, res, next) {
    const asserted = req.get("X-Pilot-Cid");
    if (asserted === undefined) return userToken(req, res, next);

    if (req.get("X-User-Token")) {
      return res.status(400).json({ error: "Send X-Pilot-Cid or X-User-Token, not both" });
    }
    const va = req.vaIntegration;
    if (!va || !Array.isArray(va.prefixes) || va.prefixes.length === 0) {
      return res.status(403).json({
        error: "This service key may not act for pilots by CID",
        code: "pilot_cid_not_allowed",
      });
    }
    const cid = String(asserted).trim();
    if (!CID.test(cid)) {
      return res.status(400).json({ error: "X-Pilot-Cid must be a VATSIM CID", field: "X-Pilot-Cid" });
    }

    req.cid = cid;
    req.callsignPrefixes = va.prefixes;
    next();
  };
}

module.exports = { ownsCallsign, createPilotIdentityMiddleware };
