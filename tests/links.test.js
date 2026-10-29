'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TEST_ENV, resetEnv, freshStores, body, Client, captureConsole } = require('./helpers');
const { checkLinkUrl } = require('../netlify/lib/validate');
const { runImport } = require('../scripts/lib/import-core');

let stores;
test.beforeEach(() => { resetEnv(); stores = freshStores(); });

async function admin(team = 'marketing') {
  const c = new Client();
  await c.login(team, TEST_ENV[`PASSWORD_${team.toUpperCase()}`]);
  await c.adminLogin(team, TEST_ENV[`PASSWORD_ADMIN_${team.toUpperCase()}`]);
  return c;
}
async function globalAdmin() {
  const c = new Client('203.0.113.99');
  await c.globalLogin(TEST_ENV.PASSWORD_ADMIN);
  return c;
}
const put = (key, value, etag = '"seed"') => stores('team-links').map.set(key, { body: JSON.stringify(value), etag });

test('unsafe link destinations are rejected', async () => {
  const bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)', 'file:///etc/passwd', 'http://docs.google.com/document/d/EXAMPLE/edit', 'ftp://example.com/a',
    'https://user:pass@example.com/', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://intranet/x',
    'https://printer.local/x', 'https://example.com:8443/x', 'https://exa mple.com/', 'https://example.com/\u0000',
    '//example.com/x', '/relative', 'https://' + 'a'.repeat(2050) + '.com',
  ];
  for (const url of bad) assert.equal(checkLinkUrl(url).ok, false, url);
  const good = [
    'https://docs.google.com/document/d/EXAMPLE-ID/edit?tab=t.0',
    'https://drive.google.com/drive/folders/EXAMPLE-FOLDER',
    'https://docs.google.com/spreadsheets/d/EXAMPLE-SHEET/edit#gid=0',
    'https://app.example-tool.com/dashboard',
  ];
  for (const url of good) assert.equal(checkLinkUrl(url).ok, true, url);

  const c = await admin();
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com']) {
    const res = await c.manage({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { name: 'x', url } });
    assert.equal(res.statusCode, 400, url);
  }
  assert.equal(stores('team-links').peek('marketing_tasks'), undefined);
});

test('LINK_ALLOWED_HOSTS enforces an explicit destination allowlist when set', async () => {
  resetEnv({ LINK_ALLOWED_HOSTS: 'google.com, .example-tool.com' });
  assert.equal(checkLinkUrl('https://docs.google.com/document/d/EXAMPLE/edit').ok, true);
  assert.equal(checkLinkUrl('https://app.example-tool.com/x').ok, true);
  assert.equal(checkLinkUrl('https://evilgoogle.com/x').ok, false);
  assert.equal(checkLinkUrl('https://example.org/x').ok, false);
});

test('field lengths, ids, years and goal labels are validated', async () => {
  const c = await admin();
  const base = { team: 'marketing', version: '' };
  const cases = [
    { ...base, action: 'add', type: 'tasks', link: { name: 'x'.repeat(301), url: 'https://example.com' } },
    { ...base, action: 'add', type: 'tasks', link: { name: 'tab\there', url: 'https://example.com' } },
    { ...base, action: 'add', type: 'tasks', link: 'https://example.com' },
    { ...base, action: 'add', type: 'kpi', year: '26', link: { url: 'https://example.com' } },
    { ...base, action: 'add', type: 'kpi', year: '__proto__', link: { url: 'https://example.com' } },
    { ...base, action: 'remove', type: 'tasks', id: '1' },
    { ...base, action: 'remove', type: 'tasks', id: 1.5 },
    { ...base, action: 'explode', type: 'tasks' },
    { ...base, action: 'add', type: 'tasks', version: undefined, link: { url: 'https://example.com' } },
  ];
  for (const p of cases) {
    const res = await c.manage(p);
    assert.equal(res.statusCode, 400, JSON.stringify(p).slice(0, 80));
  }
  const g = await globalAdmin();
  for (const goalYear of ['__proto__', 'constructor', '', '<img src=x>', "2026');alert(1);//", 'x'.repeat(31)]) {
    const res = await g.manage({ action: 'set', team: 'global', type: 'goals', version: '', goalYear, yearGoal: '$1' });
    assert.equal(res.statusCode, 400, goalYear);
  }
  const tooMany = await g.manage({ action: 'set', team: 'global', type: 'goals', version: '', goalYear: '2026', monthlyGoals: Array(40).fill({ month: 'Jan', goal: '$1' }) });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});

