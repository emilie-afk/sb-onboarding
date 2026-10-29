#!/usr/bin/env node
// Builds the publish folder. Only the page and its logo are published; functions,
// tests, scripts and docs are not served. The build never reads Netlify Blobs or
// any private file, so it cannot write stored links into the output.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT = 'dist';
const FILES = ['index.html', 'succulents-box-logo-icon.png'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (const f of FILES) fs.copyFileSync(f, `${OUT}/${f}`);

// Verify the output as well as the source.
execFileSync(process.execPath, ['scripts/check-public.mjs', OUT], { stdio: 'inherit' });
console.log(`Built ${OUT}/ (${FILES.join(', ')}).`);
