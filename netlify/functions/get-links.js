// get-links.js — returns stored links / goals for ONE authorized team + type.
//
// Requires a valid signed session (cookie). The team and type in the query are
// only a selection: access is decided from the verified session grants.
//
// GET ?team=<team>&type=tasks|eos|kpi|handover|tools   (member/admin of <team>, or global admin)
// GET ?team=global&type=goals|handbook                 (any signed-in team member or admin)
//
// Response: { links, version }
//   tasks/eos/handover/tools/handbook: [{ id, name, url }, ...]
//   kpi:   { "2026": [{ id, name, url }, ...] }
//   goals: { "2026": { yearGoal, quarterGoal, monthlyGoals, brandGoals, channelGoals } }
// `version` is the storage version used for edit-conflict detection.

const { TEAM_TYPES, GLOBAL_TYPES, LINK_STORE, isTeam } = require('../lib/config');
const { json, errorResponse } = require('../lib/http');
const { canReadTeam, canReadGlobal } = require('../lib/session');
const { authenticate } = require('../lib/auth');
const { openStore, readVersioned } = require('../lib/storage');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' }, { headers: { Allow: 'GET' } });
  }
  try {
    const { team, type } = event.queryStringParameters || {};
    const isGlobal = team === 'global';
    const validTarget = isGlobal ? GLOBAL_TYPES.includes(type) : isTeam(team) && TEAM_TYPES.includes(type);

    // Authenticate before revealing anything about the request.
    const { session } = await authenticate(event);
    if (!session) return json(401, { error: 'unauthenticated' });
    if (!validTarget) return json(400, { error: 'invalid_request' });

    const allowed = isGlobal ? canReadGlobal(session) : canReadTeam(session, team);
    if (!allowed) return json(403, { error: 'forbidden' });

    const store = openStore(LINK_STORE, event);
    const { data, version } = await readVersioned(store, `${team}_${type}`);
    const fallback = type === 'kpi' || type === 'goals' ? {} : [];
    return json(200, { links: data ?? fallback, version });
  } catch (err) {
    return errorResponse(err, 'get-links');
  }
};
