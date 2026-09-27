# Nine tables the legacy server uses that do not exist on Postgres

Run it yourself against the VM (read-only, one `SELECT` against `pg_tables`):

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
