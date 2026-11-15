# Stand finder for the vACC website: what RampAgentAPI needs

The French vACC website (`angular-frontend`) is adding a public **stand finder**:
a map of an airport's stands with live status, plus a "Where should I park?"
form where a pilot enters callsign, aircraft type and origin (typed by hand
or imported from their SimBrief flight plan) and gets the stand RampAgent would
give them right now.

**Stand booking will be added later from the same page.** Nothing in this
change books or holds a stand. Keep it in mind when you name things.

## Architecture (decided)

```
browser ──► website backend (NestJS) ──X-Service-Key──► RampAgentAPI /api/v1/*
```

- **The website backend calls RampAgent directly, not through vaccfr-core.**
  RampAgent owns stand data, and later stand bookings. Core only provides
  identity: RampAgent already verifies core JWTs and will keep doing that for
  booking.
- **The browser never calls RampAgent.** The website backend handles SimBrief,
  caching and rate limiting.
- **The existing unversioned routes stay exactly as they are.** The viewer and
  the EuroScope plugin use `/api/airports`, `/api/occupancy`, `/api/assign` and
  so on. Everything new goes under `/api/v1`, and that is the only contract the
  website relies on.

---

## 1. Service-key auth for `/api/v1`

The existing `api_keys` table holds per-user keys that expire after 30 days, so
it can't be used for service-to-service calls. Add instead:

- An env var `SERVICE_API_KEYS`, a comma-separated list of `name:key` pairs,
  e.g. `website:3f9c…`. It uses the same format as vaccfr-core's
  `SERVICE_API_KEYS`, so operators only learn one convention.
- Middleware `requireServiceKey` on every `/api/v1` route:
  - It reads the `X-Service-Key` header and compares it with
    `crypto.timingSafeEqual`, checking lengths first.
  - It returns **401** if the header is missing and **403** if the key is wrong.
  - On success it sets `req.service = name` and logs it, so request logs and
    stats show which caller made the request.
- If `SERVICE_API_KEYS` is empty, every `/api/v1` call is refused (fail closed)
  and a warning is logged once at startup.
- Add the variable to `docker-compose.yml`, `DOCKER.md` and the config files.

## 2. `GET /api/v1/airports`

This lists the airports the finder can show. It comes from the same source as
`getAirportListAndCoordinates`.

```json
[
  { "icao": "LFPG", "coords": [49.0097, 2.5479], "standCount": 450 }
]
```

The website uses this list to decide whether an event airfield gets a
"Find my stand" button.

## 3. `GET /api/v1/airports/:icao/stands`

This returns the stand **definitions**, normalized. The website must never parse
the raw config strings, so this endpoint is the only place that knows the
config-file format.

```json
{
  "icao": "LFPG",
  "version": "…config version…",
  "stands": [
    {
      "name": "K40",
      "lat": 49.000456,
      "lon": 2.566853,
      "radius": 25,
      "codes": ["C"],
      "uses": ["A"],
      "schengen": true,
      "maxWingspan": null,
      "callsigns": ["AFR", "BAW"],
      "countries": null,
      "apron": false,
      "priority": 4,
      "remark": null
    }
  ]
}
```

Rules:
- **`Coordinates`** is `lat:lon[:radius]`. When there's no radius, use 15, as
  `getAllStands` already does. Skip stands whose lat or lon isn't a finite
  number, and log a warning for each.
- **`Code` and `Use`** are strings in the config, e.g. `"CDE"`. Split them into
  arrays of single letters. A missing value becomes `null`, meaning
  "unrestricted".
- **`schengen`** is `true`, `false` or `null`. Only `null` means unrestricted.
- **`priority`** is a number, or `null` when absent.
- **`remark`** is a string, or `null`, or — as the config keys it by code
  list (`{"BC": "Push on T43"}`) — an object with one entry per aircraft
  code letter (`{"B": "Push on T43", "C": "Push on T43"}`).
- **Leave out internal fields** such as `Block`: it's assignment logic, not
  something to show.
- **An unknown ICAO** returns **404** `{ "error": "Unknown airport" }`. Unlike
  the viewer endpoint, this contract is allowed to say "no such airport".
- **Responses are cached in memory per ICAO.** Drop the cache entry when
  `airportIndex.invalidate(icao)` runs (config webhook or version bump), so
  edits to the config repo still go live without a deploy.

## 4. `GET /api/v1/airports/:icao/status`

This returns live occupancy for a single airport. It's
`occupancyController.getAirportStatus` exposed under v1, with an explicit
shape:

```json
{
  "icao": "LFPG",
  "updatedAt": "2026-11-15T18:04:12Z",
  "stands": {
    "K40": { "state": "occupied", "callsign": "AFR123" },
    "K42": { "state": "assigned", "callsign": "BAW304" },
    "K44": { "state": "blocked",  "callsign": "BAW304" }
  }
}
```

- Free stands are left out of the response.
- `updatedAt` is the time of the last processed datafeed cycle.
- Reuse the existing `cachedPayload` caching so polling stays cheap. The
  website polls every 30 seconds.
- **Callsigns are already public on the VATSIM datafeed**, so returning them is
  fine.

## 5. `POST /api/v1/airports/:icao/suggest` (the main piece)

This is a **dry run** of the assignment engine. It answers: "if this aircraft
arrived now, which stand would RampAgent give it?" **It must not change any
state.** That means no `registry.add*`, no `blockStands`, no Hoppie/TELEX
eligibility, no searchLogged or noStandFound caches, and no changes to
`stat` counters other than a dedicated `suggestCount`.

