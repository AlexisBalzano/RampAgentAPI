const occupancyService = require('./occupancyService');
const { getAirportConfigPath } = require('./airportService');
// const assignAddon = require('../native/build/Release/assign.node');

// FIXME: working ?
function getAssignedStand(aircraftId) {
  // Lookup assigned stand from registry
  const registry = occupancyService.getRegistry();
  return registry[aircraftId] || null;
}