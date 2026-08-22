# What the core update means for RampAgentAPI

Written from reading this repo against `vaccfr-core` after the website
migration. Nothing here has been changed — each item is a decision for whoever
maintains RampAgentAPI.

**Short version: very little.** RampAgentAPI uses core for authentication only,
and it already does the important part correctly. One endpoint is worth
switching; everything else is optional.

---

## First, what is already right

**Session tokens are verified, not just decoded.** `decryptToken` in
`controllers/authController.js` does:

```js
const payload = jwt.verify(accessToken, secret, { algorithms: ["HS256"] });
```

That is the correct check, and it pins the algorithm so an `alg: none` token
cannot slip through. Worth stating because **`vaccfr-core` itself does not do
this** — core decodes without verifying, and so does PINEDE. RampAgentAPI is
unaffected by that issue.

**The plugin token is a separate scheme and stays as it is.** `verifyToken` uses
a SHA-256 of `AUTH_SECRET + client`, which has nothing to do with core and is
not touched by any of this.

---

## 1. Member endpoint — done

`getSession` and `loginCallback` both fetched:

```js
process.env.CORE_URL_INTERNAL + `/v1/user/${sessionData.tokenContent.cid}`
```

which returns the full `User` row, **including `email`**. Both now call:

```
/v1/user/members/:cid
```

which returns only:

```json
{
  "cid": "1234567",
  "firstName": "…",
  "lastName": "…",
  "fullName": "…",
  "vatsimRatingId": 5,
  "vatsimRatingShort": "C1",
  "UserGlobalPermissions": { "isApprovedAtc": true, "isStaff": false, … }
}
```

Same auth — the user's own token in the `Authorization` header, exactly as
before. The old route was additionally guarded by `IsUserFromTokenGuard`, so a
caller could only read itself; the member route drops that and is readable by
any authenticated caller. RampAgent only ever fetches its own CID, so nothing
changes here.

### What was checked before switching

Everything downstream reads is still present:

- `updateSessionLocalUser` uses `cid`, `fullName`, `firstName`, `lastName` — all carried
- `getSession` uses `cid` for the Redis lookup — carried
- the viewer reads `core.cid` and `core.firstName` only — both carried

Nothing read `email`, and nothing read the division or subdivision fields the
member shape drops.

### The stored copy is cleared too

`updateSessionLocalUser` was writing `email` into the Redis local user, and
`redisService.updateLocalUser` merges (`{ ...existing, ...settings }`) rather
than replacing. Dropping the field alone would have left every already-cached
address in place indefinitely, so it is now set explicitly to `undefined`,
which `JSON.stringify` omits — the key disappears from the stored record on
each user's next login.

### Deployment order matters

`/v1/user/members/:cid` exists on core's `website-architecture-rewrite` branch
and **not on core's `main`**. Deployed against a core that has not merged that
branch, both routes 404 and every login fails with "Failed to fetch user info
from core". **Core must be merged and deployed first.**

---

## 2. Roles are available if RampAgent ever needs them

Core is now the source of truth for vACC roles, and the member endpoint above
carries them: `isApprovedAtc`, `isStaff`, `isEventsTeam`, the LFPG/LFMN position
approvals, and so on.

RampAgentAPI does not appear to gate anything on role today. If it ever should —
restricting stand assignment to approved controllers, for instance — the answer
is in the response it already fetches, with no extra call.

Two things to know if you do:

- `UserGlobalPermissions` is **nullable**. A member who has never been given a
  role has `null` there, not an object of falses. Treat that as "no roles".
- Roles change in core without telling anyone. If you cache the member response,
  keep it short — the vACC website uses 30 seconds.

---

## 3. The API version is hardcoded

Several URLs are built as `/v1/...` directly, while `CORE_URL_INTERNAL` and
`CORE_URL_EXTERNAL` come from the environment. Core's other consumers carry a
`CORE_API_VERSION` variable and interpolate it.

Not a problem today — there is only a v1. It becomes one the day core ships a
v2 and this repo has the version in a dozen string literals instead of one
variable. Cheap to change now, tedious later.

---

## 4. Service-to-service auth exists now, if you need it

Core previously had no way for another service to authenticate — only an origin
allowlist, which server-side callers do not send. It now accepts `X-Service-Key`,
configured one key per service:

```
SERVICE_API_KEYS=discord-bot:xxxx,training:yyyy,website:zzzz
```

RampAgentAPI does not need one: every call it makes carries the user's own
token. It would only be needed if RampAgentAPI ever writes to core — setting a
role, for instance.

---

## Nothing else changes

The login redirect to `/v1/auth/vatsim/login?origin=…&redirect=…` is unchanged,
and this service's origins are already in core's `approvedOrigins` allowlist.
Session handling, the plugin token scheme and everything downstream of them work
exactly as before.

---

## Suggested order

1. ~~**Member endpoint**~~ — done, see above; needs core merged first
2. **`CORE_API_VERSION`** — whenever that file is next open

What remains is optional and blocks nothing.
