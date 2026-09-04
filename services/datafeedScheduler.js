/**
 * Phase-locking poll scheduler for the data platform's traffic feed.
 *
 * VATSIM regenerates every 15.000 s, but we no longer read VATSIM: the data
 * platform re-publishes that data on a clock of its own. It forwards VATSIM's
 * generation timestamps unchanged, so those still identify a generation, but
 * they say nothing useful about when it becomes readable here - measured, the
 * age of a generation when it first appears sawtooths across roughly 22-34 s,
 * drifting up a little each cycle until the platform falls a whole period
 * behind, skips a generation, and resets.
 *
 * So the phase to lock onto is the platform's *publish* cadence, not the
 * generation timestamps. Measured, consecutive publishes land about 15.18 s
 * apart with a periodic 17.7 s hiccup. This tracks the interval between
 * successive catches and aims each poll just past the next expected publish.
 *
 * What a fixed interval gets wrong is still the point: a 15.000 s timer against
 * a ~15.18 s publisher creeps earlier every cycle, so staleness wanders across
 * the whole range - measured in simulation, a mean of ~7.4 s whatever offset
 * the container boots with. Anchoring to the last publish holds position, at a
 * mean of ~0.6 s.
 *
 * The hard part is that a publish time is never directly observable: a catch
 * only proves the publish already happened, so scheduling from catches carries
 * whatever lateness the poller started with, forever. A *stale* read is the
 * useful one - it proves the publish had not happened yet, which bounds it from
 * below. So each poll deliberately aims to arrive a little early and then probes
 * at retryMs until the publish lands. That probe becomes the anchor for the
 * next aim, and the phase stops drifting.
 *
 * Cost is roughly two reads per publish, both of them the few-hundred-byte
 * stats endpoint. Traffic is only ever downloaded once a new generation is
 * confirmed, so probes never pull the pilot list.
 */

const DEFAULTS = {
  // Tuned by sweeping the measured publish profile. Reaching further ahead and
  // probing harder does buy freshness, but with diminishing returns: 1500/700
  // costs 15.6 stats reads a minute for a mean staleness of 388 ms, where
  // 400/1000 costs 7.2 for 681 ms. Traffic is already ~25 s old by the time the
  // platform publishes it, so the cheaper end of the curve is the right one.
  periodMs: 15200, // starting guess for the publish interval
  earlyMs: 400, // how far ahead of the estimate to arrive deliberately
  retryMs: 1000, // gap between probes while waiting for the publish to land
  creepMs: 700, // extra reach per cycle while still hunting the first probe
  smoothing: 0.25, // how fast the interval estimate follows what it observes
  minDelayMs: 500, // never hammer, whatever the arithmetic says
  maxDelayMs: 20000, // never sleep past the next publish entirely
  errorMs: 5000, // wait after a failed fetch
  maxProbes: 12, // give up waiting and re-aim if a publish never lands
};

const clamp = (value, low, high) =>
  value < low ? low : value > high ? high : value;

