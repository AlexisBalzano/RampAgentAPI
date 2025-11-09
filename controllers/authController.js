const { error, warn } = require('../utils/logger');
const crypto = require('crypto');
const path = require('path');
const cookie = require('cookie');
const { jwtVerify } = require('jose');
const redisService = require('../services/redisService');


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
    if (!role) return res.status(400).json({ error: 'role required' });

    const user = await redisService.getLocalUser(cid) || { 
      cid, 
      roles: [], 
      created_at: new Date().toISOString() 
    };

    user.roles ||= [];
    if (!user.roles.includes(role)) {
      user.roles.push(role);
      user.updated_at = new Date().toISOString();
      const updated = await redisService.updateLocalUser(cid, user);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update user' });
      }
    }
    res.json({ ok: true, user });
  } catch (err) {
    error('Failed to grant role:', err);
    res.status(500).json({ error: 'Failed to grant role' });
  }
};

exports.revokeRole = async function (req, res) {
  try {
    const cid = req.params.cid;
    const role = (req.body && req.body.role) || null;
    if (!role) return res.status(400).json({ error: 'role required' });

    const user = await redisService.getLocalUser(cid);
    if (!user) return res.status(404).json({ error: 'user not found' });

    user.roles = (user.roles || []).filter(r => r !== role);
    user.updated_at = new Date().toISOString();
    
    const updated = await redisService.updateLocalUser(cid, user);
    if (!updated) {
      return res.status(500).json({ error: 'Failed to update user' });
    }
    res.json({ ok: true, user });
  } catch (err) {
    error('Failed to revoke role:', err);
    res.status(500).json({ error: 'Failed to revoke role' });
  }
};

exports.requireRoles = (roles) => {
  return async (req, res, next) => {
    if (!req.user || !req.user.cid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const userRoles = await redisService.getRoles(req.user.cid);
      const hasRequiredRole = roles.some(role => userRoles.includes(role));
      
      if (hasRequiredRole) {
        return next();
      }

      return res.status(403).json({ error: 'Insufficient permissions' });
    } catch (err) {
      error('Failed to check roles:', err);
      return res.status(500).json({ error: 'Failed to check permissions' });
    }
  };
};

// Verifying token from plugins for manual stand assignement
exports.verifyToken = (token, client) => {
  // Return true if token is valid, false otherwise
  const secret = process.env.AUTH_SECRET;
  
  if (!secret) {
    error('No secret found', { category: 'Auth' });
    return false;
  }

  const expectedToken = crypto.createHash('sha256').update(secret + client).digest('hex');
  return token === expectedToken;
};

// Redirect to vACC FR core login
exports.login = (req, res) => {
  const params = new URLSearchParams()
  const baseURL = process.env.BASE_URL || 'https://pintade.vatsim.fr/rampagent'; //FIXME: remove fallback
  params.set("origin", baseURL)
  params.set("redirect", `${baseURL}/api/auth/callback`)
  const loginUrl = `${process.env.CORE_URL_EXTERNAL}/v1/auth/vatsim/login?` + params.toString();
  return res.redirect(loginUrl);
};

exports.logout = async (req, res) => {
  try {
    await deleteSession(res);
    const baseURL = process.env.BASE_URL || 'https://pintade.vatsim.fr/rampagent'; //FIXME: remove fallback
    return res.redirect(baseURL + '/debug/');
  } catch (err) {
    error('logout error: ' + (err.message || err), { category: 'Auth' });
    return res.status(500).send('Error during logout');
  }
};

// Middleware to require a valid session cookie and attach req.user
exports.requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.split(' ')[1];

    const sessionData = await decryptToken(token);
    if (!sessionData) return res.status(401).json({ error: 'Invalid session' });
    req.user = sessionData.tokenContent;
    next();
  } catch (err) {
    error('Auth error:', err);
    return res.status(401).json({ error: 'Not authenticated' });
  }
};

exports.loginCallback = async (req, res) => {
  try {
    const accessToken = req.query.access_token;
    const code = req.query.code;

    if (!accessToken) {
      return res.status(400).send('Access token (or code) missing');
    }

    await createSession(res, accessToken);
    const user = await exports.getSessionFromToken(accessToken);

    if (user && user.core) {
      await updateSessionLocalUser(accessToken, user.core);
    }
    // redirect back to UI
    const baseURL = process.env.BASE_URL || 'https://pintade.vatsim.fr/rampagent'; //FIXME: remove fallback
    return res.redirect(baseURL || '/debug/#dashboard');
  } catch (err) {
    error('loginCallback error: ' + (err.message || err), { category: 'Auth' });
    return res.status(401).send('Invalid access token');
  }
};

