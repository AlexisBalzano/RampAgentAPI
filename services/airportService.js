const redisService = require('./redisService');
const path = require('path');

exports.getAirportList = () => {
  // Return a list of available airport ICAO codes based on existing JSON files
  const fs = require('fs');
  const dirPath = path.join(__dirname, '..', 'data', 'airports');
  const files = fs.readdirSync(dirPath);
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5).toUpperCase());
};

exports.getAirportListAndCoordinates = async () => {
  // Return a list of available airport ICAO codes and coordinates based on existing JSON files
  const icaoList = this.getAirportList();
  const airports = [];
  
  for (const icao of icaoList) {
    const airportData = await redisService.getAirportConfig(icao);
    if (airportData) {
      const coordinatesStr = airportData.Coordinates || "";
      const parts = coordinatesStr.split(':');
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        airports.push({
          name: icao,
          coords: [lat, lon]
        });
      }
    }
  }
  return airports;
};

exports.getAllStands = async () => {
  // Return a list of all stands from all airport JSON files
  const icaoList = this.getAirportList();
  const stands = [];
  
  for (const icao of icaoList) {
    const airportData = await redisService.getAirportConfig(icao);
    if (!airportData) continue;

    const standsObj = airportData.Stands;
    if (standsObj && typeof standsObj === 'object') {
      for (const [standName, standDef] of Object.entries(standsObj)) {
        const coordinatesStr = (standDef && standDef.Coordinates) ? String(standDef.Coordinates) : "";
        const parts = coordinatesStr.split(':').map(s => s.trim());
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        const radius = (parts.length > 2) ? parseFloat(parts[2]) : 15;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          stands.push({
            name: `${icao}-${standName}`, // include ICAO to avoid duplicate names across airports
            icao: icao,
            coords: [lat, lon],
            radius: radius,
            schengen: standDef.Schengen || "",
            apron: standDef.Apron || false,
          });
        }
      }
    }
  }
  return stands;
};

exports.getStandsByIcao = async (icao) => {
  // Return the list of all stands of a specific airport ICAO
  const airportConfig = await this.getAirportConfig(icao);
  return airportConfig ? airportConfig.Stands : null;
};

exports.getConfig = async () => {
  // Return the configuration settings from data/config.json
  return await redisService.getConfig();
};

// NEW: Get airport config with Redis caching
exports.getAirportConfig = async (icao) => {
  return await redisService.getAirportConfig(icao);
};

exports.checkAirportVersion = async (icao) => {
  return await redisService.checkAndUpdateVersion(icao);
};