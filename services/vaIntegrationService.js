/**
 * Virtual airline integrations: a VA's backend books departure stands for its
 * pilots by sending their CID (X-Pilot-Cid) with its own service key, limited
 * to its callsign prefixes. Managed by admins from the dashboard, stored in
 * Redis.
 *
 * Only a SHA-256 of each key is stored: the key is shown once, when it is
 * created or rotated. Requests are matched against an in-memory copy, reloaded
 * from Redis every minute so another instance's changes are picked up; when
 * Redis can't be read the last copy is kept.
 */
const crypto = require("crypto");
const redisService = require("./redisService");
const { info, warn } = require("../utils/logger");

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const PREFIX = /^[A-Z0-9]{2,7}$/;
const MAX_PREFIXES = 10;
const TOUCH_EVERY_MS = 5 * 60 * 1000; // lastUsedAt is written back at most this often
const RELOAD_EVERY_MS = 60 * 1000;

const byId = new Map(); // id -> record
const byHash = new Map(); // key hash -> id
let reloadTimer = null;

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
const newKey = () => `rva_${crypto.randomBytes(32).toString("hex")}`;

class InvalidInput extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
    this.status = 400;
  }
}

function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    prefixes: record.prefixes,
    enabled: record.enabled,
    keyHint: record.keyHint,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    keyRotatedAt: record.keyRotatedAt,
    lastUsedAt: record.lastUsedAt || null,
  };
}

function index(records) {
  byId.clear();
  byHash.clear();
  for (const record of records) {
    if (!record || !ID.test(record.id) || !record.keyHash) continue;
    byId.set(record.id, record);
    byHash.set(record.keyHash, record.id);
  }
}

function put(record) {
  const previous = byId.get(record.id);
  if (previous) byHash.delete(previous.keyHash);
  byId.set(record.id, record);
  byHash.set(record.keyHash, record.id);
}

/** Reads every integration from Redis. Keeps the current copy on failure. */
async function load() {
  try {
    index(await redisService.getAllVaIntegrations());
    return true;
  } catch (err) {
    warn(`Failed to load VA integrations: ${err.message}`, { category: "Service" });
    return false;
  }
}

function startReloading() {
  if (reloadTimer) return;
  reloadTimer = setInterval(load, RELOAD_EVERY_MS);
  reloadTimer.unref();
}

function readPrefixes(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,|]+/) : null;
  if (!list) throw new InvalidInput("prefixes is required", "prefixes");
  const prefixes = [...new Set(list.map((p) => String(p).trim().toUpperCase()).filter(Boolean))];
  if (prefixes.length === 0) throw new InvalidInput("At least one callsign prefix is required", "prefixes");
  if (prefixes.length > MAX_PREFIXES) throw new InvalidInput(`At most ${MAX_PREFIXES} prefixes`, "prefixes");
  const bad = prefixes.find((p) => !PREFIX.test(p));
  if (bad) throw new InvalidInput(`"${bad}" is not a callsign prefix (2-7 letters or digits)`, "prefixes");
  return prefixes;
}

function readName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length < 2 || name.length > 60) throw new InvalidInput("name must be 2-60 characters", "name");
  return name;
}

function slug(name) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const list = () => [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)).map(publicView);

/** Creates an integration. Returns { integration, key }: the only time the key is seen. */
async function create({ name, prefixes, by }) {
  const cleanName = readName(name);
  const cleanPrefixes = readPrefixes(prefixes);
  const id = slug(cleanName);
  if (!ID.test(id)) throw new InvalidInput("name must contain letters or digits", "name");
  if (byId.has(id)) {
    const err = new InvalidInput(`An integration named "${id}" already exists`, "name");
    err.status = 409;
    throw err;
  }
  const key = newKey();
  const t = new Date().toISOString();
  const record = {
    id,
    name: cleanName,
    prefixes: cleanPrefixes,
    enabled: true,
    keyHash: hashKey(key),
    keyHint: key.slice(-4),
    createdAt: t,
    createdBy: by ? String(by) : null,
    updatedAt: t,
    keyRotatedAt: t,
    lastUsedAt: null,
  };
  await redisService.setVaIntegration(record);
  put(record);
  info(`VA integration "${id}" created by ${by} for callsigns ${cleanPrefixes.join(", ")}`, { category: "Service" });
  return { integration: publicView(record), key };
}

/** Changes name, prefixes or enabled. Null when it does not exist. */
async function update(id, changes, by) {
  const current = byId.get(id);
  if (!current) return null;
  const next = { ...current };
  if (changes.name !== undefined) next.name = readName(changes.name);
  if (changes.prefixes !== undefined) next.prefixes = readPrefixes(changes.prefixes);
  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== "boolean") throw new InvalidInput("enabled must be true or false", "enabled");
    next.enabled = changes.enabled;
  }
  next.updatedAt = new Date().toISOString();
  await redisService.setVaIntegration(next);
  put(next);
  info(
    `VA integration "${id}" updated by ${by}: ${next.enabled ? "enabled" : "disabled"}, callsigns ${next.prefixes.join(", ")}`,
    { category: "Service" }
  );
  return publicView(next);
}

/** Replaces the key; the old one stops working at once. Null when it does not exist. */
async function rotate(id, by) {
  const current = byId.get(id);
  if (!current) return null;
  const key = newKey();
  const t = new Date().toISOString();
  const next = { ...current, keyHash: hashKey(key), keyHint: key.slice(-4), keyRotatedAt: t, updatedAt: t };
  await redisService.setVaIntegration(next);
  put(next);
  info(`VA integration "${id}" key rotated by ${by}`, { category: "Service" });
  return { integration: publicView(next), key };
}

async function remove(id, by) {
  const current = byId.get(id);
  if (!current) return false;
  await redisService.deleteVaIntegration(id);
  byId.delete(id);
  byHash.delete(current.keyHash);
  info(`VA integration "${id}" deleted by ${by}`, { category: "Service" });
  return true;
}

/** The enabled integration owning `presented`, or null. */
function match(presented) {
  if (!presented || byHash.size === 0) return null;
  const id = byHash.get(hashKey(presented));
  const record = id && byId.get(id);
  if (!record || !record.enabled) return null;
  touch(record);
  return { id: record.id, name: record.name, prefixes: record.prefixes };
}

function touch(record) {
  const t = Date.now();
  const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (t - last < TOUCH_EVERY_MS) return;
  record.lastUsedAt = new Date(t).toISOString();
  redisService.setVaIntegration(record).catch(() => {}); // best effort: only a dashboard hint
}

// For the tests.
function _reset() {
  byId.clear();
  byHash.clear();
}

module.exports = { load, startReloading, list, create, update, rotate, remove, match, hashKey, _reset };
