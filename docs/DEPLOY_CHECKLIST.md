# Grimore — Deploy Checklist

Run through this before shipping to production (grimore.gg). Deploy is `.\deploy-gcp.ps1` from a
Windows machine with the repo; it runs preflight, builds the React bundle, ships a zip to the GCP VM,
and restarts the Docker Compose stack (app + Postgres + Redis + Caddy).

## Pre-flight (local, before running the deploy script)
- [ ] `npm run preflight` → `[preflight] OK.` (no hard failures). This also runs as step 0 of the
      deploy script and aborts the deploy on any parse/brace error.
- [ ] `npm run test:unit` → all green (recommendation + multiplayer + safety scripts + billing).
- [ ] `git status` clean or intended; you are deploying the commit you think you are.
- [ ] No secrets added to tracked files (`.env` is gitignored; `.env.example` holds placeholders only).

## Data safety (the historically dangerous area)
- [ ] The deploy script does NOT ship `grimore.db` and does NOT auto-run the SQLite→Postgres
      migration. Production data lives only on the VM Postgres volume.
- [ ] If you must run a one-time migration: back up Postgres first, then run
      `execution/migrate_sqlite_to_postgres.js` manually with `FORCE_RESEED=1` only if intended.
- [ ] Never run the `execution/*cleanup*`/`*purge*` scripts against production without explicit
      `--confirm` and explicit IDs (they refuse otherwise by design).

## Secrets / environment (on the VM, in `~/grimore/.env` — never in the repo zip)
- [ ] `SESSION_SECRET` set to a strong random value (app refuses to boot in production without it).
- [ ] `GOOGLE_CLIENT_ID`, `GEMINI_API_KEY`, `MOXFIELD_USER_AGENT` present.
- [ ] `POSTGRES_PASSWORD` set (rotate from any old default).
- [ ] Google OAuth: `https://grimore.gg` and `https://www.grimore.gg` are Authorized JavaScript
      origins for the OAuth client.

## Premium billing (only when enabling — it ships disabled)
- [ ] `npm install stripe` has been run (adds the SDK to package.json + lockfile).
- [ ] Test keys in `.env`: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`.
- [ ] Stripe dashboard webhook points at `https://grimore.gg/api/billing/webhook`
      (events: `checkout.session.completed`, `customer.subscription.updated|deleted`).
- [ ] Verified locally with the Stripe CLI (`stripe listen` + trigger events); a player flips to
      `active` on checkout and a duplicate event is a no-op.
- [ ] Billing copy gates only Grimore technology — never card data/images/search/basic deck viewing.
- [ ] Flip `PREMIUM_GATING=on` only after the above; leave `off` to ship the scaffolding dark.

## Post-deploy verification
- [ ] `https://grimore.gg/health` → `{"status":"ok"}`.
- [ ] Landing page renders; password login and "Sign in with Google" both work.
- [ ] `https://grimore.gg/api/decks/discover` returns decks; card search returns images + prices.
- [ ] Spot-check the Play Realm and deck builder in a browser.
- [ ] Containers healthy: `sudo docker-compose ps` (app/postgres/redis/caddy all healthy).

## Rollback
- [ ] Keep the previous image/commit noted. To roll back, redeploy the prior commit (data is
      untouched by deploys — only the app container changes).
