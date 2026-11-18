'use strict';
// The private onboarding guide: served only to signed-in sessions, never in the public page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { TEST_ENV, resetEnv, freshStores, event, body, Client } = require('./helpers');
const { validateGuide, decodeGuideValue, resetGuideCacheForTests } = require('../netlify/lib/guide');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'guide.synthetic.json');
const getGuide = require('../netlify/functions/get-guide').handler;
const call = c => getGuide(event({ cookie: c && c.cookie, ip: c ? c.ip : '203.0.113.10' }));

test.beforeEach(() => { resetEnv({ ONBOARDING_GUIDE_FILE: FIXTURE }); freshStores(); resetGuideCacheForTests(); });
test.after(() => { delete process.env.ONBOARDING_GUIDE_FILE; });

test('signed-out requests get 401 and no guide text', async () => {
  const res = await call(null);
  assert.equal(res.statusCode, 401);
  assert.ok(!res.body.includes('Example Manager'));
  for (const cookie of ['unlockedTeams=["marketing"]', 'sbo_session=forged.value.here']) {
    const r = await getGuide(event({ cookie }));
    assert.equal(r.statusCode, 401);
    assert.ok(!r.body.includes('Example'));
  }
});

test('a team member and an admin receive the guide', async () => {
  const member = new Client();
  await member.login('design', TEST_ENV.PASSWORD_DESIGN);
  const res = await call(member);
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).guide.version, 'synthetic-1');
  assert.equal(body(res).guide.routine[0].detail[0], 'Ask **Example Manager** for an account.');
  const admin = new Client('203.0.113.11');
  await admin.globalLogin(TEST_ENV.PASSWORD_ADMIN);
  assert.equal((await call(admin)).statusCode, 200);
});

test('after logout the copied cookie no longer reads the guide', async () => {
  const c = new Client();
  await c.login('seo', TEST_ENV.PASSWORD_SEO);
  const copied = c.cookie;
  assert.equal((await call(c)).statusCode, 200);
  await c.sessionAction('logout');
  const res = await getGuide(event({ cookie: copied }));
  assert.equal(res.statusCode, 401);
});

test('a missing or invalid guide answers 503 without details', async () => {
  const c = new Client();
  await c.login('video', TEST_ENV.PASSWORD_VIDEO);
  process.env.ONBOARDING_GUIDE_FILE = path.join(os.tmpdir(), 'no-such-guide.json');
  let res = await call(c);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(body(res), { error: 'guide_not_configured' });
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbonb-')), 'guide.json');
  fs.writeFileSync(bad, JSON.stringify({ version: 'x', checklist: 'nope' }));
  process.env.ONBOARDING_GUIDE_FILE = bad;
  res = await call(c);
  assert.equal(res.statusCode, 503);
});

test('only GET is accepted', async () => {
  assert.equal((await getGuide(event({ method: 'POST', body: {} }))).statusCode, 405);
});

test('validation keeps only the known fields and bounds the sizes', () => {
  const g = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  g.extra = 'dropped'; g.benefits[0].html = '<script>';
  const v = validateGuide(g);
  assert.equal(v.extra, undefined);
  assert.equal(v.benefits[0].html, undefined);
  assert.throws(() => validateGuide({ ...g, benefits: [{ icon: 'x', title: 'y', text: 'z'.repeat(5000) }] }));
});

test('the build writes the guide from the variable (plain or gz) outside dist/', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const gz = 'gz:' + zlib.gzipSync(Buffer.from(text)).toString('base64');
  assert.equal(JSON.parse(decodeGuideValue(gz)).version, 'synthetic-1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbonb-build-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'netlify', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'netlify', 'lib', 'guide.js'), path.join(dir, 'netlify', 'lib', 'guide.js'));
  const out = execFileSync(process.execPath, ['scripts/write-private-guide.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ONBOARDING_GUIDE_JSON: gz } });
  assert.match(out, /version synthetic-1: 2 checklist items, 1 benefits, 1 routine steps/);
  assert.ok(!out.includes('Example Manager'), 'no guide text in the build log');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'netlify', 'private', 'guide.json'), 'utf8')).version, 'synthetic-1');
  const none = execFileSync(process.execPath, ['scripts/write-private-guide.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ONBOARDING_GUIDE_JSON: '' } });
  assert.match(none, /not configured/);
  assert.ok(!fs.existsSync(path.join(dir, 'netlify', 'private', 'guide.json')));
});

test('the public page carries no people, internal tools or HR terms', () => {
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(page, /\bM(?:s|r)\.\s/, 'no named staff');
  assert.doesNotMatch(page, /\bVND\b|\d+%\s*(?:share|of)|paid leave days/i, 'no HR terms or amounts');
  const visible = page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visible, /(^|\s)#[a-z0-9][a-z0-9-]{2,}/, 'no chat channel names in the page text');
  assert.match(page, /id="guide-checklist"/);
  assert.match(page, /id="guide-benefits"/);
  assert.match(page, /id="guide-routine"/);
});
