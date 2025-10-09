exports.info = (msg) => addServerLog('INFO', msg);
exports.error = (msg) => addServerLog('ERROR', msg);

// Store logs in memory (you might want to use a more robust solution)
const logs = [];

// Function to add log entries
function addServerLog(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message: message
  };
  
  logs.push(entry);
  
  // Keep only last 1000 entries
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000);
  }
  
  // Also log to console
  console.log(`[${entry.level}] ${entry.message}`);
}

// Function to get current logs
exports.getLogs = () => logs;

