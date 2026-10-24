# Grimore v2 — decisions log

Standing decisions that bind new work. Each entry says what was decided, why, and what would reverse it.
Started 2026-09-14; the original `claude/decisions-log.md` referenced in the Phase 1 brief was never
committed to the repo, so this begins fresh.

---

## D1 — The Postgres schema is the source of truth, not the legacy query

**Decided:** when a legacy handler's SQL disagrees with `packages/db/migrations/0001_baseline.sql`,
the schema wins and the query is the bug. Migrations only add what the application genuinely needs.

**Why:** `server.js` was written against SQLite and never re-verified after the Postgres cutover. Four
route groups audited so far were not merely buggy but *unable to execute* — card search, all eight
collections routes, the player profile, and all sixteen social routes. A catch-all `try/catch` hid it
in every case. The schema is the artifact that survived the cutover; the queries are what rotted.

**Reverses if:** a divergence turns out to represent a deliberate schema change that was applied to the
production database but never written back into the baseline dump. Check the live schema before
assuming that; do not assume it from the legacy code alone.

## D2 — Contracts live in `packages/shared`, and the API and the web client both import them

**Decided:** every request and response shape is a Zod contract in `packages/shared/src/contracts/`.
`apps/api` validates against it; `apps/web` imports the inferred types.

**Why:** the hand-maintained `Player` interface in `apps/web` was camelCase while both servers returned
snake_case — it never matched anything, and nothing caught that. A shared contract makes drift a
typecheck failure.

## D3 — Legacy response keys are kept as aliases during the migration

**Decided:** v2 responses use the contract's field names, with the legacy keys alongside where the
existing UI reads them (`name` next to `deck_name`; `scryfallId`, `price`, `image_uri` on cards).

**Why:** it lets the API cut over without the UI changing in the same release. Remove an alias only
when every caller has moved.

## D4 — Two API bases in the web client for the duration of the strangler

**Decided:** `apiUrl()` addresses `apps/api`; `legacyUrl()` addresses `server.js`. Un-ported routes are
called through `legacyUrl()`.

**Why:** it makes each remaining migration task visible at its call site instead of silently 404ing
after a cutover. When a route lands in `apps/api`, its `legacyUrl()` call moves to `apiUrl()` and the
migration is provably finished. **`legacyUrl()` having no remaining callers is the definition of done
for the port.**

## D5 — Blocked external services are marked, never stubbed

**Decided:** where Scryfall or Gemini is unreachable, build against the local tables and mark the
integration point `TODO(scryfall-fallback)` / `TODO(gemini)`. Never fake a response.

**Why:** a stub that returns plausible data is indistinguishable from a working integration until it
reaches production. A marked gap is honest and greppable.

## D6 — Messages use the existing `messages` table, not a new `direct_messages`

**Decided:** the social slice reads and writes `messages` (`id, sender_id, recipient_id, subject, body,
is_read, created_at`), the table the baseline schema already provides.

**Why:** legacy queries `direct_messages`, which does not exist on Postgres — so no message can ever
have been stored there and no data is at risk. Creating a second table would leave two for one concept.

**Reverses if:** Nick prefers the legacy name. It is a rename plus a migration; nothing depends on it.

## D7 — Moderation lands once, as a shared utility

**Decided:** `isProfane` filtering is not reimplemented per slice. Sites that need it are marked
`TODO(moderation)`: decks (names, tags, comments) and players (nickname, commander, bio, handles).

**Why:** four copies of a word list drift apart. One utility in `packages/shared`, one test suite.

**Landed 2026-09-14** as `packages/shared/src/moderation.ts` (47 tests) with `apps/api/src/lib/moderation.ts`
as the throwing wrapper. Legacy's word list is kept verbatim; the *matching* is rewritten, because
legacy's single `replace(/[^a-z0-9]/g, '')` was wrong in both directions — it joined adjacent words
("Goblins Hit Hard" → "goblinshithard"), matched substrings inside real words (`Scrap Mastery`,
`Scrapheap Scrounger`), and still let `sh1t`, `f*ck` and `f4ggot` through because the strip ran
before any folding. Matching is now per token, with a per-word allow list, leet folding, a
single-character wildcard and a deduplicating pass.

## D9 — A stacked PR does NOT retarget when its base merges

**Decided:** when landing a stack of PRs, either merge the **top** PR (which contains the whole chain)
into `main` after retargeting it, or retarget each PR to `main` before merging it. Never merge a
stacked PR while its base still points at another feature branch.

**Why:** GitHub retargets a stacked PR only when its base branch is **deleted**, not when the base is
merged. On 2026-09-14 thirteen PRs in this stack were merged in order, each into its own base branch,
so the work landed in the feature branches instead of `main` — `main` advanced by exactly one PR. No
commits were lost (the top branch held the full chain and one merge recovered it), but the merge
record is misleading: #4-#15 read as "merged" while their content reached `main` through #16.

This session's credentials also **cannot delete branches** (HTTP 403), so the delete-to-retarget route
is unavailable here. Retarget explicitly, and **verify `origin/main` actually moved after the first
merge** rather than trusting the API's `"merged": true`.

## D8 — `/api/dev/git-commit` and `/api/dev/git-push` are not ported

**Decided:** these two routes execute git operations from an HTTP endpoint. They will not be carried
into `apps/api`; they should be deleted from `server.js`.

**Why:** an HTTP endpoint that runs git commands against the server's working tree is a
remote-code-execution surface. Porting it would launder a security problem into the new codebase.

**Needs Nick's sign-off** before deleting from `server.js`, since something may call them.

---

# Wave plan

Ordered for efficiency. **Revised 2026-09-14** after probing which external services and schema
dependencies are actually available — the first ordering would have produced a lot of TODO-marked
shells. What is reachable from the build environment:

| Dependency | State |
| --- | --- |
| `api.scryfall.com` | **blocked** (egress proxy denies CONNECT) |
| `api.moxfield.com` | **blocked** (same) |
| Gemini | **blocked** (403) |
| Postgres / Redis | available locally |

That rules a route group "cheap" only if it is local-data-only. It also surfaced a second blocker:
**`active_roster` and `pods` are not in the baseline schema**, and `reprice-init` queries both for its
tournament deck-lock check. So the reprice suite cannot be finished until the Events wave settles the
tournament schema — which is why decks-completion moved after Events.

## Wave 1 — wishlist + recycle bin (5 routes)  *(in progress)*

`/api/wishlist` (3) and `/api/recovery` (2). Small, local-only, and each closes an open loop: wishlist
clears `TODO(wishlist-slice)` from the collections slice, and recovery makes the recycle bin
*reachable* — both the decks and collections slices already write to `deleted_items` and nothing has
ever read it back. Needs a migration: `wishlist_cards` is not in the baseline schema.

## Wave 2 — Events (19 routes)

seasons (7), roster (6), pairings (4), leaderboards (2). The largest untouched pillar and one of the
five navigation destinations `DESIGN.md` names. Also the wave that must resolve `active_roster` /
`pods` versus the baseline's `tournaments` / `tournament_players` / `tournament_rounds` / `matches`,
which unblocks Wave 3.

## Wave 3 — decks completion (10 routes)

reprice suite, Moxfield import, suggestions, autotag, share, discover variants. **Deliberately after
Events**: `reprice-init`'s deck-lock needs the tournament tables, `reprice-finalize` and
`reprice-card-cheapest` and `share` need Scryfall, and `register` / `import-account` need Moxfield.
Port the persistence and the shape; mark each external call per D5.

## Wave 4 — cards completion (6 routes)

details-batch, recommendations, swipes and art votes are local. versions and rulings need Scryfall (D5).

## Wave 5 — Play Realm (15 routes)

sandbox (9), draft (6). Depends on `apps/realtime`. `/api/sandbox/ai-advisor` needs Gemini (D5).

## Wave 6 — the long tail (~14 routes)

semantic search (2), artists (2), movers (1), preferences (1), admin (2), config (1), jobs (1),
health (1). Excludes the two `dev/git-*` routes (D8).

## Wave 7 — web cutover

Move the remaining `apps/web` pages onto the typed client, deleting each `legacyUrl()` call as its
route lands. Done when `legacyUrl()` has no callers (D4).

## Cross-cutting, any wave

- ~~The shared moderation utility (D7)~~ — landed as `packages/shared/src/moderation.ts`, wired into
  decks (name, tags, per-card tags, comments), players (profile fields, username) and league (season
  and league names). `apps/web` can call the same matcher to warn before submit; nothing does yet.
- `scryfallService.js` writes a `scryfall_id` column to `scryfall_cards` that does not exist in the
  baseline schema, so the Postgres bulk card sync cannot ever have succeeded. Needs its own fix.
- `reprice-card` uses `INSERT OR REPLACE`, which is SQLite-only syntax and raises on Postgres.

## D10 — Guest mode is removed, not ported

**Decided:** `POST /api/auth/guest` is deleted rather than ported, along with its unreferenced
frontend caller and the always-false `is_guest` / `req.session.isGuest` plumbing in `apps/api`.
Migration `0012` disables login on the legacy shared account without deleting the row.

**Why:** legacy's guest mode is one SHARED player with the hard-coded password `guestpass123`.
Every guest is the same person — one guest's decks and collection are every guest's — and because
the row is an ordinary player, that password answers the normal login form. The guest route was
never needed to reach it. Porting the design faithfully would carry both problems into the new
service; porting it *unfaithfully* (per-visitor ephemeral accounts) is a new feature, not a port.

`handleGuestLogin` in `public/app.js` had **no callers** — no button in any HTML reached it — so
removal is not a user-visible change.

Confirmed by test rather than by reading: `guest-retirement.test.ts` signs in as the seeded account
through `/api/auth/login` *before* applying 0012, so the exposure is demonstrated, then asserts the
same credentials are refused afterwards.

## D11 — Sandbox rooms stay in legacy, unported

**Decided:** the four `/api/sandbox/{create-room,join-room,sync-state,room/:code}` routes are not
ported to `apps/api` and not deleted from `server.js`.

**Why not ported:** they are an HTTP-polling multiplayer built on a process-local `sandboxRooms`
object, and they have no authentication of any kind. Room codes are `GRIM-` plus four digits — 9000
possibilities, enumerable in seconds — and `sync-state` accepts any slot id, so guessing a code
lets anyone rewrite any player's life total and battlefield. The object is never pruned, so it also
leaks memory, and being in-process it cannot survive a restart or a second worker.
`apps/realtime` already does this properly: Redis-backed `PodStore`, per-seat tokens
(`randomBytes(16)`), word-based codes with a far larger space, a reconnect grace window and rate
limiting. Carrying the legacy shape into the new service would bless an unauthenticated API.

**Why not deleted:** `public/app.js` actively calls all four, so deleting them breaks Play Realm's
multiplayer for real users today.

**Therefore:** moving Play Realm onto the `apps/realtime` Socket.IO path is its own piece of work —
a client rewrite against a different state model, not a route port — and the legacy routes stay
until that lands. The exposure above is live in the meantime; widening the code space in
`server.js` is a cheap, client-compatible mitigation if it should not wait.

## D12 — The Google admin allow list is configuration, not source

**Decided:** `ADMIN_GOOGLE_EMAILS` defaults to **empty** in the v2 env schema. Legacy defaults it to
two hard-coded personal addresses in `server.js`.

**Why:** a committed identity-to-admin grant is a standing privilege written into source, readable
by anyone with repository access and carried into every fork, branch and backup. It also silently
survives a change of ownership. Configuration is where it belongs.

**Consequence, stated plainly:** until `ADMIN_GOOGLE_EMAILS` is set in the `apps/api` environment, a
Google sign-in from an owner address creates an ordinary account instead of resolving to `p_admin`.
This only bites once auth traffic is cut over to `apps/api`; legacy is unaffected.

## D13 — The dev git routes are deleted, and D8's risk framing was overstated

**Decided:** `/api/dev/git-status`, `/api/dev/git-stage`, `/api/dev/git-commit` and
`/api/dev/git-push` are deleted, together with the scaffolding that existed only for them: the
`/changes` route, `localDevOnlyGuard`, the static-file guard for `/changes.*`, the
`child_process` import, and the hidden Command Center nav button in `public/index.html`.

**Correction to D8.** These were described across several sessions as a remote-code-execution
surface needing urgent sign-off. That was wrong, and the record should say so:

- Both `/changes` and `/api/dev` sat behind `localDevOnlyGuard`, registered *before* the routes.
- The guard's first condition is `NODE_ENV === 'production'`, and `docker-compose.yml` sets
  `NODE_ENV=production`. Every `/api/dev` request on the VM returned 404 regardless of origin.
- `public/changes.html` — the dashboard these routes served — **is not in the repository**, so
  nothing called them from anywhere.

The honest description is dead developer tooling, not a live exposure. Deleting it is still
worthwhile (a production server should not carry handlers that shell out to `git push`, guarded or
not, and dead code that looks dangerous costs reviewer attention every time it is read), but it was
never urgent, and it should not have been pressed as though it were.

**Verified by booting the server**, not by reading: `POST /api/dev/git-push` now returns Express's
own `Cannot POST /api/dev/git-push`. The `GET` variants return the SPA's `index.html`, which is how
every unmatched GET in this app already behaves.


## D14 — Legacy routes get a CI job on the dialect they actually ship on

**Decided:** a new `legacy-postgres` job in `.github/workflows/ci.yml` boots `server.js` against a
real Postgres 16 service and drives its write paths over HTTP
(`test/postgres-write-paths.test.js`, `npm run test:postgres`).

**Why this and not more unit tests.** Every legacy test to date runs on SQLite. Production runs on
Postgres, and `db.js` builds a *different* table under the same name per dialect. That is not a gap
mocks can close: the whole class of bug — `column "followed_id" does not exist` — only exists when a
real Postgres is asked to execute the statement. Three routes were dead in production while CI was
green.

The suite asserts rows, not status codes. A 200 proved nothing in #29 either: registration returned
500 *after* writing the player row, and an add-to-collection returned 500 after writing the card.

**The suite fails on CI rather than skipping.** It skips cleanly when `POSTGRES_TEST_URL` is unset so
a developer without Postgres is unaffected, but when `CI` is set a missing URL throws. Seven skips
reported as a pass is precisely the failure mode the overnight session recorded twice: a check that
passes when it should fail is more dangerous than no check, because it is trusted.

## D15 — Two of the five column mismatches stay deferred, and the reason is a schema decision

**Decided:** `card_price_cache.last_updated` and `scryfall_cards.scryfall_id` are left as they are.

Both sit inside `INSERT OR REPLACE` statements, which need a unique constraint Postgres does not
have — `card_price_cache` is keyed by a surrogate `id` with only a non-unique `lower(card_name)`
index, where SQLite makes `card_name` the primary key.

**The application-code alternative was considered and rejected.** UPDATE, then INSERT if nothing
matched, works without a constraint, but two concurrent callers can both insert, and
`card_price_cache` is read through a JOIN — so a duplicate row duplicates rows in card lists. Trading
a loud failure for a quiet wrong answer is the wrong trade.

The real fix is a unique index plus a dedupe of whatever is already on the VM. Both tables are
regenerable caches, which makes it low-risk, but it is still a migration against live data and
belongs with the cutover in `claude/v2-deploy-notes.md`, not smuggled into a column-rename change.

## D16 — Four of the nine SQLite-only writes are fixed; D-era claim that all nine were blocked was wrong

**Decided:** the `active_roster` check-in (both call sites) and the `player_stats` / `deck_stats`
standings rebuilds are converted to `ON CONFLICT` upserts. `KNOWN_SQLITE_ONLY` drops from 9 to 5.

**Correcting the record.** The overnight report deferred all nine with a single reason — "each needs a
unique constraint the production schema does not have." That was asserted, not checked, and it is
wrong for four of them: `active_roster` has a primary key on `player_id`, and migration `0009` gives
`player_stats` and `deck_stats` partial unique indexes. The constraints were there.

Two things were verified against a live Postgres before writing the statements, because either would
have produced a confidently broken fix:

- A partial unique index is only inferred when the statement restates its predicate. `ON CONFLICT
  (player_id, season_id) WHERE season_id IS NOT NULL` resolves; without the `WHERE` the same statement
  is rejected. Both rebuilds always pass a non-null season id.
- `INSERT OR REPLACE` deletes and reinserts, so unnamed columns reset to defaults; `DO UPDATE` does
  not. `active_roster.checked_in_at` is the only column affected, and it is set explicitly so a
  re-check-in refreshes it as it did on SQLite.

**Scope note.** This makes the statements correct, not the feature reachable: `db.js` creates
`active_roster`, `pods` and `pod_results` in neither dialect, so the league is dead on any database
`initDb` built until migration `0009` runs.

