'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { handlers, TEST_ENV, resetEnv, freshStores, event, setCookieOf, body, Client, withNow, captureConsole } = require('./helpers');
const { COOKIE_NAME, encodeToken, decodeToken } = require('../netlify/lib/session');
const { MAX_FAILURES_PER_ADDRESS } = require('../netlify/lib/security-store');

let stores;
test.beforeEach(() => { resetEnv(); stores = freshStores(); });

const tokenOf = c => decodeURIComponent(c.cookie.split('=').slice(1).join('='));

test('login issues a Secure, HttpOnly, SameSite=Strict, host-only, expiring cookie', async () => {
  const c = new Client();
  const res = await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  assert.equal(res.statusCode, 200);
  const sc = setCookieOf(res);
  assert.match(sc, new RegExp(`^${COOKIE_NAME}=`));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(attr), attr);
  assert.ok(!/Domain=/i.test(sc));
  const maxAge = Number(sc.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge > 11 * 3600 && maxAge <= 12 * 3600);
  const b = body(res);
  assert.deepEqual(b.session.teams, ['marketing']);
  assert.equal(b.session.globalAdmin, false);
  assert.equal(res.headers['Cache-Control'].includes('no-store'), true);
});

test('session token never contains a password and is not the password', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  const raw = tokenOf(c);
  const payload = decodeToken(raw, TEST_ENV.SESSION_SECRET);
  const text = JSON.stringify(payload) + raw;
  for (const pw of Object.values(TEST_ENV)) assert.ok(!text.includes(pw));
  const res = await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  assert.ok(!res.body.includes(TEST_ENV.PASSWORD_MARKETING));
});

test('wrong password → 401 with no cookie', async () => {
  const c = new Client();
  const res = await c.login('marketing', 'nope');
  assert.equal(res.statusCode, 401);
  assert.equal(setCookieOf(res), null);
  assert.equal(body(res).success, false);
});

test('a team password only opens its own team', async () => {
  const c = new Client();
  assert.equal((await c.login('seo', TEST_ENV.PASSWORD_MARKETING)).statusCode, 401);
  assert.equal((await c.login('marketing', TEST_ENV.PASSWORD_ADMIN)).statusCode, 401, 'global admin password is not a member password');
});

test('unsupported team names are rejected, not mapped to env vars', async () => {
  const c = new Client();
  for (const team of ['MARKETING', 'market-ing', 'admin_marketing', '__proto__', 'global', '']) {
    const res = await c.login(team, TEST_ENV.PASSWORD_MARKETING);
    assert.equal(res.statusCode, 400, team);
  }
  const res = await c.login('admin', TEST_ENV.PASSWORD_ADMIN_MARKETING, { teamName: 'Marketing!' });
  assert.equal(res.statusCode, 400);
});

test('multiple teams can be unlocked in one session without granting others', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  const info = await c.sessionInfo();
  assert.deepEqual(info.teams, ['marketing', 'seo']);
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 200);
  assert.equal((await c.get('seo', 'tasks')).statusCode, 200);
  assert.equal((await c.get('design', 'tasks')).statusCode, 403);
});

test('session restoration returns the verified grants only', async () => {
  const c = new Client();
  assert.deepEqual(await c.sessionInfo(), { authenticated: false });
  await c.login('design', TEST_ENV.PASSWORD_DESIGN);
  const info = await c.sessionInfo();
  assert.equal(info.authenticated, true);
  assert.deepEqual(info.teams, ['design']);
  assert.deepEqual(info.adminTeams, []);
  assert.ok(Date.parse(info.expiresAt) > Date.now());
});

