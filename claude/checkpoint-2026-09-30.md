# Checkpoint — 2026-09-30

Picking up the item the overnight session deliberately left: the five column mismatches where
`server.js` writes a name the Postgres schema does not have. They were left because "each wants its
route exercised end to end afterwards, rather than being changed on inspection" — so that is what was
built first.

## What was broken, and how it was proven

Booted `server.js` against a Postgres database, drove the routes over HTTP, read the server's own log:

```
error: column "followed_id" does not exist          <- POST /api/players/:id/follow
Failed to add card to collection: error: column "scryfall_id" does not exist
[DB Sanitize] Error ...: column sc.scryfall_id does not exist    <- on every boot, swallowed
```

So on Postgres: following someone, unfollowing, checking whether you follow someone, and adding a
card to a collection all returned 500 — while CI was green, because CI runs the legacy server on
SQLite and `db.js` builds a different table per dialect under the same name.

## What changed

**Three of the five mismatches are fixed** as dialect constants beside the ones #29 added, rather
than as edits at each call site — the call sites are what drifted:

| Constant | Closes |
| --- | --- |
| `FOLLOWED_COLUMN` | `follows.followed_id` → `following_id`, at all four call sites |
| `SCRYFALL_ID_COLUMN` | `scryfall_cards.scryfall_id` → `id`, on reads |
| `SQL_UPSERT_COLLECTION_CARD` | `is_foil` → `foil`, **and** the `ON CONFLICT` target |
| `SQL_RESTORE_COLLECTION_CARD` | `is_foil`/`added_at` on the recovery restore path |

Two were more than renames. The collection upsert's uniqueness is a plain column tuple on SQLite but
an *expression* index on Postgres, and Postgres rejects an `ON CONFLICT` target that does not restate
the expressions exactly. And the recovery archive is built with `SELECT *`, so it carries whichever
dialect was live when the collection was deleted — the restore reads both spellings and writes only
the local one.

**Three more bugs surfaced by driving the routes:**

- Adding a card to a collection returned **500 after writing the row** on any database without
  `wishlist_cards` — every add on SQLite, and every add on Postgres until migration 0008 runs. The
  wishlist decrement is a side effect that shared the route's try/catch. Because the insert is an
  upsert, a user retrying after that 500 silently doubled their quantity.
- `COLLATE NOCASE` in the wishlist decrement is SQLite-only, so decrementing a wishlist entry failed
  on Postgres even once the table existed.
- The boot-time `deck_cards` UUID sanitizer has never run on Postgres, logging its own error and
  moving on, on every boot since the cutover.

## The part that stops this recurring

`test/postgres-write-paths.test.js` + a `legacy-postgres` CI job. It boots the real server against a
throwaway Postgres database, drives the routes the way a browser does, and then reads the rows back
with SQL — a 200 is not the assertion, the row is. This is the first time the legacy server is
exercised on the dialect it ships on.

Seven checks. **All seven fail on the code as it was**, verified by reverting and re-running, and the
sanitizer check was verified individually by reverting only its one-line fix — a guard that passes
either way is worthless. The suite skips when `POSTGRES_TEST_URL` is unset but *throws* when `CI` is
set, so a misconfigured job cannot report skips as a pass.

The schema-gap audit also had to be taught that a ternary's SQLite branch is not a Postgres claim, or
it reports the fixed columns as still broken. Checked for the opposite error too: a bogus column
injected into a Postgres branch is still reported.

## Deliberately not done

- **`card_price_cache.last_updated` and `scryfall_cards.scryfall_id`** — both inside
  `INSERT OR REPLACE`, both needing a unique constraint Postgres does not have. The application-code
  upsert was considered and rejected: it races, and `card_price_cache` is read through a JOIN, so a
  duplicate row duplicates rows in card lists. See D15.
- **The SQLite duplicate-row divergence.** Adding the same card twice duplicates instead of
  incrementing, because SQLite's primary key includes the nullable `scryfall_id` and NULL never
  conflicts with NULL. Pre-existing (verified against unmodified `server.js`, where both adds also
  500'd). Fixing it needs a unique expression index, and creating one on a dev database that already
  holds duplicates fails — leaving the `ON CONFLICT` target pointing at nothing, which is worse.
  SQLite is the local dev store only.

## Where the numbers land now

`node scripts/audit-postgres-schema-gap.js "$POSTGRES_URL"`

| | tables missing | columns missing |
| --- | --- | --- |
| **Today** — baseline + `initDb` | 9 (unchanged) | 12 → **9** |
| **After a cutover** — + migrations | 2 (unchanged) | 5 → **2** |

The table counts are untouched by design: seven of the nine are fixed by migrations that have never
run, which is deployment work, not a code change.

## Verification

Postgres 16 and Redis 7 running locally, nothing mocked.

| Suite | Result |
| --- | --- |
| `npm run test:postgres` (new) | 7 passed |
| `npm run test:unit` (legacy, SQLite) | 38 passed |
| v2 — `packages/*` + `apps/*` | 436 passed, 0 skipped |
| `node scripts/guards.js` | OK |
| `npm run preflight` | OK (1 pre-existing emoji warning) |
| SQLite route smoke, same sequence | no regression; add-card now 200, was 500 |

Nothing in this session touched the VM, production data, or `deploy-gcp.ps1`. The five items in
`claude/vm-runbook-2026-09-26.md` are all still waiting.
