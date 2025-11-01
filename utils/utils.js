exports.haversineMeters = (lat1, lon1, lat2, lon2) => {
  const kPi = 3.141592653589793;
  const kR = 6371000.0;
  const rad = (d) => (d * kPi) / 180.0;
  const lat1Rad = rad(lat1);
  const lon1Rad = rad(lon1);
  const lat2Rad = rad(lat2);
  const lon2Rad = rad(lon2);
  const dLat = lat2Rad - lat1Rad;
  const dLon = lon2Rad - lon1Rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return kR * c;
};