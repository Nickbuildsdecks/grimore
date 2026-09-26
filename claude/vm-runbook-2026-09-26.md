# VM runbook — the five items Claude cannot do

These need a human at a keyboard with VM access. Claude Code sessions here run in a cloud
container that cannot reach the VM, and the project rule is that it never touches the live VM or
production data regardless.

Roughly ten minutes end to end. Items 1 and 4 share one `psql` session; 2 and 3 share one `.env`
edit.

---

## Read this first — no v2 migration has ever run in production

`docker-compose.yml` defines `app`, `postgres`, `redis` and `caddy`. **There is no `apps/api`
service.** The deployed container runs `CMD ["node", "server.js"]` — the legacy app only.

`runMigrations` is called from exactly one place, `apps/api/src/server.ts`, which is not deployed.
`deploy-gcp.ps1` deliberately runs no migration step (its own comment explains why: the old
automatic SQLite→Postgres step was removed after it risked user-data loss).

**Therefore migrations 0004–0012 have never executed against production.** They exist in dev and
CI only. Anything described as "fixed by migration NNNN" is fixed *for the v2 API*, and reaches
production only when `apps/api` is deployed — which is a separate piece of work.

That is why item 1 below is a manual `UPDATE` rather than a deploy.

---

## 1. The shared `guest` account  ← the only live exposure here

Legacy's guest is one shared player whose password is the literal `guestpass123`, stored as an
ordinary bcrypt hash, so it answers the normal login form. Whether a row exists depends on whether
the SQLite→Postgres cutover dump carried one.

```bash
ssh <VM_USER>@<VM_IP>          # both are in your local .env
docker exec -it grimore-postgres psql -U grimore_user -d grimore_db
```

```sql
SELECT id, username, email FROM players WHERE username = 'guest';
```

**No rows** → nothing to do, and nothing ever was. Skip to item 4, you are already in psql.

**A row with `email = 'guest@grimore.local'`** → that credential works right now. Disable it:

```sql
UPDATE players
   SET password_hash = 'disabled:guest-mode-removed-0012'
 WHERE username = 'guest'
   AND email = 'guest@grimore.local'
   AND password_hash <> 'disabled:guest-mode-removed-0012';
```

This is character-for-character the body of migration `0012_retire_guest_account.sql`, and that
migration's `WHERE` excludes rows already carrying the sentinel — so when `apps/api` is eventually
deployed, 0012 runs as a no-op rather than conflicting.

The row is **not deleted**: it may own decks, collection rows and league history that a cascade
would take with it. Reversible by setting a real bcrypt hash.

**A row with a different email** → that is a real player who registered the username. Leave it
alone; the `AND email = ...` clause above already protects them.

---

## 4. Card data freshness

Same psql session:

```sql
SELECT count(*), max(last_updated) FROM scryfall_cards;
```

The Postgres bulk sync has never written a row — it named a `scryfall_id` column the table does not
have, and the import loop's `catch` (labelled "Ignore parse errors" but wrapping the write too)
discarded every rejection. Fixed in PR #19, but that fix is in `scryfallService.js`, which the
legacy container *does* run — so this one does reach production on the next deploy.

If `max(last_updated)` is the cutover date, prices and oracle text have been frozen since then and
the first successful sync will be a large one. Worth running it at a quiet hour.

`\q` to exit psql.

---

## 2 & 3. Environment variables

One edit to the VM-side `.env` (the one in the compose directory, loaded via `env_file:` — never
shipped in the deploy zip).

| Variable | Value | Urgency |
| --- | --- | --- |
| `TCGPLAYER_AFFILIATE_ID` | `xJoE0d` | **Now.** Live and wrong today. |
| `ADMIN_GOOGLE_EMAILS` | your addresses, comma-separated, exact | Before `apps/api` serves auth |
| `GOOGLE_CLIENT_ID` | your existing client id | Probably already set — confirm |

`TCGPLAYER_AFFILIATE_ID` is the one that matters immediately. `server.js:6673` reads
`process.env.TCGPLAYER_AFFILIATE_ID || 'grimore'`, so with the variable unset every legacy
purchase link has been attributed to `grimore` rather than `xJoE0d`. (`apps/web` and `apps/api`
both already default to `xJoE0d`, so only the legacy path is affected.)

`ADMIN_GOOGLE_EMAILS` has no effect until `apps/api` is deployed — legacy has its own hard-coded
list. Setting it now costs nothing and avoids a confusing surprise later (D12).

Then recreate the container so the new environment is picked up:

```bash
docker compose up -d
docker compose ps          # app should return to healthy
```

---

## 5. Scryfall allowlist — not on the VM

This is a Claude Code environment setting, not a server change. In the session title bar, open the
cloud environment menu → **Edit** → **Network access**, and either widen the access level or add:

- `api.scryfall.com` — search, named lookup, autocomplete, bulk-data manifests
- `cards.scryfall.io` — card images
- `svgs.scryfall.io` — set symbols

What it unblocks: porting card search against the real Scryfall API rather than the local
`scryfall_cards` table, and sweeping the moderation filter over the full card-name corpus — which
is the only honest measure of its false-positive rate. Nothing is broken without it.

---

## Not on this list, deliberately

**Deploying.** Four PRs merged since the last deploy (#19–#22). Whether to ship them, and when, is
your call — and the only one with production effect on the legacy app is #19's card-sync fix.
`powershell -ExecutionPolicy Bypass -File .\deploy-gcp.ps1` from your local clone, per `CLAUDE.md`.

**The sandbox room codes.** `GRIM-`+4-digit codes are enumerable and `sync-state` accepts any slot
id, so guessing a code lets anyone rewrite another player's board. Live today. The real fix is
moving Play Realm onto `apps/realtime` (D11); widening the code space in `server.js` is a
client-compatible stopgap. Neither is a runbook item — both need a decision first.
