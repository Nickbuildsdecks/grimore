# The migration cutover — exact commands, in order

Nick said "merge it and start the cutover". The merge is done. This is the cutover, and it is split
into what I have already done and what only Nick can run.

**I cannot reach the VM.** No `.env`, no `VM_IP`/`VM_USER`, an empty `~/.ssh`, and no `ssh`, `scp`,
`gcloud` or PowerShell binary in this container — checked, not assumed. The standing rule is also never
to touch the live VM. So every command below with `VM` beside it is Nick's to run.

---

## What is already done

### The deploy bundle now ships the v2 sources (`deploy-gcp.ps1`)

`$filesToCopy` was the legacy files plus `public/` and `apps/web/dist`. It now also carries
`apps/`, `packages/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, and
the three CommonJS modules legacy requires at runtime (`accountTokens.js`, `passwordPolicy.js`,
`mailer.js`) — omitting one of those would be a boot loop, not a degraded feature.

**This was tested, not just written.** PowerShell 7.4 was installed in this container, so the script
was parsed and then dry-run end to end with only `scp`, `ssh` and the health poll stubbed:

- The React build step ran for real. It had been **silently broken**: it did `Set-Location "web"`, a
  directory that does not exist (the app is `apps/web`), swallowed the output with `| Out-Null` and never
  checked `$LASTEXITCODE`. Every deploy shipped whatever `apps/web/dist` was left over from the last
  successful local build. It now builds from the workspace and aborts on failure.
- The bundle came out at 6.5 MB / 2.5 MB zipped, with all 14 migrations, all 9 workspace manifests and
  no `node_modules` or nested `dist` leaked.
- **The `apps/api` image was built from the bundle**, exactly as the VM will, and started against a
  production-shaped database. It applied migrations 0002–0014 and answered
  `/readyz` → `{"ready":true,"checks":{"db":"ok","redis":"ok"}}`.

The script also now checks itself: it reads the required manifest list out of `apps/api/Dockerfile` and
aborts if the bundle is missing any, so the next package added cannot silently break the image build on
the VM. Verified by injecting a fake requirement — exit 1, no completion banner.

### The migration set was rehearsed on a production-shaped database with data

Built `0001_baseline.sql` + `initDb()` (production's actual path), seeded rows into every table the risky
migrations touch, snapshotted, migrated, and diffed.

**Every row survived byte-identical.** The two one-way doors specifically:

- `0005` rewrites `collections.id` from integer serial to TEXT. Values became their own decimal strings
  (`1`, `2`, `3`), `collection_cards.collection_id` converted in the same transaction, and the join still
  holds.
- `0009` drops the `player_stats` and `deck_stats` primary keys and replaces them with partial unique
  indexes. Rows preserved.

Re-running the migrator afterwards applied 0 migrations. Restarting the api container was a no-op.

### Both directions of the deployment window were tested

This decides the order of operations below.

| | register | login | discover | forgot-password |
| --- | --- | --- | --- | --- |
| **New code, old schema** (after deploy, before migrate) | 200 | 200 | 200 | 503, one log warning |
| **New code, new schema** (after migrate) | 200 | 200 | 200 | works |

So **deploying is safe on its own** and does not require the migration. The site keeps working
throughout; recovery stays as broken as it already is until the migration runs, then starts working.

The epoch guard warns exactly once about the missing `sessions_valid_from` column rather than per
request, and tolerates only that one absence — any other database error fails closed.

---

## The agreed route: rehearse on staging first

We settled on a staging rehearsal rather than giving me production write access, which is the right call
and does not change any step below — it goes *in front* of them. Setup is
`claude/staging-rehearsal-setup.md`.

Worth knowing before you start it: the connection strings cannot reach this session. `docker-compose.yml`
gives postgres `expose: - "5432"` rather than `ports:`, so nothing outside the Docker network has a
listener to connect to, and this environment's egress is a domain allowlist in front of HTTP(S) rather
than raw TCP. So the rehearsal is run *on the VM* and only its output comes back to me. That runbook
says so up front rather than having you build a role and a dump first.

## What Nick runs

### Step 0 — set the three environment variables first  `VM`

Do this before anything else. Two of them are what recovery needs, and the third is what the fail-closed
mailer is waiting for. They go in the **VM-side `.env`**, which compose loads via `env_file` — not in the
deploy bundle.

```bash
# on the VM, in ~/grimore/.env
APP_BASE_URL=https://your-real-origin          # no trailing slash
SMTP_URL=smtps://user:pass@smtp.provider.com:465
MAIL_FROM=Grimore <no-reply@your-domain>
```

Any provider that speaks SMTP works; nothing in the code is tied to one. **Until `SMTP_URL` is set,
`forgot-password` returns 503 and sends nothing** — deliberately, because reporting a send that did not
happen is how the broken flow stayed invisible for so long.

While you are in that file, the two VM runbook items that are wrong right now:

```bash
TCGPLAYER_AFFILIATE_ID=xJoE0d                  # defaults to 'grimore' otherwise
```

### Step 1 — deploy the code  `LOCAL`

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-gcp.ps1
```

