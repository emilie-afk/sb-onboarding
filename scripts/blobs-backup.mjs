#!/usr/bin/env node
// Read-only backup of every key in the `team-links` Netlify Blobs store.
//
//   SITE_ID=… NETLIFY_API_TOKEN=… node scripts/blobs-backup.mjs [--out private/backups]
//
// Writes private/backups/team-links-<timestamp>.json (git-ignored) containing each
// key, its etag and its JSON value. Nothing is written to Netlify. The backup holds
// internal links and revenue goals: keep it private and do not upload it anywhere
// public. Restore is manual and deliberate (see docs/SECURITY.md).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getStore } = require('@netlify/blobs');
const { LINK_STORE } = require('../netlify/lib/config.js');

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'private/backups';
const siteID = process.env.SITE_ID;
const token = process.env.NETLIFY_API_TOKEN;
if (!siteID || !token) {
  console.error('Set SITE_ID and NETLIFY_API_TOKEN in your shell (not in any file in the repository).');
  process.exit(2);
}

const store = getStore({ name: LINK_STORE, siteID, token });
const entries = {};
const { blobs } = await store.list();
for (const { key } of blobs) {
  const res = await store.getWithMetadata(key, { type: 'text' });
  if (!res) continue;
  let value;
  try { value = JSON.parse(res.data); } catch { value = { __unparsed_text__: res.data }; }
  entries[key] = { etag: res.etag || '', value };
}

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(outDir, `${LINK_STORE}-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ store: LINK_STORE, exportedAt: new Date().toISOString(), keyCount: Object.keys(entries).length, entries }, null, 2), { mode: 0o600 });
console.log(`Backed up ${Object.keys(entries).length} keys to ${file}`);
console.log('Keys:', Object.keys(entries).sort().join(', '));
