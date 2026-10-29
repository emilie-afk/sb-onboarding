// check-password.js — team and admin login.
//
// Verifies a password server-side and, on success, issues (or extends) a signed,
// expiring session cookie. The password is never returned or stored.
//
// POST JSON (with header X-SB-Onboarding: 1):
//   { team: '<team>', password }                       → team member access
//   { team: 'admin', teamName: '<team>', password }    → team admin for <team>,
//                                                       or global admin if the
//                                                       global admin password is used
//   { team: 'admin', scope: 'global', password }       → global admin only
//
// Environment variables (values set only in Netlify):
//   PASSWORD_<TEAM>, PASSWORD_ADMIN_<TEAM>, PASSWORD_ADMIN, SESSION_SECRET
//   (see docs/SECURITY.md for the full list)
//
// Responses: 200 { success:true, session } · 401 { success:false } wrong password ·
//            429 too many attempts · 403 failed CSRF check · 503 not configured

const { isTeam, memberEnvName, teamAdminEnvName, GLOBAL_ADMIN_ENV, getSecurityConfig } = require('../lib/config');
const { json, readJsonBody, checkCsrf, clientAddress, errorResponse } = require('../lib/http');
const { verifyPassword } = require('../lib/passwords');
const { makeGrant, issue, sessionCookie, summarize } = require('../lib/session');
const { authenticate } = require('../lib/auth');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false }, { headers: { Allow: 'POST' } });
  }
  try {
    const cfg = getSecurityConfig();   // denies when misconfigured or in maintenance mode
    if (!checkCsrf(event)) return json(403, { success: false, error: 'forbidden' });
    const body = readJsonBody(event);
    const { team, teamName, scope, password } = body;

    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      return json(400, { success: false, error: 'invalid_request' });
    }

    // Determine the login scope from validated, supported values only.
    let rlScope;
    let candidates; // [{ env, grant: () => grant }]
    if (team === 'admin') {
      if (scope === 'global') {
        rlScope = 'admin-global';
        candidates = [{ env: GLOBAL_ADMIN_ENV, kind: 'global' }];
      } else if (isTeam(teamName)) {
        rlScope = `admin-${teamName}`;
        candidates = [
          { env: GLOBAL_ADMIN_ENV, kind: 'global' },
          { env: teamAdminEnvName(teamName), kind: 'teamAdmin', team: teamName },
        ];
      } else {
        return json(400, { success: false, error: 'invalid_request' });
      }
    } else if (isTeam(team)) {
      rlScope = `team-${team}`;
      candidates = [{ env: memberEnvName(team), kind: 'member', team }];
    } else {
      return json(400, { success: false, error: 'invalid_request' });
    }

    // At least one password for this scope must be configured.
    if (!candidates.some(c => typeof process.env[c.env] === 'string' && process.env[c.env].length > 0)) {
      console.error(`check-password: no password configured for scope ${rlScope}`);
      return json(503, { success: false, error: 'not_configured' });
    }

    const { session, security } = await authenticate(event);
    const address = clientAddress(event);

    const wait = await security.retryAfter(rlScope, address, cfg.secret);
    if (wait > 0) {
      return json(429, { success: false, error: 'too_many_attempts', retryAfter: wait }, { headers: { 'Retry-After': String(wait) } });
    }

    // Evaluate every candidate so timing does not reveal which one matched.
    const results = candidates.map(c => ({ c, ok: verifyPassword(password, c.env) }));
    const match = results.find(r => r.ok);
    if (!match) {
      await security.recordFailure(rlScope, address, cfg.secret);
      return json(401, { success: false });
    }
    await security.clearAddress(rlScope, address, cfg.secret);

    const grant = makeGrant(match.c.kind, match.c.team, process.env, cfg.secret);
    const issued = issue({ session, add: [grant] });
    return json(200, { success: true, session: summarize({ ...issued.payload, grants: issued.payload.g }) }, {
      cookies: [sessionCookie(issued.token, issued.payload.exp)],
    });
  } catch (err) {
    return errorResponse(err, 'check-password');
  }
};
