const airportService = require("./airportService");

/**
 * Compiled, in-process view of the airport and global configs.
 *
 * The datafeed loop re-derives the same handful of facts about every stand on
 * every pass: parsing "lat:lon:radius" strings, splitting Code letters, turning
 * Countries/Callsigns arrays into membership tests, walking a 380-entry
 * wingspan table. None of that changes between config version bumps, so it is
 * computed once here and dropped when a bump lands.
 *
 * Stand order is taken straight from Object.entries(Stands) so that anything
 * relying on "first matching stand wins" keeps behaving identically.
 */

const airports = new Map(); // ICAO -> CompiledAirport | null
let derivedConfig = null;
let derivedConfigSource = null; // identity of the config object it was built from

const DEFAULT_STAND_RADIUS = 30;
const DEFAULT_AIRPORT_RADIUS = 5000;

function parseCoordinates(coordString, defaultRadius) {
  if (!coordString) return null;

  const parts = String(coordString).split(":");
  if (parts.length < 2) return null;

  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lon)) return null;

  const radius = parts[2] ? parseFloat(parts[2]) : defaultRadius;
  return { lat, lon, radius };
}

// Highest letter of a Code string ("CDE" -> "E"), without allocating an array.
function maxCodeLetter(code) {
  let max = "";
  for (let i = 0; i < code.length; i++) {
    if (code[i] > max) max = code[i];
  }
  return max || null;
}

class CompiledStand {
  constructor(name, def) {
    this.name = name;
    this.def = def;

    const coords = parseCoordinates(def.Coordinates, DEFAULT_STAND_RADIUS);
    this.hasCoords = coords !== null;
    this.lat = coords ? coords.lat : 0;
    this.lon = coords ? coords.lon : 0;
    this.radius = coords ? coords.radius : 0;

    this.use = typeof def.Use === "string" ? def.Use : null;
    this.code = typeof def.Code === "string" ? def.Code : null;
    this.maxCode = this.code ? maxCodeLetter(this.code) : null;
    this.schengen = def.Schengen; // may be undefined
    this.wingspan = typeof def.Wingspan === "number" ? def.Wingspan : 0;
    this.priority =
      def.Priority && Number.isInteger(def.Priority) ? def.Priority : 0;

    this.countries = Array.isArray(def.Countries) ? new Set(def.Countries) : null;

    this.callsigns = Array.isArray(def.Callsigns) ? new Set(def.Callsigns) : null;
    this.callsignMaxLen = 0;
    if (this.callsigns) {
      for (const cs of this.callsigns) {
        if (cs.length > this.callsignMaxLen) this.callsignMaxLen = cs.length;
      }
    }

    this.block = Array.isArray(def.Block) ? def.Block : null;

    // Aprons: flat [lat, lon, ...] ring plus a bounding box, so the ray-cast
    // only runs for aircraft that could plausibly be inside it.
    this.hasApron = def.Apron !== undefined;
    this.apronSize = this.hasApron ? def.Apron.Size : 0;
    this.apronRing = null;
    this.apronMinLat = 0;
    this.apronMaxLat = 0;
    this.apronMinLon = 0;
    this.apronMaxLon = 0;

    if (this.hasApron && Array.isArray(def.Apron.Coordinates)) {
      const pts = [];
      for (const coordString of def.Apron.Coordinates) {
        const c = parseCoordinates(coordString, DEFAULT_STAND_RADIUS);
        if (c) pts.push(c.lat, c.lon);
      }
      if (pts.length >= 6) {
        this.apronRing = Float64Array.from(pts);
        this.apronMinLat = this.apronMaxLat = pts[0];
        this.apronMinLon = this.apronMaxLon = pts[1];
        for (let i = 0; i < pts.length; i += 2) {
          if (pts[i] < this.apronMinLat) this.apronMinLat = pts[i];
          if (pts[i] > this.apronMaxLat) this.apronMaxLat = pts[i];
          if (pts[i + 1] < this.apronMinLon) this.apronMinLon = pts[i + 1];
          if (pts[i + 1] > this.apronMaxLon) this.apronMaxLon = pts[i + 1];
        }
      }
    }
  }

  /** Matches a callsign against the stand prefix list (prefixes of length 3+). */
  matchesCallsign(upperCallsign) {
    const max =
      this.callsignMaxLen < upperCallsign.length
        ? this.callsignMaxLen
        : upperCallsign.length;
    for (let len = 3; len <= max; len++) {
      if (this.callsigns.has(upperCallsign.substring(0, len))) return true;
    }
    return false;
  }

