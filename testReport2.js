import fetch from "node-fetch";
setInterval(async () => {
await fetch("http://localhost:3000/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFPG_APP",
    aircrafts: {
      onGround: {
      },
      airborne: {
      },
    },
  }),
});
}, 400);