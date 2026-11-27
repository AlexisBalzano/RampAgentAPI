const { useAirports, clearRegistry, stand } = require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const svc = require("../services/occupancyService");
const vaArrivals = require("../services/vaArrivalService");
const v1Routes = require("../routes/v1");
const { createServiceKeyMiddleware } = require("../middleware/serviceKey");
const redisService = require("../services/redisService");
const vaIntegrations = require("../services/vaIntegrationService");

// VA integrations live in Redis; an in-memory hash stands in for it.
const stored = new Map();
redisService.setVaIntegration = async (r) => void stored.set(r.id, JSON.stringify(r));
redisService.deleteVaIntegration = async (id) => void stored.delete(id);
redisService.getAllVaIntegrations = async () => [...stored.values()].map((v) => JSON.parse(v));

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const KEYS = { website: "webk3y" };
const LAT = { C1: 45.001, R1: 45.002, P5: 45.003, SMALL: 45.004, BIG: 45.005, N1: 45.006 };
let base;
let server;

test.before(async () => {
  useAirports([
    {
      // Provisional: freeze 20 min before arrival.
      ICAO: "LFXX",
      Coordinates: "45.0:5.0:5000",
      Assignment: { Mode: "provisional", FreezeMinutes: 20, PreemptMarginMinutes: 5 },
      Stands: {
        C1: stand(LAT.C1, { Priority: 1, Code: "C", Use: "A" }),
        R1: stand(LAT.R1, { Priority: 2, Code: "C", Use: "A" }),
        // A cargo, non-Schengen stand: the engine would never give it to an
        // A320 passenger flight from LFBO, but an airline may ask for it.
        P5: stand(LAT.P5, { Priority: 5, Code: "C", Use: "C", Schengen: false, Block: ["N1"] }),
        SMALL: stand(LAT.SMALL, { Priority: 1, Code: "B", Use: "A" }),
        BIG: stand(LAT.BIG, { Priority: 3, Code: "E", Use: "A" }),
        N1: stand(LAT.N1, { Priority: 4, Code: "C", Use: "A" }),
      },
    },
    {
      ICAO: "LFYY",
      Coordinates: "46.0:5.0:5000",
      Assignment: { Mode: "greedy" },
      Stands: {
        G1: stand(46.001, { Priority: 1, Code: "C", Use: "A" }),
        G9: stand(46.002, { Priority: 9, Code: "C", Use: "A" }),
      },
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createServiceKeyMiddleware("website:webk3y"), v1Routes);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(() => {
  server.close();
  Date.now = realNow;
});

test.beforeEach(async () => {
  skew = 0;
  stored.clear();
  vaIntegrations._reset();
  KEYS.flyva = (await vaIntegrations.create({ name: "Fly VA", prefixes: "FVA", by: "1" })).key;
  KEYS.other = (await vaIntegrations.create({ name: "Other VA", prefixes: "OVA", by: "1" })).key;
  vaArrivals._reset();
  clearRegistry(svc.registry);
  svc._notificationState.clear();
});

const call = (path, { method = "GET", body, service = "flyva" } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      "X-Service-Key": KEYS[service],
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const inMinutes = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();

const prefer = (callsign, stand, { arrival = "LFXX", aircraftType = "A320", eta = inMinutes(60), service } = {}) =>
  call(`/va/arrivals/${callsign}`, { method: "PUT", body: { arrival, stand, aircraftType, eta }, service });

// An aircraft `minutes` out at 450 kt, due north of the field.
function inbound(callsign, minutes, { arrival = "LFXX", type = "A320" } = {}) {
  const field = arrival === "LFYY" ? 46 : 45;
  return {
    callsign,
    latitude: field + ((minutes / 60) * 450) / 60,
    longitude: 5.0,
    groundspeed: 450,
    altitude: 30000,
    flight_plan: { departure: "LFBO", arrival, aircraft_short: type, remarks: "" },
  };
}

function parkedAt(callsign, name) {
  return {
    callsign,
    latitude: LAT[name],
    longitude: 5.0,
    altitude: 0,
    groundspeed: 0,
    flight_plan: { departure: "LFBO", arrival: "LFXX", aircraft_short: "A320", remarks: "" },
  };
}

const cycle = (airborne = [], onGround = []) => svc.processDatafeed({ onGround, airborne });
const held = (callsign) => svc.registry.firstAssignedOf(callsign);
const poll = async (callsign) => (await call(`/va/arrivals/${callsign}`)).json();

// --- API ------------------------------------------------------------------------

test("only VA keys, and only for their own callsigns", async () => {
  const web = await prefer("FVA1", "P5", { service: "website" });
  assert.equal(web.status, 403);
  assert.equal((await web.json()).code, "va_only");

  const foreign = await prefer("OVA1", "P5");
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, "callsign_not_allowed");
});

test("validates the stand and the aircraft size only", async () => {
  assert.equal((await prefer("FVA1", "Z99")).status, 404);
  const type = await prefer("FVA1", "P5", { aircraftType: "XXXX" });
  assert.equal((await type.json()).code, "unknown_aircraft_type");
  const small = await prefer("FVA1", "SMALL");
  assert.equal(small.status, 422);
  assert.equal((await small.json()).code, "stand_unsuitable");
  const eta = await prefer("FVA1", "P5", { eta: inMinutes(3 * 60) });
  assert.equal((await eta.json()).code, "eta_out_of_range");

  // Cargo-only and non-Schengen: accepted, those are the airline's call.
  const ok = await prefer("fva1", "p5");
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.callsign, "FVA1");
  assert.equal(body.stand, "P5");
  assert.equal(body.assignment.state, "waiting");
});

test("create, update, list, delete", async () => {
  assert.equal((await prefer("FVA1", "P5")).status, 201);
  assert.equal((await prefer("FVA1", "R1")).status, 200);
  const list = await (await call("/va/arrivals")).json();
  assert.deepEqual(list.map((p) => [p.callsign, p.stand]), [["FVA1", "R1"]]);
  assert.deepEqual(await (await call("/va/arrivals", { service: "other" })).json(), []);

  assert.equal((await call("/va/arrivals/FVA1", { method: "DELETE" })).status, 204);
  assert.equal((await call("/va/arrivals/FVA1", { method: "DELETE" })).status, 404);
});

// --- Engine, provisional mode ---------------------------------------------------------

test("the airline's stand is given first and kept over better tiers", async () => {
  await prefer("FVA1", "P5");
  await cycle([inbound("FVA1", 60)]);
  assert.equal(held("FVA1").name, "P5");
  assert.equal(held("FVA1").status, "provisional");

  await cycle([inbound("FVA1", 50)]);
  assert.equal(held("FVA1").name, "P5", "not upgraded to C1");

  const status = await poll("FVA1");
  assert.deepEqual(
    { state: status.assignment.state, stand: status.assignment.stand, honoured: status.assignment.honoured },
    { state: "assigned", stand: "P5", honoured: true }
  );

  await cycle([inbound("FVA1", 15)]);
  assert.equal(held("FVA1").status, "firm", "the freeze still applies");
});

test("never displaces anyone; goes back to the stand if it frees up before the freeze", async () => {
  // XXX2 ends up holding R1 provisionally, with C1 free.
  await cycle([inbound("XXX1", 90), inbound("XXX2", 95)]);
  assert.equal(held("XXX2").name, "R1");
  svc.registry.removeAllAssignedOf("XXX1");

  await prefer("FVA1", "R1");
  await cycle([inbound("XXX2", 90), inbound("FVA1", 60)]);
  assert.equal(held("XXX2").name, "R1", "a provisional holder with a later ETA keeps it");
  assert.equal(held("FVA1").name, "C1", "assigned as usual");
  assert.equal((await poll("FVA1")).assignment.reason, "stand_unavailable");

  // XXX2 diverts: R1 is free again while FVA1 is still provisional, and the
  // airline's stand wins over the better-tier C1 it holds.
  svc.registry.removeAllAssignedOf("XXX2");
  svc.registry.removeAllBlockedOf("XXX2");
  await cycle([inbound("FVA1", 55)]);
  assert.equal(held("FVA1").name, "R1");
  assert.equal((await poll("FVA1")).assignment.honoured, true);
});

test("does not take a stand whose Block neighbour someone holds", async () => {
  await svc.assignStandToPilot("N1", "LFXX", "XXX2", "test");
  await prefer("FVA1", "P5");
  await cycle([inbound("FVA1", 60)]);
  assert.notEqual(held("FVA1").name, "P5");
});

test("a filed aircraft too big for the stand is assigned normally", async () => {
  await prefer("FVA1", "P5");
  await cycle([inbound("FVA1", 60, { type: "A333" })]);
  assert.equal(held("FVA1").name, "BIG");
  assert.equal((await poll("FVA1")).assignment.reason, "aircraft_unsuitable");
});

test("lives two hours from the request", async () => {
  const res = await prefer("FVA1", "P5");
  const body = await res.json();
  assert.equal(Date.parse(body.expiresAt) - Date.parse(body.updatedAt), 2 * 60 * 60 * 1000);

  skew = 2 * 60 * 60 * 1000 + 1000;
  await cycle([inbound("FVA1", 60)]);
  assert.equal(held("FVA1").name, "C1", "not applied once expired");
  assert.equal((await call("/va/arrivals/FVA1")).status, 404, "and deleted");
});

test("too late once the flight holds another stand for good", async () => {
  await cycle([inbound("FVA1", 15)]);
  assert.equal(held("FVA1").status, "firm");
  const res = await prefer("FVA1", "P5");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "too_late");
  assert.equal((await prefer("FVA1", held("FVA1").name)).status, 201, "the stand it already has is fine");
});

test("a controller's assignment wins and is reported", async () => {
  await prefer("FVA1", "P5");
  await cycle([inbound("FVA1", 60)]);
  await svc.assignStandToPilot("R1", "LFXX", "FVA1", "test");
  await cycle([inbound("FVA1", 55)]);
  assert.equal(held("FVA1").name, "R1");
  assert.equal((await poll("FVA1")).assignment.reason, "controller");
});

test("is deleted once fulfilled, so the next flight under the callsign does not get it", async () => {
  await prefer("FVA1", "P5");
  await cycle([inbound("FVA1", 60)]);
  await cycle([], [parkedAt("FVA1", "P5")]);
  assert.equal((await call("/va/arrivals/FVA1")).status, 404);

  // FVA1 leaves and a new FVA1 heads back in.
  clearRegistry(svc.registry);
  await cycle([inbound("FVA1", 60)]);
  assert.equal(held("FVA1").name, "C1");
});

test("is deleted when the flight parks on another stand too", async () => {
  await prefer("FVA1", "P5");
  await cycle([], [parkedAt("FVA1", "R1")]);
  assert.equal((await call("/va/arrivals/FVA1")).status, 404);
});

test("refused while the flight is parked at the airport", async () => {
  await cycle([], [parkedAt("FVA1", "R1")]);
  const res = await prefer("FVA1", "P5");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "too_late");
});

// --- Engine, greedy mode -------------------------------------------------------------

test("greedy mode gives the airline's stand first", async () => {
  await prefer("FVA2", "G9", { arrival: "LFYY" });
  await cycle([inbound("FVA2", 60, { arrival: "LFYY" })]);
  assert.equal(held("FVA2").name, "G9");
});