This ships the v2 sources and restarts the legacy container. **It does not run any migration**: the `api`
service sits behind the `v2` compose profile and the script's remote command is a plain
`docker-compose up` with no `--profile`. The script prints a reminder of that at the end.

Expected: the legacy app comes back up and behaves exactly as before, plus `/api/auth/login` now rotates
the session id and the password policy is enforced. `forgot-password` still returns 503.

**Rollback:** redeploy the previous commit. Nothing about the database has changed yet.

### Step 2 — back up the database  `VM`

This is the step that makes Step 3 reversible. Do not skip it.

```bash
cd ~/grimore
docker exec grimore-postgres pg_dump -U grimore_user grimore_db > grimore-$(date +%F-%H%M).sql
ls -lh grimore-*.sql        # confirm it is not zero bytes
```

### Step 3 — run the migrations  `VM`

The one-way door, and the step the staging rehearsal exists to de-risk. Do the rehearsal first;
migrations 0002–0014 apply on container start.

```bash
cd ~/grimore
docker compose --profile v2 up -d api
docker logs -f grimore-api            # watch each migration; Ctrl-C when it says "api listening"
```

Expect 13 `[migrate] applied ...` lines (0001 is marked applied, not re-run, because the legacy schema is
already there). If any line errors, **stop** and restore from Step 2 rather than retrying.

### Step 4 — confirm health before any traffic reaches it  `VM`

```bash
docker exec grimore-api node -e "require('http').get('http://localhost:3000/readyz',r=>r.pipe(process.stdout))"
```

Expect `{"ready":true,"checks":{"db":"ok","redis":"ok"}}`.

Then confirm the legacy app — the one actually serving users — is still fine against the migrated schema:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://your-real-origin/api/auth/me      # 200
curl -s -o /dev/null -w '%{http_code}\n' https://your-real-origin/api/decks/discover  # 200
```

### Step 5 — check that recovery now works  `VM`

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"usernameOrEmail":"your-username"}' \
  https://your-real-origin/api/auth/forgot-password
```

Expect `{"success":true,"message":"If an account matches that, ..."}` **and an email**. A 503 means
`SMTP_URL` or `APP_BASE_URL` is still missing (Step 0). A 500 means something else — check
`docker-compose logs --tail=50 app`.

### Step 6 — the remaining VM runbook item  `VM`

`0012` disables login on the shared `guest` account. Confirm:

```bash
docker exec grimore-postgres psql -U grimore_user -d grimore_db \
  -c "SELECT username, left(password_hash, 20) FROM players WHERE username = 'guest'"
```

Expect `disabled:guest-mode-r` or no row at all. If you already ran that UPDATE by hand, `0012` was a
no-op.

---

## Rollback, per step

| After | To undo |
| --- | --- |
| Step 1 (deploy) | Redeploy the previous commit. The database is untouched. |
| Step 3 (migrate) | `docker compose stop api`, then restore the Step 2 dump. The legacy app runs fine on either schema — both directions were tested. |
| Step 5 (mail) | Unset `SMTP_URL`. Recovery returns to 503 rather than failing halfway. |

Routing traffic to `apps/api` is **not** part of this cutover. That is a separate Caddy change, one
prefix at a time, and reversible by pointing the prefix back at `app`. Nothing in this runbook sends a
single user request to the new API.

## What is still not covered

- **Traffic routing to `apps/api`** — deliberately out of scope, as above.
- **The `api` container will keep running after Step 3**, applying migrations on each restart (a no-op
  once applied) and answering only `/healthz` and `/readyz` until Caddy sends it something. If you would
  rather it not run at all between cutover and routing: `docker compose stop api`. The schema change
  persists.
- **`/api/pairings/report/:podId` still has no auth check** (D17). It needs one look at the front-end
  callers before a guard goes on, because a wrong guess breaks score reporting mid-event.
