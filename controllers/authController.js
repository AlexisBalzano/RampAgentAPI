const { error } = require('../utils/logger');
const crypto = require('crypto');

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