## D17 — `/api/pairings/report/:podId` is left unauthenticated, deliberately and under protest

**Decided:** not changed in this pass, and recorded here so it is not read past again.

The route mutates `pod_results`, marks the pod completed and rebuilds every standings row for the
season. There is no `req.session.player` check. The comment directly above it reads "Can be submitted
by players or admin", so a session was plainly intended, and every sibling route in the file has one.

Not fixed here because adding the check is an authorization change, not a dialect fix, and whether any
client calls it without a session has to be established rather than assumed — a wrong guess silently
breaks score reporting at an event. It wants one look at the front-end callers and then a one-line
guard.

## D18 — `card_price_cache` gets a unique key; `scryfall_cards` needed none. D15 is superseded

**Decided:** migration `0013` deduplicates `card_price_cache` and adds `UNIQUE (LOWER(card_name))`.
The four remaining cache writes become real upserts, and `KNOWN_SQLITE_ONLY` drops from 5 to 1.

**D15 said** these two tables both needed a new unique constraint, and that an application-level
upsert was the wrong trade. Investigating rather than restating that turned up two corrections:

- **`scryfall_cards` needed no index at all.** On Postgres the Scryfall UUID *is* the primary key, and
  `scryfallService.js`'s own bulk upsert already targets it. The legacy statement is now the same
  shape as that one — same key, same "refresh everything but the key" conflict clause — so the two
  writers cannot disagree about what a row means.
- **`apps/api/src/routes/decks.ts` had already shipped the application-level upsert** that D15
  rejected, as a select-then-update-or-insert, because no constraint existed. It is a real upsert now,
  which closes the race D15 correctly identified but could not avoid at the time.

**Why `LOWER(card_name)` is the right key**, checked rather than assumed. The table carries
`scryfall_id`, `set_code` and `collector_number`, which read like a per-printing cache. Nothing has
ever written a meaningful set code or collector number into it, and
`execution/migrate_sqlite_to_postgres.js` drops their NOT NULL constraints, so the migrated rows hold
NULL. Every reader joins on `LOWER(pc.card_name)` alone, and the SQLite table it came from keys on
`card_name` outright. Per-printing prices live in `scryfall_cards`, where two printings genuinely
differ by UUID — `apps/api/src/collections.test.ts` seeds exactly that. The `card_price_cache`
duplicates in that same fixture have nothing distinguishing them at all: they are the pathological
state, not a design.

**Two v2 fixtures had to change**, and neither lost its guard. `cards.test.ts` and
`collections.test.ts` both seed duplicate cache rows on purpose, to hold the readers to not fanning
out. Rather than delete a regression guard because the schema now usually prevents the condition, each
fixture drops the index for its own scope and recreates it deliberately — the index is new, and a
restore from a pre-0013 backup or a replica lagging the migration reintroduces duplicates silently.

**Order matters inside the migration.** The dedupe runs before the index creation, in the single
transaction the migrator wraps it in: the index cannot be built while duplicates exist, and a
half-applied state would leave the upsert with no target. Newest row wins, by
`cached_at DESC NULLS LAST, id DESC`. Verified on a table seeded with duplicates on purpose, including
mixed casing and a NULL `cached_at`: 6 rows to 3, the right survivor each time, idempotent on re-run.

## D19 — A mis-cased reprice was poisoning the shared price cache

**Found by** test 11 failing for a reason I had not predicted, which is the argument for driving routes
rather than reading them.

`/api/decks/reprice-card` looked its card up with an exact `card_name = ?` match. A caller whose casing
differed from the stored row found nothing, fell through to the `0.10` default, and then wrote that 10c
into `card_price_cache` — which is **shared**, so one mis-cased reprice priced that card at 10c for
every user and every deck until something overwrote it.

Now `LOWER(card_name) = LOWER(?)`, matching the wishlist fix in the same pass. Same class as the
`COLLATE NOCASE` removal; this one had the wider blast radius because the row it corrupts is global.

## D20 — The account system, and the decision to duplicate two modules on purpose

**Decided:** bring the account surface to the standard described in
`claude/account-system-design.md`, in both apps, and accept a duplicated CommonJS copy of the token
discipline and the password policy to do it.

Eleven findings, all closed in code. The ones worth repeating here because they were exploitable rather
than merely untidy:

- Reset tokens were stored **as issued**, so any read of that table — a backup, a replica, a dump — was
  a live credential for every pending reset.
- Reset rows keyed on **username**, which this app lets people change. A reset issued before a rename
  and redeemed after matched nobody, or, if someone had taken the freed username, set an
  attacker-chosen password on a **different person's account**.
- The whole recovery link was written to **stdout on every request**, so it reached every aggregated log
  and its entire retention window.
- `devResetLink` was attached whenever `NODE_ENV !== 'production'`, so one missing environment variable
  turned forgot-password into an **unauthenticated account-takeover API**.
- Legacy login wrote the identity onto whatever session the client arrived with — **session fixation**.
- A password change ended no other session, and `apps/api` carried a comment claiming it did.

**On the duplication.** `server.js` is CommonJS in a plain npm install and cannot resolve the ESM
workspace packages. The options were a bundler step, a dual build, `require()` of ESM, or two copies.
Two copies won on the condition that they are held together by a test rather than by care:
`test/account-tokens-parity.test.js` compares hashes, lifetimes, redeemability at the exact expiry
boundary, rejection messages and every password verdict, and was verified to fail when a lifetime and
then a hash algorithm were deliberately changed. Duplicated security logic plus a parity test is a
known-good arrangement; duplicated logic plus good intentions is what produced the schema divergence
this migration keeps uncovering.

**The fail-closed mailer is the other decision worth defending.** With no provider configured, every
send throws. A no-op would have been friendlier and wrong: "we have sent you a recovery link" must not
be returned when nothing was sent, and that exact false success is how the broken flow stayed unnoticed.
The cost is that recovery mail does not deliver in production until `SMTP_URL` is set, and that cost is
visible rather than hidden.

## D21 — Who may report a pod score, and who may correct one

**Decided:** port `apps/api`'s authorization rule to legacy verbatim, and scope the already-reported
refusal to non-organizers in **both** apps.

`POST /api/pairings/report/:podId` in `server.js` had **no authentication of any kind** — no session
check, no pod membership check, no role check, no validation that the players named were at the table.
Its only comment was "Can be submitted by players or admin". Anyone who could reach the server could
post arbitrary results for any pod in any season, award themselves unlimited points and rewrite the
standings. `apps/api` fixed this when the league slice was ported; legacy is what is actually serving
traffic, so the fix had to land there too. The rule, identical in both now:

- signed in, or 401;
- seated at that pod **or** holding `admin` / `judge` / `scorekeeper`, or 403;
- every result must name a player seated at that pod, or 400;
- the report must cover the whole table, exactly once each, or 400;
- no impossible game — two winners, or one player who both won and drew, or 400.

**The completeness rule came out of reviewing my own change.** Scoping the 409 to the players closes one
hole and opens another if a report may be partial: one player could report *only themselves* as the
winner, which completes the pod, leaves the rest of the table on zero, and — because the pod is now
closed to the players — cannot be corrected by anyone but an organizer. `apps/api` had that hole too,
under its blanket 409, where the first reporter simply won permanently. Both apps now require a result
for every seat, named once each, which is what both reporting forms already submit.

**The re-report question, which was genuinely open.** `apps/api` refused every second report with a
blanket 409; legacy allowed unlimited overwriting by anyone. Neither is right, and the reason is a fact
about both codebases: `pods.completed` is only ever set to `1` — **nothing, in either app, can reopen a
reported pod**. So a blanket 409 makes a mis-entered score permanent for the rest of the season, fixable
only by someone with a `psql` prompt. The 409 is therefore scoped to the players who sat at the pod
(so whoever lost cannot quietly rewrite the result) while an organizer can still correct a typo. The
standings are rebuilt from the pods rather than accumulated, so a correction settles the board instead
of adding to it — proved by the new test in both suites, which moves a win from one player to another
and checks the loser's total drops.

**Roles are read from the database, not the session.** Legacy's `hasRole` reads a snapshot taken at
login, so revoking an organizer's role left them holding it until they next signed in. The report route
now reads `role` and `is_admin` per request, matching `apps/api`. `hasRole` itself was left alone: the
other five call sites are admin-only routes and widening them is a separate decision.

**One bug found in passing and fixed, because it is in the same handler.** The route read
`SELECT * FROM seasons WHERE is_active = 1` and scored against *that*, not against the pod's own season.
So correcting a pod after the season closed answered 404 ("Pod or active season not found"), and
correcting one while a *different* season was open paid out the new season's points and rebuilt the new
season's leaderboard. It reads `seasons WHERE id = pod.season_id` now, as `apps/api` always did.

**One thing found in passing, and a correction to what I first said about it.** `handleSelfReport` in
`public/app.js` posts `{ kills, placedFirst, placedDraw }` with **no `results` array at all**, which the
report route could never have accepted. I reported this to Nick as a live button that had always answered
500, put the product question to him, and he chose replacing it with the full-pod form. Then I checked
what actually rendered it, and **the whole path was unreachable**: `loadActiveMatch()` is never called
from anywhere, and none of the five elements it writes to — `dashboard-active-match-panel`,
`active-match-round`, `active-match-table`, `active-match-status-badge`, `active-match-details` — exist in
any page in `public/`. The panel never rendered, so the Report button was never on screen and nobody ever
clicked it. My description of it as a live broken affordance was wrong, and so was the product question I
built on it: there was no user-facing behaviour to decide about.

That makes the chosen outcome a deletion rather than a rewrite. Both functions are removed, with a comment
where they were recording what they did and why they could not work. Score reporting goes through
`renderHubPairings` / `renderScoreForm`, which submits a result for every seat — the shape the route
requires, and now the only reporting path in the product, which is what "replace it with the full-pod
form" amounts to when the other form was never reachable. Building a second copy of that form into a
dashboard panel nobody asked for would have been adding a feature, not fixing one.

`GET /api/players/active-match` is **kept**: the React SPA reads it in `apps/web/src/pages/Events.tsx` to
display the pod. Only the dead legacy client code went.

**Coverage note.** The pods model — `pods`, `pod_results`, `active_roster` — is created **only** by
Postgres migration 0009. Nothing in `db.js` or `server.js` creates it for SQLite, so the whole league
engine has never existed on the local dev dialect, and this ladder can only be exercised on Postgres.
`test/postgres-write-paths.test.js` does that, against the dialect production actually runs.

## D22 — The affiliate id default, which was quietly earning nothing

**Decided:** default `TCGPLAYER_AFFILIATE_ID` to `xJoE0d` in legacy, as `apps/api` already does, and
return `null` rather than `'grimore'` for Card Kingdom.

`/api/config/affiliates` fell back to `'grimore'`. That is not a real affiliate id, so with
`TCGPLAYER_AFFILIATE_ID` unset — which it is on the VM — every purchase link the client built from this
route was unattributed while looking attributed. CLAUDE.md requires `xJoE0d` on all of them, and every
hard-coded link in `public/` already uses it; only the configurable path was wrong. `apps/api` fixed this
during the port and recorded why; legacy is what serves traffic, so it needed the same default.

Card Kingdom gets `null` instead of a fabricated id, because there is no Card Kingdom affiliate id to
fall back to and a fake one is worse than none — the client can leave the link unattributed honestly.
Nothing in `public/` or `apps/web` reads that field today, so this changes no rendered link.

Tested in `test/postgres-write-paths.test.js`, which is the only harness that boots `server.js` and sets
no affiliate environment variables, so the assertion exercises the default rather than a fixture. This
removes `TCGPLAYER_AFFILIATE_ID=xJoE0d` from the list of things Nick has to set on the VM: setting it is
now an override rather than a requirement.

## D23 — The recommendation engine is its own package, and the candidate pool is bounded in SQL

**Decided:** port `execution/recommendation_engine.js` into a new workspace package,
`@grimore/recommender`, rather than into `packages/shared` or inline in the route; and replace its
whole-table in-process candidate cache with a bounded, cursor-paged SQL window.

**Why a package.** The engine is ~700 lines of pure domain logic — feature extraction, profile
accumulation, scoring, diversification — with no contract surface and no I/O. That is exactly what
`@grimore/auto-tagger` already is, and the precedent is worth following: `packages/shared` stays the
place contracts and cross-cutting utilities live, and the engine stays testable without Postgres. The
legacy engine's own test suite (`test/recommendation-engine.test.js`) was carried across verbatim as
the port's regression oracle, which is the only thing that can honestly claim the TypeScript rewrite
classifies cards the way the shipped engine does. Those assertions pin rules that have each been got
wrong once already (a mana land is `Lands`, not `Utility Lands`; blink and graveyard recursion are
not removal), so they fail the build rather than quietly changing what the product recommends.

**Why bound the pool.** Legacy's `loadLocalRecommendationCandidates` selected every row of
`scryfall_cards`, mapped it in JavaScript, and held the result in a module-level object for 30
minutes; `loadCommunityCardCounts` did the same for a `GROUP BY` over every public deck's cards. Two
problems, and the second is the one that decides it:

1. It is a full table read per cold process, and the table is the entire card universe.
2. **A process-local cache makes the cursor lie.** The feed's whole design rests on a stable
   `page:cycle` cursor — the seed is derived from it so a reload returns the same page. With two API
   instances holding caches populated at different times, the same cursor returns different cards
   depending on which instance answers. `apps/api` is built to run more than one.

So the pool is `ORDER BY edhrec_rank` with `LIMIT/OFFSET` from the cursor, deduplicated to one row
per card name, and the community counts are computed for the names on the page rather than for every
card in the product. Both are plain queries with no cached state: the same cursor returns the same
page on any instance. The cost is a sort of the deduplicated card set per request, which the Scryfall
pool this falls back from does server-side — one more reason to close `TODO(scryfall-fallback)`.

**Not decided here:** whether the feed should be personalised for anonymous callers at all. It stays
public, as legacy had it, because the discovery feed is the product's front door and a 401 there is a
worse answer than a popularity-led page. An anonymous caller runs no signal queries.

## D24 — `suggestions` is portable after all, and it gets one classifier rather than a second copy

**Supersedes a claim of mine.** The "`suggestions` is not portable" note in
`claude/phase1-progress-2026-09-14.md` was wrong on its central point. It reasoned that because
`GET /api/decks/:deckId/suggestions` reads `json.edhrec.com`, and that host is denied by the egress
proxy, the route could not be ported. But that is the same situation `cards.ts` is in with
api.scryfall.com, and the same answer applies: build the local-first path, mark the remote fetch
`TODO(edhrec)`, and report which pool answered in the response. The route is ported.

What the earlier note missed is worse than what it got wrong. **The route could not execute at all
on Postgres** — its first query reads `scryfall_cards.scryfall_id`, a column that table has never
had — so the question was never "can EDHREC be reached", it was "has this page ever worked here". It
has not. Proven by running the legacy SQL verbatim against a migrated database. The latent
`playerId` temporal-dead-zone bug that note did name has since been fixed in `server.js`, and its own
comment there records it; it is not a live defect any more.

**Decided: the local pool is the commander's colour identity, format-legal, popularity-ordered, and
excludes the deck's own cards.** Legacy's local fallback was `SELECT card_name FROM scryfall_cards
LIMIT 60` — sixty arbitrary rows, unrelated to the commander, the colours or the format. Keeping
that shape would be porting a placeholder. The pool filters on colour identity and the format's ban
list in SQL (so the row limit applies to cards that qualify) and again through
`candidateFitsDeck`, the predicate the recommender slice already pins with tests. `candidateFitsDeck`
took a whole `DeckFingerprint`; it reads only `format` and `colors`, so its parameter is now that
structural subset (`DeckLegalityScope`) and a route with no profile to fingerprint can call it.

**Decided: no in-process cache.** Legacy memoised per commander slug for six hours in a module-level
`Map`. Two API instances hold different maps, so the same deck gets different suggestions depending
on which answers — the objection D23 raised against the recommendation pool's cache, and it applies
here unchanged. The pool query is bounded and index-ordered.

**Decided: the functional buckets come from `@grimore/auto-tagger`.** Legacy ran a second
classifier, `categorizeCardByTags`, 166 lines of rules that overlap the ported engine's almost
entirely. Carrying it across would put two implementations of `directives/auto_tagging_engine.md` in
v2 and guarantee they drift. The cost is real and is recorded rather than hidden: the ported engine
does not implement five of legacy's secondary archetypes — **Tokens & Swarm, Equipment & Auras,
Enchantments, Spellslinger, Landfall** — so those headers do not appear on the suggestions page.
Adding them belongs in `@grimore/auto-tagger` with the autotag route's own 26 tests in front of it,
because `tagDeck` returns *every* matching category and writes the result to `deck_cards.custom_tag`;
appending categories changes stored tags for already-tagged decks. That is its own change, not a
rider on a route port.

