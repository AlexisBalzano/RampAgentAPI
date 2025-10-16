import fetch from "node-fetch";
await fetch("http://localhost:3000/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFBO_APP",
    aircrafts: {
      onGround: {
        AFR124: {
          origin: "LFBO",
          aircraftType: "B77W",
          position: { lat: 43.631168, lon: 1.371362 },
        },
        EZY123: {
          origin: "LFBO",
          aircraftType: "A320",
          position: { lat: 43.629031, lon: 1.373805 },
        },
        EZY321: {
          origin: "LFBO",
          aircraftType: "A320",
          position: { lat: 43.659984, lon: 7.207375 },
        },
        RYR123: {
          origin: "N/A",
          aircraftType: "B77W",
          position: { lat: 43.628017, lon: 1.376684 },
        },
        AIB123: {
          origin: "LFBO",
          aircraftType: "B77W",
          position: { lat: 43.618574, lon: 1.362633 },
        },
      },
      airborne: {
        BAW456: {
          origin: "EGLL",
          destination: "LFBO",
          aircraftType: "A320",
          position: { lat: 48.8566, lon: 2.3522, alt: 3000, dist: 15 },
        },
        DLH789: {
          origin: "EDDF",
          destination: "LFBO",
          aircraftType: "A320",
          position: { lat: 47.378177, lon: 8.562152, alt: 3000, dist: 52 },
        },
        AFR456: {
          origin: "LFPG",
          destination: "LFBO",
          aircraftType: "A320",
          position: { lat: 48.8566, lon: 2.3522, alt: 16000, dist: 15 },
        },
        AIB456: {
          origin: "LFPG",
          destination: "LFBH",
          aircraftType: "A320",
          position: { lat: 43.631168, lon: 1.371362, alt: 3000, dist: 15 },
        },
      },
    },
  }),
});
