'use strict';
// guide.js — the private onboarding guide (setup checklist details, benefits, daily routine).
//
// The guide names people, internal tools and HR terms, so it is not in this public
// repository or in the published page. The build writes it from the ONBOARDING_GUIDE_JSON
// build variable (plain JSON, or "gz:" + base64 of the gzipped JSON) to netlify/private/guide.json
// (git-ignored, never copied to dist/), and the get-guide function bundles that file
// (netlify.toml included_files). get-guide serves it only to a signed-in session.
//
// Shape (all text is plain text; **double asterisks** mark bold):
//   { version: string,
//     checklist: [{ title, text }],            // replaces the public checklist cards
//     tools: [{ icon, name, note }],           // the strip under the checklist
//     benefitsNote: string,
//     benefits: [{ icon, title, text }],
//     routine: [{ title, paragraphs: [string], detail: [string] }] }   // before "Follow your team workflow"

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_TEXT = 2000;
const MAX_ITEMS = 30;

class GuideError extends Error {
  constructor(code) { super(code); this.name = 'GuideError'; this.code = code; }
}

const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;
const textList = v => Array.isArray(v) && v.length <= MAX_ITEMS && v.every(s => isText(s));

function validateGuide(doc) {
  const g = typeof doc === 'string' ? JSON.parse(doc) : doc;
  const ok = g && typeof g === 'object'
    && isText(g.version, 64)
    && Array.isArray(g.checklist) && g.checklist.length <= MAX_ITEMS && g.checklist.every(c => c && isText(c.title, 200) && isText(c.text))
    && Array.isArray(g.tools) && g.tools.length <= MAX_ITEMS && g.tools.every(t => t && isText(t.icon, 8) && isText(t.name, 100) && isText(t.note, 300))
    && isText(g.benefitsNote)
    && Array.isArray(g.benefits) && g.benefits.length <= MAX_ITEMS && g.benefits.every(b => b && isText(b.icon, 8) && isText(b.title, 200) && isText(b.text))
    && Array.isArray(g.routine) && g.routine.length <= MAX_ITEMS && g.routine.every(r => r && isText(r.title, 200) && textList(r.paragraphs) && textList(r.detail));
  if (!ok) throw new GuideError('guide_invalid');
  return {
    version: g.version,
    checklist: g.checklist.map(({ title, text }) => ({ title, text })),
    tools: g.tools.map(({ icon, name, note }) => ({ icon, name, note })),
    benefitsNote: g.benefitsNote,
    benefits: g.benefits.map(({ icon, title, text }) => ({ icon, title, text })),
    routine: g.routine.map(({ title, paragraphs, detail }) => ({ title, paragraphs: [...paragraphs], detail: [...detail] })),
  };
}

/** Decodes the build variable value (plain JSON or "gz:" + base64 gzip). */
function decodeGuideValue(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  try {
    return v.startsWith('gz:') ? zlib.gunzipSync(Buffer.from(v.slice(3), 'base64')).toString('utf8') : v;
  } catch {
    throw new GuideError('guide_invalid');
  }
}

function guideCandidates(env = process.env) {
  const out = [];
  if (env.ONBOARDING_GUIDE_FILE) out.push(env.ONBOARDING_GUIDE_FILE);
  for (const base of [env.LAMBDA_TASK_ROOT, process.cwd(), path.resolve(__dirname, '..', '..')]) {
    if (base) out.push(path.join(base, 'netlify', 'private', 'guide.json'));
  }
  return out;
}

let cache = null;

/** Returns the validated guide, or throws GuideError('guide_missing' | 'guide_invalid'). */
function loadGuide(env = process.env) {
  if (cache && !env.ONBOARDING_GUIDE_FILE) return cache;
  for (const file of guideCandidates(env)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let guide;
    try { guide = validateGuide(text); } catch { throw new GuideError('guide_invalid'); }
    if (!env.ONBOARDING_GUIDE_FILE) cache = guide;
    return guide;
  }
  throw new GuideError('guide_missing');
}

function resetGuideCacheForTests() { cache = null; }

module.exports = { loadGuide, validateGuide, decodeGuideValue, GuideError, resetGuideCacheForTests };