**Decided: ownership, not just a session.** Legacy required a login and then read whatever `deckId`
it was given, so any signed-in caller could learn the commander of anyone's private deck. The only
entry point is `public/app.js` sending the owner to `/suggestions.html?deckId=<their own deck>`, so
enforcing ownership breaks no caller.

## D25 — The remaining long tail: one alias ported, one route that is dead, one that is blocked and mis-authorized

Four legacy routes were left after the suggestions slice that are neither externally blocked by a
card service nor already declared out of scope. Each gets a different answer, and two of them are
"not ported", deliberately.

**`GET /health` and `GET /api/health` — ported as aliases.** Legacy's handler is
`{ status: 'ok', uptime }` with no database access, which is byte-for-byte what `apps/api`'s own
`/healthz` already returns. The reason to alias rather than shrug is that these two paths are wired
into things outside this repo: `docker-compose.yml`'s healthcheck for the legacy service, and
whatever external uptime monitor is pointed at the domain. Both 404 against `apps/api` the moment a
reverse proxy sends `/api` there, and a monitor that reads 404 as "down" pages for a service that is
fine. One handler, three paths, one test per legacy path.

**`GET /api/jobs/:jobId` — not ported. It is dead code and should be deleted.** The route reads
`asyncJobsMap`, a module-level `Map`. That Map has **four references in the entire repository**: the
declaration, a 5-minute sweep interval that deletes entries older than 30 minutes, the sweep's
iteration, and this route's `.get()`. **Nothing anywhere calls `.set()`**, so the Map is empty for
the life of the process and the route answers `404 {"error":"Job not found or expired."}` to every
possible input, forever. There is nothing to port: a faithful port is a 404 handler, and a useful
port would be inventing an async-job system no caller asks for. The sweep interval should go with
it — it is a timer that wakes every five minutes to iterate an empty Map. Same posture as D13's dev
git routes (raise rather than port), though this one is merely dead rather than dangerous.

**`POST /api/admin/sync-mtgjson` and `GET /api/admin/sync-mtgjson/status` — not ported yet, and they
need two fixes when they are.** mtgjson.com is denied by the egress proxy (verified:
`CONNECT tunnel failed, response 403`), so the work they exist to do cannot run here and porting the
shape would add two endpoints that can only fail. Two things must change at that point rather than be
carried across:

1. **Authorization is a hard-coded username.** Both routes gate on
   `req.session.player.username.toLowerCase() !== 'nickbuildsdecks'`. The `players` table has an
   admin role and `apps/api` has `isAdmin()`; D12 already moved the Google admin allow list out of
   source and into configuration. A username string in a conditional is neither, and it silently
   grants the sync to anyone who registers that username on a fresh database.
2. **The sync status lives in `global.mtgjsonSyncStatus`.** Process-local, so with two API instances
   the status endpoint reports on whichever instance the request landed on rather than on the sync
   that is running — the D11/D23 objection again. It belongs in Redis, which `apps/api` already has.

**`GET *`, `GET /react*`, `GET /sandbox` — not API routes.** These serve HTML: the SPA shell, the
sandbox page, and the catch-all for the legacy pages in `public/`. `apps/web` serves the SPA and the
legacy pages stay with `server.js` until the Wave 7 cutover moves them. There is nothing for
`apps/api` to answer here, and adding a static-file handler to a JSON API would be the wrong shape.

## D26 — The second API base resolved nowhere in production, and is removed rather than fixed

**The finding.** `apps/web`'s `legacyUrl()` existed so call sites for routes not yet ported out of
`server.js` would be visible rather than silently 404ing. It read
`import.meta.env.VITE_LEGACY_API_URL`, and when that is unset it returned `/legacy-api/<path>`.

`VITE_LEGACY_API_URL` is set **nowhere**: not in `deploy-gcp.ps1`, not in CI, not in any env file or
template in the repository. And `/legacy-api` is mapped in exactly one place — the Vite **dev**
proxy. Nothing in production maps it: the SPA is served from `/react` by `server.js`, whose only
catch-all is `app.get('*')`, so a POST to `/legacy-api/api/auth/forgot-password` falls through to
Express's default handler and answers `Cannot POST ...` as HTML.

So **password recovery and password reset have been broken in the deployed React SPA** since that
page was written, and worked perfectly in development. That asymmetry is why it survived: the dev
proxy papered over it on every machine anyone tested on. (The third call site, Moxfield import, has
no caller yet.)

**Decided: remove the helper, not repair it.** Repairing it would mean adding a `/legacy-api` rule to
the production reverse proxy — a VM change, which is out of bounds, and one that adds a second
public path to the legacy server for the sake of three calls. Both recovery routes are ported now,
and both servers answer them at the same same-origin `/api/...` path, so `apiUrl()` is correct before
the cutover and after it. The helper, the `LEGACY_BASE` constant, `VITE_LEGACY_API_URL` and the
`/legacy-api` dev-proxy rule are all gone, so nothing can drift back onto a prefix that only works in
development. A parameterised test asserts all three call sites resolve to a same-origin `/api` path
and contain no `/legacy-api`.

**One dependency this creates, stated rather than hidden.** `/api/decks/register` is the one of the
three that `apps/api` does not serve — api.moxfield.com is denied by the egress proxy, so it has no
port. Same-origin means it reaches `server.js` today, which is correct. It must be ported before the
reverse proxy sends `/api` to `apps/api`, even if only as a 503 `MOXFIELD_UNAVAILABLE` the way
`/api/decks/reprice-init` already is, or it becomes a bare 404. Marked `TODO(moxfield)` at the call
site, which is where whoever moves the proxy will be looking.

**The general lesson, which is the third time this shape has appeared.** A mechanism whose only
working configuration is the development one is not a seam, it is a hiding place — alongside
`loadActiveMatch()` (never called), `asyncJobsMap` (never written), and the Scryfall Tagger fetch
(result discarded). The check that finds all four is the same: ask what provides the thing this reads,
and in which environment.

## D27 — Play Realm becomes a shared tabletop, not a rules engine, and D11 is superseded

**D11 said** the four legacy `/api/sandbox/{create-room,join-room,sync-state,room/:code}` routes stay
unported because they are an unauthenticated HTTP-polling multiplayer on a process-local object, and
that "moving Play Realm onto the `apps/realtime` Socket.IO path is its own piece of work". This is
that work. The legacy routes are still not ported and still not deleted — `public/app.js` calls
them — but there is now a path that does not involve them.

**Decided: a shared digital tabletop.** The server owns the zones and both clients render what it
sends; nothing in the system knows what a card does. A rules-enforcing engine has to be written card
by card, so it works only for the cards someone has implemented — a few dozen out of roughly thirty
thousand — and a real Commander deck would mostly not function. A tabletop works with every card
ever printed on the first day. The action vocabulary is physical moves (`card:move`, `card:tap`,
`card:counter`, `token:create`, …) chosen so per-card automation can be layered on top later without
changing the state model. Nick picked this shape explicitly over an Arena-style engine.

**Decided: the engine grows a card layer rather than a new package.** `packages/rules-engine` was
already an immutable, seeded-RNG reducer with state-based actions, logging and version bumping —
everything a card game needs except the cards. Zones and instances went in beside the existing
tracker actions, with the shared assertion helpers extracted to `internal.ts` so both halves of the
reducer use one set without importing each other in a cycle. A table with no decks loaded behaves
exactly as it did before, which is what keeps the existing life-tracker tables working.

**Decided: hidden information is enforced server-side, per socket.** `pod:state` broadcast one
payload to the whole room. For a tracker that is fine; for a card game it hands every player their
opponent's hand and the order of both libraries, and no amount of client-side discipline fixes data
the client already holds. The socket layer now sends `viewFor(state, seat)` — a redaction where a
card's identity is simply **absent** when that seat may not know it. Three consequences worth
stating:

1. **Your own library is hidden from you too**, except while you are searching it, which shuffling
   ends. A player who could read their own library would know every draw for the rest of the game.
2. **Definitions are separate from instances.** Two hundred cards each carrying name, type line and
   oracle text is about 70KB, past the 64KB `STATE_MAX_BYTES` the realtime contract allows. A
   redacted view inlines a definition only onto cards that seat can see, so the payload is a
   fraction of the state and no dictionary has to be cached client-side.
3. **Per socket, not per room.** `dealTable` compacts seat indices when the table is dealt, so a
   seat-numbered room joined at sit-down can be the wrong room by the time the game starts;
   resolving each socket's seat from the authoritative snapshot by playerId cannot go stale.

**Decided: the table sits outside the login gate.** It identifies a player by the seat token
`apps/realtime` issues and never looks at a Grimore session, so an account buys nothing — while
requiring one means the person you send a code to has to register before they can play with you. It
also keeps the table's only dependency Redis, rather than Postgres and the API as well, which is
several fewer ways for a games night to fail.

**Decided: two built-in decks, drawn as text.** Nick asked for built-in decks only. There is no card
artwork available — the production card table has never been populated and this environment cannot
reach Scryfall — so every card face is legible from its name, cost, type line, oracle text and
power/toughness, and an image is used only if one is ever present. Loading a Grimore deck or a
pasted list is a deck-source function away: `deck:load` already resolves any deck handed to it
through `ActionContext.decks`.

**Not decided here:** whether the legacy sandbox routes get deleted. They should, once
`public/app.js` stops calling them, but that is a legacy-client change and D11's exposure note still
stands until then.

---

## D28 — The rules engine arrives beside the tabletop, not instead of it. D27 stands

**D27 chose** a shared digital tabletop over an Arena-style engine, because a rules engine has to be
written card by card and would work for a few dozen cards out of thirty thousand. It also said the
action vocabulary was chosen "so per-card automation can be layered on top later without changing
the state model". Nick then asked for exactly that: *"an mtg arena style engine with scripts for
each card, automating game functions."* This is that layer. D27 is not superseded — its reasoning is
why the tabletop is still underneath, and still reachable.

**Decided: one `GameState`, two modes.** A table sets `automated` and the engine owns the turn; a
table that does not is the tabletop exactly as it was, down to the last action. No tabletop action
changed, and the manual moves stay reachable *inside* Arena mode under "Move by hand". That is the
answer to D27's objection rather than a retreat from it: the engine handles the cards it knows, and
a card nobody has scripted is still a card you can pick up and move. A game that stops dead because
one card does something the engine cannot express would be worse than the tabletop it replaced.

**Decided: the client works out no rules.** `viewFor` carries an `automation` block including that
seat's own `legalActions`, and every move the table offers comes from it — every castable card,
every legal target, every creature that may block which attacker. A UI that decided any of that for
itself would be a second, worse copy of the engine, and the two would disagree the moment either
changed. This is not theoretical: the one deadlock found in a real game was the table offering a
block the engine refused, and the fix was to stop the table having an opinion.

**Decided: affordability is judged against mana you could make, and the engine taps for it.** The
two halves are load-bearing together. Offering spells against *potential* mana is right — nobody
taps five lands and then decides what to cast — but without auto-tapping the engine refuses plays it
has just offered, which in the browser meant no spell was ever cast, so no creature arrived, so
there was no combat and no damage: a whole half of the game missing from one absent function. The
reverse pairing fails too: auto-tapping without the potential-mana basis makes a castable spell look
unaffordable. Floating mana is spent before anything is tapped, so a player who tapped particular
lands on purpose gets what they intended.

**Decided: nothing dies where it dies.** Damage is marked; lethal damage is noticed by state-based
actions after every action (CR 704). That is the rule, and it is also the thing that makes "pump it
in response to the bolt" work with no special case anywhere. The same choice is why triggers are
raised by the engine rather than announced by scripts: `settle` detects the moments by comparing
state before and after, so a script cannot forget to announce itself because it never does.

**Decided: a card that needs a decision during resolution is left unscripted, not approximated.**
Searching a library, "choose one", an opponent discarding. The engine has no way to interrupt a
resolution and ask, so those cards resolve by hand and the log records that they were not automated.
A tutor that silently picks for you is worse than one you resolve yourself.

**Decided: unparseable costs are refused, not guessed.** `{R/G}` read as generic would let a player
cast a spell they cannot afford. No deck in the pool uses hybrid or phyrexian mana; when one does,
the honest failure is "this cost is not automated yet".

**Not decided here:** whether a one-player table ships. `bot.ts` already plays a full game and
exists in `src/` rather than a test file for that reason, but nobody has asked for it yet.

## D29 — A cost is not a target, and the difference is worth the engine it takes

Three capabilities arrived after D28, and two of them are the same decision in different clothes:
the engine stops and asks *before* a thing is on the stack, never during its resolution.

**Decided: a trigger chooses its targets as it is put on the stack, and only sometimes asks** (CR
603.3d). "When this enters the battlefield, destroy target creature" is one of the most common
things a creature does and could not be scripted at all before this — a trigger went on the stack
with no targets and no way to get any. Three cases, and only one is a question: no legal target at
all and the trigger never goes on the stack (CR 603.3c), so a hexproof creature an opponent cannot
touch is the same as no creature as far as their trigger is concerned; exactly one legal target and
it is taken, because a choice between one thing is not a choice and a prompt with a single button is
noise; anything else and the controller chooses, with nothing happening until they do. Flametongue
Kavu's famous drawback is then not written anywhere — played with nothing else on the board the only
thing it can point at is itself, so it kills itself and the engine does not even ask.

**Decided: a card in a graveyard is its own target kind, not a filter on "creature".** It is a
different object in a different zone. A card in a graveyard has no continuous effects applied to it
and its printed type is what it is, where a creature on the battlefield is whatever the layers say
it currently is. Writing it as a filter would have put graveyard cards through the characteristics
pipeline, which has nothing true to say about them.

**Decided: "sacrifice another creature" is implemented as a cost, with the engine that requires.**
This is the one worth the length. A cost is paid as the ability is activated: the creature is in the
graveyard *before* the ability is on the stack, so an opponent cannot answer by killing it in
response, and anything watching for a death sees it then rather than on resolution. A target is the
opposite in all three respects. Modelled as a target it would have looked right in every screenshot
and been wrong exactly where it mattered — which is why the deck shipped a commit earlier without
Vampire Aristocrat and Bloodthrone Vampire at all, with the gap written down, rather than with an
approximation nobody would notice until it cost somebody a game. The choice travels with the
activation rather than being asked for afterwards, so no new engine phase was needed: `legalActions`
offers the creatures that could pay, an outlet with nothing to feed it is not offered, and the
sacrifice is validated before anything is spent.

**Still not decided, and still the same gap:** a decision made *during* a resolution. A tutor,
"choose one", an opponent discarding a card of their choice. D28's rule holds — those cards are
left unscripted rather than approximated — but the shape to fix it now exists three times over, in
`pendingDiscard`, the opening-hand phase and `pendingChoice`.

## D30 — A decision during resolution gets its own mechanism, and D28's gap closes

**D28 said** a card needing a decision during resolution is left unscripted rather than
approximated, because the engine had no way to interrupt a resolution and ask. That was the right
call while it was true, and it is the gap this closes. Every tutor, every own-choice discard and
every "each player sacrifices" was behind it.

**Decided: a resolution can suspend, and the spell stays on the stack while it does.** A spell
declares `decisions`; the engine stops, asks, and hands the answers to the effect. Leaving it on
the stack rather than popping it first is what keeps both tables honest — they still show what is
resolving — and nothing else happens at all while a question is outstanding: no priority, no
further resolution, no step change, not even for the player who cast it. The resumption state lives
*in* the game state rather than in a closure, because the state is serialised to Redis between one
action and the next.

**Decided: a decision is not a target, and the difference drives the whole design.** A target is
chosen as the spell goes on the stack, by its controller, from a public zone, and an opponent may
respond. A decision is made as the spell resolves, possibly by somebody else, possibly from a
hidden zone, and nobody can respond. Writing "search your library for a creature card" as a target
gets all four wrong. Mind Rot is the card that proves it matters: *the player discarding chooses*,
not the caster, and a target would have had that backwards.

**Decided: three kinds of question are answered by the engine rather than asked.** One with nothing
to choose from — "each player sacrifices a creature" asks nothing of a player with no creature. One
that must take exactly what is available — a player discarding two cards with two cards in hand has
no decision to make. And one whose asker has left the game between questions. Each of those, asked,
is a prompt with no answer that stops the game dead; that failure mode has already happened once in
this engine, with graveyard targets, and it is worth designing against rather than fixing twice.

