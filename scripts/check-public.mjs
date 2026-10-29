#!/usr/bin/env node
// Fails (exit 1) if committed/public files contain real internal document links.
//
// Scans every file in the repository folder (or the folders given as arguments)
// except .git, node_modules and private/. Runs in every Netlify build and against
// the built dist/ folder.
//
// Flags:
//   * Google Docs / Sheets / Slides / Forms / Drive / Apps Script links whose ID is
//     not an obvious placeholder (IDs starting with EXAMPLE, FAKE or SYNTHETIC).
//   * Any term listed (one per line) in the file named by PRIVATE_TERMS_FILE, if set.
//     Keep that file outside the repository or under private/ (git-ignored).
//
// Output never prints a full matching ID — only file, line and a masked preview.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'private', '.netlify']);
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.json', '.md', '.toml', '.txt', '.css', '.svg', '.yml', '.yaml', '.map', '.csv', '.patch', '']);

const GOOGLE_ID_PATTERNS = [
  /docs\.google\.com\/(?:a\/[^/\s]+\/)?(?:document|spreadsheets|presentation|forms|drawings|file)\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{10,})/g,
  /drive\.google\.com\/(?:a\/[^/\s]+\/)?(?:file\/(?:u\/\d+\/)?d|drive\/(?:u\/\d+\/)?folders|folderview\?id=|open\?id=|uc\?(?:export=\w+&)?id=)\/?([A-Za-z0-9_-]{10,})/g,
  /script\.google\.com\/macros\/s\/([A-Za-z0-9_-]{10,})/g,
  /sheets\.googleapis\.com\/v4\/spreadsheets\/([A-Za-z0-9_-]{10,})/g,
];
const PLACEHOLDER = /^(EXAMPLE|FAKE|SYNTHETIC)/i;

function privateTerms() {
  const file = process.env.PRIVATE_TERMS_FILE;
  if (!file) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(p)) && p !== '.') return;
    for (const name of fs.readdirSync(p)) yield* walk(path.join(p, name));
  } else if (st.isFile() && TEXT_EXT.has(path.extname(p).toLowerCase()) && st.size < 5 * 1024 * 1024) {
    yield p;
  }
}

const mask = s => (s.length <= 8 ? '***' : s.slice(0, 4) + '…' + s.slice(-2));

const terms = privateTerms();
const findings = [];
for (const target of targets) {
  for (const file of walk(target)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const re of GOOGLE_ID_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          if (!PLACEHOLDER.test(m[1])) findings.push(`${path.relative(root, file)}:${i + 1}  Google document link (id ${mask(m[1])})`);
        }
      }
      for (const term of terms) {
        if (line.includes(term)) findings.push(`${path.relative(root, file)}:${i + 1}  private term (${mask(term)})`);
      }
    });
  }
}

if (findings.length) {
  console.error('check:public FAILED — internal content found in public files:');
  for (const f of findings) console.error('  ' + f);
  console.error('Move real links into Netlify Blobs (see docs/SECURITY.md) and use EXAMPLE-… placeholders in code.');
  process.exit(1);
}
console.log(`check:public passed (${targets.join(', ')}${terms.length ? `, ${terms.length} private terms` : ''}).`);