test('stored-script payloads in names and goals are stored as plain text (rendering is escaped)', async () => {
  const c = await admin();
  const payload = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>';
  const res = await c.manage({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { name: payload, url: 'https://example.com/xss' } });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).links[0].name, payload);
  assert.match(res.headers['Content-Type'], /application\/json/);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('versioned writes: a stale editor gets 409 and the current data, nothing is lost', async () => {
  const a = await admin();
  const b = await globalAdmin();
  const v0 = body(await a.get('marketing', 'eos')).version;
  assert.equal(v0, '');
  // Admin A adds.
  const r1 = await a.manage({ action: 'add', team: 'marketing', type: 'eos', version: v0, link: { name: 'A', url: 'https://example.com/a' } });
  assert.equal(r1.statusCode, 200);
  // Admin B (still on the old version) adds — must not overwrite A's addition.
  const r2 = await b.manage({ action: 'add', team: 'marketing', type: 'eos', version: v0, link: { name: 'B', url: 'https://example.com/b' } });
  assert.equal(r2.statusCode, 409);
  assert.equal(body(r2).error, 'conflict');
  assert.deepEqual(body(r2).links.map(l => l.name), ['A']);
  // B reloads (uses returned version) and retries successfully.
  const r3 = await b.manage({ action: 'add', team: 'marketing', type: 'eos', version: body(r2).version, link: { name: 'B', url: 'https://example.com/b' } });
  assert.equal(r3.statusCode, 200);
  assert.deepEqual(stores('team-links').peek('marketing_eos').map(l => l.name), ['A', 'B']);
});

