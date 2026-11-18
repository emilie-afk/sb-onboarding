'use strict';
// Strong consistency for security and integrity state (review item R1).
const test = require('node:test');
const assert = require('node:assert/strict');
const { handlers, TEST_ENV, resetEnv, freshStores, event, body, Client } = require('./helpers');
const { openStore, readStrong, readVersioned, setStoreFactoryForTests } = require('../netlify/lib/storage');
const { ConfigError, LINK_STORE, SECURITY_STORE } = require('../netlify/lib/config');
const { MAX_FAILURES_PER_ADDRESS } = require('../netlify/lib/security-store');

let stores;
test.beforeEach(() => { resetEnv(); stores = freshStores({ eventual: true }); });

// ── Real @netlify/blobs client construction (no network) ─────────────
function fakeFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'get' });
    if (String(url).startsWith('https://api.netlify.com/')) {
      return new Response(JSON.stringify({ url: 'https://signed.blobs.test/object' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  };
}

test('token mode builds a strongly consistent API client for both stores', async () => {
  setStoreFactoryForTests(null);
  resetEnv({ SITE_ID: 'synthetic-site-id', NETLIFY_API_TOKEN: 'synthetic-token' });
  // Even if the runtime exposes an (eventually consistent) edge context, token
  // mode must not be diverted to it.
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: 'https://edge.blobs.test', siteID: 'ctx-site', token: 'ctx-token' })).toString('base64');
  try {
    for (const name of [LINK_STORE, SECURITY_STORE]) {
      const calls = [];
      const store = openStore(name, {}, process.env, { fetch: fakeFetch(calls) });
      assert.equal(store.client.consistency, 'strong', name);
      assert.equal(store.client.edgeURL, undefined, name);
      assert.equal(await readStrong(store, 'revoked/abc'), null);
      assert.deepEqual(await readVersioned(store, 'marketing_tasks'), { data: null, version: '' });
      assert.ok(calls.length >= 2);
      assert.ok(calls.every(c => c.url.startsWith('https://api.netlify.com/api/v1/blobs/synthetic-site-id/') || c.url.startsWith('https://signed.blobs.test/')), JSON.stringify(calls));
      assert.ok(!calls.some(c => c.url.includes('edge.blobs.test')));
    }
  } finally {
    delete process.env.NETLIFY_BLOBS_CONTEXT;
  }
});

test('context mode is refused (no strong-read endpoint) and every function fails closed', async () => {
  resetEnv({ BLOBS_ACCESS: 'context' });
  assert.throws(() => openStore(LINK_STORE, { blobs: 'e30=' }), ConfigError);
  assert.throws(() => openStore(SECURITY_STORE, { blobs: 'e30=' }), ConfigError);
  resetEnv({ BLOBS_ACCESS: 'eventual' });
  assert.throws(() => openStore(LINK_STORE, {}), ConfigError);

  resetEnv();
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  resetEnv({ BLOBS_ACCESS: 'context' });
  const responses = [
    await c.get('marketing', 'tasks'),
    await handlers.session(event({ cookie: c.cookie })),
    await handlers.login(event({ method: 'POST', body: { team: 'marketing', password: TEST_ENV.PASSWORD_MARKETING } })),
    await c.manage({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com/x' } }),
  ];
  for (const r of responses) {
    assert.equal(r.statusCode, 503);
    assert.equal(body(r).error, 'not_configured');
  }
});

// ── Stale-read model ─────────────────────────────────────────────────
test('the stale-read model really serves stale data to non-strong reads (control)', async () => {
  const s = stores(SECURITY_STORE);
  await s.setJSON('revoked/control', { exp: 1 });
  assert.equal(await s.get('revoked/control', { type: 'json' }), null, 'eventual read is stale');
  assert.deepEqual(await s.get('revoked/control', { type: 'json', consistency: 'strong' }), { exp: 1 });
  s.sync();
  assert.deepEqual(await s.get('revoked/control', { type: 'json' }), { exp: 1 });
});

function assertAllReadsStrong() {
  for (const [name, s] of stores.stores) {
    assert.ok(s.reads.length > 0 || name !== SECURITY_STORE, 'security store was read');
    const weak = s.reads.filter(r => r.consistency !== 'strong');
    assert.deepEqual(weak, [], `${name}: non-strong reads`);
  }
}

test('logout: the copied cookie is rejected on the very next request despite stale replicas', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  for (const s of stores.stores.values()) s.sync();     // replicas hold the pre-logout state
  const copied = c.cookie;
  assert.equal((await c.sessionAction('logout')).statusCode, 200);
  // no sync(): replicas still say "not revoked"
  const replay = await handlers.getLinks(event({ query: { team: 'marketing', type: 'tasks' }, cookie: copied }));
  assert.equal(replay.statusCode, 401);
  assert.equal(body(await handlers.session(event({ cookie: copied }))).authenticated, false);
  assertAllReadsStrong();
});

test('end-admin: the admin-capable cookie loses access immediately; team access kept', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  for (const s of stores.stores.values()) s.sync();
  const adminCookie = c.cookie;
  const res = await c.sessionAction('end-admin');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res).teams, ['marketing']);
  const replay = await handlers.manage(event({ method: 'POST', cookie: adminCookie, body: { action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com/a' } } }));
  assert.equal(replay.statusCode, 401);
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 200);
  assertAllReadsStrong();
});

test('drop-team: the previous cookie loses the dropped team immediately', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  for (const s of stores.stores.values()) s.sync();
  const old = c.cookie;
  const res = c.absorb(await handlers.session(event({ method: 'POST', body: { action: 'drop-team', team: 'seo' }, cookie: c.cookie })));
  assert.equal(res.statusCode, 200);
  assert.equal((await handlers.getLinks(event({ query: { team: 'seo', type: 'tasks' }, cookie: old }))).statusCode, 401);
  assert.equal((await c.get('seo', 'tasks')).statusCode, 403);
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 200);
  assertAllReadsStrong();
});

test('login limits count every failure immediately despite stale replicas', async () => {
  const c = new Client('198.51.100.7');
  for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i++) {
    assert.equal((await c.login('marketing', 'wrong-' + i)).statusCode, 401);
  }
  // replicas never synced: a stale read would see zero failures
  const res = await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  assert.equal(res.statusCode, 429);
  assertAllReadsStrong();
});

test('link edits read the current version, so a stale replica cannot cause a lost update', async () => {
  const a = new Client('203.0.113.1');
  const b = new Client('203.0.113.2');
  for (const c of [a, b]) {
    await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
    await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  }
  const first = await a.manage({ action: 'add', team: 'marketing', type: 'tools', version: '', link: { name: 'A', url: 'https://example.com/a' } });
  assert.equal(first.statusCode, 200);
  // B never saw A's write; replicas are stale too
  const second = await b.manage({ action: 'add', team: 'marketing', type: 'tools', version: '', link: { name: 'B', url: 'https://example.com/b' } });
  assert.equal(second.statusCode, 409);
  assert.deepEqual(body(second).links.map(l => l.name), ['A']);
  const fresh = await b.get('marketing', 'tools');
  assert.deepEqual(body(fresh).links.map(l => l.name), ['A']);
  assert.equal(body(fresh).version, body(first).version);
  assertAllReadsStrong();
});
