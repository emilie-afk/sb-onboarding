// manage-links.js
// Adds or removes file links. Requires the global admin password.
//
// POST body:
//   { action, team, type, adminPassword, link?, id?, year? }
//
//   action: 'add' | 'remove'
//   team:   'marketing' | 'customerservice' | 'seo' | 'design' | 'video'
//   type:   'tasks' | 'eos' | 'kpi' | 'handover' | 'tools'
//   year:   required only for type='kpi' (e.g. "2026")
//   link:   { name, url }   — for action='add'
//   id:     number           — for action='remove'

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ success: false }) }; }

  const { action, team, type, adminPassword, link, id, year } = body;

  // ── Validate admin password ──
  const globalAdmin = process.env.PASSWORD_ADMIN;
  const teamAdminKey = team
    ? 'PASSWORD_ADMIN_' + team.toUpperCase().replace(/[^A-Z]/g, '')
    : null;
  const teamAdmin = teamAdminKey ? process.env[teamAdminKey] : null;

  const authorized =
    (globalAdmin && adminPassword === globalAdmin) ||
    (teamAdmin   && adminPassword === teamAdmin);

  if (!authorized) {
    return { statusCode: 401, body: JSON.stringify({ success: false }) };
  }

  if (!action || !team || !type) {
    return { statusCode: 400, body: JSON.stringify({ success: false }) };
  }

  // ── Get store with explicit credentials ──
  const siteID = process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;

  if (!siteID || !token) {
    console.error('manage-links: missing SITE_ID or NETLIFY_API_TOKEN env vars');
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Server misconfiguration: missing SITE_ID or NETLIFY_API_TOKEN' })
    };
  }

  try {
    const store = getStore({ name: 'team-links', siteID, token });
    const key   = `${team}_${type}`;

    if (type === 'kpi') {
      // KPI: year-keyed object  { "2026": [...], "2027": [...] }
      const allYears = (await store.get(key, { type: 'json' })) || {};

      if (action === 'add') {
        if (!year || !link?.url) return { statusCode: 400, body: JSON.stringify({ success: false }) };
        const yearLinks = allYears[year] || [];
        yearLinks.push({ id: Date.now(), name: link.name || link.url, url: link.url });
        allYears[year] = yearLinks;
      } else if (action === 'remove') {
        if (!year || id == null) return { statusCode: 400, body: JSON.stringify({ success: false }) };
        const yearLinks = (allYears[year] || []).filter(l => l.id !== id);
        allYears[year] = yearLinks;
      }

      await store.setJSON(key, allYears);
      return { statusCode: 200, body: JSON.stringify({ success: true, links: allYears }) };

    } else {
      // tasks / eos / handover / tools: flat array
      let links = (await store.get(key, { type: 'json' })) || [];

      if (action === 'add') {
        if (!link?.url) return { statusCode: 400, body: JSON.stringify({ success: false }) };
        links.push({ id: Date.now(), name: link.name || link.url, url: link.url });
      } else if (action === 'remove') {
        if (id == null) return { statusCode: 400, body: JSON.stringify({ success: false }) };
        links = links.filter(l => l.id !== id);
      }

      await store.setJSON(key, links);
      return { statusCode: 200, body: JSON.stringify({ success: true, links }) };
    }

  } catch (err) {
    console.error('manage-links error:', err.message || err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
