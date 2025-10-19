import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load airport data
const airportFiles = ["LFPG.json"];
const airportData = {};
const allStands = [];
const airportICAOs = [];

for (const file of airportFiles) {
  const filePath = path.join(__dirname, "data", "airports", file);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  airportData[data.ICAO] = data;
  airportICAOs.push(data.ICAO);
  
  // Collect all stands with their coordinates
  if (data.Stands) {
    for (const [standName, standInfo] of Object.entries(data.Stands)) {
      if (standInfo.Coordinates) {
        const [lat, lon] = standInfo.Coordinates.split(":").map(parseFloat);
        allStands.push({
          icao: data.ICAO,
          stand: standName,
          lat,
          lon,
        });
      }
    }
  }
}

function generateRandomCoordinate() {
  const lat = (Math.random() * 180 - 90).toFixed(6);
  const lon = (Math.random() * 360 - 180).toFixed(6);
  return { lat: parseFloat(lat), lon: parseFloat(lon) };
}

function generateRandomCallsign() {
  // const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  let callsign = "";
  // const firstLetterCount = 3;
  const digitCount = Math.floor(Math.random() * 3) + 1; // 1 to 3 digits
    const callsigns = ["FDX", "TAY", "FPO", "ABR", "CLX", "UPS", "AAL", "DAL", "UAL", "JBU", "AFR", "SIA", "ACA", "BAW", "EJU", "EZS", "VIR", "KLM", "SWR", "THA", "QTR", "KAL", "CPA", "JAL", "ANA", "RJA", "GFA", "DLH", "NAX", "SAS", "SWR", "RYR", "VLG", "EZY", "IBE", "LOT", "CSA"];
    let randomNum = Math.floor(1000 + Math.random() * 9000);
    callsign = callsigns[randomNum % callsigns.length];

    for (let i = 0; i < digitCount; i++) {
      callsign += digits.charAt(Math.floor(Math.random() * digits.length));
    }

    return callsign;
}

function generateAircraftType() {
  const types = ["B738", "B734", "B77W", "A339", "B748", "B763", "B753", "MD80", "A321", "A388", "A320", "BE58", "C172"];
  return types[Math.floor(Math.random() * types.length)];
}

function generateIcaoCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let icao = "";
  for (let i = 0; i < 4; i++) {
    icao += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return icao;
}

function generateOnGroundAircrafts(count) {
  const aircrafts = {};
  for (let i = 0; i < count; i++) {
    const acId = generateRandomCallsign();
    const useRealStand = Math.random() > 0.3; // 70% chance to use real stand coordinates
    
    if (useRealStand && allStands.length > 0) {
      const randomStand = allStands[Math.floor(Math.random() * allStands.length)];
      aircrafts[acId] = {
        origin: generateIcaoCode(),
        aircraftType: generateAircraftType(),
        position: {
          lat: randomStand.lat,
          lon: randomStand.lon,
        },
      };
    } else {
      aircrafts[acId] = {
        origin: generateIcaoCode(),
        aircraftType: generateAircraftType(),
        position: generateRandomCoordinate(),
      };
    }
  }
  return aircrafts;
}

function generateRandomArrivalCoordinate() {
  const position = generateRandomCoordinate();
  position.alt = Math.floor(Math.random() * 18000) + 1000; // Altitude between 1000 and 19000 feet
  position.dist = Math.floor(Math.random() * 60) + 5; // Distance between 5 and 65 NM
  return position;
}

function generateAirborneAircrafts(count) {
  const aircrafts = {};
  for (let i = 0; i < count; i++) {
    const acId = generateRandomCallsign();
    const useRealDestination = Math.random() > 0.4; // 60% chance to use real airport ICAO
    
    aircrafts[acId] = {
      origin: generateIcaoCode(),
      destination: useRealDestination && airportICAOs.length > 0
        ? airportICAOs[Math.floor(Math.random() * airportICAOs.length)]
        : generateIcaoCode(),
      aircraftType: generateAircraftType(),
      position: generateRandomArrivalCoordinate(),
    };
  }
  return aircrafts;
}

function generateReport(onGroundCount = 5, airborneCount = 5) {
  return {
    client: "LFBO_APP",
    aircrafts: {
      onGround: generateOnGroundAircrafts(onGroundCount),
      airborne: generateAirborneAircrafts(airborneCount),
    },
  };
}

await fetch("http://localhost:3000/api/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(generateReport()),
});

let count = 0;
let totalSent = 0;
setInterval(async () => {
  count++;
  const onGroundCount = 0; // FIXME: 0 for airborne testing
  const airborneCount = Math.floor(Math.random() * 10) + 1; // Random count between 1 and 10
  totalSent += onGroundCount + airborneCount;
  console.log(`Sending report ${count} with ${onGroundCount} on-ground and ${airborneCount} airborne aircrafts. Total aircrafts sent so far: ${totalSent}`);
  await fetch("http://localhost:3000/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(generateReport(onGroundCount, airborneCount)),
  });
}, 100); // Every 1 seconds