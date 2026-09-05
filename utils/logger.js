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

// A busy datafeed cycle emits thousands of log lines. One INSERT and one
// console.log per line means thousands of round trips and, under Docker, one
// blocking write syscall each. Entries are buffered and written in batches
// instead: a single transaction with a prepared statement, and one joined
// stdout write. In-memory state is still updated synchronously, so
// getRecentLogs() never lags.
const FLUSH_INTERVAL_MS = 250;
const FLUSH_THRESHOLD = 500;
const CONSOLE_ENABLED = process.env.LOG_CONSOLE !== 'off';

let pending = [];
let pendingConsole = [];
let flushTimer = null;

// Batches are chained so they commit in the order they were produced, and so
// flush() can hand back a promise that resolves once everything logged so far
// is on disk.
let writeQueue = Promise.resolve();

function flushConsole() {
  if (pendingConsole.length === 0) return;
  const chunk = pendingConsole.join('\n') + '\n';
  pendingConsole = [];
  process.stdout.write(chunk);
}

function writeBatch(batch) {
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run('BEGIN');
      const stmt = db.prepare(
        'INSERT INTO logs (timestamp, level, message, icao, callsign, category) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const entry of batch) {
        stmt.run(
          entry.timestamp,
          entry.level,
          entry.message,
          entry.tags.icao,
          entry.tags.callsign,
          entry.tags.category
        );
      }
      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) console.error('Failed to insert logs:', err);
        resolve();
      });
    });
  });
}

/** Writes everything buffered so far. Resolves once it is committed. */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushConsole();

  if (pending.length > 0) {
    const batch = pending;
    pending = [];
    writeQueue = writeQueue.then(() => writeBatch(batch));
  }
  return writeQueue;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

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

  pending.push(entry);

  // Keep in memory for quick access
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }

  // Console output
  if (CONSOLE_ENABLED) {
    const tagStr = [];
    if (entry.tags.icao) tagStr.push(`ICAO:${entry.tags.icao}`);
    if (entry.tags.callsign) tagStr.push(`CS:${entry.tags.callsign}`);
    const tagsFormatted = tagStr.length ? ` [${tagStr.join(', ')}]` : '';
    pendingConsole.push(`[${entry.level}]${tagsFormatted} ${entry.message}`);
  }

  if (pending.length >= FLUSH_THRESHOLD) flush();
  else scheduleFlush();
}

exports.info = (msg, tags = {}) => addServerLog('INFO', msg, tags);
exports.warn = (msg, tags = {}) => addServerLog('WARN', msg, tags);
exports.error = (msg, tags = {}) => addServerLog('ERROR', msg, tags);

// Force buffered entries to disk (used before reads and on shutdown).
exports.flush = flush;

// Get recent logs from memory (fast)
exports.getRecentLogs = () => recentLogs;

// Get paginated filtered logs from database
exports.getFilteredLogs = (filters = {}, page = 1, pageSize = 100) => {
  // Buffered entries must be committed before the query runs.
  return flush().then(() => new Promise((resolve, reject) => {
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
  }));
};

// Get total count for pagination
exports.getLogCount = (filters = {}) => {
  // Buffered entries must be committed before the query runs.
  const promise = flush().then(() => new Promise((resolve, reject) => {
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
  }));

  return promise.then(count => {
    if (count > MAX_TOTAL_LOGS) {
      exports.cleanupOldLogs();
    }
    return count;
  });
};

// Get unique values for filters
exports.getUniqueICAOs = () => {
  return flush().then(() => new Promise((resolve, reject) => {
    db.all('SELECT DISTINCT icao FROM logs WHERE icao IS NOT NULL ORDER BY icao', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.icao));
    });
  }));
};

exports.getUniqueCallsigns = () => {
  return flush().then(() => new Promise((resolve, reject) => {
    db.all('SELECT DISTINCT callsign FROM logs WHERE callsign IS NOT NULL ORDER BY callsign', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.callsign));
    });
  }));
};

exports.getUniqueCategories = () => {
  return flush().then(() => new Promise((resolve, reject) => {
    db.all('SELECT DISTINCT category FROM logs WHERE category IS NOT NULL ORDER BY category', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.category));
    });
  }));
};

// Cleanup old logs (keep last 100k)
exports.cleanupOldLogs = () => {
  // Resolving the cut-off id via OFFSET avoids rescanning 100k rows for a NOT IN.
  db.run(
    'DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)',
    [MAX_TOTAL_LOGS]
  );
};

// Run cleanup periodically (every hour)
setInterval(exports.cleanupOldLogs, 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  // Do not lose buffered entries on shutdown.
  flush().then(() => {
    db.close((err) => {
      if (err) console.error('Error closing database:', err);
      else console.log('Database connection closed');
      process.exit(0);
    });
  });
});