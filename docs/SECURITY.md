# SB Onboarding — security model, configuration and rollout

The repository is public. Nothing secret or internal belongs in it: passwords,
signing secrets, storage tokens, real document links and revenue goals live only
in Netlify environment variables and Netlify Blobs.

## 1. Access model

The team-password workflow is unchanged. What changed is that a password is now
checked once by the server, which then issues a **signed, expiring session
cookie**. Every data function re-verifies that cookie and decides access from it.
Nothing the browser sends (team name, role flag, stored "unlocked" state) grants
access.

### Permission matrix

| Action | Anonymous | Team member (team X) | Team admin (team X) | Global admin |
|---|---|---|---|---|
| Public pages (welcome, values, benefits text, daily setup) | ✅ | ✅ | ✅ | ✅ |
| Read team X tasks / EOS / KPI / handover / tools | ❌ 401 | ✅ | ✅ | ✅ |
| Read team Y (another team) | ❌ 401 | ❌ 403 | ❌ 403 | ✅ |
| Read revenue goals and handbook link (shared) | ❌ 401 | ✅ | ✅ | ✅ |
| Add / edit / remove team X links | ❌ 401 | ❌ 403 | ✅ | ✅ |
| Add / edit / remove team Y links | ❌ 401 | ❌ 403 | ❌ 403 | ✅ |
| Set / delete revenue goal years | ❌ 401 | ❌ 403 | ❌ 403 | ✅ |
| Change the handbook link | ❌ 401 | ❌ 403 | ❌ 403 | ✅ (API / private import) |

- A person may unlock several teams; each team password adds one grant for that
  team only. Unlocking one team never opens another.
- A team admin password typed in another team's workspace is rejected.
- The global admin password works in any workspace and in the goals editor.
- Admin access ends when the person locks admin mode, leaves the workspace,
  finishes or cancels a goals edit, signs out, or after 2 hours.

### Sessions

| Property | Value |
|---|---|
| Cookie | `__Host-sbonb`, `HttpOnly; Secure; SameSite=Strict; Path=/`, host-only |
| Content | `base64url(JSON)` + HMAC-SHA256 signature with `SESSION_SECRET` |
| Grants | `{team, member|admin, password-fingerprint, expiry}` or `{global, fingerprint, expiry}` |
| Lifetime | member grants 12 h, team-admin and global-admin grants 2 h (checked by the server on every request) |
| Logout | `POST session {action:"logout"}` stores the session id in `onboarding-security/revoked/<sid>`; a copied cookie stops working |
| Restore | `GET session` returns the verified teams/admin scope only |

Passwords are never returned, never stored in the browser and never placed in
the cookie. Old `sessionStorage` keys (`unlockedTeams`, `adminUnlocked`,
`adminPassword`, `goalsAdminPw`) are deleted by the new page on load.

### Session invalidation

| To invalidate… | Do this (then redeploy so functions see new values) |
|---|---|
| One browser's session | That person clicks **Sign out** |
| Everyone who used a specific password | Change that password variable. Each grant carries `HMAC(SESSION_SECRET, var-name + password)`; a changed password no longer matches, so only grants issued for that password stop working |
| All sessions issued before a moment | Set `SESSION_NOT_BEFORE` to an ISO time, e.g. `2026-11-01T00:00:00Z` |
| Absolutely every session | Rotate `SESSION_SECRET` |

Netlify functions read environment values captured at deploy time: after any of
these changes, **trigger a new production deploy**. An unparsable
`SESSION_NOT_BEFORE` denies all access instead of being ignored.

### Login-attempt limits (durable)

Stored in the Blobs store `onboarding-security` under `rl/…` (not in function
memory). Per login scope (each team, each team-admin, global admin):

- 10 failures per client address per 15 minutes, and
- 50 failures from all addresses per 15 minutes (slows distributed guessing).

Client addresses are stored only as an HMAC. If this store cannot be read or
written, login is refused (fail closed). Trade-off: someone hammering one team's
login can temporarily lock that team's login for 15 minutes; existing sessions
are not affected.

