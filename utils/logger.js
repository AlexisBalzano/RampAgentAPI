const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../logs.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to logs database');
    initializeDatabase();
  }
});

// Initialize database schema
function initializeDatabase() {
  db.serialize(() => {
    // Create table
    db.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        icao TEXT,
        callsign TEXT,
        category TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `, (err) => {
      if (err) console.error('Error creating logs table:', err);
      else console.log('Logs table ready');
    });

    // Create indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_level ON logs(level)');
    db.run('CREATE INDEX IF NOT EXISTS idx_icao ON logs(icao)');
    db.run('CREATE INDEX IF NOT EXISTS idx_callsign ON logs(callsign)');
    db.run('CREATE INDEX IF NOT EXISTS idx_category ON logs(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_timestamp ON logs(timestamp)');
  });
}

// In-memory cache for recent logs (last 1000)
const recentLogs = [];
const MAX_RECENT_LOGS = 1_000;
const MAX_TOTAL_LOGS = 100_000;

function addServerLog(level, message, tags = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message: message,
    tags: {
      icao: tags.icao || null,
      callsign: tags.callsign || null,
      category: tags.category || null
    }
  };

  // Insert into database
  db.run(
    'INSERT INTO logs (timestamp, level, message, icao, callsign, category) VALUES (?, ?, ?, ?, ?, ?)',
    [entry.timestamp, entry.level, entry.message, entry.tags.icao, entry.tags.callsign, entry.tags.category],
    (err) => {
      if (err) console.error('Failed to insert log:', err);
    }
  );

  // Keep in memory for quick access
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }

  // Console output
  const tagStr = [];
  if (entry.tags.icao) tagStr.push(`ICAO:${entry.tags.icao}`);
  if (entry.tags.callsign) tagStr.push(`CS:${entry.tags.callsign}`);
  const tagsFormatted = tagStr.length ? ` [${tagStr.join(', ')}]` : '';
  console.log(`[${entry.level}]${tagsFormatted} ${entry.message}`);
}

exports.info = (msg, tags = {}) => addServerLog('INFO', msg, tags);
exports.warn = (msg, tags = {}) => addServerLog('WARN', msg, tags);
exports.error = (msg, tags = {}) => addServerLog('ERROR', msg, tags);

// Get recent logs from memory (fast)
exports.getRecentLogs = () => recentLogs;

// Get paginated filtered logs from database
exports.getFilteredLogs = (filters = {}, page = 1, pageSize = 100) => {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM logs WHERE 1=1';
    const params = [];

    // Build WHERE clause
    if (filters.level && filters.level !== '' && filters.level !== 'ALL') {
      query += ' AND level = ?';
      params.push(filters.level);
    }
    if (filters.icao && filters.icao !== '' && filters.icao !== 'ALL') {
      query += ' AND icao = ?';
      params.push(filters.icao);
    }
    if (filters.callsign && filters.callsign !== '' && filters.callsign !== 'ALL') {
      query += ' AND callsign = ?';
      params.push(filters.callsign);
    }
    if (filters.category && filters.category !== '' && filters.category !== 'ALL') {
      query += ' AND category = ?';
      params.push(filters.category);
    }

    // Add pagination
    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(pageSize, (page - 1) * pageSize);

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        // Transform to match existing format
        const logs = rows.map(row => ({
          timestamp: row.timestamp,
          level: row.level,
          message: row.message,
          tags: {
            icao: row.icao,
            callsign: row.callsign,
            category: row.category
          }
        }));
        resolve(logs);
      }
    });
  });
};

// Get total count for pagination
exports.getLogCount = (filters = {}) => {
  const promise = new Promise((resolve, reject) => {
    let query = 'SELECT COUNT(*) as count FROM logs WHERE 1=1';
    const params = [];

    if (filters.level && filters.level !== '' && filters.level !== 'ALL') {
      query += ' AND level = ?';
      params.push(filters.level);
    }
    if (filters.icao && filters.icao !== '' && filters.icao !== 'ALL') {
      query += ' AND icao = ?';
      params.push(filters.icao);
    }
    if (filters.callsign && filters.callsign !== '' && filters.callsign !== 'ALL') {
      query += ' AND callsign = ?';
      params.push(filters.callsign);
    }
    if (filters.category && filters.category !== '' && filters.category !== 'ALL') {
      query += ' AND category = ?';
      params.push(filters.category);
    }

    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });

  return promise.then(count => {
    if (count > MAX_TOTAL_LOGS) {
      cleanupOldLogs();
    }
    return count;
  });
};

// Get unique values for filters
exports.getUniqueICAOs = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT DISTINCT icao FROM logs WHERE icao IS NOT NULL ORDER BY icao', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.icao));
    });
  });
};

exports.getUniqueCallsigns = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT DISTINCT callsign FROM logs WHERE callsign IS NOT NULL ORDER BY callsign', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.callsign));
    });
  });
};

exports.getUniqueCategories = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT DISTINCT category FROM logs WHERE category IS NOT NULL ORDER BY category', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.category));
    });
  });
};

// Cleanup old logs (keep last 100k)
exports.cleanupOldLogs = () => {
  db.run('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 100000)');
};

// Run cleanup periodically (every hour)
setInterval(exports.cleanupOldLogs, 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error('Error closing database:', err);
    else console.log('Database connection closed');
    process.exit(0);
  });
});