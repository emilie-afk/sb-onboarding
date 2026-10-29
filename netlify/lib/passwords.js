'use strict';
// Password verification and password-version fingerprints.
//
// A session grant records a fingerprint of the password that was used, computed
// as HMAC-SHA256(SESSION_SECRET, env-var-name + password). On every request the
// fingerprint is recomputed from the current environment; if the password was
// changed (and the site redeployed so functions see the new value) the
// fingerprints differ and the grant is rejected. The raw password is never stored
// in the session, and the fingerprint cannot be checked offline without the secret.

const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Constant-time comparison of a candidate against the password held in env[name].
function verifyPassword(candidate, envName, env = process.env) {
  const expected = env[envName];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) {
    // Still spend comparable time.
    crypto.timingSafeEqual(digest(expected), digest(expected));
    return false;
  }
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

function passwordFingerprint(envName, secret, env = process.env) {
  const value = env[envName];
  if (typeof value !== 'string' || value.length === 0) return null;
  return crypto
    .createHmac('sha256', secret)
    .update('sbonb-pw-v1\0' + envName + '\0' + value, 'utf8')
    .digest('base64url')
    .slice(0, 22);
}

module.exports = { verifyPassword, passwordFingerprint };
