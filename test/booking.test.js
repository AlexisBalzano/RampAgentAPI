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

const ME = "1234567";
const OTHER = "7654321";
const token = (cid, key = "test-core-key") => jwt.sign({ cid }, key, { algorithm: "HS256" });

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const STAND_LAT = { D1: 45.001, D2: 45.002, D3: 45.003, BIG: 45.004 };
let base;
let server;

test.before(async () => {
  useAirports([
    {
      ICAO: "LFXX",
      Coordinates: "45.0:5.0:5000",
      Stands: {
        D1: stand(STAND_LAT.D1, { Priority: 1, Code: "C", Use: "A", Block: ["D2"] }),
        D2: stand(STAND_LAT.D2, { Priority: 1, Code: "C", Use: "A" }),
        D3: stand(STAND_LAT.D3, { Priority: 2, Code: "C", Use: "A" }),
        BIG: stand(STAND_LAT.BIG, { Priority: 1, Code: "E", Use: "A" }),
      },
    },
    { ICAO: "LFYY", Coordinates: "46.0:5.0:5000", Stands: { Y1: stand(46.001, { Use: "A" }) } },
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createServiceKeyMiddleware("website:k3y"), v1Routes);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(() => {
  server.close();
  Date.now = realNow;
});

test.beforeEach(() => {
  skew = 0;
  bookingService._reset();
  clearRegistry(svc.registry);
  prefileService._setSource([
    { cid: Number(ME), callsign: "AFR123", flight_plan: { aircraft_short: "A320", departure: "LFXX", arrival: "LEMD", deptime: "1200", remarks: "" } },
    { cid: Number(OTHER), callsign: "EZY9", flight_plan: { aircraft_short: "A320", departure: "LFYY", arrival: "EGLL" } },
  ]);
});

const call = (path, { method = "GET", body, cid = ME, user } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      "X-Service-Key": "k3y",
      ...(user !== undefined ? (user ? { "X-User-Token": user } : {}) : { "X-User-Token": token(cid) }),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const book = (stand, opts = {}) => call("/airports/LFXX/bookings", { method: "POST", body: { stand }, ...opts });

/** One datafeed cycle: parked aircraft (at a stand) and airborne arrivals. */
const cycle = (parked = [], airborne = []) =>
  svc.processDatafeed({
    onGround: parked.map(({ callsign, cid, at }) => ({
      callsign,
      cid: cid !== undefined ? Number(cid) : undefined,
      latitude: STAND_LAT[at],
      longitude: 5.0,
      altitude: 0,
      groundspeed: 0,
      flight_plan: { departure: "LFXX", arrival: "LEMD", aircraft_short: "A320", remarks: "" },
    })),
    airborne,
  });

const statusOf = async (name) => (await (await call("/airports/LFXX/status")).json()).stands[name];

test("the member's token is required and verified", async () => {
  assert.equal((await book("D1", { user: null })).status, 401);
  assert.equal((await book("D1", { user: token(ME, "wrong-key") })).status, 401);
  assert.equal((await call("/me/booking", { user: null })).status, 401);
});

test("lists the member's prefiles departing covered airports", async () => {
  const res = await call("/me/prefiles");
  assert.deepEqual(await res.json(), [
    { callsign: "AFR123", aircraftType: "A320", departure: "LFXX", arrival: "LEMD", deptime: "1200" },
  ]);
});

test("books a stand from the prefile and holds it for 10 minutes", async () => {
  const res = await book("d1");
  assert.equal(res.status, 201);
  const booking = await res.json();
  assert.equal(booking.stand, "D1");
  assert.equal(booking.callsign, "AFR123");
  assert.equal(booking.destination, "LEMD");
  assert.equal(Date.parse(booking.expiresAt) - Date.parse(booking.createdAt), 10 * 60 * 1000);

  assert.deepEqual(await statusOf("D1"), { state: "booked", callsign: "AFR123" });
  assert.equal((await statusOf("D2")).state, "blocked", "its Block neighbour is held too");
  const mine = await (await call("/me/booking")).json();
  assert.equal(mine.booking.stand, "D1");
});

test("refuses without a prefile departing here", async () => {
  const res = await call("/airports/LFXX/bookings", { method: "POST", body: { stand: "D1" }, cid: OTHER });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "no_prefile");
});

test("refuses a stand that does not fit, or is taken", async () => {
  const big = await book("BIG");
  assert.equal(big.status, 422);
  assert.equal((await big.json()).code, "stand_unsuitable");

  svc.registry.addOccupied(new svc.Stand("D3", "LFXX", "PARKED1"));
  const taken = await book("D3");
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, "stand_taken");

  assert.equal((await book("NOPE")).status, 404);
});

test("an arrival is never given a booked stand", async () => {
  assert.equal((await book("D1")).status, 201);
  await cycle([], [
    {
      callsign: "BAW45",
      latitude: 45.3,
      longitude: 5.0,
      altitude: 9000,
      groundspeed: 250,
      flight_plan: { departure: "EGLL", arrival: "LFXX", aircraft_short: "A320", remarks: "" },
    },
  ]);
  const arrival = svc.registry.firstAssignedOf("BAW45");
  assert.ok(arrival, "the arrival got a stand");
  assert.ok(!["D1", "D2"].includes(arrival.name), `not the booked stand or its neighbour (${arrival.name})`);
  assert.equal((await statusOf("D1")).state, "booked");
});

test("connecting on the stand fulfils it: occupancy keeps the stand", async () => {
  await book("D1");
  await cycle([{ callsign: "AFR123", cid: ME, at: "D1" }]);
  const mine = await (await call("/me/booking")).json();
  assert.equal(mine.booking, null);
  assert.equal(mine.last.status, "fulfilled");
  assert.equal((await statusOf("D1")).state, "occupied");
});

test("connecting on another stand releases it", async () => {
  await book("D1");
  await cycle([{ callsign: "AFR123", cid: ME, at: "D3" }]);
  const mine = await (await call("/me/booking")).json();
  assert.equal(mine.booking, null);
  assert.equal(mine.last.status, "released");
  assert.equal(await statusOf("D1"), undefined, "D1 is free again");
});

test("not connecting within 10 minutes expires it", async () => {
  await book("D1");
  skew = 9 * 60 * 1000;
  await cycle();
  assert.equal((await statusOf("D1")).state, "booked", "still held at 9 minutes");
  skew = 10 * 60 * 1000 + 1;
  await cycle();
  assert.equal(await statusOf("D1"), undefined);
  assert.equal((await (await call("/me/booking")).json()).last.status, "expired");
});

test("someone else connecting on it ends the booking as a conflict", async () => {
  await book("D1");
  await cycle([{ callsign: "RYR1", cid: "999", at: "D1" }]);
  const mine = await (await call("/me/booking")).json();
  assert.equal(mine.booking, null);
  assert.equal(mine.last.status, "conflict");
  assert.equal((await statusOf("D1")).callsign, "RYR1");
});

test("a new booking replaces the member's previous one; cancel frees it", async () => {
  await book("D1");
  assert.equal((await book("D3")).status, 201);
  assert.equal(await statusOf("D1"), undefined);
  assert.equal((await statusOf("D3")).state, "booked");

  assert.equal((await call("/me/booking", { method: "DELETE" })).status, 204);
  assert.equal(await statusOf("D3"), undefined);
  assert.equal((await call("/me/booking", { method: "DELETE" })).status, 404);
});

test("a controller's manual assignment overrides the booking", async () => {
  await book("D3");
  const result = await svc.assignStandToPilot("D3", "LFXX", "TVF7", "plugin");
  assert.equal(result.action, "assign");
  assert.equal((await (await call("/me/booking")).json()).last.status, "overridden");
  assert.equal(svc.registry.firstAssignedOf("TVF7").name, "D3");
});

test("a booking survives the registry's two-minute expiry while held", async () => {
  await book("D1");
  skew = 5 * 60 * 1000;
  await cycle(); // refreshes the held stand's timestamp
  const held = svc.registry.firstAssignedOf("AFR123");
  assert.ok(held && Date.now() - held.timestamp < 2 * 60 * 1000);
});
