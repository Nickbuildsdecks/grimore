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

## A fourth time I was wrong: a test that passed only on my machine

`legacy-postgres` went red on the link-fix commit, and the cause was my test, not the code.

Test 21 asserted that `/reset-password` serves the React shell and therefore cannot handle a token. That
is true only when `apps/web` has been built. It had been, locally — I built it minutes earlier — so the
test passed. The `legacy-postgres` CI job installs with npm and never runs the web build, so the
catch-all fell back to the legacy page, which *does* load `app.js`, and the negative assertion failed.

The test is now the right shape, and the right shape is a stronger claim than the original: **`/` always
serves the page that handles the token** — that is the invariant — while what `/reset-password` serves
*varies with an unrelated build step*, which is itself the reason a link in an email must not depend on
it. The negative half now runs only when the build it describes is present. Verified by hiding
`apps/web/dist` and re-running, which is the condition CI was in.

The lesson is narrower than "run the tests": I did run them, and they passed. It is that a test asserting
what a *path* serves is asserting something about the build, and my local build state was not CI's. The
only way to have caught it before pushing was to reproduce CI's tree, which is what I do now.

While reading those logs I also found a harmless but noisy race of my own making: migration 0013 dropped
`idx_card_price_cache_lower_card_name`, which `db.js`'s `initDb` recreates on every legacy boot. The two
running concurrently produce a duplicate-key error on `pg_class_relname_nsp_index` in the logs, and the
DROP achieves nothing because the index comes straight back. Removed, with the reasoning recorded in the
migration: taking it away properly means removing it from `db.js` first, which is a legacy change and not
a migration's business.

## Fifth pass: the score-report route

Handed to me with "optimization is up to you", so I established the facts before choosing, and two of
them decided it.

**Fact one: `apps/api` had already solved the authorization half.** Its league slice requires a session
and seated-or-organizer, and validates that every result names a player at the table. There was nothing
to design — legacy just needed the same rule, and legacy is what is serving traffic. Ported verbatim,
plus reading roles from the database rather than the login-time session snapshot so a revoked role locks
someone out at once.

**Fact two: neither app can reopen a reported pod.** `pods.completed` is only ever set to `1`, in both.
That is what made the re-report question real rather than stylistic: `apps/api`'s blanket 409 makes a
mis-entered score permanent for the rest of the season, and legacy's unlimited overwrite lets whoever
lost rewrite the result. So the 409 now applies to the players who sat at the pod and not to organizers,
in both apps. The standings are rebuilt from the pods rather than accumulated, so a correction settles
the board — the new test in each suite moves a win between players and checks the loser's total falls.

**And a hole I opened and then closed.** Reading my own diff adversarially: scoping the 409 to the
players is only safe if a report has to cover the whole table. Otherwise one player reports *only
themselves* as the winner, the pod completes with everyone else on zero, and the rest of the table can no
longer correct it — I would have shipped a rule exploitable by exactly the person it constrains.
`apps/api` had the same hole under its blanket 409, where the first reporter won permanently. Both apps
now require a result for every seat, named once each, which is what both reporting forms already send.

### Two things found while reading the handler

The route scored `seasons WHERE is_active = 1` instead of the pod's own season. Correcting a pod after
its season closed answered 404; correcting one while a different season was open paid out the *new*
season's points and rebuilt the *new* season's leaderboard. Fixed, with a test that closes the season
and corrects the pod.

`handleSelfReport` in `public/app.js` posts `{ kills, placedFirst, placedDraw }` with no `results` array,
so the dashboard's self-report button has always answered 500. It answers a clean 400 now, and I did not
make it work: the route marks the pod `completed`, so a one-seat report would close the pod with every
other player on zero. What a self-report should do to the other seats is a league rules decision, and
guessing at it would have been the kind of quiet scope widening this project keeps paying for. Flagged
in `claude/decisions-log.md` (D21) for Nick.

### A coverage limit worth stating plainly

The pods model — `pods`, `pod_results`, `active_roster` — is created **only** by Postgres migration 0009.
Nothing in `db.js` or `server.js` creates it for SQLite. The entire league engine has therefore never
existed on the local dev dialect, so "test it locally first" cannot mean SQLite for this feature; the
Postgres write-path suite is the only place this ladder can be exercised, and that is the dialect
production runs. I did still boot legacy on SQLite to prove the server starts with the new route and that
the session check precedes any query.

### Verified before pushing, this time against a tree CI can reproduce

| Suite | Result |
| --- | --- |
| `pnpm --filter @grimore/api test` | 264 passed, 18 files (league 36, up from 35) |
| `npm run test:postgres` | 25 passed (was 24; one new authorization test, 11 assertions) |
| `npm run test:unit` | 40 passed |
| `npm run v2:typecheck` | 15/15 |
| `npm run v2:build` | 9/9 |
| `npm run v2:guards` | OK |
| `npm run preflight` | OK, 0 hard failures |
| legacy boot on SQLite | starts; 401 before any query |

The first run of the Postgres suite failed, and it was my test rather than the code: registering the
organiser mid-test seeded a zeroed `player_stats` row for the active season, so "a re-report must not add
rows" was counting registration. The organiser is created before the season opens now. Worth noting that
the thing that tripped my test is the season-two collision recorded above — the untargeted
`ON CONFLICT DO NOTHING` — showing up from a third direction.

## Sixth pass: the affiliate id, found while confirming what is left for Nick

`TCGPLAYER_AFFILIATE_ID=xJoE0d` was on the list of things Nick had to set on the VM. Checking why turned
it into a code fix instead: `/api/config/affiliates` in legacy defaulted to `'grimore'`, which is not a
real affiliate id, so with the variable unset — as it is — every purchase link built from that route
looked attributed and earned nothing. CLAUDE.md requires `xJoE0d` on all of them, every hard-coded link
in `public/` already carries it, and `apps/api` had already made it the default during the port. Only the
configurable path in the app actually serving traffic was wrong.

Card Kingdom now returns `null` instead of `'grimore'`: there is no Card Kingdom affiliate id to fall
back to, and a fabricated one is worse than none. Nothing reads that field, so no rendered link changes.

Tested where it can be tested — `test/postgres-write-paths.test.js` is the only harness that boots
`server.js`, and it sets no affiliate environment variables, so the assertion exercises the default
rather than a fixture. One item off Nick's VM list: setting the variable is an override now, not a
requirement.

## Still open, and what kind of thing each is

**Nick's, VM-side, unchanged:** `SMTP_URL` + `MAIL_FROM` + `APP_BASE_URL` (recovery mail fails closed
until they are set, by design); the staging rehearsal; then `pg_dump` followed by
`docker compose --profile v2 up -d api`, both run by hand with eyes on the output.

**A product decision, not a refactor:** the dashboard's "Report Your Pod Result" form. It is a live,
rendered affordance that has never worked, and it cannot be made to work without deciding what one
player's self-report does to the other seats — the route marks the pod `completed`, so a one-seat report
closes the pod with everyone else on zero. The two honest options are per-seat confirmation before a pod
locks, or replacing the form with the full-pod report that already exists in `renderHubPairings`. Until
then it answers a clear 400 instead of a 500.