**Decided: a library search reuses `searching` rather than inventing a reveal.** The tabletop's
**Search deck** already opens a seat's own library to that seat alone, and the view is already keyed
on it. Answering shuffles (CR 701.19e), which is what the cards say and also what stops the searcher
keeping the order they were just shown.

**Decided: the candidate list is the authorisation.** The candidates travel only inside the
answering seat's own `you` block, never in the public view, and `auto:decide` refuses any id not on
that list. Without the second half, a crafted action could fetch any card from any library — the
first half alone is a UI convention, not a rule.

**Decided: `beforeDecisions` exists, for the one card shape that needs it.** "Draw two cards, then
discard two cards" cannot ask first, because the cards it offers are the ones it has not drawn yet.
A card whose question depends on what it has already done puts that half in `beforeDecisions`, the
engine asks, and `onResolve` finishes with the answers.

**Still not decided:** modal spells. The mode is a decision, but the mode decides what the spell
*targets*, and targets are chosen before a spell is on the stack. That needs a two-stage cast, and
D28's rule still holds for it: left unscripted rather than approximated.

**Found in two browsers, and worth recording as a decision rather than a fix:** a suspended
resolution left `state.priority` naming whoever last passed. That seat's table offered Pass, the
engine refused it because a question was outstanding, and the two disagreed for as long as the
question stood — a stuck game on turn ten, not a wrong label. **Decided: nobody holds priority in
the middle of a resolution, and `legalActions` refuses to report `hasPriority` while anything is
blocking at all.** Both halves on purpose: the state should be honest, but the consequence of
forgetting to make it honest is a stuck game, and `hasPriority` is the field the table keys its one
button on. One of the two has to be hard to get wrong.

**Decided, separately: a refusal of an action the game had already moved past is not shown to the
player.** Both players act at once at a real table. Tapping Pass a fraction of a second before an
opponent's spell starts resolving sends a pass the engine then refuses — correctly — but the player
did nothing wrong, and a red banner saying so is just wrong. The test is precise: the pod has moved
past the version the action was composed against. A refusal at the *current* version is a real
disagreement between the table and the engine and still shows, which is the one worth seeing.

**Measured, and written down rather than left to be discovered:** a view with a library open reaches
**45.8KB** against a 64KB socket cap, where ordinary play peaks at 18.5KB. A zone that normally
travels as a count travels as fifty card definitions. That is inside the cap for a 60-card deck and
outside it for a 100-card Commander one — which is this project's stated centre. Sending the same
definition once per copy is the cost; fixing it is its own piece of work.

## D31 — The view gets a wire form, and nothing else learns of it

The measurement in D30 said a view with a library open reached 45.8KB against a 64KB socket cap,
where ordinary play peaks at 18.5KB, and that a 100-card Commander library would not have fitted.
This is that fix.

**Decided: packing is a transport concern, not a change to the view contract.** `viewFor` still
returns a view with every card definition in place, so the engine, its tests and every one of the
thirty-odd places that read `card.card` are untouched. `apps/realtime` packs on the way out and
`apps/web` unpacks once, in `lib/table.ts`, and nothing downstream knows the wire form exists. The
alternative — making every consumer resolve a definition key — would have spread a transport detail
through the UI for no gain.

**Decided: the property to test is that packing is invisible.** `unpackView(packView(v))` equals
`v`, asserted for every state of a whole game rather than on one hand-built view. The size claim is
the *point* of doing it, but the correctness claim is that a client cannot tell.

**Decided: two things get said once.** The definitions, keyed by their own content so two copies of
one printing collapse and two different printings never do; and the fields that are false on almost
every card — untapped, face up, unrevealed, not a token, not a commander, attached to nothing, no
counters. The second half was the surprise: with a sixty-card library on screen the per-card
scaffolding costs more than the definitions, and deduping definitions alone only bought 23%. Both
together: **45.8KB to 25.3KB**, and a search is no longer the peak at all.

**Decided: the dedup gets its own leak test, because sharing is exactly how it could leak.** Two
ways, both asserted over a whole game across the wire: a card a seat may not identify must carry no
definition key, and the shared table must contain nothing that no visible card asked for — a
definition shipped because a *hidden* card wanted it would be readable by whoever got the payload.

## D32 — Modal spells are a cast-time choice, which is why they needed no new engine

D30 left modal spells as the one common shape still unscriptable, and said the reason was that the
mode decides what the spell targets while targets are chosen before resolution. That framing was
right about the constraint and wrong about the difficulty.

**Decided: modes are announced as the spell is cast (CR 601.2b), before its targets (CR 601.2c).**
They are not a mid-resolution decision at all. Scripting them as one would have been actively wrong
rather than merely approximate: a player could counter a Charm without knowing which half of it was
coming, which is a different and much better card.

**Decided: `legalActions` offers one play per legal combination of modes.** Which means the table
needed no new interface — offering several plays for one card is a shape it already had for a
permanent with several abilities — and a combination whose targets cannot be filled is simply not
offered. "Destroy target creature; or draw two cards" offers only the draw against an empty board,
and the exile-power-5 mode of a Charm appears the moment a creature grows into it. The alternative,
a mode picker in front of the targeting flow, would have been a second state machine to get wrong.

**Decided: "choose one", "choose one or both" and "choose two" are one mechanism.** `min` and `max`
on the modal block, and the combinations are the subsets of that size, shortest first. For the
cards here that is at most three plays on screen.

**Decided: each mode reads its own slice of the targets.** They arrive as one flat list in the
order the specs were offered, so a mode taking the wrong slice would return the right *kind* of
card and the wrong card — the kind of bug that looks like it works. Asserted directly, on a
graveyard holding two creatures and two lands.

**Still not decided, and now the honest boundary:** replacement effects (regenerate), copy effects
and characteristic-setting effects. These are the shapes `effects.ts` has no vocabulary for, and
they are why Golgari Charm is not in a deck while Selesnya Charm is — one of its three modes
regenerates, and a modal card with one unscriptable mode is an unscriptable card. D28's rule holds:
left alone and resolved by hand rather than approximated.

## D33 — "Dies" means what the rules say it means, and `relocate` is the only place that knows

**Found by writing the first card with a death trigger**, which the engine had gone its entire life
without. `dies` was raised in exactly two places: state-based actions, when they noticed lethal
damage, and the sacrifice-cost path, which announced its own. So a creature **destroyed by a spell**
— Doom Blade, the most ordinary removal there is — never fired a death trigger, because it was
already in the graveyard by the time state-based actions looked.

**Decided: the event is recorded where the card moves and raised where every other event is
raised.** "Dies" means put into a graveyard from the battlefield (CR 700.4). `relocate` is the one
place a card changes zone, so it appends to a `died` list; `settle` drains that list and raises the
event, in a loop, because a death can trigger something that kills another creature. This restores
the principle D28 set out and `dies` had quietly broken: *a script cannot forget to announce itself
because nothing announces itself*. Two hand-patched call sites were a rule nobody owned.

It also fixed the ordering for a sacrificed creature for free. The explicit raise put the death
trigger on the stack *before* the ability it paid for; `settle` puts it on after, which is correct
(CR 603.3b) and means it resolves first.

**Decided: both halves of CR 700.4 are asserted, in both directions.** Destroying fires it and
exiling does not. Swords to Plowshares firing a death trigger would be a different and much worse
card, and getting that half wrong is exactly how the first half comes back.

**Two limits, stated rather than discovered later.** A `dies` trigger fires for the creature that
died and no other, because the engine offers the event only to the dying permanent's own script —
so "whenever another creature dies" (Blood Artist, Zulaport Cutthroat) is not scriptable. The same
holds for `etb`, which rules out "whenever another creature enters" (Soul Warden). Both are a whole
family of cards each, and both are a change to `raise` rather than to a script.

**And one test was wrong rather than strict.** "Leaves the stack empty whenever a step ends" only
held while no card had a death trigger: *entering* the combat damage step deals damage, a creature
dies, and its trigger goes on the stack inside the same action that changed the step — correctly.
The claim worth asserting is narrower and now says so: a step never advances past something that
was *already* waiting to resolve.

## D34 — A trigger may watch the board, and `etb` had the same bug `dies` did

D33 named two limits and said each was "a change to `raise` rather than to a script". This is that
change, and making it found the second half of the bug D33 fixed.

**Decided: `dies` and `etb` carry `who`, `of` and `what`, all defaulting to today's behaviour.**
`who` is self (the default), another, or any — the "~ **or another** creature" templating. `of`
narrows to a controller. `what` narrows to creatures. Every script written before this means
exactly what it meant, because a trigger that says nothing about `who` still watches only its own
permanent. Blood Artist, Zulaport Cutthroat, Soul Warden and Impact Tremors follow, and they are
what makes a sacrifice deck a deck rather than a pile.

**`what` was not in the first draft, and the test is why it exists.** An Impact Tremors fired for
its own arrival: `who`/`of` say *whose* and not *what*, and an enchantment entering the battlefield
is not "a creature you control enters". Worth recording because the omission looked harmless —
three of the four cards would have passed without it.

**Decided: `etb` is recorded where the card moves, exactly as `dies` now is.** Writing these cards
exposed the same bug one layer along: `etb` was raised at a single call site, a permanent *spell*
finishing its resolution. So a creature put onto the battlefield by Zombify arrived silently, and a
**token triggered nothing at all** — Krenko's Goblins, Izoni's Insects and Talrand's Drakes were
mute, and so was anything watching for them. Entering means arriving from anywhere (CR 603.6a).
`relocate` and the two token-creating paths record it; `settle` drains a list of deaths and a list
of arrivals in one loop, deaths first, because a creature that dies can leave a token behind.

That the same flaw appeared twice in two sessions is the actual lesson, and it is D28's rule being
right: *an event announced by its callers is an event some caller will forget*. The two remaining
events raised from call sites are `attacks` and `becomes-tapped`, and both are genuinely about one
object doing one thing, which is why neither has been wrong.

**A note for whoever writes the next test:** a *tabletop* action — `card:move`, `token:create` —
never calls `settle`, so a death or arrival it causes is recorded and waits for the next engine
action to announce it. A test that makes a token by hand and then looks at the stack sees an empty
one. `testkit.drain` exists for that and says so.

## D35 — A four-player Commander pod, and the three rules that had never had a game to be wrong in

The engine and the server have supported four seats since the first checkpoint, and D31 recorded
pod *assertions* — per-defender declarations, a seat blocking only what attacks it. Nobody had
played one. Sitting four seats down found that the headline format of a Commander product could
not cast a commander.

**`legalActions` only ever scanned the hand.** The command zone is a zone a spell is cast *from*
(CR 903.8), and the function that decides what a seat may do had one list: `zoneKey(seat, 'hand')`.
So in Arena mode the commander sat in the command zone for the whole game, uncastable, in a
product whose first sentence is Commander. It is two lines — scan both zones, carry a flag — and
that is the point: it was never hard, it was never *reached*, because every automated game ever
played here had been 1v1 with no command zone.

**Decided: commander tax is extra generic on the cost, not a rewritten cost string.** `payFrom`
takes `extraGeneric`, so {2} per previous cast is added to whatever the card costs rather than the
cost text being reassembled — a rewritten string has to be re-parsed, and a hybrid or phyrexian
pip would not survive the round trip.

**Decided: commander damage is keyed by the commander's owner seat.** This is a correction to what
I first wrote: I keyed combat damage by the *instance* id, which reads better — several commanders,
several counters — and is incompatible with `commanderDamage:adjust`, the tabletop action that has
keyed by `fromSeat` since the manual table shipped. Two key spaces in one record never add up to
21, so a game played half by hand and half by the engine would have had a player at 20 damage from
each of two keys and alive. The rules talk about damage from "a commander" by player (CR 903.10),
so the seat is also the right key.

**Decided: a commander that would die goes to the command zone automatically, in `relocate`.** CR
903.9 gives its owner the *choice*; the engine takes it for them. Written down as a trade rather
than hidden: the alternative is stopping every single death to ask a question whose answer is "the
command zone" essentially always, and `relocate` is already the one choke point every zone change
goes through, which is why the rule costs four lines instead of a patch per call site (D28, D34).

**A bug only a pod could have: an eliminated seat could hold priority** (CR 800.4). A two-player
game cannot show it — when one player loses, the game ends in the same breath, so the state never
survives long enough for the dead seat to be asked for anything. With four seats it survives for
most of the game, and the table of a conceded player was offered a Pass the engine would refuse.
The same shape as the `pendingDecision` priority bug in D32: *priority naming a seat that cannot
act is a deadlock, however it got there.*

**Decided: the realtime payload cap is derived, not measured.** `STATE_MAX_BYTES` was 64KB, set
when the Play Realm was two players and a redacted view peaked at 22KB. A four-player pod with 259
permanents measured **68.5KB** — an ordinary long game of Commander, not a pathological one — so
the cap was refusing to send a state the engine was right to build. Two packing wastes came out
first, because a cap raised over avoidable bytes is a cap raised twice: the card id was travelling
as a field *and* as its map key, and `keywords: []` was travelling on every card that has none.
That is 68.5KB → 60.8KB, which is still only 5% of headroom, so the cap itself is now derived from
the engine's own hard limit — `MAX_INSTANCES` (600) × ~100 bytes a packed card ≈ 100KB worst case,
and 128KB is above it. **A legal game cannot reach the cap**, which is the property a safety limit
should have: what trips it is a bug, not a board.

**And a test that was asserting the cap when it meant something else.** "The full state is well
past `STATE_MAX_BYTES` while a view is a fraction of it" broke the moment the cap moved, because
the claim it was making is about *redaction* and it had been written against this month's byte
limit. It now asserts the ratio it always meant — the raw state is more than twice the widest
view — and the cap appears once, where a view is checked against the contract. The engine's tests
state the cap in one place (`testkit.WIRE_CAP`) with the derivation named where the real constant
lives; the engine does not import it, because the engine depends on nothing and least of all on
the transport.

## D36 — Four browsers, and the four-player interface nobody had looked at

D35 put four seats in the engine. This is the same pod driven through four real browsers, and it
was written because the engine passing a pod test says nothing about whether four people can play
one. Three things were missing from the *table*, and each of them was invisible from the engine's
side because the engine had always been right.

**Decided: a declaration carries a defender per attacker, not one for the whole attack.** The
reducer sent `chosen.map((attacker) => ({ attacker, defender: mode.defender }))` with `defender`
fixed at `firstOpponent(view)` — the lowest-numbered living opponent. In a duel that is the only
answer and the code reads as if it meant it. In a pod it means **you could only ever attack one
specific player**, whatever you intended, and the engine had accepted a defender per attack since
combat was written. The attack prompt now offers the players who can be attacked, each creature
keeps the one it was tapped for, and tapping a creature again *after* re-aiming re-points it
instead of dropping it — a second tap with nothing changed in between still removes it.

**Decided: an attacking creature says who it is attacking, on its own face.** Nothing on the board
named a defender anywhere: `attackSummary` existed in `lib/arena.ts` and no component called it.
With one opponent there is nothing to say; with three, "attacking" alone is a board you cannot
read, and the blockers' count belongs next to it.

**Decided: the engine's control bar offers Concede.** The manual bar always had one; the Arena bar
never did, so a player in an automated game had **no way out of it** — a duel where somebody
walks away is a stuck table, and a pod is three people waiting on a fourth. Conceding is a rule
(CR 104.3a) and `concede` has always been accepted; nothing offered it. It arms on the first tap
and acts on the second, which the tabletop's own button does not do and should: there, a misclick
costs a game two people can carry on playing by hand, and here it ends your game inside the engine.

**Decided: the commander's zone says the commander is playable.** The hand's cards carry a
"playable" badge from `legalActions`; the command zone carried no badges at all. So the one card a
Commander player always wants to cast was the only card on the table that never said it could be.

**And commander damage follows life.** The `cmd` button was a tabletop affordance rendered in both
modes, so with the engine running a tap on it added a second count on top of the damage combat had
already recorded — the same trap the life buttons were (D15), one rule along. It is a number with
the engine running and a button on a tabletop.

**The run that found nothing, twice, and why.** Two pod runs reported "the command zone was read
250 times and never said playable" while the engine offered the commander in 15% of the same
moments. The table server was a process started before the commander work existed: Vite hot-reloads
the UI, and the socket server does not — it holds the `dist` it loaded at startup. Nothing was
wrong with either the engine or the table. It is written into the setup doc's troubleshooting table
because it will catch a person exactly as it caught me, and the shape of the lesson is general: **a
browser suite tests the server that is running, not the code in the tree.**

**The driver is shared now** (`scripts/lib/table-driver.mjs`). Four browsers playing Commander ask
for exactly the same moves as two playing a duel, so a second copy of that policy would have
drifted inside a week. The arena suite passing 35 checks on the extracted driver is what says the
extraction was faithful; the only pod-specific line in it is that an attack is aimed at a random
legal player before each creature is tapped, which does nothing at a two-player table.

