const { useAirports, clearRegistry, stand } = require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const airportIndex = require("../services/airportIndex");
const svc = require("../services/occupancyService");
const v1 = require("../controllers/v1Controller");
const { Stand, registry } = svc;

const RAW = {
  ICAO: "LFXX",
  Coordinates: "45.0:5.0:5000",
  Assignment: { Mode: "greedy" },
  Stands: {
    // Contact, tier 1
    C1: stand(45.001, { Priority: 1, Code: "CD", Use: "A", Schengen: true }),
    C2: stand(45.002, { Priority: 1, Code: "C", Use: "A", Schengen: true }),
    C3: stand(45.003, { Priority: 1, Code: "DE", Use: "A", Schengen: true }),
    // Remote, tier 2
    R1: stand(45.004, { Priority: 2, Code: "CDEF", Use: "A" }),
    R2: stand(45.005, { Priority: 2, Code: "CDEF", Use: "A" }),
    // Non-Schengen contact, airline-only stand, cargo apron, GA
    N1: stand(45.006, { Priority: 1, Code: "CD", Use: "A", Schengen: false }),
    K1: stand(45.007, { Priority: 1, Code: "C", Use: "A", Callsigns: ["KLM"] }),
    CARGO: { Coordinates: "45.008:5.0:25", Use: "C", Apron: { Size: 1 } },
    GA1: stand(45.009, { Use: "P", Wingspan: 15 }),
  },
};

let derived;
let airport;
test.beforeEach(async () => {
  ({ derived } = useAirports([structuredClone(RAW)]));
  airport = await airportIndex.get("LFXX");
  clearRegistry(registry);
});

const evaluate = (input) =>
  svc.evaluateStand(airport, derived, { origin: "LEMD", remarks: null, ...input });
const names = (stands) => stands.map((s) => s.name).sort();

test("fit filters: code, schengen, use, callsign list", () => {
  // A320 from Spain: code C, Schengen. Tier-1 Schengen code-C stands only.
  const a320 = evaluate({ callsign: "AFR123", aircraftType: "A320" });
  assert.deepEqual(names(a320.candidates), ["C1", "C2"]);
  assert.equal(a320.profile.code, "C");
  assert.equal(a320.profile.schengen, true);

  // Non-Schengen origin gets the non-Schengen contact stand.
  assert.deepEqual(names(evaluate({ callsign: "BAW1", aircraftType: "A320", origin: "EGLL" }).candidates), ["N1"]);

  // KLM may use its own stand.
  assert.ok(names(evaluate({ callsign: "KLM1", aircraftType: "B738", origin: "EHAM" }).candidates).includes("K1"));

  // Cargo goes to the cargo apron (by remark, by operator).
  assert.deepEqual(names(evaluate({ callsign: "AFR9", aircraftType: "A320", remarks: "CARGO FLIGHT" }).candidates), ["CARGO"]);
  assert.deepEqual(names(evaluate({ callsign: "FDX1", aircraftType: "A320" }).candidates), ["CARGO"]);
});

test("departure: Schengen decided by the destination, same fit rules", () => {
  const depart = (input) =>
    svc.evaluateStand(airport, derived, { direction: "departure", remarks: null, ...input });

  const toSpain = depart({ callsign: "AFR123", aircraftType: "A320", otherAirport: "LEMD" });
  assert.deepEqual(names(toSpain.candidates), ["C1", "C2"]);
  assert.equal(toSpain.profile.schengen, true);
  assert.equal(toSpain.profile.originPrefix, "LE", "countries are matched against the other end");

  const toLondon = depart({ callsign: "BAW1", aircraftType: "A320", otherAirport: "EGLL" });
  assert.deepEqual(names(toLondon.candidates), ["N1"]);
  assert.equal(toLondon.profile.schengen, false);
});

test("wingspan limit on a stand", () => {
  // C172 is GA (11 m): fits GA1 (max 15 m).
  assert.deepEqual(names(evaluate({ callsign: "FGKXA", aircraftType: "C172" }).candidates), ["GA1"]);
});

test("priority tier: only the best free tier is offered", () => {
  registry.addOccupied(new Stand("C1", "LFXX", "X1"));
  registry.addAssigned(new Stand("C2", "LFXX", "X2"));
  const r = evaluate({ callsign: "AFR123", aircraftType: "A320" });
  assert.deepEqual(names(r.candidates), ["R1", "R2"], "tier 1 is taken, so tier 2");
  assert.ok(r.fitCount >= 4);
});

test("blocked stands are unavailable unless blocked by the same callsign", () => {
  registry.addBlocked(new Stand("C1", "LFXX", "OTHER"));
  assert.deepEqual(names(evaluate({ callsign: "AFR123", aircraftType: "A320" }).candidates), ["C2"]);
  registry.removeAllBlockedOf("OTHER");
  registry.addBlocked(new Stand("C1", "LFXX", "AFR123"));
  registry.addAssigned(new Stand("C2", "LFXX", "AFR123"));
  assert.deepEqual(names(evaluate({ callsign: "AFR123", aircraftType: "A320" }).candidates), ["C1", "C2"], "its own holdings count as free");
});

test("a full apron is unavailable", () => {
  registry.addOccupied(new Stand("CARGO", "LFXX", "FDX9", "", 1));
  const r = evaluate({ callsign: "FDX1", aircraftType: "A320" });
  assert.deepEqual(r.candidates, []);
  assert.equal(r.fitCount, 1);
  assert.equal(v1._internal.buildSuggestion("LFXX", r).reason, "all_compatible_occupied");
});

