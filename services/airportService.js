exports.getAirportConfigPath = (icao) => {
  if (!icao) {
    return `../data/airports/`;
  }
  return `../data/airports/${icao}.json`;
};

exports.getAirportList = () => {
  // Return a list of available airport ICAO codes based on existing JSON files
  const fs = require('fs');
  const path = require('path');
  const dirPath = path.join(__dirname, '..', 'data', 'airports');
  const files = fs.readdirSync(dirPath);
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5).toUpperCase());
}

exports.getAirportListAndCoordinates = () => {
  // Return a list of available airport ICAO codes and coordinates based on existing JSON files
  const fs = require('fs');
  const path = require('path');
  const dirPath = path.join(__dirname, '..', 'data', 'airports');
  const files = fs.readdirSync(dirPath);
  const airports = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      const airportData = JSON.parse(fs.readFileSync(path.join(dirPath, file)));
      const coordinatesStr = airportData.Coordinates || "";
      const lat = parseFloat(coordinatesStr.split(':')[0]);
      const lon = parseFloat(coordinatesStr.split(':')[1]);
      airports.push({
        name: file.slice(0, -5).toUpperCase(),
        coords: [lat, lon]
      });
    }
  }
  return airports;
};

exports.getAllStands = () => {
  // Return a list of all stands from all airport JSON files
  const fs = require('fs');
  const path = require('path');
  const dirPath = path.join(__dirname, '..', 'data', 'airports');
  const files = fs.readdirSync(dirPath);
  const stands = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      const airportData = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
      const airportIcao = file.slice(0, -5).toUpperCase();

      // Stands is an object keyed by stand name in your data files
      const standsObj = airportData.Stands;
      if (standsObj && typeof standsObj === 'object') {
        for (const [standName, standDef] of Object.entries(standsObj)) {
          const coordinatesStr = (standDef && standDef.Coordinates) ? String(standDef.Coordinates) : "";
          const parts = coordinatesStr.split(':').map(s => s.trim());
          const lat = parseFloat(parts[0]);
          const lon = parseFloat(parts[1]);
          const radius = (parts.length > 2) ? parseFloat(parts[2]) : 15; // default radius if not specified
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            stands.push({
              name: `${airportIcao}-${standName}`, // include ICAO to avoid duplicate names across airports
              coords: [lat, lon],
              radius: radius,
              schengen: standDef.Schengen || "",
              apron: standDef.Apron || false,
            });
          }
        }
      }
    }
  }
  return stands;
};

exports.getConfig = () => {
  // Return the configuration settings from data/config.json
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  if (fs.existsSync(configPath)) {
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return configData;
  }
  return {};
};
