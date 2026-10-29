// session.js — session restoration, logout and ending admin access.
//
// GET                                   → { authenticated, teams, adminTeams, globalAdmin, expiresAt }
// POST { action: 'logout' }             → revokes the session server-side and clears the cookie
// POST { action: 'end-admin' }          → drops team-admin and global-admin access, keeps team
//                                         member access under a new session id (the old id is
//                                         revoked so a copied cookie loses admin access too)
// POST { action: 'drop-team', team }     → drops one team's access (used when the user cancels a
//                                         login whose success response arrives late); same
//                                         revoke-and-reissue as end-admin
// POSTs require the X-SB-Onboarding: 1 header and a JSON body (CSRF protection).

const { json, readJsonBody, checkCsrf, errorResponse } = require('../lib/http');
const { isTeam } = require('../lib/config');
const { issue, sessionCookie, clearCookie, summarize } = require('../lib/session');
const { authenticate } = require('../lib/auth');

exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'GET') {
      const { session } = await authenticate(event);
      return json(200, summarize(session));
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { success: false }, { headers: { Allow: 'GET, POST' } });
    }
    if (!checkCsrf(event)) return json(403, { success: false, error: 'forbidden' });
    const { action, team } = readJsonBody(event);
    const { session, security } = await authenticate(event);

    if (action === 'logout') {
      if (session) await security.revoke(session.sid, session.exp);
      return json(200, { success: true, authenticated: false }, { cookies: [clearCookie()] });
    }

    if (action === 'end-admin' || action === 'drop-team') {
      if (action === 'drop-team' && !isTeam(team)) return json(400, { success: false, error: 'invalid_request' });
      if (!session) return json(200, { success: true, authenticated: false }, { cookies: [clearCookie()] });
      const remove = action === 'end-admin'
        ? g => g.s === 'global' || g.l === 'admin'
        : g => g.s === 'team' && g.t === team;
      if (!session.grants.some(remove)) return json(200, { success: true, ...summarize(session) });
      await security.revoke(session.sid, session.exp);
      const issued = issue({ session: { grants: session.grants }, keep: g => !remove(g) });
      if (!issued) return json(200, { success: true, authenticated: false }, { cookies: [clearCookie()] });
      return json(200, { success: true, ...summarize({ ...issued.payload, grants: issued.payload.g }) }, {
        cookies: [sessionCookie(issued.token, issued.payload.exp)],
      });
    }

    return json(400, { success: false, error: 'invalid_action' });
  } catch (err) {
    return errorResponse(err, 'session');
  }
};