## D37 — {X} was half-built, which is worse than missing

The mana layer has parsed `{X}` since it was written, `payCost` has taken an amount to pay for it,
the stack object has had a field for it, and `EffectContext.x` has been documented as "the chosen
value of X, 0 when the cost had none". Nothing ever set it. No card had an X in its cost, no
`legalActions` ever reported one, the table had no way to choose one, and so none of that code had
ever run.

**That is a worse state than not having it.** A missing feature is a gap you can see; a feature
wired at both ends and never connected in the middle looks finished in every file you open. The
half that was missing is the half with the rules in it.

**Decided: `legalActions` reports `xMax`, and the client never derives it.** What X can be is a
mana question — untapped sources, what they can produce, what the rest of the cost needs first —
and a client that worked it out would be a second mana engine disagreeing with the first. The
reducer clamps what it sends to the reported ceiling as belt and braces, not as arithmetic of its
own.

**Decided: X is chosen at cast time, before targets, like a mode.** CR 601.2b puts X with the
announcement and CR 601.2c puts targets after it, and that is the order the table walks: the
Fireball's size, then what it points at. Modelling it as a mid-resolution decision would have been
the same mistake modal spells nearly were (D27) — you would get to see how big the Fireball was
only after it was too late to counter it. The table opens on the largest X the mana allows,
because that is the choice a player makes nearly every time, and every smaller number is one tap.

**Decided: an X of zero travels, and an X on a card without one is refused.** `{X}` at zero is a
legal cast and sometimes the only one available, so a spell with an X in its cost always sends a
number rather than leaving the field out — "no x" and "x = 0" must not be the same message. The
opposite case is refused outright: a Lightning Bolt arriving with `x: 2` is a client that has
misunderstood the card, and ignoring the number would leave an x on the stack object for some
later effect to read.

**The X is in the stack description.** "Fireball" does not tell the player holding a counterspell
whether their 2/2 lives; "Fireball (X=3)" does. Same reasoning as the modes.

**The bot takes the largest X, and that occasionally kills it.** It does not know what a card does
— that shallowness is deliberate and recorded in D20 — so it does not know that a Hurricane hits
its own controller too. Left as it is: the alternative is a card-specific hack dressed up as a
rule, and `playout.test.ts` asserts that games *finish*, not that they are played well.

**And a test method that was quietly wrong.** The modal test watched `state.stackObjects` after
each action to see what the bot had cast. With auto-pass on, a spell nobody can respond to is cast
*and resolved* inside one action, so the stack is empty again by the next line: of fifteen X
spells cast across ten games, exactly **one** was still there to be seen. The modal test had been
passing on the same luck. Both now read the bot's own action through a `stepWatching` helper,
which is the thing they were always trying to assert.

Five cards, one per colour, each a different shape: Fireball (targeted damage), Mind Spring (draw
X), Exsanguinate (X from each opponent, which is a different card at a pod than at a duel), Secure
the Wastes (X tokens, at instant speed) and Hurricane (X to every flier **and every player**,
including its controller). Sixty-eight scripted cards.

## D38 — Scry, and the second way a player may read their own library

A library is the one zone hidden from its own owner, and until now there was exactly one hole in
that: `searching`, which opens the whole thing. Scry needs a different hole — the top two cards,
face up to you and to nobody else — and the interesting part is how the engine decides who may
read them.

**Decided: the candidate list is the authorisation, again.** `canIdentify` reveals a library card
when there is a `pendingDecision` from `library-top`, it belongs to the viewer, and the card is on
*that question's own candidate list* — the same list `auto:decide` validates an answer against.
One list, two uses, so a crafted answer and an unauthorised read fail for the same reason and
cannot drift apart. The alternative was a second rule saying "the top N are readable", which is
a number that can disagree with the question.

**Decided: the scried cards travel as cards without a zone.** The view sends their definitions to
the one seat being asked and sends no library zone at all, so what the table learns is "these two
cards", not "here is the order of your deck". The table draws them from the question's candidate
list rather than from a zone, which is why no synthetic zone was needed anywhere.

**Decided: putting them back is the engine's job, not the card's.** Scry is a keyword action with
fixed semantics — the chosen cards go to the bottom, the rest stay on top, nothing is shuffled —
so `answerDecision` does it, exactly where a search's shuffle already lives (CR 701.19e for the
one, CR 701.17 for the other). Preordain's own effect is the draw and nothing else, which is what
the card says.

**Where the engine stops, written down: the cards kept stay in the order they were already in.**
Printed scry also lets you reorder what you keep. That needs a question whose answer is a
*sequence* rather than a set, which `DecisionSpec` cannot express, and no card in this pool turns
on it. Scry 1 is therefore exact and scry 2 is very slightly simplified, and the limitation is in
the code next to the type rather than in a changelog.

**Magma Jet damages before it asks**, via `beforeDecisions` — the hook that existed for Faithless
Looting's draw. That is the order printed on the card and occasionally the order that matters:
what you want on top is a different question once the creature is dead.

**The bot bottoms a land once it has five, and otherwise keeps everything.** Scry is neither
gaining nor losing, so `decideCards`' existing rule — take the most and the best when gaining,
the fewest and the worst when losing — says nothing useful about it. The one scry decision that
is obviously right without knowing anything else is "I have enough lands", and that is all it
makes. Anything cleverer needs the bot to know what it is holding and what it is playing against.

Three cards: Preordain (scry 1, then draw), Magma Jet (damage, then scry 2) and Omenspeaker (an
ETB scry on a 1/3 body, which is the trigger path). Seventy-one scripted cards.

**Postscript, from the run that followed:** the solo suite stalled at turn seven while the two
two-browser suites passed. Its move policy was a *third copy* of the same prompt-reading code, and
the X-cost prompt had been taught only to the shared driver — so the copy sat looking at a table
that was waiting for it. It is now the driver too, with one line of its own saying why it always
develops. The rule this keeps re-proving: **a copy of a policy is a copy of the next thing you
forget to tell it.**

## D39 — Equipment, and what a target filter is allowed to know

An Equipment is an Aura that outlives its creature, and saying it that way is most of the design:
everything the engine already had for Auras applies, and the two differences are where the work
is.

**Decided: equip is an ordinary activated ability, not a new kind of card.** Sorcery-speed
abilities, targets, mana costs and continuous effects all existed; `equipTo` is the one new verb.
No `CardScript.equipment` field, no new resolution path, nothing in `legalActions` that knows what
an Equipment is. A card type that needs an engine change is a card type the engine does not
really support.

**Decided: the attachment ends, the Equipment stays (CR 301.5c).** An Aura attached to nothing
goes to the graveyard; an Equipment just comes loose, which is why a board wipe leaves the gear
behind. One more clause in state-based actions, next to the Aura one.

**And the bug in it, which is the Aura bug wearing a different hat.** The first version checked
`attachedTo !== null` and found nothing wrong — because `relocate` detaches everything pointing at
a card *as that card leaves*, so by the time the state-based actions run the Equipment is attached
to nothing rather than to something dead. The check is on the **effect** as well: an Equipment
with no legal host and a `+2/+0` still in `state.effects` is the thing to fix, and that bonus
would otherwise have sat there for the rest of the game, waiting to be applied to whatever next
held that instance id. D21 found this shape for Auras; this is the same mistake, caught in a test
this time rather than in a game.

**Decided: a target filter may see the card it belongs to.** `TargetSpec.filter` now takes an
optional `source`. Equip without it offers the creature the Equipment is already on — legal by the
rules, useless in practice, a trap for a player and a waste of mana for a bot. Measured before and
after over ten games: **51 equips of which 35 were re-equipping the same creature, down to 26 of
which none were.** The capability is general and other cards want it: "another target creature" is
printed on hundreds.

**And a bug the new cards exposed: a game could end with a question still on the table.** Magma
Jet deals its damage, the engine asks where to put the top of the library, and the state-based
actions that end the game run in the same action — leaving a prompt nobody can answer on a
finished table, with `legalActions` refusing priority because a decision was outstanding. The game
ending now clears priority and every pending question, which is what CR 104.1 means by the game
ending immediately. Found by a playout, in the one matchup that could produce it.

Bonesplitter (+2/+0 for {1}), Loxodon Warhammer (+3/+0, trample, lifelink) and Basilisk Collar
(deathtouch and lifelink on anything, which turns a Llanowar Elves into a creature nobody blocks).
Seventy-four scripted cards.

## D40 — A land that makes one of two colours, and one answer about affordability

The engine could not express a dual land. `ManaSource.produces` was a multiset — a source listing
`['U','B']` added one of each — so a Guildgate would have been two mana off one land, and the
comment in `mana.ts` said as much: a source offering a *choice* "is left out of `sources` by the
caller rather than guessed at".

**Decided: a source may be a choice, and the solver says which colour each tap made.** `solveTap`
now returns picks — `{ key, types }` — instead of keys, because for a choice source the colour is
not decided until it is tapped, and the caller has to put the right mana in the pool. The greedy
rule that was already there turns out to be exactly right for duals: the *least flexible* source
that makes a short colour goes first, so a Guildgate is saved for the colour only it can provide.

**Decided: several free tap-for-mana abilities on one permanent are a choice, not a sum.** That is
what a dual land is, and `manaSources` now collapses them into one source with `choose: true`.
Before this it took the first such ability and ignored the rest, which was right for everything in
the pool and wrong for anything with two.

**Decided: affordability is one function, and it is the solver.** `legalActions` used to count an
optimistic pool — every untapped source's colours added up — and `canPay` that against the cost,
while the payment itself used `solveTap`. Two answers to one question, and a dual land is exactly
where they part company: counted as both its colours it looks like two mana and it is one, so the
table would have offered a two-drop off one Guildgate and the engine would have refused to pay for
it. `canAfford` (pool, cost, sources) is now the only answer, and `maxAffordableX` with it.

`potentialMana` survives as what it always really was: the **dimmed pips** on the control bar,
"the colours you could still make", optimistic on purpose because that is the useful reading for a
person. Nothing decides legality from it any more, and its doc comment says so.

**Decided: "enters the battlefield tapped" is applied where arrivals are announced.** It is a
replacement effect (CR 614.1c) and the engine has no replacement layer, so it is applied in
`settle`'s arrival drain, before the entry trigger is raised — the permanent is never observably
untapped, because nothing can act between the two inside one action. Honest about being an
approximation of the right mechanism rather than the mechanism.

Three Guildgates, one for each two-colour deck, two copies each in place of two basics. Measured
over twelve bot games: 19 gates played, **71 gate taps paying for spells**, no refusals, every
game finished. Seventy-nine scripted cards, the five basic lands among them.

## D41 — Two replacement effects, and the card both checkpoints said was unscriptable

Golgari Charm has been the stated limit since the first checkpoint: "a modal card with one
unscriptable mode is an unscriptable card", and the mode was *regenerate each creature you
control*. This is that mode, and the other replacement effect the pool actually wants.

**Decided: a regeneration shield is a counter, and the destruction is replaced in both places it
can happen.** A counter because that is already a per-permanent, serialised, *visible* number — a
player can see how many shields a creature has, which is exactly right — and because nothing else
in the engine needs a general replacement layer yet. The replacement is honoured by `destroy`,
where a spell says so, **and** by the lethal-damage state-based action, which is the half players
actually use: a shield that saved a creature from Doom Blade but not from the 3/3 it just blocked
would be the wrong half of the card.

All three parts of the replacement are real (CR 701.15a): it is tapped, its damage is removed, and
it is **taken out of combat**. The damage matters mechanically — without clearing it the next pass
of state-based actions kills the creature again and the shield buys nothing — and the removal from
combat is what makes regeneration a cost rather than a free save.

**A toughness of zero or less cannot be regenerated away** (CR 704.5a): that is not destruction,
it is a creature that does not exist as a creature. One `ch.toughness > 0` guard, and it is the
difference between regeneration and indestructible.

**Decided: an unspent shield expires with the turn**, in `endTurnCleanup` beside damage wearing
off — "the next time this turn" (CR 701.15b) and not a permanent save. Found by writing the test
the wrong way round: my first version regenerated, passed the turn, then cast the removal, and the
creature died exactly as it should have.

**Decided: "enters with N counters" is applied where the X is known.** In `completeResolution`,
because that is the only place that has the stack object and therefore the X the spell was cast
for. A permanent arriving any other way — reanimated, copied, a token — enters with X of zero,
which is the rule (CR 614.1c) rather than a simplification: reanimate an Endless One and it comes
back a 0/0 and dies, as it does at a real table.

**And one bot line, measured.** It was casting Endless One for X=0 — a card thrown away for a 0/0
that dies before anyone looks at it — so a play whose `xMax` is nothing is now skipped. Over
twelve games that removed every X=0 cast and left the real ones alone.

Drudge Skeletons, Golgari Charm (all three modes, the sweep included) and Endless One. **The bot
puts up shields and never spends one**: it activates the ability on its own main phase rather than
when something is about to die, which is the same shallowness as aiming a pump spell at an enemy
creature (D20) and is recorded here rather than hidden — the engine path is asserted on a fixed
board, in combat, with the shield going up between blockers and damage.

## D42 — Drawing the combat instead of describing it

D36 gave an attacking creature a badge reading "attacking Ana". That was the right first answer
and it is not enough: with three opponents a badge is a sentence you read four times to work out
what is happening to *you*, and the one question a defender has is whether they are the one being
attacked.

**Decided: the arrows are measured from the DOM, not computed from the layout.** The board is flex
rows that wrap, inside containers that scroll, on a page that resizes and rotates. An overlay that
knew where the cards were would be a second layout engine, and it would disagree with the first
the moment a hand grew by one card. So the overlay asks the browser — `getBoundingClientRect` on
`[data-testid="card-…"]` and `[data-testid="seat-…"]` — and re-measures on resize, on scroll
(captured, so inner scrollers count) and on any body resize.

**Decided: it lands on the edge facing the attacker.** Not the middle of the seat row, where the
arrowhead disappears under the player's name, and not always the top: in a pod the rows are above
*and* below you, so the only edge that reads as being pointed at is the near one.

**`pointer-events: none` is not decoration here.** The overlay covers the whole board, and without
it every card underneath would stop being tappable the moment somebody attacked — which is the
exact moment the defender needs to tap their creatures.

Blocks are drawn too, dashed and in the info colour rather than gold: a block is an answer, not a
threat, and the two should not look the same at a glance. Nothing is drawn at all when there is no
combat, which is most of a game, and nothing is drawn on a tabletop, where the engine does not
know what an attack is and the players point at each other themselves.

The screenshot the pod suite takes is the argument for the whole thing: Cleo's Drudge Skeletons
with a line running down the board to Boris's row, and Boris — reading his own screen — knows
without parsing a badge that the attack is his to block.

## D43 — Three opponents are not one opponent three times

The pod suite's screenshot was the argument: **two and a half thousand pixels** of board. Four
hands, four battlefields and twelve mostly-empty piles stacked vertically, with the player about
to attack you somewhere off the top of the screen. Every row of it was correct and the whole was
unreadable.

**Decided: opponents sit side by side once there are several of them.** Three columns on a wide
screen, one full-width panel in a duel, and the vertical stack on a phone — three columns of card
on 390 pixels is nothing anybody can read. It is shorter (1,300–1,500px instead of 2,547) and it
is *truer*: that is where those players are sitting.

The layout is the only thing that changed. No zone was hidden and no card was made unreachable,
which was the constraint: a graveyard collapsed to a count is a graveyard a spell cannot be
pointed at, and "a prompt with no visible answer" is a stopped game — the failure that the
graveyard-targeting bug produced the first time round. The piles under an opponent went from two
columns to three because the panel is narrower now, and each panel scrolls its own battlefield
sideways rather than pushing the page wide.

What this does not fix, and is worth naming: the panels do not line up row for row, because each
is as tall as its own contents. A grid with shared rows would align them and would also leave a
player with no creatures holding an empty box the height of somebody else's board. The misalignment
is the better of the two, until there is a reason to think otherwise.

## D44 — The bot stops throwing creatures away

"It attacks with everything, blocks when the trade is good, and casts the biggest thing it can
afford" has been the honest description since D20, and the first clause was the worst of it: the
bot ran a 1/1 into an untapped 3/3 every turn because the engine said it was allowed to. Measured
over twenty games across every matchup: **292 attackers declared, 40 of them dead.** Two creatures
a game, given away.

**Decided: each attack is weighed against the blocks it could actually face.** Nothing that can
block it — attack, that is free damage. Nothing that blocks it can kill it — attack, the worst
case is no damage. It dies but takes something at least as good with it — attack, that is a
trade. It dies for nothing — stay home. Four lines of judgement, all of it read off the board:
no card knowledge, no search, nothing the bot could not work out by looking.

