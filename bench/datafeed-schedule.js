/**
 * Simulates the data platform's publishing against the phase-locking scheduler.
 *
 *   node bench/datafeed-schedule.js [--hours=2] [--verbose]
 *
 * The platform re-publishes VATSIM data on a clock of its own. Measured over
 * three minutes of the live service:
 *
 *   - generation stamps advance in 15.000 s steps (VATSIM's period), with an
 *     occasional 30.000 s step where a generation was skipped entirely
 *   - consecutive publishes land ~15.18 s apart, with a periodic ~17.7 s hiccup
 *   - a generation's age when it first appears sawtooths across ~22-34 s
 *
 * Staleness here is how long a publish had been readable before the poller
 * caught it - the quantity polling actually controls.
 */

const { DatafeedScheduler } = require("../services/datafeedScheduler");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);
const HOURS = Number(args.hours || 2);
const VERBOSE = !!args.verbose;

const VATSIM_PERIOD_MS = 15000;

/**
 * A publisher that re-emits VATSIM generations on its own cadence.
 * `fastMs`/`slowMs` and `slowEvery` reproduce the measured 15.18/17.7 s mix;
 * because its mean period exceeds VATSIM's, it falls behind and skips a
 * generation to catch up, exactly as the real one does.
 */
function makePlatform({ bootAt, fastMs, slowMs, slowEvery, deliveryMs }) {
  const publishes = []; // { at, generationMs }
  let at = bootAt;
  let generation = Math.floor(bootAt / VATSIM_PERIOD_MS) * VATSIM_PERIOD_MS;
  for (let i = 0; i < 40000; i++) {
    // Publish the newest VATSIM generation that has been available long enough.
    const newest =
      Math.floor((at - deliveryMs) / VATSIM_PERIOD_MS) * VATSIM_PERIOD_MS;
    if (newest > generation) generation = newest;
    publishes.push({ at, generationMs: generation });
    at += (i + 1) % slowEvery === 0 ? slowMs : fastMs;
  }
  return {
    publishes,
    // What a read at `now` returns: the most recent publish at or before it.
    read(now) {
      let lo = 0;
      let hi = publishes.length - 1;
      let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (publishes[mid].at <= now) {
          found = publishes[mid];
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return found;
    },
  };
}

function run({ platform, durationMs, startAt, strategy }) {
  let now = startAt;
  const end = startAt + durationMs;
  let requests = 0;
  let duplicates = 0;
  const staleness = [];
  const caughtPublishes = new Set();
  let lastGeneration = null;

  while (now < end) {
    const publish = platform.read(now);
    requests++;
    const isNew = publish !== null && publish.generationMs !== lastGeneration;
    if (isNew) {
      caughtPublishes.add(publish.at);
      staleness.push(now - publish.at);
      lastGeneration = publish.generationMs;
    } else {
      duplicates++;
    }
    now += strategy({
      generationMs: publish ? publish.generationMs : null,
      fetchedAt: now,
    });
  }

  const publishedInWindow = platform.publishes.filter(
    (p) => p.at >= startAt && p.at < end
  );
  // Distinct generations the platform actually offered in the window.
  const offered = new Set(publishedInWindow.map((p) => p.generationMs)).size;
  const sorted = [...staleness].sort((a, b) => a - b);
  const mean = staleness.reduce((s, v) => s + v, 0) / (staleness.length || 1);

  return {
    requests,
    duplicates,
    generations: caughtPublishes.size,
    requestsPerGeneration: +(requests / (caughtPublishes.size || 1)).toFixed(3),
    missed: Math.max(0, offered - caughtPublishes.size),
    stalenessMeanMs: Math.round(mean),
    stalenessP50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)] || 0),
    stalenessMaxMs: Math.round(sorted[sorted.length - 1] || 0),
  };
}