exports.createSession = async function (res, _token) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const cookieStr = cookie.serialize('session', _token, {
    httpOnly: true,
    secure: true,
    expires: expiresAt,
    sameSite: 'lax',
    path: '/'
  });
  const prev = res.getHeader('Set-Cookie');
  if (prev) {
    const arr = Array.isArray(prev) ? prev : [String(prev)];
    res.setHeader('Set-Cookie', arr.concat(cookieStr));
  } else {
    res.setHeader('Set-Cookie', cookieStr);
  }
  return;
}

// Helper: verify token
async function decryptToken(accessToken) {
  const encodedKey = new TextEncoder().encode(process.env.CORE_JWT_KEY);

  try {
    const { payload } = await jwtVerify(accessToken, encodedKey, {
      algorithms: ["HS256"]
    });
    return {
      token: accessToken,
      tokenContent: payload
    };
  } catch (error) {
    console.log("Failed to verify session", error);
    return null;
  }
}

exports.getSession = async function(){
  const cookiesRaw = await cookies()
  const sessionCookie = cookiesRaw.get("session")
  if (!sessionCookie) return null;
  const sessionData = await decryptToken(sessionCookie.value);
  if (!sessionData) return null;

  const coreUserUrl = `${AppConfig.core.internal_url}/${AppConfig.core.api_version}/user/${sessionData.tokenContent.cid}`
  const coreRes = await fetch(coreUserUrl, {
    method: "GET",
    headers: {
      "Authorization": sessionData.token
    }
  })
  if (coreRes.status !== 200) return null;
  let coreUser = null
  try {
    coreUser = await coreRes.json()
  } catch { }
  if (!coreUser) return null;

  const localUserUrl = `${AppConfig.api.internal_url}/${AppConfig.api.api_version}/localuser/${coreUser.cid}`
  const localRes = await fetch(localUserUrl, {
    method: "GET",
    headers: {
      Authorization: sessionData.token
    }
  })
  if (localRes.status !== 200) return { core: coreUser, local: null, token: sessionData.token };
  let localUser = null
  try {
    localUser = await localRes.json()
  } catch { }

  return { core: coreUser, local: localUser, token: sessionData.token }
}

exports.updateSessionLocalUser = async function (_token, _user) {
  const updateLocalUserUrl = `${AppConfig.api.internal_url}/${AppConfig.api.api_version}/localuser/${_user.cid}/update`
  const body = {
    cid: _user.cid,
    full_name: _user.fullName,
    first_name: _user.firstName,
    last_name: _user.lastName,
    email: _user.email,
    core_session_token: _token
  }
  const res = await fetch(updateLocalUserUrl, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: _token,
      "content-type": "application/json"
    },
  })
  console.log(res.status)
}

async function deleteSession(res) {
  // delete session cookie by setting an expired Set-Cookie header
  const expired = cookie.serialize('session', '', {
    httpOnly: true,
    secure: true,
    expires: new Date(0),
    sameSite: 'lax',
    path: '/'
  });

  const prev = res.getHeader('Set-Cookie');
  if (prev) {
    const arr = Array.isArray(prev) ? prev : [String(prev)];
    res.setHeader('Set-Cookie', arr.concat(expired));
  } else {
    res.setHeader('Set-Cookie', expired);
  }

  return;
}

// API Key Management

exports.getKeys = async (req, res) => {
  try {
    const keys = await redisService.getAllKeys();
    return res.json(keys);
  } catch (error) {
    console.error('Error fetching keys:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getUserKey = async (req, res) => {
  try {
    const keyId = req.params.id;
    const key = await redisService.getKeyById(keyId);
    if (key) {
      return res.json(key);
    }
    return res.status(404).json({ error: 'Key not found' });
  } catch (error) {
    console.error('Error fetching key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.createKey = async (req, res) => {
  try {
    const id = req.params.id;
    const newKey = await redisService.createKey(id);
    return res.status(201).json(newKey);
  } catch (error) {
    console.error('Error creating key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.renewKey = async (req, res) => {
  try {
    const keyId = req.params.id;
    const renewed = await redisService.renewKey(keyId);
    if (renewed) {
      return res.status(200).json({ message: 'Key renewed successfully' });
    }
    return res.status(404).json({ error: 'Key not found' });
  } catch (error) {
    console.error('Error renewing key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.deleteKey = async (req, res) => {
  try {
    const keyId = req.params.id;
    const deleted = await redisService.deleteKey(keyId);
    if (deleted) {
      return res.status(200).json({ message: 'Key deleted successfully' });
    }
    return res.status(404).json({ error: 'Key not found' });
  } catch (error) {
    console.error('Error deleting key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