The user chose **only currently free stands**. The result has to match what the
plugin would assign at that moment.

Request:
```json
{
  "callsign": "AFR123",
  "aircraftType": "A320",
  "origin": "LEMD",
  "remarks": null
}
```
- `direction` is optional: `"arrival"` (the default) or `"departure"`.
  - **arrival** needs `origin`. The destination is `:icao`.
  - **departure** needs `destination` instead of `origin`; the origin is
    `:icao`. It answers "which free stand should I start from". The fit rules
    are the same: Schengen is decided by both ends, and a stand's `Countries`
    restriction is matched against the destination, as an arrival's is
    against its origin.
- `callsign` is required, 2–10 characters, `[A-Z0-9-]` after upper-casing.
- `aircraftType` is required, 2–4 characters.
- `origin` (arrival) or `destination` (departure) is required and must be a
  4-letter ICAO.
- `profile.otherCountry` is the country prefix of the other end of the flight.
- `remarks` is optional, capped at 500 characters. It's only used for cargo
  detection.
- The destination is `:icao`.
- Invalid input returns **400** with `{ "error": "…", "field": "…" }`.

Response:
```json
{
  "icao": "LFPG",
  "profile": {
    "use": "A",
    "code": "C",
    "wingspan": 35.8,
    "typeKnown": true,
    "schengen": true,
    "company": "AFR",
    "otherCountry": "LE"
  },
  "direction": "arrival",
  "suggested": "K40",
  "alternatives": ["K42", "K44"],
  "reason": null,
  "evaluatedAt": "2026-11-15T18:04:12Z"
}
```
- `suggested` is `null` when nothing fits. In that case `reason` is one of:
  - `no_compatible_stand`: no stand admits this profile at all.
  - `all_compatible_occupied`: stands fit, but they're occupied, assigned or
    blocked right now.
  - `unknown_type`: the aircraft type isn't in the wingspan data and the
    81 m fallback ruled everything out. Set `typeKnown: false` whenever the
    fallback was used, even if a stand was found, so the website can warn the
    pilot.
- `alternatives` holds up to 5 other free, fitting stands at the **same
  priority tier**, ordered the way `pickTightest` would order them. The map
  highlights them as second choices.

Implementation:
- **Extract a pure function** in `occupancyService.js`:
  `evaluateStand(airport, derived, profileInput) → { profile, candidates }`.
  - It reuses `aircraftProfile`, `standFits`, the occupied/assigned/blocked
    checks, the apron-capacity check, priority filtering and `pickTightest`.
  - It returns candidates and never assigns anything.
- **Refactor greedy `assignStand` to call it**, so the suggestion and the real
  assignment can't drift apart. Add a test that runs the same aircraft through
  both and checks they pick the same stand.
- `aircraftProfile` currently reads datafeed objects
  (`ac.flight_plan.aircraft_short` etc.). Either build a feed-shaped object
  from the request, or split it so it accepts plain fields. Splitting is
  cleaner.
- **Airports in provisional mode** (`airport.assignment.provisional`): a
  suggestion has no ETA, so it can't preempt anyone.
  - Treat every stand held by another callsign (firm or provisional) as
    unavailable.
  - Otherwise use the same fit and priority rules.
  - State this in a code comment, because it's the one place where the
    suggestion is deliberately more conservative than the engine.
- **The airport config isn't loaded or compiled** (the airport exists in the
  config repo but `airportIndex` has no compiled copy yet): compile it on
  demand through the same path the datafeed loop uses. Don't return 500.
- **Unknown ICAO** → 404, same as §3.

## 6. Rate limiting and logging

- Calls come from the website backend, so per-IP limiting isn't useful. Add a
  per-service limit on `/suggest` instead, e.g. 600/min for `website`, as a
  safety net. The website enforces its own per-user limits.
- Log each suggest call in category `Suggest` with the callsign, profile and
  result, using the existing logger. This helps the config maintainers see
  which stands pilots ask for and which ones never fit.

## 7. Tests and docs

- **Unit tests:**
  - normalization (§3): code/use splitting, schengen tri-state, missing radius
  - `evaluateStand`: fit filters, priority tier, apron full, provisional
    conservatism, unknown type
  - the assign/suggest parity test (§5)
  - service-key middleware: missing key, wrong key, valid key, empty config
- Write the `/api/v1` contract into `ReadMe.md`. It's currently just a title.

## Later: booking (don't build yet, but don't block it)

Booking will add routes such as `POST /api/v1/airports/:icao/bookings`,
authenticated with the **user's core JWT** (using the existing
`decryptToken`/`jwt.verify` path), and stored in RampAgent so the assignment
engine honours them. Keep `/api/v1/airports/:icao/...` as the resource root, and
keep `evaluateStand` free of request or auth concerns so booking can reuse it.

## Out of scope

- No changes to the viewer, the plugin endpoints or TELEX.
- No changes to vaccfr-core.

## Deploy

1. Generate a key and set `SERVICE_API_KEYS=website:<key>` on RampAgent.
2. Deploy RampAgent.
3. Then set the same key on the website backend as `RAMPAGENT_SERVICE_KEY`,
   with `RAMPAGENT_URL_INTERNAL`.

The website's finder shows a "stand finder unavailable" state until RampAgent
answers, so the deploy order isn't critical. RampAgent should still go first.
