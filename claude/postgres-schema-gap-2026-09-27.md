# What the legacy server writes that Postgres does not have

Run it yourself against the VM (read-only: one `SELECT` against `pg_tables`, one against
`information_schema.columns`):

```bash
node scripts/audit-postgres-schema-gap.js "$POSTGRES_URL"
```

## What it reports today

Against a database built the way production was — `0001_baseline.sql` plus whatever `db.js`'s
`initDb()` adds at startup:

| Table | Feature it backs | Created by |
| --- | --- | --- |
| `active_roster` | league check-in | migration `0009` |
| `pods` | league pods | migration `0009` |
| `pod_results` | league results and standings | migration `0009` |
| `wishlist_cards` | wishlist | migration `0008` |
| `friend_requests` | friend requests | migration `0007` |
| `deleted_items` | deleted-item recovery | migration `0003`, and `db.js` **SQLite branch only** |
| `price_movers` | the Movers & Shakers ticker | migration `0011` |
| `direct_messages` | direct messaging | **nothing** |
| `password_resets` | password reset | **nothing** |

Every one of these is referenced by `server.js` with `FROM`, `INTO`, `UPDATE` or `JOIN`. On
Postgres each raises `relation "..." does not exist`, so the feature is not degraded — it is dead.

## The part that matters

**Seven of the nine are already fixed by migrations that have never run.**

Running the same audit against a database with all twelve migrations applied reports only two
missing — `direct_messages` and `password_resets`, the two nothing creates. That is the control,
and it is the whole argument:

```
against baseline + initDb   ->  9 tables missing
against all migrations      ->  2 tables missing
```

The v2 migrations are usually described as groundwork for `apps/api`. They are also, right now, the
fix for seven broken features in the app that is actually serving users. That reframes the
deployment work in `claude/v2-deploy-notes.md`: it is not only about shipping the new API.

Note this does **not** mean the features work the moment the tables exist — `server.js` still writes
SQLite-only syntax at nine sites (see the ratchet in `scripts/guards.js`), and `active_roster` and
the standings updates are among them. Creating the table removes the "relation does not exist"
error; the `INSERT OR REPLACE` above it is the next one.

## A table can exist and still be the wrong shape

`db.js` builds a different table for each dialect under the same name, and `server.js` writes the
SQLite spelling. The table check never sees this: the table is there, the INSERT still fails with
`column "..." does not exist`.

Twelve such columns when this was written, across seven tables. Most are closed by the migrations;
five were not, and were not schema problems at all — `server.js` simply wrote the wrong name:

| Table | `server.js` wrote | Postgres has | Now |
| --- | --- | --- | --- |
| `follows` | `followed_id` | `following_id` | fixed |
| `collection_cards` | `is_foil` | `foil` | fixed |
| `collection_cards` | `added_at` | `created_at` | fixed |
| `scryfall_cards` | `scryfall_id` | `id` | fixed on reads; the two writes are deferred, below |
| `card_price_cache` | `last_updated` | `cached_at` | deferred, below |

**Three of the five are fixed, each proven by driving its route over HTTP against a real Postgres
database and then reading the row back with SQL** — `test/postgres-write-paths.test.js`, run in CI by
the `legacy-postgres` job. Every one of its seven checks fails on the code as it was.

The fixes are dialect constants next to the ones #29 added (`FOLLOWED_COLUMN`, `SCRYFALL_ID_COLUMN`,
`SQL_UPSERT_COLLECTION_CARD`, `SQL_RESTORE_COLLECTION_CARD`), not edits at each call site, because
the call sites are what drifted.

Two of them turned out to be more than a rename:

- **The collection upsert.** Renaming `is_foil` is not enough: the uniqueness that makes the route an
  upsert is a plain column tuple on SQLite but an *expression* index on Postgres,
  `(collection_id, lower(card_name), COALESCE(scryfall_id, ''), foil, condition, language)`. Postgres
  rejects an `ON CONFLICT` target that does not restate those expressions exactly, so the clause had
  to be written per dialect.
- **The recovery restore.** The archive in `deleted_items.data` is built with `SELECT *`, so it
  carries whichever dialect's column names were live when the collection was deleted — and a
  collection deleted on SQLite may well be restored after a Postgres cutover. The restore now reads
  `c.foil ?? c.is_foil` and `c.created_at ?? c.added_at`, and writes only the local spelling.

### Still deferred: the two `INSERT OR REPLACE` writes

`card_price_cache.last_updated` and `scryfall_cards.scryfall_id` are both inside
`INSERT OR REPLACE` statements, and those need a unique constraint that the Postgres schema does not
have — `card_price_cache` is keyed by a surrogate `id` with only a *non-unique* `lower(card_name)`
index, where SQLite makes `card_name` the primary key.

Doing the upsert in application code instead (UPDATE, then INSERT if nothing matched) was considered
and rejected: two concurrent callers can both insert, and `card_price_cache` is read through a JOIN,
so a duplicate row duplicates rows in card lists. The honest fix is a unique index plus a dedupe of
whatever is already on the VM, which is a schema decision.