class DatafeedScheduler {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.lastGenerationMs = null; // newest generation stamp seen, for duplicates
    this.publishAt = null; // estimated wall time of the last publish
    this.floorAt = null; // latest probe that came back stale: publish is after this
    this.periodMs = this.options.periodMs; // estimated publish interval
    this.lastAgeMs = null; // generation age at the last catch, for reporting
    this.lastLatencyMs = null; // how late we were to the last publish
    this.locked = false;
    this.creep = 0; // extra reach accumulated while hunting the first probe
    this.probes = 0;
    this.consecutiveErrors = 0;
  }

  /** Kept for reporting: how stale the last generation was when caught. */
  get lagMs() {
    return this.lastAgeMs;
  }

  /**
   * Feeds one poll result in and returns how to schedule the next.
   *
   * @param {object} observation
   * @param {boolean} observation.ok        the fetch produced a usable body
   * @param {number|null} observation.generationMs  the feed's own timestamp
   * @param {number} observation.fetchedAt  when the response landed here
   * @returns {{isNew: boolean, delayMs: number, nextPollAt: number,
   *            phase: string, lagMs: number|null, locked: boolean}}
   */
  observe({ ok, generationMs, fetchedAt }) {
    const o = this.options;

    if (!ok || !Number.isFinite(generationMs)) {
      // Leave the lock alone: a transient fetch failure says nothing about
      // delivery timing, and dropping the phase would re-run convergence.
      this.consecutiveErrors++;
      return this._result(false, fetchedAt, o.errorMs, "error");
    }
    this.consecutiveErrors = 0;

    if (this.lastGenerationMs === null) {
      this.lastGenerationMs = generationMs;
      this.publishAt = fetchedAt; // upper bound; probes will tighten it
      this.lastAgeMs = Math.max(0, fetchedAt - generationMs);
      return this._result(true, fetchedAt, this._aim(fetchedAt), "seed");
    }

    // A stamp that has not advanced means the next publish has not happened
    // yet. That is the probe answering, and it is the only hard information
    // available about when a publish actually lands: it is later than now.
    if (generationMs <= this.lastGenerationMs) {
      this.floorAt = fetchedAt;
      this.probes++;
      const phase = this.locked ? "wait" : "lock";
      this.locked = true;
      this.creep = 0; // acquired: the probe anchors the phase from here on

      // If a publish never lands, stop probing and re-aim from the estimate
      // rather than sitting in a tight loop.
      if (this.probes >= o.maxProbes) {
        this.probes = 0;
        this.publishAt = fetchedAt;
        return this._result(false, fetchedAt, this._aim(fetchedAt), "stalled");
      }
      return this._result(false, fetchedAt, o.retryMs, phase);
    }

    // A new publish. A probe moments earlier came back stale, so the publish
    // happened between that probe and now - which pins its wall time far more
    // tightly than the catch alone, and is what stops the phase drifting.
    const publishedAt = this.floorAt !== null ? this.floorAt : fetchedAt;

    if (this.publishAt !== null) {
      const observed = publishedAt - this.publishAt;
      // Ignore intervals that clearly do not span exactly one publish - a
      // restart, a stall, or a platform outage - instead of letting them drag
      // the estimate somewhere it cannot recover from.
      if (observed > this.periodMs * 0.5 && observed < this.periodMs * 1.9) {
        this.periodMs += (observed - this.periodMs) * o.smoothing;
      }
    }

    this.lastLatencyMs = fetchedAt - publishedAt;
    this.publishAt = publishedAt;
    this.floorAt = null;
    this.probes = 0;
    this.lastGenerationMs = generationMs;
    this.lastAgeMs = Math.max(0, fetchedAt - generationMs);

    // Until a probe has come back stale, the only anchor is a catch - which is
    // late by an unknown amount, and aiming from it would keep that lateness
    // forever. Reaching a little further each cycle guarantees a stale read
    // eventually, whatever offset this process happened to start on.
    if (!this.locked) this.creep += o.creepMs;

    return this._result(
      true,
      fetchedAt,
      this._aim(fetchedAt),
      this.locked ? "locked" : "probe"
    );
  }

  /**
   * Milliseconds to wait so the next poll lands just *before* the next publish.
   *
   * Arriving deliberately early and then probing at retryMs until it lands
   * costs a couple of extra stats reads - a few hundred bytes each, and never
   * any traffic - and buys two things: staleness bounded by the probe gap
   * rather than by however far the estimate happens to be off, and a fresh
   * lower bound on every publish time, which is what keeps the phase anchored.
   */
  _aim(fetchedAt) {
    const o = this.options;
    const target = this.publishAt + this.periodMs - o.earlyMs - this.creep;
    return clamp(target - fetchedAt, o.minDelayMs, o.maxDelayMs);
  }

  _result(isNew, fetchedAt, delayMs, phase) {
    return {
      isNew,
      delayMs: Math.round(delayMs),
      nextPollAt: Math.round(fetchedAt + delayMs),
      phase,
      periodMs: Math.round(this.periodMs),
      latencyMs: this.lastLatencyMs,
      lagMs: this.lastAgeMs,
      locked: this.locked,
    };
  }
}

/**
 * Parses a generation timestamp to epoch milliseconds, or null.
 *
 * The data platform reports Postgres timestamptz - "2026-09-04 15:09:27.317488+00"
 * - which is not ISO 8601: a space instead of T, and a two-digit offset. V8
 * happens to accept it, but relying on engine leniency for the value the whole
 * poll phase is derived from is not worth the risk, so it is normalised first.
 */
function parseTimestampMs(value) {
  if (typeof value !== "string" || value === "") return null;

  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;

  const normalised = value
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00"); // "+00" -> "+00:00"
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { DatafeedScheduler, parseTimestampMs, DEFAULTS };
