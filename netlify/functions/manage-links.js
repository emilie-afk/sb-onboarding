// manage-links.js — add / update / remove links and set / delete revenue goals.
//
// Requires a verified administrative session (cookie) and CSRF header.
// Permission comes only from the session: client-supplied roles or passwords
// are ignored.
//   team admin of <team>  → that team's tasks / eos / kpi / handover / tools
//   global admin          → every team, plus global goals and handbook
//
// POST JSON (header X-SB-Onboarding: 1):
//   { action, team, type, version, link?, id?, year?, goalYear?, yearGoal?, quarterGoal?,
//     monthlyGoals?, brandGoals?, channelGoals? }
//   action: 'add' | 'update' | 'remove'   for link lists
//           'set' | 'delete-year'         for type 'goals' (team 'global')
//   version: the `version` returned by get-links / the previous write ('' = empty).
//            A stale version returns 409 with the current data, so concurrent
//            admins never silently overwrite each other.
//
// Stored shapes are unchanged:
//   `${team}_${type}`  flat array  [{ id, name, url }]
//   `${team}_kpi`      { "<year>": [{ id, name, url }] }
//   `global_goals`     { "<year label>": { yearGoal, quarterGoal, monthlyGoals, brandGoals, channelGoals } }
//   `global_handbook`  flat array  [{ id, name, url }]

const { TEAM_TYPES, LINK_STORE, isTeam } = require('../lib/config');
const { json, readJsonBody, checkCsrf, errorResponse } = require('../lib/http');
const { canManageTeam, isGlobalAdmin } = require('../lib/session');
const { authenticate } = require('../lib/auth');
const { openStore, readVersioned, writeIfVersion } = require('../lib/storage');
const {
  LIMITS,
  RESERVED_KEYS,
  ValidationError,
  validateLinkInput,
  validateRecordId,
  validateKpiYear,
  validateGoalYearLabel,
  validateGoalsEntry,
  isPlainObject,
} = require('../lib/validate');

const LINK_ACTIONS = ['add', 'update', 'remove'];
const GOAL_ACTIONS = ['set', 'delete-year'];

class Outcome {
  constructor(status, body) { this.status = status; this.body = body; }
}

function nextId(records) {
  const maxId = records.reduce((m, r) => (r && Number.isSafeInteger(r.id) && r.id > m ? r.id : m), 0);
  return Math.max(Date.now(), maxId + 1);
}

function sameUrl(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
}

// Applies a link action to a flat list. Returns the new list or an Outcome.
function applyToList(list, body, allRecords) {
  if (!Array.isArray(list)) return new Outcome(409, { error: 'unexpected_data' });
  if (body.action === 'add') {
    const link = validateLinkInput(body.link);
    if (list.some(r => r && sameUrl(r.url, link.url))) return new Outcome(409, { error: 'duplicate' });
    if (list.length >= LIMITS.linksPerList) return new Outcome(409, { error: 'list_full' });
    return [...list, { id: nextId(allRecords), name: link.name, url: link.url }];
  }
  const id = validateRecordId(body.id);
  const idx = list.findIndex(r => r && r.id === id);
  if (idx < 0) return new Outcome(404, { error: 'not_found' });
  if (body.action === 'remove') return list.filter((_, i) => i !== idx);
  // update: keep id, position and any other stored fields
  const link = validateLinkInput(body.link);
  if (list.some((r, i) => i !== idx && r && sameUrl(r.url, link.url))) return new Outcome(409, { error: 'duplicate' });
  const next = list.slice();
  next[idx] = { ...list[idx], name: link.name, url: link.url };
  return next;
}

function applyLinks(type, current, body) {
  if (type !== 'kpi') {
    const list = current ?? [];
    return applyToList(list, body, Array.isArray(list) ? list : []);
  }
  const all = current ?? {};
  if (!isPlainObject(all)) return new Outcome(409, { error: 'unexpected_data' });
  const year = validateKpiYear(body.year);
  const allRecords = Object.values(all).flatMap(v => (Array.isArray(v) ? v : []));
  const yearList = Object.prototype.hasOwnProperty.call(all, year) ? all[year] : [];
  const updated = applyToList(yearList, body, allRecords);
  if (updated instanceof Outcome) return updated;
  return { ...all, [year]: updated };
}

function applyGoals(current, body) {
  const all = current ?? {};
  if (!isPlainObject(all)) return new Outcome(409, { error: 'unexpected_data' });
  if (body.action === 'delete-year') {
    const key = body.goalYear;
    if (typeof key !== 'string' || !key || key.length > 100 || RESERVED_KEYS.has(key)) throw new ValidationError('goal_year_invalid');
    if (!Object.prototype.hasOwnProperty.call(all, key)) return new Outcome(404, { error: 'not_found' });
    const next = { ...all };
    delete next[key];
    return next;
  }
  const goalYear = validateGoalYearLabel(body.goalYear);
  return { ...all, [goalYear]: validateGoalsEntry(body) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false }, { headers: { Allow: 'POST' } });
  }
  try {
    if (!checkCsrf(event)) return json(403, { success: false, error: 'forbidden' });
    const body = readJsonBody(event);

    const { session } = await authenticate(event);
    if (!session) return json(401, { success: false, error: 'unauthenticated' });

    const { action, team, type, version } = body;
    const isGoals = team === 'global' && type === 'goals';
    const isHandbook = team === 'global' && type === 'handbook';
    const isTeamList = isTeam(team) && TEAM_TYPES.includes(type);
    if (!isGoals && !isHandbook && !isTeamList) return json(400, { success: false, error: 'invalid_request' });
    if (!(isGoals ? GOAL_ACTIONS : LINK_ACTIONS).includes(action)) return json(400, { success: false, error: 'invalid_action' });
    if (typeof version !== 'string' || version.length > 200) return json(400, { success: false, error: 'version_required' });

    const allowed = isTeamList ? canManageTeam(session, team) : isGlobalAdmin(session);
    if (!allowed) return json(403, { success: false, error: 'forbidden' });

    const store = openStore(LINK_STORE, event);
    const key = `${team}_${type}`;
    const dataField = isGoals ? 'goals' : 'links';
    const empty = isGoals || type === 'kpi' ? {} : [];

    const current = await readVersioned(store, key);
    const currentBody = { [dataField]: current.data ?? empty, version: current.version };
    if (current.version !== version) {
      return json(409, { success: false, error: 'conflict', ...currentBody });
    }

    const result = isGoals ? applyGoals(current.data, body) : applyLinks(type, current.data, body);
    if (result instanceof Outcome) {
      return json(result.status, { success: false, ...result.body, ...currentBody });
    }

    const written = await writeIfVersion(store, key, result, current.version);
    if (!written.ok) {
      const latest = await readVersioned(store, key);
      return json(409, { success: false, error: 'conflict', [dataField]: latest.data ?? empty, version: latest.version });
    }
    return json(200, { success: true, [dataField]: result, version: written.version });
  } catch (err) {
    if (err instanceof ValidationError) return json(400, { success: false, error: err.code });
    return errorResponse(err, 'manage-links');
  }
};
