'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'check-public.mjs');

test('check:public passes on the repository', () => {
  const out = execFileSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /passed/);
});

test('check:public fails on a real-looking Google document link and masks it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbonb-'));
  const id = 'Zq' + 'x9'.repeat(20);
  fs.writeFileSync(path.join(dir, 'page.html'), `<a href="https://docs.google.com/spreadsheets/d/${id}/edit">x</a>\n<a href="https://drive.google.com/drive/folders/${id}">y</a>`);
  fs.writeFileSync(path.join(dir, 'ok.html'), '<a href="https://docs.google.com/document/d/EXAMPLE-HANDBOOK/edit">placeholder</a>');
  const res = spawnSync(process.execPath, [CHECK, dir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /page\.html:1/);
  assert.match(res.stderr, /page\.html:2/);
  assert.ok(!res.stderr.includes('ok.html'));
  assert.ok(!res.stderr.includes(id), 'full id never printed');
});

test('check:public honours a private terms file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbonb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'mentions Internal-Codename-Zeta here');
  const terms = path.join(dir, '..', `terms-${Date.now()}.txt`);
  fs.writeFileSync(terms, '# private\nInternal-Codename-Zeta\n');
  const res = spawnSync(process.execPath, [CHECK, dir], { encoding: 'utf8', env: { ...process.env, PRIVATE_TERMS_FILE: terms } });
  assert.equal(res.status, 1);
  assert.ok(!res.stderr.includes('Internal-Codename-Zeta'));
});

test('build publishes only the page and logo, with no internal links', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'dist')).sort(), ['index.html', 'succulents-box-logo-icon.png']);
  const html = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8');
  assert.ok(!/docs\.google\.com\/(document|spreadsheets)\/d\//.test(html));
  assert.ok(!/sessionStorage\.setItem/.test(html), 'no browser-stored auth state');
  assert.ok(!/adminPassword\s*[:=]|getItem\('adminPassword'\)/.test(html), 'admin password never stored or sent with requests');
});

test('index.html never interpolates stored values into inline handlers', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/onclick="[^"]*\$\{/.test(html), 'no ${…} inside onclick attributes');
  assert.ok(!/href="\$\{/.test(html), 'no ${…} hrefs');
});