test('a write racing between read and write is refused by the conditional write', async () => {
  const c = await admin();
  put('marketing_tools', [{ id: 1, name: 'Tool', url: 'https://example.com/t' }], '"t1"');
  const store = stores('team-links');
  const realSet = store.setJSON.bind(store);
  let injected = false;
  store.setJSON = async (key, data, opts) => {
    if (!injected && key === 'marketing_tools') {
      injected = true;   // another admin writes first
      await realSet(key, [{ id: 1, name: 'Tool', url: 'https://example.com/t' }, { id: 2, name: 'Other admin', url: 'https://example.com/o' }]);
    }
    return realSet(key, data, opts);
  };
  const res = await c.manage({ action: 'add', team: 'marketing', type: 'tools', version: '"t1"', link: { name: 'Mine', url: 'https://example.com/m' } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(body(res).links.map(l => l.name), ['Tool', 'Other admin']);
  assert.deepEqual(store.peek('marketing_tools').map(l => l.name), ['Tool', 'Other admin']);
});

test('a conditional write that the backend did not apply is never reported as saved', async () => {
  // @netlify/blobs returns { modified: true } (no etag) for any non-412 failure.
  const c = await admin();
  put('marketing_tools', [{ id: 1, name: 'Tool', url: 'https://example.com/t' }], '"t1"');
  const store = stores('team-links');
  const realSet = store.setJSON.bind(store);
  store.setJSON = async () => ({ modified: true });     // e.g. a 403/500 from storage
  const cap = captureConsole();
  let res;
  try {
    res = await c.manage({ action: 'add', team: 'marketing', type: 'tools', version: '"t1"', link: { name: 'Mine', url: 'https://example.com/m' } });
  } finally { cap.restore(); store.setJSON = realSet; }
  assert.equal(res.statusCode, 500);
  assert.equal(body(res).success, false);
  assert.deepEqual(store.peek('marketing_tools').map(l => l.name), ['Tool']);
});

test('retrying an add is safe (no duplicates)', async () => {
  const c = await admin();
  const p = { action: 'add', team: 'marketing', type: 'tasks', version: '', link: { name: 'Doc', url: 'https://example.com/doc' } };
  const first = await c.manage(p);
  assert.equal(first.statusCode, 200);
  const retry = await c.manage(p);                     // response lost, client retries with old version
  assert.equal(retry.statusCode, 409);
  const again = await c.manage({ ...p, version: body(first).version });   // even with the new version
  assert.equal(again.statusCode, 409);
  assert.equal(body(again).error, 'duplicate');
  assert.equal(stores('team-links').peek('marketing_tasks').length, 1);
});

test('existing data shapes, ids, order and extra fields survive every operation', async () => {
  const flat = [
    { id: 1716800000000, name: 'Task list', url: 'https://docs.google.com/document/d/EXAMPLE-1/edit', note: 'kept' },
    { id: 1716800000001, name: 'Second', url: 'https://docs.google.com/document/d/EXAMPLE-2/edit' },
  ];
  const kpi = { 2025: [{ id: 10, name: 'Old KPI', url: 'https://example.com/k25' }], 2026: [{ id: 11, name: 'KPI', url: 'https://example.com/k26' }] };
  const goals = {
    2026: { yearGoal: '$1,000', quarterGoal: '$250', monthlyGoals: [{ month: 'January 2026', goal: '$80' }], brandGoals: [], channelGoals: [{ channel: 'Web', yearGoal: '$5', quarterGoal: '', monthlyGoal: '' }] },
    yearGoal: 'legacy top-level value',
  };
  put('seo_tasks', flat, '"a"');
  put('seo_kpi', kpi, '"b"');
  put('global_goals', goals, '"c"');

  const c = await admin('seo');
  const g = await globalAdmin();
  // Read shapes are unchanged.
  assert.deepEqual(body(await c.get('seo', 'tasks')).links, flat);
  assert.deepEqual(body(await c.get('seo', 'kpi')).links, kpi);
  assert.deepEqual(body(await c.get('global', 'goals')).links, goals);

  // Update keeps id, position and extra fields.
  let r = await c.manage({ action: 'update', team: 'seo', type: 'tasks', version: '"a"', id: 1716800000000, link: { name: 'Renamed', url: 'https://docs.google.com/document/d/EXAMPLE-1b/edit' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stores('team-links').peek('seo_tasks')[0], { id: 1716800000000, name: 'Renamed', url: 'https://docs.google.com/document/d/EXAMPLE-1b/edit', note: 'kept' });
  assert.equal(stores('team-links').peek('seo_tasks')[1].id, 1716800000001);

  // KPI add to a new year keeps other years; ids stay unique.
  r = await c.manage({ action: 'add', team: 'seo', type: 'kpi', version: '"b"', year: '2027', link: { name: 'Next', url: 'https://example.com/k27' } });
  assert.equal(r.statusCode, 200);
  const k = stores('team-links').peek('seo_kpi');
  assert.deepEqual(Object.keys(k).sort(), ['2025', '2026', '2027']);
  assert.deepEqual(k['2025'], kpi['2025']);
  assert.ok(k['2027'][0].id > 11);
  // KPI remove only touches its year.
  r = await c.manage({ action: 'remove', team: 'seo', type: 'kpi', version: body(r).version, year: '2025', id: 10 });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stores('team-links').peek('seo_kpi')['2026'], kpi['2026']);
  // Removing a missing id reports not_found without writing.
  r = await c.manage({ action: 'remove', team: 'seo', type: 'kpi', version: body(r).version, year: '2025', id: 10 });
  assert.equal(r.statusCode, 404);

  // Goals set keeps other years and unknown legacy keys.
  r = await g.manage({ action: 'set', team: 'global', type: 'goals', version: '"c"', goalYear: 'FY2027', yearGoal: '$2,000', monthlyGoals: [{ month: 'Jan', goal: '$1' }] });
  assert.equal(r.statusCode, 200);
  const sg = stores('team-links').peek('global_goals');
  assert.deepEqual(sg['2026'], goals['2026']);
  assert.equal(sg.yearGoal, 'legacy top-level value');
  assert.deepEqual(sg.FY2027, { yearGoal: '$2,000', quarterGoal: '', monthlyGoals: [{ month: 'Jan', goal: '$1' }], brandGoals: [], channelGoals: [] });
});

test('unexpected stored shapes are reported, never overwritten', async () => {
  put('design_tasks', { not: 'a list' }, '"x"');
  const c = await admin('design');
  const r = await c.manage({ action: 'add', team: 'design', type: 'tasks', version: '"x"', link: { url: 'https://example.com/a' } });
  assert.equal(r.statusCode, 409);
  assert.equal(body(r).error, 'unexpected_data');
  assert.deepEqual(stores('team-links').peek('design_tasks'), { not: 'a list' });
});

test('private import is add-only, keeps ids and never overwrites existing records', async () => {
  const store = stores('team-links');
  put('global_handbook', [{ id: 7, name: 'Existing', url: 'https://docs.google.com/document/d/EXAMPLE-OLD/edit' }], '"h"');
  put('marketing_kpi', { 2026: [{ id: 3, name: 'K', url: 'https://example.com/k' }] }, '"k"');
  const doc = { entries: [
    { team: 'global', type: 'handbook', links: [
      { name: 'Existing again', url: 'https://docs.google.com/document/d/EXAMPLE-OLD/edit' },
      { id: 42, name: 'Employee Handbook', url: 'https://docs.google.com/document/d/EXAMPLE-NEW/edit' },
      { name: 'bad', url: 'javascript:alert(1)' },
    ] },
    { team: 'marketing', type: 'kpi', year: '2026', links: [{ id: 3, name: 'Clashing id', url: 'https://example.com/k2' }] },
    { team: 'video', type: 'tools', links: [{ name: 'Tool', url: 'https://example.com/tool' }] },
  ] };
  const logs = [];
  const dry = await runImport(store, doc, { apply: false, log: l => logs.push(l) });
  assert.equal(store.peek('global_handbook').length, 1, 'dry run writes nothing');
  assert.equal(store.peek('video_tools'), undefined);
  assert.deepEqual(dry.map(d => d.added), [1, 1, 1]);
  assert.ok(logs.every(l => !l.includes('EXAMPLE-NEW')), 'logs show hosts, not document ids');

  await runImport(store, doc, { apply: true, log: () => {} });
  const hb = store.peek('global_handbook');
  assert.deepEqual(hb[0], { id: 7, name: 'Existing', url: 'https://docs.google.com/document/d/EXAMPLE-OLD/edit' });
  assert.deepEqual(hb[1], { id: 42, name: 'Employee Handbook', url: 'https://docs.google.com/document/d/EXAMPLE-NEW/edit' });
  assert.equal(hb.length, 2);
  const k = store.peek('marketing_kpi')['2026'];
  assert.equal(k[0].id, 3);
  assert.notEqual(k[1].id, 3, 'clashing id replaced with a fresh one');
  assert.equal(store.peek('video_tools').length, 1);

  // Running again adds nothing.
  const again = await runImport(store, doc, { apply: true, log: () => {} });
  assert.deepEqual(again.map(d => d.added), [0, 0, 0]);

  // Goals cannot be imported through this path.
  await assert.rejects(runImport(store, { entries: [{ team: 'global', type: 'goals', links: [] }] }, { log: () => {} }));
});
