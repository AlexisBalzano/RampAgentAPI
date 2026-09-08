/**
 * Restart survival for the gate TELEX.
 *
 *   node bench/telex-restart.js
 *
 * The record of "already notified" lived only in a process-local Map. A
 * container restart wiped it: the stand registry came back empty too, so every
 * inbound aircraft was assigned a stand again, and nothing remembered its pilot
 * had been told the gate moments earlier - so they were told a second time.
 *
 * The record is now mirrored into Redis and read back before the first datafeed
 * cycle, so the repeat is prevented rather than sent. Redis is faked in process
 * here, but every line of redisService and occupancyService under test is the
 * real one: key naming, TTL, JSON round-trip and session expiry all run.
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

// Enough of a Redis client for the record API: a Map, a prefix glob, and the
// expiry recorded rather than enforced.
const store = new Map(); // key -> { value, ttl }
const fakeRedis = {
  async set(key, value, options) {
    store.set(key, { value, ttl: options && options.EX });
    return "OK";
  },
  async del(key) {
    return store.delete(key) ? 1 : 0;
  },
  async keys(pattern) {
    if (!pattern.endsWith("*")) throw new Error(`unsupported pattern ${pattern}`);
    const prefix = pattern.slice(0, -1);
    return [...store.keys()].filter((k) => k.startsWith(prefix));
  },
  async mGet(keys) {
    return keys.map((k) => (store.has(k) ? store.get(k).value : null));
  },
};

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

// A restart is exactly this: the module's Maps - notificationState and the
// stand registry - are gone, while Redis is not. Dropping only occupancyService
// from the cache reproduces that, since redisService stays the same singleton.
function restart() {
  delete require.cache[require.resolve("../services/occupancyService")];
  return require("../services/occupancyService");
}

(async () => {
  await new Promise((r) => pinede.listen(0, r));
  process.env.PINEDE_INTERNAL_URL = `http://127.0.0.1:${pinede.address().port}`;
  process.env.PINEDE_SERVICE_TOKEN = "test-token";

  const redisService = require("../services/redisService");
  redisService.client = fakeRedis;
  redisService.isConnected = true;

  const airportService = require("../services/airportService");
  const config = {
    ...(await airportService.getConfig()),
    max_alt: 40000,
    max_distance: 200,
    Hoppie: { min_alt: 10000 },
  };
  airportService.getConfig = async () => config;

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

  const ac = {
    callsign: "AFR123",
    latitude: 48.0,
    longitude: 2.4,
    altitude: 25000,
    groundspeed: 400,
    flight_plan: { departure: "LFBO", arrival: "LFPG", aircraft_short: "A320", remarks: "" },
  };

  let svc = require("../services/occupancyService");
  const cycle = async (airborne) => {
    await svc.processDatafeed({ onGround: [], airborne });
    await settle();
  };

  // 1. Notified once, and the fact of it written to Redis.
  await cycle([ac]);
  check("notified on first assignment", posts.length === 1, `${posts.length} posts`);

  const entry = store.get("telex:notified:AFR123");
  check("the send was recorded in Redis", !!entry, `keys: ${[...store.keys()]}`);
  check("it carries the one hour expiry", !!entry && entry.ttl === 3600,
    entry ? `ttl ${entry.ttl}` : "no entry");

  // 2. Restart. The registry is empty, so the aircraft is assigned a stand all
  //    over again - this is the cycle that used to send a second message.
  svc = restart();
  check("precondition: the restart emptied the registry",
    svc.getAllAssigned().length === 0, `${svc.getAllAssigned().length} assigned`);

  const restored = await svc.loadPersistedNotifications();
  check("the record was restored from Redis", restored === 1, `restored ${restored}`);

  await cycle([ac]);
  check(
    "no second message after a restart",
    posts.length === 1,
    `${posts.length} posts: ${posts.map((p) => p.text).join(" | ")}`
  );
  check("it was in fact reassigned a stand",
    svc.getAllAssigned().some((s) => s.callsign === "AFR123"), "holds nothing");

  // 3. Control: the same restart without the reload. If this does not resend,
  //    the check above proves nothing about the reload.
  const before = posts.length;
  svc = restart();
  await cycle([ac]);
  check(
    "control: without the reload it does resend",
    posts.length === before + 1,
    `${posts.length - before} extra posts`
  );

  // 4. The session ending still clears both copies, so a genuinely new session
  //    under the same callsign is not blocked by a leftover record.
  await cycle([]);
  svc.registry.removeAllAssignedOf("AFR123");
  svc.registry.removeAllBlockedOf("AFR123");
  svc.registry.removeAllOccupiedOf("AFR123");
  await cycle([]);
  check(
    "the ended session cleared the Redis record",
    !store.has("telex:notified:AFR123"),
    `keys: ${[...store.keys()]}`
  );

  const after = posts.length;
  await cycle([ac]);
  check("and a new session may notify again", posts.length === after + 1,
    `${posts.length - after} posts`);

  // 5. A session that outlives the TTL keeps its record: every cycle it is seen
  //    pushes the expiry back, throttled to half the TTL so it costs one
  //    command per callsign per half hour rather than one per cycle. The TTL is
  //    dropped to a second here so that half hour is reachable in a bench; the
  //    restart is what makes occupancyService re-read it.
  redisService.constructor.TELEX_NOTIFIED_EXPIRATION = 1;
  svc = restart();
  await svc.loadPersistedNotifications();

  const sentAt = JSON.parse(store.get("telex:notified:AFR123").value).sentAt;

  store.get("telex:notified:AFR123").ttl = 999; // sentinel: a refresh overwrites it
  await cycle([ac]);
  check(
    "not refreshed again within the throttle window",
    store.get("telex:notified:AFR123").ttl === 999,
    `ttl ${store.get("telex:notified:AFR123").ttl}`
  );

  await new Promise((r) => setTimeout(r, 600));
  await cycle([ac]);
  check(
    "a live session pushes its expiry back",
    store.get("telex:notified:AFR123").ttl === 1,
    `ttl ${store.get("telex:notified:AFR123").ttl}`
  );
  check(
    "and the refresh keeps the original send time",
    JSON.parse(store.get("telex:notified:AFR123").value).sentAt === sentAt,
    `${JSON.parse(store.get("telex:notified:AFR123").value).sentAt} != ${sentAt}`
  );

  pinede.close();
  console.log(failures === 0 ? "\nRESTART RULES OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
