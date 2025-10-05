const clients = new Map(); // callsign -> { occupied, lastUpdate }

exports.updateClientReport = (callsign, occupied) => {
  clients.set(callsign, { occupied, lastUpdate: Date.now() });
};

exports.getGlobalOccupied = () => {
  const now = Date.now();
  const occupied = new Set();

  for (const [_, data] of clients.entries()) {
    if (now - data.lastUpdate < 10_000) {
      data.occupied.forEach(s => occupied.add(s));
    }
  }

  return Array.from(occupied);
};
