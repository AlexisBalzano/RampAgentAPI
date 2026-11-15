require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("../services/occupancyService");

// LFMN, and positions at known distances from it.
const NICE = { icao: "LFMN", hasCoords: true, lat: 43.6584, lon: 7.2159 };
const LYON = { lat: 45.7256, lon: 5.0811 }; // LFLL, ~150 nm away
const FINAL = { lat: 43.62, lon: 7.25 }; // a few nm out
const CONFIG = { max_alt: 40000, max_distance: 200 };

const aircraft = (position, groundspeed, altitude = 0) => ({
  callsign: "EJU22EM",
  latitude: position.lat,
  longitude: position.lon,
  altitude,
  groundspeed,
  destination: "LFMN",
  flight_plan: { departure: "LFLL", arrival: "LFMN" },
});

const concerned = (ac, config = CONFIG) => svc.isConcernedArrival(ac, config, null, NICE);

test("still on the ground at a nearby origin: not an arrival yet", () => {
  assert.equal(concerned(aircraft(LYON, 3)), false, "pushing back at LFLL");
  assert.equal(concerned(aircraft(LYON, 20)), false, "taxiing at LFLL");
});

test("airborne from the same origin: an arrival", () => {
  assert.equal(concerned(aircraft(LYON, 160, 1500)), true);
  assert.equal(concerned(aircraft(LYON, 302, 11000)), true);
});

test("slow near the destination: taxiing in, still an arrival", () => {
  assert.equal(concerned(aircraft(FINAL, 15)), true);
});

test("thresholds can be tuned from config", () => {
  assert.equal(concerned(aircraft(LYON, 40), { ...CONFIG, min_airborne_gs: 30 }), true);
  assert.equal(concerned(aircraft(LYON, 3), { ...CONFIG, ground_near_destination_nm: 300 }), true);
});

test("the existing envelope still applies", () => {
  assert.equal(concerned(aircraft(LYON, 300, 41000)), false, "above max_alt");
  assert.equal(concerned(aircraft(LYON, 300, 11000), { ...CONFIG, max_distance: 100 }), false, "beyond max_distance");
});
