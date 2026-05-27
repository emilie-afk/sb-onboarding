// get-links.js
// Returns saved file links for a team + type.
// No auth required — the UI already gates access behind the team password.
//
// Query params: ?team=marketing&type=eos   (type: eos | kpi | handover)
//
// Response for eos / handover (flat array):
//   { links: [{ id, name, url }, ...] }
//
// Response for kpi (year-keyed object):
//   { links: { "2026": [{ id, name, url }, ...], "2027": [...] } }

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  const { team, type } = event.queryStringParameters || {};

  if (!team || !type) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing team or type' }) };
  }

  try {
    const store = getStore('team-links');
    const key   = `${team}_${type}`;
    const data  = await store.get(key, { type: 'json' });

    // Default: eos/handover → [], kpi → {}
    const fallback = type === 'kpi' ? {} : [];
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: data ?? fallback }),
    };
  } catch (err) {
    console.error('get-links error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to load links' }),
    };
  }
};
