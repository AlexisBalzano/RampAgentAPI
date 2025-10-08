import fetch from "node-fetch";
await fetch("http://localhost:3000/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFBO_APP",
    aircrafts: {
      onGround: {
        AFR123: {
          origin: "LFBO",
          aircraftType: "B77W",
          use: "A",
          position: { lat: 43.631168, lon: 1.371362 },
        },
        EZY123: {
          origin: "LFBO",
          aircraftType: "B77W",
          use: "A",
          position: { lat: 43.629031, lon: 1.373805 },
        },
        RYR123: {
          origin: "LFBO",
          aircraftType: "B77W",
          use: "A",
          position: { lat: 43.628017, lon: 1.376684 },
        },
        AIB123: {
          origin: "LFBO",
          aircraftType: "B77W",
          use: "A",
          position: { lat: 43.618574, lon: 1.362633 },
        },
      },
      airborne: {
        BAW456: {
          origin: "EGLL",
          destination: "LFBO",
          aircraftType: "A320",
          use: "A",
          position: { lat: 48.8566, lon: 2.3522, alt: 3000, dist: 15 },
        },
      },
    },
  }),
});