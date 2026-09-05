/**
 * Session rules for the gate TELEX.
 *
 *   node bench/telex-session.js
 *
 * One callsign got two messages naming different gates. The record of "already
 * notified" was expired whenever the callsign held no stands, but holding no
 * stands is not the same as having gone: an aircraft whose stand is taken and
 * cannot be given another holds nothing at all. The next assignment then looked
 * like a fresh session and notified again.
 *
 * A session now ends only after the callsign is absent from the datafeed for
 * two consecutive cycles.
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

(async () => {
  await new Promise((r) => pinede.listen(0, r));
  process.env.PINEDE_INTERNAL_URL = `http://127.0.0.1:${pinede.address().port}`;
  process.env.PINEDE_SERVICE_TOKEN = "test-token";

  const airportService = require("../services/airportService");
  const config = {
    ...(await airportService.getConfig()),
    max_alt: 40000,
    max_distance: 200,
    Hoppie: { min_alt: 10000 },
  };
  airportService.getConfig = async () => config;

  // Two stands, so the aircraft can be moved from one gate to the other.
  const airport = {
    ICAO: "LFPG",
    Coordinates: "49.010965:2.560501:6000",
    Hoppie: { MessageTemplate: "EXPECT TERMINAL {terminal}", BriefingUrl: "" },
    Stands: {
      A01: { Coordinates: "48.999947:2.560557:25", Use: "A", Terminal: "2A" },
      B01: { Coordinates: "48.999950:2.560560:25", Use: "A", Terminal: "2B" },
    },
  };
  airportService.getAirportList = () => ["LFPG"];
  airportService.getAirportConfig = async () => airport;

  const svc = require("../services/occupancyService");

  const inbound = (callsign) => ({
    callsign,
    latitude: 48.0,
    longitude: 2.4,
    altitude: 25000,
    groundspeed: 400,
    flight_plan: { departure: "LFBO", arrival: "LFPG", aircraft_short: "A320", remarks: "" },
  });

  const cycle = async (airborne) => {
    await svc.processDatafeed({ onGround: [], airborne });
    await settle();
  };

  const ac = inbound("AFR123");

  // 1. First assignment notifies once.
  await cycle([ac]);
  check("notified on first assignment", posts.length === 1, `${posts.length} posts`);
  const firstGate = posts[0] && posts[0].text;

  // 2. Both stands fill up, so when its own is taken there is nothing to move
  //    it to and it ends the cycle holding no stands at all. That is the state
  //    the old rule treated as "session over".
  svc.registry.addOccupied(new svc.Stand("A01", "LFPG", "BAW999", "", 0));
  svc.registry.addOccupied(new svc.Stand("B01", "LFPG", "DLH777", "", 0));
  await cycle([ac]);

  const strandedHolds = svc.getAllAssigned().some((s) => s.callsign === "AFR123");
  check("precondition: it now holds no stand", !strandedHolds, "still holds one");

  // 3. A stand frees up and it is assigned again - to a different gate. With
  //    the record expired this sent a second message.
  svc.registry.removeAllOccupiedOf("DLH777");
  await cycle([ac]);

  check(
    "no second message after being moved to another gate",
    posts.length === 1,
    `${posts.length} posts: ${posts.map((p) => p.text).join(" | ")}`
  );

  const assigned = svc.getAllAssigned().find((s) => s.callsign === "AFR123");
  check("it was in fact reassigned to a different gate", !!assigned && assigned.name !== "A01",
    assigned ? assigned.name : "not assigned");
  void firstGate;

  svc.registry.removeAllOccupiedOf("BAW999");

  // 3. Absent for one cycle only - still the same session.
  await cycle([]);
  await cycle([ac]);
  check("one missed cycle does not start a new session", posts.length === 1, `${posts.length} posts`);

  // 4. Absent for two consecutive cycles, and the registry entries timed out as
  //    they would after two minutes of silence: the session is over, so a later
  //    arrival under the same callsign may notify again.
  await cycle([]);
  svc.registry.removeAllAssignedOf("AFR123");
  svc.registry.removeAllBlockedOf("AFR123");
  svc.registry.removeAllOccupiedOf("AFR123");
  await cycle([]);
  await cycle([ac]);
  check("a genuinely ended session may notify again", posts.length === 2, `${posts.length} posts`);

  // 5. While a stale assignment is still held, absence alone must not reopen it.
  const other = inbound("DLH456");
  await cycle([other]); // AFR123 absent, but still holding the stand from step 4
  await cycle([other]);
  await cycle([other]);
  const before = posts.length;
  svc.registry.removeAllAssignedOf("AFR123");
  await cycle([ac]);
  check(
    "a lingering assignment keeps the record alive",
    posts.length === before,
    `${posts.length - before} extra posts`
  );

  pinede.close();
  console.log(failures === 0 ? "\nSESSION RULES OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