**With one exception that overrules all of it: lethal.** If enough damage gets through to kill the
defender, everything attacks — a creature saved on the turn you could have won is a creature saved
for nothing. "Gets through" assumes each untapped blocker eats the biggest attacker, which
under-claims lethal rather than over-claiming it; being wrong in that direction costs a turn, and
being wrong the other way costs the team.

**And blocking picks the best fight rather than the first legal one.** The old loop took the first
attacker a creature could block, so a 4/4 ate a 1/1 while a 5/5 walked past. Now each blocker
takes the biggest attacker it can actually handle, preferring a fight it survives.

**A near-miss worth recording.** `exchange(attacker, blocker)` reads from the first creature's
side, and in the blocking loop I destructured it as though the sides swapped — two lines that
would have made the bot block its best creature into death and call it a trade. Caught by naming
the two halves at the point of use (`iDie: attackerDies, itDies: blockerDies`) rather than
carrying `iDie` around and remembering whose "I" it was.

**Measured after: 240 attackers declared, 16 dead.** Sixty per cent fewer creatures given away
while still attacking 82% as often — and the average game got *shorter*, 19.4 turns to 18.6, which
is the number that says the bot did not solve the problem by refusing to fight. All three are
asserted in `playout.test.ts`, including the attack count, because without it the test passes by
doing nothing.

## D45 — A fifth deck, built out of what the engine learned

The four starter decks were written against the engine as it was: creatures, burn, counterspells,
a graveyard. **Forge Alliance** is the first deck written against the engine as it is now —
Equipment, X tokens, a dual that enters tapped, an aura that draws a card. Nothing in it would
have worked ten commits ago, which is the point of building it: a deck is the honest test of
whether a feature is usable rather than merely present.

**Decided: an Equipment's bonus is declared on its script, not closed over by its own ability.**
Balan, Wandering Knight moves every Equipment you control onto itself, so it is the first card
that has to *read another card's script* — and a `+2/+0` that exists only inside the Bonesplitter's
effect function cannot be asked what it is. `CardScript.equipBonus` is the smallest thing that
makes the question answerable, and it costs the `equipment()` helper one line.

**Most of the deck is cards the other decks already define.** Monastery Swiftspear, Doomed
Traveler, Serra Angel, Ajani's Pridemate, Lightning Bolt, Magma Jet, Fireball, the three
Equipment, Secure the Wastes. A `CardDef` is data and a script is keyed by name, so a deck list is
genuinely just a list — which is what a deck *should* be, and worth saying because it means the
next deck costs almost nothing.

Five new cards for the things it needed: Boros Guildgate, Elite Vanguard (a vanilla 2/1, no script
at all), Leonin Skyhunter, Raise the Alarm, Angelic Gift and Inspired Charge. Angelic Gift is the
interesting one — an Aura with a trigger on it, so the flying is the continuous effect and the
draw is the card entering, and both halves had to be there for the card to be the card.

Five decks mean fifteen pairings; `playout.test.ts` now plays all of them to a finish, which is
the check that matters when a new deck arrives: not that its cards work, but that a game between
it and every other deck ends.

**A harness correction that came with it.** The pod suite reported "Nick stuck at Declare blockers
on turn 33" in a game that then carried on and finished. It was the driver, not the table: between
"is it this page's move" and the move itself, another of the four browsers acted and took the move
away. In a pod that happens on its own. The driver now says *the moment passed* instead of
reporting a defect — a prompt that genuinely cannot be answered still returns null from the
branches that find a question with nothing lit, and a table that has actually stopped shows up in
the callers' idle and repeat detectors, which describe it more accurately than one missing button
can.

## D46 — The log says what happened, not only what was played

