const { error } = require('console');
const crypto = require('crypto');

exports.verifyToken = (token, cid, client) => {
  // Return true if token is valid, false otherwise
  const secret = process.env.AUTH_SECRET;
  
  if (!secret) {
    return false;
  }

  const expectedToken = crypto.createHash('sha256').update(secret + cid + client).digest('hex');
  return token === expectedToken;
};