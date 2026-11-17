process.env.CORE_JWT_KEY = "test-core-key";
const { useAirports, clearRegistry, stand } = require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const svc = require("../services/occupancyService");
const bookingService = require("../services/bookingService");
const prefileService = require("../services/prefileService");
const v1Routes = require("../routes/v1");
const { createServiceKeyMiddleware } = require("../middleware/serviceKey");
const redisService = require("../services/redisService");
const vaIntegrations = require("../services/vaIntegrationService");

// VA integrations live in Redis; an in-memory hash stands in for it.
const stored = new Map();
redisService.setVaIntegration = async (r) => void stored.set(r.id, JSON.stringify(r));
redisService.deleteVaIntegration = async (id) => void stored.delete(id);
redisService.getAllVaIntegrations = async () => [...stored.values()].map((v) => JSON.parse(v));

const PILOT = "1234567";
const KEYS = { website: "webk3y" };
let base;
let server;

test.before(async () => {
  useAirports([
    {
      ICAO: "LFXX",
      Coordinates: "45.0:5.0:5000",
      Stands: {
        D1: stand(45.001, { Priority: 1, Code: "C", Use: "A" }),
        D2: stand(45.002, { Priority: 1, Code: "C", Use: "A" }),
      },
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createServiceKeyMiddleware("website:webk3y"), v1Routes);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(() => server.close());

test.beforeEach(async () => {
  stored.clear();
  vaIntegrations._reset();
  KEYS.flyva = (await vaIntegrations.create({ name: "Fly VA", prefixes: "FVA, fvx", by: "1" })).key;
  bookingService._reset();
  clearRegistry(svc.registry);
  prefileService._setSource([
    { cid: Number(PILOT), callsign: "FVA101", flight_plan: { aircraft_short: "A320", departure: "LFXX", arrival: "LEMD", deptime: "1200" } },
    { cid: Number(PILOT), callsign: "AFR9", flight_plan: { aircraft_short: "A320", departure: "LFXX", arrival: "EGLL", deptime: "1300" } },
  ]);
});

const call = (path, { method = "GET", body, service = "flyva", headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      "X-Service-Key": KEYS[service],
      ...headers,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const asPilot = (path, opts = {}) => call(path, { ...opts, headers: { "X-Pilot-Cid": PILOT, ...(opts.headers || {}) } });

test("only VA keys may assert a CID", async () => {
  const res = await asPilot("/me/booking", { service: "website" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "pilot_cid_not_allowed");
  assert.equal((await call("/me/booking", { headers: { "X-Pilot-Cid": "abc" } })).status, 400);
  const both = jwt.sign({ cid: PILOT }, "test-core-key", { algorithm: "HS256" });
  assert.equal((await asPilot("/me/booking", { headers: { "X-User-Token": both } })).status, 400);
  assert.equal((await call("/me/booking")).status, 401, "neither header");
});

test("lists only the VA's prefiles and books one without naming the callsign", async () => {
  const list = await (await asPilot("/me/prefiles")).json();
  assert.deepEqual(list.map((p) => p.callsign), ["FVA101"]);

  const res = await asPilot("/airports/LFXX/bookings", { method: "POST", body: { stand: "D1" } });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).callsign, "FVA101");
  assert.equal((await (await asPilot("/me/booking")).json()).booking.stand, "D1");
});

test("refuses a flight outside the VA's callsigns", async () => {
  const res = await asPilot("/airports/LFXX/bookings", { method: "POST", body: { stand: "D1", callsign: "AFR9" } });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "callsign_not_allowed");
});

test("cannot see or cancel a booking made for another callsign", async () => {
  const token = jwt.sign({ cid: PILOT }, "test-core-key", { algorithm: "HS256" });
  const web = await call("/airports/LFXX/bookings", {
    service: "website",
    method: "POST",
    body: { stand: "D2", callsign: "AFR9" },
    headers: { "X-User-Token": token },
  });
  assert.equal(web.status, 201);

  assert.equal((await (await asPilot("/me/booking")).json()).booking, null);
  assert.equal((await asPilot("/me/booking", { method: "DELETE" })).status, 404);
  assert.equal(bookingService.forCid(PILOT).booking.stand, "D2", "still held");
});

test("the VA can cancel its own booking", async () => {
  await asPilot("/airports/LFXX/bookings", { method: "POST", body: { stand: "D1" } });
  assert.equal((await asPilot("/me/booking", { method: "DELETE" })).status, 204);
  assert.equal(bookingService.forCid(PILOT).booking, null);
});

test("a disabled, rotated or deleted VA key stops working at once", async () => {
  assert.equal((await asPilot("/me/booking")).status, 200);

  await vaIntegrations.update("fly-va", { enabled: false }, "1");
  assert.equal((await asPilot("/me/booking")).status, 403, "disabled");
  await vaIntegrations.update("fly-va", { enabled: true }, "1");

  const old = KEYS.flyva;
  KEYS.flyva = (await vaIntegrations.rotate("fly-va", "1")).key;
  assert.equal((await asPilot("/me/booking")).status, 200, "new key works");
  assert.equal((await asPilot("/me/booking", { headers: { "X-Service-Key": old } })).status, 403, "old key refused");

  await vaIntegrations.remove("fly-va", "1");
  assert.equal((await asPilot("/me/booking")).status, 403, "deleted");
});

test("integrations survive a reload from storage, keyed by hash only", async () => {
  const raw = [...stored.values()].join("");
  assert.ok(!raw.includes(KEYS.flyva), "the key itself is never stored");
  vaIntegrations._reset();
  await vaIntegrations.load();
  assert.equal((await asPilot("/me/booking")).status, 200);
});

test("validates name and prefixes", async () => {
  await assert.rejects(vaIntegrations.create({ name: "Fly VA", prefixes: "ABC" }), { status: 409 });
  await assert.rejects(vaIntegrations.create({ name: "X", prefixes: "ABC" }), { field: "name" });
  await assert.rejects(vaIntegrations.create({ name: "Other", prefixes: "" }), { field: "prefixes" });
  await assert.rejects(vaIntegrations.create({ name: "Other", prefixes: "A" }), { field: "prefixes" });
  await assert.rejects(vaIntegrations.create({ name: "Other", prefixes: "ab-c" }), { field: "prefixes" });
});
