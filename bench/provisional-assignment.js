/**
 * Provisional / firm stand assignment, and the TELEX rules that go with it.
 *
 *   node bench/provisional-assignment.js
 *
 * Issue #68: on a small airport, aircraft picked up far out took the contact
 * stands, and short hops that landed first were sent to remote stands. With
 * "Assignment": { "Mode": "provisional" } a stand stays provisional until the
 * holder is FreezeMinutes out, and until then an aircraft arriving earlier may
 * take it. The TELEX goes out at the freeze, and a pilot never gets more than
 * Hoppie.MaxMessages however often their stand changes.
 */
const http = require("http");
const Module = require("module");

const loggerPath = require.resolve("../utils/logger");
const stub = new Module(loggerPath);
stub.filename = loggerPath;
stub.loaded = true;
stub.exports = {
  info: () => {},
  warn: () => {},
  error: () => {},
  getRecentLogs: () => [],
  cleanupOldLogs: () => {},
};
require.cache[loggerPath] = stub;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : ` - ${detail}`}`);
}

const posts = [];
const pinede = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    posts.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

const settle = () => new Promise((r) => setTimeout(r, 60));

// Corrections wait for the new stand to settle; the clock is moved by hand.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advanceMinutes = (m) => (skew += m * 60 * 1000);

(async () => {
  await new Promise((r) => pinede.listen(0, r));
  process.env.PINEDE_INTERNAL_URL = `http://127.0.0.1:${pinede.address().port}`;
  process.env.PINEDE_SERVICE_TOKEN = "test-token";

  const airportService = require("../services/airportService");
  const config = {
    ...(await airportService.getConfig()),
    max_alt: 45000,
    max_distance: 1000,
    Hoppie: { min_alt: 10000 },
  };
  airportService.getConfig = async () => config;

  // One contact stand (Priority 1) and three remote ones (Priority 2), each
  // TELEX naming its gate through Info.
  const stand = (lat, priority, gate) => ({
    Coordinates: `${lat}:5.0:25`,
    Use: "A",
    Priority: priority,
    Terminal: "1",
    Info: `GATE ${gate}`,
  });
  const airport = {
    ICAO: "LFXX",
    Coordinates: "45.0:5.0:5000",
    Assignment: { Mode: "provisional", FreezeMinutes: 40, PreemptMarginMinutes: 10 },
    Hoppie: { MessageTemplate: "STAND {info}", BriefingUrl: "", MaxMessages: 2 },
    Stands: {
      C1: stand(45.001, 1, "C1"),
      R1: stand(45.002, 2, "R1"),
      R2: stand(45.003, 2, "R2"),
      R3: stand(45.004, 2, "R3"),
      R4: stand(45.005, 2, "R4"),
    },
  };
  airportService.getAirportList = () => ["LFXX"];
  airportService.getAirportConfig = async () => airport;

  const svc = require("../services/occupancyService");
  const telex = svc._notificationState;

  // An aircraft `minutes` out at 450 kt, due north of the field.
  const at = (ac, minutes, altitude = 35000) => {
    const nm = (minutes / 60) * 450;
    ac.latitude = 45 + nm / 60;
    ac.longitude = 5.0;
    ac.groundspeed = 450;
    ac.altitude = altitude;
    return ac;
  };
  const inbound = (callsign, minutes) =>
    at(
      {
        callsign,
        flight_plan: { departure: "LFBO", arrival: "LFXX", aircraft_short: "A320", remarks: "" },
      },
      minutes
    );

  const cycle = async (airborne, onGround = []) => {
    await svc.processDatafeed({ onGround, airborne });
    await settle();
  };
  const held = (callsign) => svc.getAllAssigned().find((s) => s.callsign === callsign);
  const textsTo = (callsign) => posts.filter((p) => p.callsign === callsign).map((p) => p.text);

  // 1. Seen 70 minutes out: best stand, but only provisionally, and no TELEX.
  const far = inbound("AFR100", 70);
  await cycle([far]);
  check("far aircraft gets the contact stand", held("AFR100")?.name === "C1", held("AFR100")?.name);
  check("...provisionally", held("AFR100")?.status === "provisional", held("AFR100")?.status);
  check("...and is sent no TELEX yet", textsTo("AFR100").length === 0, textsTo("AFR100").join(" | "));

  // 2. A short hop due in 30 minutes shows up. It lands first, so it takes the
  //    contact stand; the far aircraft is re-housed in the same cycle.
  const hop = inbound("HOP200", 30);
  at(far, 69);
  await cycle([far, hop]);
  check("short hop takes the contact stand", held("HOP200")?.name === "C1", held("HOP200")?.name);
  check("...firm, being inside the freeze", held("HOP200")?.status === "firm", held("HOP200")?.status);
  check(
    "far aircraft moved to a remote stand in the same cycle",
    /^R/.test(held("AFR100")?.name || ""),
    held("AFR100")?.name
  );
  check(
    "short hop is sent its gate at the freeze",
    textsTo("HOP200").join() === "STAND GATE C1",
    textsTo("HOP200").join(" | ")
  );

  // 3. Within the margin nobody is moved: a 65-min aircraft does not displace a
  //    69-min one (nor would they swap back and forth).
  const near = inbound("EZY300", 65);
  const farStandBefore = held("AFR100")?.name;
  await cycle([far, hop, near]);
  check("no displacement inside the margin", held("AFR100")?.name === farStandBefore,
    `${farStandBefore} -> ${held("AFR100")?.name}`);
  check("...and the newcomer takes a free stand", /^R/.test(held("EZY300")?.name || ""),
    held("EZY300")?.name);

  // 4. A firm stand is never taken, however early the newcomer.
  const early = inbound("TVF400", 10);
  await cycle([far, hop, near, early]);
  check("firm stand kept against an earlier arrival", held("HOP200")?.name === "C1",
    held("HOP200")?.name);

  // 5. The far aircraft reaches the freeze: firm, and its TELEX names its gate.
  at(far, 35);
  await cycle([far, hop, near, early]);
  const farGate = held("AFR100")?.name;
  check("far aircraft is firm at the freeze", held("AFR100")?.status === "firm", held("AFR100")?.status);
  check(
    "...and is sent the gate it holds",
    textsTo("AFR100").join() === `STAND GATE ${farGate}`,
    textsTo("AFR100").join(" | ")
  );

  // 6. Someone connects onto its stand. It is moved; the TELEX is now wrong, but
  //    no correction goes out until the new stand has held for two minutes.
  const squatter = { callsign: "PRIV1", latitude: airport.Stands[farGate].Coordinates.split(":")[0] * 1,
    longitude: 5.0, groundspeed: 0, altitude: 0, flight_plan: null };
  // Free a stand for it to go to.
  svc.registry.removeAllAssignedOf("EZY300");
  svc.registry.removeAllBlockedOf("EZY300");
  at(far, 34);
  await cycle([far, hop, early], [squatter]);
  const moved = held("AFR100");
  check("firm aircraft re-housed after its stand was taken", !!moved && moved.name !== farGate,
    moved && moved.name);
  check("...flagged as differing from its TELEX", moved?.telexStale === true, String(moved?.telexStale));
  check("...with no correction yet", textsTo("AFR100").length === 1, textsTo("AFR100").join(" | "));

  advanceMinutes(1);
  at(far, 33);
  await cycle([far, hop, early], [squatter]);
  check("still none after one minute", textsTo("AFR100").length === 1, textsTo("AFR100").join(" | "));

  advanceMinutes(1.5);
  at(far, 31);
  await cycle([far, hop, early], [squatter]);
  check(
    "one correction once the new stand has held",
    textsTo("AFR100").length === 2 &&
      textsTo("AFR100")[1] === `REVISED STAND GATE ${held("AFR100")?.name}`,
    textsTo("AFR100").join(" | ")
  );
  check("...and the stand is no longer stale", held("AFR100")?.telexStale === false,
    String(held("AFR100")?.telexStale));

  // 7. Lost again: the cap (MaxMessages 2) is used up, so nothing more is sent
  //    however long it waits - the controller sees telexStale instead.
  const secondGate = held("AFR100").name;
  const squatter2 = { ...squatter, callsign: "PRIV2",
    latitude: airport.Stands[secondGate].Coordinates.split(":")[0] * 1 };
  svc.registry.removeAllAssignedOf("TVF400");
  svc.registry.removeAllBlockedOf("TVF400");
  at(far, 30);
  await cycle([far, hop], [squatter, squatter2]);
  for (let i = 0; i < 4; i++) {
    advanceMinutes(1);
    await cycle([far, hop], [squatter, squatter2]);
  }
  check("no third message to the same pilot", textsTo("AFR100").length === 2,
    textsTo("AFR100").join(" | "));
  check("...the stale TELEX is flagged instead", held("AFR100")?.telexStale === true,
    String(held("AFR100")?.telexStale));

  // 8. Inside the cut-off no correction is sent even with budget left.
  svc.registry.removeAllAssignedOf("HOP200");
  svc.registry.removeAllBlockedOf("HOP200");
  const late = inbound("BAW500", 20);
  await cycle([far, late], [squatter, squatter2]);
  const lateGate = held("BAW500")?.name;
  check("late aircraft notified at assignment", textsTo("BAW500").length === 1,
    textsTo("BAW500").join(" | "));
  const squatter3 = { ...squatter, callsign: "PRIV3",
    latitude: airport.Stands[lateGate].Coordinates.split(":")[0] * 1 };
  at(late, 12);
  await cycle([far, late], [squatter, squatter2, squatter3]);
  advanceMinutes(3);
  at(late, 10);
  await cycle([far, late], [squatter, squatter2, squatter3]);
  check("precondition: late aircraft was moved", !!held("BAW500") && held("BAW500").name !== lateGate,
    held("BAW500")?.name);
  check("no correction inside the cut-off", textsTo("BAW500").length === 1,
    textsTo("BAW500").join(" | "));

  // 9. A controller may take a provisional stand; the engine never moves it.
  for (const cs of ["AFR100", "BAW500", "PRIV1", "PRIV2", "PRIV3"]) {
    svc.registry.removeAllAssignedOf(cs);
    svc.registry.removeAllBlockedOf(cs);
    svc.registry.removeAllOccupiedOf(cs);
    telex.delete(cs);
  }
  const prov = inbound("RYR600", 80);
  await cycle([prov]);
  const provStand = held("RYR600")?.name;
  check("precondition: provisional holder", held("RYR600")?.status === "provisional",
    held("RYR600")?.status);
  const result = await svc.assignStandToPilot(provStand, "LFXX", "DLH700", "bench");
  check("manual assignment overrides a provisional hold", result.action === "assign", result.action);
  check("...as a firm, manual stand", held("DLH700")?.status === "firm" && held("DLH700")?.manual === true);
  const dlh = inbound("DLH700", 5);
  await cycle([prov, dlh]);
  check("engine leaves the manual stand alone", held("DLH700")?.name === provStand,
    held("DLH700")?.name);
  check("displaced holder re-housed", !!held("RYR600") && held("RYR600").name !== provStand,
    held("RYR600")?.name);
  check("manual assignment sends no TELEX", textsTo("DLH700").length === 0);

  // 10. "Mode": "greedy" opts an airport back out: first seen keeps the stand,
  //     and the TELEX goes out at the first assignment, however far out.
  for (const cs of ["RYR600", "DLH700"]) {
    svc.registry.removeAllAssignedOf(cs);
    svc.registry.removeAllBlockedOf(cs);
    telex.delete(cs);
  }
  airport.Assignment = { Mode: "greedy" };
  require("../services/airportIndex").invalidateAll();
  const greedyFar = inbound("KLM800", 70);
  await cycle([greedyFar]);
  const greedyHop = inbound("HOP900", 20);
  await cycle([greedyFar, greedyHop]);
  check("greedy: first seen keeps the contact stand", held("KLM800")?.name === "C1",
    held("KLM800")?.name);
  check("greedy: TELEX sent at first assignment", textsTo("KLM800").length === 1,
    textsTo("KLM800").join(" | "));

  pinede.close();
  console.log(failures === 0 ? "\nPROVISIONAL ASSIGNMENT OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
