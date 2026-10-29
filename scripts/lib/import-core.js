'use strict';
// Add-only import of links into the existing `team-links` structure.
// Never removes, reorders or edits existing records; never overwrites a key that
// changed since it was read (conditional write).

const { TEAMS, TEAM_TYPES } = require('../../netlify/lib/config');
const { validateLinkInput, validateKpiYear, isPlainObject } = require('../../netlify/lib/validate');
const { readVersioned, writeIfVersion } = require('../../netlify/lib/storage');

const IMPORTABLE_GLOBAL = ['handbook'];

function entryKey(entry) {
  const { team, type } = entry;
  if (team === 'global') {
    if (!IMPORTABLE_GLOBAL.includes(type)) throw new Error(`global/${type} cannot be imported (only: ${IMPORTABLE_GLOBAL.join(', ')})`);
  } else if (!TEAMS.includes(team) || !TEAM_TYPES.includes(type)) {
    throw new Error(`unsupported team/type ${team}/${type}`);
  }
  return `${team}_${type}`;
}

function maxId(records) {
  return records.reduce((m, r) => (r && Number.isSafeInteger(r.id) && r.id > m ? r.id : m), 0);
}

// Returns { next, added:[{name,host}], skipped:[{reason,host}] } without writing.
function planEntry(current, entry, env = process.env) {
  const isKpi = entry.type === 'kpi';
  if (isKpi && current != null && !isPlainObject(current)) throw new Error('existing KPI data is not year-keyed; not touching it');
  if (!isKpi && current != null && !Array.isArray(current)) throw new Error('existing data is not a list; not touching it');
  const year = isKpi ? validateKpiYear(entry.year) : null;
  const all = isKpi ? { ...(current || {}) } : null;
  const list = isKpi ? [...(Array.isArray(all[year]) ? all[year] : [])] : [...(current || [])];
  const everyRecord = isKpi ? Object.values(all).flatMap(v => (Array.isArray(v) ? v : [])) : list;
  const ids = new Set(everyRecord.map(r => r && r.id));
  let nextId = Math.max(Date.now(), maxId(everyRecord) + 1);
  const added = [];
  const skipped = [];
  for (const raw of entry.links || []) {
    let link;
    try {
      link = validateLinkInput(raw, env);
    } catch (e) {
      skipped.push({ reason: e.code || 'invalid', host: hostOf(raw && raw.url) });
      continue;
    }
    if (list.some(r => r && typeof r.url === 'string' && r.url.trim() === link.url)) {
      skipped.push({ reason: 'already_present', host: hostOf(link.url) });
      continue;
    }
    let id = Number.isSafeInteger(raw.id) && raw.id > 0 && !ids.has(raw.id) ? raw.id : nextId++;
    ids.add(id);
    list.push({ id, name: link.name, url: link.url });
    added.push({ name: link.name, host: hostOf(link.url) });
  }
  const next = isKpi ? { ...all, [year]: list } : list;
  return { next, added, skipped };
}

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return '(invalid)'; }
}

async function runImport(store, doc, { apply = false, log = console.log, env = process.env } = {}) {
  if (!doc || !Array.isArray(doc.entries)) throw new Error('import file must have an "entries" array');
  const summary = [];
  for (const entry of doc.entries) {
    const key = entryKey(entry);
    const { data, version } = await readVersioned(store, key);
    const plan = planEntry(data, entry, env);
    const label = `${key}${entry.year ? `[${entry.year}]` : ''}`;
    for (const a of plan.added) log(`  + ${label}: "${a.name}" (${a.host})`);
    for (const s of plan.skipped) log(`  = ${label}: skipped ${s.reason} (${s.host})`);
    let written = false;
    if (apply && plan.added.length) {
      const res = await writeIfVersion(store, key, plan.next, version);
      if (!res.ok) throw new Error(`${key} changed while importing; nothing written for it — run again`);
      written = true;
    }
    summary.push({ key: label, added: plan.added.length, skipped: plan.skipped.length, written });
  }
  return summary;
}

module.exports = { planEntry, runImport, entryKey };