  /** Ray-casting point-in-polygon over the precompiled ring. */
  isInApron(lat, lon) {
    const ring = this.apronRing;
    if (!ring) return false;
    if (
      lat < this.apronMinLat ||
      lat > this.apronMaxLat ||
      lon < this.apronMinLon ||
      lon > this.apronMaxLon
    ) {
      return false;
    }

    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = ring[i];
      const xi = ring[i + 1];
      const yj = ring[j];
      const xj = ring[j + 1];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  }
}

class CompiledAirport {
  constructor(raw) {
    this.raw = raw;
    this.icao = raw.ICAO;

    const coords = parseCoordinates(raw.Coordinates, DEFAULT_AIRPORT_RADIUS);
    this.hasCoords = coords !== null;
    this.lat = coords ? coords.lat : 0;
    this.lon = coords ? coords.lon : 0;
    this.radius = coords ? coords.radius : 0;

    this.stands = [];
    this.standsByName = new Map();
    if (raw.Stands) {
      for (const [name, def] of Object.entries(raw.Stands)) {
        const stand = new CompiledStand(name, def);
        this.stands.push(stand);
        this.standsByName.set(name, stand);
      }
    }
  }
}

async function get(icao) {
  const cached = airports.get(icao);
  if (cached !== undefined) return cached;

  const raw = await airportService.getAirportConfig(icao);
  const compiled = raw && raw.ICAO ? new CompiledAirport(raw) : null;
  airports.set(icao, compiled);
  return compiled;
}

/** Cache-only lookup; undefined when the airport was never loaded. */
function peek(icao) {
  return airports.get(icao);
}

let loadedList = [];
let loadedByIcao = new Map();

/** Every compiled airport, in airport-list order. Populated by preload(). */
function all() {
  return loadedList;
}

/**
 * Compiled airports keyed by ICAO. Both the airport-list key (the file name)
 * and the config's own ICAO field are registered, so a lookup succeeds however
 * the caller came by the code.
 */
function byIcao() {
  return loadedByIcao;
}

/**
 * Loads and compiles every airport in icaoList in parallel. A no-op once warm,
 * so it is cheap to call at the top of each datafeed cycle - and it means the
 * rest of the cycle never has to await a config load.
 */
async function preload(icaoList) {
  let missing = null;
  for (const icao of icaoList) {
    if (!airports.has(icao)) (missing || (missing = [])).push(icao);
  }
  if (missing) {
    await Promise.all(missing.map((icao) => get(icao)));
  }
  if (missing || loadedList.length === 0) {
    loadedList = [];
    loadedByIcao = new Map();
    for (const icao of icaoList) {
      const compiled = airports.get(icao);
      if (!compiled) continue;
      loadedList.push(compiled);
      loadedByIcao.set(icao, compiled);
      if (compiled.icao && compiled.icao !== icao) {
        loadedByIcao.set(compiled.icao, compiled);
      }
    }
  }
  return loadedList;
}

function invalidate(icao) {
  airports.delete(icao);
  loadedList = [];
  loadedByIcao = new Map();
  airportService.invalidateAirport(icao);
}

function invalidateAll() {
  airports.clear();
  loadedList = [];
  loadedByIcao = new Map();
  derivedConfig = null;
  derivedConfigSource = null;
  airportService.invalidateAll();
}

/**
 * Derived form of the global config: array membership tests become Sets, and
 * wingspan resolution is memoised per aircraft type.
 */
function deriveConfig(config) {
  if (derivedConfig && derivedConfigSource === config) return derivedConfig;

  const wingspans = config.AircraftWingspans || {};
  // Prefix buckets replace the "scan all 380 keys" fallback for derivative types.
  const byPrefix = new Map();
  for (const type of Object.keys(wingspans)) {
    const p = type.slice(0, 3);
    if (!byPrefix.has(p)) byPrefix.set(p, wingspans[type]);
  }

  derivedConfig = {
    config,
    wingspans,
    wingspanByPrefix: byPrefix,
    wingspanCache: new Map(), // upper-cased type -> resolved wingspan
    cargoOperators: new Set(config.CargoOperator || []),
    helicopters: new Set(config.Helicopters || []),
    military: new Set(config.Military || []),
    generalAviation: new Set(config.GeneralAviation || []),
    // Retained only so an older config still parses; the assignment envelope no
    // longer distinguishes extended airports - see maxAltitudeFt in
    // occupancyService.
    extendedIcaos: new Set(config.extended_icaos || []),
  };
  derivedConfigSource = config;
  return derivedConfig;
}

module.exports = {
  get,
  peek,
  all,
  byIcao,
  preload,
  invalidate,
  invalidateAll,
  deriveConfig,
  parseCoordinates,
  CompiledAirport,
  CompiledStand,
};
