exports.getAirportConfigPath = (airportICAO) => {
  const icaoUpper = airportICAO.toUpperCase();
  return '../data/airports/' + icaoUpper + '.json';
};