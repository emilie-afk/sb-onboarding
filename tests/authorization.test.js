'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handlers, TEST_ENV, resetEnv, freshStores, event, body, Client } = require('./helpers');
const { TEAMS, TEAM_TYPES } = require('../netlify/lib/config');

let stores;
const seed = () => {
  const s = stores('team-links');
  for (const team of TEAMS) {
    s.map.set(`${team}_tasks`, { body: JSON.stringify([{ id: 1, name: `${team} secret task list`, url: `https://example.com/${team}/tasks` }]), etag: '"v1"' });
    s.map.set(`${team}_kpi`, { body: JSON.stringify({ 2026: [{ id: 2, name: `${team} KPI`, url: `https://example.com/${team}/kpi` }] }), etag: '"v1"' });
  }
  s.map.set('global_goals', { body: JSON.stringify({ 2026: { yearGoal: '$9', quarterGoal: '$3', monthlyGoals: [], brandGoals: [], channelGoals: [] } }), etag: '"g1"' });
  s.map.set('global_handbook', { body: JSON.stringify([{ id: 5, name: 'Employee Handbook', url: 'https://docs.google.com/document/d/EXAMPLE-HANDBOOK/edit' }]), etag: '"h1"' });
};
test.beforeEach(() => { resetEnv(); stores = freshStores(); seed(); });

const addTask = (team, version = '"v1"', url = 'https://example.com/new') =>
  ({ action: 'add', team, type: 'tasks', version, link: { name: 'New', url } });

test('anonymous requests cannot read any protected links or goals', async () => {
  const s = stores('team-links');
  for (const team of TEAMS) for (const type of TEAM_TYPES) {
    const res = await handlers.getLinks(event({ query: { team, type } }));
    assert.equal(res.statusCode, 401);
    assert.ok(!res.body.includes('example.com'));
  }
  for (const type of ['goals', 'handbook']) {
    const res = await handlers.getLinks(event({ query: { team: 'global', type } }));
    assert.equal(res.statusCode, 401);
  }
  // Invalid parameters still answer 401 first (no information about valid names).
  assert.equal((await handlers.getLinks(event({ query: { team: '../x', type: 'zzz' } }))).statusCode, 401);
  assert.ok(!s.ops.some(op => op.startsWith('get:')), 'storage never read for anonymous requests');
});

test('browser-side flags, roles and passwords in the request grant nothing', async () => {
  const attempts = [
    { cookie: 'unlockedTeams=["marketing"]; adminUnlocked=true' },
    { headers: { 'x-admin': 'true', 'x-team': 'marketing', authorization: 'Bearer anything' } },
  ];
  for (const a of attempts) {
    const res = await handlers.getLinks(event({ query: { team: 'marketing', type: 'tasks', role: 'admin' }, ...a }));
    assert.equal(res.statusCode, 401);
  }
  // Old-style request carrying the real admin password but no session.
  const res = await handlers.manage(event({ method: 'POST', body: { ...addTask('marketing'), adminPassword: TEST_ENV.PASSWORD_ADMIN, role: 'global' } }));
  assert.equal(res.statusCode, 401);
  // A member session plus a client-supplied role/password is still only a member.
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  const res2 = await c.manage({ ...addTask('marketing'), adminPassword: TEST_ENV.PASSWORD_ADMIN, role: 'admin', globalAdmin: true });
  assert.equal(res2.statusCode, 403);
  assert.equal(stores('team-links').peek('marketing_tasks').length, 1);
});

test('changing the team in the query cannot reach another team', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  for (const team of TEAMS.filter(t => t !== 'marketing')) {
    for (const type of TEAM_TYPES) {
      const res = await c.get(team, type);
      assert.equal(res.statusCode, 403, `${team}/${type}`);
      assert.ok(!res.body.includes(team + ' secret'));
    }
  }
  const own = await c.get('marketing', 'tasks');
  assert.equal(own.statusCode, 200);
  assert.deepEqual(body(own).links.map(l => l.name), ['marketing secret task list']);
});

test('only supported team/type values are accepted', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  for (const [team, type] of [['marketing', 'goals'], ['marketing', 'secrets'], ['global', 'tasks'], ['marketing_tasks', ''], ['Marketing', 'tasks'], ['marketing', 'tasks/../kpi']]) {
    assert.equal((await c.get(team, type)).statusCode, 400, `${team}/${type}`);
  }
});

test('get-links returns only the requested content, privately', async () => {
  const c = new Client();
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  const res = await c.get('seo', 'kpi');
  const b = body(res);
  assert.deepEqual(Object.keys(b).sort(), ['links', 'version']);
  assert.deepEqual(Object.keys(b.links), ['2026']);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.match(res.headers['Cache-Control'], /private/);
  assert.equal(res.headers.Vary, 'Cookie');
});

