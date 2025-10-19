exports.info = (msg, tags = {}) => addServerLog('INFO', msg, tags);
exports.warn = (msg, tags = {}) => addServerLog('WARN', msg, tags);
exports.error = (msg, tags = {}) => addServerLog('ERROR', msg, tags);

// Store logs in memory (you might want to use a more robust solution)
const logs = [];

// Function to add log entries
function addServerLog(level, message, tags = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message: message,
    tags: {
      icao: tags.icao || null,
      callsign: tags.callsign || null,
      // Add other tags as needed
      category: tags.category || null
    }
  };

  logs.push(entry);
  
  // Keep only last 1000 entries
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000);
  }
  
  const tagStr = [];
  if (entry.tags.icao) tagStr.push(`ICAO:${entry.tags.icao}`);
  if (entry.tags.callsign) tagStr.push(`CS:${entry.tags.callsign}`);
  const tagsFormatted = tagStr.length ? ` [${tagStr.join(', ')}]` : '';
  
  console.log(`[${entry.level}]${tagsFormatted} ${entry.message}`);
}

// Function to get current logs
exports.getLogs = () => logs;

// Get filtered logs
exports.getFilteredLogs = (filters = {}) => {
  let filtered = [...logs];
  
  // Filter by level (empty string means ALL)
  if (filters.level && filters.level !== '' && filters.level !== 'ALL') {
    filtered = filtered.filter(log => log.level === filters.level);
  }
  
  // Filter by ICAO (empty string means ALL)
  if (filters.icao && filters.icao !== '' && filters.icao !== 'ALL') {
    filtered = filtered.filter(log => log.tags.icao === filters.icao);
  }
  
  // Filter by callsign (empty string means ALL)
  if (filters.callsign && filters.callsign !== '' && filters.callsign !== 'ALL') {
    filtered = filtered.filter(log => log.tags.callsign === filters.callsign);
  }

  // Filter by category (empty string means ALL) - FIX: was missing empty string check
  if (filters.category && filters.category !== '' && filters.category !== 'ALL') {
    filtered = filtered.filter(log => log.tags.category === filters.category);
  }

  return filtered;
};

// Get unique ICAOs from logs
exports.getUniqueICAOs = () => {
  const icaos = new Set();
  logs.forEach(log => {
    if (log.tags.icao) icaos.add(log.tags.icao);
  });
  return Array.from(icaos).sort();
};

// Get unique callsigns from logs
exports.getUniqueCallsigns = () => {
  const callsigns = new Set();
  logs.forEach(log => {
    if (log.tags.callsign) callsigns.add(log.tags.callsign);
  });
  return Array.from(callsigns).sort();
};

// Get unique Categories from logs
exports.getUniqueCategories = () => {
  const categories = new Set();
  logs.forEach(log => {
    if (log.tags.category) categories.add(log.tags.category);
  });
  return Array.from(categories).sort();
};