'use strict';
// Request authentication shared by every data endpoint.

const { getSecurityConfig } = require('./config');
const { readSession } = require('./session');
const { SecurityStore } = require('./security-store');

// Returns { session, security } where session is null when the request carries no
// valid session. Throws ConfigError when security configuration is missing, so the
// caller responds 503 and never serves protected data.
async function authenticate(event, env = process.env) {
  getSecurityConfig(env);
  const security = new SecurityStore(event, env);
  const session = await readSession(event, { env, isRevoked: sid => security.isRevoked(sid) });
  return { session, security };
}

module.exports = { authenticate };
