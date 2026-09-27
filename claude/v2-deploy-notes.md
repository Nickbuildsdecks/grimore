# Deploying `apps/api` — what exists, what is missing, what it costs

## The problem this addresses

`docker-compose.yml` had no `api` service. Production runs `CMD ["node", "server.js"]` and nothing
else, `runMigrations` is called only from `apps/api/src/server.ts`, and `deploy-gcp.ps1`
deliberately runs no migration step.

So **every v2 change is shelfware**: 99 ported routes, migrations 0002-0012, and the whole typed
contract layer have never executed against production, and cannot until something deploys them.
Nothing in the repo was even capable of building that image.

## What now exists

**`apps/api/Dockerfile`** — a multi-stage production image, built and exercised for real rather
than written and hoped for. Against a fresh Postgres 16 and Redis 7:

| Check | Result |
| --- | --- |
| All 12 migrations apply on an empty database | yes, `0002` through `0012` in order |
| `/healthz` | `{"status":"ok"}` |
| `/readyz` | `{"ready":true,"checks":{"db":"ok","redis":"ok"}}` |
| register → login | 201, then 200 with the player |
| deck save, `Scrap Mastery` | accepted — the moderation fix is live in the image |
| deck save, a profane name | `{"error":{"code":"PROFANITY", ...}}` |
| unknown player | `{"error":{"code":"NOT_FOUND", ...}}` — typed codes intact |

Two things the build surfaced that reading would not have:

- `tsconfig.base.json` has to be in the image; every `packages/*` tsconfig extends it, and without
  it `tsc` loses its `lib` setting and fails on `Set` and `Map`.
- Every workspace member's `package.json` must be copied before `pnpm install --frozen-lockfile`,
  including ones the image never builds, or the lockfile is judged out of sync.

The image also asserts at build time that `packages/db/migrations/0001_baseline.sql` and
`apps/api/dist/server.js` both exist, so a packaging mistake fails the build rather than the first
container start.

**A `docker-compose.yml` service, behind the `v2` profile.** `docker compose config --services`
lists `postgres redis app caddy`; only `--profile v2` adds `api`. A plain `docker compose up -d` on
the VM behaves exactly as it does today.

## What is still missing — this cannot be deployed yet

**`deploy-gcp.ps1` does not ship the sources the image needs.** Its `$filesToCopy` list is the
legacy files plus `public/` and `apps/web/dist`. There is no `apps/api`, no `packages/`, no
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json` or `tsconfig.base.json`.

That change was deliberately not made here. The script is PowerShell that cannot be run or tested
from this environment, and a broken deploy script is worse than a missing one.

## The cutover, in the order it has to happen

1. **Extend the deploy bundle** — add `apps/api`, `packages/`, `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` to `$filesToCopy`. Test it by deploying
   and confirming the *legacy* app still comes up; the api profile stays off.
2. **Back up the database.** Step 3 is the one-way door.
   ```bash
   docker exec grimore-postgres pg_dump -U grimore_user grimore_db > grimore-$(date +%F).sql
   ```
3. **Run the migrations, deliberately.** `docker compose --profile v2 up -d api`. The container
   applies 0002-0012 on start and logs each one. Watch with `docker logs -f grimore-api`.
   - `0005` rewrites `collections.id` from integer to text, preserving data.
   - `0009` replaces the `player_stats` and `deck_stats` primary keys with partial unique indexes.
   - `0012` disables login on the shared `guest` account — see `claude/vm-runbook-2026-09-26.md`.
     If you have already run that UPDATE by hand, 0012 is a no-op.
4. **Confirm it is healthy before any traffic reaches it.** `docker exec grimore-api node -e` against
   `/readyz`, or from the `app` container, since nothing is routed to it yet.
5. **Route traffic, one prefix at a time.** The Caddyfile is untouched by this change. Moving a
   route group is a Caddy edit, and it is reversible: point the prefix back at `app`.

## Environment variables the api container needs

Loaded from the VM-side `.env` via `env_file`, plus what compose passes explicitly:

| Variable | Notes |
| --- | --- |
| `SESSION_SECRET` | Must be 32+ characters or the app refuses to start in production |
| `GOOGLE_CLIENT_ID` | Without it, Google sign-in refuses every credential by design |
| `ADMIN_GOOGLE_EMAILS` | Comma-separated exact addresses; empty means no Google admin mapping (D12) |
| `POSTGRES_PASSWORD` | Already set; compose builds `DATABASE_URL` from it |

`DATABASE_URL` and `REDIS_URL` are constructed in compose — do not also set them in `.env`, or the
`environment:` block and `env_file` will disagree.

## Why the session cookie appears broken over plain HTTP

Probing the container directly with `curl` over `http://` looks like a login failure: the login
returns 200 but the next request is `UNAUTHENTICATED`. That is `secure: env.NODE_ENV === 'production'`
doing its job — the cookie is marked Secure and a client will not return it over plain HTTP. Behind
Caddy, which terminates TLS and sets `X-Forwarded-Proto`, it works. Do not "fix" this by weakening
the cookie.
