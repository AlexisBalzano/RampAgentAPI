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