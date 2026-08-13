# Grimore

A premium, all-in-one Magic: The Gathering companion — deck building and analysis, a card search
backed by Scryfall, collection and wishlist tracking, social/discovery feeds, a live multiplayer
"Play Realm," and an AI rules advisor. Live at **https://grimore.gg**.

> Brand note: the name is intentionally spelled **Grimore**.

## Stack

- **Backend:** Node.js + Express, Socket.IO for realtime multiplayer.
- **Frontend:** vanilla HTML/CSS/JS in `public/` (the primary app), plus an optional React SPA in
  `web/` served at `/react`.
- **Data:** dual-mode via `db.js` — **SQLite** (`better-sqlite3`) for local dev, **PostgreSQL** for
  production. Redis backs sessions in production. The layer auto-selects on `POSTGRES_URL`.
- **External services:** Scryfall (card data/images/prices), Google Identity Services (sign-in),
  Google Gemini (AI advisor), Moxfield (deck import), Stripe (premium billing — test-mode scaffolding).
- **Deploy:** Docker Compose (app + Postgres + Redis + Caddy for automatic HTTPS) on a GCP VM, via
  `deploy-gcp.ps1`.

## Local development

```bash
npm install
npm run dev        # starts the Express server on http://localhost:3000 (SQLite by default)
```

Copy `.env.example` to `.env` and fill in what you need (all are optional for a basic local run;
missing integrations degrade gracefully rather than crash):

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Session cookie signing (required in production; random fallback in dev). |
| `GOOGLE_CLIENT_ID` | "Sign in with Google". |
| `GEMINI_API_KEY` | AI rules advisor / AI opponent. |
| `MOXFIELD_USER_AGENT` | Whitelisted Moxfield crawler UA for deck import. |
| `POSTGRES_URL` | Set to use Postgres instead of SQLite. |
| `REDIS_URL` | Session store in production. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Admin bootstrap (random password generated if unset). |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` | Premium billing (test mode). |
| `PREMIUM_GATING` | `off` (default) or `on` — gates premium features. |
| `FREE_DECK_LIMIT` | Deck count allowed on the free tier (default 25). |

## Quality gates

```bash
npm run preflight   # node --check every JS file + CSS brace-balance; BLOCKS a broken deploy.
npm run test:unit   # pure-JS behavioral suite (recommendation, multiplayer, safety scripts, billing).
```

`preflight` also runs automatically as step 0 of `deploy-gcp.ps1`, so a parse-broken file can never
ship. The unit suite needs no server or database — it runs anywhere Node does.

## Premium billing (Stripe)

Billing is **scaffolded in test mode and disabled by default** (`PREMIUM_GATING=off`, and inert with
no Stripe key). It gates only Grimore's own technology (AI advisor, advanced analytics, deck count) —
never card data, images, search, or basic deck viewing, per the WotC Fan Content Policy and Scryfall
terms. To enable: `npm install stripe`, set the test keys in `.env`, configure the webhook endpoint
(`/api/billing/webhook`) in the Stripe dashboard, then set `PREMIUM_GATING=on`. See `billing.js` and
`docs/DEPLOY_CHECKLIST.md`.

## Project layout

```
server.js              Express app + all HTTP routes + Socket.IO wiring
db.js                  Dual-mode (SQLite/Postgres) data layer + schema/migrations
billing.js             Stripe premium scaffolding (flag-dark)
multiplayer.js         Socket.IO pod/game engine
scryfallService.js     Scryfall bulk import + pricing
mtgjsonService.js      MTGJSON import (admin)
public/                The primary frontend (index.html, app.js, page JS, CSS)
web/                   Optional React SPA, served at /react
execution/             Maintenance scripts + the recommendation engine
scripts/preflight.js   Pre-deploy parse/brace gate
test/                  Pure-JS behavioral tests (run with npm run test:unit)
docs/                  API reference + deploy checklist
```

## Deploy

Production runs via Docker Compose behind Caddy (auto-HTTPS). From a Windows machine with the repo:

```powershell
.\deploy-gcp.ps1     # runs preflight, builds, ships to the VM, restarts containers
```

Production data lives only on the VM's Postgres volume — never re-seeded from a dev machine. See
`docs/DEPLOY_CHECKLIST.md` before shipping.
