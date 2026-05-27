// get-links.js
// Returns saved file links for a team + type.
// No auth required — the UI already gates access behind the team password.
//
// Query params: ?team=marketing&type=eos
//   type: tasks | eos | kpi | handover | tools | goals
//
// Response for tasks/eos/handover/tools (flat array):
//   { links: [{ id, name, url }, ...] }
//
// Response for kpi (year-keyed object):
//   { links: { "2026": [{ id, name, url }, ...] } }

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  const { team, type } = event.queryStringParameters || {};

  if (!team || !type) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing team or type' }) };
  }

  // ── Get store with explicit credentials ──
  const siteID = process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;

  if (!siteID || !token) {
    console.error('get-links: missing SITE_ID or NETLIFY_API_TOKEN env vars');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server misconfiguration: missing SITE_ID or NETLIFY_API_TOKEN' })
    };
  }

  try {
    const store = getStore({ name: 'team-links', siteID, token });
    const key   = `${team}_${type}`;
    const data  = await store.get(key, { type: 'json' });

    // Default: kpi → {}, goals → { yearGoal:'', quarterGoal:'' }, others → []
    const fallback = (type === 'kpi' || type === 'goals') ? {} : [];
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: data ?? fallback }),
    };
  } catch (err) {
    console.error('get-links error:', err.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to load links', detail: err.message }),
    };
  }
};