test('forged, tampered and garbage sessions are rejected', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  const raw = tokenOf(c);
  const payload = decodeToken(raw, TEST_ENV.SESSION_SECRET);

  // Tamper: change granted team but keep the old signature.
  const tampered = { ...payload, g: payload.g.map(g => ({ ...g, t: 'seo' })) };
  const tamperedBody = Buffer.from(JSON.stringify(tampered)).toString('base64url');
  const forgedSameSig = tamperedBody + '.' + raw.split('.')[1];
  // Forge: sign with a different secret.
  const forgedOtherKey = encodeToken({ ...payload, g: [{ s: 'global', pv: 'x', x: payload.exp }] }, 'another-secret-that-is-long-enough-000000');
  // Grant claims global admin with a correct signature but no valid password fingerprint.
  const noFingerprint = encodeToken({ ...payload, g: [{ s: 'global', pv: 'AAAAAAAAAAAAAAAAAAAAAA', x: payload.exp }] }, TEST_ENV.SESSION_SECRET);

  for (const bad of ['garbage', raw + 'x', forgedSameSig, forgedOtherKey, noFingerprint, '', 'a.b.c']) {
    const res = await handlers.getLinks(event({ query: { team: 'seo', type: 'tasks' }, cookie: `${COOKIE_NAME}=${bad}` }));
    assert.ok([401, 403].includes(res.statusCode), `token variant got ${res.statusCode}`);
    const res2 = await handlers.getLinks(event({ query: { team: 'global', type: 'goals' }, cookie: `${COOKIE_NAME}=${bad}` }));
    if (bad !== raw) assert.equal(res2.statusCode, 401);
  }
});

test('expired sessions and expired admin grants are rejected by the server', async () => {
  const c = new Client();
  const t0 = Date.UTC(2026, 9, 1, 8, 0, 0);
  await withNow(t0, async () => {
    await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
    await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  });
  // 3 hours later: admin (2 h) expired, member (12 h) still valid.
  await withNow(t0 + 3 * 3600e3, async () => {
    const info = await c.sessionInfo();
    assert.deepEqual(info.adminTeams, []);
    assert.deepEqual(info.teams, ['marketing']);
    const res = await c.manage({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { name: 'X', url: 'https://example.com/x' } });
    assert.equal(res.statusCode, 403);
  });
  // 13 hours later: everything expired even though the browser still sends the cookie.
  await withNow(t0 + 13 * 3600e3, async () => {
    assert.equal((await c.get('marketing', 'tasks')).statusCode, 401);
    assert.deepEqual(await c.sessionInfo(), { authenticated: false });
  });
});

test('SESSION_NOT_BEFORE invalidates sessions issued earlier', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  resetEnv({ SESSION_NOT_BEFORE: new Date(Date.now() + 5000).toISOString() });
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 401);
});

test('rotating SESSION_SECRET invalidates all sessions', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  resetEnv({ SESSION_SECRET: 'a-completely-new-synthetic-secret-9876543210' });
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 401);
});

test('changing a team password invalidates only grants issued for that password', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  resetEnv({ PASSWORD_MARKETING: 'synthetic-mk-member-ROTATED' });
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 403);
  assert.equal((await c.get('seo', 'tasks')).statusCode, 200);
  assert.equal((await c.login('marketing', 'synthetic-mk-member-ROTATED')).statusCode, 200);
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 200);
});

test('changing the admin password removes admin access from existing sessions', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.globalLogin(TEST_ENV.PASSWORD_ADMIN);
  resetEnv({ PASSWORD_ADMIN: 'synthetic-global-admin-ROTATED' });
  const info = await c.sessionInfo();
  assert.equal(info.globalAdmin, false);
  assert.deepEqual(info.teams, ['marketing']);
  const res = await c.manage({ action: 'set', team: 'global', type: 'goals', version: '', goalYear: '2026', yearGoal: '$1' });
  assert.equal(res.statusCode, 403);
});

test('removing a password from the environment denies its existing sessions', async () => {
  const c = new Client();
  await c.login('video', TEST_ENV.PASSWORD_VIDEO);
  resetEnv({ PASSWORD_VIDEO: undefined });
  assert.equal((await c.get('video', 'tasks')).statusCode, 401);
  const res = await c.login('video', TEST_ENV.PASSWORD_VIDEO);
  assert.equal(res.statusCode, 503);
});

test('logout revokes the session server-side (a copied cookie stops working)', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  const copied = c.cookie;
  const res = await c.sessionAction('logout');
  assert.equal(res.statusCode, 200);
  assert.match(setCookieOf(res), /Max-Age=0/);
  assert.equal(c.cookie, null);
  const replay = await handlers.getLinks(event({ query: { team: 'marketing', type: 'tasks' }, cookie: copied }));
  assert.equal(replay.statusCode, 401);
  assert.ok(stores('onboarding-security').map.size > 0, 'revocation is stored durably');
});

