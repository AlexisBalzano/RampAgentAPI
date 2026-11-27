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

- `state` is `occupied`, `assigned`, `booked` or `blocked`, in that order of
  precedence. `booked` is a departure stand held for a pilot (see below).
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

## Departure stand booking (`/api/v1`)

A pilot with a **prefile** departing one of our airports can hold one stand
there for **10 minutes**. They must connect on it within that time; occupancy
then keeps the stand as for any parked aircraft. Arrivals can't book: the
assignment engine handles them.

These routes act for a member, so on top of the service key they need the
member's vaccfr-core JWT in `X-User-Token` (verified with `VACCFR_RAMPAGENT_CORE_JWT_KEY`).
Missing or invalid: `401`.

A virtual airline's backend sends the pilot's CID in `X-Pilot-Cid` instead,
with a VA key. Admins create VA keys in the dashboard (**Dashboard → Virtual
airlines**), each with its callsign prefixes. A VA only sees, books and cancels
flights under its prefixes. The key is shown once, at creation or rotation, and
only its SHA-256 hash is stored in Redis. Disabling, rotating or deleting a key
takes effect immediately. Any other key sending `X-Pilot-Cid` gets `403` with
`code: "pilot_cid_not_allowed"`, and a prefile outside the prefixes gets `422`
with `code: "callsign_not_allowed"`. The dashboard uses
`/api/admin/va-integrations` (admin session required): `GET`, `POST
{ name, prefixes }`, `PATCH /:id { name?, prefixes?, enabled? }`,
`POST /:id/rotate`, `DELETE /:id`.
See [VA-INTEGRATION.md](VA-INTEGRATION.md) for the guide given to VAs.

### `GET /api/v1/me/prefiles`

The member's prefiles departing an airport we cover, from the data platform.

```json
[{ "callsign": "AFR123", "aircraftType": "A320", "departure": "LFPG", "arrival": "LEMD", "deptime": "1120" }]
```

`503` with `code: "prefiles_unavailable"` when the data platform can't be reached.

### `POST /api/v1/airports/:icao/bookings`

```json
{ "stand": "K40", "callsign": "AFR123" }
```

`callsign` is only needed when the member has several prefiles departing
`:icao`. Aircraft type, destination and remarks always come from the prefile.
A new booking replaces the member's previous one.

`201`:

```json
{
  "icao": "LFPG", "stand": "K40", "callsign": "AFR123", "aircraftType": "A320",
  "destination": "LEMD", "createdAt": "…", "expiresAt": "…"
}
```

| Status | `code` | Meaning |
|---|---|---|
| 404 | | Unknown airport or stand |
| 422 | `no_prefile` | No prefile departing `:icao` on this VATSIM account |
| 422 | `several_prefiles` | Several match: send `callsign` |
| 422 | `stand_unsuitable` | The stand doesn't accept this aircraft (size, use, Schengen, airline…) |
| 409 | `stand_taken` | Occupied, assigned, blocked or booked by someone else |

### `GET /api/v1/me/booking`

```json
{
  "booking": { "icao": "LFPG", "stand": "K40", "expiresAt": "…" },
  "last": { "status": "fulfilled", "icao": "LFPG", "stand": "K40", "callsign": "AFR123", "at": "…" }
}
```

`booking` is the held booking or `null`. `last` says how the previous one
ended, for 30 minutes:

| `status` | When |
|---|---|
| `fulfilled` | The pilot connected on the stand |
| `released` | The pilot connected on another stand |
| `expired` | Nobody connected within 10 minutes |
| `conflict` | Another aircraft connected on the stand or next to it |
| `overridden` | A controller assigned the stand to someone else |
| `cancelled` / `replaced` | The member cancelled it, or booked another stand |

### `DELETE /api/v1/me/booking`

`204`, or `404` with `code: "no_booking"`.

### How the engine honours a booking

While held, the booking is an assigned stand in the registry with
`status: "booked"`, and its `Block` neighbours are blocked. No arrival is
given the stand or a stand that would block it, and the plugin sees it as
assigned. Bookings are mirrored in Redis with the remaining hold as TTL, so
a restart neither loses nor extends one. A manual `/api/assign` by a
controller cancels the booking.

## Arrival stand preferences for virtual airlines (`/api/v1/va/arrivals`)

A VA key (see above) may name, per flight, the arrival stand the airline
announced to its pilot. No `X-Pilot-Cid`: a preference belongs to the flight.
Other keys get `403 va_only`; callsigns outside the VA's prefixes get
`403 callsign_not_allowed`.

| Route | |
|---|---|
| `PUT /va/arrivals/:callsign` | `{ arrival, stand, aircraftType, eta }` → `201` created / `200` replaced |
| `GET /va/arrivals` | The VA's live preferences with what each flight was given (for polling) |
| `GET /va/arrivals/:callsign` | One of them |
| `DELETE /va/arrivals/:callsign` | `204`, or `404 no_preference` |

At request time only the stand's existence and the aircraft's size are
checked, with the usual rules (its code among the stand's `Code`, its wingspan
within `Wingspan`); Use, Schengen, Countries and Callsigns restrictions are the
airline's call and are ignored. Errors: `unknown_airport`, `unknown_stand`,
`unknown_aircraft_type`, `stand_unsuitable`, `eta_out_of_range` (30 min ago to
2 h ahead), `callsign_claimed` (another VA's flight), `too_late` (the flight
already holds another stand firm, or is parked there), `too_many_preferences`.

### How the engine honours a preference

Nothing is written into the registry: the stand stays open to everyone, and the
plugin sees nothing new. A preference lives 2 hours from its last `PUT`:

- The preferred stand is given first if it is strictly free (not occupied,
  held or blocked by anyone else, and no `Block` neighbour held by someone
  else) and the filed aircraft is small enough for it. A preference never
  displaces anyone.
- Otherwise the flight is assigned as usual. In provisional mode it moves to
  the preferred stand if that frees up while its assignment is still
  provisional, and is never "upgraded" away from it.
- Everything else is unchanged: an earlier arrival may still take a
  provisional stand, the freeze makes it firm, the TELEX goes out, a
  controller's assignment wins.

The preference is deleted as soon as the flight parks at the airport (on its
stand or another one), or when its 2 hours are up, so a later flight under the
same callsign never inherits it. Until then each record's `assignment` reports
`state` (`waiting` or `assigned`), `stand`, `status` (`provisional`/`firm`),
`honoured`, and when not honoured a `reason`: `stand_unavailable`,
`aircraft_unsuitable`, `controller`, or `destination_differs`. Records are
mirrored in Redis.
