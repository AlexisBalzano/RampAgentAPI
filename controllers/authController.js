const { error, warn } = require('../utils/logger');
const crypto = require('crypto');
const path = require('path');
const cookie = require('cookie');
const { jwtVerify } = require('jose');

// Local user DB
let Low, JSONFile, db;

// Local user DB (lowdb is ESM-only in recent versions -> dynamic import)
const file = path.join(__dirname, '..', 'data', 'localUsers.json');

(async function initDb() {
  try {
    const lowdb = await import('lowdb');
    Low = lowdb.Low;
    JSONFile = lowdb.JSONFile;
    const adapter = new JSONFile(file);
    db = new Low(adapter);
    await db.read();
    db.data ||= { users: [] };

    // seed initial admins from env (CSV of cids)
    const seedAdmins = (process.env.INIT_ADMINS || process.env.ADMIN_CIDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const cid of seedAdmins) {
      let u = db.data.users.find(x => x.cid === cid);
      if (!u) {
        u = { cid, roles: ['admin'], created_at: new Date().toISOString() };
        db.data.users.push(u);
      } else {
        u.roles ||= [];
        if (!u.roles.includes('admin')) u.roles.push('admin');
      }
    }

    await db.write();
  } catch (err) {
    error('Failed to init lowdb: ' + (err.message || err), { category: 'Auth' });
    // fallback stub so other code doesn't blow up (requests should still handle missing data)
    db = {
      read: async () => { /* noop */ },
      write: async () => { /* noop */ },
      data: { users: [] }
    };
  }
})();

exports.getLocalUser = async function (req, res) {
  await db.read();
  const cid = req.params.cid;
  const user = db.data.users.find(u => u.cid === cid);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
};

exports.getAllLocalUsers = async function (req, res) {
  await db.read();
  res.json(db.data.users || []);
};

exports.getAdmins = async function (req, res) {
  await db.read();
  const admins = (db.data.users || []).filter(u => Array.isArray(u.roles) && u.roles.includes('admin'));
  res.json(admins);
};

exports.updateLocalUser = async function (req, res) {
  await db.read();
  const cid = req.params.cid;
  const body = req.body || {};
  let user = db.data.users.find(u => u.cid === cid);
  if (!user) {
    user = {
      cid,
      roles: [],
      created_at: new Date().toISOString(),
      ...body
    };
    db.data.users.push(user);
  } else {
    Object.assign(user, body, { updated_at: new Date().toISOString() });
  }
  await db.write();
  res.json({ ok: true, user });
};

exports.grantRole = async function (req, res) {
  // body: { role: "admin" }
  const cid = req.params.cid;
  const role = (req.body && req.body.role) || null;
  if (!role) return res.status(400).json({ error: 'role required' });

  await db.read();
  let user = db.data.users.find(u => u.cid === cid);
  if (!user) {
    user = { cid, roles: [], created_at: new Date().toISOString() };
    db.data.users.push(user);
  }
  user.roles ||= [];
  if (!user.roles.includes(role)) {
    user.roles.push(role);
    user.updated_at = new Date().toISOString();
    await db.write();
  }
  res.json({ ok: true, user });
};

exports.revokeRole = async function (req, res) {
  const cid = req.params.cid;
  const role = (req.body && req.body.role) || null;
  if (!role) return res.status(400).json({ error: 'role required' });

  await db.read();
  const user = db.data.users.find(u => u.cid === cid);
  if (!user) return res.status(404).json({ error: 'user not found' });

  user.roles = (user.roles || []).filter(r => r !== role);
  user.updated_at = new Date().toISOString();
  await db.write();
  res.json({ ok: true, user });
};

// middleware factory to require a role
exports.requireRole = function (role) {
  return async function (req, res, next) {
    // requireAuth should have set req.user (token payload)
    if (!req.user || !req.user.cid) return res.status(401).json({ error: 'Not authenticated' });

    await db.read();
    const local = db.data.users.find(u => u.cid === req.user.cid);
    if (local && Array.isArray(local.roles) && local.roles.includes(role)) {
      return next();
    }

    // optional fallback: check token payload for admin flag
    if (req.user && (req.user.is_admin === true || req.user.admin === true)) return next();

    return res.status(403).json({ error: 'Forbidden' });
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
  params.set("origin", process.env.NEXT_PUBLIC_BASE_URL)
  params.set("redirect", `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/callback`)
  const loginUrl = `${process.env.NEXT_PUBLIC_CORE_URL_EXTERNAL}/${process.env.NEXT_PUBLIC_CORE_API_VERSION}/auth/vatsim/login?` + params.toString();
  return res.redirect(loginUrl);
};

exports.logout = async (req, res) => {
  try {
    await deleteSession(res);
    return res.redirect(process.env.NEXT_PUBLIC_BASE_URL + '/debug/');
  } catch (err) {
    error('logout error: ' + (err.message || err), { category: 'Auth' });
    return res.status(500).send('Error during logout');
  }
};

// Middleware to require a valid session cookie and attach req.user
exports.requireAuth = async (req, res, next) => {
  const token = req.cookies && req.cookies.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const sessionData = await decryptToken(token);
  if (!sessionData) return res.status(401).json({ error: 'Invalid session' });
  req.user = sessionData.tokenContent;
  next();
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
    return res.redirect(process.env.NEXT_PUBLIC_BASE_URL || '/debug/#dashboard');
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