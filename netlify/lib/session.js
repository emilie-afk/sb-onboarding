'use strict';
// Signed, expiring sessions carried in a Secure, HttpOnly, SameSite=Strict cookie.
//
// Token: base64url(JSON payload) "." base64url(HMAC-SHA256(SESSION_SECRET, payload))
// Payload: { v:1, sid, iat, exp, g:[grant...] }
//   grant: { s:'team', t:<team>, l:'member'|'admin', pv:<fingerprint>, x:<expiry> }
//          { s:'global', pv:<fingerprint>, x:<expiry> }
//
// Every request re-checks: signature, version, iat/exp, SESSION_NOT_BEFORE,
// server-side revocation (logout), and for each grant its own expiry and that the
// password it was issued for has not changed since. The server never trusts a team
// or role supplied by the browser; permissions come only from verified grants.

const crypto = require('crypto');
const {
  TEAMS,
  MEMBER_TTL,
  ADMIN_TTL,
  GLOBAL_ADMIN_ENV,
  isTeam,
  memberEnvName,
  teamAdminEnvName,
  getSecurityConfig,
} = require('./config');
const { passwordFingerprint } = require('./passwords');
const { parseCookies } = require('./http');

const COOKIE_NAME = '__Host-sbonb';
const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 4096;
const CLOCK_SKEW = 60;

const now = () => Math.floor(Date.now() / 1000);

function sign(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update('sbonb-session-v1.' + payloadB64, 'utf8').digest('base64url');
}

function encodeToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return body + '.' + sign(secret, body);
}

// Returns the payload if the signature is valid, else null. Does not check expiry.
function decodeToken(token, secret) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = sign(secret, body);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function grantEnvName(grant) {
  if (grant.s === 'global') return GLOBAL_ADMIN_ENV;
  if (grant.s === 'team' && isTeam(grant.t)) {
    if (grant.l === 'member') return memberEnvName(grant.t);
    if (grant.l === 'admin') return teamAdminEnvName(grant.t);
  }
  return null;
}

function grantIsCurrent(grant, cfg, t, env) {
  if (!grant || typeof grant !== 'object') return false;
  if (!Number.isInteger(grant.x) || grant.x <= t) return false;
  const name = grantEnvName(grant);
  if (!name) return false;
  const pv = passwordFingerprint(name, cfg.secret, env);
  if (!pv || typeof grant.pv !== 'string' || grant.pv.length !== pv.length) return false;
  return crypto.timingSafeEqual(Buffer.from(grant.pv), Buffer.from(pv));
}

// Verifies the session cookie. Returns { sid, iat, exp, grants } or null.
// `isRevoked(sid)` is an async callback checking durable revocation storage.
async function readSession(event, { env = process.env, isRevoked } = {}) {
  const cfg = getSecurityConfig(env); // throws ConfigError → caller denies
  const token = parseCookies(event)[COOKIE_NAME];
  if (!token) return null;
  const p = decodeToken(token, cfg.secret);
  if (!p || p.v !== TOKEN_VERSION) return null;
  const t = now();
  if (typeof p.sid !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.sid)) return null;
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return null;
  if (p.exp <= t || p.iat > t + CLOCK_SKEW) return null;
  if (p.iat < cfg.notBefore) return null;
  if (!Array.isArray(p.g) || p.g.length > 16) return null;
  const grants = p.g.filter(g => grantIsCurrent(g, cfg, t, env));
  if (!grants.length) return null;
  if (typeof isRevoked !== 'function') throw new Error('revocation check required');
  if (await isRevoked(p.sid)) return null;
  return { sid: p.sid, iat: p.iat, exp: p.exp, grants };
}

function newSid() {
  return crypto.randomBytes(18).toString('base64url');
}

function makeGrant(kind, team, env, secret) {
  const t = now();
  if (kind === 'member') {
    return { s: 'team', t: team, l: 'member', pv: passwordFingerprint(memberEnvName(team), secret, env), x: t + MEMBER_TTL };
  }
  if (kind === 'teamAdmin') {
    return { s: 'team', t: team, l: 'admin', pv: passwordFingerprint(teamAdminEnvName(team), secret, env), x: t + ADMIN_TTL };
  }
  if (kind === 'global') {
    return { s: 'global', pv: passwordFingerprint(GLOBAL_ADMIN_ENV, secret, env), x: t + ADMIN_TTL };
  }
  throw new Error('unknown grant kind');
}

const grantKey = g => (g.s === 'global' ? 'global' : `${g.t}:${g.l}`);

// Builds a new token from the still-valid grants of `session` plus `added`.
// A new grant replaces an older grant of the same kind (refreshing its expiry).
function issue({ session, add = [], keep = () => true, sid, env = process.env }) {
  const cfg = getSecurityConfig(env);
  const t = now();
  const map = new Map();
  for (const g of (session && session.grants) || []) if (keep(g)) map.set(grantKey(g), g);
  for (const g of add) map.set(grantKey(g), g);
  const grants = [...map.values()];
  if (!grants.length) return null;
  const payload = {
    v: TOKEN_VERSION,
    sid: sid || (session && session.sid) || newSid(),
    iat: t,
    exp: Math.max(...grants.map(g => g.x)),
    g: grants,
  };
  return { token: encodeToken(payload, cfg.secret), payload };
}

function sessionCookie(token, exp) {
  const maxAge = Math.max(0, exp - now());
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

// ── Authorization helpers ─────────────────────────────────────────────
function isGlobalAdmin(session) {
  return !!session && session.grants.some(g => g.s === 'global');
}

function canReadTeam(session, team) {
  if (!session || !isTeam(team)) return false;
  return isGlobalAdmin(session) || session.grants.some(g => g.s === 'team' && g.t === team);
}

function canManageTeam(session, team) {
  if (!session || !isTeam(team)) return false;
  return isGlobalAdmin(session) || session.grants.some(g => g.s === 'team' && g.t === team && g.l === 'admin');
}

// Shared content (revenue goals, handbook) is visible to anyone holding any valid grant.
function canReadGlobal(session) {
  return !!session && session.grants.length > 0;
}

// Public summary for the browser (no fingerprints, no token).
function summarize(session) {
  if (!session) return { authenticated: false };
  const global = isGlobalAdmin(session);
  const teams = TEAMS.filter(t => session.grants.some(g => g.s === 'team' && g.t === t));
  const adminTeams = TEAMS.filter(t => session.grants.some(g => g.s === 'team' && g.t === t && g.l === 'admin'));
  const adminExpiries = session.grants.filter(g => g.s === 'global' || g.l === 'admin').map(g => g.x);
  return {
    authenticated: true,
    teams,
    adminTeams,
    globalAdmin: global,
    expiresAt: new Date(Math.max(...session.grants.map(g => g.x)) * 1000).toISOString(),
    adminExpiresAt: adminExpiries.length ? new Date(Math.min(...adminExpiries) * 1000).toISOString() : null,
  };
}

module.exports = {
  COOKIE_NAME,
  encodeToken,
  decodeToken,
  readSession,
  makeGrant,
  issue,
  sessionCookie,
  clearCookie,
  isGlobalAdmin,
  canReadTeam,
  canManageTeam,
  canReadGlobal,
  summarize,
};
