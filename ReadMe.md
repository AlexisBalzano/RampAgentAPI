# Ramp Agent

# Security

Initial Authentication (Client Connection) <br>
New ATC client plugin connects<br>
Plugin checks: "Am I connected to the network as a valid controller?"<br>
If YES → Client requests JWT from your API with their callsign (e.g., "LFBO_APP")<br>
API validates with network API: "Is this callsign actually connected right now?"<br>
If network confirms → API issues JWT containing:<br>
callsign (e.g., "LFBO_APP")<br>
issued_at timestamp
expires_at (e.g., 24 hours, or session duration)<br>
Client stores JWT and includes it in all subsequent report requests
Report Submission (Every Request)<br>
Client sends report with Authorization: Bearer <JWT><br>
API validates JWT:<br>

- ✅ Signature is valid (not tampered)<br>
- ✅ Not expired<br>
- ✅ Extract callsign from token<br>

API checks: Does req.body.client match JWT's callsign?<br>
If match → Process report<br>
If mismatch → Reject (prevents token theft/reuse)<br>
When client disconect, it sends a request to AUTH to revoke JWT and make the callsign available for next controller

## Steps
- Add /auth/login endpoint
    - token generation
    - token expiration/destruction

- Verify callsign with vatsim Data API (store CID?)
- Issue JWT on success, send it to the plugin, block callsign (make it impossible to request new JWT with this callsign)
- Validate JWT on /api/report & /api/assign
- Check client callsign matches the JWT callsign in report & assign
