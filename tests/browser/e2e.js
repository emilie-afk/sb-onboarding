'use strict';
// End-to-end browser checks against the local dev server running the real
// function handlers with synthetic credentials and an in-memory store.
//   node tests/browser/e2e.js [screenshot-prefix]

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { resetEnv, TEST_ENV } = require('../helpers');
resetEnv();
const { createServer } = require('../../scripts/dev-server');
const { memoryStoreFactory } = require('../../scripts/lib/memory-store');

const shotPrefix = process.argv[2] || null;
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

const factory = memoryStoreFactory();
const server = createServer({ factory });
let BASE;

function seed() {
  for (const s of factory.stores.values()) s.map.clear();
  const links = factory('team-links');
  const put = (k, v) => links.map.set(k, { body: JSON.stringify(v), etag: '"seed-' + k + '"' });
  for (const t of ['marketing', 'customerservice', 'seo', 'design', 'video']) {
    for (const type of ['tasks', 'eos', 'handover', 'tools']) put(`${t}_${type}`, [{ id: 100, name: `${t} ${type} doc`, url: `https://example.com/${t}/${type}` }]);
    put(`${t}_kpi`, { 2026: [{ id: 200, name: `${t} KPI`, url: `https://example.com/${t}/kpi` }] });
  }
  put('global_goals', { 2026: { yearGoal: '$1,000', quarterGoal: '$250', monthlyGoals: [{ month: 'January 2026', goal: '$80' }], brandGoals: [], channelGoals: [] } });
  put('global_handbook', [{ id: 1, name: 'Employee Handbook', url: 'https://docs.google.com/document/d/EXAMPLE-HANDBOOK/edit' }]);
}

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', async d => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'prompt') await d.accept(page.__promptAnswer || '');
    else await d.accept();
  });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  return { ctx, page, errors, dialogs };
}

