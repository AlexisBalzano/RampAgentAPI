/**
 * Reproduces the failure that made the container disappear: the airport config
 * directory going missing under a running process.
 *
 * Before hardening, the readdirSync inside the version poller threw, the throw
 * surfaced as an unhandled rejection, and Node terminated. This asserts the
 * process now survives, keeps its last known airport list, and recovers when
 * the directory comes back.
 *
 *   node bench/resilience.js
 */
const fs = require("fs");
const path = require("path");

const AIRPORTS_DIR = path.join(__dirname, "..", "data", "airports");
const HIDDEN_DIR = AIRPORTS_DIR + ".hidden";

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : ` - ${detail}`}`);
}

function restore() {
  if (fs.existsSync(HIDDEN_DIR) && !fs.existsSync(AIRPORTS_DIR)) {
    fs.renameSync(HIDDEN_DIR, AIRPORTS_DIR);
  }
}
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(1);
});

const airportService = require("../services/airportService");

(async () => {
  const initial = airportService.getAirportList();
  check("reads the airport list normally", initial.length > 0, `${initial.length} airports`);

  // Take the directory away, exactly as an unpopulated config volume would.
  fs.renameSync(AIRPORTS_DIR, HIDDEN_DIR);

  let threw = null;
  let listWhileMissing = null;
  try {
    listWhileMissing = airportService.refreshAirportList();
  } catch (err) {
    threw = err;
  }

  check("refreshAirportList does not throw when the directory is gone", threw === null,
    threw && threw.message);
  check(
    "keeps the last known airport list",
    Array.isArray(listWhileMissing) && listWhileMissing.length === initial.length,
    `got ${listWhileMissing && listWhileMissing.length}`
  );

  // Repeated failures must not re-log on every tick.
  for (let i = 0; i < 5; i++) airportService.refreshAirportList();
  check("survives repeated failed reads", true);

  // Put it back; the next read should pick it up again.
  restore();
  const recovered = airportService.refreshAirportList();
  check("recovers once the directory returns", recovered.length === initial.length,
    `got ${recovered.length}`);

  // The process is still alive to print this, which is the whole point.
  console.log(
    failures === 0
      ? "\nRESILIENCE OK - process survived the outage"
      : `\n${failures} FAILURE(S)`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
