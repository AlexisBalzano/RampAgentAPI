/**
 * The secret core signs members' session tokens with (core's AUTH_JWT_KEY).
 *
 * Deployed as VACCFR_RAMPAGENT_CORE_JWT_KEY; CORE_JWT_KEY is still read as a
 * fallback so existing local .env files keep working. Read at call time, not
 * at require time, so dotenv and tests can set it first.
 */
function coreJwtKey() {
  return (
    process.env.VACCFR_RAMPAGENT_CORE_JWT_KEY ||
    process.env.vaccfr_rampagent_core_jwt_key ||
    process.env.CORE_JWT_KEY ||
    undefined
  );
}

module.exports = { coreJwtKey };
