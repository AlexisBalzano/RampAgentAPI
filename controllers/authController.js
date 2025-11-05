const { error, warn } = require('../utils/logger');
const crypto = require('crypto');
const path = require('path');

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
  const origin = process.env.AUTH_ORIGIN || 'https://pintade.vatsim.fr/rampagent/';
  const redirect = process.env.AUTH_REDIRECT || 'https://pintade.vatsim.fr/rampagent/api/auth/callback';
  const loginUrl = 'https://api.core.vatsim.fr/v1/auth/vatsim/login?origin=' + encodeURIComponent(origin) + '&redirect=' + encodeURIComponent(redirect);
  return res.redirect(loginUrl);
};

// Middleware to require a valid session cookie and attach req.user
exports.requireAuth = async (req, res, next) => {
  const token = req.cookies && req.cookies.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = await verifyAndGetPayload(token);
    req.user = payload;
    return next();
  } catch (err) {
    error('Authentication failed: ' + (err.message || err), { category: 'Auth' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Simple helper endpoint for the frontend to get current user info
exports.getMe = async (req, res) => {
  const token = req.cookies && req.cookies.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = await verifyAndGetPayload(token);
    return res.json({ user: payload });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Single login callback that validates token (or exchanges code) and sets httpOnly cookie
exports.loginCallback = async (req, res) => {
  try {
    let accessToken = req.query.access_token;
    const code = req.query.code;

    // If an authorization code is provided and token endpoint is configured, exchange it
    if (!accessToken && code && process.env.AUTH_TOKEN_URL && process.env.AUTH_CLIENT_ID && process.env.AUTH_CLIENT_SECRET) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.AUTH_REDIRECT || 'https://pintade.vatsim.fr/rampagent/api/auth/callback',
        client_id: process.env.AUTH_CLIENT_ID,
        client_secret: process.env.AUTH_CLIENT_SECRET,
      });
      const resp = await fetch(process.env.AUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!resp.ok) throw new Error('Token exchange failed');
      const json = await resp.json();
      accessToken = json.access_token;
      if (!accessToken) throw new Error('No access_token returned from token endpoint');
    }

    if (!accessToken) {
      return res.status(400).send('Access token (or code) missing');
    }

    const payload = await verifyAndGetPayload(accessToken);

    // cookie options
    const isProd = process.env.NODE_ENV === 'production';
    const maxAgeMs = payload.exp ? (payload.exp - Math.floor(Date.now() / 1000)) * 1000 : 24 * 3600 * 1000;

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'Strict',
      maxAge: Math.max(0, maxAgeMs),
      path: '/',
    });

    // redirect back to UI (prefer relative path)
    return res.redirect(process.env.UI_REDIRECT || '/debug/#dashboard');
  } catch (err) {
    error('loginCallback error: ' + (err.message || err), { category: 'Auth' });
    return res.status(401).send('Invalid access token');
  }
};

// Helper: verify token using configured strategy and return payload, or throw
async function verifyAndGetPayload(accessToken) {
  // 1) Prefer cryptographic verification with a public key (AUTH_PUBLIC_KEY PEM)
  const pubKey = process.env.AUTH_PUBLIC_KEY;
  if (pubKey) {
    const jwt = require('jsonwebtoken');
    // validate signature and standard claims
    const opts = { algorithms: ['RS256'] };
    if (process.env.AUTH_ISSUER) opts.issuer = process.env.AUTH_ISSUER;
    if (process.env.AUTH_AUDIENCE) opts.audience = process.env.AUTH_AUDIENCE;
    return jwt.verify(accessToken, pubKey, opts);
  }

  // 2) Token introspection endpoint (for opaque tokens)
  if (process.env.AUTH_INTROSPECT_URL) {
    const resp = await fetch(process.env.AUTH_INTROSPECT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: process.env.AUTH_INTROSPECT_AUTH ? `Basic ${process.env.AUTH_INTROSPECT_AUTH}` : undefined },
      body: `token=${encodeURIComponent(accessToken)}`,
    });
    if (!resp.ok) throw new Error('Token introspection failed');
    const info = await resp.json();
    if (!info.active) throw new Error('Token not active');
    return info;
  }

  // 3) userinfo endpoint if available
  if (process.env.AUTH_USERINFO_URL) {
    const resp = await fetch(process.env.AUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new Error('Userinfo lookup failed');
    return await resp.json();
  }

  // 4) Fallback (NOT SECURE) — decode and check exp only
  {
    const parts = accessToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid token format (no verification available)');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) throw new Error('Access token expired');
    console.warn('verifyAndGetPayload: token was not cryptographically verified (no PUBLIC_KEY or introspection configured)');
    warn('verifyAndGetPayload: token was not cryptographically verified (no PUBLIC_KEY or introspection configured)', { category: 'Auth' });
    return payload;
  }
}