### CSRF

All writes (login, logout, link and goal changes) require `POST`, a JSON body,
the header `X-SB-Onboarding: 1` (cross-site forms cannot send it, and
cross-site `fetch` would need a CORS preflight these functions never approve), a
same-origin `Origin` / `Sec-Fetch-Site` when the browser sends them, and the
cookie is `SameSite=Strict`. Set `APP_ORIGINS` to pin allowed origins.

### Fail-closed configuration

Missing or short `SESSION_SECRET`, a `SESSION_SECRET` equal to any password,
missing Blobs credentials, or an unconfigured password for the requested scope →
`503 not_configured`, no data. `MAINTENANCE_MODE=1` → every function returns 503
without reading data. Logs carry only error names, never passwords, cookies,
tokens or the secret.

## 2. Environment variables (Netlify → Site configuration → Environment variables)

Mark every value as **secret**, scope to **Functions**, and set values for the
**Production** context only (see §6 on deploy previews).

| Variable | Required | Placeholder / notes |
|---|---|---|
| `SESSION_SECRET` | yes | `<random 48+ chars>` — `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Must differ from every password |
| `PASSWORD_MARKETING`, `PASSWORD_CUSTOMERSERVICE`, `PASSWORD_SEO`, `PASSWORD_DESIGN`, `PASSWORD_VIDEO` | existing | `<team member password>` (unchanged) |
| `PASSWORD_ADMIN_MARKETING` … `PASSWORD_ADMIN_VIDEO` | existing | `<team admin password>` (unchanged) |
| `PASSWORD_ADMIN` | existing | `<global admin password>` (unchanged) |
| `SITE_ID` | existing (token mode) | `<netlify site id>` |
| `NETLIFY_API_TOKEN` | existing (token mode) | `<personal access token>` — see §5 |
| `BLOBS_ACCESS` | optional | `token` (default) or `context` |
| `SESSION_NOT_BEFORE` | optional | `<ISO date-time>` |
| `APP_ORIGINS` | recommended | `https://<production-domain>` (comma-separated if several) |
| `LINK_ALLOWED_HOSTS` | optional | e.g. `docs.google.com,drive.google.com,<team tool hosts>`; leading `.` allows subdomains. Empty = any public https host |
| `MAINTENANCE_MODE` | emergency only | `1` |

No rate-limit storage needs creating: the `onboarding-security` Blobs store is
created on first write with the same Blobs credentials.

## 3. Stored data (Netlify Blobs store `team-links`)

Unchanged shapes; the only new key is `global_handbook`.

| Key | Shape |
|---|---|
| `<team>_tasks`, `_eos`, `_handover`, `_tools` | `[{ id, name, url }]` |
| `<team>_kpi` | `{ "2026": [{ id, name, url }], … }` |
| `global_goals` | `{ "<year label>": { yearGoal, quarterGoal, monthlyGoals, brandGoals, channelGoals } }` |
| `global_handbook` (new) | `[{ id, name, url }]` |

Teams: `marketing, customerservice, seo, design, video`.

Writes are versioned: `get-links` returns a `version` (etag); `manage-links`
requires it and uses conditional writes (`onlyIfMatch` / `onlyIfNew`). A stale
editor gets `409 conflict` plus the latest data and the UI asks them to review
and retry. Duplicate URLs in one list are refused, so a retried "add" cannot
create duplicates. A write that storage does not confirm is reported as an
error, never as saved. Existing ids, order and unknown extra fields are kept.

Link policy: `https://` only, no credentials, standard port, a public DNS host
(no IPs, `localhost`, `.local`, …), optional `LINK_ALLOWED_HOSTS`, bounded
lengths. The server never fetches these URLs. Stored names, goals and URLs are
rendered as text; a stored link that fails the policy is shown as
"(link needs review)" and is not clickable — it is not deleted.

## 4. Public Google documents — what this does and does not do

