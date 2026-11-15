const { useAirports, clearRegistry, stand } = require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const svc = require("../services/occupancyService");
const v1Routes = require("../routes/v1");
const { createServiceKeyMiddleware } = require("../middleware/serviceKey");

let base;
let server;

test.before(async () => {
  useAirports([
    {
      ICAO: "LFXX",
      version: "3",
      Coordinates: "45.0:5.0:5000",
      Stands: {
        C1: stand(45.001, { Priority: 1, Code: "C", Use: "A", Schengen: true }),
        C2: stand(45.002, { Priority: 1, Code: "CD", Use: "A", Schengen: true }),
        BAD: { Coordinates: "nope" },
      },
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createServiceKeyMiddleware("website:k3y"), v1Routes);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(() => server.close());

const call = (path, { method = "GET", body, key = "k3y" } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(key ? { "X-Service-Key": key } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test("auth is required on every route", async () => {
  assert.equal((await call("/airports", { key: null })).status, 401);
  assert.equal((await call("/airports", { key: "bad" })).status, 403);
});

test("GET /airports", async () => {
  const res = await call("/airports");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ icao: "LFXX", coords: [45, 5], standCount: 3 }]);
});

test("GET /airports/:icao/stands", async () => {
  const res = await call("/airports/lfxx/stands");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.icao, "LFXX");
  assert.equal(body.version, "3");
  assert.deepEqual(body.stands.map((s) => s.name), ["C1", "C2"]);
  assert.equal((await call("/airports/ZZZZ/stands")).status, 404);
});

test("GET /airports/:icao/status", async () => {
  clearRegistry(svc.registry);
  svc.registry.addOccupied(new svc.Stand("C1", "LFXX", "AFR1"));
  svc.registry.addBlocked(new svc.Stand("C2", "LFXX", "AFR1"));
  const res = await call("/airports/LFXX/status");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.stands, {
    C1: { state: "occupied", callsign: "AFR1" },
    C2: { state: "blocked", callsign: "AFR1" },
  });
  assert.ok("updatedAt" in body);
  assert.equal((await call("/airports/ZZZZ/status")).status, 404);
});

test("POST /airports/:icao/suggest", async () => {
  clearRegistry(svc.registry);
  const ok = await call("/airports/LFXX/suggest", {
    method: "POST",
    body: { callsign: "afr123", aircraftType: "a320", origin: "lemd" },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.suggested, "C1");
  assert.deepEqual(body.alternatives, ["C2"]);
  assert.equal(body.profile.typeKnown, true);
  assert.equal(svc.registry.getAllAssigned().length, 0, "nothing assigned");

  const bad = await call("/airports/LFXX/suggest", {
    method: "POST",
    body: { callsign: "AFR123", aircraftType: "A320", origin: "LEM" },
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).field, "origin");

  const departure = await call("/airports/LFXX/suggest", {
    method: "POST",
    body: { callsign: "AFR123", aircraftType: "A320", direction: "departure", destination: "LEMD" },
  });
  assert.equal(departure.status, 200);
  const dep = await departure.json();
  assert.equal(dep.direction, "departure");
  assert.equal(dep.profile.otherCountry, "LE");

  const noDestination = await call("/airports/LFXX/suggest", {
    method: "POST",
    body: { callsign: "AFR123", aircraftType: "A320", direction: "departure", origin: "LEMD" },
  });
  assert.equal(noDestination.status, 400);
  assert.equal((await noDestination.json()).field, "destination");

  const badDirection = await call("/airports/LFXX/suggest", {
    method: "POST",
    body: { callsign: "AFR123", aircraftType: "A320", direction: "sideways", origin: "LEMD" },
  });
  assert.equal((await badDirection.json()).field, "direction");

  const unknown = await call("/airports/ZZZZ/suggest", {
    method: "POST",
    body: { callsign: "AFR123", aircraftType: "A320", origin: "LEMD" },
  });
  assert.equal(unknown.status, 404);
});
