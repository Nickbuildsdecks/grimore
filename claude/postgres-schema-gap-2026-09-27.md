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

Twelve such columns today, across seven tables. Most are closed by the migrations; **five are not,
and they are not schema problems at all — they are `server.js` writing the wrong column name**:

| Table | `server.js` writes | Postgres has |
| --- | --- | --- |
| `follows` | `followed_id` | `following_id` |
| `collection_cards` | `is_foil` | `foil` |
| `collection_cards` | `added_at` | (nothing — `created_at` defaults) |
| `card_price_cache` | `last_updated` | `cached_at` |
| `scryfall_cards` | `scryfall_id` | `id` |

So following a player and adding a card to a collection both fail on Postgres, and would keep
failing after a migration cutover. Each is a one-line dialect-aware fix in `server.js`, and none
needs a schema change — but each wants its route exercised end to end afterwards, the way
registration was in #29, rather than being changed on inspection.

## The three-way comparison

Same audit, three databases:

| | tables missing | columns missing |
| --- | --- | --- |
| **Today** — baseline + `initDb` | 9 | 12 across 7 tables |
| Migrations only (not a real state) | 2 | 6 across 5 |
| **After a cutover** — baseline + `initDb` + migrations | **2** | **5 across 4** |

The middle row is included because it is the tempting one to quote and it is misleading: a database
with migrations but no `initDb` is not a state that exists, and reading it as "after the cutover"
overstates one gap that `initDb` closes.

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
