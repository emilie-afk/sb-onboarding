'use strict';
// Netlify Blobs access. Credentials stay server-side.
//
// BLOBS_ACCESS selects how the functions authenticate to Blobs:
//   token   (default, current production behaviour) – SITE_ID + NETLIFY_API_TOKEN.
//           Reads go through the Netlify API, so they are strongly consistent.
//   context – the deploy-scoped Blobs credentials Netlify passes to each function
//           invocation (connectLambda). Avoids a personal access token, but reads
//           are eventually consistent (up to ~60 s), so edit conflicts are more
//           likely right after a change. Verify on a deploy preview before switching
//           production; deploy previews read and write the same site-wide store.
//
// Any missing configuration throws ConfigError (callers deny access).

const { getStore, connectLambda } = require('@netlify/blobs');
const { ConfigError } = require('./config');

let testFactory = null;

// Tests and the local dev server inject an in-memory or file-backed store.
function setStoreFactoryForTests(factory) {
  testFactory = factory;
}

function openStore(name, event, env = process.env) {
  if (testFactory) return testFactory(name);
  const mode = env.BLOBS_ACCESS || 'token';
  if (mode === 'context') {
    if (!event || !event.blobs) throw new ConfigError('Blobs context unavailable');
    connectLambda(event);
    return getStore(name);
  }
  if (mode !== 'token') throw new ConfigError('BLOBS_ACCESS must be token or context');
  const siteID = env.SITE_ID;
  const token = env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new ConfigError('SITE_ID or NETLIFY_API_TOKEN missing');
  return getStore({ name, siteID, token });
}

// Reads a JSON value with its version (etag). `version` is '' when the key is absent.
async function readVersioned(store, key) {
  const res = await store.getWithMetadata(key, { type: 'json' });
  if (!res) return { data: null, version: '' };
  return { data: res.data, version: res.etag || '' };
}

// Conditional write: succeeds only if the stored version is still `version`
// ('' means "key must not exist yet"). Returns { ok, version }.
async function writeIfVersion(store, key, data, version) {
  const opts = version ? { onlyIfMatch: version } : { onlyIfNew: true };
  const res = await store.setJSON(key, data, opts);
  if (!res || res.modified !== true) return { ok: false, version: null };
  if (res.etag) return { ok: true, version: res.etag };
  // @netlify/blobs reports any conditional write that did not fail with 412 as
  // { modified: true } — including 401/403/5xx responses, which carry no etag.
  // Without an etag, read back and confirm the stored value is ours before
  // reporting success; otherwise fail loudly instead of claiming a save.
  const after = await readVersioned(store, key);
  if (!after.version || JSON.stringify(after.data) !== JSON.stringify(data)) {
    throw new Error('conditional write not confirmed');
  }
  return { ok: true, version: after.version };
}

module.exports = { openStore, readVersioned, writeIfVersion, setStoreFactoryForTests };
