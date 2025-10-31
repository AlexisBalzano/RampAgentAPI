const { error } = require('../utils/logger');
const crypto = require('crypto');

exports.verifyToken = (token, cid, client) => {
  // Return true if token is valid, false otherwise
  const secret = process.env.AUTH_SECRET;
  
  if (!secret) {
    error('No secret found');
    return false;
  }

  const expectedToken = crypto.createHash('sha256').update(secret + cid + client).digest('hex');
  return token === expectedToken;
};