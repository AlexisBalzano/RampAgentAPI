const occupancyService = require('../services/occupancyService');
const { info, error } = require('../utils/logger');
const stats = require('../services/statService');
const { haversineMeters } = require('../utils/utils');

function filterDatafeed(pilots) {
  let filteredPilots = pilots.filter(pilot => {
    const distance = haversineMeters(pilot.latitude, pilot.longitude, 46.22545, 2.10924); // Center of France
    return distance <= 600_000; // 600 km
  });

  const onGround = [];
  const airborne = [];

  filteredPilots.forEach(pilot => {
    if (pilot.altitude < 20000) {
      if (pilot.groundspeed < 2) {
        onGround.push(pilot);
      } else {
        airborne.push(pilot);
      }
    }
  });

  return { onGround, airborne };
}

// Handle incoming reports from datafeed
exports.getDatafeed = () => {
  fetch('https://data.vatsim.net/v3/vatsim-data.json', { method: 'GET', headers: { 'Accept': 'application/json' } })
    .then(response => response.json())
    .then(data => {
      // Validate and process data
      if (data && data.pilots && data.pilots.length > 0) {
        // Process aircraft data
        const filteredDatafeed = filterDatafeed(data.pilots);
        info(`Datafeed processed: ${filteredDatafeed.onGround.length} on ground, ${filteredDatafeed.airborne.length} airborne`, { category: 'Report' });
        // Pass to occupancy service
        occupancyService.processDatafeed(filteredDatafeed);
      }
      else {
        error('Invalid datafeed format', { category: 'Report' });
        return;
      }
    })
    .catch(err => {
      error(`Error fetching datafeed: ${err}`, { category: 'Report'});
      return;
    });

  // Increment only if valid report
  stats.incrementReportCount();
};