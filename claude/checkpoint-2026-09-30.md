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

## Second pass: the league and standings writes

The overnight report said of the nine remaining `INSERT OR REPLACE` statements that "each needs a
unique constraint the production schema does not have". **That is true of five, not nine.** The
constraints were checked this time rather than assumed:

```
active_roster   PRIMARY KEY (player_id)
player_stats    UNIQUE (player_id, season_id) WHERE season_id IS NOT NULL   -- migration 0009
deck_stats      UNIQUE (deck_id, season_id)   WHERE season_id IS NOT NULL   -- migration 0009
```

So four were fixable with no schema change, and the ratchet drops from 9 to 5. Two things had to be
established against a real Postgres first, not read off the docs:

- **Postgres will infer a *partial* unique index, but only if the statement restates its predicate.**
  `ON CONFLICT (player_id, season_id) WHERE season_id IS NOT NULL` works; the identical statement
  without the `WHERE` is rejected with "there is no unique or exclusion constraint matching the ON
  CONFLICT specification". The predicate is load-bearing, not decoration. Both rebuilds always pass a
  non-null season id, so they always land in that half of the split.
- **`INSERT OR REPLACE` and `ON CONFLICT DO UPDATE` are not the same statement.** SQLite's REPLACE
  deletes and reinserts, so unnamed columns revert to their defaults; `DO UPDATE` leaves them alone.
  Only `active_roster.checked_in_at` is affected here, and refreshing it on a re-check-in is the
  right behaviour anyway, so it is set explicitly rather than allowed to diverge quietly.

Two more suite checks cover it — check-in replacing in place, and a pod score rebuilding both
standings tables, then being re-reported to prove the upsert updates rather than duplicating. Both
fail with **only** the four league statements reverted and the rest of the fixes left in, so they
guard exactly what they claim to.

The SQLite branches were exercised too, though not through the routes: `db.js` creates
`active_roster`, `pods` and `pod_results` in **neither** dialect. The whole league feature — check-in,
pairings, pods, standings — is dead on any database `initDb` built, on both dialects, until migration
0009 runs. So the statements were run directly against tables shaped the way 0009 defines them: one
row after a re-check-in, the newer deck winning, two seasons coexisting, a re-report overwriting.

### A live bug found on the way, and a correction to #29

On production Postgres today `player_stats` is `PRIMARY KEY (player_id)` — **season is not in the
key**. The untargeted `ON CONFLICT DO NOTHING` that #29 introduced therefore does nothing at all for a
player's second season:

```
INSERT INTO player_stats (player_id, season_id) VALUES ('pq1','sq1') ON CONFLICT DO NOTHING;  -- INSERT 0 1
INSERT INTO player_stats (player_id, season_id) VALUES ('pq1','sq2') ON CONFLICT DO NOTHING;  -- INSERT 0 0
-> one row, season sq1 only
```

A returning player appears in season one's standings and is simply absent from season two's. Silently
— no error, no 500. #29 was still an improvement (before it, registration 500'd and left an orphaned
account), but its PR body did not say this and should have.

**This one cannot be fixed in code.** Today's primary key physically cannot hold two seasons for one
player; an application-level check-then-insert would hit the same key. Migration 0009 replaces it with
the two partial unique indexes. That makes it a third thing the never-run migrations fix in the app
serving users right now, alongside the seven dead tables — the cutover in `claude/v2-deploy-notes.md`
is worth more again, not less.

The same comparison on SQLite, for contrast: its `player_stats` is `PRIMARY KEY (player_id,
season_id)`, so two seasons coexist there. Verified. The dialects disagree about the shape of the
league itself.

### Noticed, not changed: `/api/pairings/report/:podId` has no auth check

It mutates `pod_results`, marks the pod complete and rebuilds every standings row in the season, and
there is no `req.session.player` check — the comment above it says "Can be submitted by players or
admin", so a session was clearly intended. Left alone deliberately: adding one is an authorization
change, and whether the client relies on calling it unauthenticated has to be established first
rather than guessed. Flagged here because it is the kind of thing that gets read past.

## Third pass: the cache writes, and one unique index

Nick approved the migration route for the remaining statements. Investigating before writing it
changed the answer in two ways worth stating, because both correct what I had told him:

- **`scryfall_cards` needed no index.** Its Postgres primary key *is* the Scryfall UUID, and
  `scryfallService.js`'s bulk upsert already targets it. The legacy statement is now the same shape as
  that one, so the two writers cannot disagree about what a row means.
- **`apps/api/src/routes/decks.ts` had already shipped the application-level upsert I said I had
  rejected as racy** — a select-then-update-or-insert, because no constraint existed. It is a real
  upsert now, which closes that race rather than leaving the two codebases disagreeing.

So one migration, `0013`: deduplicate `card_price_cache`, then add `UNIQUE (LOWER(card_name))` — in
that order, in the one transaction the migrator wraps it in, because the index cannot be built while
duplicates exist and a half-applied state leaves the upsert with no target. Newest row wins. Verified
against a table seeded with duplicates on purpose, mixed casing and a NULL `cached_at` included: 6
rows to 3, the right survivor each time, idempotent on re-run.

`LOWER(card_name)` is the key because the table is per-name in practice, not per-printing: nothing has
ever written a meaningful set code or collector number into it, the SQLite→Postgres migration script
drops those NOT NULL constraints, and every reader joins on `LOWER(pc.card_name)` alone. Per-printing
prices live in `scryfall_cards`, where printings differ by UUID.

