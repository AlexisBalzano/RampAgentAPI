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