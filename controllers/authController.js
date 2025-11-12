const { error, warn } = require("../utils/logger");
const crypto = require("crypto");
const path = require("path");
const cookie = require("cookie");
const jwt = require("jsonwebtoken");
const redisService = require("../services/redisService");

exports.getLocalUser = async (req, res) => {
  try {
    const { cid } = req.user; // From requireAuth middleware
    const localUser = await redisService.getLocalUser(cid);
    res.json(localUser);
  } catch (err) {
    error("Failed to get local user:", err);
    res.status(500).json({ error: "Failed to get local user" });
  }
};

exports.getAllLocalUsers = async (req, res) => {
  try {
    const users = await redisService.getAllLocalUsers();
    if (!users) {
      return res.status(500).json({ error: "Failed to retrieve users" });
    }
    res.json(users);
  } catch (err) {
    error("Failed to get all local users:", err);
    res.status(500).json({ error: "Failed to get users" });
  }
};

exports.updateLocalUser = async (req, res) => {
  try {
    const { cid } = req.user;
    const settings = req.body;
    const updated = await redisService.updateLocalUser(cid, settings);
    if (!updated) {
      return res.status(500).json({ error: "Failed to update local user" });
    }
    res.json(updated);
  } catch (err) {
    error("Failed to update local user:", err);
    res.status(500).json({ error: "Failed to update local user" });
  }
};

exports.grantRole = async function (req, res) {
  try {
    const cid = req.params.cid;
    const role = (req.body && req.body.role) || null;
    if (!role) return res.status(400).json({ error: "role required" });

    const user = (await redisService.getLocalUser(cid)) || {
      cid,
      roles: [],
      created_at: new Date().toISOString(),
    };

    user.roles ||= [];
    if (!user.roles.includes(role)) {
      user.roles.push(role);
      user.updated_at = new Date().toISOString();
      const updated = await redisService.updateLocalUser(cid, user);
      if (!updated) {
        return res.status(500).json({ error: "Failed to update user" });
      }
    }
    res.json({ ok: true, user });
  } catch (err) {
    error("Failed to grant role:", err);
    res.status(500).json({ error: "Failed to grant role" });
  }
};

exports.revokeRole = async function (req, res) {
  try {
    const cid = req.params.cid;
    const role = (req.body && req.body.role) || null;
    if (!role) return res.status(400).json({ error: "role required" });

    const user = await redisService.getLocalUser(cid);
    if (!user) return res.status(404).json({ error: "user not found" });

    user.roles = (user.roles || []).filter((r) => r !== role);
    user.updated_at = new Date().toISOString();

    const updated = await redisService.updateLocalUser(cid, user);
    if (!updated) {
      return res.status(500).json({ error: "Failed to update user" });
    }
    res.json({ ok: true, user });
  } catch (err) {
    error("Failed to revoke role:", err);
    res.status(500).json({ error: "Failed to revoke role" });
  }
};

exports.requireRoles = (roles) => {
  return async (req, res, next) => {
    if (!req.user || !req.user.cid) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const userRoles = req.user.roles || [];
      const hasRequiredRole = roles.some((role) => userRoles.includes(role));

      if (hasRequiredRole) {
        return next();
      }

      return res.status(403).json({ error: "Insufficient permissions" });
    } catch (err) {
      error("Failed to check roles:", err);
      return res.status(500).json({ error: "Failed to check permissions" });
    }
  };
};

// Verifying token from plugins for manual stand assignement
exports.verifyToken = (token, client) => {
  // Return true if token is valid, false otherwise
  const secret = process.env.CORE_JWT_KEY;

  if (!secret) {
    error("No secret found", { category: "Auth" });
    return false;
  }

  const expectedToken = crypto
    .createHash("sha256")
    .update(secret + client)
    .digest("hex");
  return token === expectedToken;
};

// Redirect to vACC FR core login
exports.login = (req, res) => {
  const params = new URLSearchParams();
  const baseURL = process.env.BASE_URL;
  params.set("origin", baseURL);
  params.set("redirect", `${baseURL}/rampagent/api/auth/callback`);
  const loginUrl =
    `${process.env.CORE_URL_EXTERNAL}/v1/auth/vatsim/login?` +
    params.toString();

  return res.redirect(loginUrl);
};

exports.logout = async (req, res) => {
  try {
    deleteSession(res);
    const baseURL = process.env.BASE_URL;
    return res.redirect(baseURL + "/rampagent/debug/");
  } catch (err) {
    error("logout error: " + (err.message || err), { category: "Auth" });
    return res.status(500).send("Error during logout");
  }
};

function deleteSession(res) {
  const cookieStr = cookie.serialize("session", "", {
    httpOnly: true,
    secure: true,
    expires: new Date(0),
    sameSite: "lax",
    path: "/",
  });
  const prev = res.getHeader("Set-Cookie");
  if (prev) {
    const arr = Array.isArray(prev) ? prev : [String(prev)];
    res.setHeader("Set-Cookie", arr.concat(cookieStr));
  } else {
    res.setHeader("Set-Cookie", cookieStr);
  }
  return;
}


// Middleware to require a valid session cookie and attach req.user
exports.requireAuth = async (req, res, next) => {
  try {
    const cookieRaw = cookie.parse(req.headers.cookie || "");
    let token = cookieRaw.session;

    if (!token) {

      return res.status(401).json({ error: "Not authenticated" });
    }

    const sessionData = await decryptToken(token);
    if (!sessionData) return res.status(401).json({ error: "Invalid session" });

    // Enrich with roles from Redis
    const localUser = await redisService.getLocalUser(
      sessionData.tokenContent.cid
    );
    req.user = {
      ...sessionData.tokenContent,
      roles: localUser?.roles || [],
    };

    return next();
  } catch (err) {
    error("Auth error:", err);
    return res.status(401).json({ error: "Not authenticated" });
  }
};

