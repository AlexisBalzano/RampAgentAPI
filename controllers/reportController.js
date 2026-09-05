const occupancyService = require('../services/occupancyService');
const airportService = require('../services/airportService');
const { info, error } = require('../utils/logger');
const stats = require('../services/statService');
const { haversineMeters } = require('../utils/utils');

// Never let the pre-filter drop traffic the assignment envelope would accept:
// this used to be a fixed 20 000 ft, which silently capped max_alt at FL200
// however high it was configured.
const MIN_ALTITUDE_CEILING_FT = 20000;

function filterDatafeed(pilots, maxAltitude = MIN_ALTITUDE_CEILING_FT) {
  const ceiling = Math.max(maxAltitude, MIN_ALTITUDE_CEILING_FT);

  let filteredPilots = pilots.filter(pilot => {
    const distance = haversineMeters(pilot.latitude, pilot.longitude, 46.22545, 2.10924); // Center of France
    return distance <= 600_000; // 600 km
  });

  const onGround = [];
  const airborne = [];

  filteredPilots.forEach(pilot => {
    if (pilot.altitude < ceiling) {
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
    .then(async data => {
      // Validate and process data
      if (data && data.pilots && data.pilots.length > 0) {
        // Process aircraft data, using the same ceiling the assignment
        // envelope applies so the two cannot drift apart
        const config = await airportService.getConfig();
        const filteredDatafeed = filterDatafeed(
          data.pilots,
          config ? occupancyService.maxAltitudeFt(config) : undefined
        );
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