#!/usr/bin/env node
// Offline review of a backup made with scripts/blobs-backup.mjs.
//
//   node scripts/audit-stored-content.mjs private/backups/team-links-<timestamp>.json
//
// Reports (never fixes or deletes): unexpected keys, unexpected data shapes,
// links the new policy would reject (non-https, javascript:/data:, credentials,
// IP hosts…), over-long or control-character names, duplicate ids / URLs,
// and goal year labels the editor would not accept for new entries.
// Output masks URL paths so it can be pasted into a ticket.

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TEAMS, TEAM_TYPES } = require('../netlify/lib/config.js');
const { checkLinkUrl, LIMITS } = require('../netlify/lib/validate.js');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/audit-stored-content.mjs <backup.json>'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = backup.entries || {};
const issues = [];
const note = (key, msg) => issues.push(`${key}: ${msg}`);
const hostOf = u => { try { const x = new URL(String(u)); return `${x.protocol}//${x.host}/…`; } catch { return String(u).slice(0, 12) + '…'; } };

function auditList(key, list) {
  if (!Array.isArray(list)) return note(key, 'expected a list');
  const ids = new Set(), urls = new Set();
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') return note(key, `item ${i} is not an object`);
    if (!Number.isSafeInteger(r.id)) note(key, `item ${i} has a non-numeric id`);
    else if (ids.has(r.id)) note(key, `duplicate id at item ${i}`); else ids.add(r.id);
    const c = checkLinkUrl(r.url);
    if (!c.ok) note(key, `item ${i} url rejected by new policy (${c.reason}): ${hostOf(r.url)}`);
    if (typeof r.url === 'string') { if (urls.has(r.url.trim())) note(key, `duplicate url at item ${i}`); urls.add(r.url.trim()); }
    if (typeof r.name !== 'string') note(key, `item ${i} name is not text`);
    else if (r.name.length > LIMITS.name || /[\u0000-\u001f]/.test(r.name)) note(key, `item ${i} name too long or has control characters`);
    else if (/[<>"'`]/.test(r.name)) note(key, `item ${i} name contains HTML-like characters (now rendered as text): review`);
  });
}

for (const [key, { value }] of Object.entries(entries)) {
  const [team, type] = key.split('_');
  if (key === 'global_goals') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { note(key, 'expected year-keyed object'); continue; }
    for (const [yr, g] of Object.entries(value)) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) note(key, `"${yr}" is not a goals object (older format?) — kept, not shown`);
      if (yr.length > 30 || !/^[\p{L}\p{N}][\p{L}\p{N} _.\-/]*$/u.test(yr)) note(key, `year label "${yr.slice(0, 30)}" would not be accepted for new entries (existing entry still works)`);
      if (g && typeof g === 'object') {
        for (const f of ['monthlyGoals', 'brandGoals', 'channelGoals']) if (g[f] !== undefined && !Array.isArray(g[f])) note(key, `"${yr}".${f} is not a list`);
      }
    }
  } else if (key === 'global_handbook') {
    auditList(key, value);
  } else if (TEAMS.includes(team) && TEAM_TYPES.includes(type) && key === `${team}_${type}`) {
    if (type === 'kpi') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { note(key, 'expected year-keyed object'); continue; }
      for (const [yr, list] of Object.entries(value)) {
        if (!/^\d{4}$/.test(yr)) note(key, `year key "${yr.slice(0, 20)}" is not a 4-digit year`);
        auditList(`${key}[${yr}]`, list);
      }
    } else auditList(key, value);
  } else {
    note(key, 'unexpected key (not read by the app; left untouched)');
  }
}

console.log(`Audited ${Object.keys(entries).length} keys from ${file}`);
if (!issues.length) console.log('No issues found.');
else { console.log(`${issues.length} item(s) to review:`); for (const i of issues) console.log('  - ' + i); }
