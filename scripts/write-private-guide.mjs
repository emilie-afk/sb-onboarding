#!/usr/bin/env node
// Writes the private onboarding guide for the get-guide function from the
// ONBOARDING_GUIDE_JSON build variable (plain JSON or "gz:" + base64 gzip) to
// netlify/private/guide.json. That folder is git-ignored and is never copied to dist/.
// Without the variable nothing is written and get-guide answers 503 (signed-in users
// see "not available yet"); the public page is unaffected. Prints counts only.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateGuide, decodeGuideValue } = require('../netlify/lib/guide.js');

const OUT = path.join('netlify', 'private', 'guide.json');
const text = decodeGuideValue(process.env.ONBOARDING_GUIDE_JSON);
if (!text) {
  fs.rmSync(OUT, { force: true });
  console.log('Private guide: not configured (ONBOARDING_GUIDE_JSON unset); get-guide will answer 503.');
} else {
  const guide = validateGuide(text);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(guide), { mode: 0o600 });
  console.log(`Private guide written (version ${guide.version}: ${guide.checklist.length} checklist items, ${guide.benefits.length} benefits, ${guide.routine.length} routine steps).`);
}