One consequence worth stating plainly: the printings-gallery `UPDATE scryfall_cards` beside them was
fixed (on Postgres the UUID is the primary key, so only the price can be updated), but it is
**unreachable on Postgres until the `INSERT OR REPLACE` above it is fixed** — that one throws first
and the shared catch swallows both. So gallery price caching is still dead on Postgres.

## The three-way comparison

Same audit, three databases:

| | tables missing | columns missing (then → now) |
| --- | --- | --- |
| **Today** — baseline + `initDb` | 9 | 12 across 7 → **9 across 6** |
| Migrations only (not a real state) | 2 | 6 across 5 |
| **After a cutover** — baseline + `initDb` + migrations | **2** | 5 across 4 → **2 across 2** |

The middle row is included because it is the tempting one to quote and it is misleading: a database
with migrations but no `initDb` is not a state that exists, and reading it as "after the cutover"
overstates one gap that `initDb` closes.

The audit had to learn something to report those figures honestly. A dialect-aware statement is a
ternary on `db.isPostgres`, so its SQLite branch still contains `is_foil` and `added_at` in the
source — and the audit, matching INSERT column lists, counted them and reported a *fixed* mismatch as
still broken. It now skips lines that open the SQLite branch (they begin with `:`), the same test the
ratchet in `scripts/guards.js` uses. Verified not to have become blind in the process: a bogus column
injected into a Postgres branch is still reported.

## `direct_messages` and `password_resets`

No definition exists anywhere — not in `db.js`'s Postgres branch, not in `db.js`'s SQLite branch,
not in any migration. Messaging and password reset cannot work on either dialect without one.

Not written here, deliberately. Inventing a schema for a feature by reading its INSERT statements
is guesswork, and both want a decision about shape — particularly `password_resets`, where token
lifetime, single-use semantics and cleanup are security-relevant.

## Why the audit is shaped the way it is

Two wrong turns worth recording, because both produce a confident and useless answer:

**Matching table names against raw source.** `FROM`, `INTO` and `UPDATE` appear constantly in
English comments, so the first run reported `the`, `your`, `it` and `crashing` as missing tables and
buried the real findings.

**Extracting SQL string literals with regexes.** A quote regex pairs an apostrophe in one comment
with a quote hundreds of lines later and returns a slab of JavaScript, so the "SQL" it yields is
prose again. Tightening it to statements that *start* with a verb dropped the reference count from
46 to 27 and silently lost `password_resets` and `deleted_items` — false negatives in an audit whose
entire purpose is to notice what is missing, which is worse than the noise it replaced.

What it does instead: a candidate is kept if it is a table defined somewhere in the repo, or if it
is snake_case with an underscore. The first rule is exact for anything with a definition; the second
catches the tables defined nowhere, which is the case a definition-based check would miss entirely.

## Found by exercising the routes, not by reading them

Four things that only showed up once the routes were actually driven. Three are fixed; the fourth is
recorded rather than half-fixed.

**Adding a card to a collection returned 500 on every database without `wishlist_cards` — after
writing the row.** The wishlist auto-decrement is a side effect that runs after the card is already
in the collection, and it was inside the route's single try/catch, so a missing table reported the
add as failed. Because the insert above it is an upsert, a user who retried after that 500 silently
doubled their quantity. That was *every* add on SQLite (`initDb` never creates `wishlist_cards`) and
every add on Postgres until migration 0008 runs. The side effect now has its own catch and logs.

**`COLLATE NOCASE` in the wishlist decrement.** SQLite-only, a syntax error on Postgres, so
decrementing a wishlist entry — as opposed to clearing it — failed there even once the table existed.
Replaced with `LOWER(card_name) = LOWER(?)`, which matches the DELETE directly above it and works in
both dialects.

**The boot-time `deck_cards` UUID sanitizer has never run on Postgres.** It joins `scryfall_cards` on
the dialect-specific UUID column and swallows its own errors into a `console.error`, so every boot
logged `[DB Sanitize] Error ... column sc.scryfall_id does not exist` and moved on. Fixed, and
asserted: the suite reads the server's own boot log.

That assertion needed two things to be worth having. `Database initialized successfully` is logged
*partway* through the boot chain — before the Scryfall sync and before the sanitizer — so a test
keying off it would have passed vacuously. The chain now ends with `Startup tasks complete.`, which
is what the suite waits for, and which also tells an operator reading logs when startup actually
finished. And `SKIP_SCRYFALL_BULK_SYNC=1` (opt-in, off by default) stops CI downloading the whole
oracle-cards dump on every boot, which would otherwise delay the sanitizer past any timeout.

**Not fixed: on SQLite, adding the same card twice duplicates the row instead of incrementing.**
SQLite's `collection_cards` primary key includes the nullable `scryfall_id`, and NULL never conflicts
with NULL, so a card with no resolved UUID gets a second row. Whoever built the Postgres schema knew
this — its index wraps the column in `COALESCE(scryfall_id, '')`. Verified pre-existing against
unmodified `server.js`, where both adds *also* returned 500. Not fixed here: it needs a unique
expression index on SQLite, and creating one on a developer database that already holds duplicates
fails, which would leave the `ON CONFLICT` target pointing at an index that does not exist — a worse
failure than the one it replaces. SQLite is the local dev store only, so this affects no user.