async function createSession(res, _token) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const cookieStr = cookie.serialize("session", _token, {
    httpOnly: true,
    secure: true,
    expires: expiresAt,
    sameSite: "lax",
    path: "/",
  });
  const prev = res.getHeader("Set-Cookie");
  if (prev) {
    const arr = Array.isArray(prev) ? prev : [String(prev)];
    res.setHeader("Set-Cookie", arr.concat(cookieStr));
  } else {
    res.setHeader("Set-Cookie", cookieStr);
  }
  return;
}

// Helper: verify token
async function decryptToken(accessToken) {
  const secret = process.env.CORE_JWT_KEY;

  try {
    const payload = jwt.verify(accessToken, secret, {
      algorithms: ["HS256"],
    });
    return {
      token: accessToken,
      tokenContent: payload,
    };
  } catch (err) {
    error("Failed to verify session: " + err, { category: "Auth" });
    return null;
  }
}

exports.getSession = async (req, res) => {
  const cookieRaw = cookie.parse(req.headers.cookie || "");
  const token = cookieRaw.session;

  if (!token) {
    error("No token provided", { category: "Auth" });
    return res.status(401).json({ error: "Not authenticated" });
  }

  const sessionData = await decryptToken(token);
  if (!sessionData) return res.status(401).json({ error: "Invalid session" });

  const coreUserUrl =
    process.env.CORE_URL_INTERNAL + `/v1/user/${sessionData.tokenContent.cid}`; //FIXME: is correct ?
  const coreRes = await fetch(coreUserUrl, {
    method: "GET",
    headers: {
      Authorization: sessionData.token,
    },
  });
  if (coreRes.status !== 200) return res.status(401).json({ error: "Failed to fetch user info from core" });
  
  let coreUser = null;
  try {
    coreUser = await coreRes.json();
  } catch {
    error("Failed to parse core user response", { category: "Auth" });
    return res.status(500).json({ error: "Failed to parse core user" });
  }
  if (!coreUser) return res.status(401).json({ error: "Core user not found" });

  // Get local user from Redis
  const localUser = await redisService.getLocalUser(coreUser.cid);
  if (!localUser) {
    warn("No local user found for CID: " + coreUser.cid, { category: "Auth" });
  }

  return res.json({ core: coreUser, local: localUser, token: sessionData.token });
};

async function updateSessionLocalUser(_token, _user) {
  const localUserData = {
    cid: _user.cid,
    full_name: _user.fullName,
    first_name: _user.firstName,
    last_name: _user.lastName,
    email: _user.email,
    updated_at: new Date().toISOString(),
  };

  const updated = await redisService.updateLocalUser(_user.cid, localUserData);

  if (!updated) {
    error(`Failed to update local user in session ${_user.cid}`, {
      category: "Auth",
    });
    return null;
  }

  return updated;
}

exports.loginCallback = async (req, res) => {
  try {
    const accessToken = req.query.access_token;

    if (!accessToken) {
      return res.status(400).send("Access token missing");
    }

    // Verify and decode the token
    const sessionData = await decryptToken(accessToken);
    if (!sessionData) {
      return res.status(401).send("Invalid access token");
    }

    // Fetch core user info
    const coreUserUrl =
      process.env.CORE_URL_INTERNAL +
      `/v1/user/${sessionData.tokenContent.cid}`;
    const coreRes = await fetch(coreUserUrl, {
      method: "GET",
      headers: {
        Authorization: accessToken,
      },
    });

    if (coreRes.status !== 200) {
      return res.status(401).send("Failed to fetch user info from core");
    }

    let coreUser = null;
    try {
      coreUser = await coreRes.json();
    } catch {
      error("Failed to parse core user response", { category: "Auth" });
      return res.status(500).send("Failed to parse user info");
    }

    if (!coreUser) {
      return res.status(401).send("User not found");
    }

    // Update or create local user
    await updateSessionLocalUser(accessToken, coreUser);

    // Set session cookie
    await createSession(res, accessToken);

    // Redirect back to UI
    const baseURL = process.env.BASE_URL;
    return res.redirect(baseURL + "/rampagent/debug/#dashboard");
  } catch (err) {
    error("loginCallback error: " + (err.message || err), { category: "Auth" });
    return res.status(401).send("Authentication failed, check logs");
  }
};

// API Key Management

exports.getKeys = async (req, res) => {
  try {
    const keys = await redisService.getAllKeys();
    return res.json(keys);
  } catch (err) {
    error("Error fetching keys:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getUserKey = async (req, res) => {
  try {
    const keyId = req.params.id;
    const key = await redisService.getKeyById(keyId);
    if (key) {
      return res.json(key);
    }
    return res.status(404).json({ error: "Key not found" });
  } catch (err) {
    error("Error fetching key:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.createKey = async (req, res) => {
  try {
    const id = req.params.id;
    const newKey = await redisService.createKey(id);
    return res.status(201).json(newKey);
  } catch (err) {
    error("Error creating key:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.renewKey = async (req, res) => {
  try {
    const keyId = req.params.id;
    const renewed = await redisService.renewKey(keyId);
    if (renewed) {
      return res.status(200).json({ message: "Key renewed successfully" });
    }
    return res.status(404).json({ error: "Key not found" });
  } catch (err) {
    error("Error renewing key:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.deleteKey = async (req, res) => {
  try {
    const keyId = req.params.id;
    const deleted = await redisService.deleteKey(keyId);
    if (deleted) {
      return res.status(200).json({ message: "Key deleted successfully" });
    }
    return res.status(404).json({ error: "Key not found" });
  } catch (err) {
    error("Error deleting key:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
