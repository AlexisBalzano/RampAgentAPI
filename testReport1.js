import fetch from "node-fetch";
await fetch("http://localhost:3000/api/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFBO_APP",
    aircrafts: {
      onGround: {
        AFR124: {
          origin: "LFBO",
          aircraftType: "B77W",
          position: { lat: 49.012444, lon: 2.502654 },
        },
      },
      airborne: {
      },
    },
  }),
});