**Ratchet 5 → 1.** The one survivor is `password_resets`, whose table is defined nowhere in either
dialect — the account work, not a dialect fix.

Two v2 fixtures seed duplicate cache rows on purpose, to hold the readers to not fanning out. Neither
lost its guard: each drops the index for its own scope and recreates the condition deliberately, since
the index is new and a pre-0013 backup restore would reintroduce duplicates silently.

### A mis-cased reprice was poisoning the shared cache

Test 11 failed for a reason I had not predicted. `/api/decks/reprice-card` matched its card with an
exact `card_name = ?`, so a caller whose casing differed found nothing, fell back to the `0.10`
default, and wrote that 10c into `card_price_cache` — which is shared, so one mis-cased reprice priced
that card at 10c for every user and every deck. Now `LOWER()` on both sides. Recorded as D19.

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
| `npm run test:postgres` (new) | 12 passed |
| `npm run test:unit` (legacy, SQLite) | 38 passed |
| v2 — `packages/*` + `apps/*` | 436 passed, 0 skipped |
| `node scripts/guards.js` | OK |
| `npm run preflight` | OK (1 pre-existing emoji warning) |
| SQLite route smoke, same sequence | no regression; add-card now 200, was 500 |
| SQLite league branches, run directly | one row per re-check-in, two seasons coexist, re-report overwrites |
| `KNOWN_SQLITE_ONLY` ratchet | 9 → 1, and still rejects an injected new one |
| Migration 0013 dedupe | 6 duplicate rows → 3, newest survivor, idempotent |

Nothing in this session touched the VM, production data, or `deploy-gcp.ps1`. The five items in
`claude/vm-runbook-2026-09-26.md` are all still waiting.

---

# Fourth pass: the account system

Nick asked for the account side to be brought to industry standard: "figure out what the industry
standard is and make the full system with all necessary parts." The design, the eleven findings and the
standards they are measured against are in `claude/account-system-design.md`; this is the summary.

**Password recovery had never worked**, and the code around it was worse than merely broken: the token
was stored as issued, the whole link was written to stdout on every request, the row keyed on a username
this app lets people change, and `devResetLink` was exposed by the absence of one environment variable
rather than the presence of a flag.

**Built:** migration 0014, a shared token discipline, `@grimore/mailer` that fails closed, session-epoch
enforcement in both apps, a real password policy, an audit trail, per-account throttling, and the
recovery and verification flows end to end including the front-end wiring.

`KNOWN_SQLITE_ONLY` reached **0** on the way, because `password_resets` was the last of the nine.

## Three times I was wrong, and how each was caught

Recording these together because the pattern is the point: none of them were caught by reading.

1. **I told Nick `scryfall_cards` needed a unique index, and that the application-level upsert was too
   racy to use.** Investigating before writing the migration showed the Postgres primary key already
   *is* the Scryfall UUID, and that `apps/api/routes/decks.ts` had already shipped the very upsert I had
   dismissed. Caught by checking the repository instead of my own earlier claim.

2. **I wrote a comment saying legacy read `sessions_valid_from`. Nothing read it anywhere.** So the
   password reset signed nobody out, and the comment asserted a security property the code did not
   provide — the identical mistake this work criticises `players.ts` for, committed in the act of fixing
   it. Caught by going back to verify my own comment.

3. **The recovery link pointed at a page that could not handle it.** `/reset-password?token=` returns
   200 from both front ends, because every unmatched GET falls through to a SPA shell. But `app.js`
   reads the token at `/`, and that path serves the React shell whose router has `basename="/react"`.
   Correct server logic, plausible URL, 200 response, dead flow. Caught by requesting both paths against
   a running server and comparing the documents.

The common thread: each looked right in the source and was wrong in the running system. The first was
caught by distrusting a claim I had made; the second by re-reading my own comment as though someone else
had written it; the third only by making the request.

## Two guards that earned their keep on my own work

- The **Dockerfile manifest guard** (written in the first pass today) caught that I had not added
  `packages/mailer/package.json` to the image — which would have failed the build on
  `--frozen-lockfile`.
- The **`apps/api` recovery suite** caught the link-shape change immediately, because its helper scraped
  `/token=/` and `resetToken=` does not match it. A test noticing a contract change is the whole point.

## Where the account work stops

Three config decisions are Nick's, and the first gates the flow: an SMTP provider plus `MAIL_FROM`, and
`APP_BASE_URL`. Until `SMTP_URL` is set, sends throw — deliberately, because the alternative is
reporting a send that did not happen, which is exactly how the broken flow stayed invisible.

Deferred with reasons: TOTP/WebAuthn, breached-password checking over the network, and the unauthenticated
`/api/pairings/report/:podId` (D17).

## Totals across the whole day

| Suite | Start of day | Now |
| --- | --- | --- |
| v2 (`packages/*` + `apps/*`) | 436 | **501** |
| legacy unit | 38 | **40** |
| Postgres write paths | 0 (suite did not exist) | **24** |
| `KNOWN_SQLITE_ONLY` ratchet | 9 | **0** |
| Postgres column gap, post-cutover | 5 | **2** |

Nothing in this session touched the VM, production data, or `deploy-gcp.ps1`.
