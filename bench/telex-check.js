/**
 * Drives the real assignment path with a stub PINEDE and counts TELEX posts.
 *
 *   node bench/telex-check.js
 *
 * The bug this exists for: postTelex returned undefined on success, so the
 * caller never marked the callsign 'sent' and re-posted every recheck window
 * for the rest of the flight. One aircraft, many cycles, must be one TELEX.
 */
const http = require("http");
const Module = require("module");

// Silence the logger (sqlite + console) before anything pulls it in.
const loggerPath = require.resolve("../utils/logger");
const stub = new Module(loggerPath);
stub.filename = loggerPath;
stub.loaded = true;
const logs = [];
stub.exports = {
  info: (m) => logs.push("INFO " + m),
  warn: (m) => logs.push("WARN " + m),
  error: (m) => logs.push("ERROR " + m),
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
    posts.push({
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(body || "{}"),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

(async () => {
  await new Promise((r) => pinede.listen(0, r));
  const port = pinede.address().port;
  process.env.PINEDE_INTERNAL_URL = `http://127.0.0.1:${port}`;
  process.env.PINEDE_SERVICE_TOKEN = "test-token";

  const airportService = require("../services/airportService");

  // A wide envelope, and a Hoppie block so eligibility can be satisfied.
  const config = {
    ...(await airportService.getConfig()),
    max_alt: 40000,
    max_distance: 200,
    Hoppie: { MinAltitudeFt: 10000 },
  };
  airportService.getConfig = async () => config;

  // One airport, one stand, carrying the Terminal + Hoppie config the feature needs.
  const airport = {
    ICAO: "LFPG",
    Coordinates: "49.010965:2.560501:6000",
    Hoppie: {
      MessageTemplate: "GATE INFO: TERMINAL {terminal} - {briefingUrl}",
      BriefingUrl: "https://example.invalid/brief",
    },
    Stands: {
      A01: {
        Coordinates: "48.999947:2.560557:25",
        Code: "CDE",
        Use: "A",
        Terminal: "2E",
      },
    },
  };
  airportService.getAirportList = () => ["LFPG"];
  airportService.getAirportConfig = async () => airport;

  const occupancyService = require("../services/occupancyService");

  // Inbound, 60 nm out at FL250 - inside the widened envelope and above the
  // Hoppie threshold, so it should notify on the first automatic assignment.
  const aircraft = {
    callsign: "AFR123",
    latitude: 48.0,
    longitude: 2.4,
    altitude: 25000,
    groundspeed: 400,
    flight_plan: {
      departure: "LFBO",
      arrival: "LFPG",
      aircraft_short: "A320",
      remarks: "",
    },
  };

  // Ten cycles is well past HOPPIE_RECHECK_TICKS (4), so a resend bug shows up.
  for (let cycle = 0; cycle < 10; cycle++) {
    await occupancyService.processDatafeed({ onGround: [], airborne: [aircraft] });
    await new Promise((r) => setTimeout(r, 60)); // let the fire-and-forget post land
  }

  console.log(`TELEX posts observed: ${posts.length}`);
  if (posts[0]) {
    console.log(`  url:  ${posts[0].url}`);
    console.log(`  auth: ${posts[0].auth}`);
    console.log(`  body: ${JSON.stringify(posts[0].body)}`);
  }
  console.log("");

  check("the aircraft was assigned a stand", occupancyService.getAllAssigned().length === 1,
    `${occupancyService.getAllAssigned().length} assigned`);
  check("exactly one TELEX for ten cycles (no resend loop)", posts.length === 1,
    `${posts.length} posts`);
  check("posted to the internal telex endpoint", posts[0] && posts[0].url === "/v1/internal/telex",
    posts[0] && posts[0].url);
  check("carried the service token", posts[0] && posts[0].auth === "test-token",
    posts[0] && posts[0].auth);
  check("addressed to the callsign", posts[0] && posts[0].body.callsign === "AFR123",
    posts[0] && posts[0].body.callsign);
  check(
    "template placeholders were substituted",
    posts[0] && posts[0].body.message === "GATE INFO: TERMINAL 2E - https://example.invalid/brief",
    posts[0] && posts[0].body.message
  );
  check(
    "the send was logged once",
    logs.filter((l) => l.includes("notification sent")).length === 1,
    logs.filter((l) => l.includes("notification sent")).length + " log lines"
  );

  pinede.close();
  console.log(failures === 0 ? "\nTELEX PATH OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
