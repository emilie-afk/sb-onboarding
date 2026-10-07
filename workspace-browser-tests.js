const { chromium } = require('playwright');
const fs = require('fs');
const HTML = process.argv[2];
const html = fs.readFileSync(HTML, 'utf8');
const png = fs.readFileSync('/tmp/sb-onboarding/succulents-box-logo-icon.png');
const TEAMS = { marketing:'Marketing', customerservice:'Customer Service', seo:'SEO', design:'Design', video:'Video' };
const PW = 'pw-ok';
let results = []; const ok=(name,cond,extra='')=>results.push(`${cond?'PASS':'FAIL'}  ${name}${extra?'  — '+extra:''}`);

async function setup(browser, opts={}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport:{width:390,height:844}, isMobile:true, hasTouch:true } : { viewport:{width:1280,height:900} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/' || u.pathname === '/index.html') return route.fulfill({ body: html, contentType:'text/html' });
    if (u.pathname.endsWith('.png')) return route.fulfill({ body: png, contentType:'image/png' });
    if (u.pathname === '/.netlify/functions/check-password') {
      const b = JSON.parse(route.request().postData());
      if (b.team === 'admin') {
        const a = opts.adminCtl || {}; a.count = (a.count||0)+1; (a.teams = a.teams||[]).push(b.teamName);
        if (a.delay) await new Promise(r=>setTimeout(r,a.delay));
        if (a.abort) return route.abort().catch(()=>{});
        if (a.raw) return route.fulfill(a.raw).catch(()=>{});
        if (a.status && a.status !== 200) return route.fulfill({ status:a.status, json:a.body||{success:false} }).catch(()=>{});
        return route.fulfill({ json:{ success: b.password === 'admin-ok' } }).catch(()=>{});
      }
      const ctl = opts.ctl || {};
      ctl.count = (ctl.count||0)+1;
      if (opts.authDown) return route.abort();
      const delay = typeof ctl.delay === 'function' ? ctl.delay(b) : (ctl.delay||0);
      if (delay) await new Promise(r=>setTimeout(r,delay));
      if (ctl.raw) return route.fulfill(ctl.raw).catch(()=>{});
      if (ctl.status && ctl.status !== 200) return route.fulfill({ status: ctl.status, json: ctl.body || { success:false } }).catch(()=>{});
      return route.fulfill({ json: { success: b.password === PW } }).catch(()=>{});
    }
    if (u.pathname === '/.netlify/functions/get-links') {
      const type = u.searchParams.get('type'), team = u.searchParams.get('team');
      if (opts.linksFail === 'abort') return route.abort();
      if (opts.linksFail === '500') return route.fulfill({ status:500, json:{ error:'Failed to load links' } });
      if (type === 'goals') return route.fulfill({ json:{ links:{} } });
      if (type === 'kpi') return route.fulfill({ json:{ links:{ '2026':[{id:1,name:`${team} KPI`,url:'https://example.com'}] } } });
      return route.fulfill({ json:{ links:[{ id:1, name:`${team} ${type} doc`, url:'https://example.com' }] } });
    }
    return route.abort();
  });
  await page.goto('http://site.test/#teams');
  return { ctx, page, errors };
}
const visible = (page, sel) => page.evaluate(s => { const el=document.querySelector(s); return !!el && getComputedStyle(el).display!=='none' && el.offsetHeight>0; }, sel);
async function login(page, id, name, pw) {
  await page.click(`.team-card:has(h3:text-is("${name}"))`);
  await page.fill('#team-password', pw); await page.click('#unlock-btn');
  await page.waitForTimeout(300);
}
async function journeyState(page){ return page.evaluate(()=>{const a=[...document.querySelectorAll('.journey-step.active')]; return a.map(s=>s.dataset.page+':'+s.getAttribute('aria-current')).join(',');}); }

