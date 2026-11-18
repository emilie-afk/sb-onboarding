'use strict';
// Netlify Blobs access. Credentials stay server-side.
//
// Every read and write here must be strongly consistent: revocations (logout,
// end-admin, drop-team), login-failure counters and link versions are security or
// integrity state, and a stale read could accept a signed-out cookie or overwrite
// a newer edit.
//
// BLOBS_ACCESS:
//   token (default, the only supported mode) – SITE_ID + NETLIFY_API_TOKEN. The
//         client talks to the Netlify API, which is strongly consistent. The store
//         is also opened with consistency 'strong' and every read requests it.
//   context – NOT SUPPORTED, fails closed (503). These are Lambda-compatible
//         functions; connectLambda() gives them only the cached, eventually
//         consistent edge endpoint (no uncachedEdgeURL), so strong reads are
//         impossible. Re-enable only after migrating to functions that receive a
//         strong-read endpoint, with tests and a deploy-preview check.
//
// Any missing or unsupported configuration throws ConfigError (callers deny access).
// There is no silent fallback to eventual consistency.

const { getStore } = require('@netlify/blobs');
const { ConfigError } = require('./config');

const CONSISTENCY = 'strong';

let testFactory = null;

// Tests and the local dev server inject an in-memory or file-backed store.
function setStoreFactoryForTests(factory) {
  testFactory = factory;
}

// `options.fetch` exists only so tests can observe real client construction
// without network access.
function openStore(name, event, env = process.env, options = {}) {
  const mode = env.BLOBS_ACCESS || 'token';
  if (mode === 'context') {
    throw new ConfigError('BLOBS_ACCESS=context is unsupported: no strongly consistent Blobs endpoint for these functions');
  }
  if (mode !== 'token') throw new ConfigError('BLOBS_ACCESS must be token');
  if (testFactory) return testFactory(name);
  const siteID = env.SITE_ID;
  const token = env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new ConfigError('SITE_ID or NETLIFY_API_TOKEN missing');
  const opts = { name, siteID, token, consistency: CONSISTENCY };
  if (options.fetch) opts.fetch = options.fetch;
  return getStore(opts);
}

// Strong read of a JSON value (null when absent).
async function readStrong(store, key) {
  return store.get(key, { type: 'json', consistency: CONSISTENCY });
}

// Strong read of a JSON value with its version (etag). `version` is '' when absent.
async function readVersioned(store, key) {
  const res = await store.getWithMetadata(key, { type: 'json', consistency: CONSISTENCY });
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

module.exports = { CONSISTENCY, openStore, readStrong, readVersioned, writeIfVersion, setStoreFactoryForTests };
