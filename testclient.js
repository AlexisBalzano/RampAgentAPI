// testClient.js
import fetch from "node-fetch";
await fetch('http://localhost:3000/report', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    callsign: 'LFPG_APP',
    occupied: ['B01','B02']
  })
});
