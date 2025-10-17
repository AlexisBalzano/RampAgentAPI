import fetch from "node-fetch";

fetch("http://localhost:3000/api/assign?stand=26&icao=LFMN&callsign=DLH95K", {
  method: "GET",
  headers: { "Content-Type": "application/json" },
});