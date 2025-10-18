const jwt = require("jsonwebtoken");

// Store authenticated callsigns with timestamps
const activeCallsigns = new Map(); // Changed to Map to store expiration time

// Cleanup expired sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const [callsign, expiry] of activeCallsigns.entries()) {
    if (now > expiry) {
      activeCallsigns.delete(callsign);
    }
  }
}, 60000);

exports.login = async (req, res) => {
  const { callsign } = req.query;
  if (!callsign) {
    return res.status(400).json({ error: "Callsign is required" });
  }

  // Check if already authenticated
  if (activeCallsigns.has(callsign)) {
    return res.status(409).json({ error: "Callsign already authenticated" });
  }

  // check if callsign is actually online
  const onlineControllers = await fetch(
    "https://data.vatsim.net/v3/vatsim-data.json"
  ).then((res) => res.json());
  const isOnline = onlineControllers.controllers.some(
    (controller) => controller.callsign === callsign
  );

  if (!isOnline) {
    return res
      .status(401)
      .json({ error: "Unauthorized: Callsign is not online" });
  }

  // Add callsign with expiration timestamp (2 minutes from now)
  const expiryTime = Date.now() + 2 * 60 * 1000;
  activeCallsigns.set(callsign, expiryTime);

  // Generate proper JWT
  const token = jwt.sign(
    { callsign: callsign },
    process.env.JWT_SECRET,
    { expiresIn: "2m" }
  );

  res.status(200).json({
    status: "ok",
    message: "Authenticated successfully",
    token: token,
  });
};

exports.verifyToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(403).json({ error: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Check if callsign is still in active sessions
    if (!activeCallsigns.has(decoded.callsign)) {
      return res.status(401).json({ error: "Session expired or logged out" });
    }

    req.callsign = decoded.callsign;

    // Extend session expiration
    const newExpiryTime = Date.now() + 2 * 60 * 1000;
    activeCallsigns.set(decoded.callsign, newExpiryTime);

    // Reset token expiration
    const newToken = jwt.sign(
      { callsign: decoded.callsign },
      process.env.JWT_SECRET,
      { expiresIn: "2m" }
    );
    res.setHeader("Authorization", `Bearer ${newToken}`);
    next();
  });
};

exports.logout = (req, res) => {
  // remove callsign from authenticated stations list to make it available for new login
  const callsign = req.callsign; // From verifyToken middleware
  activeCallsigns.delete(callsign);
  res.status(200).json({ status: "ok", message: "Logged out successfully" });
};
