/**
 * Watches the phase-locking scheduler converge against the data platform.
 *
 *   node bench/datafeed-live.js [--minutes=4]
 *
 * Fetches only `general` handling - no stand processing - so this is safe to
 * run alongside the API. Prints one line per poll: the generation caught, how
 * old it was when caught, and what the scheduler decided next.
 */
const { DatafeedScheduler, parseTimestampMs } = require("../services/datafeedScheduler");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);
const MINUTES = Number(args.minutes || 4);

// Defaults to the public route so this runs from a workstation; inside the
// network set DATAPLATFORM_URL=http://dataplatform:8080.
const BASE = (
  process.env.DATAPLATFORM_URL || "https://pintade.vatsim.fr/dataplatform"
).replace(/\/+$/, "");
const URL = BASE + "/api/v1/current/vatsim/network/stats";
const scheduler = new DatafeedScheduler();

const pad = (v, n) => String(v).padStart(n);
const started = Date.now();
let polls = 0;
let duplicates = 0;
let generations = 0;
let lockedAtPoll = null;
const ages = [];

async function tick() {
  if (Date.now() - started > MINUTES * 60 * 1000) return summarise();

  let decision;
  let generationMs = null;
  let ageMs = null;
  try {
    const res = await fetch(URL, { headers: { Accept: "application/json" } });
    const data = await res.json();
    const fetchedAt = Date.now();
    generationMs = parseTimestampMs(data && data.last_updated);
    ageMs = Number.isFinite(generationMs) ? fetchedAt - generationMs : null;
    decision = scheduler.observe({ ok: true, generationMs, fetchedAt });
  } catch (err) {
    decision = scheduler.observe({
      ok: false,
      generationMs: null,
      fetchedAt: Date.now(),
    });
    console.log(`poll ${pad(++polls, 3)}  FETCH FAILED: ${err.message}`);
    setTimeout(tick, decision.delayMs);
    return;
  }

  polls++;
  if (decision.isNew) {
    generations++;
    ages.push(ageMs);
  } else {
    duplicates++;
  }
  if (decision.locked && lockedAtPoll === null) lockedAtPoll = polls;

  console.log(
    `poll ${pad(polls, 3)}  ${decision.isNew ? "new " : "DUPE"}  ` +
      `gen=${new Date(generationMs).toISOString().slice(11, 23)}  ` +
      `age=${pad(ageMs, 6)}ms  phase=${decision.phase.padEnd(6)}  ` +
      `period=${pad(decision.periodMs, 6)}ms  late=${pad(decision.latencyMs ?? "-", 5)}ms  next in ${pad(decision.delayMs, 6)}ms`
  );

  setTimeout(tick, decision.delayMs);
}

function summarise() {
  const settled = ages.slice(Math.max(0, ages.length - 8));
  const mean = settled.reduce((s, v) => s + v, 0) / (settled.length || 1);
  console.log("");
  console.log(`polls: ${polls}, generations caught: ${generations}, duplicates: ${duplicates}`);
  console.log(`locked after poll: ${lockedAtPoll ?? "never"}`);
  console.log(`requests per generation: ${(polls / (generations || 1)).toFixed(3)}`);
  console.log(`final publish-interval estimate: ${Math.round(scheduler.periodMs)} ms`);
  console.log(
    `feed age when caught, last ${settled.length}: mean ${Math.round(mean)} ms ` +
      `(min ${Math.min(...settled)}, max ${Math.max(...settled)})`
  );
  process.exit(0);
}

console.log(`watching ${URL} for ${MINUTES} min\n`);
tick();