(async () => {
  const browser = await chromium.launch();
  for (const [id, name] of Object.entries(TEAMS)) {
    const { ctx, page, errors } = await setup(browser);
    // incorrect password
    await login(page, id, name, 'wrong');
    const note = await page.textContent('#form-note');
    ok(`${name}: incorrect password`, note.includes('Incorrect password') && await visible(page,'#team-modal.open') && !(await visible(page,'#team-page')), note);
    // fresh login
    await page.fill('#team-password', PW); await page.click('#unlock-btn'); await page.waitForTimeout(300);
    const heading = await page.textContent('#team-name-heading');
    const js = await journeyState(page);
    const tasks = await page.textContent('#tasks-links-list');
    ok(`${name}: fresh login shows workspace`, await visible(page,'#team-page') && heading===`${name} Team` && tasks.includes('tasks doc') && !(await page.textContent('#form-note')).includes('connect'), `heading="${heading}"`);
    ok(`${name}: "My team" active + aria-current`, js==='teams:step', js);
    // tabs
    let tabOk = true, tabLog=[];
    for (const [t, sel] of [['eos','#eos-links-list'],['kpi','#kpi-years-container'],['handover','#handover-links-list'],['tools','#tools-links-list'],['tasks','#tasks-links-list']]) {
      await page.click(`.tab-nav button[onclick*="'${t}'"]`); await page.waitForTimeout(150);
      const txt = await page.textContent(sel); const shown = await visible(page, '#tab-'+t);
      if (!shown || !(txt.includes(t==='kpi'?'KPI':`${t} doc`))) { tabOk=false; tabLog.push(t); }
    }
    ok(`${name}: all 5 tabs load`, tabOk, tabLog.join(','));
    // Escape inside workspace then switch tab (regression guard)
    await page.keyboard.press('Escape'); await page.click(`.tab-nav button[onclick*="'eos'"]`); await page.waitForTimeout(150);
    ok(`${name}: Escape doesn't break tabs`, (await page.textContent('#eos-links-list')).includes('eos doc'));
    // return to My team
    await page.click('.team-back'); await page.waitForTimeout(200);
    ok(`${name}: back returns to My team`, await visible(page,'#teams') && !(await visible(page,'#team-page')) && (await journeyState(page))==='teams:step');
    // reopen unlocked
    await page.click(`.team-card:has(h3:text-is("${name}"))`); await page.waitForTimeout(300);
    ok(`${name}: reopen unlocked (no modal)`, await visible(page,'#team-page') && !(await visible(page,'#team-modal.open')) && (await page.textContent('#tasks-links-list')).includes('tasks doc') && (await journeyState(page))==='teams:step');
    // journey nav away while in workspace
    await page.click('.journey-step[data-page="values"]'); await page.waitForTimeout(200);
    ok(`${name}: journey nav leaves workspace`, await visible(page,'#values') && !(await visible(page,'#team-page')));
    ok(`${name}: no JS errors`, errors.length===0, errors.join(' | '));
    await ctx.close();
  }
  // auth network failure
  { const { ctx, page } = await setup(browser, { authDown:true });
    await login(page,'seo','SEO',PW);
    ok('Auth network failure → "Could not connect"', (await page.textContent('#form-note')).includes('Could not connect') && !(await visible(page,'#team-page')));
    await ctx.close(); }
  // ── Stale / duplicate auth responses ──
  const unlocked = page => page.evaluate(()=>sessionStorage.getItem('unlockedTeams')||'[]');
  const start = async (page, name, pw) => { await page.click(`.team-card:has(h3:text-is("${name}"))`); await page.fill('#team-password', pw); await page.click('#unlock-btn'); await page.waitForTimeout(100); };
  for (const how of ['Cancel','Escape','Backdrop']) {
    const ctl = { delay: 800 }; const { ctx, page, errors } = await setup(browser, { ctl });
    await start(page,'Marketing',PW);
    if (how==='Cancel') await page.click('#cancel-modal');
    else if (how==='Escape') await page.keyboard.press('Escape');
    else await page.mouse.click(5,5);
    await page.waitForTimeout(1000);
    ok(`Delayed success after ${how} is ignored`, !(await visible(page,'#team-page')) && await visible(page,'#teams') && (await unlocked(page))==='[]' && !(await visible(page,'#team-modal.open')) && errors.length===0, `unlocked=${await unlocked(page)}`);
    await ctx.close();
  }
  { // reopen same modal while old request in flight
    const ctl = { delay: 800 }; const { ctx, page, errors } = await setup(browser, { ctl });
    await start(page,'Marketing',PW); await page.click('#cancel-modal');
    await page.click('.team-card:has(h3:text-is("Marketing"))'); await page.waitForTimeout(1000);
    ok('Reopened modal ignores old response', await visible(page,'#team-modal.open') && !(await visible(page,'#team-page')) && (await page.textContent('#form-note'))==='' && !(await page.isDisabled('#unlock-btn')) && (await unlocked(page))==='[]', `note="${await page.textContent('#form-note')}"`);
    await ctx.close();
  }
  { // switch teams while old request in flight; new team gets a fast wrong-password answer
    const ctl = { delay: b => b.team==='marketing' ? 900 : 50 }; const { ctx, page, errors } = await setup(browser, { ctl });
    await start(page,'Marketing',PW); await page.keyboard.press('Escape');
    await start(page,'SEO','wrong'); await page.waitForTimeout(1100);
    ok('Switched team ignores old team response', await visible(page,'#team-modal.open') && (await page.textContent('#modal-title'))==='Unlock SEO' && (await page.textContent('#form-note')).includes('Incorrect') && !(await visible(page,'#team-page')) && (await unlocked(page))==='[]', `unlocked=${await unlocked(page)}`);
    // now SEO succeeds normally
    await page.fill('#team-password', PW); await page.click('#unlock-btn'); await page.waitForTimeout(300);
    ok('Switched team then correct password opens that team', (await page.textContent('#team-name-heading'))==='SEO Team' && (await unlocked(page))==='["seo"]' && errors.length===0);
    await ctx.close();
  }
  { // duplicate submissions while pending
    const ctl = { delay: 600 }; const { ctx, page, errors } = await setup(browser, { ctl });
    await page.click('.team-card:has(h3:text-is("Video"))'); await page.fill('#team-password', PW);
    await page.click('#unlock-btn'); const disabled = await page.isDisabled('#unlock-btn');
    await page.click('#unlock-btn',{force:true}).catch(()=>{}); await page.focus('#team-password'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    ok('Duplicate submits blocked (1 request, button disabled)', ctl.count===1 && disabled && (await page.textContent('#team-name-heading'))==='Video Team' && errors.length===0, `requests=${ctl.count} disabled=${disabled}`);
    await ctx.close();
  }
  { // delayed wrong password re-enables button
    const ctl = { delay: 500 }; const { ctx, page } = await setup(browser, { ctl });
    await start(page,'Design','wrong'); await page.waitForTimeout(700);
    ok('Delayed wrong password → Incorrect, button re-enabled', (await page.textContent('#form-note')).includes('Incorrect') && !(await page.isDisabled('#unlock-btn')));
    await ctx.close();
  }
  // ── HTTP status handling ──
  { const ctl = { status: 500, body: { success:false, error:'boom' } }; const { ctx, page, errors } = await setup(browser, { ctl });
    await start(page,'Customer Service',PW); await page.waitForTimeout(200);
    const note = await page.textContent('#form-note'); const kept = await page.inputValue('#team-password');
    ok('JSON 500 → server error (not "Incorrect"), password kept', note.includes('server had a problem') && !note.includes('Incorrect') && kept===PW && !(await page.isDisabled('#unlock-btn')) && !(await visible(page,'#team-page')), note);
    ctl.status = 200; await page.click('#unlock-btn'); await page.waitForTimeout(300);
    ok('Retry after 500 succeeds', (await page.textContent('#team-name-heading'))==='Customer Service Team' && errors.length===0);
    await ctx.close(); }
  { const ctl = { raw: { status: 502, body: '<html>Bad gateway</html>', contentType:'text/html' } }; const { ctx, page } = await setup(browser, { ctl });
    await start(page,'SEO',PW); await page.waitForTimeout(200);
    const note = await page.textContent('#form-note');
    ok('Non-JSON 502 → server error', note.includes('server had a problem'), note); await ctx.close(); }
  { const ctl = { status: 401, body: { success:false } }; const { ctx, page } = await setup(browser, { ctl });
    await start(page,'Marketing',PW); await page.waitForTimeout(200);
    const note = await page.textContent('#form-note');
    ok('401 → Incorrect password (unchanged behaviour)', note.includes('Incorrect') && (await page.inputValue('#team-password'))==='', note); await ctx.close(); }

  // ── Admin password ──
  const adminState = page => page.evaluate(()=>({ s: sessionStorage.getItem('adminUnlocked'), badge: !!document.querySelector('#tasks-admin-area .admin-badge'), form: getComputedStyle(document.getElementById('tasks-add-form')).display }));
  const adminOff = st => st.s===null && !st.badge && st.form==='none';
  const adminStart = async (page, pw) => { await page.click('#tasks-admin-area .admin-unlock-btn'); await page.fill('#admin-input', pw); await page.click('#admin-unlock-btn'); await page.waitForTimeout(100); };
  const openWs = async (page, name) => { await login(page, null, name, PW); };
  { const adminCtl = {}; const { ctx, page, errors } = await setup(browser, { adminCtl });
    await openWs(page,'Marketing');
    await adminStart(page,'wrong'); await page.waitForTimeout(200);
    const note = await page.textContent('#admin-note');
    ok('Admin: wrong password → Incorrect', note.includes('Incorrect admin password') && (await page.inputValue('#admin-input'))==='' && adminOff(await adminState(page)), note);
    await page.fill('#admin-input','admin-ok'); await page.click('#admin-unlock-btn'); await page.waitForTimeout(300);
    const st = await adminState(page);
    ok('Admin: correct password → admin mode', st.s==='true' && st.badge && st.form==='block' && !(await visible(page,'#admin-modal.open')) && adminCtl.teams.every(t=>t==='marketing') && errors.length===0, JSON.stringify(st));
    await ctx.close(); }
  for (const how of ['Cancel','Escape','Backdrop']) {
    const adminCtl = { delay: 800 }; const { ctx, page, errors } = await setup(browser, { adminCtl });
    await openWs(page,'SEO'); await adminStart(page,'admin-ok');
    if (how==='Cancel') await page.click('#cancel-admin'); else if (how==='Escape') await page.keyboard.press('Escape'); else await page.mouse.click(5,5);
    await page.waitForTimeout(1000);
    ok(`Admin: delayed success after ${how} ignored`, adminOff(await adminState(page)) && await visible(page,'#team-page') && errors.length===0, JSON.stringify(await adminState(page)));
    await ctx.close();
  }
  { const adminCtl = { delay: 800 }; const { ctx, page } = await setup(browser, { adminCtl });
    await openWs(page,'Design'); await adminStart(page,'admin-ok'); await page.click('#cancel-admin');
    await page.click('#tasks-admin-area .admin-unlock-btn'); await page.waitForTimeout(1000);
    ok('Admin: reopened modal ignores old response', adminOff(await adminState(page)) && await visible(page,'#admin-modal.open') && (await page.textContent('#admin-note'))==='' && !(await page.isDisabled('#admin-unlock-btn')));
    await ctx.close(); }
  { const adminCtl = { delay: 800 }; const { ctx, page } = await setup(browser, { adminCtl });
    await openWs(page,'Video'); await adminStart(page,'admin-ok'); await page.keyboard.press('Escape');
    await page.click('.team-back'); await page.waitForTimeout(1000);
    ok('Admin: leaving workspace ignores old response', (await page.evaluate(()=>sessionStorage.getItem('adminUnlocked')))===null && await visible(page,'#teams'));
    await ctx.close(); }
  { const adminCtl = { delay: 800 }; const { ctx, page } = await setup(browser, { adminCtl });
    await openWs(page,'Marketing'); await page.click('.team-back'); await openWs(page,'Customer Service');  // both unlocked
    await adminStart(page,'admin-ok'); await page.keyboard.press('Escape'); await page.click('.team-back');
    await page.click('.team-card:has(h3:text-is("Marketing"))'); await page.waitForTimeout(1000);
    ok('Admin: switching team ignores old team response', adminOff(await adminState(page)) && (await page.textContent('#team-name-heading'))==='Marketing Team');
    await ctx.close(); }
  { const adminCtl = { delay: 600 }; const { ctx, page, errors } = await setup(browser, { adminCtl });
    await openWs(page,'SEO'); await page.click('#tasks-admin-area .admin-unlock-btn'); await page.fill('#admin-input','admin-ok');
    await page.click('#admin-unlock-btn'); const dis = await page.isDisabled('#admin-unlock-btn');
    await page.click('#admin-unlock-btn',{force:true}).catch(()=>{}); await page.focus('#admin-input'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    ok('Admin: duplicate submits blocked', adminCtl.count===1 && dis && (await adminState(page)).s==='true' && errors.length===0, `requests=${adminCtl.count} disabled=${dis}`);
    await ctx.close(); }
  { const adminCtl = { status: 500, body:{success:false,error:'boom'} }; const { ctx, page, errors } = await setup(browser, { adminCtl });
    await openWs(page,'Design'); await adminStart(page,'admin-ok'); await page.waitForTimeout(200);
    const note = await page.textContent('#admin-note');
    ok('Admin: JSON 500 → server error, password kept', note.includes('server had a problem') && !note.includes('Incorrect') && (await page.inputValue('#admin-input'))==='admin-ok' && !(await page.isDisabled('#admin-unlock-btn')) && adminOff(await adminState(page)), note);
    adminCtl.status = 200; await page.click('#admin-unlock-btn'); await page.waitForTimeout(300);
    ok('Admin: retry after 500 succeeds', (await adminState(page)).s==='true' && errors.length===0);
    await ctx.close(); }
  { const adminCtl = { raw:{ status:502, body:'<html>Bad gateway</html>', contentType:'text/html' } }; const { ctx, page } = await setup(browser, { adminCtl });
    await openWs(page,'Video'); await adminStart(page,'admin-ok'); await page.waitForTimeout(200);
    ok('Admin: non-JSON 502 → server error', (await page.textContent('#admin-note')).includes('server had a problem')); await ctx.close(); }
  { const adminCtl = { status:401 }; const { ctx, page } = await setup(browser, { adminCtl });
    await openWs(page,'Marketing'); await adminStart(page,'admin-ok'); await page.waitForTimeout(200);
    ok('Admin: 401 → Incorrect admin password', (await page.textContent('#admin-note')).includes('Incorrect admin password')); await ctx.close(); }
  { const adminCtl = { abort:true }; const { ctx, page } = await setup(browser, { adminCtl });
    await openWs(page,'SEO'); await adminStart(page,'admin-ok'); await page.waitForTimeout(200);
    ok('Admin: network failure → Could not connect', (await page.textContent('#admin-note')).includes('Could not connect') && !(await page.isDisabled('#admin-unlock-btn'))); await ctx.close(); }

  // links failure (500 and network)
  for (const mode of ['500','abort']) {
    const { ctx, page, errors } = await setup(browser, { linksFail: mode });
    await login(page,'design','Design',PW);
    const note = await page.textContent('#form-note');
    const err = await page.textContent('#tasks-links-list');
    await page.click(`.tab-nav button[onclick*="'kpi'"]`); await page.waitForTimeout(150);
    const kerr = await page.textContent('#kpi-years-container');
    ok(`Links ${mode} → visible error, workspace shown`, await visible(page,'#team-page') && err.includes('Could not load files') && kerr.includes('Could not load files') && !note.includes('connect'), `tasks="${err.trim()}"`);
    await ctx.close();
  }
  // mobile
  { const { ctx, page, errors } = await setup(browser, { mobile:true });
    await login(page,'customerservice','Customer Service',PW);
    const m = await page.evaluate(()=>({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok('Mobile 390px: workspace visible, no horizontal scroll', await visible(page,'#team-page') && m.sw<=m.cw, JSON.stringify(m));
    await page.screenshot({ path: process.argv[3]+'-mobile.png', fullPage:false });
    await page.click(`.tab-nav button[onclick*="'tools'"]`); await page.waitForTimeout(150);
    ok('Mobile: tab switch works', (await page.textContent('#tools-links-list')).includes('tools doc'));
    ok('Mobile: no JS errors', errors.length===0, errors.join('|'));
    await ctx.close(); }
  { const { ctx, page } = await setup(browser);
    await login(page,'marketing','Marketing',PW);
    await page.screenshot({ path: process.argv[3]+'-desktop.png' }); await ctx.close(); }
  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${results.filter(r=>r.startsWith('PASS')).length}/${results.length} passed`);
})();
