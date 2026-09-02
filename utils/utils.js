const kR = 6371000.0; // Earth radius (m), matching the client-side implementation
const DEG_TO_RAD = Math.PI / 180.0;

// Metres of great-circle distance per degree of latitude. A great-circle
// distance is always >= its meridional component, so |dLat| * this value is a
// rigorous lower bound on the distance - cheap enough to reject candidates
// before paying for any trigonometry.
const M_PER_DEG_LAT = kR * DEG_TO_RAD; // 111194.93

const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const lat1Rad = lat1 * DEG_TO_RAD;
  const lat2Rad = lat2 * DEG_TO_RAD;
  const dLat = lat2Rad - lat1Rad;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;

  const sinDLat = Math.sin(dLat * 0.5);
  const sinDLon = Math.sin(dLon * 0.5);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;

  return 2 * kR * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * True when the two points are within `radius` metres of each other.
 * Rejects on the latitude band first, which discards the vast majority of
 * candidates without any trigonometry, then falls back to the exact haversine
 * so the boundary result is identical to haversineMeters(...) <= radius.
 */
const withinRadius = (lat1, lon1, lat2, lon2, radius) => {
  const dLat = lat2 > lat1 ? lat2 - lat1 : lat1 - lat2;
  if (dLat * M_PER_DEG_LAT > radius) return false;
  return haversineMeters(lat1, lon1, lat2, lon2) <= radius;
};

module.exports = { haversineMeters, withinRadius, M_PER_DEG_LAT, DEG_TO_RAD };
