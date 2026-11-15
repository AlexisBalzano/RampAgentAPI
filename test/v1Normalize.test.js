const { useAirports } = require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const airportIndex = require("../services/airportIndex");
const v1 = require("../controllers/v1Controller");
const { normalizeStand, normalizeAirportStands, standsCache } = v1._internal;

test("splits Code and Use into letters, null when absent", () => {
  const s = normalizeStand("LFXX", "A1", { Coordinates: "45:5:20", Code: "cde", Use: "AC" });
  assert.deepEqual(s.codes, ["C", "D", "E"]);
  assert.deepEqual(s.uses, ["A", "C"]);
  const bare = normalizeStand("LFXX", "A2", { Coordinates: "45:5" });
  assert.equal(bare.codes, null);
  assert.equal(bare.uses, null);
});

test("schengen is tri-state", () => {
  assert.equal(normalizeStand("LFXX", "a", { Coordinates: "45:5", Schengen: true }).schengen, true);
  assert.equal(normalizeStand("LFXX", "b", { Coordinates: "45:5", Schengen: false }).schengen, false);
  assert.equal(normalizeStand("LFXX", "c", { Coordinates: "45:5" }).schengen, null);
});

test("missing radius defaults to 15; unusable coordinates are skipped", () => {
  assert.equal(normalizeStand("LFXX", "a", { Coordinates: "45.1:5.2" }).radius, 15);
  assert.equal(normalizeStand("LFXX", "b", { Coordinates: "45.1:5.2:30" }).radius, 30);
  assert.equal(normalizeStand("LFXX", "c", { Coordinates: "x:5" }), null);
  assert.equal(normalizeStand("LFXX", "d", {}), null);
});

test("priority, wingspan, lists, apron and remark", () => {
  const s = normalizeStand("LFXX", "K40", {
    Coordinates: "49.000456:2.566853:25",
    Priority: 4,
    Wingspan: 36,
    Callsigns: ["AFR", "BAW"],
    Apron: { Size: 3 },
    Remark: { CD: "PUSH BACK", E: "TOWED" },
    Block: ["K42"],
  });
  assert.equal(s.priority, 4);
  assert.equal(s.maxWingspan, 36);
  assert.deepEqual(s.callsigns, ["AFR", "BAW"]);
  assert.equal(s.countries, null);
  assert.equal(s.apron, true);
  assert.deepEqual(s.remark, { C: "PUSH BACK", D: "PUSH BACK", E: "TOWED" });
  assert.equal("block" in s || "Block" in s, false, "internal fields stay out");
  assert.equal(normalizeStand("LFXX", "x", { Coordinates: "45:5", Priority: 1.5 }).priority, null);
});

test("airport payload carries icao, version and only usable stands", () => {
  const out = normalizeAirportStands({
    ICAO: "LFXX",
    version: "7",
    Stands: { A: { Coordinates: "45:5" }, B: { Coordinates: "bad" } },
  });
  assert.equal(out.icao, "LFXX");
  assert.equal(out.version, "7");
  assert.deepEqual(out.stands.map((s) => s.name), ["A"]);
});

test("the stands cache is dropped when the airport config is invalidated", () => {
  useAirports([]);
  standsCache.set("LFXX", "{}");
  standsCache.set("LFYY", "{}");
  airportIndex.invalidate("LFXX");
  assert.equal(standsCache.has("LFXX"), false);
  assert.equal(standsCache.has("LFYY"), true);
  airportIndex.invalidateAll();
  assert.equal(standsCache.size, 0);
});

test("rate limiter allows the limit per window, then 429", () => {
  let t = 0;
  const limit = v1._internal.createRateLimiter(2, 60_000, () => t);
  const call = () => {
    const res = {
      statusCode: 200,
      headers: {},
      set(k, v) {
        this.headers[k] = v;
      },
      status(c) {
        this.statusCode = c;
        return this;
      },
      json() {
        return this;
      },
    };
    let passed = false;
    limit({ service: "website" }, res, () => (passed = true));
    return { passed, res };
  };
  assert.equal(call().passed, true);
  assert.equal(call().passed, true);
  const third = call();
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  t = 60_000;
  assert.equal(call().passed, true, "a new window opens");
});
