# Ramp Agent API

Assigns arrival stands to VATSIM traffic at French airports, tracks stand
occupancy, and serves both to the EuroScope plugin, the viewer and the vACC
website.

```bash
npm install
npm start      # needs Redis and the config repo cloned into data/
npm test       # unit tests (node:test)
```

Docker setup and environment variables: see [DOCKER.md](DOCKER.md).

## Routes

- **Unversioned** (`/api/airports`, `/api/occupancy`, `/api/assign`, ...) are
  used by the viewer and the EuroScope plugin. They are not a public contract
  and are not described here.
- **`/api/v1`** is the contract for other services, currently the vACC
  website's stand finder. It is described below and only changes in
  backwards-compatible ways.

## `/api/v1`

### Authentication

Every `/api/v1` request carries an `X-Service-Key` header. Keys are configured
in `SERVICE_API_KEYS` as comma-separated `name:key` pairs, e.g.
`website:3f9c…`.

| Situation | Response |
|---|---|
| Header missing | `401 { "error": "Missing X-Service-Key header" }` |
| Key not recognised | `403 { "error": "Invalid service key" }` |
| `SERVICE_API_KEYS` empty | Every request is refused (401 or 403) |

An ICAO in the path is case-insensitive. An airport that isn't in the config
repo returns `404 { "error": "Unknown airport" }`.

### `GET /api/v1/airports`

The airports the finder can show.

```json
[{ "icao": "LFPG", "coords": [49.0097, 2.5479], "standCount": 450 }]
```

### `GET /api/v1/airports/:icao/stands`

Stand definitions, normalized from the config files. Cached per airport, and
refreshed when the config repo changes (webhook or version bump).

```json
{
  "icao": "LFPG",
  "version": "…",
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

| Field | Meaning |
|---|---|
| `radius` | Metres. 15 when the config gives none. |
| `codes`, `uses` | Single letters. `null` means unrestricted. |
| `schengen` | `true`, `false`, or `null` for unrestricted. |
| `maxWingspan` | Metres, or `null`. |
| `callsigns`, `countries` | Allowed callsign prefixes / origin ICAO prefixes, or `null`. |
| `priority` | Lower is preferred. `null` ranks after every stand that has one. |
| `remark` | `null`, a string, or an object keyed by aircraft code letter (`{ "C": "…", "D": "…" }`). |

Stands whose coordinates can't be parsed are left out (and logged).

### `GET /api/v1/airports/:icao/status`

Live state of the airport's stands. Free stands are left out. Cheap to poll.

```json
{
  "icao": "LFPG",
  "updatedAt": "2026-11-15T18:04:12Z",
  "stands": {
    "K40": { "state": "occupied", "callsign": "AFR123" },
    "K42": { "state": "assigned", "callsign": "BAW304" },
    "K44": { "state": "blocked", "callsign": "BAW304" },
    "GA": { "state": "occupied", "callsign": "FGKXA", "used": 2, "capacity": 6 }
  }
}
```

- `state` is `occupied`, `assigned` or `blocked`, in that order of precedence.
- Aprons hold several aircraft: they also carry `used` and `capacity`, and
  `callsign` is one of the aircraft on them.
- `updatedAt` is when the last datafeed cycle was processed (`null` before the
  first).

### `POST /api/v1/airports/:icao/suggest`

Which stand RampAgent would give this aircraft if it arrived now. A dry run:
nothing is assigned, held or notified.

Request:

```json
{ "callsign": "AFR123", "aircraftType": "A320", "origin": "LEMD", "remarks": null }
```

| Field | Rule |
|---|---|
| `callsign` | Required. 2–10 of `A-Z 0-9 -` (case-insensitive). |
| `aircraftType` | Required. 2–4 letters or digits. |
| `origin` | Required. 4-letter ICAO. |
| `remarks` | Optional, at most 500 characters. Only used for cargo detection. |

Invalid input returns `400 { "error": "…", "field": "…" }`.

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
    "originCountry": "LE"
  },
  "suggested": "K40",
  "alternatives": ["K42", "K44"],
  "reason": null,
  "evaluatedAt": "2026-11-15T18:04:12Z"
}
```

- `suggested` is the stand the engine would pick: the best free priority tier,
  then the tightest-fitting code, random among equals (as the engine does).
- `alternatives` are up to 5 other free, fitting stands at the same tier,
  tightest first.
- `typeKnown: false` means the type has no wingspan data and was treated as
  81 m (code F). Show the pilot a warning.
- When `suggested` is `null`, `reason` is:
  - `no_compatible_stand`: no stand admits this aircraft at all.
  - `all_compatible_occupied`: stands fit, but all are occupied, assigned or
    blocked right now.
  - `unknown_type`: the type is unknown and no stand takes an 81 m aircraft.
- Only currently free stands are suggested. A stand held by another aircraft,
  even provisionally, is never suggested, although the engine could later give
  it to an earlier arrival.
- Limited to `SUGGEST_RATE_LIMIT` calls per minute per service (default 600);
  over the limit returns `429` with `Retry-After`.
