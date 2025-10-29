import fetch from "node-fetch";
await fetch("http://localhost:3000/api/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFBO_APP",
    cid: "123456",
    token: "2",
    aircrafts: {
      onGround: {},
      airborne: {},
    },
  }),
});