function table(rows) {
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  );
  const line = (vals) =>
    vals.map((v, i) => String(v).padStart(width[i])).join("  ");
  console.log(line(cols));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : ` - ${detail}`}`);
}

const durationMs = HOURS * 3600 * 1000;
const BOOT_OFFSETS = [];
for (let ms = 0; ms < 16000; ms += 500) BOOT_OFFSETS.push(ms);

// The measured profile, plus a steadier and a rougher variant.
const PROFILES = [
  { name: "measured (15.18/17.7 s)", fastMs: 15184, slowMs: 17710, slowEvery: 3 },
  { name: "steady    (15.18 s)", fastMs: 15184, slowMs: 15184, slowEvery: 999 },
  { name: "rough     (15.2/19 s)", fastMs: 15200, slowMs: 19000, slowEvery: 4 },
];

console.log(`simulating ${HOURS}h per case\n`);

for (const profile of PROFILES) {
  const rows = [];
  const locked = [];
  const fixed = [];

  for (const bootOffsetMs of BOOT_OFFSETS) {
    const platform = makePlatform({
      bootAt: 600000,
      deliveryMs: 14000,
      ...profile,
    });
    const startAt = 900000 + bootOffsetMs;

    const f = run({
      platform,
      durationMs,
      startAt,
      strategy: () => VATSIM_PERIOD_MS,
    });

    const scheduler = new DatafeedScheduler();
    let lockedAfter = null;
    let polls = 0;
    const l = run({
      platform,
      durationMs,
      startAt,
      strategy: ({ generationMs, fetchedAt }) => {
        polls++;
        const r = scheduler.observe({
          ok: generationMs !== null,
          generationMs,
          fetchedAt,
        });
        if (r.locked && lockedAfter === null) lockedAfter = polls;
        if (VERBOSE) console.log(r.phase, r.periodMs, r.delayMs);
        return r.delayMs;
      },
    });
    l.lockedAfterPolls = lockedAfter;
    l.periodEstimateMs = Math.round(scheduler.periodMs);

    locked.push(l);
    fixed.push(f);
    rows.push(
      { strategy: "fixed", boot: bootOffsetMs, ...strip(f) },
      { strategy: "locked", boot: bootOffsetMs, ...strip(l) }
    );
  }

  console.log(`--- ${profile.name} (${BOOT_OFFSETS.length} boot offsets) ---`);

  const lMeans = locked.map((r) => r.stalenessMeanMs);
  const fMeans = fixed.map((r) => r.stalenessMeanMs);
  console.log("");
  console.log(
    `  mean staleness - fixed: ${Math.min(...fMeans)}-${Math.max(...fMeans)} ms, ` +
      `locked: ${Math.min(...lMeans)}-${Math.max(...lMeans)} ms`
  );
  const lockPolls = locked.map((r) => r.lockedAfterPolls);
  check(
    "locks on every boot offset",
    lockPolls.every((v) => v !== null),
    `never locked at offsets: ${BOOT_OFFSETS.filter((_, i) => lockPolls[i] === null).join(",")}`
  );
  check(
    "acquires quickly whatever the boot offset (<= 30 polls)",
    lockPolls.every((v) => v !== null && v <= 30),
    `worst ${Math.max(...lockPolls.filter((v) => v !== null))} polls`
  );
  check(
    "beats a fixed interval on staleness",
    Math.max(...lMeans) < Math.min(...fMeans),
    `locked worst ${Math.max(...lMeans)} vs fixed best ${Math.min(...fMeans)}`
  );
  check(
    "misses no publishes",
    locked.every((r) => r.missed === 0),
    locked.map((r) => r.missed).join(",")
  );
  check(
    "keeps the expensive fetch to one per publish (probes are stats-only)",
    locked.every((r) => r.requestsPerGeneration < 2.5),
    locked.map((r) => r.requestsPerGeneration).join(",")
  );
  check(
    "estimate does not ratchet away from the real interval",
    locked.every((r) => r.periodEstimateMs < profile.slowMs + 2000),
    locked.map((r) => r.periodEstimateMs).join(",")
  );
  console.log("");
}

function strip(r) {
  return {
    requests: r.requests,
    dupes: r.duplicates,
    caught: r.generations,
    "req/gen": r.requestsPerGeneration,
    missed: r.missed,
    stale_mean: r.stalenessMeanMs,
    stale_p50: r.stalenessP50Ms,
    stale_max: r.stalenessMaxMs,
  };
}

console.log(
  failures === 0 ? "ALL SCHEDULER CHECKS PASSED" : `${failures} CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