test('team members see shared goals and handbook but cannot change them or their team', async () => {
  const c = new Client();
  await c.login('video', TEST_ENV.PASSWORD_VIDEO);
  assert.equal((await c.get('global', 'goals')).statusCode, 200);
  assert.equal(body(await c.get('global', 'handbook')).links.length, 1);
  assert.equal((await c.manage(addTask('video'))).statusCode, 403);
  assert.equal((await c.manage({ action: 'set', team: 'global', type: 'goals', version: '"g1"', goalYear: '2026', yearGoal: '$0' })).statusCode, 403);
  assert.equal((await c.manage({ action: 'add', team: 'global', type: 'handbook', version: '"h1"', link: { url: 'https://example.com/hb' } })).statusCode, 403);
});

test('team admins manage only their own team', async () => {
  const c = new Client();
  await c.login('marketing', TEST_ENV.PASSWORD_MARKETING);
  const login = await c.adminLogin('marketing', TEST_ENV.PASSWORD_ADMIN_MARKETING);
  assert.deepEqual(body(login).session.adminTeams, ['marketing']);
  assert.equal(body(login).session.globalAdmin, false);

  assert.equal((await c.manage(addTask('marketing'))).statusCode, 200);
  for (const team of TEAMS.filter(t => t !== 'marketing')) {
    const res = await c.manage(addTask(team));
    assert.equal(res.statusCode, 403, team);
    assert.equal(stores('team-links').peek(`${team}_tasks`).length, 1);
  }
  // Team admin cannot change goals or the handbook.
  assert.equal((await c.manage({ action: 'set', team: 'global', type: 'goals', version: '"g1"', goalYear: '2026', yearGoal: '$0' })).statusCode, 403);
  assert.equal((await c.manage({ action: 'delete-year', team: 'global', type: 'goals', version: '"g1"', goalYear: '2026' })).statusCode, 403);
  // Nor read other teams.
  assert.equal((await c.get('seo', 'tasks')).statusCode, 403);
});

test("a team admin password typed in another team's workspace is rejected", async () => {
  const c = new Client();
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  assert.equal((await c.adminLogin('seo', TEST_ENV.PASSWORD_ADMIN_MARKETING)).statusCode, 401);
  assert.equal((await c.globalLogin(TEST_ENV.PASSWORD_ADMIN_MARKETING)).statusCode, 401);
});

test('global admins manage every team, the goals and the handbook', async () => {
  const c = new Client();
  await c.login('design', TEST_ENV.PASSWORD_DESIGN);
  const login = await c.adminLogin('design', TEST_ENV.PASSWORD_ADMIN);   // global password in a team workspace
  assert.equal(body(login).session.globalAdmin, true);
  for (const team of TEAMS) {
    assert.equal((await c.get(team, 'tasks')).statusCode, 200, team);
    assert.equal((await c.manage(addTask(team))).statusCode, 200, team);
  }
  const goals = await c.manage({ action: 'set', team: 'global', type: 'goals', version: '"g1"', goalYear: '2027', yearGoal: '$2', quarterGoal: '$1' });
  assert.equal(goals.statusCode, 200);
  assert.deepEqual(Object.keys(body(goals).goals).sort(), ['2026', '2027']);
  const hb = await c.manage({ action: 'update', team: 'global', type: 'handbook', version: '"h1"', id: 5, link: { name: 'Employee Handbook', url: 'https://docs.google.com/document/d/EXAMPLE-HANDBOOK-2/edit' } });
  assert.equal(hb.statusCode, 200);
});

test('global-admin scope login (goals prompt) works without a team session', async () => {
  const c = new Client();
  const res = await c.globalLogin(TEST_ENV.PASSWORD_ADMIN);
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).session.globalAdmin, true);
  const del = await c.manage({ action: 'delete-year', team: 'global', type: 'goals', version: '"g1"', goalYear: '2026' });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(body(del).goals, {});
});

test('team members cannot perform any administrative action', async () => {
  const c = new Client();
  await c.login('customerservice', TEST_ENV.PASSWORD_CUSTOMERSERVICE);
  for (const action of ['add', 'update', 'remove']) {
    const res = await c.manage({ action, team: 'customerservice', type: 'tasks', version: '"v1"', id: 1, link: { url: 'https://example.com/z' } });
    assert.equal(res.statusCode, 403, action);
  }
  assert.equal(stores('team-links').peek('customerservice_tasks').length, 1);
});
