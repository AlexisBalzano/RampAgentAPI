// Placeholder for your future C++ integration
// Later: const assignAddon = require('../native/build/Release/assign.node');
const occupancyService = require('./occupancyService');

exports.assignToAircraft = (aircraftId) => {
  const occupied = new Set(occupancyService.getGlobalOccupied());
  const allStands = ['A01', 'A02', 'A03', 'A04', 'B01', 'B02'];

  const free = allStands.find(s => !occupied.has(s));
  if (!free) return null;

  // Mock: in real case, you'd call your C++ logic here
  return free;
};
