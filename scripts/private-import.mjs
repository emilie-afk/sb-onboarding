#!/usr/bin/env node
// Private, add-only import of links (e.g. the handbook link that used to be
// hard-coded in index.html) into Netlify Blobs.
//
//   node scripts/private-import.mjs --file private/links-import.json            # dry run (default)
//   node scripts/private-import.mjs --file private/links-import.json --apply    # write
//   node scripts/private-import.mjs --file … --local-data-dir private/dev-data  # local test store
//
// Production access uses SITE_ID and NETLIFY_API_TOKEN from your shell environment
// (never commit them). Keep the import file under private/ (git-ignored).
// Existing records are never changed or removed; links whose URL is already
// present are skipped; each key is written with a version check.
//
// Import file format:
// { "entries": [
//     { "team": "global", "type": "handbook", "links": [ { "name": "Employee Handbook", "url": "https://…" } ] },
//     { "team": "marketing", "type": "kpi", "year": "2026", "links": [ … ] }
// ] }

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runImport } = require('./lib/import-core.js');
const { LINK_STORE } = require('../netlify/lib/config.js');

const args = process.argv.slice(2);
const arg = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const file = arg('--file');
const apply = args.includes('--apply');
const localDir = arg('--local-data-dir');
if (!file) {
  console.error('Usage: node scripts/private-import.mjs --file private/links-import.json [--apply] [--local-data-dir dir]');
  process.exit(2);
}

let store;
if (localDir) {
  const { memoryStoreFactory } = require('./lib/memory-store.js');
  store = memoryStoreFactory({ dir: localDir })(LINK_STORE);
  console.log(`Target: LOCAL test store in ${localDir}`);
} else {
  const { getStore } = require('@netlify/blobs');
  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) {
    console.error('Set SITE_ID and NETLIFY_API_TOKEN in your shell (not in any file in the repository).');
    process.exit(2);
  }
  store = getStore({ name: LINK_STORE, siteID, token });
  console.log(`Target: Netlify Blobs store "${LINK_STORE}" of site ${siteID.slice(0, 4)}…`);
}

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(apply ? 'Mode: APPLY (add-only)' : 'Mode: DRY RUN — nothing will be written (add --apply to write)');
try {
  const summary = await runImport(store, doc, { apply });
  console.table(summary);
} catch (err) {
  console.error('Import stopped:', err.message);
  process.exit(1);
}
