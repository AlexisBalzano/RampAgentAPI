import fetch from "node-fetch";
await fetch("http://localhost:3000/api/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFBO_APP",
    token: "c6c61659c5dae268c025e5dd89ca6df5e4649958054b471aedaa271ce9af8998",
    aircrafts: {
      onGround: {},
      airborne: {
        "FHBLM": {
          origin: "LFMD",
          destination: "LFMN",
          aircraftType: "H145",
          position: { lat: 43.5361, lon: 7.0175, alt: 5000, dist: 25 },
        }
      },
    },
  }),
});
