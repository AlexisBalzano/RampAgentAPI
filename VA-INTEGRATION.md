# RampAgent stand booking for virtual airlines

RampAgent lets your pilots book a **departure stand** at a vACC France airport
before they connect. The stand is held for **10 minutes**. If the pilot
connects on it within that time, it's theirs. If they don't, it's released.

## What you get from vACC France

- A **service key**: a secret string starting with `rva_`. We can show it to
  you only once, so store it safely.
- Your **callsign prefixes**, e.g. `FVA`. You can only book flights whose
  callsign starts with one of them.

## Rules for your implementation

1. **Call from your server only.** Never put the key in the ACARS client, a
   browser or a mobile app: anyone can extract it from there. Your ACARS asks
   your backend, and your backend calls RampAgent.
2. **Only book for the pilot who is logged in to your system.** You send their
   VATSIM CID, and we trust that it's theirs. That trust is what the key stands
   for.
3. **Keep the key out of git, logs and error reports.** If it leaks, tell us:
   we revoke it and issue a new one.

## Requirements on the pilot's side

- The pilot must have a **VATSIM prefile** departing the airport, under one of
  your callsigns. We read the aircraft type and destination from the prefile,
  not from your request.
- The pilot then has 10 minutes to connect on the stand.
- Only departures can be booked. Arrival stands are assigned automatically.

## Authentication

Send these headers on every request:

```
X-Service-Key: <your service key>
X-Pilot-Cid: <the pilot's VATSIM CID>
Content-Type: application/json
```

Base URL: `https://<rampagent host>/api/v1`

## Endpoints

### 1. List airports, stands and their status (optional)

- `GET /airports`: the airports we cover.
- `GET /airports/{ICAO}/stands`: stands with size code, use and priority.
- `GET /airports/{ICAO}/status`: which stands are occupied, assigned or booked right now.
- `POST /airports/{ICAO}/suggest`: stand suggestions for an aircraft.

These don't need `X-Pilot-Cid`.

### 2. The pilot's prefiles

`GET /me/prefiles`

```json
[{ "callsign": "FVA101", "aircraftType": "A320", "departure": "LFPG", "arrival": "LEMD", "deptime": "1120" }]
```

This only lists prefiles under your callsigns that depart an airport we cover.

### 3. Book a stand

`POST /airports/{ICAO}/bookings`

```json
{ "stand": "K40", "callsign": "FVA101" }
```

You only need `callsign` when the pilot has more than one of your prefiles
departing that airport. A successful booking returns `201`:

```json
{
  "icao": "LFPG", "stand": "K40", "callsign": "FVA101", "aircraftType": "A320",
  "destination": "LEMD", "createdAt": "2026-11-17T10:00:00.000Z", "expiresAt": "2026-11-17T10:10:00.000Z"
}
```

A pilot can hold one booking at a time, and a new booking replaces the
previous one.

### 4. Check the booking

`GET /me/booking`

```json
{
  "booking": { "icao": "LFPG", "stand": "K40", "callsign": "FVA101", "expiresAt": "…" },
  "last": null
}
```

`booking` is `null` when nothing is held. `last` shows how the previous
booking ended, and stays available for 30 minutes:

| `last.status` | Meaning |
|---|---|
| `fulfilled` | The pilot connected on the stand |
| `released` | The pilot connected on another stand |
| `expired` | No connection within 10 minutes |
| `conflict` | Another aircraft took the stand, or a neighbouring stand that blocks it |
| `overridden` | A controller assigned the stand to someone else |
| `cancelled` / `replaced` | Cancelled, or replaced by a new booking |

### 5. Cancel

`DELETE /me/booking`: returns `204`, or `404` if nothing is booked.

## Errors

Error responses are JSON, for example `{ "error": "…", "code": "…" }`.

| Status | `code` | What to do |
|---|---|---|
| 400 | | Malformed request or CID. Fix the request |
| 401 | | Missing `X-Service-Key`, or `X-Pilot-Cid` missing on a booking route |
| 403 | | Key not recognised: wrong, disabled, replaced or deleted. Contact us |
| 403 | `pilot_cid_not_allowed` | This key isn't a VA key. Use the key we gave you |
| 404 | | Unknown airport or stand |
| 404 | `no_booking` | Nothing to cancel |
| 409 | `stand_taken` | The stand is taken. Offer another one, or use `/suggest` |
| 422 | `no_prefile` | The pilot has no prefile departing this airport |
| 422 | `several_prefiles` | Send `callsign` |
| 422 | `callsign_not_allowed` | The prefile isn't under your callsigns |
| 422 | `stand_unsuitable` | The stand doesn't accept this aircraft (size, use, Schengen…) |
| 429 | | Rate limited. Wait for `Retry-After` seconds |
| 503 | `prefiles_unavailable` | Prefile data is temporarily unavailable. Retry later |

## Typical flow

1. The pilot files a prefile on VATSIM, e.g. `FVA101` from LFPG.
2. Your backend calls `GET /me/prefiles` with the pilot's CID to confirm the flight.
3. You pick a stand, using the pilot's choice or `/suggest`, and call
   `POST /airports/LFPG/bookings`.
4. You show the stand and the `expiresAt` time to the pilot.
5. You can poll `GET /me/booking` (no more often than every 30 s) to show
   whether the booking was fulfilled or expired.

## Example

```bash
curl -X POST "https://<rampagent host>/api/v1/airports/LFPG/bookings" \
  -H "X-Service-Key: $RAMPAGENT_KEY" \
  -H "X-Pilot-Cid: 1234567" \
  -H "Content-Type: application/json" \
  -d '{"stand":"K40"}'
```
