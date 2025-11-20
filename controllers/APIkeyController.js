const { error, warn } = require("../utils/logger");
const sqlite3 = require('sqlite3').verbose();
const crypto = require("crypto");
const path = require('path');

const VALIDITY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Setup database for API keys
const dbPath = path.join(__dirname, '../APIkeys.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to API keys database');
    initializeDatabase();
  }
});

// Initialize database schema
function initializeDatabase() {
  db.serialize(() => {
    // Create table
    db.run(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_used_at INTEGER,
        expires_at INTEGER
      )
    `, (err) => {
      if (err) console.error('Error creating API keys table:', err);
      else console.log('API keys table ready');
    });

    // Create indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_user_id ON api_keys(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_key ON api_keys(key)');
    db.run('CREATE INDEX IF NOT EXISTS idx_created_at ON api_keys(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_expires_at ON api_keys(expires_at)');
  });
}

exports.getKeys = (req, res) => {
  const sql = 'SELECT id, user_id, key, created_at, last_used_at, expires_at FROM api_keys';
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching API keys:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      const apiKeys = rows.map(row => ({
        id: row.id,
        user_id: row.user_id,
        key: row.key,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at
      }));
      res.json({ keys: apiKeys });
    }
  });
};

exports.getUserKey = (req, res) => {
  const userId = req.params.id;
  const sql = 'SELECT id, user_id, key, created_at, last_used_at, expires_at FROM api_keys WHERE user_id = ?';
  db.get(sql, [userId], (err, row) => {
    if (err) {
      console.error('Error fetching API key:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      res.json({ key: row });
    }
  });
};

exports.createKey = (req, res) => {
  const userId = req.params.id;
  const newKey = crypto.randomBytes(32).toString('hex');
  const sql = 'INSERT INTO api_keys (user_id, key) VALUES (?, ?)';
  db.run(sql, [userId, newKey], function (err) {
    if (err) {
      console.error('Error creating API key:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      res.status(201).json({ key: { id: this.lastID, user_id: userId, key: newKey } });
    }
  });
};

exports.renewKey = (req, res) => {
  const userId = req.params.id;
  const sql = 'UPDATE api_keys SET expires_at = ? WHERE user_id = ?';
  const expiresAt = Date.now() + VALIDITY_PERIOD_MS;

  db.run(sql, [expiresAt, userId], function (err) {
    if (err) {
      console.error('Error renewing API key:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      res.json({ key: { user_id: userId, expires_at: expiresAt } });
    }
  });
};

exports.deleteKey = (req, res) => {
  const userId = req.params.id;
  const sql = 'DELETE FROM api_keys WHERE user_id = ?';
  db.run(sql, [userId], function (err) {
    if (err) {
      console.error('Error deleting API key:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      res.json({ message: 'API key deleted successfully' });
    }
  });
};

// Cleanup old keys (older than 60 days)
exports.cleanupOldKeys = () => {
  const sql = 'DELETE FROM api_keys WHERE expires_at < ?';
  const now = Date.now() - (2 * VALIDITY_PERIOD_MS); // 60 days ago
  db.run(sql, [now], function (err) {
    if (err) {
      console.error('Error cleaning up old API keys:', err);
    } else {
      console.log(`Deleted ${this.changes} old API keys`);
    }
  });
};

// Run cleanup periodically (every days)
setInterval(exports.cleanupOldKeys, 24 * 60 * 60 * 1000); // every days


// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error('Error closing database:', err);
    else console.log('Database connection closed');
    process.exit(0);
  });
});