const visible = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && el.offsetHeight > 0; }, sel);
async function teamLogin(page, name, pw) {
  await page.click(`.team-card:has(h3:text-is("${name}"))`);
  await page.fill('#team-password', pw);
  await page.click('#unlock-btn');
  await page.waitForTimeout(250);
}
async function adminLogin(page, pw) {
  await page.click('#tasks-admin-area .admin-unlock-btn');
  await page.fill('#admin-input', pw);
  await page.click('#admin-unlock-btn');
  await page.waitForTimeout(300);
}
const text = (page, sel) => page.textContent(sel);
const tab = async (page, t) => { await page.click(`.tab-nav button[onclick*="'${t}'"]`); await page.waitForTimeout(150); };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    // 1. Anonymous visitor
    seed();
    { const { ctx, page, errors } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await page.waitForTimeout(300);
      ok('Anonymous: goals locked', await visible(page, '#goals-locked') && !(await visible(page, '#goals-display')));
      const direct = await page.evaluate(async () => {
        const r = await fetch('/.netlify/functions/get-links?team=marketing&type=tasks');
        const g = await fetch('/.netlify/functions/get-links?team=global&type=goals');
        return [r.status, g.status, await r.text()];
      });
      ok('Anonymous: direct API calls → 401, no data', direct[0] === 401 && direct[1] === 401 && !direct[2].includes('example.com'), JSON.stringify(direct.slice(0, 2)));
      await page.click('.journey-step[data-page="handbook"]').catch(() => page.goto(BASE + '/#handbook'));
      await page.waitForTimeout(200);
      const hb = await text(page, '#handbook-links');
      ok('Anonymous: handbook link hidden', hb.includes('Unlock your team section') && !(await page.$('#handbook-links a.handbook-card')));
      const html = await page.content();
      ok('Anonymous: page source has no internal document link', !/docs\.google\.com\/document\/d\/(?!EXAMPLE)/.test(html));
      ok('Anonymous: no JS/CSP errors', errors.length === 0, errors.join(' | '));
      await ctx.close(); }

    // 2. Browser-only flags grant nothing (and old values are cleared)
    { const { ctx, page } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await page.evaluate(() => { sessionStorage.setItem('unlockedTeams', '["marketing"]'); sessionStorage.setItem('adminUnlocked', 'true'); sessionStorage.setItem('adminPassword', 'old'); });
      await page.reload(); await page.waitForTimeout(300);
      await page.click('.team-card:has(h3:text-is("Marketing"))'); await page.waitForTimeout(200);
      const cleared = await page.evaluate(() => ['unlockedTeams', 'adminUnlocked', 'adminPassword'].every(k => sessionStorage.getItem(k) === null));
      ok('Browser flags: modal still required, goals locked', await visible(page, '#team-modal.open') && await visible(page, '#goals-locked'));
      ok('Browser flags: legacy sessionStorage auth cleared', cleared);
      await page.evaluate(() => { unlockedTeams = ['seo']; adminUnlocked = true; });   // tamper with page variables
      const forced = await page.evaluate(async () => (await fetch('/.netlify/functions/get-links?team=seo&type=tasks')).status);
      ok('Browser flags: tampered page state still gets 401 from server', forced === 401);
      await ctx.close(); }

    // 3. Team login, cookie, tabs, restoration, handbook
    seed();
    { const { ctx, page, errors } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await teamLogin(page, 'Marketing', 'wrong');
      ok('Team: wrong password → Incorrect', (await text(page, '#form-note')).includes('Incorrect password'));
      await page.fill('#team-password', TEST_ENV.PASSWORD_MARKETING); await page.click('#unlock-btn'); await page.waitForTimeout(300);
      ok('Team: correct password opens workspace with stored links', (await text(page, '#team-name-heading')) === 'Marketing Team' && (await text(page, '#tasks-links-list')).includes('marketing tasks doc'));
      const cookies = await ctx.cookies();
      const sc = cookies.find(c => c.name === '__Host-sbonb');
      ok('Team: session cookie is HttpOnly + Secure + SameSite=Strict', !!sc && sc.httpOnly && sc.secure && sc.sameSite === 'Strict', JSON.stringify(sc && { h: sc.httpOnly, s: sc.secure, ss: sc.sameSite }));
      ok('Team: cookie not readable by page script', !(await page.evaluate(() => document.cookie)).includes('sbonb'));
      let allTabs = true;
      for (const [t, sel, needle] of [['eos', '#eos-links-list', 'eos doc'], ['kpi', '#kpi-years-container', 'KPI'], ['handover', '#handover-links-list', 'handover doc'], ['tools', '#tools-links-list', 'tools doc']]) {
        await tab(page, t); if (!(await text(page, sel)).includes(needle)) allTabs = false;
      }
      ok('Team: all tabs load', allTabs);
      ok('Team: KPI year groupings kept', (await text(page, '#kpi-years-container')).includes('2026') && (await text(page, '#kpi-years-container')).includes('2027'));
      await page.click('.team-back'); await page.waitForTimeout(300);
      ok('Team: goals visible after unlock', await visible(page, '#goals-display') && (await text(page, '#goals-years-container')).includes('$1,000'));
      const other = await page.evaluate(async () => (await fetch('/.netlify/functions/get-links?team=seo&type=tasks')).status);
      ok('Team: changing the team in the query → 403', other === 403);
      // Restoration after reload
      await page.reload(); await page.waitForTimeout(400);
      await page.click('.team-card:has(h3:text-is("Marketing"))'); await page.waitForTimeout(300);
      ok('Restore: reload keeps team unlocked (no modal)', await visible(page, '#team-page') && !(await visible(page, '#team-modal.open')));
      await page.click('.journey-step[data-page="handbook"]'); await page.waitForTimeout(300);
      const hbHref = await page.getAttribute('#handbook-links a.handbook-card', 'href').catch(() => null);
      ok('Restore: handbook card opens the stored link', hbHref === 'https://docs.google.com/document/d/EXAMPLE-HANDBOOK/edit' && (await text(page, '#handbook-links')).includes('Open Employee Handbook'));
      const rel = await page.getAttribute('#handbook-links a.handbook-card', 'rel');
      ok('Restore: external link uses noopener noreferrer', rel === 'noopener noreferrer');
      ok('Team: no JS/CSP errors', errors.length === 0, errors.join(' | '));
      // Logout
      await page.click('.journey-step[data-page="teams"]'); await page.waitForTimeout(300);
      const before = (await ctx.cookies()).find(c => c.name === '__Host-sbonb');
      await page.click('#goals-signout-btn'); await page.waitForTimeout(300);
      ok('Logout: goals locked again', await visible(page, '#goals-locked'));
      await page.click('.team-card:has(h3:text-is("Marketing"))'); await page.waitForTimeout(200);
      ok('Logout: team requires password again', await visible(page, '#team-modal.open'));
      const replay = await fetch(BASE + '/.netlify/functions/get-links?team=marketing&type=tasks', { headers: { cookie: `${before.name}=${before.value}` } });
      ok('Logout: old cookie rejected by server', replay.status === 401);
      await ctx.close(); }

    // 4. Team admin scope, safe rendering, update keeps position
    seed();
    const links = factory('team-links');
    links.map.set('marketing_tools', { body: JSON.stringify([
      { id: 1, name: '<img src=x onerror=alert("xss-name")>', url: 'https://example.com/ok' },
      { id: 2, name: 'Bad scheme', url: 'javascript:alert("xss-url")' },
      { id: 3, name: 'Third', url: 'https://example.com/third' },
    ]), etag: '"t"' });
    links.map.set('global_goals', { body: JSON.stringify({ "x');alert('xss-goal');//": { yearGoal: '<b onmouseover=alert(1)>$5</b>' }, '2026': { yearGoal: '$1' } }), etag: '"g"' });
    { const { ctx, page, errors, dialogs } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await teamLogin(page, 'Marketing', TEST_ENV.PASSWORD_MARKETING);
      await tab(page, 'tools');
      const toolsHtml = await page.innerHTML('#tools-links-list');
      ok('XSS: name rendered as text, no element injected', !(await page.$('#tools-links-list img')) && (await text(page, '#tools-links-list')).includes('<img src=x'));
      ok('XSS: javascript: link not clickable, marked for review', !toolsHtml.includes('javascript:') && (await text(page, '#tools-links-list')).includes('(link needs review)'));
      await page.click('.team-back'); await page.waitForTimeout(300);
      ok('XSS: malicious goal year/value shown as text', (await text(page, '#goals-years-container')).includes("x');alert('xss-goal');//") && !(await page.$('#goals-years-container b')));
      await page.hover('#goals-years-container .goal-value').catch(() => {});
      await page.click('.team-card:has(h3:text-is("Marketing"))'); await page.waitForTimeout(250);
      await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_MARKETING);
      ok('Team admin: admin mode active', !!(await page.$('#tasks-admin-area .admin-badge')));
      await tab(page, 'tools');
      // Add an unsafe URL → rejected with message
      await page.fill('#tools-new-name', 'Evil'); await page.fill('#tools-new-url', 'javascript:alert(1)'); await page.click('#tab-tools .btn-add'); await page.waitForTimeout(250);
      ok('Admin: unsafe URL rejected with message', dialogs.some(d => d.message.includes('https://')) && !(await text(page, '#tools-links-list')).includes('Evil'));
      // Add a good link
      await page.fill('#tools-new-name', 'New tool'); await page.fill('#tools-new-url', 'https://example.com/newtool'); await page.click('#tab-tools .btn-add'); await page.waitForTimeout(250);
      ok('Admin: add link', (await text(page, '#tools-links-list')).includes('New tool') && (await page.inputValue('#tools-new-url')) === '');
      // Edit the third card (update keeps position and id)
      await page.click('#tools-links-list .drive-card[data-id="3"] .drive-edit-btn');
      await page.fill('#tools-links-list .drive-card[data-id="3"] .edit-name', 'Third renamed');
      await page.click('#tools-links-list .drive-card[data-id="3"] .edit-save-btn'); await page.waitForTimeout(250);
      const order = await page.$$eval('#tools-links-list .drive-card', cs => cs.map(c => c.dataset.id));
      const stored = links.peek('marketing_tools');
      ok('Admin: edit keeps id and position', order[2] === '3' && stored[2].id === 3 && stored[2].name === 'Third renamed', order.join(','));
      // Remove
      await page.click('#tools-links-list .drive-card[data-id="3"] .drive-remove-btn'); await page.waitForTimeout(250);
      ok('Admin: remove link', !(await text(page, '#tools-links-list')).includes('Third renamed') && links.peek('marketing_tools').length === 3);
      // KPI add for 2027
      await tab(page, 'kpi');
      await page.selectOption('#kpi-new-year', '2027'); await page.fill('#kpi-new-name', 'KPI 2027'); await page.fill('#kpi-new-url', 'https://example.com/k27');
      await page.click('#tab-kpi .btn-add'); await page.waitForTimeout(250);
      ok('Admin: KPI add into year group', Object.keys(links.peek('marketing_kpi')).sort().join() === '2026,2027' && (await text(page, '#kpi-years-container')).includes('KPI 2027'));
      // Team admin can't manage another team
      await page.click('.team-back'); await page.waitForTimeout(300);
      await teamLogin(page, 'SEO', TEST_ENV.PASSWORD_SEO);
      ok('Team admin: admin mode not carried to another team', !(await page.$('#tasks-admin-area .admin-badge')));
      await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_MARKETING);
      ok("Team admin: own admin password rejected in another team's workspace", (await text(page, '#admin-note')).includes('Incorrect admin password'));
      await page.click('#cancel-admin');
      const forced = await page.evaluate(async () => (await fetch('/.netlify/functions/manage-links', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SB-Onboarding': '1' }, body: JSON.stringify({ action: 'add', team: 'seo', type: 'tasks', version: '"seed-seo_tasks"', link: { url: 'https://example.com/forced' } }) })).status);
      ok('Team admin: direct API write to another team → 403', forced === 403);
      const noCsrf = await page.evaluate(async () => (await fetch('/.netlify/functions/manage-links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', team: 'marketing', type: 'tasks', version: '', link: { url: 'https://example.com/x' } }) })).status);
      ok('CSRF: write without CSRF header → 403', noCsrf === 403);
      ok('XSS: no script dialogs fired', !dialogs.some(d => /xss/.test(d.message)), JSON.stringify(dialogs.map(d => d.message)));
      ok('Admin flow: no JS/CSP errors', errors.length === 0, errors.join(' | '));
      if (shotPrefix) await page.screenshot({ path: shotPrefix + '-desktop.png' });
      await ctx.close(); }

    // 5. Lock admin / leaving workspace ends admin access on the server
    seed();
    { const { ctx, page } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await teamLogin(page, 'Design', TEST_ENV.PASSWORD_DESIGN);
      await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_DESIGN);
      await page.click('#tasks-admin-area .admin-badge button'); await page.waitForTimeout(300);
      const s1 = await page.evaluate(async () => (await fetch('/.netlify/functions/session')).json());
      ok('Lock: server admin access removed, team access kept', s1.adminTeams.length === 0 && s1.teams.includes('design'));
      await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_DESIGN);
      await page.click('.team-back'); await page.waitForTimeout(300);
      const s2 = await page.evaluate(async () => (await fetch('/.netlify/functions/session')).json());
      ok('Leaving workspace ends admin access', s2.adminTeams.length === 0 && !s2.globalAdmin);
      await ctx.close(); }

    // 6. Global admin: goals edit + delete via prompt, conflict between two admins
    seed();
    { const A = await newPage(browser); const B = await newPage(browser);
      for (const P of [A, B]) {
        await P.page.goto(BASE + '/#teams');
        await teamLogin(P.page, 'Video', TEST_ENV.PASSWORD_VIDEO);
        await P.page.click('.team-back'); await P.page.waitForTimeout(300);
        P.page.__promptAnswer = TEST_ENV.PASSWORD_ADMIN;
      }
      // A edits 2026 and saves
      await A.page.click('[data-goal-action="edit"][data-goal-year="2026"]'); await A.page.waitForTimeout(300);
      ok('Goals: global password prompt opens editor', await visible(A.page, '#goals-edit-form'));
      // B opens editor at the same time
      await B.page.click('[data-goal-action="edit"][data-goal-year="2026"]'); await B.page.waitForTimeout(300);
      await A.page.fill('#goal-year-input', '$2,000'); await A.page.click('#goals-edit-form .goals-save-btn'); await A.page.waitForTimeout(300);
      ok('Goals: save by admin A', (await text(A.page, '#goals-years-container')).includes('$2,000') && !(await visible(A.page, '#goals-edit-form')));
      await B.page.fill('#goal-quarter-input', '$999'); await B.page.click('#goals-edit-form .goals-save-btn'); await B.page.waitForTimeout(300);
      const stored = factory('team-links').peek('global_goals');
      ok('Conflict: admin B gets conflict message, A\'s change not lost', B.dialogs.some(d => d.message.includes('Someone else changed the revenue goals')) && stored['2026'].yearGoal === '$2,000' && stored['2026'].quarterGoal === '$250');
      ok('Conflict: B keeps edits in the form', await visible(B.page, '#goals-edit-form') && (await B.page.inputValue('#goal-quarter-input')) === '$999');
      await B.page.click('#goals-edit-form .goals-save-btn'); await B.page.waitForTimeout(300);
      ok('Conflict: B saves after reviewing', factory('team-links').peek('global_goals')['2026'].quarterGoal === '$999');
      const sA = await A.page.evaluate(async () => (await fetch('/.netlify/functions/session')).json());
      ok('Goals: global admin access ends after saving', !sA.globalAdmin && sA.teams.includes('video'));
      // Wrong global password
      A.page.__promptAnswer = 'wrong';
      await A.page.click('#goals-edit-btn'); await A.page.waitForTimeout(300);
      ok('Goals: wrong global password → message, no editor', A.dialogs.some(d => d.message === 'Incorrect admin password.') && !(await visible(A.page, '#goals-edit-form')));
      // Delete year
      A.page.__promptAnswer = TEST_ENV.PASSWORD_ADMIN;
      await A.page.reload(); await A.page.waitForTimeout(400); await A.page.click('.journey-step[data-page="teams"]'); await A.page.waitForTimeout(300);
      await A.page.click('[data-goal-action="delete"][data-goal-year="2026"]'); await A.page.waitForTimeout(400);
      ok('Goals: delete year', !('2026' in factory('team-links').peek('global_goals')) && (await text(A.page, '#goals-years-container')).includes('No goals set yet'));
      // Team-admin conflict on links
      seed();
      for (const P of [A, B]) {
        await P.page.click('.team-card:has(h3:text-is("Video"))'); await P.page.waitForTimeout(250);
        await adminLogin(P.page, TEST_ENV.PASSWORD_ADMIN_VIDEO);
        await tab(P.page, 'eos');
      }
      await A.page.fill('#eos-new-name', 'From A'); await A.page.fill('#eos-new-url', 'https://example.com/a'); await A.page.click('#tab-eos .btn-add'); await A.page.waitForTimeout(250);
      await B.page.fill('#eos-new-name', 'From B'); await B.page.fill('#eos-new-url', 'https://example.com/b'); await B.page.click('#tab-eos .btn-add'); await B.page.waitForTimeout(250);
      const afterConflict = factory('team-links').peek('video_eos').map(l => l.name);
      ok('Link conflict: B warned and sees A\'s file; nothing overwritten', B.dialogs.some(d => d.message.includes('Someone else changed these files')) && (await text(B.page, '#eos-links-list')).includes('From A') && afterConflict.join() === 'video eos doc,From A');
      await B.page.click('#tab-eos .btn-add'); await B.page.waitForTimeout(250);
      ok('Link conflict: B retries successfully', factory('team-links').peek('video_eos').map(l => l.name).join() === 'video eos doc,From A,From B');
      await A.ctx.close(); await B.ctx.close(); }

    // 7. Session expiry while in a workspace
    seed();
    { const { ctx, page } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await teamLogin(page, 'SEO', TEST_ENV.PASSWORD_SEO);
      process.env.SESSION_NOT_BEFORE = new Date(Date.now() + 2000).toISOString();   // server-side invalidation
      await tab(page, 'eos');
      ok('Expiry: workspace shows session-expired message', (await text(page, '#eos-links-list')).includes('session has expired') && (await text(page, '#workspace-error')).includes('expired'));
      await page.click('.team-back'); await page.waitForTimeout(300);
      await page.click('.team-card:has(h3:text-is("SEO"))'); await page.waitForTimeout(200);
      ok('Expiry: password required again', await visible(page, '#team-modal.open'));
      delete process.env.SESSION_NOT_BEFORE;
      await page.fill('#team-password', TEST_ENV.PASSWORD_SEO); await page.click('#unlock-btn'); await page.waitForTimeout(300);
      ok('Expiry: logging in again restores the workspace', (await text(page, '#tasks-links-list')).includes('seo tasks doc') && !(await page.$('#workspace-error')));
      await ctx.close(); }

    // 8. Durable login limit message
    seed();
    { const { ctx, page } = await newPage(browser);
      await page.goto(BASE + '/#teams');
      await page.click('.team-card:has(h3:text-is("Customer Service"))');
      for (let i = 0; i < 11; i++) { await page.fill('#team-password', 'wrong' + i); await page.click('#unlock-btn'); await page.waitForTimeout(80); }
      ok('Login limit: friendly too-many-attempts message', (await text(page, '#form-note')).includes('Too many incorrect attempts'));
      await ctx.close(); }

    // 10. Revocation failures are visible, retryable, and never shown as success
    {
      // fault: { action, mode: 'abort'|'500'|'delay', ms }  — applies to session POSTs
      async function faultyPage() {
        const P = await newPage(browser);
        P.fault = null;
        await P.page.route('**/.netlify/functions/session', async route => {
          const req = route.request();
          let action = null;
          try { action = JSON.parse(req.postData() || '{}').action; } catch {}
          const f = P.fault;
          if (req.method() === 'POST' && f && f.action === action) {
            if (f.mode === 'abort') return route.abort('failed');
            if (f.mode === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":"server_error"}' });
            if (f.mode === 'html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy page</html>' });
            if (f.mode === 'delay') { await new Promise(r => setTimeout(r, f.ms)); }
          }
          return route.continue();
        });
        return P;
      }
      const rawCookie = async ctx => ((await ctx.cookies()).find(c => c.name === '__Host-sbonb') || {}).value;
      // Authorized replays get 409 (stale version, nothing written); revoked ones 401.
      const replayAdmin = (cookie, team) => fetch(BASE + '/.netlify/functions/manage-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sb-onboarding': '1', origin: BASE, cookie: '__Host-sbonb=' + cookie },
        body: JSON.stringify({ action: 'add', team, type: 'tasks', version: 'stale-version', link: { url: 'https://example.com/replay' } }),
      }).then(r => r.status);
      const replayRead = (cookie, team) => fetch(BASE + `/.netlify/functions/get-links?team=${team}&type=tasks`, { headers: { cookie: '__Host-sbonb=' + cookie } }).then(r => r.status);
      const alertText = page => page.evaluate(() => document.getElementById('session-alert')?.textContent || '');
      const retry = async page => { await page.click('#session-alert .session-alert-retry'); await page.waitForTimeout(350); };
      const serverSession = page => page.evaluate(async () => (await fetch('/.netlify/functions/session')).json());

      for (const mode of ['abort', '500']) {
        seed();
        const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'Design', TEST_ENV.PASSWORD_DESIGN);
        await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_DESIGN);
        const adminCookie = await rawCookie(ctx);
        P.fault = { action: 'end-admin', mode };
        await page.click('#tasks-admin-area .admin-badge button'); await page.waitForTimeout(350);
        const msg = await alertText(page);
        ok(`Lock (${mode}): failure is visible, not shown as locked on the server`, msg.includes('could not be ended on the server') && msg.includes('Retry'), msg.slice(0, 80));
        ok(`Lock (${mode}): local admin controls disabled`, !(await visible(page, '#tasks-add-form')) && (await text(page, '#tasks-admin-area')).includes('Manage files'));
        ok(`Lock (${mode}): server really still has admin (so the alert is truthful)`, (await replayAdmin(adminCookie, 'design')) === 409);
        P.fault = null;
        await retry(page);
        ok(`Lock (${mode}): retry succeeds and clears the alert`, (await alertText(page)) === '');
        ok(`Lock (${mode}): replaying the original cookie is rejected after confirmed success`, (await replayAdmin(adminCookie, 'design')) === 401);
        const s = await serverSession(page);
        ok(`Lock (${mode}): team access kept`, s.teams.includes('design') && s.adminTeams.length === 0);
        await ctx.close();
      }

      // Malformed (non-JSON) success-looking response is a failure too
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'Design', TEST_ENV.PASSWORD_DESIGN);
        await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_DESIGN);
        P.fault = { action: 'end-admin', mode: 'html' };
        await page.click('#tasks-admin-area .admin-badge button'); await page.waitForTimeout(350);
        ok('Lock (malformed 200): treated as failure', (await alertText(page)).includes('unexpected response'));
        await ctx.close(); }

      // Pending: admin re-authentication is blocked until the server answers
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'Design', TEST_ENV.PASSWORD_DESIGN);
        await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_DESIGN);
        P.fault = { action: 'end-admin', mode: 'delay', ms: 800 };
        await page.click('#tasks-admin-area .admin-badge button'); await page.waitForTimeout(150);
        const pending = await page.evaluate(() => { const b = document.querySelector('#tasks-admin-area button'); return { t: b.textContent, d: b.disabled }; });
        ok('Pending: "Ending admin access…" shown and re-auth disabled', pending.d && pending.t.includes('Ending admin access'), JSON.stringify(pending));
        await page.waitForTimeout(900);
        ok('Pending: completes, Manage files available, no alert', (await text(page, '#tasks-admin-area')).includes('Manage files') && (await alertText(page)) === '');
        await ctx.close(); }

      // Leaving the workspace with a failed end-admin
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'SEO', TEST_ENV.PASSWORD_SEO);
        await adminLogin(page, TEST_ENV.PASSWORD_ADMIN_SEO);
        const adminCookie = await rawCookie(ctx);
        P.fault = { action: 'end-admin', mode: '500' };
        await page.click('.team-back'); await page.waitForTimeout(350);
        ok('Leave workspace (500): alert visible on the Teams page', (await alertText(page)).includes('could not be ended'));
        P.fault = null; await retry(page);
        ok('Leave workspace: retry ends admin; original cookie rejected', (await alertText(page)) === '' && (await replayAdmin(adminCookie, 'seo')) === 401);
        await ctx.close(); }

      // Goals: cancel and completed save with a failed end-admin
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'Video', TEST_ENV.PASSWORD_VIDEO);
        await page.click('.team-back'); await page.waitForTimeout(300);
        page.__promptAnswer = TEST_ENV.PASSWORD_ADMIN;
        await page.click('[data-goal-action="edit"][data-goal-year="2026"]'); await page.waitForTimeout(300);
        let globalCookie = await rawCookie(ctx);
        P.fault = { action: 'end-admin', mode: 'abort' };
        await page.click('#goals-edit-form .goals-cancel-btn'); await page.waitForTimeout(350);
        ok('Goals cancel (network): alert visible', (await alertText(page)).includes('could not be ended'));
        ok('Goals cancel: server still global admin before retry (truthful)', (await replayAdmin(globalCookie, 'marketing')) === 409);
        P.fault = null; await retry(page);
        ok('Goals cancel: retry ends global admin; original cookie rejected', (await alertText(page)) === '' && (await replayAdmin(globalCookie, 'marketing')) === 401 && !(await serverSession(page)).globalAdmin);

        await page.click('[data-goal-action="edit"][data-goal-year="2026"]'); await page.waitForTimeout(300);
        globalCookie = await rawCookie(ctx);
        P.fault = { action: 'end-admin', mode: '500' };
        await page.fill('#goal-year-input', '$3,000'); await page.click('#goals-edit-form .goals-save-btn'); await page.waitForTimeout(400);
        ok('Goals save: change saved', factory('team-links').peek('global_goals')['2026'].yearGoal === '$3,000');
        ok('Goals save (500 on end-admin): alert visible', (await alertText(page)).includes('could not be ended'));
        P.fault = null; await retry(page);
        ok('Goals save: retry ends global admin; original cookie rejected', (await alertText(page)) === '' && (await replayAdmin(globalCookie, 'marketing')) === 401);
        await ctx.close(); }

      // Late login cleanup: cancelled login whose success arrives later, drop-team fails
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.route('**/.netlify/functions/check-password', async route => { await new Promise(r => setTimeout(r, 500)); return route.continue(); });
        await page.goto(BASE + '/#teams');
        await page.click('.team-card:has(h3:text-is("Marketing"))');
        await page.fill('#team-password', TEST_ENV.PASSWORD_MARKETING);
        P.fault = { action: 'drop-team', mode: '500' };
        await page.click('#unlock-btn'); await page.waitForTimeout(100);
        await page.click('#cancel-modal');
        await page.waitForTimeout(900);
        const lateCookie = await rawCookie(ctx);
        ok('Late login cleanup (500): alert names the cancelled team', (await alertText(page)).includes('cancelled Marketing sign-in could not be removed'));
        ok('Late login cleanup: server still grants it before retry (truthful)', (await replayRead(lateCookie, 'marketing')) === 200);
        P.fault = null; await retry(page);
        ok('Late login cleanup: retry removes it; old cookie rejected', (await alertText(page)) === '' && (await replayRead(lateCookie, 'marketing')) === 401 && !(await serverSession(page)).authenticated);
        await ctx.close(); }

      // Late admin login cleanup with a failed end-admin
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'Design', TEST_ENV.PASSWORD_DESIGN);
        await page.route('**/.netlify/functions/check-password', async route => { await new Promise(r => setTimeout(r, 500)); return route.continue(); });
        await page.click('#tasks-admin-area .admin-unlock-btn');
        await page.fill('#admin-input', TEST_ENV.PASSWORD_ADMIN_DESIGN);
        P.fault = { action: 'end-admin', mode: 'abort' };
        await page.click('#admin-unlock-btn'); await page.waitForTimeout(100);
        await page.click('#cancel-admin');
        await page.waitForTimeout(900);
        const c = await rawCookie(ctx);
        ok('Late admin cleanup (network): alert visible, admin not shown active', (await alertText(page)).includes('could not be ended') && !(await visible(page, '#tasks-add-form')));
        P.fault = null; await retry(page);
        ok('Late admin cleanup: retry ends admin; cookie rejected for admin', (await replayAdmin(c, 'design')) === 401 && (await alertText(page)) === '');
        await ctx.close(); }

      // Sign-out failure is not presented as signed out
      seed();
      { const P = await faultyPage(); const { page, ctx } = P;
        await page.goto(BASE + '/#teams');
        await teamLogin(page, 'Marketing', TEST_ENV.PASSWORD_MARKETING);
        const c = await rawCookie(ctx);
        P.fault = { action: 'logout', mode: 'abort' };
        await page.click('#team-signout-btn'); await page.waitForTimeout(350);
        const msg = await alertText(page);
        ok('Sign-out (network): "not confirmed" alert with retry, no "close the browser" claim', msg.includes('Sign-out was not confirmed') && !/close the browser/i.test(msg));
        ok('Sign-out (network): page not shown as signed out', await visible(page, '#team-page'));
        P.fault = { action: 'logout', mode: '500' };
        await retry(page);
        ok('Sign-out (500): still not confirmed', (await alertText(page)).includes('http 500'));
        P.fault = null; await retry(page);
        ok('Sign-out: retry signs out; old cookie rejected', (await alertText(page)) === '' && !(await visible(page, '#team-page')) && (await replayRead(c, 'marketing')) === 401);
        await ctx.close(); }
    }

    // 9. Mobile
    seed();
    { const { ctx, page, errors } = await newPage(browser, { mobile: true });
      await page.goto(BASE + '/#teams');
      await teamLogin(page, 'Customer Service', TEST_ENV.PASSWORD_CUSTOMERSERVICE);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      ok('Mobile: workspace visible, no horizontal scroll, sign-out visible', await visible(page, '#team-page') && m.sw <= m.cw && await visible(page, '#team-signout-btn'), JSON.stringify(m));
      if (shotPrefix) await page.screenshot({ path: shotPrefix + '-mobile.png' });
      ok('Mobile: no JS errors', errors.length === 0, errors.join(' | '));
      await ctx.close(); }
  } catch (err) {
    results.push('FAIL  crashed: ' + (err && err.stack));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