The Google Docs/Sheets remain shared publicly ("anyone with the link"), as
required. This change:

- removes the links from the public repository, the published page and every
  anonymous API response, so strangers can no longer *discover* them through
  this app;
- does **not** hide a URL from people who are authorized: "Open" buttons are
  normal links and a signed-in person can copy the URL;
- cannot recall URLs that were already copied, indexed, forked or cached.
  Anyone who has a public URL can still open the document.

If a document must become inaccessible to strangers who already hold its URL,
the only fix is changing that document's Google sharing settings (or replacing
the document and retiring the old URL). That is not done here and needs the
owner's approval.

## 5. Procedures

All commands run from a trusted computer. Put `SITE_ID` / `NETLIFY_API_TOKEN` in
the shell only; never in a file in the repository. `private/` is git-ignored.

### Backup (read-only)

```bash
SITE_ID=<site-id> NETLIFY_API_TOKEN=<token> node scripts/blobs-backup.mjs --out private/backups
node scripts/audit-stored-content.mjs private/backups/team-links-<timestamp>.json
```

The backup holds internal links and goals — keep it private. The audit only
reports (bad URLs, odd shapes, HTML-like names, duplicate ids); it never edits.
Also record the current environment variable **names** and deploy id (Netlify →
Deploys) — do not paste values anywhere shared.

### Private link import (add-only)

