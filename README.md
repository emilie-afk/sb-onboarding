# 🌵 Employee Onboarding Site

A warm, friendly onboarding hub for new team members at Succulents Box.

## Features
- Welcome page with Day 1 checklist and tool setup guide
- Company values
- Employee handbook link (Google Docs)
- Daily tasks guide (TimeStation, #daily-updates, #attendance-teamvn)
- 5 password-protected team sections: Marketing, Customer Service, SEO, Design, Video
- Each team section has: Position Task List, EOS Files, KPI Files (by year), Handover Files, Tools
- EOS, KPI, and Handover files are Google Drive links — admin-only to add/remove, all members can view

---

## Folder Structure

```
/
├── index.html                       ← The entire site (single page)
├── netlify.toml                     ← Netlify config
├── package.json                     ← Declares @netlify/blobs dependency
├── netlify/
│   └── functions/
│       ├── check-password.js        ← Validates team + admin passwords
│       ├── get-links.js             ← Returns saved Google Drive links
│       └── manage-links.js         ← Add / remove links (admin only)
└── README.md
```

---

## Deployment

### 1. Push to GitHub
Push this folder to a **public GitHub repository**.
Passwords are **never** in the code — safe to push publicly.

### 2. Connect to Netlify
1. Log in at [netlify.com](https://netlify.com)
2. **Add new site → Import an existing project → GitHub**
3. Select your repository
4. Build settings:
   - **Build command:** `npm install`
   - **Publish directory:** `/`  *(or leave blank)*
5. Click **Deploy site**

### 3. Set Environment Variables ⚠️ Do this before sharing the URL
Go to: **Netlify → Your site → Site configuration → Environment variables**

**Team passwords** (employees use these to unlock their team section):

| Variable name              | What it does                              |
|----------------------------|-------------------------------------------|
| `PASSWORD_MARKETING`       | Unlocks the Marketing team section        |
| `PASSWORD_CUSTOMERSERVICE` | Unlocks the Customer Service section      |
| `PASSWORD_SEO`             | Unlocks the SEO section                   |
| `PASSWORD_DESIGN`          | Unlocks the Design section                |
| `PASSWORD_VIDEO`           | Unlocks the Video section                 |

**Admin passwords** (used to add/remove Google Drive file links):

| Variable name                    | What it does                                              |
|----------------------------------|-----------------------------------------------------------|
| `PASSWORD_ADMIN`                 | **Global admin** — can manage files in ALL team sections  |
| `PASSWORD_ADMIN_MARKETING`       | Team admin — can only manage Marketing files              |
| `PASSWORD_ADMIN_CUSTOMERSERVICE` | Team admin — can only manage Customer Service files       |
| `PASSWORD_ADMIN_SEO`             | Team admin — can only manage SEO files                    |
| `PASSWORD_ADMIN_DESIGN`          | Team admin — can only manage Design files                 |
| `PASSWORD_ADMIN_VIDEO`           | Team admin — can only manage Video files                  |

> Inside a team section, entering either `PASSWORD_ADMIN` (global) or the team's own `PASSWORD_ADMIN_<TEAM>` will unlock admin mode.

After adding all variables → **Deploys → Trigger deploy → Deploy site**

> ⚠️ Never put passwords in the code or GitHub.

---

## How File Links Work (EOS, KPI, Handover)

- File links are stored securely in **Netlify Blobs** (Netlify's built-in storage)
- Links persist across all users and devices
- **Admin flow:** Click "🔒 Admin: manage files" inside any team tab → enter `PASSWORD_ADMIN` → add/remove links
- **Regular users:** see links and can click to open in Google Drive, but cannot add or remove
- KPI files are organized by year (2026, 2027, etc.)

---

## Updating Task Lists, Tools & Other Content

All static content (position task lists, tools) is inside `index.html` in the `TEAM_DATA` object.
Search for `const TEAM_DATA` to find it. Edit the arrays and push to GitHub — Netlify redeploys automatically.