test("provisional mode: a suggestion never takes another aircraft's stand", async () => {
  ({ derived } = useAirports([{ ...structuredClone(RAW), Assignment: { Mode: "provisional" } }]));
  airport = await airportIndex.get("LFXX");
  // A provisional holder far out: the engine would let an earlier arrival take
  // C1 and C2 from it; a suggestion must not.
  for (const name of ["C1", "C2"]) {
    const held = new Stand(name, "LFXX", `FAR${name}`);
    held.status = "provisional";
    held.eta = 90;
    registry.addAssigned(held);
  }
  const r = evaluate({ callsign: "HOP1", aircraftType: "A320" });
  assert.deepEqual(names(r.candidates), ["R1", "R2"]);
});

test("unknown type: 81 m fallback, flagged, and reported when nothing fits", async () => {
  const r = evaluate({ callsign: "AFR123", aircraftType: "ZZ99" });
  assert.equal(r.profile.typeKnown, false);
  assert.equal(r.profile.wingspan, 81);
  assert.equal(r.profile.code, "F");
  // Code F fits the remote stands, so a stand is found but the flag stays.
  assert.deepEqual(names(r.candidates), ["R1", "R2"]);

  registry.addOccupied(new Stand("R1", "LFXX", "X1"));
  registry.addOccupied(new Stand("R2", "LFXX", "X2"));
  assert.equal(v1._internal.buildSuggestion("LFXX", evaluate({ callsign: "AFR123", aircraftType: "ZZ99" })).reason, "all_compatible_occupied");

  // On an airport with no code-F stand at all, the reason is unknown_type.
  const noF = structuredClone(RAW);
  noF.Stands.R1.Code = "CD";
  noF.Stands.R2.Code = "CD";
  ({ derived } = useAirports([noF]));
  airport = await airportIndex.get("LFXX");
  const s = v1._internal.buildSuggestion("LFXX", evaluate({ callsign: "AFR123", aircraftType: "ZZ99" }));
  assert.equal(s.suggested, null);
  assert.equal(s.reason, "unknown_type");
});

test("no compatible stand at all", () => {
  // A helicopter: no stand admits use H.
  const s = v1._internal.buildSuggestion("LFXX", evaluate({ callsign: "SAMU1", aircraftType: "EC35" }));
  assert.equal(s.suggested, null);
  assert.equal(s.reason, "no_compatible_stand");
});

test("suggestion: a stand alone in its tier still lists the lower tiers", () => {
  // A non-Schengen A320 fits N1 (tier 1, alone) and the remotes (tier 2).
  const s = v1._internal.buildSuggestion("LFXX", evaluate({ callsign: "BAW1", aircraftType: "A320", origin: "EGLL" }));
  assert.equal(s.suggested, "N1");
  assert.deepEqual(s.alternatives, ["R1", "R2"]);
});

test("suggestion: taken stands are never listed as alternatives", () => {
  registry.addOccupied(new Stand("R1", "LFXX", "XYZ123"));
  const s = v1._internal.buildSuggestion("LFXX", evaluate({ callsign: "BAW1", aircraftType: "A320", origin: "EGLL" }));
  assert.deepEqual(s.alternatives, ["R2"]);
});

test("suggestion: tightest first, alternatives by priority, nothing written", () => {
  const before = registry.version;
  const s = v1._internal.buildSuggestion("LFXX", evaluate({ callsign: "AFR123", aircraftType: "A320" }));
  // C2 is code C only (tightest), C1 is C-D; then the tier-2 remotes.
  assert.equal(s.suggested, "C2");
  assert.deepEqual(s.alternatives, ["C1", "R1", "R2"]);
  assert.equal(s.reason, null);
  assert.equal(s.profile.company, "AFR");
  assert.equal(s.profile.otherCountry, "LE");
  assert.equal(s.direction, "arrival");
  assert.equal(registry.version, before, "a suggestion does not touch the registry");
  assert.equal(registry.getAllAssigned().length, 0);
});

test("parity: the engine assigns the stand the suggestion names", async () => {
  const realRandom = Math.random;
  try {
    const cases = [
      { callsign: "AFR123", aircraftType: "A320", origin: "LEMD" },
      { callsign: "BAW45", aircraftType: "A320", origin: "EGLL" },
      { callsign: "KLM7", aircraftType: "B738", origin: "EHAM" },
      { callsign: "AFR9", aircraftType: "A333", origin: "KJFK" },
      { callsign: "FDX1", aircraftType: "A320", origin: "LFPG" },
      { callsign: "XYZ1", aircraftType: "ZZ99", origin: "LEMD" },
    ];
    const occupancy = [[], ["C2"], ["C1", "C2", "R1"]];

    for (const taken of occupancy) {
      for (const [i, input] of cases.entries()) {
        for (const r of [0, 0.51, 0.99]) {
          clearRegistry(registry);
          for (const name of taken) registry.addOccupied(new Stand(name, "LFXX", `PARK${name}`));
          Math.random = () => r;

          const suggested = v1._internal.buildSuggestion("LFXX", evaluate(input)).suggested;
          await svc.processDatafeed({
            onGround: [],
            airborne: [
              {
                callsign: input.callsign,
                latitude: 45.5,
                longitude: 5.0,
                altitude: 20000,
                groundspeed: 400 + i,
                flight_plan: {
                  departure: input.origin,
                  arrival: "LFXX",
                  aircraft_short: input.aircraftType,
                  remarks: "",
                },
              },
            ],
          });
          const assigned = registry.firstAssignedOf(input.callsign);
          assert.equal(
            assigned ? assigned.name : null,
            suggested,
            `${input.callsign} ${input.aircraftType} with ${taken.join(",") || "nothing"} taken, rng ${r}`
          );
        }
      }
    }
  } finally {
    Math.random = realRandom;
  }
});
