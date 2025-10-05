const occupancyService = require('./occupancyService');
const { getAirportConfigPath } = require('./airportService');
// const assignAddon = require('../native/build/Release/assign.node');

exports.assignToAircraft = (airportICAO, aircraftData) => {
  const airportConfigPath = getAirportConfigPath(airportICAO);

  // For now, mock C++ call:
  // const stand = assignAddon.assignStand(airportConfigPath, aircraftData);

  console.log(`Would call C++ with: ${airportConfigPath}`);
  return 'A12';
};