A game's log read like this: `Friend attacks with 2 creature(s)`, `Nick blocks with 2
creature(s)`, `Friend passes`, `Friend passes`, `Friend passes`. Nothing about who was attacked,
what blocked what, who took damage or what died — a board wipe read "Nick casts Golgari Charm"
and four creatures died in silence. It is a record of *actions sent*, and what a player scrolling
back wants is what happened.

**Decided: consequences are detected by comparing the table before and after, not announced.**
The same rule as triggers (D28, D34), applied to the log: a consequence each caller has to
remember to mention is a consequence some caller will forget. `applyAction` diffs the state it
started from against the state it produced — life totals that moved, permanents that left the
battlefield for a graveyard or exile — and appends them to the line. Every card written from here
on gets it for nothing, including the ones that kill something without mentioning it.

A token that dies is *deleted* rather than moved, so "gone from the instances entirely" counts as
a death too. It is the only way a token's death can be seen at all.

**Capped at six, with the overflow counted.** A sweep that kills nine would otherwise be a
paragraph; the line now ends "and 3 more", which is both shorter and honest about what it is not
showing.

**Combat names names.** "Attacks with 2 creature(s)" is true and useless: in a pod the question is
who is being attacked and in a duel it is what with. `Friend attacks: Bloodthrone Vampire at Nick,
Drudge Skeletons at Nick` and `Nick blocks: Warrior on Bloodthrone Vampire, Warrior on Drudge
Skeletons` are the same information the arrows draw, in the form you can scroll back through.

**And the client drops a pass that did nothing.** Most of an automated game's log is priority
going round the table, and a hundred lines of "Friend passes" is how a player loses the four that
mattered. A pass that ended a step or killed something keeps its line — by then it is not a pass,
it is the action that caused all of that, and the engine now says so on the same line.

## D47 — Planeswalkers, which needed rules rather than vocabulary

The last card type, and the only one so far that could not be built out of effects the engine
already had. Every other addition this session was a verb — scry, equip, regenerate. A
planeswalker is a *set of rules*: it enters with loyalty, its abilities are paid for in counters,
one of them per turn, it dies at zero, damage removes loyalty rather than being marked on it, and
it can be attacked instead of its controller.

**Decided: all of it in one go, abilities and attacking.** Abilities without attacking would have
left exactly the state `{X}` was in before D37 — present and not connected — and worse, because a
planeswalker nobody can attack is not an approximation, it is a different card. The combat change
turned out to be two lines in `dealCombatDamage` behind one function that answers "what does this
attack hit", plus validation on the declaration.

**Decided: a loyalty cost carries its restrictions.** A script writes `{ loyalty: -1 }` and gets
sorcery speed, once per planeswalker per turn (CR 606.3) and "not without the loyalty to pay for
it" — because every loyalty ability in the game has all three, and a script repeating them is
three more places to forget one. The cost is paid *as the ability is activated* (CR 606.2), so a
planeswalker that goes to zero on its own minus is already dying while the ability it paid for
waits on the stack — and the ability still resolves, which is the rule and the reason the cost is
not paid on resolution.

**Decided: the printed loyalty is applied in `relocate`.** The first version did it in `settle`'s
arrival drain, which is where "enters tapped" lives — and a planeswalker put onto a *manual* table
got none, so the moment the engine took over the state-based actions read zero loyalty and swept
it into the graveyard. Found by a test whose board kept coming up empty. `relocate` is the one
place a card arrives; it is the third rule this session to end up there, after `dies` and `etb`.

**And `normaliseDef` was dropping it.** The loyalty was on the card definition and gone by the
time it reached the table, because the normaliser lists the fields it keeps and nobody had added
this one. Two bugs of the same shape in one feature: a new field has to be carried by everything
that copies a card, and the compiler cannot see an omission in an object literal.

**Damage to a planeswalker removes loyalty** (CR 120.3c) rather than being marked. Not a detail:
marked damage wears off at end of turn, and a planeswalker that healed itself every turn would be
unkillable by anything but a removal spell.

**The bot attacks a planeswalker only when it can kill it.** Chipping at one gives the damage up
for nothing, because a player's life total is what ends the game. Shallow — it does not ask what
the planeswalker *does* — and measured: over sixteen games, 5 cast, 24 abilities activated, 2
attacks aimed at one, every game finished.

Jace Beleren and Garruk Wildspeaker, both with all three printed abilities implemented; nothing
was simplified to make it fit. Garruk's "+1: untap two target lands" found the last bug: the bot
sent one target for a spec that wanted two, because no card before it had `count: 2`.

## D48 — The in-game help was for the other table

The help panel behind the **?** has one list, and every line of it is about the manual tabletop:
tap your own lands, say who you are attacking in chat, settle combat with the life buttons. With
the engine running, two of those are not possible any more and the rest are things the engine
does for you — so a new player reading it goes looking for buttons that are not there, which is
worse than no help at all.

**Decided: two lists, chosen by which table you are at.** The Arena list is the one a player
needs on their first automated game: that the bar always shows the one thing the game is waiting
for, that mana is tapped for them, that targets light up wherever they are, that an X spell asks
how big before it asks what at, that attacking asks *who* — a player or one of their
planeswalkers — that a planeswalker's own abilities are one a turn, that some cards stop and ask
a question mid-resolution, what the skipping toggle does, and that **Move by hand** is there for
anything the engine does not know.

This is not documentation work: the help panel is the only place a player who has not read
`claude/play-realm-setup.md` learns any of it, and every feature added this session is invisible
until something says it exists. The arena suite now reads the panel and fails if it is showing
tabletop help at an automated table — which is exactly the regression that produced this entry.

## D49 — A pod of one: three bots, three different decks

The server has been able to seat three bots since the pod format went in, and the lobby has only
ever offered one. So the one thing a solo player could not set up was the format the product is
built around: a four-player Commander game. Worse, the server gave every bot the same deck, so a
pod of three opponents would have been the same deck three times, drawing the same cards in the
same order — which is not three opponents.

**Decided: `botDecks`, a deck each in seat order, with the single `botDeck` still working.** Three
lines in the pod's `create`, because `runBots` already loaded a deck per seat; what it lacked was
anywhere for the caller to say which. The lobby's new **Solo pod** button sends the first three
starter decks. A realtime test asserts the pod arrives as asked — four seats, three bots, each on
its own deck, everybody on forty, every commander in its command zone — because that assertion is
the feature, and the browser suite below is the proof it is playable.

**`SOLO_POD=1` on the solo browser suite plays one to a survivor**, with two checks a duel cannot
make: that the lobby really seated four, and that *all three* bots played. A pod where two of the
three sat still would pass every other check in the suite and be no kind of game.

## D50 — "The game is finished" is not an error

The solo pod suite failed on the one check that matters most — "the engine never refused anything
the table offered" — with `GAME_FINISHED: the game is finished`, every run. Not a rules bug: the
pass that killed the last opponent and the pass queued behind it both went out, and the engine
refused the second, correctly. The client then put it on screen in red, over "Nick wins".

The existing guard could not catch it. It swallows a refusal when the table has moved on since the
action was sent — but a queued action re-composes against the version the previous ack just handed
back, so by that test nothing had moved.

**Decided: the server gives it its own code, `game_finished`.** Not a string match on the message,
and not a guess from the client's own copy of the view: the client's view of "is it over" can
arrive after the refusal does, which is exactly the race. A distinct code is the server stating the
one thing it knows for certain, and the client swallows that code and nothing else. The engine's
`GAME_FINISHED` was being flattened into `illegal_action`, which is what made it unanswerable —
and it never was an illegal action: the action was fine, the game ended under it.

**And the refusal has one owner now.** Every handler answers the ack *and* emits `pod:error`, and
the `pod:error` listener had none of the context `send` uses to judge a refusal — so it put the
banner back up for every refusal `send` had deliberately swallowed, including the version-stale one
that has been in the code since D-era optimistic concurrency. While a call of ours is in flight,
the ack decides; `pod:error` is for anything that arrives unasked.

## D51 — `scripts/play.mjs` builds the table server before starting it

Three debugging sessions in this project have ended the same way: the code was right, the running
server was old. Vite serves the web app from source, so the UI is never stale; `apps/realtime` runs
from `dist/`, and the script only checked that the file *existed*. "Restart the play stack after an
engine change" was the standing advice and it was wrong — restarting a stale build starts the stale
build again. The most recent instance cost an hour: a refusal that three separate fixes failed to
make go away, because none of them was running.

**Decided: build it, every time, as part of starting it.** `tsc` on an unchanged tree is a couple
of seconds. The question "is the server up to date?" cannot come up again, which is worth more than
the seconds.

**And the browser driver's clicks are bounded.** A press used to wait Playwright's default thirty
seconds for a button to hold still, so a control bar that re-rendered under the cursor — which is
what four seats acting on one table do — ended a whole run with a stack trace instead of a move.
Two tries at two seconds, then the press is reported as not having landed, which the callers'
own idle detectors already know what to do with. One `tap`/`press` pair for every click in the
driver, rather than the three different ad-hoc timeouts that had accumulated.

## D52 — A cost that is a decision, three times

Everything the engine could cast until now cost what was printed in the corner. Three shapes of
cost it could not express, and each one needed a different part of the engine to grow.

**Cycling: the zone comes from the cost.** An ability paid for by discarding the card is used from
the hand, and nothing in Magic discards itself from the battlefield to pay for something. So
`discardSelf` in the cost is what decides where the ability may be used, and `legalActions` walks
the hand as well as the battlefield and skips each ability unless it is in the zone its own cost
implies. The alternative was a `fromHand` flag sitting beside the cost that could disagree with
it — and the same reasoning already decides sorcery speed for a loyalty ability, so this is the
second rule of its kind rather than a new idea.

The card is discarded *as the cost is paid*, so it is in the graveyard while its own ability is
still on the stack (CR 702.29a). That is not a detail to be tidied away: it is why a cycled land
can be pulled back out of the graveyard before the draw has happened.

**Kicker: a second play, not a second question.** The engine already offers a modal spell once per
combination of modes, so a kicker is one more play on the same card with a bigger cost — the
table needed no new control, and the player pays it by choosing it. Two decisions inside that:
the kicker's symbols are *appended to the printed cost* and paid as one cost, so a player who can
afford the card but not all of a coloured kicker is offered the plain version only and never ends
up having paid half; and the kicked-ness travels on the stack object, like X and the modes, because
whether it was paid changes what the spell does and the player deciding whether to respond reads
the stack to find out.

The effect reads `ctx.kicked` and branches, rather than the script carrying two effect functions.
A kicked spell is almost always the same spell with a number changed, and two functions would have
meant two places to fix a bug in one card.

**An additional cost that is not optional.** The sacrifice machinery has existed since activated
abilities got costs; a cast could not ask for one. Paid as the spell is cast, which means the
creature is dead before anybody holds priority and its death trigger goes on the stack *above* the
spell that killed it (CR 603.3b) — the difference between Bone Splinters and "destroy target
creature, then sacrifice one", which is a much worse card. And a spell whose additional cost cannot
be paid is not castable at all (CR 601.2h), so it is not offered rather than offered and refused.

**Two engine gaps closed on the way, because the cards needed them.** A static effect that skips
its own source, for "*other* creatures you control get +1/+0" — a 2/2 lord that pumped itself would
attack as a 3/2, which is a different card. And "a **nontoken** creature you control dies", which
is how nearly every death payoff is printed, and the clause that keeps a deck of 1/1 tokens from
draining the table to zero by accident.

**And the bot had to be taught both of the new cast-time choices**, because the engine would
otherwise have refused what the table offered it: it sent a kicked play without the kicker — which
is not a refusal but something worse, the cheap half of a card offered as the expensive one — and a
Bone Splinters with nothing named to feed it. Its judgement about *whether* to feed one is shallow
in the same way as everything else in that file and says so: the cheapest creature it has, and only
when that creature is worth less than what the spell is aimed at.

Measured over 24 unsteered games on the new deck: 21 kicked, 38 cast by sacrificing a creature, 6
lands cycled out of 46 chances, every game finished, 22.5 turns on average.

## D53 — The bot looks one move ahead, and the measurement decided everything

The bot took the most expensive play it could afford. That is a ranking, not a judgement, and this
document has been carrying its failures as jokes for weeks: the Hurricane it casts for eight into a
board of its own fliers, the Shock it points at a 1/1. The fix is the one the file's own header
promised and deferred — a position evaluator and a search — and it was worth writing now because
every rule underneath it is trustworthy.

**Decided: one ply, and a cheap simulation of it.** For each play the bot could make, apply it and
let the stack resolve with nobody responding, then score the position. That is the line the bot is
actually choosing between — a spell cast into an empty stack on its own turn usually resolves — and
it is the cheapest simulation that shows what a card *does* rather than what it costs. A second ply
needs an opponent model, which is this same function recursing, and that is not worth writing
before the evaluation has a number behind it.

**The number: 105 wins to 55 over 160 games** against the bot it replaced, alternating which seat
searched so that neither the decks nor the turn order could explain the result. Every game
finished, 17.9 turns on average, no refused actions.

**Decided: the old bot stays, behind `{ lookahead: false }`.** A claim like the one above needs a
control that can be re-measured, and the tests that play dozens of games want the cheap bot anyway
— it is not only faster, it is *wilder*, casting whatever is most expensive and so wandering into
more of the engine than a bot that plays well ever would. Breadth is what those tests are for.

**Two things the measurement found that reasoning had not.**

*A land in play has to be worth more than a card in hand.* Otherwise the land drop lowers the score
and the bot stops making it — which it did, losing 60 games out of 60 while looking exactly like a
weight that needed nudging. The land drop is taken as a rule before the search now, which is what
the old ranking's "always make your land drop" had been saying all along; the weights still have to
agree with it, because a bot that would not play lands is not a tuning problem, it is a bot that
does not play Magic.

*Weighing a play against doing nothing made it worse.* Requiring a play to beat the current
position by a margin is the obvious way to stop a bot spending removal on a 1/1 — and it cost
twelve games in sixty (28 wins against 40 with no baseline at all). The reason is that a card kept
is a card the evaluation scores, while the turn it cost is invisible to it: the discipline was
imaginary and the wasted turns were real. So the baseline is gone. The search answers *which* play,
and the old bias to always make one stands.

**The weights are four numbers and a comment each**, and the comment is what each one broke when it
was wrong. Creatures are power plus toughness, the same measure the blocking logic already uses to
judge a trade, so the bot values a creature the same way whether it is deciding to cast it or to
block with it.

**Cost, since an opponent that thinks is only better if nobody waits for it:** 0.1–0.3ms per
decision at the median, under 9ms at the 95th percentile, 32ms at the very worst in a four-player
pod. The browser suites are unchanged in feel — a solo pod plays 282 moves in 45 seconds, and the
bots are not what it is waiting for.

## D54 — Combat is chosen by playing it out, in whole plans

Attacks and blocks were the last two judgements the bot made by arithmetic. `exchange()` answers
"would this creature die to that one", one pair at a time, and knows nothing about what the whole
exchange leaves behind — which is most of what combat is.

**Decided: plans, not creatures.** Combat is not a sum of independent choices, so the search
compares whole declarations: what the heuristic would do, nothing at all, everything that can
attack, and the heuristic minus its biggest creature. Four plans rather than every subset — ten
attackers have a thousand subsets, and these four are the shapes a player actually chooses between.
Blocks get the same treatment with three.

**Decided: the defender blocks with the bot's own policy.** It is the only opponent model there is
and the fair one: the other seat is assumed to answer as well as this one would.

**The number: 270 wins to 130 with the combat search against 253 to 147 without**, on the same 400
games with the same seeds and the same opponent — 17 games that turned on a declaration. It changes
the attack in 126 of 479 combats (85 of them attacking with *fewer* creatures), and the blocks in
40 of 161.

**And the simulation has to finish the combat, not the step.** The step moves on the moment damage
is dealt, while the triggers that damage raised are still on the stack. Scoring there meant two
creatures dying in front of a Blood Artist counted as an even trade, because the four points of
life had not happened yet — and the bot traded into a drain engine every time. Both simulations now
answer whatever the line is waiting on, with the same aiming policy a real decision uses, rather
than stopping at the first trigger that wants a target. Worth five games in 400 on its own, and it
is the one case in this work where the fix was a bug rather than a weight.

**Two things the measurement refused.**

*Holding a blocker back.* The honest way to express it is to see the swing back, which is the
second ply. The cheap substitute is to score an untapped creature above a tapped one so that
attacking costs something — and it lost: nothing at one point, 26 games in 400 at two points, and
at four points the bot was *worse than the shallow one it replaced*. In this pool attacking is
right, and a bot that keeps blockers home is a bot that never closes. The term is gone, and this
paragraph is here so the next person to have the idea does not have to measure it again.

*A loyalty counter being worth nothing.* The search had quietly stopped using planeswalkers — three
activations across sixteen games, against more than one per planeswalker for the bot before it —
because a plus ability bought something the evaluation could not see, and the test that says
"activated more often than cast" is what caught it. Loyalty is a planeswalker's life and its
spell-per-turn, so it is scored at about the value of a point of life.

**Cost:** a decision takes 2ms at the median in a duel and 0.1ms in a pod, under 15ms at the 95th
percentile, 61ms at the very worst. The two tests that play twenty whole games with the searching
bot now need more than vitest's default five seconds, which is the price of the player meeting the
bot the tests measure.

## D55 — Exile until this leaves, and the word "another"

Oblivion Ring, Journey to Nowhere, Banisher Priest, Fiend Hunter: the commonest removal in Magic,
and none of it could be written, because the engine had no way to say "until this leaves the
battlefield".

**Decided: a leave-the-battlefield trigger, recorded where `dies` is recorded.** A Banisher Priest
gives its creature back whether it was destroyed, exiled, bounced or sacrificed, and every one of
those is a different caller. `relocate` is the one place a card changes zone, so that is where the
event is noticed — the fourth rule to end up there, after `dies`, `etb` and printed loyalty, and
for the same reason every time: there is no path that can forget. It is wider than `died`, which is
only the cards that reached a graveyard.

**Decided: the link lives on the exiled card.** `exiledBy` on the card in exile, not a list on the
exiler, which is the same shape as an Aura keeping its host: one card in exile is held by at most
one thing, while one permanent could in principle be holding several. It comes back under its
**owner's** control, not its exiler's — getting that wrong would make Journey to Nowhere a Mind
Control with extra steps.

**And the card is Banishing Light, not Oblivion Ring, because of one word.** Oblivion Ring says
"exile target nonland permanent", and alone on an empty board the only legal target is itself: it
exiles itself, leaving the battlefield fires its own return trigger, the return brings it back, and
entering exiles it again. Fifty iterations and a game over on turn five, in two of thirty unsteered
games — a real loop on a real card, which the engine reproduced faithfully. The fix is not a house
rule in the engine, because the engine was right. It is to print the card that says "another",
which is what Wizards themselves did ten years later. Oblivion Ring stays in the comment, because
the next person to reach for it should know what it costs.

**The same word found a bug that had been in `legalActions` for weeks.** A trigger waiting to be
aimed listed its candidates with `legalTargets(state, spec, seat)` — no source — so every filter
that says "another", or "a creature this is not already attached to", was offering the ability's own
permanent. The engine's own `chooseTargets` does pass the source, so it refused the choice the
table had offered: a table offering a move the engine rejects, which is the one failure
`legalActions` exists to prevent. It went unnoticed because no card in the pool needed the word
until this one.

**Measured over 30 unsteered games:** 25 of the three cards cast, 18 of those finding a legal target
and exiling something; the other seven correctly did nothing, since a trigger with no legal target
never goes on the stack (CR 603.3c). No game destroyed the exiler, so the giving-back half is held
by tests rather than by a measurement — one test per way of leaving, because "it works when it
dies" is the easy third of the rule.

## D56 — Two mana off one tap, and the land it stopped wasting

The mana solver has always had two shapes for a source: a *sum* (`produces: ['C','C']` adds two)
and a *choice* (`choose: true` over `['U','B']` adds one of them). The distinction is the whole
difference between a Sol Ring and a Guildgate, and it has been in the comments since the solver was
written — with nothing in the pool exercising the first half of it. A live path with no card behind
it is the same risk as an untested one, so: Sol Ring, Mind Stone, and Birds of Paradise, which is
the choice shape taken as far as it goes (five abilities, one tap, one mana of any colour).

**And the first card that makes two mana immediately found a bug.** For the generic part of a cost
the solver took whatever was first in its list of untapped sources. With every source making one
mana that was fine. With a Sol Ring in play it tapped a Swamp for one, found the cost still short,
and tapped the Ring as well: three permanents spent on a cost that two could pay, and a land left
face down that could have cast something else. It now picks the largest source that still *fits*
what is owed, and the smallest overshoot when nothing fits — which is the tap a player would make,
and the reason both halves are tested: "fewest taps" alone would pay a one-drop with a Sol Ring.

Nothing about this is visible in a win rate; it is visible as a land still untapped when the
opponent casts something. That is the kind of thing a person notices in the first ten minutes of
playing and would not report as a bug.

## D57 — Two numbers that say who the threat is

Everything on a seat strip said how the game had gone — life, hand, graveyard, poison, commander
damage — and nothing said what was about to happen. In a duel that is survivable: there is one
board opposite you and you are already looking at it. In a four-player pod the boards are in three
columns and the question "can they kill me, and can they stop me if I go at them instead" takes
twenty seconds of counting, every turn, which is exactly the kind of work a table is supposed to do
for you.

**Decided: total power, and how much of it is untapped.** Not a threat score, not a ranking — two
facts, in the order a player needs them. Power is what can kill you on their turn; untapped is what
can stop you on yours. A single number would have hidden the difference, and a computed "who is
winning" would be the table telling players what to think about each other, which in a pod is the
players' own business.

**Read from the view, not recomputed.** `boardRead` walks the same `zones` the board is drawn from
and uses the view's `power`, which is the engine's computed value — so a 2/2 under a Glorious
Anthem counts as three, and the number on the strip cannot disagree with the number on the card.
It is shown only on an automated table: on a tabletop nothing is computing anybody's power, and a
number there would be a guess dressed as a fact.

## D58 — An action has two versions, and only one of them was being asked about

The solo pod suite started failing with "Firebrand Archer can only be cast in your main phase with
an empty stack" — a refusal on a button the table was showing the player. Not a rules bug: a play
is composed from the view React last rendered, and by the time the click lands the table may have
moved on. In a pod with three server seats it moves constantly.

The client already had a guard for this: swallow an `illegal_action` when the table has moved since
the action was sent, because then the player did nothing wrong. It never fired, and the reason is
that the action was stamped with `versionRef.current` at *send* time — the newest version, because
that is what the store will accept. So the guard compared the newest version against itself while
the play it was judging came from a view one or two versions older.

**Decided: an action carries the version of the view it was composed from.** `send(action,
basedOn)`, with `basedOn` being what React last rendered, so "has the table moved since this play
was offered?" is a question that can actually be asked. The stale play is dropped silently, which
is what "the moment passed" means — a human tap that lands a version late deserves nothing
happening, not a red banner blaming them for a button the table drew.

Worth naming what found it: a suite that taps as fast as the server plays. A human would have hit
this too, just less often, and would have reported it as "it said no for no reason".

## D59 — "Again" is one tap, and it is a composition rather than a rule

The game-over panel had one button: "New game", which is `game:reset` — the table emptied back to
an unstarted tabletop with no decks and no engine. That is exactly right when somebody is changing
decks or the next thing they do is leave, and exactly wrong when two people have just finished a
game and said "again", which took a reset, two deck picks, a start, and a switch back into Arena
mode. Five actions and a deck picker between one game and the next, in a product whose whole point
is playing Magic with a friend.

**Decided: `game:rematch`, composed out of the reducers rather than written as a new rule.** It
applies reset, then `deck:load` for each seat's own deck, then `game:start`, then `auto:start` if
the engine was running — the same actions a player would drive by hand. So a deck that no longer
resolves fails the rematch the same way it fails the manual version, every permission and legality
check is enforced by the thing that already enforces it, and the log reads as if somebody had done
it themselves. A new rule would have been a second implementation of four existing ones.

**Decided: any seated player may ask, and only once the game is over.** A reset mid-game is the
host's, because it throws away a game in progress. "Again" after a finished game is nobody's
privilege, and a rematch that only worked for whoever created the table would be a worse feature
than no rematch. The steps inside run as the table — otherwise `deck:load` for the *other* seat
would refuse — which is the permission question being answered once, at the top, instead of four
times in the middle.

**Decided: the previous winner goes second.** The convention at every table, and the engine knows
who won, so there is nothing to ask anybody. With no winner — a draw, or a game nobody finished —
the seat that went first goes first again, because there is nothing to take turns about.

The two buttons now say what they do: **Play again** is the one a player wants, and **New game** is
beside it in a quieter style for when the decks are changing.

## D60 — Eight cards that needed nothing, and a draw nobody had seen

The pool is a hundred cards and `effects.ts` covers far more than that, so this round is breadth:
eight cards that each fill a gap the decks actually felt, and not one of them needed a new engine
feature.

The three worth naming:

**Day of Judgment**, because no deck could answer a board it was behind on — every piece of removal
in the pool killed one thing. A wrath is also the sharpest test of the search: casting it is right
when behind and catastrophic when ahead, and the only way to tell is to play it out. Measured over
40 games it was castable on 24 moves and cast 5 times, three of those from behind on board. The
other two are the standing cost of the bot having no "do nothing" option (D53) — when a wrath is
the only play it has, it casts it. That is written down rather than hidden, because it is the
cheapest honest description of a bot that always acts.

**Icy Manipulator**, the first card to point at any permanent and do something other than exile it.
A tapper is removal that gives the thing back every turn, and it works without telling anybody:
`tapped` is a fact about a permanent that the attack rules, the block rules and `manaSources` all
already respect, so one line of effect turns off a creature, a land or an Equipment.

**Tormod's Crypt**, the first card to touch a whole zone rather than a card in one — and the only
answer any deck has to a Gravedigger loop.

**And a draw is a legal ending the arena suite had never seen.** Two players died in the same
event — mutual combat damage on empty life totals — and the engine ended the game with no winner,
which is correct (CR 104.4b). The suite failed, because it asserted that somebody wins. It now
asserts that the table says what happened and that both screens say the same thing, which is what
the test was always about.

## D61 — A watcher is a third party, and gets its own component

The spectator view has existed since redaction went in: public zones, both hands as face-down
counts, no legal moves. Nothing could ask for one, because `pod:join` always takes a seat and
refuses once a game has started — so a friend who wanted to watch had to be handed somebody's
screen, which is also the only way to cheat at this game.

**Decided: `pod:watch`, in the room and out of the game.** No name and no seat token, because a
watcher is not a player: it holds nothing and is owed nothing. `broadcast` already sends a seatless
socket the spectator view, and every handler that changes anything already calls `requireSeat`, so
the server side is one handler and no new rules. The pod's status is deliberately not checked: a
watcher arriving mid-game is the normal case, and a table that only admitted watchers in the lobby
would be useless for the thing people actually want to watch.

**Decided: a separate component rather than `Board` in read-only mode.** `Board` is a thousand
lines of "what may I do with this card" and a watcher may do nothing with any of them. A `readOnly`
flag would be a branch on every tap handler in the file, and the branch that got forgotten would be
a watcher playing somebody else's turn. The duplication is a few zone rows; the alternative is a
security property maintained by vigilance.

**And the suite found the last send that was not saying which view it came from.** D58 gave every
action the version of the view it was composed from — through `act`. Every button on the *control
bar* goes through `dispatchArena` instead, which was still sending without it, so a Pass pressed as
blockers became owed read to the client as an illegal action rather than a late one. One path
further along, the same bug, found by the same kind of test: a suite that taps as fast as the server
plays.

Two more browser-driver flakes closed while this was going in, both of the same shape as the clicks
and the text reads: a play sheet that does not open is a card this move does not play, not a run
that ends with a stack trace; and a press on a panel that is re-rendering gets three tries.

## D62 — Three things tried on the opponent, one of them worth keeping

The search looks one move ahead. The obvious next step is two, so this round was spent finding out
whether depth or judgement is what limits it. The answer was judgement, and the measurements are
worth keeping because each one is an idea somebody will have again.

**Looking one swing ahead: no difference.** A full second ply means modelling every reply to every
play; the cheap version is to model the only reply that matters — the opponent's next attack — and
score the position after it. Built as a two-stage search (score every candidate cheaply, then
project the swing for the closest few), measured on 400 paired games: **276 wins with it, 276
without**, at twice the time. Then aimed at the one decision where it should matter most, the attack
declaration, where "should I send the last untapped creature" is explicitly a question about the
opponent's turn: **276 again.** Removed. The comment in `scoreDeclaration` carries the number, so
the next person to reach for depth starts from the finding rather than from the intuition.

The reason, as far as it can be read off the games: in a pool this size a lot of games are decided
by what was drawn, and a bot that already plays each option out one move captures most of what
there is to capture against a bot that plays the most expensive card. The ceiling is the
evaluation.

**A keyword is worth something: eight games.** `creatureValue` was power plus toughness, which made
a 2/2 flier the same creature as a 2/2 Grizzly Bears — not only to the evaluation, but to the
combat heuristics that use the same function to decide whether a trade is good. Keywords now carry
a small value each, in the same units as a body: flying and deathtouch 1.5, indestructible 2, down
to reach at a quarter. **284 wins to 116, up from 276 to 124** on the same seeds. It is the first
piece of actual Magic knowledge in the evaluator, and the cheapest.

**A non-linear life total: nothing.** Two life is worse than twenty minus eighteen, which is true
and did not show up: 285 against 284 over 400 games, with sweeps over where "nearly dead" starts
and how fast it bites. Removed, with this paragraph in its place.

**And a flake fixed with the number that found it.** The assertion added in D50 — that an action
after the game is over comes back as `game_finished` — fired at the end of a burst of several
hundred sends and read `rate_limited` once in six runs. It backs off like every other send in that
test now. Six consecutive green runs, which is the only kind of evidence an intermittent failure
accepts.

## D63 — An attack is an event the whole board can watch, and a card that changes zones is a new object

Hellrider is one line of printed text — "whenever a creature you control attacks" — and the engine
could not express it. The `attacks` event was raised for the attacking creature and offered to that
creature's script alone — right for an attack trigger that talks about itself, and wrong for every
one that watches the board. (Nothing in the pool used the event at all, which is how it stayed
self-only: Hellrider is the first card scripted that attacks are a *table* event for.) It now takes the same `who`/`of` pair that `etb` and
`dies` already took, is offered to every permanent on the battlefield, and each trigger's own
filter decides whether it wants it. A trigger that says nothing about `who` still means `self`, so
nothing written before this changed meaning.

**And it needed one thing the other board-watchers do not: what the attack was aimed at.** "Deals 1
damage to the player or planeswalker it's attacking" is about *that* attack, and by the time the
trigger resolves the attacker may be dead and the attack gone from combat — so the board can no
longer answer. The declaration copies it onto the event, `raise` copies it onto the stack object,
and `EffectContext.attacked` is where the script reads it. In a pod three creatures attacking three
players produce three triggers that each hit the right one, which is the case that makes this worth
a field rather than a lookup.

**Then Cloudshift found a rule the engine had never needed.** One white mana, "exile target creature
you control, then return it to the battlefield" — two `relocate` calls and no new vocabulary, which
is the whole reason it was worth scripting. It re-triggered the Elvish Visionary's draw and cleared
the damage on the way through, both for free. What it did *not* do was the thing players actually
cast it for: blinking a creature in response to a Doom Blade left the Doom Blade resolving happily,
because the engine keeps one id per physical card and the removal found its target exactly where it
left it.

A card that changes zones becomes a **new object** (CR 400.7), and a spell does not resolve against
an object that is not the one it targeted (CR 608.2b). Rather than churn ids — which is what the
table, the tests and the animations all read as card identity — each instance now carries an
`objectSeq` that `relocate` bumps on every zone change, and a stack object records which object
each of its card targets *was* in `targetSeqs`. `resolveTop` drops the targets that have since
become something else, before the fizzle check, so a spell that lost one of two targets resolves
against the one it still has and never sees the other. Four lines of comparison, one new field, no
change to `Target` and nothing new on the wire.

**And the same question was being got wrong in combat.** A permanent that leaves the battlefield is
removed from combat (CR 506.4), so a creature blinked out and back mid-combat is not an attacking
creature — but the engine found the attack entry's id back on the battlefield and swung with it. A
Cloudshift on your own blocked attacker got its damage through, which is a free win nobody printed.
Each attack now records which object its attacker and blockers were when they were declared, and
`dealCombatDamage` ignores the ones that are something else now. The *blockers* are compared rather
than removed from the list on purpose: that list is also what says the attacker is blocked at all,
and a chump blocker that dies still stops the damage (CR 509.1h).

The fizzle check needed one distinction it had not needed before: "chose nothing" and "lost
everything it chose" are not the same. A spell with an optional target that was pointed at nothing
resolves; one whose only target is gone is countered. The count it started with decides, which is
the bug the existing Counterspell and Lightning Bolt tests caught within a minute of the change.

**And a sampled observation in the browser suite, reported as a fact.** The arena run came back
once saying no attack was ever drawn on the board, in a game full of attacks: the arrows exist only
while the attack stands, and a defender with no legal block is never asked for one, so the engine
can be through combat before any page is looked at again. It is sampled at the one moment it is
certainly true now — immediately after the declaration — on top of the old opportunistic check.

## D64 — The pod decision, on the button that makes it

A four-player board shows everything and concludes nothing. D50 put two numbers on every seat
strip — total power, and how many creatures are untapped — which answered "what can hit me". What
it did not answer is the question a pod turn is actually spent on: **which of these three people do
I attack**, and that one needs their life total, what they have left to block with, and whether
this swing finishes them, all at once, while the clock runs.

**Untapped *power*, not untapped creatures.** The strip said `board 11 (2 up)`. Three untapped 1/1s
and one untapped 7/7 are the same `2 up` and nothing like the same turn, and both questions the
number is read for — what can block my attack, what can kill me on their turn — are about power.
It reads `board 11 · 7 up` now. The count stays in `boardRead` because one question really is a
count: "can they block at all", which is what decides whether an attack is lethal.

**The read is on the button that sends the attack.** Each defender in the attack prompt now says
their life, what they have untapped, how many of your creatures are already aimed at them, and
`lethal` when it applies. Put there rather than in a panel of its own because the choice is made
by pressing one of those buttons, and a read somewhere else on screen is a read you have to go
and find.

**`lethal` is the strict claim, on purpose.** It appears only when the attack aimed at that seat is
at least their life total **and they have no untapped creature** — nothing to block with, so every
point connects. A seat holding blockers is not marked at all, even at one life, because whether a
block saves them depends on how the attacker assigns damage, and a table that cried lethal and was
wrong would be worse than a table that said nothing. An instant can still save them, which is true
of every lethal attack ever declared.

**And the same marker on an opponent's strip, the other way round.** Their untapped power alone is
at least your life and you have nothing untapped to block with: that is a warning you can act on
this turn, and it is the one conclusion the table draws for you.

**"All at them" is one press.** Re-aiming a single attacker was already a second tap on it. What
was missing is the commonest decision in the format: four creatures aimed around the table, then
one life total drops and all of them should go at that player — by hand, four untaps and four
retaps with the aim changed in between, which is long enough for the moment to pass. `aimAll`
rewrites every declared attack, clearing a planeswalker aim rather than leaving it on the attacks
that had one, because "all at them" means the player.

**What this does *not* add is a verdict on who is winning.** Life totals sit side by side on four
strips already, so "who is ahead" is on screen; a composite score of life and board and cards
would be a guess dressed as a fact, which is the one thing a table must not do with a number. The
numbers it shows are the ones it can compute exactly.

## D65 — Four keywords the engine enforced for nobody, and the scope nothing used

First strike, menace, indestructible and shroud were all written, all checked in the rules —
`dealsInStep`, `menaceSatisfied`, `destroy` and the lethal-damage state-based action,
`isLegalTarget` — and **no card in the pool had any of them.** `all-creatures` was the same story
one layer up: a static scope with no card behind it. A live path with no card behind it is the same
risk as an untested one, which is the argument that put the mana rocks in; these five cards are
that argument applied to combat and targeting.

- **Youthful Knight** {1}{W} 2/2 first strike. The whole claim is the *step*:
  `needsFirstStrikeStep` only inserts a first-strike damage step when something in combat has the
  keyword, so until this card the step had never happened in a game.
- **Boggart Brute** {2}{R} 3/2 menace. A single-blocker declaration is refused whole (CR 702.110a)
  rather than accepted and undone, and the table only lights blocks the engine would take, so the
  rule shows up as "that creature cannot block this alone" rather than as a surprise.
- **Darksteel Plate**, equip {2}, equipped creature is indestructible. Written with the existing
  `equipment()` helper's keyword grant, so the card is four lines and the keyword does the work: a
  2/1 with three damage marked on it stays on the battlefield, and Doom Blade resolves and
  accomplishes nothing.
- **Robe of Mirrors** {U} Aura, enchanted creature has shroud. Shroud rather than hexproof on
  purpose: hexproof is the keyword players expect and shroud is the one that tests the rule, because
  it stops the *controller* targeting it too — no Giant Growth, no targeted equip, no Cloudshift.
  The engine already made that distinction and nothing had ever asked it to.
- **Night of Souls' Betrayal** {2}{B}{B}{B}, all creatures get -1/-1. The first `all-creatures`
  static, and the hardest thing in the pool for the state-based actions: every 1/1 on the table
  dies at once when it lands, and every 1/1 token afterwards arrives dead (CR 704.5f) — a loop
  `stateBasedActions` has to settle before anybody gets priority back. One copy in one deck, which
  also sidesteps the legend rule on a non-creature permanent.

**Measured over thirty unsteered games across three pairings**, because a card that is in a deck and
never cast has not been tested: Boggart Brute cast 20 times and attacked, Robe of Mirrors cast 17,
Youthful Knight cast 11, Darksteel Plate cast twice (one copy, one deck) and held a creature up
with lethal damage marked on it twice, Night of Souls' Betrayal cast 3 times and killed a creature
as it landed. **The first-strike damage step happened once in thirty games** — not because the card
does not work, but because the step only exists when a first striker is actually *in* combat and the
searching bot blocks rarely; the deterministic test is the one that holds that claim.

**`becomes-tapped` is left unused, deliberately.** It is the last trigger in `scriptTypes.ts` with
no card behind it, and the honest reason is that the bare "whenever ~ becomes tapped" template is
not on a card this pool would carry. The cards that look like it — "whenever enchanted land is
tapped for mana" — are triggers on an *Aura* about the permanent it is attached to, which a
self-only event cannot express. Inventing a card for the path would be worse than saying that.

**And a test whose timeout was a measurement of this machine.** The four-seat payload-budget test
packs and unpacks four views after every action of a whole pod and ran at 2.7s against a 5s default,
which timed out twice in a day beside five other packages' suites. It takes the same 60s the other
whole-game tests take now. A timeout that fails on a slow afternoon is not a test of the payload.

## D66 — Taking the last move back, one step, the host's call

The misclick was the one failure at a real table that nothing here could recover from. An
unscripted card has Move by hand, a dropped phone reclaims its seat, a game that cannot continue
has never happened in thousands of playouts — but a creature tapped into the wrong attack, a land
played before the Guildgate, or a Pass pressed a beat early was permanent. On a kitchen table you
say "hang on" and put it back.

**It belongs to the table, not to the rules.** The engine is an immutable reducer, so the previous
state *is* the previous state: there is nothing to invert and no rule to write. `pod:undo` restores
the pod record the store held before the last game action, and `packages/rules-engine` does not know
the feature exists.

**One step, written inside the same compare-and-set as the action.** `PodRecord.previous` is the
prior record serialized, set by `mutate` only for `applyAction` — a join, a ready-up or a heartbeat
must never be undoable — and stripped of its own `previous` so nothing nests. Keeping it in the same
CAS is the whole reason it can be trusted: a history written in a second round trip can tear away
from the state it belongs to. The cost is honest and worth naming: the stored record is about twice
the size while a step is held, and each action pays one `JSON.stringify` of the prior record.

**One step rather than a stack**, because that is what "put it back" means. A chain of undos is a
different feature — rewinding a game — and it would hold a copy of a whole game state in Redis per
step for something nobody asked for.

**It takes back the server's replies with it.** A move against the bots and the three answers it
provoked land in one pod version by design (D-something ago: `runBots` runs inside the same
mutation), so one undo is one thing that happened, which is also what the player means.

**The host's button and nobody else's.** It is the one affordance at this table that rewrites what
has already happened, and in a hidden-information game that is not a power to hand round. Three
things keep it honest: only the host may press it, the pod says `undoable` so the button is simply
absent when there is nothing to take back (rather than erroring), and the table announces in chat
that somebody took something back — an undo nobody can see is indistinguishable from the server
losing a move.

**And the limit is stated rather than hidden:** the previous state is exactly the previous state,
so a card drawn and then taken back has still been seen by whoever drew it. That is true across a
kitchen table too, and it is the reason this is one step, host-only and announced.

The announcement is a chat message rather than a line in the game log on purpose. The log is the
engine's, and the restored state carries the log it had — the undone move's own line is gone from
it, which is correct, because it did not happen.

## D67 — The seventh deck, and what measuring it changed

Six decks, and the two colours with the most answers in the pool had never been played together:
every counterspell sat in a deck beside black removal, and every flier but the Drakes sat in a
green-white deck that wants to attack on the ground. **Skyward Writ** is white-blue tempo — hold the
ground, answer the one spell that matters, win in the air — and it is the first deck whose plan is
*not* to have the best board.

It needed three cards. **Azorius Guildgate**, one line through the `guildgate()` helper.
**Wall of Air**, the first card in the pool with `defender` and flying at once. And
**Hanna, Ship's Navigator** as the commander, the first in the pool whose text is an activated
ability pointing into a graveyard — which needed no new vocabulary: `graveyard-card` has always
taken any card with a filter, and the filter is the card's printed type line, which is the right
test because a card in a graveyard has no continuous effects applied to it.

**Then it was measured, and the measurement rewrote it twice.**

- **First version: 19 wins, 41 losses over sixty games**, including 1-9 against both aggro decks. It
  cast everything — 38 Counterspells, 16 Hanna activations — so nothing was broken. What was wrong
  was that it had nothing alive to answer *with*: 24 lands, a 5-mana 3/2 flier, and two blockers.
- **Second version: 29-31.** The fix was bodies rather than answers: four Walls instead of two, a
  third first striker, two blockers for two mana at instant speed, and a one-drop that gains life
  for every creature anybody plays. Lands down to 23.
- **Third and current: 50-70 over 120 games**, which is 42% against the whole field, with the
  spread a tempo deck should have: **16-4 against Tidal Mind, 13-7 against Rot Harvest, 9-11 against
  Ashen Rite, and 5-15, 5-15, 2-18 against the three decks that attack fastest.**

**And a card was cut by the numbers.** Moon Heron — a 3/2 flier for five — was written, scripted,
played sixty games across two versions of the deck, and deleted, because it never earned the slot.
The def and the script are gone with it; what is kept is the fact that it was measured.

**Two honest reasons the overall number is under half**, and only one of them is the deck. The deck
loses to go-wide green-white because its blockers are 1/5 Walls and its removal is one-for-one, which
is a real matchup. The other reason is the bot: **holding mana for a counterspell is this deck's
whole plan and the search cannot do it** — it casts a counter when a counter is castable, not when
it matters. That limitation is written up in D62 and the ceiling it describes is the evaluation, not
the depth. A person playing Skyward Writ plays it better than the bot can, which is not a claim
about this deck so much as about the one thing the opponent still cannot do.

The testkit also gained a `graveyard` option for `arena()`, because the three new tests needed cards
in a graveyard and every earlier graveyard test had been putting them there by hand.

## D68 — Holding mana for the answer: measured, and worth nothing

The seventh deck's win rate pointed at the obvious hole in the search: a land is worth the same
tapped or untapped, so spending mana costs the evaluation nothing, the bot taps out every turn, and
it is then holding a counterspell with no mana when the spell worth answering arrives. So the term
was built — a little for each untapped land, but only while the hand holds something castable at
instant speed, capped at the cheapest such card's cost, because mana up with nothing to spend it on
is worth exactly nothing and more mana than the answer needs buys nothing either.

**Eighty-four paired games per weight, same seeds, the two control decks against the three that beat
them fastest plus the control mirror:**

| mana-up weight | control decks | counterspells cast |
| --- | --- | --- |
| 0 (none) | 23-61 | 75 |
| 0.5 | 23-61 | 80 |
| 1.0 | 20-64 | 79 |
| 2.0 | 18-66 | 78 |

Monotone, in the wrong direction. At 0.5 it is exactly a wash and costs a scan of the hand on every
evaluation; above that it loses games. **Removed**, with the table in the comment where the next
person reaching for it will look — the third idea about this search to be built, measured and
deleted, after the swing-ahead projection and the non-linear life total.

What the measurement is worth is the correction it made to the premise. **Every counterspell the bot
casts is already cast in response** — 75 of 75 with the term off, 80 of 80 at 0.5 — and it could not
be otherwise: a counterspell targets a spell on the stack, so with an empty stack it has no legal
target and `legalActions` never offers it. D67 said the bot "counters what is counterable, not what
matters", and the mechanism in that sentence was wrong. What is true is narrower and more useful:
the bot is often tapped out when the moment comes, and **valuing untapped mana does not fix it,
because the board the mana bought is worth more than the answer kept for it.** For a control deck
to beat an aggressive one in this pool, the bot would have to know *which* spell is worth answering
— that is a judgement about the opponent's hand and board, not a price on a land.

The claim in `claude/play-realm-setup.md` that a person plays the control decks better than the bot
stays, because it is still true. What changed is the reason given for it.
