import fetch from "node-fetch";
await fetch("http://localhost:3000/api/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client: "LFBO_APP",
    cid: "123456",
    token: "a1c407ecfa501bc947f863de357581ac96cd29513dabe773f1da97f5918345e1",
    aircrafts: {
      onGround: {},
      airborne: {},
    },
  }),
});
