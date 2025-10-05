import fetch from "node-fetch";
await fetch("http://localhost:3000/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFPG_APP",
    aircrafts: {
      onGround: {
        AFR123: {
          origin: "LFPG",
          aircraftType: "B77W",
          use: "A",
          position: { lat: 49.0097, lon: 2.5479 },
        },
      },
      airborne: {
        BAW456: {
          origin: "EGLL",
          destination: "LFPG",
          aircraftType: "A320",
          use: "A",
          position: { lat: 48.8566, lon: 2.3522, alt: 3000, dist: 15 },
        },
      },
    },
  }),
});