test('end-admin keeps member access and revokes the admin-capable cookie', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  const adminCookie = c.cookie;
  const res = await c.sessionAction('end-admin');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res).adminTeams, []);
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 200);
  const replay = await handlers.manage(event({ method: 'POST', cookie: adminCookie, body: { action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com/a' } } }));
  assert.equal(replay.statusCode, 401);
});

test('CSRF: writes and logins need the custom header, JSON and same origin', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  const payload = { action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com/csrf' } };
  const variants = [
    { csrf: false },
    { headers: { origin: 'https://evil.example' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { origin: 'null' } },
  ];
  for (const v of variants) {
    const res = await handlers.manage(event({ method: 'POST', body: payload, cookie: c.cookie, ...v }));
    assert.equal(res.statusCode, 403, JSON.stringify(v));
  }
  const login = await handlers.login(event({ method: 'POST', body: { team: 'seo', password: TEST_ENV.PASSWORD_SEO }, csrf: false }));
  assert.equal(login.statusCode, 403);
  const logout = await handlers.session(event({ method: 'POST', body: { action: 'logout' }, cookie: c.cookie, headers: { origin: 'https://evil.example' } }));
  assert.equal(logout.statusCode, 403);
  assert.equal(stores('team-links').peek('marketing_tasks'), undefined);
});

test('APP_ORIGINS restricts allowed origins when set', async () => {
  resetEnv({ APP_ORIGINS: 'https://sb-onboarding.example' });
  const res = await handlers.login(event({ method: 'POST', body: { team: 'seo', password: TEST_ENV.PASSWORD_SEO } }));
  assert.equal(res.statusCode, 403);
  const ok = await handlers.login(event({ method: 'POST', body: { team: 'seo', password: TEST_ENV.PASSWORD_SEO }, headers: { origin: 'https://sb-onboarding.example' } }));
  assert.equal(ok.statusCode, 200);
});

test('durable login limits: per address and per team, stored outside process memory', async () => {
  const attacker = new Client('198.51.100.7');
  for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i++) {
    assert.equal((await attacker.login('marketing', 'guess-' + i)).statusCode, 401);
  }
  const blocked = await attacker.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  assert.equal(blocked.statusCode, 429, 'even the right password is refused while limited');
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.equal(setCookieOf(blocked), null);

  // State lives in the security store (not memory): a "new function instance" sees it.
  const sec = stores('onboarding-security');
  const keys = [...sec.map.keys()];
  assert.ok(keys.some(k => k.startsWith('rl/team-marketing/')));
  assert.ok(!keys.some(k => k.includes('198.51.100.7')), 'client address is hashed');

  // Another address is not affected; other scopes are not affected.
  assert.equal((await new Client('198.51.100.8').login('marketing', TEST_ENV.PASSWORD_MARKETING)).statusCode, 200);
  assert.equal((await attacker.login('seo', TEST_ENV.PASSWORD_SEO)).statusCode, 200);

  // Window expiry lifts the limit.
  await withNow(Date.now() + 16 * 60e3, async () => {
    assert.equal((await attacker.login('marketing', TEST_ENV.PASSWORD_MARKETING)).statusCode, 200);
  });
});

test('per-team limit slows distributed guessing across addresses', async () => {
  for (let i = 0; i < 50; i++) await new Client(`192.0.2.${i}`).login('admin', 'guess', { teamName: 'seo' });
  const res = await new Client('192.0.2.200').adminLogin('seo', TEST_ENV.PASSWORD_ADMIN_SEO);
  assert.equal(res.statusCode, 429);
});

test('login fails closed if the limit store is unavailable', async () => {
  stores = freshStores({ failOn: (op, key) => key.startsWith('rl/') });
  const res = await new Client().login('marketing', TEST_ENV.PASSWORD_MARKETING);
  assert.equal(res.statusCode, 500);
  assert.equal(setCookieOf(res), null);
});

test('missing or unsafe security configuration denies access everywhere', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  const cookie = c.cookie;
  const cases = [
    { SESSION_SECRET: undefined },
    { SESSION_SECRET: 'too-short' },
    { SESSION_SECRET: TEST_ENV.PASSWORD_ADMIN.padEnd(40, 'x'), PASSWORD_ADMIN: TEST_ENV.PASSWORD_ADMIN.padEnd(40, 'x') },
    { SESSION_NOT_BEFORE: 'not-a-date' },
  ];
  for (const env of cases) {
    resetEnv(env);
    const r1 = await handlers.getLinks(event({ query: { team: 'marketing', type: 'tasks' }, cookie }));
    const r2 = await handlers.login(event({ method: 'POST', body: { team: 'marketing', password: TEST_ENV.PASSWORD_MARKETING } }));
    const r3 = await handlers.session(event({ cookie }));
    const r4 = await handlers.manage(event({ method: 'POST', cookie, body: { action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com' } } }));
    for (const r of [r1, r2, r3, r4]) {
      assert.equal(r.statusCode, 503, JSON.stringify(env));
      assert.ok(!/links|session"/.test(r.body) || body(r).error === 'not_configured');
    }
  }
});

test('missing Blobs credentials deny access (token mode, no test store)', async () => {
  const { setStoreFactoryForTests } = require('../netlify/lib/storage');
  setStoreFactoryForTests(null);
  resetEnv({ SITE_ID: undefined, NETLIFY_API_TOKEN: undefined });
  const res = await handlers.getLinks(event({ query: { team: 'marketing', type: 'tasks' } }));
  assert.equal(res.statusCode, 503);
  resetEnv({ BLOBS_ACCESS: 'context' });
  const res2 = await handlers.getLinks(event({ query: { team: 'marketing', type: 'tasks' } }));
  assert.equal(res2.statusCode, 503);
});

test('logs and error responses never contain passwords, cookies or the secret', async () => {
  const cap = captureConsole();
  try {
    stores = freshStores({ failOn: (op, key) => op === 'set' && key === 'marketing_tasks' });
    const c = new Client();
    await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
    await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
    const res = await c.manage({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com/fail' } });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(body(res), { success: false, error: 'server_error' });
    resetEnv({ SESSION_SECRET: undefined });
    await handlers.login(event({ method: 'POST', body: { team: 'marketing', password: TEST_ENV.PASSWORD_MARKETING } }));
    const text = cap.lines.join('\n') + res.body;
    for (const v of Object.values(TEST_ENV)) assert.ok(!text.includes(v), 'leaked ' + v.slice(0, 12));
    assert.ok(!text.includes(c.cookie.split('=')[1]));
    assert.ok(!text.includes('https://example.com/fail'));
  } finally {
    cap.restore();
  }
});

test('oversized and malformed bodies are rejected before any work', async () => {
  const big = JSON.stringify({ team: 'marketing', password: 'x'.repeat(40 * 1024) });
  assert.equal((await handlers.login(event({ method: 'POST', rawBody: big }))).statusCode, 413);
  assert.equal((await handlers.login(event({ method: 'POST', rawBody: '{nope' }))).statusCode, 400);
  assert.equal((await handlers.login(event({ method: 'POST', rawBody: '[]' }))).statusCode, 400);
  assert.equal((await handlers.login(event({ method: 'GET' }))).statusCode, 405);
});

test('password comparison handles non-string and very long input safely', async () => {
  for (const pw of [null, 123, { a: 1 }, ['x'], 'x'.repeat(300)]) {
    const res = await handlers.login(event({ method: 'POST', body: { team: 'marketing', password: pw } }));
    assert.equal(res.statusCode, 400);
  }
  assert.ok(crypto.timingSafeEqual);
});

test('drop-team removes only that team (cancelled login) and revokes the previous cookie', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  const old = c.cookie;
  const res = await c.sessionAction('drop-team');
  assert.equal(res.statusCode, 400, 'team required');
  const r2 = c.absorb(await handlers.session(event({ method: 'POST', body: { action: 'drop-team', team: 'seo' }, cookie: c.cookie })));
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(body(r2).teams, ['marketing']);
  assert.equal((await c.get('seo', 'tasks')).statusCode, 403);
  assert.equal((await c.get('marketing', 'tasks')).statusCode, 200);
  const replay = await handlers.getLinks(event({ query: { team: 'seo', type: 'tasks' }, cookie: old }));
  assert.equal(replay.statusCode, 401);
  assert.equal((await c.sessionAction('nonsense')).statusCode, 400);
});

test('MAINTENANCE_MODE closes every function without reading data', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  resetEnv({ MAINTENANCE_MODE: '1' });
  const s = stores('team-links');
  s.ops.length = 0;
  const responses = [
    await c.get('marketing', 'tasks'),
    await c.login('marketing', TEST_ENV.PASSWORD_MARKETING),
    await handlers.session(event({ cookie: c.cookie })),
    await c.manage({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com' } }),
  ];
  for (const r of responses) assert.deepEqual([r.statusCode, body(r).error], [503, 'maintenance']);
  assert.equal(s.ops.length, 0);
  delete process.env.MAINTENANCE_MODE;
});