1. Copy `docs/links-import.example.json` to `private/links-import.json` and put
   the real links in it (for the handbook: the URL that used to be hard-coded in
   `index.html`; it is in the backup history and in the team's records).
2. Dry run (default), then apply:

```bash
SITE_ID=… NETLIFY_API_TOKEN=… node scripts/private-import.mjs --file private/links-import.json
SITE_ID=… NETLIFY_API_TOKEN=… node scripts/private-import.mjs --file private/links-import.json --apply
```

The import never removes, reorders or edits existing records, skips URLs already
present, keeps given ids when free, and uses a conditional write per key (if a
key changes during the import, nothing is written for it — run again). Only
team lists, KPI years and `global/handbook` are importable; goals are not.
Test locally first with `--local-data-dir private/dev-data`.

### Restore (manual, deliberate)

There is no automatic restore. To restore one key from a backup, write that
key's `value` back with a one-off script using `store.setJSON(key, value)` after
confirming nobody is editing. Do not bulk-restore over newer edits.

### Local development

```bash
npm install && (cd netlify/functions && npm install)
npm test                 # unit/integration tests, synthetic credentials
npm run build            # dist/ + public-content check
npx playwright --version # Chromium needed for browser checks
npm run test:browser     # end-to-end + UI regression checks
SESSION_SECRET=<synthetic> PASSWORD_MARKETING=<synthetic> … npm run dev
```

The dev server and tests use an in-memory store and never touch production.

## 6. Rollout (requires approval at each ⚠ step)

0. **Freeze edits** — tell admins not to edit links/goals during the window.
1. **Backup** — run the backup + audit above. Review the audit output.
2. **Configure** ⚠ — add `SESSION_SECRET` and `APP_ORIGINS` (Production
   context, secret, Functions scope). Optional `LINK_ALLOWED_HOSTS` only if the
   audit shows every stored host is covered. Netlify → Site configuration →
   Build & deploy → **Sensitive variable policy: Require approval** for
   deploy previews from forks (the repo is public; previews share the
   site-wide Blobs store).
3. **Import privately** ⚠ — run the handbook import (dry run, then `--apply`).
   Confirm `global_handbook` exists. Nothing else is overwritten.
4. **Deploy** ⚠ — deploy this branch to production in one deploy (login,
   session, get-links and manage-links change together). Do not deploy only some
   functions.
5. **Old browser state** — the new page clears old `sessionStorage` keys on
   load; existing users simply log in again. No action needed.
6. **Close old deploys** ⚠ — *every previous production deploy is still
   reachable at `https://<deploy-id>--<site>.netlify.app` and runs its own
   unauthenticated `get-links`, unlimited `check-password` and
   password-in-body `manage-links` against the same store with the token it was
   built with.* Deploying the fix does not close them. Do one of:
   - **Preferred:** create a new `NETLIFY_API_TOKEN`, set it for Production,
     redeploy, verify (step 7), then **revoke the old token** in Netlify user
     settings — old deploys lose storage access; or switch to
     `BLOBS_ACCESS=context` after verifying on a deploy preview, then revoke the
     token entirely.
   - Also delete old deploys / branch deploys you no longer need (Deploys →
     deploy → Delete) and check that no branch deploys of old code are enabled.
   After this step, verify an old permalink's `/.netlify/functions/get-links?team=marketing&type=tasks` no longer returns data.
7. **Verify in production** (use real passwords privately, no test records in
   real lists unless approved):
   - anonymous: `curl https://<site>/.netlify/functions/get-links?team=marketing&type=tasks` → 401; page source has no Google document link;
   - team member: unlock, see own team's tabs, goals and handbook; `?team=<other>` → 403;
   - team admin: manage own team; another team's admin password rejected in own workspace;
   - global admin: manage any team; edit goals;
   - sign out → old cookie rejected; reload restores session while valid;
   - two browsers editing the same list → second gets the conflict message.
8. **Unfreeze**.

### Rollback (data-preserving)

- **Authentication broken / unsure:** set `MAINTENANCE_MODE=1` and redeploy the
  same code. Every function returns 503; no data is read or changed; the public
  pages still load. Fix forward, then remove the variable and redeploy.
- **Never** roll back to a deploy whose `get-links` has no authentication (any
  deploy before this change) — that republishes all team links anonymously.
- Data is never migrated destructively: the only added key is
  `global_handbook`; the `onboarding-security` store can be deleted at any time
  (users just log in again).
- If a bad write happened, restore that single key from the backup (§5).

## 7. Git history cleanup (separate, not executed)

Reachable history still contains two real Google links (shared publicly):

| Document | Introduced | Removed |
|---|---|---|
| Employee handbook (Google Doc) | `10b1f0b` | removed by this change |
| Attendance / leave Google Sheet | `10b1f0b` | `fcd1cba` |

No passwords or tokens were found in history (patterns for passwords, tokens,
Netlify `nfp_`, GitHub `ghp_` and Google API keys were scanned).

Plan (needs approval; rewrites every commit hash and force-pushes):

1. Merge this change first (so HEAD is clean), announce a freeze.
2. Fresh mirror clone: `git clone --mirror https://github.com/emilie-afk/sb-onboarding.git`.
3. Create `private/replacements.txt` with one line per document ID:
   `<real-doc-id>==>EXAMPLE-REDACTED` (never commit this file).
4. `git filter-repo --replace-text private/replacements.txt` in the mirror.
5. Verify: `git log --all -p | grep -c <real-doc-id>` → 0, and `npm run check:public` on every branch.
6. `git push --force --mirror` (temporarily allow force-push if protected).
7. Ask GitHub Support to purge cached views/PR refs of the old commits;
   check for forks (they keep the old history).
8. Everyone re-clones; delete old local clones.

Limits: copies already cloned, forked, archived or indexed keep the old URLs.
Only changing the documents' sharing settings stops someone who already has a
URL.

## 8. Remaining risks

- Authorized users can see and copy the document URLs they open (intentional).
- Shared team passwords: anyone given a password has that team's access until
  it is changed; sessions can be ended by password change, `SESSION_NOT_BEFORE`
  or secret rotation (see §1).
- Per-scope login limits can be abused to delay a team's logins for 15 minutes.
- Token mode uses a personal access token with broad account scope; `context`
  mode reduces this but must be verified first (§6 step 6).
- Old deploys and fork deploy previews (§6 steps 2 and 6) until closed.
- `script-src 'unsafe-inline'` stays in the CSP because the existing page uses
  inline handlers; stored content is never inserted as HTML.
