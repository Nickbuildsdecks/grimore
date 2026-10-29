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

## D69 — What the control decks actually do wrong, counted

Two measurements had pointed at the same wall and neither said what to build: depth is worth nothing
(D62), pricing untapped mana is worth nothing (D68). Both of those were fixes aimed at a story about
what the bot was doing wrong, and D68's story turned out to be false. So this is the diagnostic that
should have come first — sixty games of the two control decks against the three that beat them
fastest, counting rather than guessing.

**The instrument was wrong the first time, which is worth recording.** It asked what the control
seat did at the moments it was *asked to act* with an opponent's spell on the stack, and reported
"held a counterspell it could not afford: **1**". That reads as "the tapped-out story is false" and
it is an artifact: the engine auto-passes for a seat that can do nothing, so a seat tapped out with
a counterspell in hand is never asked, and the moment it is in never appears. Measured again at the
moment the opponent's spell goes on the stack, and asking the mana solver directly rather than
asking what the bot was offered:

| | |
| --- | --- |
| Moments with an answer in hand as an opponent cast | **51** |
| …could pay for it | 30 |
| …could not | **21** |
| Its own turns | 563 |
| …on which it cast nothing at all | **118 (21%)** |
| Average turn it lost on | 21.3, at −2.9 life |
| Average turn it won on | 21.9 |

**And the spells it could not answer:** Rampant Growth 6, Faithless Looting 4, Banishing Light 4,
Banisher Priest 2, Magma Jet 2, Monastery Swiftspear 1. Mostly not threats. So being tapped out at
the moment is real — 41% of the moments that mattered — and mostly irrelevant, because what it
missed countering was a ramp spell. **That is the better reason D68 belonged in the bin:** pricing
mana would have bought the right to counter a Rampant Growth.

**The fault the data does name is the opposite of the assumption.** In the first instrument's 28
moments where it could pay, it countered **28 times and declined none.** It never saves an answer.
By this evaluation it should not: countering anything is a gain, because the spell does not resolve,
while the counterspell itself is priced as a generic card — so spending it is nearly free and
Counterspells go on Rampant Growths.

That is a specific, testable hypothesis rather than another weight on a feeling, and it is the one
thing a one-ply search structurally cannot see: what an answer is worth depends on what it will be
pointed at later. The experiment is to price an answer in hand above a generic card, and it is
measured in the next entry.

## D70 — Pricing the answer: measured, worth nothing, and the ceiling named

D69's diagnostic found the one thing this search demonstrably gets wrong: over sixty games it never
once declined to counter a spell it could pay for. By the evaluation it should not — countering
anything is a gain, and the counterspell in hand is priced as any other card, so spending it is
nearly free. Hence Counterspells on Rampant Growths.

So an answer in hand (anything castable at instant speed) was priced above a generic card.
**Eighty-four paired games per value, the same seeds and pairings as D68:**

| answer in hand | control decks | counterspells cast |
| --- | --- | --- |
| 1.5 (as any card) | 23-61 | 75 |
| 2.5 | 22-62 | 82 |
| 3.5 | 21-63 | 83 |
| 5.0 | 21-63 | 83 |

The 1.5 row reproduces D68's baseline exactly, which is how a paired measurement says it is paired.
And the second column goes the wrong way: valuing an answer *more* made the bot cast **more**
counterspells, not fewer. Holding answers made its hands bigger and its games longer, and more
counters were spent across the extra turns — the term changed how long it lived, not what it spent
the answer on. Removed.

**Four ideas have now been measured against this ceiling and all four deleted**: a second ply and a
swing projection (D62), pricing untapped mana (D68), and pricing the answer itself (D70). That is
enough to name the wall rather than keep walking into it.

**A sum of material cannot express "this is worth more later than now."** The sum is identical
whether a card is spent well or badly, so every weight that makes holding a card attractive also
makes doing nothing attractive — which is exactly what the sweep shows: longer games, the same
losses. The missing thing is not a number in the sum. It is a judgement the sum has no slot for:
*which of the opponent's spells is the one that beats you*, which depends on their deck, their
board, their hand and the race — none of which the evaluation reads.

What would actually move it, stated so the next person does not re-run these four experiments:

- A real second player in the search (the opponent choosing against the bot rather than passing),
  which is what makes "they will have a better spell next turn" visible at all. D62 measured the
  *cheap* version of this — projecting one attack — and it was worth nothing; the full version is a
  different and much larger piece of work.
- Or a threat classifier: a per-card judgement of what beats this deck, written as Magic knowledge
  rather than derived from the position. That is the kind of thing `creatureValue`'s keyword values
  turned out to be, and those were the one bot change in this whole series that *did* win games
  (D62: 284-116, up from 276-124).

The second is the cheaper bet and the first is the honest one. Either way, the next bot change
should start from the diagnostic, as D69 did, and not from a story about what the bot is doing.

## D71 — A card a test names is pinned to its deck

`testkit.ts` builds a board by pulling named cards out of a real 60-card deck, which is what makes a
test's setup reachable only through actions a player could take. The cost of that is invisible until
you need a deck slot: cutting a card to make room for a new one silently breaks every test that
names it, and the failure arrives as *"seat 0 has no Shock in library"* three increments later.

Eleven new cards displaced the second Shock, Tome Scour and both Secure the Wastes. All three are
back, paid for out of cards no test places twice, and each now carries the reason in the deck list:

| restored | paid for by | why that card could go |
| --- | --- | --- |
| Shock ×2 (Ember Rush) | Shivan Dragon 2 → 1 | a deck whose curve tops at four wants one six-drop, not two |
| Tome Scour ×1 (Tidal Mind) | Tormod's Crypt 2 → 1 | a second copy answers nothing the first had not |
| Secure the Wastes ×2 (Verdant Guard) | Rampant Growth 3 → 2, Selesnya Charm 2 → 1 | four other mana sources on one and two; removal-saturated already |

**The rule, stated so it is not rediscovered:** a deck list is test fixture as well as game content.
Before cutting a slot, grep the suites for the card's name — and if it stays, say in the list that it
is pinned, which is now done for Doomed Traveler, Grizzly Bears and the three above.

## D72 — Two tests that were passing on luck, and how to tell

Reshuffling those decks turned two playout tests red without touching a line of engine code. Both
were measurement faults, and they fail in opposite directions worth being able to tell apart.

**The instrument that looked at the wrong moment.** *"fires death triggers in real games"* searched
`stackObjects` for the trigger's description after each bot action. With auto-pass on, a trigger
nobody can respond to is put on the stack and resolved *inside the same action* — the stack is empty
again by the next line. Measured over sixteen games: **six Doomed Travellers died, six Spirits
arrived, the stack was caught holding the trigger once.** The test had a 1-in-7 chance of seeing what
it claimed to assert, and eight seeds' worth of luck ran out when the shuffle changed. Rewritten to
count the consequence — every Traveller that died left a Spirit behind, whatever killed it — which
is both robust and a stronger claim. `playout.test.ts`'s own `stepWatching` already carried this
warning in a comment; the fix is to read your own notes.

**The timeout that looked like nondeterminism.** *"casts modal spells"* failed, passed and failed
again on three consecutive runs of byte-identical code. That is the signature of a nondeterministic
engine, and the engine has no clock and no RNG outside the seeded one in its own state — so it was
measured before it was theorised: the same twelve games produce the same seventeen modal casts and
the same six mode combinations, identical across processes and within one process twice over. The
test was 4.5s of work against vitest's 5s default, and failed whenever another package's suite ran
beside it under turbo. Four tests in the file had been given `}, 60_000)` by hand as they were
written; the package now sets `testTimeout` once in `vitest.config.ts`, which fixes the class rather
than the four.

**What to check first, next time a test flakes with no code change:** whether the assertion samples
a moment that may not exist (then fix the instrument), and what the test's wall time is against its
timeout (then fix the limit). Neither needs a theory about the engine.

## D73 — React's complaints are not uncaught errors

One run of the browser suites left **7,555** copies of *"Maximum update depth exceeded"* in the dev
server's log, and every suite passed. `page.on('pageerror')` fires for an exception nobody caught; a
render loop is not that — React logs it and carries on.

The loop was `CombatArrows`: `attackSummary(view)` returns a fresh array each render, a `useCallback`
depended on it by identity, an effect depended on the callback, and the effect set state. It ran only
while something was attacking, because the no-combat path already returned the existing state
unchanged — so the table re-rendered as fast as React allowed for the whole of combat, and a
four-player pod stopped answering taps at declare-blockers. **That stall is how it was found: not by
a test, but by a browser suite giving up with nothing on screen to press, and then by reading the
server log by hand.**

Fixed by depending on the combat by value (a string over attackers, defenders and blockers), keeping
the measurement in a ref so the callback is stable, and returning the existing arrows when a new
measurement is identical — which also makes a scroll or resize that moved nothing free.

**The lasting part is the check, not the fix.** All five browser suites now watch the console for
React's own complaints — the update-depth loop, "Cannot update a component", hook-order changes,
missing keys, and anything prefixed `Warning:` — and fail on the first distinct one. It was verified
the only way a check can be: the bug was put back, the suite went red naming it, and the fix was
restored. A check that has never been seen to fail is not evidence of anything.

## D74 — A card spent on nothing is a rule, not a weight

Measured over 120 unsteered games: **Dark Ritual cast 35 times, followed by a spell in the same step
3 times.** The other 32 were a card put in the graveyard for mana that emptied at the end of the
step (CR 500.4).

The cause is structural. `candidateActions` never offers `auto:pass` as an option — D46 measured
that and it is right in general, because the evaluation cannot see what holding a card buys (28 wins
of 60 with a margin, 40 of 60 without) — so whenever a ritual is the only affordable play, it is
cast. By the evaluation, all that happened is that a card left the hand.

**Why this is not another D70 experiment.** D70's four deleted ideas all tried to make a sum of
material express "worth more later than now", which it cannot. This is not that judgement. "A spell
whose only effect is mana, with nothing in hand that mana can pay for" is a fact about the line, in
the same family as the two rules already in the search: no X spell for X=0, and no sacrifice of a
better creature than the one being fed. Those are not weights either.

So: `makesMana` is declared on the script (the engine never reads it — the mana goes through
`addToPool` like any other), and the search drops such a cast unless the simulated line contains a
cast that was not legal before.

**Both of the first two versions were wrong, and instrumenting found both while reasoning had been
happy with each.**

1. It compared the **mana pool** before and after, and changed *nothing at all*: identical records,
   casts and follow-ups across 84 paired games. A simulated line does not stop where the action
   does — with auto-pass on the engine keeps passing for any seat with nothing to do, so the state
   `simulate` returns can be a step or a turn later with the pool long since emptied. The condition
   was false exactly when it mattered.
2. Fixed to check the step and compare *plays*, it then fired on precisely the right lines and
   **still** changed nothing, because `best` was initialised to `options[0]`: a loop that `continue`d
   past every option returned the first one regardless. The search had no way to express "none of
   these". **A filter is only as good as the default it falls back to**, and that is the lasting
   lesson here — the rule is three lines and the bug was in the twenty lines around it.

**Measured, paired on seeds, Ashen Rite against the other six decks, 240 games per arm, then 240
more on a fresh seed set:**

| | casts | followed by a spell | left in hand | record |
| --- | --- | --- | --- | --- |
| without | 164 | 17 (10%) | 7 | 92-148 |
| with | 124 | **115 (93%)** | 44 | 89-151 |
| without, fresh seeds | 148 | 20 (14%) | 5 | 110-130 |
| with, fresh seeds | 107 | **102 (95%)** | 45 | 118-122 |

**Kept, and on a different ground from the four deleted experiments.** Those were kept-or-deleted on
the record because that is all they were for. This one is about the engine playing Magic correctly:
the card does its job nine times in ten instead of one, and the record moves by three games one way
and eight the other, which is nothing for two cards in sixty. A bot that casts a ritual and then
does nothing with it looks broken to the person across the table, and that matters more here than a
win rate that did not move.

**And the calibration note, which is worth more than the rule.** The same configuration scored
92-148 and 110-130 on two seed sets — an **18-game swing on 240 games**. The sweeps in D68 and D70
were read at 84 games, where that scale of noise is larger than every difference they reported. Any
future bot measurement should be at least this size, on at least two seed sets, before a number is
called a result.

One hypothesis about the three games was measured and **refuted** rather than written up: that a
hand holding unspendable rituals would discard real cards at cleanup, since the discard rule pitches
the most expensive card. Over those 240 games there were 18 cleanup discards, 12 of them with a
ritual in hand, and **not one ritual discarded.**

Still open, from the same measurement and deliberately not fixed here: **Titanic Growth was cast 17
times in 120 games and never once during a combat.** The bot plays instants at sorcery speed in its
own main phase, so a pump spell is a permanent +4/+4 on an empty board rather than a blowout on a
block. That is a judgement about when to hold an instant, which is D70's wall again — not a card
spent on nothing.

## D75 — Sound belongs to the view diff, not to the log or the tap

The Play Realm spec has named eight cues since before the rules engine existed, and the React table
had none of them. Three ways to wire them were available and two are wrong.

**From the taps** — play a sound in the click handler — is the obvious one and it is silent for
everything that matters. Most of what a player needs to hear is the *other* seat's turn, or three
bots' turns in a solo pod, and none of that passes through a handler on this client.

**From `view.log`** is the tempting one, because the log already says what happened in words. But it
says it in *prose written for a player to read* — "Nick casts Lightning Bolt targeting Friend" — so
matching on it is matching on wording that is free to change, and the log has been deliberately
rewritten once already (D42). A life total that went down is a life total that went down.

**From the view diff** is what it does: `cuesFor(before, after)` over two consecutive `GameView`s,
which is a pure function with no browser, no AudioContext and no timers in it, tested the way
`arena.ts` is tested. The oscillators live beside it with no rules in them at all, so there is
nothing in the untestable half to get wrong.

Four rules in it exist because the obvious version is worse than silence, and each has a test:

| rule | what it prevents |
| --- | --- |
| the first view is silent | reconnecting to a game in progress announcing a hand, a board and a life total at once |
| a stateVersion that does not advance is silent | an undo (an older state restored) or a rematch reading as a draw step and a spell |
| only this seat's own draws | telling you about a card the opponent drew, which a real table does not |
| triggered abilities are silent, spells are not | a sacrifice deck putting three abilities on the stack for one death |

Plus: at most two cues per update, loudest first, and the step tick dropped whenever anything else
fired — because one action can be a cast, three lands tapping, a draw and a step change at once, and
all five together is a rattle rather than a cue.

**And the check without which none of the above means anything.** The arena suite patches
`window.AudioContext` before the page loads and counts the oscillators the table builds. Every other
check — the toggle flips, the preference persists, nothing throws — passes just as happily when the
feature is completely dead. A headless browser has no speaker, so what can be proved is that the cue
was reached and the nodes were created, and that is the part that can regress. It is the same
principle as the React-warning check in D73: *a check that cannot fail is not evidence.*

It also proved something nothing else had: the sound preference is checked across a **reload**, and
the reloaded table reclaims its seat — which is what `table.ts` has been keeping the table code and
player id in `localStorage` for since the Play Realm was built.

## D76 — A screenshot is a test the suites cannot write

The feed — the engine's own log lines, said on the board for a few seconds instead of behind a
panel — passed every check it had on its first run. Three things were still wrong with it, and all
three were obvious the moment somebody looked at the screenshot the suite had just taken.

1. **Every line was off the bottom of the screen.** `absolute bottom-2` against a board that is a
   column taller than the viewport puts the element at the bottom of the *document*. The suite's
   checks — a line exists, it has text, it does not steal taps — were all true of an element nobody
   could see.
2. **The first line it ever showed was "Nick passes — postcombat main"**, which is where the game is
   rather than what happened, and which the phase bar says across the top in bigger letters.
3. **Left-aligned, it sat across the first card's name.** The hand fills from the left on every
   screen size, so the right end of that row is the emptiest place on the board.

Each fix came with a check that would have caught it, which is the part that lasts: the suite now
measures the feed's rectangle against the viewport and against the control bar, and the step-change
filter has a test naming the exact string that prompted it. But none of those checks would have been
*written* without looking — the failure mode was "correct element, wrong place", and the suite had
no reason to ask where it was.

**The practice this names:** when an increment adds something a player looks at, read the screenshot
the suite already took. The browser suites take dozens per run and they cost nothing to open. Every
other kind of defect in this project has been found by a measurement or a test; these three were
found by looking at a picture, and would not have been found any other way.

A fourth thing came out of the same increment and is the inverse lesson. The arena suite's "an
attack is drawn on the board" check reads for an arrow the instant the declaration returns, and the
overlay measures the DOM a render later — a race. It had been passing for weeks because the render
loop in D73 was re-measuring continuously; fixing that bug made the check a coin flip, which it had
always really been. **A test that passes because of a bug is a test that will fail when the bug is
fixed**, and the fix for the test (wait up to a second) is what the claim always needed.

## D77 — Prevention is a flag on an effect, not a subsystem

Nothing in the engine could prevent damage, which rules out the first family a casual player reaches
for. The obvious design is a prevention layer — shields with quantities, applied before damage, spent
as they absorb — and it is the wrong size for what the cards need.

`ContinuousEffect` already had a scope that can name one card or every creature, a duration, an
expiry pass and a source. `preventsCombatDamage` on it says exactly what the printed cards say:
*combat damage involving these permanents does not happen, dealt by them and dealt to them.* The
engine reads it in one place, `dealCombatDamage`. Fog is the effect with an all-creatures scope;
Maze of Ith is it scoped to one card; Fog Bank is it as a permanent static on itself.

**It is combat-only and the field is named so.** "Prevent the next 3 damage" is a shield with a
quantity that survives partial use and has to meet every source of damage, not just combat. Nothing
in this pool needs it, and a flag that claimed to prevent damage in general while only covering
combat would be worse than one that says what it does.

One branch of combat is reachable by exactly one card, which is why that card exists. A blocker whose
damage is prevented while the attacker's is not — a Fog Bank in front of a Ball Lightning — still has
to be *assigned* lethal damage before the trampler may send the rest through (CR 702.19b): four of
six, not six. A Fog never produces that case, because it covers the attacker too. Writing the branch
without a card to reach it would have been the same risk D57 named for the keywords.

**The player can see it, which this effect makes unusually hard.** It changes no power, no toughness
and no keyword, so a board under a Fog looks exactly like a board about to trade. `VisibleCard` now
carries a computed `damagePrevented`, the way it already carries the power the engine computed rather
than the one printed, and the badge says so.

**And the "card spent on nothing" family grew to two — with two mistakes worth keeping.**

1. The first rule asked the state *after* the cast whether a prevention effect had appeared. It let
   every pointless Fog through: **21 cast across 160 games, 11 with nothing attacking at all.** With
   auto-pass on, a spell nobody can respond to resolves inside the same action and the engine keeps
   passing for any seat with nothing to do — so a simulated line can end the turn, and an
   end-of-turn effect is gone by the time the question is asked. **D74 records this exact trap, in a
   comment two hundred lines away in the same file.** Declared on the card instead (`preventsDamage`,
   beside `makesMana`) and asked of the board before the cast.
2. The working rule's first measurement found the next one: a Fog is symmetric, so fogging your own
   alpha strike prevents your own damage and nobody else's. Nine Holy Days had stopped eight points
   of attacking power between them. The question is now "is there an attack **aimed at this seat**",
   and the same nine casts stop forty-one.

Measured over 160 unsteered games after both fixes: Maze of Ith used 76 times for 202 power stopped,
Fog Bank 23 cast and 24 blocks for 49, Fog 14 for 53, Holy Day 9 for 41 — and nothing cast into an
empty board.

**The general lesson, now that it has cost two increments:** a question about *what a spell did* may
not be askable from the state after it, because the state after it is wherever the engine's auto-pass
stopped. Ask the card, or ask the board before.

## D78 — Two versions are not enough to tell a stale tap from a bug

The table swallows a refusal for a move the game had already moved past — "tapping Pass a fraction
of a second before an opponent's spell starts resolving sends a pass the engine then refuses, and
the player did nothing wrong" — and shows the ones that happen at the version the play was offered
at, because *those* are a disagreement between what the table drew and what the engine accepts, and
`playout.test.ts` asserts deterministically that they cannot happen.

The test for "already moved past" compared two numbers the client had: `versionRef`, the newest
version it has **acked**, against `basedOn`, the version the play was **composed** against. Neither
is the version the server refused it at, and in a pod the two part company constantly: a broadcast
carries the rendered view ahead of the last ack, so `versionRef < basedOn`, and the guard reads
false for a play the table had plainly moved past.

The solo pod suite caught it as an error banner reading *"attackers must be declared before anyone
passes"* over a Pass the table was showing the player. One run in twelve.

**So the refusal says when it happened.** `PodError` carries the version the mutation read, stamped
once in `mutate` rather than at forty throw sites, and it travels on the ack as
`PodErrorEvent.stateVersion`. Ahead of the play means the table moved; equal means the table and the
engine genuinely disagree, and that still shows.

**And the banner names the move.** "auto:pass: attackers must be declared before anyone passes" is
the engine's vocabulary; "Pass: …" is what the player tapped. It is also what would have made this
failure readable from the screenshot the suite had already taken, instead of a guess — the same
lesson as D76, applied to an error message rather than to a layout.

A second, unrelated flake in the same suite got the same treatment rather than a fix: a rematch
press that times out now records Playwright's whole call log instead of its first line, because
"Timeout 2000ms exceeded" is one line short of a diagnosis and the useful half — *element is not
stable*, *intercepts pointer events*, *outside of the viewport* — is always underneath it.


## D79 — A life cost belongs in `manaSources`; everything costlier does not

`manaSources` is the one answer to "can this be paid for at all" — `legalActions` asks it what is
castable and `payFrom` asks it what to tap — and it admitted only abilities that needed nothing but
a tap. Two defensible readings of why:

- **The strict one.** A cost that is not a tap is a decision, and the engine should not make
  decisions on a player's behalf. Keep the list to free taps; let anything else be an explicit
  activation.
- **The one taken.** A *life* cost is the one non-mana cost a seat can always settle from
  information it already has — its own life total — so leaving it out does not protect the player,
  it hides a land from them. Mana Confluence was dead: it paid for nothing, it never appeared in
  the dimmed pips, and the engine refused casts the player could see the mana for.

The strict reading survives for everything else, and that is the point of drawing the line here
rather than at "any cost the engine can pay": sacrificing a creature is a decision with no right
answer, and discarding a card is worse. Life is admitted; nothing else is.

Three consequences, each of which had to be decided rather than inherited:

1. **Stopping one short of zero.** Paying life down to 0 is legal and loses the game (CR 118.4), so
   the engine offers the ability while `life > cost` and not while `life === cost`. 37 board-states
   across 120 measured games had an untapped Confluence its controller declined at one life.
2. **Painful sources go last in the list.** Every tie-break in `solveTap` keeps the first source it
   found, so ordering *is* the preference — a Plains before your life total, with no new rule in
   the solver. The solver carries the life through to the pick and charges nothing itself.
3. **A permanent with a free tap and a paid one keeps only the free ones.** No scripted card is
   shaped that way. If one ever is, charging life for a tap that did not need it is the mistake
   that cannot be taken back, so the conservative half is the half offered.

## D80 — Count it off the board, not off the move somebody made

The painlands measured as completely dead: `cityTaps: 0, cityDamage: 0` over 120 games. Both
numbers were the measurement's, not the cards'. It counted bot *actions* naming the land — and
`candidateActions` never offers a mana ability, so a land the engine taps while paying for a spell
is never an action anybody took. Counted off the board instead (untapped before an action, tapped
after it), the same 120 games show 107 City taps for 85 damage and 66 Confluence taps for 62 life.

Then the replacement got it wrong a second way: City's damage is a trigger, so the fixed version
watched the stack for it — and found **none in 120 games**. With auto-pass on, a trigger nobody can
respond to goes on the stack and resolves inside the same write, so it is never visible between two
actions. That is the third separate occasion this engine's auto-pass has broken a measurement
(D63's Dark Ritual pools, D77's Fog check, this), and the lesson is the same one each time: **the
state between actions is not the state during one.** Ask the board before, or ask the card. The
final attribution is a lower bound by construction — life the owner lost in the action that tapped
their land, bounded by the number of taps — and a lower bound that can be derived from the board is
worth more than an exact figure that depends on when a write happens to end.

## D81 — Priority null with nothing owed is not a state; restore the invariant, not the call site

`resetPriority` withholds priority while something is blocking the game — an opening hand, a
question, a discard, a combat declaration — and hands it back when the blocking thing is
**answered**. Answering is an action, so answering runs that code. Nothing runs it when the
blocking thing stops existing on its own.

Which is what an elimination does to a block that was owed. Hellrider's controller declares four
attackers at a player on three life; its trigger — one damage per attacking creature — kills them
while the attack is still on the table, by which point `advanceStep` has already taken the game to
declare-blockers and set `priority: null` because a block was owed. With the defender gone no block
is owed, and `pendingDeclaration` returns null, and `seatsToAct` falls through to `state.priority`,
which is null. Four attacks on the table, nobody to declare blockers, nobody holding priority, and
every caller — the table, the bot, the server's own seats — correctly concluding that it was not
their turn to do anything. **Two of the first eight four-seat pods played with a rotating deck list
died this way**, on turns 40 and 48.

Two candidate places to fix it:

- **At the call site.** Teach `auto:attack` to re-check priority after its triggers resolve. Cheap,
  and wrong in the way this engine has learned to recognise: the next card that eliminates somebody
  out of turn finds the same hole in a different action. The project already has the name for this
  — "detect, don't announce" — and this is the same lesson about a state rather than a log line.
- **At the invariant.** `resolveStateBasedActions` already repairs exactly this family: there is a
  block above this one headed *"Nor can an eliminated seat hold priority (CR 800.4)"*, written
  after a seat passed, died to the damage that pass let through, and kept holding priority. So the
  rule goes next to it: if the game is running and nothing is owed, somebody holds priority.
  Untap and cleanup are excluded, being the two steps where nobody holds it on purpose.

Taken with the rules fix that removes the cause: a player who leaves the game takes the attacks
aimed at them with them (CR 800.4a), so the combat is cleaned up in the same place. Either fix
alone would have unstuck these two games; both are correct independently, and the invariant is what
stops the next card finding the same hole.

**And the test had to be made to fail first.** The obvious unit test — four attackers, a dead
defender, assert the engine is still alive — passed before the fix as well as after it, because
with auto-pass on the engine ran the whole combat out inside the one action and never stopped at
the step that deadlocks. A test that cannot fail is not evidence (D76 again). Two tests now, both
checked against a stashed fix: a board of four cards that resolves the triggers one at a time and
stops where the real game stops, and the two pod seeds that reproduce the whole deadlock end to
end. The second needed the *searching* bot — `lookahead: false` plays a different game and never
reaches the position — which is worth knowing: a seed is not coverage when the bot's options or the
deck list are constants beside it.

## D82 — The runner flake was the suite's own shape, and a yield fixed it

`packages/rules-engine/vitest.config.ts` has carried this open question for a while:
`turbo run test --force` failed about one run in two with `[vitest-worker]: Timeout calling
"onTaskUpdate"` — every test passing, the process exiting 1 anyway. Four mitigations had been
measured and written up as not working: capping the worker pool, the `dot` reporter, lowering
turbo's concurrency, and `singleFork`. The remaining hypothesis was recorded rather than acted on,
because it was "a real change to thirty tests for a runner's benefit": a `playout` test is ten
seconds of *synchronous* game-playing in one body, and a worker that never yields cannot answer the
reporter inside its RPC timeout.

Enough tests accumulated that it stopped being one run in two and became **every** run, which is
what made it testable. One `await` that defers to the event loop, once per game, inside the single
heaviest test (eleven seconds, twenty whole games) cleared it — three green runs immediately after
three red ones. Extended to the five tests long enough to matter, `turbo run test --force` has since
run green four times in a row.

Three things worth keeping from it:

- **A flake that gets worse is an opportunity.** For as long as it failed half the time, no
  experiment could distinguish a fix from luck. The thing to do with an intermittent failure that
  is becoming reliable is to test the standing hypothesis immediately, not to work around it again.
- **The measurement that said "none of these worked" is what made the fix cheap.** The note in the
  config named the one remaining candidate and ruled out four others; acting on it took one line.
  A failure recorded as "flaky, ignore" would have cost the whole diagnosis a second time.
- **It was never a CI risk, and it is still worth fixing.** The config said so honestly — CI was
  green — and the cost was paid locally instead, by every verification run that had to be read as
  "512 passed, exit 1, probably fine". That is exactly the signal a suite cannot afford to teach.

## D83 — Divide by the seats the table started with, not the ones still alive

`evaluate` is "my side, less the average opponent", and the average was taken over the opponents
still alive. So eliminating a player changed the denominator, and eliminating the *weakest* player
raised the average of the ones left — which made killing them score **worse than doing nothing**.

Caught in a real position, captured from a four-seat pod on turn 49 and replayed:

| plan | result | score |
| --- | --- | --- |
| attack with nothing | nothing happens | **1877.3** |
| attack with all 462 | an opponent dies on the spot | 1875.0 |

The bot took the 1877.3. It had 462 ready goblins and three opponents on 3, 6 and 1 life, and it
attacked with nothing — every turn, for twenty turns, while Krenko doubled its board to nine
hundred creatures. The games did not end; they ran to turn 65 and then ran out of patience.

Three readings were available:

- **Sum instead of average.** Monotone in "fewer opponents is better", and it throws away the
  reason the average is there: a pod scored on the sum chases whoever is behind instead of
  answering the player about to kill it. The existing comment had already rejected it.
- **An explicit bonus per opponent already eliminated.** Keeps the average's scale and says the
  thing out loud, at the cost of a second knob with no measurement behind it.
- **A fixed denominator** — the seats the table started with. One word, keeps the intent exactly,
  and makes an elimination what it actually is: the average opponent is smaller because one of
  them is gone. In a two-player game the two readings are the same number, so every duel
  measurement in `bot.ts` still holds without being re-run.

Taken the third. Measured on sixty four-seat pods, the same seeds before and after:

| | finished | median turns | mean turns | sweep | slowest game |
| --- | --- | --- | --- | --- | --- |
| before | 58/60 | 65 | 65.2 | 327s | 25.3s (gave up) |
| after | **60/60** | **51** | **53.6** | **184s** | **9.9s** |

47 of the 60 finish sooner, 7 later. The two that had not finished at all now do.

**And this is what the "slow pod" was.** It was filed as a performance bug — one pod in sixty
taking over 140ms a decision against under 1ms everywhere else — and the profile said
declare-attackers, 2.8 seconds a call, 1859 creatures on the battlefield. None of that was the
search being expensive; it was the search *refusing to win*, so the board kept doubling until
thinking about it got slow. The lesson is the one D70 keeps teaching from the other end: a cost
that grows without bound is usually a decision that is never taken.

## D84 — The third card spent on nothing, and the bucket the first measurement got wrong

Two instant-speed protection tricks went into the pool — Blossoming Defense and Dive Down, +2/+2
or +0/+3 and hexproof until end of turn — and the first measurement said the bot threw them away:
**64 cast across 160 games, 60 of them with nothing on the stack.** The same shape as the ritual
(D63) and the Fog (D77): the evaluation sees a creature get bigger and a card leave the hand, and
both are true; what it cannot see is that the creature stops being bigger in a minute.

So the same answer, with the condition the card actually wants. `protectsACreature` on the script,
and a question asked of the board before the cast: is something on the stack aimed at one of my
creatures, or is there a combat one of my creatures is in. Two shapes because the card has two
uses — hexproof in response makes removal miss, and +2/+2 wins a fight — and the search can judge
the second for itself once the board says the fight exists.

**And the measurement was wrong in a way worth keeping.** It had two buckets, "in response" and
"at nothing", so every cast made during a combat landed in the waste bucket. That is why the
numbers after the rule looked like it had barely fired: 34 casts became 30, which reads as noise.
Re-counted with three buckets — in response, in combat, neither — the same games say:

| | cast | in response | in combat | at nothing |
| --- | --- | --- | --- | --- |
| Blossoming Defense, before | 34 | 1 | 0 | **33** |
| Blossoming Defense, after | 30 | 5 | 25 | **0** |
| Dive Down, before | 30 | 3 | 0 | **27** |
| Dive Down, after | 29 | 1 | 28 | **0** |

Two readings in those numbers. The obvious one: nothing is wasted any more. The one worth the
entry: **before the rule, `inCombat` was zero** — the bot spent every copy on its own main phase,
so the card was already in the graveyard by the time it could have mattered. The rule's real
effect is not that it stops a bad cast; it is that holding the card is what lets the search find
the good one, because only then do "cast it" and "pass" play out to different boards.

A measurement whose buckets do not mean what the rule means by them cannot say whether the rule
worked. That is the same lesson as D80, one level up: there, the thing counted was wrong; here,
the categories were.

## D85 — The instrument paid for itself: a modal over the end of the game

The solo browser suites had been failing roughly one run in a dozen for weeks on the same check —
*"and 'play again' deals another game at the same table"* — with nothing to go on but
`pressed: false`. An earlier increment responded to that not with a fix but with an instrument: a
last click whose failure keeps **Playwright's whole call log** rather than its first line, on the
reasoning that "Timeout 2000ms exceeded" is one line short of a diagnosis.

This run it fired, and the log said it outright:

```
<div data-testid="play-sheet" class="fixed inset-0 z-50 …"> intercepts pointer events
```

A play sheet — the "what can I do with this card" modal — left open over the end of the game,
covering the whole table including the button for another one. Nothing in it could be played; the
game was over.

**Two fixes, and the second is the one that mattered.** An effect that clears the sheet when the
game finishes handles a sheet the last damage landed under. It does *not* stop a sheet opening
afterwards, because by then `view.finished` has already changed and nothing re-runs. The guard on
the render is what closes that: no sheet over a finished game, however it got there. The first
attempt shipped only the effect, and the new check below caught it immediately.

**And the test for it had to be driven rather than waited for.** The first version opened a sheet
and conceded — and could not, because the sheet it had just opened was covering the concede button
too, which is the bug describing itself. The second version tapped a card in *hand* at game over
and quietly did not run at all, because the losing player's hand is often empty by then: 16/16
passed with the new check never executing. The third taps any card on the table, fails loudly when
there is none to tap, and reproduces the original failure every run — red before the render guard,
green after.

Three lessons, in the order they were learned the hard way:

- An intermittent failure deserves an instrument before it deserves a theory. This one cost two
  lines and bought the whole diagnosis.
- A check that can silently not run is worse than no check: it reports a pass it never made.
- The fix that stops the state being *entered* beats the one that cleans it up afterwards, and
  the way to tell them apart is a test that fails first.

## D86 — Do not spend now what you can spend better later

The fourth and last card in the "spent on nothing" family, and the one with the widest measurement
behind it. Five pumps in the pool — Giant Growth, Titanic Growth, Inspired Charge, Overrun and
Selesnya Charm's pump mode — cast **95 times across 160 unsteered games and not once during a
combat**. 59 of those were in the caster's own upkeep or draw step, before a land had been played,
on a board where nothing could possibly be attacking.

It is the search's horizon, not its judgement. A cast is scored with `simulate`, which stops when
the stack empties, so "+3/+3 until end of turn" is read as a creature that is bigger *now*; the
combat it was printed for is past where the simulation looks. `scoreDeclaration` does play through
combat, which is why the same bot attacks and blocks well — the gap is only on the cast, and no
weight closes it, because the creature really is bigger.

So the rule is not "a pump is bad". It is **"do not spend now what you can spend better later"**,
which makes the instant/sorcery line do real work for the first time in this project:

- an instant can wait for blockers, so it is held unless a combat is happening or something on the
  stack is pointing at one of this seat's creatures;
- a sorcery cannot wait past this main phase, so it is allowed in a precombat main with something
  that can attack — which is the Overrun line, and the only reason that card is playable at all.

**Measured on the same 160 games, before and after:**

| card | before: cast / in combat / wasted | after: cast / in combat / wasted |
| --- | --- | --- |
| Giant Growth | 17 / 0 / 16 | 15 / 12 / 0 |
| Titanic Growth | 25 / 0 / 24 | 21 / 15 / 0 |
| Inspired Charge | 23 / 0 / 23 | 2 / 2 / 0 |
| Overrun (sorcery) | 23 / 0 / 23 | 22, all precombat with an attack to make |
| Selesnya Charm (pump mode) | 7 / 0 / 7 | 0 |

**And it wins no more games, which is the honest half.** Against a fixed shallow-bot opponent over
240 paired games on two seed sets: 182-58 against 181-59, and 184-56 against 185-55. One game
either way, against a documented noise floor of eighteen. Kept anyway, for two reasons that are
not win rate: a card thrown away is a card a *human* opponent would have used, so the rule is worth
more against a person than against the reference bot; and an opponent that casts Giant Growth in
its own upkeep is the single most obvious way a table feels like it is being played by a program.

One bug on the way, worth the line: the first version of the sorcery clause asked
`legalActions(state, seat).attackers`, which is only filled in while a declaration is owed and so
is always empty in a main phase. Overrun went from 23 casts to **zero** — a rule that reads as
"never cast this card". `legalAttackers` is the function that answers the question anywhere.

## D87 — Three constants that should have been measurements

Opened the solo-pod suite's own phone screenshot, which is what D76 says to do, and found three
numbers written down where a measurement belonged.

**The feed's offset.** `bottom-[6.5rem]` — 104 pixels, chosen to clear a control bar that is one
row on a manual table and two with the engine running. On a phone the engine's bar is 111, and the
feed sat across the bottom of it: three lines of *"Opponent III mulliganed to 6"* over the top of
*"Keep this hand, or mulligan?"*. The check written to catch exactly that had been measuring the
two rectangles at desktop width, where the numbers happen to work. The component now asks the bar
where it is, the way the combat overlay asks the board — idempotent `setState`, because the same
component already taught this project what a measuring effect costs when it is not (D73).

**An empty zone's height.** Two rows — a label and a 34px strip — to say "no creatures". A fresh
four-seat pod carries sixteen of them before anybody has played a card. The label moves inside the
strip, the `data-testid` stays, and the table goes from **2.51 screens to 2.23** on a phone; a duel
from 1.37 to 1.18. The suite prints the number every run and fails over a budget, because a budget
nobody can see the balance of is one that gets spent without anybody noticing.

**"Declared attackers".** The driver taps every creature in the row — the ones the engine did not
light do nothing — and then confirms, so a declare step with everything summoning-sick reported the
same string as a real swing. The arena suite demands an attack arrow whenever that string comes
back, and an empty attack cannot draw one: a check that can only fail, taking three seconds to do
it. It had been read as the overlay's old race (D76) and waited out with more patience. The driver
now reads the count out of the prompt — the table says "3 attacking" — and the suites ask for an
arrow only when something actually attacked.

The common shape: each was a number that was right when it was written, in the one configuration it
was written against. The fix each time is the same one this project keeps arriving at — **ask the
thing rather than remember it** — and the tell is a check that passes for a reason other than the
claim being true.

One more, found by the same screenshot: a card tapped while the game was over left its sheet set,
hidden by the finished-game guard, and then the rematch dealt a new game and a Wind Drake from the
last one appeared over the new mulligan prompt. Clearing the pick when the card is no longer in the
view covers both — a rematch renumbers every instance, and so does a creature leaving for a zone
this seat cannot see.

## D88 — Two on one, and a rule the engine had but nobody could reach

`chooseBlocks` pairs each blocker with one attacker and marks that attacker taken, and says so in
its own comment: *"menace needs two blockers, which this bot does not coordinate, so it leaves them
alone."* The engine never had that problem — `auto:block` collects blockers per attacker, menace is
enforced, and combat damage assigns lethal to each in order before anything tramples past. Only the
bot could not ask the question.

Measured over 160 unsteered games before anything changed: **521 blocks, 471 of them with a single
blocker, 235 leaving the attacker alive — and in 53 of those a second creature was standing there,
legally able to block, where the two together would have killed it.** A tenth of every block the
bot made left a kill on the table.

The plan added is one more for `bestPlan` to weigh, not a new rule: pick the attacker worth ganging
— the most valuable one two or more creatures can block — add blockers cheapest-first until they
add up to lethal, then let the heuristic place whatever is left on the rest of the attack. So it is
"the usual block, plus a gang", and whether two creatures are worth one is answered where every
other combat question is, by playing it out.

**The same 160 games, paired:**

| | before | after |
| --- | --- | --- |
| blocks with one blocker | 471 | 393 |
| blocks with two or more | 50 | **134** |
| attacker survived the block | 235 | 171 |
| …where a second blocker would have killed it | **53** | **12** |
| blocker died with the attacker surviving | 116 | 93 |

Against the fixed shallow-bot reference over 240 games: **185-55 against 182-58** on one seed set
and **187-53 against 184-56** on the other. Three games each way, in the same direction in both —
inside the eighteen-game noise floor, so suggestive rather than proof, and the behaviour table is
what the change is actually justified by.

**And one rule the engine implements that nothing exercised on its own terms.** The only test that
reached more than one blocker was the menace one — the card that makes ganging *compulsory* — which
is D57's warning exactly. There is now an ordinary one: three creatures on a 5/6, the damage spent
down the line, the third blocker never reached.

Writing it surfaced a simplification worth naming rather than papering over. **CR 509.2 gives the
attacking player the damage assignment order; this engine uses the order the blocks were declared
in, which is the defending player's.** It matters only when the attacker would choose to kill a
different blocker, and nothing in this pool makes it matter enough to ask a second question in the
middle of combat. It is in the known-gaps list now instead of being quietly asserted as correct.

## D89 — The creature with no choice, and the table that must not offer one

"Attacks each combat if able" (CR 508.1d) is the first rule in this engine that takes a decision
*away* from a player, and that makes it the first one where the table's job is not to offer a move.
Every rule before it answered "may I?", and `legalActions` answered by listing what was allowed.
This one answers "must I?", and a list of what is allowed cannot say it.

The engine half is small: a `mustAttack` continuous effect, `forcedAttackers(state, seat)` reading
it off the board, and a refusal in `declareAttackers` when a declaration leaves one out. The refusal
is deliberately not silent correction — the engine does not quietly add the Juggernaut to the
attack. A declaration is a player's statement about their own combat, and an engine that edits it
is an engine the player cannot predict. So it is refused, with the card's own words as the reason.

Which puts the weight on the table, because **"the table never offers a move the engine refuses"**
is a project principle and a refusal nobody can act on is worse than no rule at all. The player
would press confirm, get an error naming a card, and have no way to find out what to do about it.
So the declaration now *starts* with the forced attackers in it, a second tap on one does nothing,
and the bar names the card and says why rather than counting it. Re-pointing it at another player
still works, which is the line the rule actually draws: whether it attacks is not the attacking
player's choice; who it attacks still is.

Two negative controls, because the two halves can each pass the other's test. With the seeding
removed, three of the four reducer tests fail; with only the no-drop guard removed, two fail — and
the no-drop test had to be rewritten to assert the mode *after* the tap, because asserting only the
confirmed declaration passed either way (an unguarded tap on an unseeded declaration simply adds
the creature, which looks identical at the end).

**Measured over 160 unsteered games** — Forge Alliance against each of the other five decks, the
Juggernaut counted off the board at each of its controller's declare-attackers steps rather than off
the action:

| | |
| --- | --- |
| Juggernauts cast | 38 |
| declare-attackers steps with one on the battlefield | 63 |
| …where it was in the declaration | 32 |
| …excused, with the engine's reason: summoning sickness | 31 |
| …excused with no reason (a bug) | **0** |

Thirty-one of sixty-three sounds like a rule that half-works and is the opposite: a creature cast
this turn is not *able* to attack, so the only excuse the engine ever gave was the correct one.

**The Wall restriction is rarer and was worth measuring rather than assuming.** "Can't be blocked
by Walls" is read off the attacker and matched against a creature *type*, not a keyword, so a Wall
of Air stopped by it is stopped for what it is. Asking `canBlock` about every untapped Wall a
defender held while a Juggernaut was attacking, across the same 160 games: **7 (Wall, Juggernaut)
pairs, all 7 refused for that reason, and not one Wall block declared on a Juggernaut anyway.**
Seven in a hundred and sixty is thin — it is unit-tested four ways for that reason — but it is
reached, which is more than D57's warning could say about several rules before it.

**And one thing deliberately not built.** Goad is the natural companion to this and is blocked:
`EffectDuration` is `'end-of-turn' | 'end-of-combat' | 'permanent'`, and goad lasts *until your next
turn* — a duration this engine has no way to express. End-of-turn would make a goad effect expire
before the combat it is meant to force, which is worse than not having it. It needs a fourth
duration keyed to a seat's turn, not a card, and that is a change to how effects expire rather than
a card to script.

## D90 — A duration that names a seat, and five lists that disagreed

Goad was written up as blocked in D89: `EffectDuration` was `end-of-turn | end-of-combat |
permanent`, and goad lasts *until your next turn*. The gap was real and the fix is one variant —
`until-controllers-next-turn`, expired in the untap step of the turn it names, which is the first
thing a turn does and therefore before anybody can read a board the effect was still changing.

**It is the first duration here anchored to a player rather than to a moment.** That is the whole
difficulty: an effect made on somebody else's turn has to survive the end of that turn, and the two
turns after it, and then end — so the expiry pass had to learn to ask *whose* turn has begun, which
is what the `seat` argument is for. Leaving it out can never expire one, which is exactly what the
end-of-turn and end-of-combat passes want.

**And `end-of-combat` turned out to be a variant nothing expired.** It was declared, no card used
it, and no pass dropped it — so the first card to say "until end of combat" would have had an
effect lasting the rest of the game. One line in the step the name points at.

**Goad itself is two rules on one creature, and the second one is new in kind.** "Attacks each
combat if able" is D89's requirement, checked against the declaration. "Attacks a player other than
you if able" (CR 701.38a) is checked against a *single attack's aim*, which nothing here had asked
before — every previous rule was about whether a creature may attack at all. So `attackAimIssue`
sits beside `canAttack` rather than inside it, and "if able" is the subtlety: the requirement lifts
when the goader is the last opponent, and it lifts when *every* remaining opponent has goaded the
creature, because then no choice satisfies anybody. Both fall out of one question — is a non-goader
left — rather than being two special cases.

**What that cost everywhere else, which is the honest part.** A restriction on the aim means three
other places had to learn it, or they would offer moves the engine refuses:

- the bot's declaration builder, renamed `legalDeclaration`, because three of the four plans it
  compares send everything at whoever has the least life, which is precisely what goad forbids;
- `legalActions`, which now carries `attackAims` — per creature, the defenders it may be sent at,
  listed only for the creatures that are actually restricted;
- the table, where a goaded creature is pre-selected at a seat it may attack, "all at them" moves
  everything except it, and the bar names the card and the player it may not be sent at.

That last one matters more than it looks. A goaded creature is also a forced one, so the table had
to combine D89's "cannot be dropped" with "cannot be aimed there", and a tap that silently moves an
arrow somewhere else reads as a bug unless the reason is on screen.

**Measured over 160 four-seat pods and 160 duels**, counted off the board rather than off the
action:

| | four-seat pods | duels |
| --- | --- | --- |
| Disrupt Decorums cast | 5 | **0** |
| creatures goaded | 9 | 0 |
| declare-steps with a goaded creature in the declaration | 8 | 0 |
| …aimed away from the goader | **8** | 0 |
| …aimed at the goader anyway | 0 | 0 |
| actions the engine refused | 0 | 0 |

The duel column is the fifth member of the "spent on nothing" family doing its job, and its negative
control is the clearest of the five: **with the rule removed the bot cast it 10 times in those same
160 duels, goaded 10 creatures, and 7 of them attacked the goader.** That is four mana spent to be
attacked, and no weight in `evaluate` can see it — `simulate` ends with this combat, and the attack
goad forces arrives on somebody else's turn, which is the same horizon that hid the pumps in D86.

Five casts in 160 pods is thin, and is said rather than dressed up: one copy, in one of four decks,
needing four mana and an opponent with a board. The rule is unit-tested five ways for that reason.

**Five hand-copied lists, found while wiring one flag through.** `PumpOptions` becomes a
`ContinuousEffect` in five places — a targeted pump, a team pump, a board pump, a permanent's
static, an aura — and each copied the subset of options it happened to know about. They disagreed:
`pump` dropped `mustAttack`; `staticEffect` dropped that *and* `preventsCombatDamage`, and an
Equipment's bonus goes through it; `pumpTeam` and `pumpAll` carried only a body and keywords; the
aura builder had four of ten; and the statics builder dropped `cantAttack` and `cantBlock`, so a
card whose printed static was "this creature can't attack" would have done nothing at all. No card
in the pool was wrong — the next one to use a flag would have been, silently, depending on which
builder its script reached for. One `modsFrom`, read by all five, and a test that every option in
is every flag out. It is the same move as `manaSources` answering both `legalActions` and payment.

**And the realtime flake, finally named and measured.** "Plays a whole game on its own against the
server" failed once weeks ago and never reproduced; it failed again here, and the message the
earlier instrumenting added said why: *stopped after 400 moves on turn 48*. Every pod seeds its
shuffle from an id carrying a timestamp, so each run is a different game, and the client that test
drives casts nothing — the game is the bot grinding a do-nothing opponent from twenty to zero.
Played out over 200 random shuffles with the same decks and the same loop: **median 137 moves, p90
216, p99 307, longest 488, and one game in two hundred over 400.** The cap was 400. Nothing was
flaky but the shuffle, and the constant is now 1200 — two and a half times the worst of two hundred
games, with the measurement in the comment beside it. D87's rule, applied to the constant that
broke it.

## D91 — Whose trigger goes on the stack first, and the choice that cannot matter yet

Two rules govern simultaneous triggers. CR 603.3b: the active player puts theirs on the stack
first, then each other player in turn order — so the active player's resolve *last*. And a player
with more than one of their own chooses the order among them.

The engine did neither. `raise` walked the seats by index, which gets APNAP right only when the
active player happens to hold the lowest seat number, and it never asked anybody anything.

**Measured over 60 four-seat pods**, counting every moment an action put more than one trigger on
the stack:

| | |
| --- | --- |
| batches of two or more simultaneous triggers | 131 |
| …belonging to more than one player, where APNAP is the rule | 33 |
| …that the engine actually ordered wrongly | **2** |
| batches where one player held two or more of their own | 111 |
| …where those were *different* abilities | 20 |
| …of those, where any carried a target | 7 |
| largest batch seen | 33 |

**APNAP is fixed, because it is an ordering rather than a question.** `apnapSeats` returns the live
seats starting from the active one, and the watchers are walked in that order with a dying or
entering permanent placed inside its own controller's group rather than ahead of everybody. Two
wrong orderings in sixty pods is not dramatic — but it is the kind of thing that decides one game
in thirty and leaves no trace, and it costs nothing to get right. Re-measured after: 0 of 33.

**The player's own choice is deliberately not built, and this is the evidence.** Twenty batches in
sixty pods had two *different* triggers from one player, which would be a prompt roughly once every
three games. Seven of the twenty included a trigger with a target, which is the only way two of
your own triggers can interact at all — one resolving first and removing what the other is aimed
at. In all seven the companion was "you gain 1 life" or "deals 1 damage to each opponent", neither
of which can remove a creature, so **no reordering available in those sixty pods could have changed
the outcome.** The seven shapes were read by hand and the instrument's count agrees with the
reading, which is as close to proof as a measurement gets.

So the simplification is named rather than asserted as correct, alongside CR 509.2's damage
assignment order: **two simultaneous triggers of your own resolve in battlefield order, and you are
not asked.** What the measurement also says is how to build it when a card makes it matter: prompt
only when one seat has two or more triggers with *different* descriptions, which never fires on the
33-trigger Hellrider batch that a naive version would put in front of a player.

## D92 — Stops are one player's preference, not the table's

`autoPass` was a single boolean on the game. The toggle's own tooltip said *"Skipping priority when
you have nothing to do"* — "you", singular — and it was not true: pressing it turned auto-pass off
for the **other** player as well, who was then asked twenty-five times a turn to confirm they still
had nothing to do, for a setting they never touched.

It is now `autoPassOff`, the list of seats that asked to be offered every priority, read through
one `autoPassFor(state, seat)` by its three callers: the auto-pass loop, the per-seat view, and the
table's toggle by way of that view. Nothing in the UI changed, because the view's `autoPass` now
means "mine" and the toggle was already written as though it did.

**Why a list rather than a map or a second boolean.** A list of who opted out has one reading and
one default: absent means on. A `Record<seat, boolean>` would have had three states per seat (on,
off, unset) for a setting with two, and keeping a table-wide boolean *beside* a per-seat one would
have been two sources of truth for the same question — which is the shape of bug this is. It also
survives a state stored before the field existed: `?? []` reads as "everybody auto-passes", which
is exactly the default that state had.

**What the shape makes expressible, and the test that could not be written before.** With it off for
seat 1 and on for seat 0, seat 0 playing a land now stops play on seat 1 in the same step — and
seat 1 passing walks the rest of the turn without asking seat 0 anything. Neither half of that was
sayable with one boolean: the old test asserted *"with it off, the other seat is offered priority
even with nothing to do"*, which was the bug written down as the specification.

Each seat's setting also survives a rematch, which is the other place a boolean would have handed
one player's preference to the other: the rematch carries the list and re-applies it seat by seat
after `auto:start`.

**And the check that proves it where the player actually is.** The arena suite presses the toggle
in Nick's browser and reads the `aria-pressed` on Friend's, which was the claim nobody was making:
with the view computed table-wide instead, Friend's switch flips to `false` too, and the suite says
so. (`nick=false friend=false (was true)`.) It is pressed back on afterwards so the rest of that
game plays as it always did.

One thing deliberately left as it was: the bots. A bot seat is never in the list, so the engine
always passes for it — a bot asking to be offered every priority would be a table that stops for
nobody's benefit.

## D93 — The attacker chooses which blocker dies

CR 509.2 gives the *attacking* player the order in which a blocked creature's combat damage is
assigned. This engine spent the attacker's power down each attack's `blockers` list, which is the
order the blocks were *declared* in — the defending player's. D88 named it as a simplification and
said nothing in the pool made it matter enough to ask a second question in the middle of combat.
That was a guess, and this is the measurement.

**Over 160 four-seat pods, before anything changed:**

| | |
| --- | --- |
| attacks blocked by two or more creatures | 276 |
| …where reordering changes how many of them die | 54 |
| …where the declared order killed fewer than the attacker's best order | **32** |
| kills that cost, in total | 35 |

A lost kill every five games, from a decision the attacking player was never offered. And the count
understates it, because the *identity* of what dies changes far more often than the count does: a
5/5 blocked by a 2/2 and a 4/4 kills one of them either way, and which one is the whole decision.

**So it is asked, and asked as a third turn-based action.** Combat already had two things that are
not priority decisions — declaring attackers and declaring blockers — and `pendingDeclaration` is
where they live, which is why nobody holds priority while one is outstanding. The order is the
third, so it went in beside them: `kind: 'order'`, owed by the active player, after every defender
has declared. One action settles every attack that needed one, because asking a player four
questions in a row for a four-creature swing is four chances to lose track of which creature the
prompt is about.

**Only when it can change something.** `damageOrderChoice` returns null unless there are two or
more blockers and the power kills *some* of them but not all: with enough for everybody the whole
block dies whatever the order (CR 510.1c), and with less than the cheapest nothing does. That is
the same line D91 drew for trigger order, and here it brings the question down to **144 askings in
160 pods — about one a game**, from 276 multi-blocks. Deathtouch is included rather than excluded:
it makes every blocker cost one, so the number that die is fixed, but with a 1/1 deathtoucher
blocked by a 2/2 and a 7/7 which one dies is the entire question.

Nothing changed in the damage step itself. `dealCombatDamage` already spent power down the
`blockers` list in order, so the rule needed somebody to *ask* rather than new code to apply it —
the answer rewrites the list.

**The bot gets the choice too, and the search was already the right shape for it.** Three candidate
orders per attack — as declared, cheapest first (most kills), most valuable first (best kill) — and
`bestPlan` plays each through the combat exactly as it does for attacks and blocks. Measured over
160 pods with the rule live: **asked 144 times, kept the declared order 83 times and reordered 61;
of those, 8 killed more blockers and 43 killed the same number but more valuable ones.** Zero
refusals, which is the invariant that matters: the search generates orders the engine accepts.

**One gap, named rather than papered over.** No browser suite reached the prompt. The engine only
asks when a creature is blocked by two or more, and the suites' driver builds small boards: it was
taught to put two blockers on one attacker when it has two, and in five full runs it never had two
creatures that could both block. So the interaction is covered by five reducer tests and the rule
by four engine tests, and the driver handles the prompt if a game ever produces one — but "a person
tapped two blockers in order in a real browser" is not yet something this suite has seen.

## D94 — The audit that found nothing, which is the result

A card in a deck that never gets played is one of three different problems wearing the same face:
the deck does not want it, the bot cannot use it, or the engine will not let it be cast. Nothing in
the suites would notice any of them — `scripts.test.ts` proves every card *can* be cast, one test
per card, which is a different claim from "it ever is".

So: every deck against every other deck, both seat orders, **252 games with each of the seven decks
playing 72 of them**, with every cast, land and activation attributed to its card and every card
ever seen in a hand recorded separately — because "never drawn" and "drawn and never cast" are the
two halves that have to be told apart.

**Every card in all seven decks is cast or activated in real games, with two exceptions, and both
are rules working rather than cards failing:**

| | |
| --- | --- |
| Disrupt Decorum (forge-alliance) | drawn 23 times, cast 0 |
| Inspired Charge (forge-alliance) | cast twice in 72 games, drawn 18 |

Disrupt Decorum is goad, and this measurement is all duels: `goadsOpponents` (D90) stops the bot
casting it when there is nobody for a goaded creature to attack but the goader. In four-seat pods
the same card is cast 5 times in 160 games. Inspired Charge is the pump rule (D86) holding a card
that is only right in a precombat main with a wide board — measured at 2 casts in 160 games when
the rule went in, and 2 in 72 here.

**One thing the audit did surface, recorded rather than fixed.** Forge Alliance now carries a card
the bot will never cast in a duel, and a person should not either: in a two-player game goad does
the opposite of what it is for. That is one dead slot in sixty when the deck is played as a duel
deck and a live one when it is played in a pod, and there is no pod-only deck to put it in — every
deck here is used for both. The alternative was keeping goad out of the pool altogether, which
costs more than the slot does.

The audit is written down because a result of "nothing is dead" is only worth anything with the
number behind it, and because the next card added to a deck can be checked the same way.

## D95 — A replacement effect one permanent contributes for another

The engine had two replacement effects and no replacement *pass*. Regeneration (CR 701.15) and
"enters the battlefield tapped" (CR 614.1c) are both shields sitting on the card they affect, which
is where they are printed and why they got away with it. "If a nontoken creature an opponent
controls would die, exile it instead" cannot: the effect belongs to one permanent and changes what
happens to a different one, so something has to ask every permanent on the table whether it wants
to replace what is about to happen.

**Where to ask was the whole decision, and the engine had already answered it once.** `relocate` is
the one place a card changes zone, and it *records* a death rather than announcing it — so `settle`
holds the single list of what just died, and `settle` is already where "enters tapped" is applied,
under a comment saying it is as close to a replacement as a state computed in one action can be. The
death replacement went in beside it. The alternative was a hook inside `relocate`, which means
`cardActions` reaching scripts and a dependency cycle, or patching fifteen call sites — the second
of which is the exact mistake `died` was introduced to stop.

**The cost, named rather than glossed.** The dying permanent touches its graveyard for the length of
one function call. A true replacement means it was never there, and the only thing that could tell
the difference is something reading a graveyard between the move and the pass. Nothing does: the
death event is raised after, so a replaced death correctly is not a death and triggers nothing;
state-based actions do not read graveyards; no card in the pool asks. A card that counted creature
cards in graveyards while resolving would be the one to break it, and the reason to move this
upstream.

**`replaces` carries a predicate rather than a scope enum**, which is `TargetSpec.filter`'s reason
exactly: every printed version words it differently — an opponent's, a nontoken one, a creature
rather than a permanent — and an enum would either fall short of the next card or carry values no
card uses, which is what D57 warns about. Several applicable replacements are not offered as a
choice (CR 616.1 says the affected player picks); the first in APNAP order wins, and nothing in this
pool can produce two.

**Kalitas, Traitor of Ghet is the card**, chosen because it is the plainest possible test of the
pass: it has to catch every way a creature can die, and the three ways reach the graveyard by three
different routes — lethal damage as a state-based action, a Doom Blade as an effect, and a sacrifice
paid as a cost before the ability is even on the stack. All three are tested, and the sharpest test
is the Blood Artist: **a replaced death is not a death, so a drain that watches for any creature
dying must not fire.** If it fires, the engine has built a trigger and called it a replacement.

**And the engine says what it did.** A replaced death raises no event, so there is nothing to log and
nothing for the feed to pick up: the card would work invisibly, and a creature would die to a Doom
Blade and turn up in exile with a Zombie beside it for no reason a player could see. Replacement
notes are recorded the way deaths are and drained in `reduceAutoAction` onto the message of the
action that provoked them — which is the one place every automated action passes on its way to a log
entry.

**Measured over 60 four-seat pods:**

| | |
| --- | --- |
| Kalitas cast | 19 |
| creature deaths | 1155 |
| creatures exiled while an opposing Kalitas was out | **48** |
| creatures exiled by the pool's other exile effects | 76 |
| actions the engine refused | 0 |

About two and a half firings a game it is in. The 48 is attributed by asking whether a Kalitas was on
an opposing battlefield at the moment, so a Swords to Plowshares cast in the same breath would be
counted with it — the 76 is the baseline that makes the attribution worth anything.

All six tests go red with the pass removed.

## D96 — What two hundred pods say, and the slowest decision in ninety thousand

Five rules went into combat and the stack in quick succession — forced attacks, goad, APNAP trigger
order, the damage assignment order, and a death replacement — each with its own tests and its own
measurement. What none of them answers is whether the engine, with all five in it, still plays
hundreds of games to the end without getting stuck. So: **200 unsteered four-seat pods, all seven
decks, every action applied and every refusal, stall and timeout counted.**

| | |
| --- | --- |
| games played | 200 |
| games that reached a winner | **200** |
| actions the engine refused | 0 |
| actions that changed nothing (a stall) | 0 |
| games over the 400-turn cap | 0 |
| moments with nobody to act, or no move for the seat that had to | 0 |
| median / p90 / longest game, in turns | 52 / 77 / 122 |
| bot decisions | 89,188 |
| mean time per decision | 7.6ms |
| slowest single decision | **2011ms** |

The last number is the one worth looking at, because it is the shape of the bug D71 was about: one
pod in sixty taking minutes per decision. Measured properly over a second soak of 60 pods and 27,261
decisions: **p50 2.0ms, p99 65ms, p99.9 173ms, 96 decisions over 100ms, six over 250ms and none at
all over 500ms.** So the two-second outlier is roughly one decision in ninety thousand, on turn 39
of a game that had already run long, and the ordinary experience of playing against this bot is a
reply in two milliseconds.

Recorded rather than acted on. A tail that thin is not a performance problem, and chasing it would
mean changing the search for a case a player meets once in a hundred games — the opposite of the
trade D71 made, where the fix was worth it because the slow case was *common*. If the tail thickens,
this is the number it thickened from.

**And one thing the soak settles that no unit test can**: every one of those 200 games ended. Not
"did not crash" — reached a winner, with the eliminations, the state-based actions and the five new
rules all agreeing on when the game was over.

## D97 — The prompt a browser only sees one run in four

D93 built the damage assignment order and named a gap: no browser suite reached the prompt, because
the engine only asks when a creature is blocked by two or more and the suites' boards are small. The
gap is now half closed, and the half that is closed is the interesting half.

The arena suite was instrumented rather than guessed about: across a full run it declared blocks
**once**, with two cards in the defending player's battlefield row and one of them placeable. So the
two-browser duel cannot reach it — not because the driver is wrong but because the game never builds
the board.

The solo-pod suite can. The player attacks into three bots that gang up (D88), so the player is the
one asked for the order — and in one of three runs it happened, the driver tapped the blockers in
order, and the engine took the declaration. **It is sampled, not required**: the suite records it and
reports it when it happens, with a line saying why it did not when it does not. That is how the scry
and the library search are already handled, and the reason is the same — a check that fails for a
board the game never built says nothing about the code.

Which leaves the honest statement: the damage order works end to end through a real browser, and it
has been seen to, about one solo-pod run in four.

## D98 — Protection, and a required argument instead of a silent hole

Protection from a colour (CR 702.16) is four rules under one keyword: a creature with protection
from black cannot be **d**amaged, **e**nchanted or equipped, **b**locked, or **t**argeted by
anything black. A keyword that did three of them would be worse than none, because a player would
trust it — so all four are in, each in the place that already answers that question: target
legality, `canBlock`, `equipTo`, and `dealDamage`.

**The damage one is why this took a refactor.** Protection is a fact about the *source*, and
`dealDamage` had no idea what was dealing the damage — twenty-one call sites, not one of them
saying. The options now carry `source: string | null`, and it is **required**.

Required is the whole point. An optional `source` would have been a silent hole: the eighteenth call
site to forget it would let protection quietly fail for whatever that spell was, with nothing
anywhere to say so — which is the shape of bug `died` (D-era: deaths announced by hand at two call
sites and silently wrong at every other) and `modsFrom` (D95's five disagreeing lists) were both
introduced to end. Making it required turned the question into twenty-one compile errors, each
answered where the caller already had the answer: the attacking creature, the blocking creature, the
spell's own `c.source`, and — in the one card that makes two creatures fight — each of them as the
other's source.

`protectedFrom(state, target, source)` is one function for all four rules, so the four cannot
disagree about what "red" means. Paladin en-Vec is the card: protection from black and from red,
which in this pool is most of the removal. Three of the four tests fail with that function
short-circuited. The fourth, equipping, is correct and unreachable — every Equipment in the pool is
colourless, so the test asserts the fact the clause rests on and the gap is named rather than
hidden, which is what D57 asks for.

One test had to be sharpened before it meant anything. "Takes no combat damage from a red creature"
originally read the damage marked on the Paladin, and passed with the rule removed: a creature that
*died* has nothing useful to say about what hit it. Asserting it is still on the battlefield is the
claim — a 2/2 in front of a 3/3 survives only if the damage never happened.

## D99 — Static abilities were installed in one of the four ways onto the battlefield

The Paladin's protection did not work on a test board. Neither had a Fog Bank's damage prevention,
nor a Juggernaut's "attacks each combat if able" — and both of those were worked around at the time
by installing the effect by hand in the test, twice, as though it were a quirk of the test helper.
The third time it was read properly.

**Statics were applied where a permanent *spell* resolved.** That is one way onto the battlefield.
The others:

- **reanimation** — `putOntoBattlefield` from a graveyard. A reanimated Fog Bank prevented no
  damage; a reanimated Juggernaut did not have to attack.
- **a token** — nothing in the pool has a static, so this one was latent.
- **a card moved there by hand** — which is the entire tabletop half of this application, the host
  fixing a misclick, and how every test in the engine builds a board.

Fixed the way everything of this shape is fixed here: arrivals are **detected** rather than
announced (`AutomationState.entered`), so the arrivals pass in `settle` is the one place that sees
every way a permanent reaches the battlefield, and that is where its statics are installed now. The
call at spell resolution is gone, so there is one place rather than two that could disagree.

And `auto:start` does the same for whatever is already in play, because taking over a table mid-game
is a real feature: a board of permanents the engine never saw arrive is exactly what the handover
from the tabletop half produces, and before this it was a board of permanents with no printed
abilities.

Guarded on the permanent having no effect of its own already, which is what keeps a resolving aura —
which installs its own effect with its own id as the source — from being handed a second one.

## D100 — Two suite checks that asserted more than their names

Both turned up as single failures in an arena run that was otherwise fine, and both were the check
being wrong rather than the code.

**"The step is named rather than left to be guessed at"** insisted the label matched upkeep, draw or
a main phase, on the reasoning that the engine begins the first turn at its upkeep. True of the
first moment of a game and not of the moment this looks: the loop before it opens and closes a play
sheet for every card in hand, and a hand with nothing playable in it is one auto-pass walks straight
past — so the game can legitimately be in a combat step by then. It is asserted against the engine's
own step labels now, which is what the name claims.

**"A card it will not let you play says why"** reads the reason off the first unplayable card in
hand on turn one. Usually there is one; a hand of lands has none, and then there is no reason to
show and nothing wrong. Conditional now, with a line saying so when the hand had nothing blocked in
it — the same treatment the scry and the library search already get, and for the same reason: a
check that fails for a game that was fine says nothing about the code and trains you to ignore it.

## D101 — The block it was never shown

The question was narrow: does the opponent ever lose a game it had a block available to survive?
Answering it took three instruments, and two of them were wrong before the engine was.

**The first instrument found eleven mistakes, and every one of them was false.** It reconstructed
each lethal attack arithmetically — power faced against life, minus what the chosen blocks would
absorb — and listed every position where some other assignment of blockers came out ahead. The
position it flagged most often had a Blood Artist in the attack, so each blocker that died drained
the blocking player: the "better" block killed its own controller. Arithmetic cannot see a trigger.
The instrument was rewritten to *play each candidate block out* through the engine and ask only
whether the seat was still alive at the end, which is the one question that has no counterexample.
It found one real mistake in 120 duels: a seat on four life blocking a 1/1 and a 4/4 while a 3/3
went past, where blocking the 3/3 and the 4/4 lived. The 1/1 was an Elvish Visionary, which
`creatureValue` prices above a Centaur Courser because it draws a card — by value it was the right
block, and by power it was the losing one.

**The bug was a length test, not a weight.** `blockPlans` already built a one-blocker-per-attacker
spread as an alternative to the heuristic's block, and already offered it to the search. It offered
it only when the alternative had *more* blocks in it than the heuristic's plan. Here the heuristic
had already blocked two attackers, and the plan that blocked the two *right* ones was the same
size — so it was never put in front of the search at all. Two plans of equal size can be entirely
different blocks, and choosing between them is the whole reason there is a search. The fix is a
second spread ordered by power rather than value, offered when it is *different* rather than when it
is longer.

**Offered only when the seat is about to die, because the full version cost too much.** Two extra
plans in every block is two more combats played out per block, and a block happens in most turns of
most games: over 60 pods it took decisions over half a second from 1 to 19 and the slowest decision
from 604ms to two and a half seconds, which is D71's bug beginning to come back — for a mistake
that costs one game in 120. Confined to the attack that is actually lethal it costs 28.12ms →
28.54ms on the mean block decision, and the real mistake goes from one to none.

**And a measurement lesson, which is why the figure above is a mean and not a tail.** The first
attempt to price the change compared the slow tail of a 60-pod soak before and after, and read
`over500` going 0 → 19 as the cost. The direction was real — baselines at two adjacent commits with
no behaviour change at all gave 0 and 1, so 19 is outside the noise — but the magnitude is not
readable: the games diverge the moment behaviour changes, so a slow position in one run may simply
not exist in the other, and a single pod's worst decision is one sample. A tail says *whether*; it
cannot say *how much*. The **mean per decision kind** can, because every run has thousands of each
kind, and that is what the 28.12 → 28.54 figure is. The corollary bit twice in one task: the same
reasoning retired two cost claims in `characteristics.ts` comments that had been written off the
same tail.

The win rate against the fixed shallow reference moved 148-92 → 150-90 on one seed set and 149-91 →
150-90 on the other. Both are inside the 18-game noise floor on 240, so the win rate is not the
case for this change and is not claimed as one: the case is that a death the bot could have avoided
no longer happens, at a cost of four tenths of a millisecond on a block.

## D102 — Prevention with a quantity, and a card that is weak on purpose

The last named gap in replacement and prevention: a shield with an amount. A Fog is all-or-nothing
and lasts a turn; "prevent the next 3 damage" is a number that is *spent* by whatever damage shows
up. `preventsCombatDamage` had refused to be stretched into it, and the three reasons it gave turned
out to be exactly the three differences:

- **it is rewritten rather than only read** — each damage event takes what it needs, the remainder
  stays, and the effect is removed when it reaches zero rather than when the turn ends;
- **it covers every source of damage**, not only combat, because that is what the cards say;
- **its target can be a player**, which is why `ContinuousEffect['scope']` now has a seat in it —
  the first scope here that names one, and the only one `characteristicsOf` can never match.

All of it lands in `dealDamage`, which is the one place damage is ever marked, and *before* anything
is marked. That ordering is the rule rather than a tidiness preference: damage that was prevented
was never dealt, so it must not reduce life, must not mark a creature, must not count towards a
commander's twenty-one, must not mark deathtouch, and must gain no life for a lifelink source. A
shield consulted after the fact could not do a single one of those. Four of the five new tests fail
with the spend removed; the fifth is the expiry test, which is about the duration rather than the
spend and legitimately passes either way.

**Two bot rules, both measured, both with the control run red.**

*When.* Samite Healer's ability taps it, so it is the first card in the pool whose cost is a
blocker. The search cannot see that cost — it scores the position one move out, where a tapped 1/1
and an untapped one are worth the same and the block has not happened yet — so the Fog rule
("damage is still coming") has a second condition for an ability: wait until blockers are declared.
With it, 113 activations in 240 duels, every one of them in the declare-blockers step. Without it,
45 in 60 duels, **every one in declare-attackers**, each spending a blocker before it blocked.

*Where.* The bot's default aim is "the enemy, and the enemy's creatures", which is right for the
removal and burn that are most of what targets anything and perfectly backwards for a shield: aimed
at an opponent it prevents the damage *you* were about to deal. `TargetSpec.friendly` is advice to
the bot in the same family as `preventsDamage` and `makesMana` — not a restriction, because a human
may legally shield an opponent's creature and at a four-player table may want to. With it, 113 of
113 shields aimed at the bot's own seat. Without it, **26 of 27 aimed at the opponent**.

**And the card is weak, which the measurement said plainly and three times.** Skyward Writ beats the
rest of the pool 164-76 and 153-87 over 240 paired duels on two seed sets. Adding the pair cost it
about five per cent whichever way the slot was paid for:

| the swap | seed set A | seed set B |
| --- | --- | --- |
| baseline | 164-76 | 153-87 |
| two Healers + a Salve, for three bodies | 141-99 | 145-95 |
| one of each, for two bodies | 146-94 | 146-94 |
| one of each, for two spells | 153-87 | 139-101 |

Which three cards come out moves the result less than the two seed sets move each other, so there is
no free version of this slot: a three-mana 1/1 is a weak card whatever its text. Two things keep it
in anyway. The pool otherwise contains **no card at all** that uses prevention-with-a-quantity, and
a rule nothing can reach is a rule nobody can trust. And the measurement is of the *bot*: it takes
exactly one point a turn with the Healer and — 72 casts out of 72 — always takes Healing Salve's
three life rather than its shield, because three life is three life to `evaluate` while a shield is
worth nothing it can see. A player who shields the blocker that is about to die gets a card the
measurement cannot score. The honest summary is that this is the floor of what the pair does, not
its value, and the five per cent is written down rather than rounded away.

*(The reason given above for the Salve — that a shield is worth nothing to `evaluate` — turned out
to be wrong. D108 measured it: the two halves are worth the same, which is why the life wins.)*

**What is still open, and named rather than hidden.** The bot never chooses the shield mode of a
modal card, for the reason above. It will not hold a shield for a burn spell on the stack, because
the gate asks about combat and the engine has no "this spell deals damage" flag to ask instead. And
shielding a blocker against shielding yourself is a choice the search makes only
if both aims are in the list `aimings` hands it, and D103 is about the fact that they were not.

*(This entry first claimed the search never compares aims at all. That was wrong — `aimings` has
offered up to three per play since the search was written. What was missing was an own-side aim
among them, which is a smaller bug with a sharper edge.)*

## D103 — The aim the search was never shown

`chooseTargets` has a comment that has been true since it was written: the bot has no idea what a
card does, so a pump spell gets aimed at an enemy creature — "legal, and wasteful". Fixing it looked
like it needed the bot to read a script's intent. It did not. It needed the search to be handed the
other aim.

**What the measurement actually found.** Counting every targeted cast over 60 duels, split by
whether the card helps what it points at: 31 aimed at the bot's own side and **three** at an
opponent's — Giant Growth twice and Titanic Growth once. Far smaller than the comment implies,
because most of the helping cards in this pool restrict their targets with a filter (Dive Down and
the regeneration tricks say "creature you control", and the engine then offers nothing else). The
wart only survives on a card that can legally point anywhere.

**And it survives for a reason worth having found.** `aimings` already offers the search up to
three ways of aiming a spell — the heuristic's own pick plus the top of the enemy-first ranking. On
a board with three enemy creatures, *the top of that ranking is three enemy creatures*: the bot's
own side is not in the list at all, so the search could not reject an aim it was never handed. It
would have rejected it instantly — pumping their creature raises their side of the evaluation and
lowers its own, which is the one judgement this evaluation makes well.

So the alternatives are now the best two by the enemy ordering **and the best one by the own-side
ordering** (`friendlyRank`, which the shield work in D102 had already written), with `AIM_WIDTH`
raised from three to four so none of them is squeezed out. Helping spells aimed at an opponent went
3 → 0 over the same 60 duels, and own-side aims 31 → 34. The test that proves it builds the board
the bug needs — a 2/2 blocking a 3/3 with three enemy creatures out — and fails with the own-side
ordering removed.

**Nothing measurable was paid for it.** The paired reference win rate moved 150-90 → 149-91 and
150-90 → 147-93 over 240 games on two seed sets, which is inside the 18-game noise floor. A 200-pod
soak finished 200 of 200 with nothing refused and nothing stalled, and the mean per decision went
*down* rather than up (a cast 8.54ms → 8.01ms, the whole soak 6.87ms → 6.45ms per decision) —
run-to-run variation on a shared machine rather than a speedup, which is the honest reading of a
fourth option costing nothing.

**And a wart it did not cause, found while looking.** The same count says the bot points removal at
its *own* creatures a handful of times per 60 duels — four Swords to Plowshares, three Murders, a
Doom Blade — and the figures are the same before and after this change, so it is older than the
fourth aiming. Some of them are defensible (a Swords on your own creature gains you its power in
life, which the evaluation can see) and some are probably not. It is written down rather than
guessed at: counting is cheap, and the next person to look should start from the number.

## D104 — A win condition the rules already enforced

The engine has ended games over an empty library since state-based actions were written: a player
who cannot draw has lost (CR 704.5b), `mill` has existed for as long, and Jace Beleren's ultimate
milled twenty. Nothing had ever tried to win that way, and building the deck that does found three
things wrong — one in the rules, one in the engine's own vocabulary, and one in the bot.

**The loss said the wrong thing.** A seat that decked out was eliminated with
`eliminatedReason: 'life'`, so the table printed "out (life)" beside a life total of nineteen.
`EliminatedReason` simply had no case for it, because nothing had ever produced one. It is
`'library'` now, and the web table says "out (empty library)" rather than echoing a field name —
which also fixed "out (commanderDamage)", which has been wrong on screen since commander damage
went in.

**The most-printed trigger in Magic was missing.** "Whenever this deals combat damage to a player"
is on hundreds of cards and on none of ours, because the engine had no event for it. It is recorded
rather than compared, which is the one departure from the house pattern and a forced one: a death,
an arrival and a tap can all be found by looking at the board, and a life total going down does not
say which creature took it there. So `dealCombatDamage` records `{ creature, defender }` and
`settle` announces it beside the deaths and arrivals, and it records only when the life total
actually moved — a Magpie whose damage is stopped by a Fog, a prevention shield or protection draws
nothing, which is what "deals damage" means. The seat travels with the record because the ability
needs it ("*that player* mills"), and it reaches the ability through the same `attacked` channel an
attack trigger already uses rather than growing a second way to say the same thing.

**And the bot could not see the win.** `evaluate` counted life, hand, board and loyalty. A library
was worth nothing, so milling seven was a card spent for no change in the score and the search —
correctly, by its own lights — declined to do it: over 56 duels the deck won 37 and **not one of
them by milling**. It won by beating down with Magpies, which is not the deck.

The fix is one weight: `LIBRARY_CARD = 0.3`, linear, counted for every seat the way life is. The
number is chosen so the pool lands where it should — a Tome Scour (five cards) is worth about a card
out of hand, a sixty-card library is eighteen points against a twenty-point life total, so "there
are two clocks and they run at about the same speed". Linear rather than "only the last ten cards
matter", which was the first shape and the wrong one: under it a mill spell cast at a forty-card
library scores zero, and a deck that cannot start its plan never finishes it.

With it, the same 56 duels: 38 wins, **24 of them by decking the opponent out**. And it costs the
other seven decks nothing measurable — the paired reference win rate moved 149-91 → 153-87 and
147-93 → 147-93, inside the noise floor, which is what a weight that is *true* looks like rather
than one that is tuned.

**What the deck is.** Nine new cards: Mirko Vosk as the commander (a 2/4 flier that mills until the
fourth land turns up — a loop rather than a number, because the printed card is a loop and the
variance is the card), Thieving Magpie, Mind Sculpt, Thought Scour, Compelling Argument (mill with
cycling, so a hand of mill against a board that is killing you has an out), Returned Centaur,
Nemesis of Reason (ten a swing, blocked or not), Psychic Strike (a Counterspell that mills the
*spell's controller*, read off the stack rather than assumed to be the only opponent) and Jace,
Memory Adept. Around them the deck is almost entirely cards the pool already had: blockers that
never attack, four counterspells, four removal spells. The dead-card audit over every pairing says
every card in it gets cast — no dead slots, no rare ones.

## D105 — The layers, and the two cards that needed them

`characteristicsOf` made one pass: printed values, then every continuous effect summed, then
counters. That is right for every card the pool had, and its own comment said why it would not stay
right — "an effect that *sets* power would not be". Two cards now set one.

**Layer 7b against 7c is the whole of it.** A +3/+3 and a -1/-1 can be summed in any order and come
to the same answer. "Becomes 1/1" cannot be summed with anything: it replaces the base that the
modifications then apply to, and it does so *by layer rather than by timestamp* (CR 613.4c). So a
Giant Growth cast before a Turn to Frog leaves a 4/4, not a 1/1 — which looks like a bug until the
layers are written down, and is the assertion the second test makes. The loop collects setting and
modifying separately now and applies 7b → 7c → 7d, with two settings resolving last-one-wins
because `state.effects` is in timestamp order.

**Layer 6 is the one place the order of the list is the rule.** "Loses all abilities" takes away
what the creature has when it resolves — printed keywords included, which is what makes a Turn to
Frog answer a flier — and leaves anything granted *afterwards* alone (CR 613.1f). That falls out of
clearing in the loop rather than setting a flag read at the end, and the control that applies it at
the end instead fails exactly the test about grants after it.

**Layer 1 needs no layer at all.** A copy copies a card's *printed* characteristics (CR 707.2), so
the engine makes one by pointing the new permanent at the copied card's own definition — and
everything follows for free: the token's abilities come from `scriptFor(name)`, and its statics are
installed by the same arrivals pass as any other permanent's, so a token copy of a Fog Bank prevents
damage. Nothing of what is *not* printed comes along: no counters, no damage, no auras, no effects
on the original. The test copies a Fog Bank carrying two +1/+1 counters and a +3/+3 and asserts a
0/2 with a prevention effect of its own.

The cards are **Turn to Frog** ({1}{U}: target creature becomes 1/1 and loses all abilities — two
mana of instant-speed removal that leaves the body behind) and **Cackling Counterpart** ({1}{U}{U}:
a token copy of a creature you control). The printed Counterpart has flashback, which this engine
has no vocabulary for — casting from a graveyard is a mechanism, not a cost — so what is here is the
front half, said rather than implied. (That mechanism was then built: see D113, and the Counterpart
has both halves now.)

They went into Tidal Mind, which wanted tricks, costing the Tome Scour (Hollow Tide's card rather
than this deck's) and the second Preordain. Measured over 240 paired duels against the rest of the
pool on two seed sets: 81-159 → 82-158 and 80-160 → 82-158. One and two games, which is as close to
"no effect" as this instrument can report, and the honest reading of two cards in a sixty: the
layers are the increment and the deck slot is where they are reachable from.

The first version of the slot cut the Wind Drake instead, and measured 96-144 and 80-160 — a bigger
move on one seed set and none on the other, so not a difference worth believing. It was changed for
a different reason: cutting the Drake left it in **no deck at all**, which the suite caught as an
orphaned script, and two tests that used tidal-mind's Tome Scour and Wind Drake went with their
cards rather than being patched around.

**Three layers are still named rather than faked**: type-changing (4), colour-changing (5) and
characteristic-defining abilities (7a). Nothing in the pool needs them, and a card that does is not
scriptable rather than approximated.

## D106 — A question about the whole table, and the Clone that asks it

Every mid-resolution question this engine could ask looked in one of the chooser's **own** zones:
your library (a tutor), your hand (a discard), your graveyard (a Raise Dead), your battlefield.
"Any creature on the battlefield" is a question about the table, and until now that made a whole
family of cards — Clone and everything printed like it — unscriptable rather than approximated.

`DecisionZone` has `any-battlefield` now, and it is a zone rather than a flag on purpose: the
candidate list *is* the authorisation the answer is checked against, so a question that looked at
one battlefield and accepted an answer from another would be a hole. Keeping both in
`decisionCandidates` is what makes that impossible rather than merely unlikely.

**The copy needed almost nothing.** `completeResolution` runs a spell's script *before* it moves the
permanent, so a Clone that points its own instance at the copied card's definition **enters** as
the copy: the arrivals pass then installs the copied card's statics and raises the copied card's own
entry trigger, and `scriptFor` gives it the copied card's abilities, because what gives a permanent
its abilities here is the name on it. The only new state is `CardInstance.printedDefKey`, and the
only new rule is that `relocate` — the one place a card changes zone — puts `defKey` back when the
permanent leaves the battlefield. A Clone that copied a Shivan Dragon is a Clone again in the
graveyard, which is what Zombify would bring back. That is CR 613.1a rather than a nicety.

**The sixth "spent on nothing" rule.** A Clone cast with an empty battlefield is a 0/0 that dies as
it arrives: four mana for a card in the graveyard. The search should see it — it plays the cast out
and state-based actions kill the 0/0 inside the same action — and mostly does: over 24 duels, nine
Clones cast, eight with a creature on the table and **one into nothing**. That one is the auto-pass
trap again, so the board is asked instead of the state after, exactly as for the Fog, the ritual,
the pump, the goad and the shield. After: eight casts, none into an empty board, and the control run
with the rule removed casts it into an empty board in the test that proves it.

**The card is the best deck change measured this session.** Clone cost Tidal Mind its second Cancel,
and over 240 paired duels against the rest of the pool: 82-158 → 101-139 on one seed set and
82-158 → 94-146 on the other. Nineteen and twelve games — the first above the 18-game noise floor,
both in the same direction, which is more than any other card swap this session could claim. The
reason is not subtle: in a deck with four counterspells and four removal spells, the best creature
on the table is usually the opponent's, and copying it is removal that leaves you the creature.

**And two tests that had quietly stopped being true.** Both failed on this increment and neither
was this increment's fault.

*"Does not throw creatures away"* asserted fewer than 1.5 dead attackers **per game**. Written when
the pool was four decks, it measured 0.8; today it measures 1.4 at HEAD and 1.65 with this change,
because eight decks and a hundred and sixty-seven cards make longer boards and more combat. The
count is what the deck list controls; the **rate** is what the policy controls, so the claim is a
rate now — 33 of 350 attackers, 9.4%, against the 13.7% the old policy lost and the 6.7% the fix
measured. Six of the 33 are Ball Lightnings, which sacrifice themselves at end of turn anyway.

*"Answers the questions cards ask mid-resolution"* required a Diabolic Tutor to be cast in twelve
specific games. A Tutor is one card in a sixty, and after a two-card deck change the shuffle simply
did not deal one: the test failed for twelve games that were fine. It plays twenty-four now, which
saw two — the same lesson as the sampled checks in the browser suites, answered by playing more
games rather than by asserting less.

## D107 — The removal with nothing to remove

D103 counted the bot pointing removal at its own creatures and deliberately did not judge it: "some
of them are defensible and some are probably not. It is written down rather than guessed at."
Judging it needed the instrument D101 built — finish the game twice from the same position, once
with the aim the bot chose and once with the best aim it had — and the answer was not the one the
count suggested.

**Six of the seven were not mis-aimed. There was nothing else to kill.** Over 60 duels: a Doom Blade
on its own Talrand, a Pacifism on its own Serra Angel, a Swords to Plowshares on its own Soul
Warden, a Flame Slash on its own Raging Goblin — in every one of those the opponent had no creature
on the battlefield at all, so the spell's own side was the only legal target left. The seventh had
an alternative and chose its own Goblin Arsonist, whose death pings something; played out, that game
ended the same either way.

So this is the **seventh "spent on nothing" rule** rather than an aiming fix: a card whose whole
effect is to remove a creature is not cast unless there is a creature the caster does not control.
Nine cards carry the flag — Doom Blade, Murder, Agonizing Demise, Flame Slash, Swords to
Plowshares, Pacifism, Journey to Nowhere, Divine Verdict, Bone Splinters — plus Turn to Frog, which
is removal that leaves the body. Three cards that look like removal and are not: a Lightning Bolt
can hit a player, a Man-o'-War is a body worth casting on its own, and an Unsummon aimed at your own
creature is a trick that saves it from a removal spell. A Banisher Priest is a 2/2 and keeps no
flag, while Journey to Nowhere — the same effect with no body — carries one.

Why the search cannot see it is the reason the family exists: killing your own creature scores worse
than passing, but with auto-pass on, the state after a one-mana instant can be a turn later, and
two positions a turn apart do not compare. The board is asked instead.

After the rule, the same 60 duels: **two** self-aimed casts, both with an enemy creature available
and so deliberate — the Agonizing Demise on the Arsonist again, and a Swords on its own Youthful
Knight for two life, which won the game it was cast in. The forced waste is gone and the judgement
calls are left alone, which is the right division.

Paired reference win rate, 240 games on two seed sets: 151-89 → 155-85 and 146-94 → 152-88. Four
and six games in the same direction, both inside the 18-game noise floor, so the case is the four
cards a game it stops throwing away rather than the win rate. The dead-card audit over every pairing
shows nothing newly dead: a rule that stopped a card being cast at all would show up there first.

## D108 — A shield is worth the life it saves, and that changes nothing

D102 left a gap with a number on it: the bot never takes Healing Salve's shield half — 72 casts out
of 72 took the three life — and the explanation offered was that `evaluate` cannot see a shield at
all, so "three life" was being compared with "nothing". That explanation was wrong, and finding out
cost two weights that have both been taken back out again.

**First the weight.** A point of prevention on a player is worth a point of life, so `seatValue`
counted it as one (and a point on a creature as half, since it only pays out if that creature is in
damage's way). Paired over 60 duels on the same seeds: **44-16 before, 44-16 after, every tally
identical** — the same 18 Salves cast, the same 11 Samite Healer activations, the same aims. Not a
small effect. No effect.

**Then the aim.** `friendlyRank` puts a player ahead of a creature, so a helping spell could only
ever be aimed at a life total; the alternatives list grew an own-*creature* entry for a `friendly`
spec, on the theory that a shield on a blocker about to die is a different card from a shield on a
player. Measured the same way: no change either.

**And then the instrument said why.** The shield half was *offered to the search 22 times in those
60 duels* — exactly as often as the life half — and chosen zero times. So the card was in hand, the
gate let it through, and the search looked at both halves and preferred the life. With the weight
in, that is a **tie**: three life and three prevention on the same player score the same number, and
`>` keeps the earlier option, which is the printed order. With the weight out it is three against
nothing and the life wins again. Either way the life wins, and for a player the life is the better
half anyway — three prevented is three saved *this turn*, while three life is three saved for the
rest of the game.

What makes prevention better than life gain is entirely beyond this search's horizon: a shield on a
blocker that would otherwise die, or a shield kept back for a burn spell. `simulate` stops when the
stack empties, so the creature that survives combat because of a shield is not in the position being
scored. **No weight can fix a horizon.** That is the same wall the pump rule, the ritual rule and
the Fog rule all hit, and those were solved by asking the board a question instead — but "would this
shield save a creature in a combat that has not been declared yet" is not a question about the
board, it is the playout the search already refuses to run.

So both terms are gone, which keeps the bot's evaluation at six honest weights rather than eight
decorative ones, and the lesson is written here instead: **the Salve's two halves are worth the same
to this bot, and taking the life is a defensible play rather than a bug.** The next person to want
the shield half chosen needs a deeper search, not a bigger number — and the measurement that proves
it takes twenty minutes, which is cheaper than the weight. (That deeper search has since been built
and measured as well, and it is level: see D110.)

## D109 — A deal at the table, and the one thing it does not do

The half of Commander a screen has always been worst at is not a rule. A pod has had threat reads
and goad for a while — both of them facts about the board — and no way to say the thing players
actually say to each other: *leave me alone this turn and I will leave you alone*. Chat carried the
words and nothing else: a sentence that scrolls away is not an agreement anybody can point at three
turns later.

So the table records deals now. Three of them, fixed wordings — a truce until the asked player's
next turn, and not attacking them this turn or next — offered by one seat to another, answered by
that seat and nobody else. **And nothing enforces any of it.** `pact:offer` and `pact:respond` are
the whole of the engine's involvement in making one; the only other place pacts appear in the rules
engine is `declareAttackers`, where an attack against somebody you promised not to attack marks the
pact broken, says so on the attack's own log line, and **is declared anyway**.

That was the decision, and it was not close. A table where the software stops you breaking your word
is a table where your word costs nothing: the pressure at a real pod is the other three players, and
all a program owes them is a record. Half the tests in `pacts.test.ts` exist to hold that line — if
one of them starts failing because the engine refused an attack, the feature has quietly turned into
a rule and the point of it is gone.

Three smaller calls fell out of it:

**Only the seat a deal was offered to may answer it — not even the host.** This is the one action in
the engine with no host override, and `assertMayActFor` is deliberately not used. The host runs the
table; they do not get to give somebody else's word.

**An expiry is a turn number, not a seat and a count.** "Until my next turn" stops meaning anything
once a seat between us is eliminated, and a turn number does not. The cost is that a pact is
measured in turns *taken* rather than turns promised, which is the same thing at the moment it is
accepted, and is what a player watching the table sees. A deal keyed to a turn nobody will ever take
— the player who offered it conceded before the answer came — expires before it starts, which is the
honest answer rather than a pact that lasts forever.

**The pacts travel to everybody, unredacted, including the spent ones.** It is the only part of the
state that does. A deal struck at a real table is struck out loud, and the fourth player hearing it
is most of what makes it mean anything; and the record of who kept their word is the whole feature,
so declined and expired pacts stay in the list (bounded by `MAX_PACTS`, which only ever drops
settled ones).

### Does the opponent keep its word?

The bot answers deals and never offers them. Answering is one rule — take it, unless the player
offering it is already dead on the board — because a bot that can swing for somebody's whole life
total and signs a truce instead is throwing a game away, and a player who offers a deal at four life
against a swarm is asking to be let off rather than offering anything. Offering is the half a search
genuinely cannot price: what a deal buys is somebody else's future behaviour, which is the two-ply
model D108 named as missing. A bot offering deals it had no way to value would be noise at the
table, which is worse than silence.

Keeping its word is a filter over every attack plan rather than one option among several, and that
distinction is the design: a deal the search would weigh against half a point of board advantage is
a deal nobody can rely on, and reliability is the only thing a pact has going for it. Measured over
30 pods with a truce going on the table every third turn, 500 moves each, same seeds both arms:

| | attack declarations | broke a live deal |
| --- | --- | --- |
| keeping its word | 672 | **0** |
| negative control (filter off) | 753 | **161** (21%) |

And the one case where it cannot keep its word: with two Juggernaut decks at the table, 10 of 882
declarations broke a deal, and **all 10 were creatures that attack each combat if able** with nobody
else legal to attack. The engine refuses the declaration that leaves such a creature at home, so the
choice is between an illegal attack and a broken promise — the promise goes, the log says so, and
the badge on that seat stays for the rest of the game. A bot that could not declare a legal attack
would be a worse table than a bot that occasionally has to break its word because the rules made it.

Deals cost the table attacks and time, which is what they are for: 672 declarations against 724 with
no deals on the same seeds, and 24 of 30 games finished inside the 500-move budget against 28. Of
495 offers the bots accepted 457 and declined 25 — the declines being the seats that could have
killed the offerer that turn.

## D110 — The reply, built and measured: level, and clairvoyant

Three entries in this log end at the same wall. The pump cast at the wrong time, the ritual spent on
nothing, the shield never chosen — each one was solved by asking the board a question instead of
weighting the position, and each write-up says the real fix is *the reply*: the search plays every
line out against an opponent who does nothing, so a Doom Blade always resolves and an attack is
never answered. D108 named it as the thing a weight cannot substitute for. So it was built.

**What was built.** `simulate` and `throughCombat` drained a line by passing priority for everybody;
they now hand priority to each other seat once per line and let it take its best answer. The answer
is chosen greedily — every candidate played out, scored from *that* seat's side, with nobody
answering the answer — because a nested search is the search inside the search that D62 and the
damage-order code both refused. The baseline is silence, so an answer has to beat letting the spell
resolve. Two gates kept the cost down: there has to be something to answer (a spell on the stack, or
an attack whose damage has not happened), and the seat has to have an untapped permanent to pay with.

**It worked, and it is taken.** Over 240 paired duels an answer was chosen 398 times — Negate 67,
Titanic Growth 67, Counterspell 40, Turn to Frog 37, Dive Down 30, Blossoming Defense 31, Essence
Scatter 25, Inspired Charge 27, Maze of Ith 12, Samite Healer 13, Divine Verdict 3 — which is a list
of exactly the cards a player holds up. And it changes decisions: on a board with a Serra Angel
against two untapped Swamps and a Doom Blade, the bot with the reply **attacks with nothing** and the
bot without **attacks with the Angel**. That is the hold-a-creature-back behaviour three entries in
this log have called for.

**One gate bug worth recording**, because it is the shape of mistake that makes a feature look
useless. `combat.attackersDeclared` is set by an *empty* declaration too, so the first version let
the defender cast its removal in both futures — the Angel died whether it attacked or not, the two
plans scored the same, and the reply changed nothing it had been built to change. Asking for
`attacks.length > 0` is what made the Angel test flip.

**And the record says it is worth nothing.** Paired duels on identical seeds, each matchup played
twice with the sides swapped, the answering bot against the silent one:

| | wins | answers taken | mean per decision |
| --- | --- | --- | --- |
| answers to spells only | 121-119 | 322 | 2.72ms vs 2.46ms |
| spells and attacks, gate bug | 121-119 | 394 | 2.92ms vs 2.55ms |
| spells and attacks, fixed | **120-120** | 398 | 2.66ms vs 2.35ms |

Dead level, three ways, at a sample where the noise floor is 18 games. In a pod it costs more: 30
pods on the same seeds finished 30/30 in both arms with nothing stalled or refused, at a mean of
10.39ms per decision against 8.40ms, p95 40.2 against 30.9, and a worst case of 3.0s against 2.5s.

So the reply is reverted, and this is its place instead. That is the third time depth has been
measured at zero in this engine — D62's projected second attack, the hold-mana weight, and now the
reply — and the pattern is consistent enough to state: **this evaluation is the limit, not the
depth.** A position two plies away is scored by the same six weights that cannot see what a shield
saves or what a card in hand buys, so looking further mostly finds more positions to misjudge.

### The reason it should not be kept even if it had won

`botAction` takes the whole `GameState`, so `reply` calls `legalActions` for the *opponent* and reads
their hand. A bot that declines to attack because of the exact card you are holding is not a better
opponent; it is a cheating one, and it would feel like cheating from the other side of the table —
which is the half of this that a win rate cannot measure and the 120-120 makes moot anyway.

Anyone coming back to this needs to know the shape of the honest version. The search must reason
from `viewFor(state, seat)` — the same redacted view a person gets — plus a model of what the
opponent's deck could be holding and whether their open mana pays for it. That is a different piece
of work from a deeper search, and it is the piece that is actually missing. The one subset that is
honest today is answers from the *battlefield*, since a permanent's activated ability is public: an
attack walking into an untapped Maze of Ith or Icy Manipulator is a real blind spot. It accounted for
about 19 of the 398 answers above, which is far below anything this instrument could price, so it
was not kept either.

## D111 — The last two layers, and the land the bot pressed 854 times

Layers 4 and 5 of CR 613 — type-changing and colour-changing — were the last two this engine had
*named* as not built, and the note next to them said the honest thing: nothing in the pool needed
them, so a card that did was not scriptable rather than approximated. Two cards now need them.

**Mutavault** ({T}: add {C}; {1}: becomes a 2/2 creature until end of turn, and is still a land) is
layer 4, and it is the honest hard case rather than a token one: a land that is a creature has to be
a creature everywhere the engine asks. **Crimson Wisps** ({R}: haste, becomes red, draw a card) is
layer 5, and is in for the layer rather than for the deck — two cards in this pool read colour at
all, and both are Paladin en-Vec's protection.

### Layer 4 is why `characteristicsOf` makes two passes

Every other layer can share one loop in effect order. Layer 4 cannot, because what a permanent *is*
decides which *other* effects apply to it: "creatures you control get +1/+1" applies to an animated
land (613.1c runs before 613.1g), and a single pass judging that scope against the printed type line
says no. So type changes are collected first, the type line is rebuilt from them, and everything
after is judged against the result. The scope of a type-changing effect is itself judged against the
printed types, which is the one simplification left — a card animating something another effect had
already animated would need the pass to iterate, and there is none.

The test that pins it is the anthem: an animated Mutavault under a `pumpTeam` is a 3/3. On the
one-pass version it is a 2/2, which is the kind of wrong answer nobody notices until a game is
decided by it.

### The bug layer 5 found in code that was already shipped

`protectionApplies` read the *printed* colours of the damage source. It had been right for as long
as nothing could change a colour, and the layer-5 test — a white Leonin Skyhunter made red, against
a Paladin en-Vec's protection from red — is what caught it. It reads `characteristicsOf(...).colors`
now, behind the empty-protection check that keeps the whole rule free for the 150-odd cards with no
protection at all.

### And then the card did nothing, three times over

The deck measurement said so first, and loudly. Ember Rush with one Mountain swapped for a Mutavault
and one Firebrand Archer for a Crimson Wisps, against the other seven decks, both seats, 238 games
per arm on two seed sets: **183-53 → 156-81 and 181-55 → 155-82.** Twenty-seven and twenty-six games
worse, which is not a noise-floor argument — it is the worst deck change measured here.

The instrument then said why, and it was not the card. In 56 games the bot **animated the Mutavault
854 times and attacked with it zero times.** Three separate failures, each needing its own fix:

1. **The moment.** A Mutavault that becomes a 2/2 is *still a land* to `seatValue`, so the animation
   scores exactly zero — and the search has no baseline for doing nothing, so with `>` comparing
   options it takes a free zero whenever nothing better is affordable. It animated in postcombat
   main phases and on opponents' turns. Fixed as the eighth "spent on nothing" rule: the board is
   asked whether there is an attack to make (its own precombat main, untapped, not summoning-sick,
   somebody left to attack) or a block to make. 854 → 90.
2. **The payment.** The {1} is generic and the Mutavault makes {C}, so the cost solver tapped the
   Mutavault to animate the Mutavault — legal, and it turns the 2/2 into a tapped 2/2 that cannot
   attack. `payFrom` now keeps the permanent's own mana for last when paying for that permanent's
   own ability, falling back to it when nothing else can pay. This is the fix that matters most: it
   is why the count was *zero* rather than small.
3. **The repeat.** With the first animation still on the stack the permanent is not a creature yet
   and the board looks untouched, so the rule above said yes again — and again. The gate asks the
   stack as well as the battlefield. 90 → 45, with **37 attacks** out of those 45.

Re-measured with all three in, same seeds: **183-53 → 189-48 and 181-55 → 177-60.** Six games up and
four down, both inside the 18-game noise floor, which is the honest reading of a two-card slot change
in a sixty — and a long way from twenty-seven games down. A Mutavault in a mono-red deck of {R}
costs is a real price as well as a body; what it is no longer is a trap the bot falls into.

Two smaller things worth recording. The table needed no change at all: the view sends power and
toughness exactly when `characteristicsOf` says the permanent is a creature, so an animated land
moves itself into the creature row and draws its own attack arrow. And Crimson Wisps' colour clause
is nearly inert in play — 12 casts in 56 games, almost all of them for the haste and the card — which
is written down rather than dressed up: the layer is right, and the card that needs it is a cantrip.

## D112 — The last layer: a size that is a fact about the board

Characteristic-defining abilities — layer 7a (CR 613.4a) — were the last layer of CR 613 this engine
had named and not built. **Lhurgoyf** needs one: its power is the number of creature cards in every
graveyard at the table and its toughness is that plus one. With it, every layer the cards in this
pool use is implemented.

A CDA is a different kind of thing from everything else in `characteristicsOf`, and the difference
is worth stating: **nothing resolves.** There is no moment at which the number is decided, so there
is nothing to store and nothing to invalidate — a creature dies three turns later and the Lhurgoyf
is bigger, a Tormod's Crypt exiles a graveyard and it is smaller, with no event, no trigger and no
recomputation anywhere. It is counted fresh on every read, which is the one implementation that
cannot drift.

**Declared, not computed by the card.** `definesSize` names a count the engine knows how to perform
rather than carrying a function, because `GameState` is written to Redis and sent down a socket: an
effect holding a closure is an effect that cannot be saved. And it names exactly *one* count, the
one the card needs. "Cards in your hand", "lands you control" and the rest are each one line in
`cdaCount` and one card away, and a clause with no card behind it is a clause nothing has ever run
— which is D57's warning, and the reason the enum has a single member and a comment rather than
three members and a hope.

**The ordering is the whole of the rest.** 7a defines the *base*, so:

- a setting effect beats it (613.4c after 613.4a): a Turn to Frog on a Lhurgoyf is a 1/1 however
  full the graveyards are;
- modifying and counters land on top: two creature cards buried, a Giant Growth and a +1/+1 counter
  make a 6/7;
- and a **copy** of it copies the ability rather than the number (CR 707.2) — a Clone of a
  four-power Lhurgoyf is a Lhurgoyf, and both of them shrink together when a graveyard is exiled.

Five tests, one per boundary, and the last of them is the one that makes layer 1 and layer 7a agree.

**In play.** It went into Rot Harvest for the second Hurricane — a deck that feeds its own creatures
to a Blood Artist is a deck whose graveyard only grows — and it is live rather than decorative: cast
12 times across 42 games, attacking 8 times at a mean power of 4.3 and a maximum of 8. The paired
reference record moved **104-132 → 107-131 and 93-144 → 103-135** over 238 games per arm on two seed
sets: three games and ten games up, both inside the 18-game noise floor and both in the same
direction, which is about what one card in a sixty can honestly claim.

What is left of CR 613 after this: dependency ordering between effects in the same layer (613.8),
which no two cards in this pool argue about, and layers 2 and 3 — control and text-changing — which
exist in the engine as *moves* rather than as layers, because control is a change of battlefield and
nothing here rewrites a card's text.

## D113 — Flashback, and the second zone a spell is cast from

`scripts.ts` said of Cackling Counterpart that "the printed card has flashback, which this engine has
no vocabulary for — casting from a graveyard is a mechanism, not a cost — so what is here is the
front half, said rather than implied". This is that mechanism.

Flashback (CR 702.33) is two things at once, and only one of them is a cost. The cost half is easy:
it *replaces* the printed cost rather than adding to it, which is the difference between it and the
kicker. The half that matters is the **zone**: a card with flashback is cast from its owner's
graveyard, which makes the graveyard the second zone a spell is ever cast from here. The command
zone was the first, and that one was a whole missing branch of `legalActions` when it went in — a
format whose point is its commander, and the function deciding what a seat may do never looked
there. So this went in the same place, as a third list beside the hand and the command zone, and the
list is filtered to cards whose script *has* a flashback cost: a graveyard of nine cards must not
produce nine lines of "you cannot cast this".

**And the end of it.** "Exile it instead of putting it anywhere else" is what stops a two-mana
cantrip being an engine, and *anywhere else* is the load-bearing phrase: a spell leaves the stack
three ways in this engine — it resolved, its targets are gone, something countered it — and all
three used to put the card in the graveyard. Three call sites each deciding for themselves is three
chances for a flashback casting to end up somewhere it can be cast from again, so the three now
share one function (`spellLeavesStack`) that reads the one flag the stack object carries. The test
that would have caught the miss is the one where a Counterspell answers a flashback casting: the
card is still exiled.

Three cards, one per shape:

- **Cackling Counterpart** ({1}{U}{U}, flashback {5}{U}{U}) — the one the note was about, both
  halves now.
- **Think Twice** ({1}{U} instant, flashback {2}{U}) — a cantrip whose whole point is the second
  casting.
- **Firebolt** ({R} sorcery, flashback {4}{R}) — two damage now and two more later, and the card
  that proves flashback did not quietly make a sorcery castable at instant speed: with something on
  the stack it is not offered, and a hand-built action naming it is refused for the printed reason.

**The bot needed nothing taught.** It casts them from hand because `legalActions` offers them and
the search prices the effect; it casts them again from the graveyard for exactly the same reason.
Measured over 48 duels: Firebolt cast 8 times and flashed back 8, Cackling Counterpart 4 and 4,
Think Twice 11 and 10. The one line of bot code this needed is the one that copies the flag onto the
action, without which the engine would have been told to cast a card in a graveyard as though it
were in hand — and would have refused its own offer.

**The table needed one line.** The graveyard row now says "playable" on a card that can be cast,
which it never had reason to before: a card in there was always something to look at and never
something to do. The browser driver learned the same thing — it tries the hand and then the
graveyard — because a mechanic the suites never click is a mechanic the engine's own tests pass and
nobody has ever actually used.

**The slots were a wash, which is the honest reading.** Think Twice for the second Soul Manipulation
in Tidal Mind: 45-193 → 45-193 and 64-174 → 63-175 over 238 games per arm on two seed sets — the
first of those is the same record to the game. Firebolt for one of Ashen Rite's two Burst Lightnings:
108-130 → 114-124 and 100-138 → 103-135, six and three games up, both inside the 18-game noise floor.
Cackling Counterpart's new half rode along in both arms of the Tidal Mind measurement, since the
script changed rather than the deck list, so that number is the Think Twice slot alone.

And one thing the measurement said that is not about flashback at all: **Tidal Mind wins 45 of 238
games against the rest of the pool on one seed set and 64 on the other** — about a fifth of them,
where Ember Rush wins three quarters. That is a balance problem with eight decks in it rather than a
card problem, and it is the next thing worth a measurement of its own.

## D114 — What each deck is worth, and the deck that had no way to win

Eight decks, measured against each other by the engine's own bot on both seats, 168 games each
(`scripts/measure/deck-table.mjs`, seeds 12 from 4400):

```
 80%  134-34  ember-rush
 70%  118-50  forge-alliance
 57%  96-72   verdant-guard
 49%  83-85   skyward-writ
 43%  72-96   hollow-tide
 38%  64-104  rot-harvest
 38%  63-105  ashen-rite
 25%  42-126  tidal-mind
```

Ember Rush beat Tidal Mind 23-1. Tidal Mind beat exactly one deck in the pool, 13-11.

**The first thing measured was not a change but the deck.** The obvious guess about a deck at 25% is
that some of its sixty cards are dead weight, so `cast-counts.mjs` went in: for every slot, how
often the bot casts it as a share of the games it reached hand. Tidal Mind's answer was that
*nothing* is dead. The least-cast spell in the deck is Diabolic Tutor at 35%, then Negate at 38% and
Cancel at 49%; the counterspells and removal it is supposedly failing to use are at 92% (Counterspell),
103% (Essence Scatter), 112% (Doom Blade) and 93% (Murder) — over 100% because the figure is per game
the card reached hand and two copies can each be cast. Ember Rush, at 80%, is the same shape: its
worst slot is Shivan Dragon at 40%. So is Ashen Rite (Read the Bones, 60%) and Rot Harvest (Zombify,
64%). **Across four decks spanning fifty-five points of win rate, there is not one dead card.** A
deck's record in this pool is not explained by cards the bot refuses to cast.

That harness also produced the one honest mistake worth recording. Its first version counted casts
and land drops only, and reported Lonely Sandbar at 12% — two land slots doing nothing, apparently
the clearest finding of the day. Counting activated abilities too moved it to 115%: a cycling land
is *played* or *cycled*, and the harness had been blind to the half of the card the deck actually
used. A usage number is only as good as its definition of use.

**Then three variants, same instrument, 238 games per arm, two seed sets.** The first was the
obvious slot change — two three-mana answers out, two cheap blockers in — and it measured as
nothing: 45-193 → 49-189 and 63-175 → 73-165, four games and ten, both inside the eighteen-game
noise floor. Same direction twice is not a measurement. It was reverted.

The one that worked was bigger, and it worked for a reason the totals hide. Cutting four of the six
counterspells for four cheap creatures is worth +42 and +33 on the two seed sets — three times the
floor, 23% → 38% — and **the per-opponent split says none of it comes from where the hypothesis
said it would**:

```
 3-31 ->  4-30   +1  v ember-rush
 5-29 ->  6-28   +1  v verdant-guard
 4-30 ->  9-25   +5  v forge-alliance
11-23 -> 16-18   +5  v hollow-tide
10-24 -> 20-14  +10  v rot-harvest
 8-26 -> 18-16  +10  v skyward-writ
 4-30 -> 14-20  +10  v ashen-rite
```

The hypothesis was "six counterspells and no sweeper cannot answer eighteen one-drops", which
predicts the gain against the fastest deck. Ember Rush is unmoved: 3-31 before, 4-30 after. Tidal
Mind is simply dead to it either way, and nothing in a sixty-card list fixes that. Every one of
those games came from the *slow* half of the pool — including beating Skyward Writ, which it used to
lose 8-26. **The deck's fault was not that it could not survive. It was that it had no way to win
the games it survived**: it answered everything, killed nobody, and lost the long game to whoever
drew a threat last.

A third variant separated the halves of the swap. Keeping all six counterspells and buying the same
four bodies with two lands and two removal spells is worth +24 of the +42 — so the clock is most of
it, and converting the redundant answers into that clock is the rest. Both halves are real, and
every variant shows the same per-opponent shape.

**What shipped is the middle one, not the biggest number**, and the reason is card quality rather
than measurement. The deepest cut deletes both Counterspells while keeping Cancel, which costs a
mana more for the same text — nobody would build that. The only counterspells left to trim are
Cancel and Soul Manipulation, and those are the pool's **only copies of their cards**, so cutting
them would orphan two scripts. So Tidal Mind goes to three counterspells rather than two: one
Counterspell for two, one Essence Scatter for two, no Negate (the least-cast spell in the deck, and
blank against the six of eight decks that win with creatures), paying for a second Fog Bank, a
second Vampire Nighthawk and a third Man-o'-War. Measured +31 and +25 on the two seed sets: 23% →
34%, which moves Tidal Mind from the pool's outlier to level with Rot Harvest and Ashen Rite.
**The pool's structure sets where this stops, not the instrument.**

**Three tests changed deck, and that is all the churn.** Three scripts tests drew a named Negate out
of Tidal Mind's library; they now draw it out of Hollow Tide, which runs Negate in the same two
colours. A test that wants a card should load a deck that has one.

**The ceiling was left alone.** Ember Rush at 80% is the other end of the same spread, and nothing
here touched it: a burn deck with four Lightning Bolts is the easiest thing in this pool for a
one-ply search to pilot, and a deck that is strong partly because the opponent plays it well is not
a deck to weaken until the opponent is better (D110). The pass set out to make sure no deck is
unplayable rather than to make every deck 50%, and with the floor at 34% that is now true.

**And the instrument is in the repository.** `deck-table.mjs`, `deck-probe.mjs` and
`cast-counts.mjs` lived in a scratch directory for every measurement before this one, which means
every number quoted in this log up to here was produced by a tool nobody can re-run. They are now
in `scripts/measure/` with a README that states the noise floor, the two seed sets, and the one rule
this entry exists to prove: read the per-opponent split before believing the total.

## D115 — Ward, and the three places a token that does not exist still had to be found

Ward was the one evergreen keyword `KEYWORDS` did not have, and it could not be one: a keyword with
a cost in it is not a flag. "Ward {2}" is shorthand for *whenever this permanent becomes the target
of a spell or ability an opponent controls, counter it unless that player pays {2}* (CR 702.21b), so
it went in as the triggered ability it abbreviates — `ward(name, cost)` in `scripts.ts` returns a
`TriggerDef` and nothing about the mechanic is special-cased anywhere else.

**The question belongs to the wrong player, and that is the whole design problem.** Every
mid-resolution question this engine had asked belonged to whoever was resolving something: the
caster searching a library, the controller aiming a trigger, the player discarding to their own
Mind Rot. `pendingDecision.seat` is a chooser *inside* somebody else's resolution. A ward's ability
belongs to the warded creature's controller and the question it asks belongs to the player who did
the targeting — so it could not be folded in, and `pendingPayment` is its own field with its own
action. Two consequences fall out of that one fact:

- The authorisation check in `payWard` is `pending.seat !== action.by` written out rather than
  `assertMayActFor`, which permits a host override. The host may drive a seat's own decisions; this
  is not one of them. Same reasoning as a deal offered to another player (D109).
- It is **two** answers, not one, so it is a row on the control bar rather than the primary button —
  and `primaryMove` deliberately returns nothing for it. A single "Pay" button with no way past it
  would be a stopped table dressed as a choice.

**Not being able to pay is not a choice, so it is not offered as one.** A player with one untapped
land facing Ward {3} has exactly one outcome available, and a prompt with one button is the
stuck-table bug that "a trigger with no legal targets never goes on the stack" exists to prevent.
That half is `settlePayment` in `automation.ts` rather than in the effect, because "can this be
afforded" is answered from `manaSources`, which lives above `effects.ts` — and nothing can change
between the two points, because nobody holds priority while a ward is outstanding. It uses
`canAfford`, not a second opinion about the pool, for the reason `legalActions` does: two answers to
"can this be paid" is how a table comes to offer a payment the engine then refuses.

That path also produced the one genuine UX hole in the feature, found by counting rather than by
reading: **six of the eleven wards in a 224-game soak were never shown to anybody**, because nobody
could pay them. The spell left the stack with no prompt and no message — a removal spell that simply
vanishes. It now writes a line through the same `replacements` channel a replaced death uses, which
is the same fix for the same bug: a card the player cannot see working.

**Where ward triggers from is four call sites, and the fourth is the one that mattered.** An object
on the stack gains targets in four places — a spell being cast, an activated ability, a triggered
ability the engine could aim itself, and that same one once its controller has chosen. One helper
(`raiseWard`) is called from all four, rather than from inside `pushAbility`, which this module's
own trigger loop calls while walking its watcher list. The fourth site is not completeness for its
own sake: **Flametongue Kavu's arrival deals its damage to a *target* creature**, so without it a
Ward {1} would have answered a Doom Blade and not a Kavu, which a player reads as a bug rather than
as a rule. The event defaults to `by: 'opponent'` — the opposite of every other trigger here —
because ward never fires off its own controller's spells, and a default that is wrong for the only
caller is not a default.

**Then Sedgemoor Witch's Pest found three bugs that had been sitting there in writing.** `relocate`
said, of a token leaving the battlefield: *"A token is recorded too and then ceases to exist below,
so its trigger finds no source and does not fire — a real limitation, and no token in the pool has
one."* A 1/1 that says "when this creature dies, you gain 1 life" is a token with one. The rules are
unambiguous that it should fire (CR 603.6d: a leave-the-battlefield ability triggers from the game
state as it was *before* the event), so the limitation had to go — and it turned out to be three
separate reads of a thing that was no longer there, each of which had to be found by instrumenting
rather than by reasoning:

1. `raise` computed the subject's seat from `instances`, so a vanished token was not in **anybody's**
   watcher list to be asked.
2. `pushAbility` read the source's `defKey` from `instances`, so the ability reached the stack with
   an empty `cardKey` and resolved as nothing.
3. The watcher loop called `scriptOf(state, id)`, which looks up `instances` again.

The fix is `GameState.vanished`: the token is removed from its zone and detached at once, because
nothing should ever see a token sitting in a graveyard, and its last state is kept just long enough
for `settle` to raise its events. Three reads, one map, and `TOKEN_DEFS` so the deck-coverage test
can tell a token script from an orphan rather than being loosened.

**The invariant test earned its keep.** `playout.test.ts` has a list of every way the engine can be
waiting on a seat, with a comment saying the list is exhaustive on purpose because a new one is a
deadlock as far as a client is concerned. Adding `pendingPayment` broke it immediately. That is the
test working: the engine had grown a new way to stop and the client had no answer for it.

**Measured.** Two cards, both printed with ward and magecraft, both halves scripted (the "or copy"
half of magecraft is not, and says so in `scripts.ts`, because nothing in this pool copies an
instant):

- **Dragonsguard Elite** ({1}{G}, 2/2, Ward {1}) into Verdant Guard for the second Naturalize:
  151-87 with it against 148-90 without, over 238 games. Three games — a wash.
- **Sedgemoor Witch** ({2}{B}{B}, 3/2, menace, Ward {3}) into Ashen Rite for the second Boggart
  Brute, in the deck whose Blood Artists and Cutthroats want the Pests: 105-133 either way. The
  same record to the game.

Both washes, which is the right outcome for a mechanic rather than a power addition: the engine
gained a keyword and the pool did not move. Over 224 games the bot cast 22 Elites and 20 Witches,
answered 11 wards (5 paid, 6 unpayable), made 5 Pests, and **finished every one of the 224** — which
is the number that mattered, because a new way for the engine to stop and wait is a new way for a
table to hang.

**What the bot does with it is the cheap rule, said out loud.** It pays whenever it can. Declining
throws the whole card away, the spell's own cost is already spent, and this bot casts greedily down
its curve, so by the time a ward is on the table there is rarely anything left it was saving for.
What it cannot weigh is the case where the mana was worth more than the spell — holding two up for
a counterspell, which is the same thing the search has never been able to price (D110). Over the
soak it declined zero times, which is this rule being honest about what it is rather than evidence
that it is right.

**And the browser suites can only sample it — but it has now been sampled.** Eleven wards in 224
engine games is about one game in twenty, so the arena suite reports "no ward came up" far more
often than not, and says so rather than passing silently. The deterministic coverage is seven engine
tests — paid, declined, cannot pay, not off your own spells, off an activated ability, off a
triggered ability, and the Pest's own death trigger — plus a web test on the shape the control bar
reads, which is the layer the flashback bug lived in (D113).

The row itself was unverified in a browser when this entry was first written, which is exactly the
gap D113's bug came through, so it was hunted rather than left: **eighteen browser games, one ward**,
in the pairing most likely to produce a payable one (Tidal Mind's removal against Verdant Guard's
Ward {1}). That one works end to end — a Doom Blade aimed at the Elite, the prompt reaching the
*caster*, {1} paid, the Elite dying to the removal it did not stop. One in eighteen is the same rate
as the engine's one in twenty, and it is a real denominator rather than the word "rarely".

One thing in this paragraph is **not** verified, and is written down rather than implied. The
screenshot that run produced was taken after the payment, so it showed the feed reporting a creature
that had already died rather than the question being asked. A picture called "a ward being paid"
should show two buttons and the sentence naming what is countered if you decline, so the driver now
shoots before it presses — but twelve further runs produced no ward at all, so **no run has yet
exercised the new ordering.** It is a two-line change in the obvious direction; it is not evidence.

## D116 — Unblocked power: the fifth term, the fifth deletion, and what the four have in common

D110 ended on "what is missing is not depth: it is an evaluation worth searching with". This is the
first attempt at the other half, and it failed — but it failed in a way that explains the other four.

**The idea.** Every weight in `evaluate` is a fact about a *card*. `flying: 1.5` is worth the same
against a board of five ground creatures as against a board of five fliers, when in the first case
the 2/2 flier is a two-a-turn clock and in the second it is a 2/2. That difference is **relational**,
and reading the board rather than pricing a card is the pattern that has actually worked in this bot
(D103's removal with nothing to remove, D107, D111's animated land). So: for each creature that
could attack, ask whether anything opposite could legally block it — with `canBlock`, so there is
one answer to "can this block that" rather than a cheaper second opinion written in the bot — and
add that power to the side it belongs to. Counted only where the opponent *had* blockers that could
not do the job, since a creature unblocked by an empty board is already described by the power on
the board, and counting it twice would make the measurement meaningless.

**The instrument, which is new and worth keeping.** Deck changes are measured against a field;
a term in the evaluation has to be measured against *the bot without it*. So: bot against bot, every
deck pairing, both bots in both seats, identical seeds. The negative control ran first — two
identical bots — and scored **56-56 of 112**. Exactly level, which is what a paired design should
give and what makes the rest of the table readable: there is no seat bias and no matchup bias left
in it, so anything that moves is the term.

| a point of unblocked power | record over 336 games |
| --- | --- |
| 0.5 | 165-171 |
| 1.0 | 161-175 |
| 2.0 | 158-178 |

Monotone, and against — the same shape as the untapped-mana result in D68. The first version of the
term counted tapped and summoning-sick creatures as pressure, which is a genuine flaw: a tapped
creature is not a clock. Gating it on `canAttack` moved 0.5 to 164-172 and 1.0 to 162-174 — the same
answer to a third decimal place. **The hypothesis was wrong, not the implementation**, which is
worth separating because the opposite conclusion would have sent the next attempt down the same road.

**What the four deleted terms have in common.** A second ply (D62), a swing projection (D62),
untapped mana (D68) and this one are all statements about what happens *next*: the move after this
one, the damage this swing will deal, the option the mana buys, the damage the flier will get
through. The terms that work are statements about what *is* — life, cards in hand, cards in the
library, bodies on the board, loyalty on a planeswalker. And the reason is in the engine rather than
in the weights: with auto-pass on, the position this search scores after a cast **can already be a
turn later** — the same trap the "spent on nothing" family of rules exists to work around (D103) —
so a term about the future is read at a moment that has already gone past it.

So the ceiling is not "a sum of material cannot express tempo", which is how D69 put it. It is
narrower and more useful: **this evaluation can price what is, not what will be**, and the fix is
not a better weight but a search that stops where the term applies. That is a different piece of
work from either a deeper search or a richer evaluation, and it is the one the next attempt should
be aimed at.

The code is gone and the lesson is in its place, in the comment above `LAND_ON_BOARD` where the
other four live.

## D117 — Where the search stops: three times faster, and exactly as strong

D116 ended on a diagnosis rather than a weight: *this evaluation can price what is, not what will
be*, because with auto-pass on, the position handed to `evaluate` can be a step — or a turn — past
the action it was about. That was inferred. This measures it, acts on it, and reports what the
action was worth, which is not what the diagnosis predicted.

**The drift, counted.** Over 13,907 actions in real games, how far the table moved on one action:

```
action           actions  same step   a step on   a turn on
auto:cast           2821    51%        30%         19%
auto:attack         1298    23%        27%         50%
auto:block           408    25%         7%         68%
auto:playLand       1350    71%         6%         23%
auto:activate        743    57%        36%          7%
```

**Half of all attack declarations are scored after the turn has already ended**, and nearly one cast
in five. A swing projection read after the swing is over is not a weak term; it is a term reading a
different position. The same goes for untapped mana, which is about the rest of *this* turn, in a
position that is often next turn — and mana pools empty when a step ends.

**The fix is one line in the right place.** `applyAction` runs the engine's auto-pass loop, so the
search turns auto-pass off in the state it is about to simulate (`noAutoPass`). The simulated state
is scored and thrown away — it is never applied to the real table — so this changes what the bot
*sees* and never how the game runs. The action then stops where it happened: the spell resolved,
priority back, same step.

**It is worth no games at all.** 166-170 over 336 paired games on the bot-against-bot instrument
whose negative control is exactly 56-56 of 112. Inside the noise floor, and the honest reading of a
flat result needed one more check first, because a setting that changes no decisions cannot win or
lose any: it changes **1% of decisions overall, 10% of attack declarations and 6% of blocks**, and
3 casts in 2,845. So it is a real change to the choices, worth nothing on the scoreboard.

**What it is worth is time, and a lot of it.**

| | mean per decision | worst | total over the same games |
| --- | --- | --- | --- |
| duel, auto-pass in the search | 2.62ms | 77ms | 36.5s |
| duel, stopping at the action | **0.91ms** | **17ms** | 12.0s |
| four-seat pod, auto-pass in the search | 10.42ms | 407ms | 314.9s |
| four-seat pod, stopping at the action | **4.78ms** | **292ms** | 141.9s |

Three times faster in a duel and more than twice as fast in a pod, with the worst case down from
77ms to 17ms. That is the number that matters: D71 went looking for pods taking minutes per
decision, and a worst case is what a person waiting at a table actually feels. **So it ships on the
strength of the clock rather than the scoreboard** — same player, far less waiting, and scoring the
position the action was about rather than one the table had already left.

**And it does not rescue the deleted terms.** The obvious next question is whether unblocked power
was right all along and merely read at the wrong moment, so it went back in on top of this and was
measured again — see the next entry. Being able to ask that question is most of why this was worth
doing even at a flat scoreboard.

## D118 — The same term on the fixed search: level, not losing, and D116 corrected

Asked again, because D117 made it a different question. Unblocked power went back in temporarily and
was measured on a search that stops where its action happened:

| a point of unblocked power | old search (D116) | search stopping at the action |
| --- | --- | --- |
| 0.5 | 165-171 | **170-166** |
| 1.0 | 161-175 | **168-168** |

The negative control ran first on the fixed search too, and came back 56-56 of 112 again.

**So the term is neutral, and it was never harmful.** The drift was. D116 concluded "the hypothesis
was wrong, not the implementation" and that was too strong a claim from a broken instrument — the
honest version is that the term is worth nothing either way, and that the twenty-game spread between
the two columns is the cost of scoring a position the table had already left. The comment above
`LAND_ON_BOARD` has been corrected in place rather than left to mislead the next attempt.

**It stays deleted**, because level is level: a term the instrument cannot price is a scan of both
boards on every evaluation for nothing. What it bought is the correction, and one more thing worth
more than the term — **three of the other four deleted terms are now worth re-asking.** A second ply
and a swing projection (D62) and untapped mana (D68) are all statements about what happens next, and
all three were measured against a position that had already gone past them. Whether any of them
survives the fixed instrument is unknown, and it is a much better question than the one D116 left.

The general lesson is about method rather than about Magic: **four terms were deleted against an
instrument that was reading the wrong position, and the deletions were recorded as facts about the
terms.** They were facts about the pair. Every one of those entries states its numbers, which is the
only reason this was recoverable at all — a log that had recorded "tried valuing evasion, didn't
work" would have closed the question for good.

## D119 — Untapped mana, re-asked: level too, and the second conclusion corrected

The second of D118's three. D68 built a term for the hole that reads as obvious — a bot that taps
out every turn is holding a counterspell with no mana when the spell worth answering arrives — and
measured it losing at every weight that changed anything, monotone, over 84 paired games on a narrow
field. The term was "a little for each untapped land, but only while the hand holds something
castable at instant speed, capped at the cheapest such card's cost".

Rebuilt exactly as it was and asked again on the search that stops where its action happened, on the
paired bot-against-bot instrument (negative control first: 56-56 of 112 again):

| mana-up weight | D68, old search and narrow field | fixed search, paired instrument |
| --- | --- | --- |
| 0.5 | 23-61 | **171-165** |
| 1.0 | 20-64 | **171-165** |
| 2.0 | 18-66 | **169-167** |

And 167-169 on a second seed set at 1.0 — so +6 and -2 across 672 games, which is level. It changes
1% of decisions, so it is a real change to the choices that is worth nothing on the scoreboard.

**Two corrections, not one.** A term about *the rest of this turn* measured against a position the
table had already left was being read in about the worst place it could be: mana pools empty when a
step ends (CR 500.4), so by the time the old search looked, the mana the term was pricing had gone.
That is why the sign flipped rather than merely the size.

And the lesson D68 left behind has to go with it. "For this bot in this pool, the board bought with
the mana is worth more than the answer kept for it" is a claim about Magic, and it was never
measured — it was inferred from a monotone that was an artifact. What the numbers support is
smaller and duller: **holding mana is worth nothing to a bot that cannot plan a turn ahead.** The
term cannot pay off, because paying off means spending the mana on the opponent's turn in a way this
search never gets to see.

The term stays deleted. Two of the four deletions D118 flagged are now corrected, and both turn out
to have been level rather than harmful. That is the shape of the finding: **a broken instrument did
not produce noise, it produced confident wrong signs** — monotone ones, in both cases, which is
exactly what makes a bad measurement persuasive.

## D120 — The control: a term about the present measures the same on both searches

D119 claimed something specific — that the two sign flips happened because those terms were about
*what happens next*, and were read in a position the table had already left. A claim like that is
worth a control, and D62 left a convenient one: a non-linear life total, deleted for measuring
level at 285-284 over 400 games. Two life is worse than twenty minus eighteen, which is true and did
not show up.

It is a statement about **what is**, not about what will be, so the theory predicts the fixed search
should not change it. Rebuilt as D62 had it — a penalty per point of life below a threshold — and
measured on the fixed search:

| bite below six life | record over 336 games |
| --- | --- |
| 1 | 169-167 |
| 3 | 168-168 |

Level, exactly as before. **So the fixed search did not simply move every number**: it moved the two
terms about the future from confidently-against to level, and left the term about the present
alone. That is the result the theory needs, and the cheapest way this session could have been wrong
about it.

Deleted again, for the reason D62 deleted it: level is level.

What is left of the original five is the half that needs the search restructured rather than a
weight changed — a swing projection and a second ply, both of which D62 measured at *exactly* level
(276-276 and 276-276) rather than against, and the honest reply D110 measured at 120-120. Those are
the three where "no difference" might still be an artifact of the old instrument, and re-asking them
is a different piece of work from adding a term: each one is a search, not a number.

## D121 — Convoke, and the second answer this file nearly grew

Convoke (CR 702.51) is the first cost in this engine that is neither mana nor a sacrifice: each
creature tapped as the spell is cast pays one generic mana, or one mana of that creature's colour.
It is a flag on the script rather than a cost, because it does not change what a spell costs — it
changes what may pay for it.

**It reduces the cost rather than making mana, and that is the whole decision here.** The tempting
shape was a few lines: a convoked creature is almost exactly a dual land — "one generic or one of my
colour" — so adding untapped creatures to `manaSources` with `produces: [...colors, 'C']` would have
worked the solver already there. It is wrong for one reason that cannot be patched afterwards: a
mana source that over-produces leaves mana floating, convoke cannot do that, and **nothing
downstream could clean it up** because Dark Ritual is in the pool and floating mana is therefore
sometimes legitimate. So `convokePlan` works out which creatures to tap and what is *left* of the
cost, and `payFrom` learned to take a cost that has already been worked out rather than only a
string to parse.

**One planner, called from both sides.** `legalActions` asks it whether to offer the cast and
`castSpell` asks it again as it pays — the same function, on the same state, so an offer and a
refusal cannot disagree. That is the bug class `legalActions` exists to prevent, and convoke is the
closest this pool has come to growing a second answer to "can this be paid for". The test that
matters is the sweep: for every board from nought to seven lands and nought to four creatures,
either the play is offered and the cast reaches the stack, or it is not offered.

**It taps nothing it does not have to.** Mana first, and only the shortfall convoked: a tapped
creature cannot block, so a spell the lands already cover convokes nobody. The visible consequence
is a test that reads oddly until you see why — four Forests, a Grizzly Bears, a Centaur Courser and
a Llanowar Elves casting a {5}{G}{G} Wurm says **"convoking 2"**, not three, because the Elf taps
for {G} and the planner counts that first. Three creatures end up tapped either way; one of them is
paying mana.

**Two rules worth getting right, both in the permissive direction.** Summoning sickness does not stop
convoke — tapping for it is neither attacking nor activating an ability (CR 702.51a) — so a creature
that arrived this turn may pay for a spell, which a test pins with three tokens made on the turn
they convoke. And a creature tapped for convoke leaves the mana-source list, because it cannot be
tapped twice; without that the engine would count one tap as two and offer a cast it then refused.

**Said on the play.** `Cast Siege Wurm (convoking 2)` rather than `Cast Siege Wurm`, because a table
that offers a seven-mana spell off four lands and gives no reason is a table a player does not
trust. The count, not the names: which creatures get tapped is the engine's to decide, and three is
what the player needs to know.

**Two cards, both Selesnya, both in the Selesnya deck** — convoke is only a discount where there is
a board to tap, and nowhere else in this pool is there one. Siege Wurm ({5}{G}{G}, 5/5 trample) for
the second Serra Angel, and Conclave Tribunal ({3}{W}{W}, exile a nonland permanent until it leaves)
for the second Swords to Plowshares. Five mana of removal is unplayable on a creature deck's curve
and three is not, which is what the mechanic is for.

**Measured.** The slot change is a wash: 149-89 with the two cards against 152-86 without, over 238
games — three games, inside the noise floor. What is not a wash is how often they get cast. Over 84
games, **Siege Wurm is cast in 79% of the games it reaches hand and Conclave Tribunal in 88%, where
the Serra Angel it replaced manages 63%** — the mechanic doing exactly what it is printed to do. And
over 168 games the bot cast one of the two twenty times and **convoked thirteen of those, tapping
2.7 creatures a time**; 168 of 168 games finished. The bot needed nothing taught: `legalActions`
offers the cast and the search prices the tapped creatures, because `simulate` scores the board
after they are tapped.

## D122 — Face down: a 2/2 with no abilities, and two players who could disagree about one board

Scoping morph turned up a live bug instead. Any player may turn a permanent face down — the card
menu has offered it since the tabletop table existed, and an automated table reaches the same move
through **Move by hand** — and `viewFor` has always hidden the card's identity from everybody else.
Nothing hid it from the *rules*. A face-down Hill Giant was a card the opponent could not read and
a 3/3 that fought like a Hill Giant, tapped for whatever its card taps for, handed out whatever
static it was handing out, and watched for whatever its triggers watch. A probe test printed both
halves verbatim before anything was changed: `characteristicsOf` said
`{"name":"Hill Giant","power":3,"toughness":3,...,"colors":["R"]}`, and the opponent's copy of that
same card had no `card` field **and no power or toughness at all**. Two players looking at one
board with different facts, and one of them looking at a blank.

**Substitute the card, do not special-case the function.** `characteristicsOf` swaps a frozen
`FACE_DOWN` CardDef — a 2/2 creature, no name, no mana cost, no types beyond Creature, no colours,
no text — in for `state.cardDefs[defKey]` at the top, and every one of CR 613's layers then runs on
*that*. Which is the rule, not a convenience: a Giant Growth on a face-down creature makes it a
5/5, a +1/+1 counter makes it a 3/3, an anthem lifts it. Three of the six tests are that sentence.
Had the face-down case been a branch *through* the function instead, each of those layers would
have been a separate decision to get right, and the counters one is the layer most easily dropped.

**It loses what it was giving as well as what it has.** CR 707.2 is "no abilities", and the static
ones count: turn a Glorious Anthem face down and the team shrinks. But the effect is not deleted
when the card is turned over, because a permanent turned back face up has its abilities again and a
deleted effect could not come back. So `silenced(state, effect.source)` is checked where each
effect is *read*, in both of the loops in `characteristicsOf` — detect, don't announce, the same
rule that governs death triggers here.

**One predicate, five callers, and that is the reason it exists.** `isFaceDownPermanent` lives in
`cards.ts` and is read by the trigger watcher, the mana-source list, the activated-ability offer,
the continuous-effect loops and `characteristicsOf` itself. The condition is two clauses long and
writing it out five times would have worked; a list of five places is a list somebody adds a sixth
to without noticing. A face-down Forest is not a Forest, and a face-down Llanowar Elves taps for
nothing — the mana-source line is the one a player would hit first.

**Only on the battlefield.** A face-down card in exile is a card nobody may read, which is a
question for `viewFor` and not for the rules: it has no characteristics to get wrong because
nothing fights it, and calling it a 2/2 creature there would make exile a battlefield.

**The view had to be restructured, not patched.** `redact` used to return early the moment a card
could not be identified, and that early return was what cost the opponent the stats. It now
computes the characteristics for *every* battlefield permanent and attaches the card definition
only when the viewer may have it. That reads like a leak and is the opposite of one: what goes out
is the 2/2, because `characteristicsOf` already substituted the profile for the card. The sixth
test is the one that proves it — the opponent's view and the spectator's view both carry a 2/2 with
`card` undefined, and the string `"Hill Giant"` does not appear anywhere in either payload.

**Not measured, and why not.** No card in this pool turns a permanent face down, so no number of
bot games exercises any of this; a games-played figure here would be measuring nothing. What there
is instead: six tests that each name the rule they pin, 649 in the package, and the five browser
suites (54, 53, 41, 21, 23 checks) on the rebuilt stack. Morph is now unblocked, but the fix was
worth doing on its own — the table offered the move already, and what it did with it was wrong.

## D123 — Morph, and the pack that was dropping a field

Morph (CR 702.37) went in on top of the face-down work in D122, and the shape of the change is the
argument for having done that first: three cards, one script field each, and no new rules. A card
with morph may be cast face down as a 2/2 creature spell for {3}, and its controller may turn it up
later for the cost printed on it. What a face-down thing *is* was already answered.

**Two actions, not one, because they are two different things.** The face-down cast is
`auto:cast` with `faceDown: true` and the turn-up is `auto:turnUp`, a **special action**: no stack,
no priority window, nothing an opponent may do about it (CR 702.37b). That is not a detail — it is
the reason a player holds a morph instead of casting the creature, and a table that drew the
turn-up as an activated ability would be promising a window to respond that does not exist. It is
`kind: 'turnUp'` in `legalActions` for the same reason, and `activatablePlays` builds it in a loop
of its own, because the ability loop skips face-down permanents by design.

**The face-down cast is its own function.** `castFaceDown` is called out of `castSpell` before
anything else happens, because a face-down spell has no text: no modes, no {X}, no kicker, no
additional cost, no convoke and nothing to target. Each of those is refused rather than dropped —
an action carrying one has misread the card, and a stack object carrying a mode the spell has no
text to read would be a lie the resolution could act on. Threading a `faceDown` flag through forty
lines about targets and modes was the alternative and it would have been worse at every line.

**Offered before affordability, which is the whole point.** The morph play is pushed in
`castablePlays` *above* the check that skips a spell the lands cannot pay for. A morph you cannot
afford is still castable face down — that is what the mechanic is for, a five-mana creature on turn
three — and a block placed after that check would have hidden the one play the card is in the deck
for. It is above the land branch as well, which is how Zoetic Cavern works at all.

**Zoetic Cavern is in the pool to prove the rule rather than to use it.** A *land* cast as a 2/2
creature spell, which is legal because morph does not read the card (CR 702.37a) and because a
face-down permanent has no types of its own. It is the single best test of the D122 design: a
face-down Cavern taps for nothing, does not use the land drop, and turning it up gives back a land
that is not a creature. A patch rather than a substitution would have needed a special case for
each of those three sentences.

**Four places had to learn that a face-down spell has no script.** `scriptOnStack` is the stack's
counterpart to `scriptOf`, and all four readers of a stack object's script go through it — targets,
decisions, the before-decisions half and the resolution — because a face-down spell that resolved
with its card's `onResolve` would be a morph that did the card's trick for {3} and then sat there as
a 2/2. The arrivals loop in `settle` learned the same thing for `entersTapped` and for statics, and
`turnUp` installs the statics itself, because `settle` installs them only for a permanent that
*arrived* and this one arrived with no abilities to install.

**The bug this turned up was in the wire, not in morph.** `packView` leaves out an empty keyword
list — `"keywords":[]` on three hundred cards is four kilobytes — and `unpackView` puts it back
under a condition that read "a battlefield card whose definition travelled". Morph broke it twice
over: a face-down permanent has characteristics and **no** definition, and a face-down spell has
them while it is still on the stack. The whole-game round-trip assertion in `playout.test.ts` caught
it on the first game, twice — the second time because `power` looked like a tidier signal than the
zone and is not, since a land has keywords and no power. The condition now reads exactly the one
`redact` uses to decide whether to compute characteristics at all, which is the only version of it
that cannot drift, and there is a test beside the morph tests as well as the one in the playout.

**Measured, and the honest split.** Over 168 games on two seed sets the bot cast **20 of 23 Dirgur
Nemesis face down (87%) and 4 of 7 (57%)**, and **8 of 18 Battering Craghorn (44%) and 6 of 18
(33%)** — the mechanic is used, and used more by the card whose printed cost is further out of
reach, which is the right shape. The number that matters more is the follow-through, and it is
lower: **4 of 20 face-down Nemesis were turned up, and 3 of 8 Craghorn**. A 2/2 that stays down is
three mana spent on a card the bot forgot about, and the reason is the one this file keeps coming
back to — `simulate` stops when the stack empties, so "turn it up and win the combat" is past the
horizon unless the combat is already happening. It needed no teaching to use morph at all; what it
cannot do is price the moment.

**The slot changes are a wash, as the convoke ones were.** Tidal Mind with the two morph cards
against Tidal Mind without them: **77-161 vs 75-163** on one seed set and **84-153 vs 73-165** on
the other — +2 and +11 in 238, positive on both and under the eighteen-game noise floor on either.
Ashen Rite with Battering Craghorn against without: **114-124 vs 112-126** and **115-123 vs
112-126**, +2 and +3. The per-opponent split is where the games are: +6 against Rot Harvest on one
set, +7 against Ashen Rite and +5 against Forge Alliance on the other, and nothing at all against
Ember Rush or Verdant Guard either time. A cheap blocker that becomes a wall is worth games against
the decks a control deck can beat and nothing against the ones that are faster than it.

**One rule was written and reverted.** Play a land with morph last of all, because a Zoetic Cavern
spent as a land while an Island is in hand throws a choice away for nothing. The reasoning is sound;
the measurement is three casts in 336 games — face-down Cavern casts went from 1 to 2 on one seed
set and 3 to 4 on the other. That is not a change this instrument can price, so the branch came out
of `botAction` and the number is here instead, which is what D108 and D118 established the habit
for. The cause is upstream of any tie-break anyway: the land drop is taken *before* the search,
because leaving it in lost every game in the measurement, so the bot never weighs the Cavern's two
halves against each other. **Zoetic Cavern's face-down half is a person's option rather than the
computer's**, and that is worth knowing about the card rather than hiding.

**What is not built.** A "when this is turned face up" trigger, which is what the morphs with text
on the back need — Ainok Survivalist, Master of Pearls, Willbender. The hook has an obvious home
(`raise` with a new event kind, off `turnUp`) and no card in the pool wants it yet, so it is not
there: three cards whose face-up side is keywords prove the mechanic without it. Megamorph, and a
morph cost that is not mana (Zombie Cutthroat pays three life), are the same answer.

**One more thing was drawn, and it had been missing since before morph.** A face-down permanent
rendered as a plain card back: no power, no toughness, no counters. That was right while the only
face-down cards were somebody's hidden hand, and wrong the moment one sat on the battlefield — the
opponent is entitled to read the 2/2, and a +1/+1 counter on it was invisible. `CardFace` now draws
both on the back, and the aria-label says "Face-down creature, 2/2" rather than "Face-down card"
wherever the engine computed characteristics. Checked in a real browser rather than only in the
view payload: five checks in the tabletop suite turn a permanent over and assert that its own player
keeps the name, the other player gets none, the other player reads **2/2**, the card underneath is
nowhere on their board, and turning it back up tells them what it was. The first version of that
leak check asserted over the whole page and failed on **the log** — "Nick moved Shock to Nick's
battlefield", a public move that happened before the card was turned over. The log is right and the
check was wrong, which is the same lesson the engine's own leak test learned two entries ago.

## D124 — The turned-face-up trigger, and the number it moved

Morph's one missing hook, and the entry it belongs beside is D123's last paragraph, which said what
it would be for: the morphs with text on the back. `turned-face-up` is a new trigger event raised
from `turnUp` with the permanent as its subject, in the `selfOnly` set beside `becomes-tapped` and
`leaves`, and the two cards that wanted it are **Ainok Survivalist** (destroy target artifact or
enchantment an opponent controls) and **Master of Pearls** (creatures you control get +2/+2 until
end of turn).

**It had to be its own event, and that is the whole point of it.** A morph *enters* the battlefield
face down with no abilities at all, so an entry trigger has already come and gone by the time the
card is itself — and turning it up is not a new object (CR 702.37d), so an `etb` will not come round
again. The two are a pair of opposites worth saying out loud: an entry trigger on a morph fires
while the card has no abilities to fire it, and this one fires when the card gets them. A test
asserts both halves on one card.

**Raised before `settle`, which is what gives the opponent their one window.** Turning a permanent
face up uses no stack and cannot be answered — but what it *triggers* goes on the stack like
anything else, and both players get priority at it. So the unanswerable half of morph is the
reveal and the answerable half is the effect, which is the right way round: a Master of Pearls
turned up after blockers cannot be stopped from being a 4/4, and the +2/+2 can be countered.

**"An opponent controls" is load-bearing, not flavour.** The Ainok's trigger is mandatory, so
without that clause a morph turned up on an otherwise empty board would have to destroy its own
controller's Sol Ring. With it, a trigger that finds no legal target never reaches the stack
(CR 603.3d) and turning the card up for the body alone stays a legal and sometimes correct play —
which is its own test.

**The prediction, and it held.** D123 recorded that the bot turns up only 15–50% of the morphs it
casts face down, because `simulate` stops when the stack empties and "turn it up and win the
combat" is past that horizon. A trigger is immediate value the search *can* see, so the prediction
was that these two would be turned up far more often. Over 168 games on each of two seed sets:

```
                      cast face down    turned back up
Ainok Survivalist      16/17, 8/9        16 of 16, 8 of 8   (100%, 100%)
Master of Pearls        9/17, 17/19       4 of 9, 13 of 17  (44%, 76%)
Dirgur Nemesis         20/24, 4/6         3 of 20, 1 of 4   (15%, 25%)
Battering Craghorn      8/18, 6/18        4 of 8, 2 of 6    (50%, 33%)
```

**Every single Ainok Survivalist the bot ever turned down, it turned back up** — 24 of 24 across
both sets, about one turn later (mean turn 11.2 down, 12.5 up: the next turn's mana). The two cards
with text are the two the bot uses properly, and the mechanism is exactly the one D123 named. That
is the most useful thing in this entry: it is not that the bot got better, it is that **a mechanic
the one-ply search cannot price became one it can, by giving the moment an effect**.

**The slot changes measure as nothing, with consistent signs worth writing down rather than
rounding away.** Skyward Writ with Master of Pearls against Skyward Writ with a second Soul Warden:
**106-132 vs 104-134** and **86-151 vs 77-160** — up 2 and up 9 in 238. Verdant Guard with Ainok
Survivalist against the same trade: **151-87 vs 155-83** and **141-97 vs 145-93** — down 4, and
down 4 again. Both are a fraction of the eighteen-game noise floor, so neither is a result; but one
is consistently up and the other consistently down, and the second has a mechanism.

**Why the Ainok is slightly down, which is a fact about the bot and not the card.** It casts it face
down **94% and 89%** of the time — a {1}{G} 2/1 paid for with {3}, a mana wasted every single time,
and then {1}{G} again to turn it up. The search prefers the face-down cast because a face-down 2/2
scores above a 2/1 and **unspent mana scores as nothing at all**, which is the term D119 re-asked on
the fixed search and measured as exactly level. So the blind spot is known, already measured, and
not worth another attempt: a person holding this card casts it face up when they want the body and
face down when they want the surprise, and the bot only knows one of those two reasons. The card
stays, because the mechanic is what it is in the deck for and the cost of the bot misplaying it is a
quarter of the noise floor.

## D125 — Vehicles, the ninth of the family, and a deck placement the instrument refused twice

A Vehicle is an artifact that is not a creature at all until somebody crews it, and almost none of
that needed new code. `isCreature` comes off the type line, so attacking, blocking, a sweeper's
"destroy all creatures" and a Doom Blade's target filter all already say no. Crewing is layer 4 —
`addTypes: ['Creature']` until end of turn — which D93 built for a land that becomes a creature, and
with no `setPower` because the body is printed on the card. What that buys for free: a Vehicle cast
this turn is summoning-sick when crewed, it stops being a creature at end of turn and stays on the
battlefield, and one that dies is an artifact in the graveyard.

**Crew is the third cost here that is not mana, and the second paid by tapping somebody else's
permanent.** `crewPlan` is convoke's sibling and is built the same way for the same reason: one
planner, called by `activatablePlays` to decide whether to offer the crew and by `activate` as it
pays, so the offer and the payment cannot disagree. Two rules travel with the cost rather than being
asked for separately — summoning sickness does not stop a creature crewing (tapping it is a cost
being paid, not a {T} ability it is activating), and the Vehicle itself stays untapped, which is the
whole point because it is about to attack.

**Smallest creatures first, which is the opposite of what reads naturally.** "Any number with total
power N or greater" could always be satisfied by tapping the biggest creature on the board, and that
is the worst choice available: a tapped creature cannot attack, so the one you want left standing is
the big one. The cost of the greedy rule is that it sometimes taps one creature more than it had to
— three bodies totalling five power to crew a 4, which a subset search would have done in two. A
test pins both halves: crew 2 off two 1/1s and a 4/4 taps the 1/1s, and crew 4 off the same board
taps all three because the small ones cannot reach it.

**The ninth member of the "spent on nothing" family, and the first that is arithmetic.**
`animationCouldMatter` already stopped the bot animating with nothing to attack or block, and it
covers crew unchanged. What it cannot see is the *price*: after a crew the Vehicle genuinely is a
creature, so `simulate` scores one more attacker and nothing at all for the creatures now lying
sideways. `crewBuysMoreThanItCosts` compares the Vehicle's power with the total power of the
creatures the plan would tap — **counting only the ones that could have attacked**, which is what
makes it a fact about the board rather than a weight: a creature that arrived this turn was not
going into this combat anyway, so tapping it is free, and a 7/11 crewed by summoning-sick bodies is
the best thing that can happen to a deck that has just emptied its hand.

**The instrument refused the first deck placement, twice.** All three Vehicles in Rot Harvest, whose
board is the widest in the pool and whose creatures it is happy to lose, measured **88-149 against
95-141** and **77-161 against 97-141** — down 7 and down 20 in 238, the second of those past the
eighteen-game noise floor. The crew rule above recovered 3 and 5 of those games and left the change
still negative. The mechanism is the obvious one in hindsight: Rot Harvest's plan is to attack and
trade with its creatures, and crew taps them.

**The placement that measures as a wash puts each Vehicle where its ratio works.** Consulate
Dreadnought stayed in Rot Harvest, because seven power of attack for four power of tapping is the
best ratio in the pool and no other deck can reach crew 4 at all: **85-151 against 93-143** and
**98-140 against 98-140** — down 8, and then exactly level. Sky Skiff and Renegade Freighter went to
Forge Alliance, whose creatures are 1/1 Soldier tokens: **150-88 against 141-97** and **161-77
against 161-77** — up 9, and exactly level. Both decks now sit inside the noise floor, which is what
the first arrangement did not, and the lesson is not about Vehicles: **a cost paid in creatures is
priced by what those creatures were going to do**, so the same three cards are a wash in one list
and twenty games in another.

**What the table had to learn to show.** `VisibleCard` now carries `isCreature`, because the two
questions "has power printed on it" and "is a creature right now" part company in exactly two places
and a client cannot derive either: a Vehicle has a printed 7/11 and is not a creature, and a
Mutavault is a creature with no printed power at all. The table read the first as the second, so
during declare-attackers it told a player their uncrewed Vehicle was **not ready** — the wrong answer
to a question nobody asked. It now says **not crewed**, and the Mutavault has been quietly wrong in
the same place since it was scripted.

## D126 — Sagas, and three pieces of machinery for a permanent with a life of its own

The first permanent in this pool whose whole shape is that it says three different things on three
different turns and then is gone. Everything else here is one of four things: an entry trigger that
fires at a moment, an activated ability a player presses, a static that is simply true, or a
continuous effect that expires. A Saga is a permanent that **keeps a count**, and what each number
means is printed on it (CR 714).

**Three pieces, and each is a different kind of thing.** A *turn-based action* adds the lore
counter as the controller's precombat main phase begins, in `onEnterStep` beside the untap and the
draw — not a trigger, because nothing can be done in response to the counter going on. A *triggered
ability* keyed to the counter reaching a number is the chapter, which goes on the stack and can be
answered like anything else. And a *state-based action* sacrifices the Saga once its last chapter
has gone. Three mechanisms for one card, and writing any of them as another would have been wrong
in a way a player would notice.

**`saga: true` is the only new field, and the chapters are ordinary triggers.** `on: { kind:
'chapter', n }` means they get the stack, targets and mid-resolution questions for free — chapter
III of The Birth of Meletis asks for a Plains and chapter III of The Eldest Reborn targets a
graveyard, both through machinery that already existed. The number of chapters is **derived** from
the triggers by `sagaChapters` rather than declared beside them: a `chapters: 3` field sitting next
to three chapter triggers is a field that eventually disagrees with them, and the consequence would
be a Saga that never leaves or one that leaves a turn early.

**The counter is the state, so nothing records which chapters have fired.** The number on the card
is the record, which is what makes three awkward cases free rather than special. A Saga that leaves
the battlefield stops counting, because there is no permanent to put a counter on. One that comes
back is a new object with no counters and starts at chapter I, which is the rule. And a face-down
Saga does nothing at all, because `scriptOf` already returns nothing for a face-down permanent.

**The sacrifice checks the counters and an empty stack, not whether an ability resolved.** That is
CR 714.4 and it is also the only version that behaves: a Saga whose last chapter is countered still
goes away. The stack check is the whole of the delay — the Saga sits on the battlefield while
chapter III waits, which is what lets a chapter that reads the board see the board the chapter is
about. A test pins the pair: at three counters with the chapter on the stack it is still there, and
after the chapter resolves it is in the graveyard.

**Chapter I fires on the turn the Saga is cast**, off the counter it enters with (CR 714.2a), which
is added in the arrivals loop in `settle` beside "enters tapped". That loop is the one place that
sees every way onto the battlefield, so a Saga put there by an effect rather than cast still starts
counting. Guarded on having no counter yet, which reads the board rather than remembering.

**Two cards, and the second is placed for a clause rather than for a colour.** The Birth of Meletis
({1}{W}: a 0/4 wall, two life, a Plains) went into Skyward Writ, whose plan is to survive to its
fliers. The Eldest Reborn ({4}{B}{B}: each opponent sacrifices, each opponent discards, then return
a creature from **any** graveyard) went into Hollow Tide, and the "any" is why: every other
reanimation in the pool reads *your* graveyard, and this is the mill deck finally able to spend the
pile its own Mind Sculpts filled.

**Measured, and both are a wash.** The Eldest Reborn against a second Wall of Air: **87-151 vs
88-150** and **93-145 vs 98-140** — down 1 and down 5 in 238. The Birth of Meletis against the same
trade: **105-133 vs 102-136** and **89-149 vs 88-150** — up 3 and up 1. All four a fraction of the
eighteen-game noise floor. What is not a wash is that they get cast: **The Eldest Reborn in 86% of
the games it reaches hand and The Birth of Meletis in 100%**, with no bot teaching at all — a Saga
asks nothing of the player after it is cast, which is the one kind of card this bot pilots perfectly.

## D127 — Foretell, and the measurement that said the cut matters more than the card

The fourth zone a spell is cast from here — after the hand, the command zone and the graveyard — and
the only one where the card is **hidden** while it waits. Foretell (CR 702.143) is {2} to exile a
card from hand face down during your own turn, and a smaller cost to cast it on any later turn.

**Two rules travel with the cost, and both are checked in one place.** It is taken during your own
turn, which in this engine is the window a sorcery gets; and a foretold card cannot be cast on the
turn it was foretold (CR 702.143b), which is the clause that stops foretell being a straight
discount on a spell you were casting anyway. The second needs the engine to remember something, and
`CardInstance.foretoldTurn` is the only new state the mechanic adds. It is also what tells a
foretold card apart from a creature a Banisher Priest took: both are face down in exile, and only
one of them is castable — and by its foreteller rather than its owner.

**Two mechanics want opposite things from one field.** `relocate` carries `faceDown` onto the stack
for morph's sake, and a foretold card must turn face up as it is cast — the moment the hiding ends.
One line in `castSpell` says which is which, and it has a test of its own, because a counterspell on
the stack that nobody could read would be a table nobody could play at.

**The bot was taught, and the teaching is the tenth of the "spent on nothing" family.** The gain
from a foretell is entirely in the future: `simulate` sees two mana spent and a card leaving hand
for nothing at all, so without a rule the search would never foretell, and with a *weight* it would
foretell on turn two instead of playing a creature. `foretellIsSpareMana` asks the board the
question the search cannot: is there anything else to do with the mana? Every play on the same card
is excluded, its own ordinary cast included, because casting it now is the thing being compared
against rather than a reason not to compare.

**Which the measurement then made interesting.** Over 56 games the bot foretold a **Saw It Coming
eight times and a Behold the Multiverse not once**, and the asymmetry is the cards rather than the
judgement: a counterspell has no sorcery-speed use, so on a turn with spare mana it is the only
thing to spend it on; a Behold the Multiverse is castable whenever there is mana for it, so there is
always something better to do with {2} than hide it. **Foretell helps this bot on exactly the card
the mechanic was printed for** — the one it otherwise has to hold mana for, which is the thing D108,
D110 and D119 all say it cannot do.

**And then the slot measurement said the hypothesis was wrong, twice.** Saw It Coming most resembles
Essence Scatter, so that was the first cut — and it cost Tidal Mind **13 and 8 games in 238** on two
seed sets, consistent in sign and at the noise floor. The mechanism is not subtle in hindsight: a
{1}{U} answer to a creature is worth more to the pool's slowest deck than a {1}{U}{U} answer to
anything, and six of the eight decks win with creatures. Trading the cheap answer away is the
opposite of what this deck's record asks for.

**Cutting the second Murder instead measures level: −1 and +7.** Same two cards added, same deck,
one different card removed, and a swing of about twelve games. That is the finding worth keeping
from this entry and it is not about foretell: **which card a slot change removes matters more than
which card it adds**, and the instrument will say so if asked separately. Both arrangements were
measured on both seed sets before either shipped, which is the only reason the first one did not.

**What the mechanic is for, which no measurement here can see.** An opponent is told there is a
face-down card in exile and nothing else, so foretelling an answer and foretelling a threat look
identical from across the table. This bot has no model of what an opponent knows and the rule above
is deliberately conservative about it — it will not foretell to hide a card, only to use mana that
was going spare. The hidden half belongs to the two people at the table.

## D128 — A ninth deck, and the eight records that moved without a card changing

**Decision: the pool's ninth deck is red-blue spells — the archetype where casting a spell is
itself the thing that advances the board — and it is assembled almost entirely out of a trigger the
engine has had since the first red deck.**

The gap in eight decks was never a colour pair. Six won by attacking with creatures, one by
attacking a library, one by draining a life total; the `spell-cast` trigger had nine readers and
every one of them was a card inside a deck that would have been fine without it. Arc Tempest is
twenty-five instants and sorceries, seven creatures that read them and twenty-one lands, and five
of its six new cards needed no new engine behaviour at all — Guttersnipe is Firebrand Archer at
twice the damage, Young Pyromancer is Talrand at a third of the cost, Gelectrode is
Thermo-Alchemist with a target, Stormchaser Mage is prowess on a hasty flier.

**Adeliz's pump is the one worth stating as a rule.** "Each Wizard you control" is narrower than
any scope `ContinuousEffect` has, and it needed none: `pump` takes a list of ids, so which
creatures are in the list is the card's own business. The subtype-scoped *static* effect ("Wizards
you control get +1/+1") could not be written at this point, and D129 is where it was — but a
one-shot pump that reads a subtype was never the same problem, and treating it as one would have
meant adding a scope for a card that did not need it.

**Enigma Drake is the engine work, and it is two additions rather than a mechanism.** The pool's
only previous characteristic-defining ability, Lhurgoyf, counts creature cards in *all* graveyards
and defines both halves of its size. The Drake counts instants and sorceries in *your* graveyard
and is printed with a star for power and a 4 for toughness. So `definesSize` gained a second count
(which meant passing the effect's controller into `cdaCount` — whose graveyards are counted is part
of what the card says, so it is read off the count kind rather than guessed) and an
`applies: 'power'` flag. Everything hard about a CDA was already solved: the count is read fresh on
every characteristic lookup, so the Drake grows as the deck fills its own graveyard and shrinks when
somebody exiles it, with no trigger, no event and nothing to invalidate.

**Where it landed, and what it did to everybody else.** 192 games against each of the eight,
`SEEDS=12 node scripts/measure/deck-table.mjs`:

```
 82%  157-35   ember-rush          beats    tidal-mind     19-5
 70%  134-58   forge-alliance               rot-harvest    16-8
 58%  112-80   verdant-guard                hollow-tide    13-11
 47%   90-102  arc-tempest   ←              ashen-rite     13-11
 45%   86-106  ashen-rite          loses to ember-rush      5-19
 44%   85-107  skyward-writ                 forge-alliance  5-19
 38%   72-120  hollow-tide                  verdant-guard   8-16
 36%   70-122  rot-harvest                  skyward-writ   11-13
 29%   56-136  tidal-mind
```

Fourth of nine, and the split is the deck's design read back: it beats everything slower than it and
loses to everything faster. The 5-19 against both one-drop decks is the bot's limitation showing for
the third time (D108, D110) — holding Counterspell up is half the plan against them, and a one-ply
search casts it the turn it can afford it.

**The finding worth keeping is in the other eight rows, none of which changed a card.** Skyward
Writ up five, Hollow Tide up two, Rot Harvest down three, Tidal Mind down six. All of it is Arc
Tempest's own record against each of them. This table has carried a caveat about exactly this since
D114 — a deck's percentage is a function of the whole rest of the field — illustrated until now by
Hollow Tide falling eight points between two runs. This is the cleaner demonstration: *nothing*
changed except the size of the field, and a quarter of the pool moved by three to six games.
**A deck-table percentage is a statement about a field, not about a deck**, and it should be re-read
rather than compared whenever the field changes size.

**No slot is dead, and the cast counts say which are closest.** `SUBJECT=arc-tempest
scripts/measure/cast-counts.mjs`, 128 games: the single Enigma Drake at 46% is the weakest, cast in
13 of the 28 games it reached hand, which is what a four-drop does in a deck whose curve stops at
three; then the two narrow counters at 61% and 62%. At the other end, Gelectrode was activated 144
times and Thermo-Alchemist 100, which is the untap-on-cast line doing the thing the deck is built
around, and Think Twice was cast 171 times from 88 games in hand, which is flashback doing the same.
The Drake stays at one copy rather than being cut: it is the deck's only threat that does not need
the rest of the deck to have resolved first, and 46% is a curve complaint rather than a dead card.
**One bug, and the browser suite found it.** `e2e-arena` has a check called "creatures on the
battlefield show a current power and toughness", and it read every `body-` element on the page —
hand included. A card in hand is *supposed* to show its printed body, so the check had been passing
on a false premise for as long as it had existed: every other card in the pool prints a number, so
reading the hand looked the same as reading the board. Enigma Drake prints a `*`, and the suite went
red the first time it was dealt one. The fix is in the check, not the card: scope the selector to
`zone-battlefield-*`. Verified non-vacuous rather than assumed — the narrowed selector was made to
print what it found, and it came back `["2/2","2/3","7/4"]`, the 7/4 being a Drake with seven spells
in its graveyard. This is the third check in this project that was wrong by being broader than its
own sentence, after the face-down leak check that read the game log and the crew test that asserted
the wrong arithmetic.


## D129 — A scope that reads a creature type, and three lords that each prove a different half

**Decision: `ContinuousEffect` gains `{ kind: 'controller-subtype', subtype, other }`, and the three
cards that justify it go in the three decks that sit between 36% and 45% rather than in the one the
mechanic would be strongest in.**

The hole was named three times before it was built, most recently in D128: the scope could say
"this card", "creatures you control", "other creatures you control" or "all creatures", so "other
Goblin creatures you control get +1/+1" — every tribal lord ever printed — could not be written.
Adeliz pumps Wizards without it, because a **one-shot** pump takes a list of ids and may filter
however the card likes. A static cannot: it is a declarative object written to Redis and sent down a
socket, so the filter has to be something the engine can perform from the stored scope.

**`other` is a field and not a second `kind`**, which is the one design choice worth stating. The
existing pair distinguishes "creatures you control" from "other creatures you control" by having two
`kind`s, and copying that here would have meant four tags for one idea. A scope carrying a `subtype`
already has to be *read* rather than matched, so one more field on it costs nothing.

**Where the subtype is matched is the judgement call.** `effectApplies` has three callers and only
one of them — the main `characteristicsOf` loop — has a type line with layer 4 applied. The others
are the layer-4 pass itself, which cannot consume its own output, and `combatDamagePrevented`. Each
caller now passes the best line it has, so the match is CR 613.1d before 613.1f where it matters and
the printed line where nothing in the pool cares. The ordering has a test built on a hand-made
`addSubtypes` effect, because no card in the pool adds a creature type yet and the ordering is free
to get right now and expensive to discover later.

**Three cards, because the three halves are separate.** A size (all three), a **keyword** (first
strike on Stromkirk Captain, indestructible on Knight Exemplar), and following the board rather
than a list — Imperious Perfect taps for Elf Warrior tokens, so it grows its own scope with no
event saying a new Elf exists, and a second copy pumps the first while neither pumps itself. Knight
Exemplar is the one that tests the duration: a Knight carrying three damage lives because it is a
3/3 and indestructible, and dies the instant the Exemplar leaves, because a `permanent` effect
exists exactly while its source is on the battlefield.

**Goblin Chieftain is deliberately not written, and that is the balance decision.** Ember Rush is
the only deck with Goblins, Krenko makes more of them every turn, and Ember Rush already wins 82% of
its games. Proving a scope is worth a card; handing the strongest deck in the field its best
possible upgrade is not. The alternative — writing the card and putting it somewhere it does
nothing — is worse than leaving it out, because a card in a deck that cannot use it is the dead
slot D119 was about.

**What the three measure as**, each a single slot swap on both seed sets, 240 games a side, with
the deck *holding* the lord listed first:

```
Stromkirk Captain  for the 2nd Dark Ritual   122-117 v 123-116      118-122 v 117-123    level
Knight Exemplar    for the Divination        107-133 v 102-138      105-135 v  99-141    +5, +6
Imperious Perfect  for the Blossoming Def.    99-138 v  97-142      103-137 v 111-127    +2, -8
```

The Captain is as close to nothing as this instrument reports — one game each way. The Exemplar is
consistent in sign on both sets and still well under the eighteen-game floor, so it is not priced
either; it ships because it is the card that tests keyword-granting, not because of the five games.
The Perfect came back with opposite signs, which by this log's own rule means it has not been
measured, it has been sampled twice.
**And then the Perfect's own cut was re-asked, which is D127's rule earning its place a second
time.** The arrangement above has the lord replacing the Blossoming Defense. Taking the **third
Blood Artist** instead, and keeping the trick, measures **+4 and +13** against it on the two seed
sets — consistent in sign, with one of them at the floor. So that is what shipped. The mechanism is
not subtle once seen: three Blood Artists is one more than a deck needs to find one, while the
Blossoming Defense is the only card in that list that answers a removal spell. Same card added,
same deck, one different card removed, and a swing of roughly fifteen games — which is the second
time that has happened in three entries. **Measuring the cut is not an optional extra step; it is
half of what a slot change is.**

**The full table says the same thing, and says it more sharply.** Re-run over all nine decks (192
games each), the only record that moved is Rot Harvest's — up five, which is the deck whose cut was
re-asked. Ashen Rite came back 86-106 and Skyward Writ 85-107, identical totals to the run before
the lords went in. That is a coincidence rather than a card doing nothing: half a dozen of their
individual matchups moved by a game or two each and the sums happened to land on the same numbers.
It is worth stating precisely, because "the total did not change" and "nothing changed" are
different claims and only the first one is true.



## D130 — Megamorph is a flag and not a trigger, and a morph cost stops being a string

**Decision: the morph turn-up cost becomes an `AbilityCost` rather than a mana string, and
megamorph's +1/+1 counter is applied inside `turnUp` rather than by a `turned-face-up` trigger.**

The first half is a shortcut being paid off. CR 702.37a lets a card print whatever it likes for
turning itself up; the pool's first five morphs all printed mana; so the cost was held as a `string`
and that read as a design right up until **Zombie Cutthroat**, whose cost is "pay 3 life" and no
mana at all. Reusing `AbilityCost` — the type an activated ability's cost already uses — rather than
growing a second vocabulary brought the life clause's own rule along for nothing: a cost you cannot
pay is not a cost you may choose to pay (CR 118.4), so at three life the turn-up is not offered, the
same way a Mana Confluence's mana is not offered at one. Only `mana` and `life` are paid and the
type says so out loud, because a `tap` on a turn-up cost would be a card that does not exist and a
script that asked for one should get nothing rather than an approximation.

**The second half is the one worth arguing.** Megamorph (CR 702.37c) is "and put a +1/+1 counter on
it", and the engine already had the obvious hook: `turned-face-up`, with two cards using it. Using
it here would be wrong, and wrong in a way that only shows up in play. A triggered ability goes on
the stack, so it would hand the opponent a window between *it is face up* and *it is bigger* — a
window to kill a 2/1 in response to its own +1/+1 counter. The whole reason morph is worth holding
is that turning a permanent face up cannot be answered, so the counter is three lines in `turnUp`
and both halves resolve before anybody has priority again. **A mechanic's timing is part of the
mechanic; implementing it with the nearest available hook is how that gets lost.**

**Both slots measure level**, 240 games a side on each seed set, deck holding the new card first:

```
Zombie Cutthroat     for the 2nd Bone Splinters, Ashen Rite    125-115 v 122-118   120-120 v 120-120
Hidden Dragonslayer  for the Air Elemental, Skyward Writ       107-133 v  98-142   101-139 v 101-139
```

+3 and 0, then +9 and 0. Non-negative on both sets, under the eighteen-game floor on both, so
neither is priced; both ship because they are the cards the mechanics needed.

**The number worth keeping is from `morph-use.mjs`.** Of seven morphs, Zombie Cutthroat is the only
one with a **100% follow-through — 10 of 10 turned up** — and its mean turn face down and mean turn
*turned up* are the same number, 6.8. The cost is why: every other morph has to find mana on a later
turn, and life can be paid on the turn the 2/2 lands. It needed no bot rule at all, because three
life is a thing `evaluate` can already see — which is the first time a new cost in this engine has
cost the bot nothing to learn.

**Two bugs, both found by the change rather than by a test.**

`morph-use.mjs` printed the morph cost into its own header, so every line read
`morph [object Object]` the moment the cost stopped being a string. It goes through the engine's
`morphCostText` now, the same formatter the offer uses, so the harness and the table cannot disagree
about what a card costs.

**The full table moved the way the probes said, and moved two decks that did not change.** After
both slots: Skyward Writ up eight (44% to 48%) and Ashen Rite up three, which is each card in the
direction its own probe gave. Verdant Guard is down five and Forge Alliance down two with no card
of theirs touched — they are the two decks that beat Skyward Writ most often, and a stronger
Skyward Writ takes those games off them (18-6 became 16-8; 17-7 became 15-9). D128's rule about a
deck-table percentage being a statement about a field now has an example *inside a single run*
rather than across two.

**One CI failure in this stretch, and it is recorded here because it was not fixed.** The run on
the lords commit failed `legacy-postgres` with 25 of 26 tests passing; the next run of the same job,
on a superset of that code, passed. The commit touched the rules engine, apps/web and docs and not
`server.js`, `db.js` or `test/`, so it cannot have caused it, and the suite passes ten times out of
ten locally — including six runs in parallel, which is the closest thing here to a loaded CI runner.

**Which test failed is still unknown, and that is the actual finding.** The job log is reachable only
through the GitHub tool's *tail*, the failing test was early in a 26-test file, and the signed blob
URL that would give the whole log is blocked by this environment's egress proxy. So the one thing
worth changing was changed: every `node --test` script now runs the **spec reporter**, which prints
a `✖ failing tests:` block with the name and the assertion at the *end* of the output. A tail is
enough next time.

**And the lead that looked obvious was a dead end, which is worth writing down so nobody follows
it.** The Postgres container log is full of `column "id" does not exist` and one `duplicate key
value violates unique constraint "players_pkey"`, and both are *handled*: `db.js`'s `run()` appends
`RETURNING id` to every INSERT and retries without it when the table has no `id` column, and
`seedAdminAccount()` is wrapped in its own try/catch. A service container's error log is the
database's record of every statement that failed, not a record of anything the program minded. Half
an hour went into that log before the code said so.



And a test that had been passing on a false premise: "will not cast a ritual with nothing to spend
it on" built its board with `position(['Dark Ritual'], ['Swamp'], [], 'ashen-rite')` and asserted
the bot passes. `arena` fast-forwards the turn counter with real `turn:pass` actions, so every draw
step on the way has happened and the hand holds whatever the shuffle gave it beside the named card —
and the test was true only because nothing ashen-rite happened to draw cost three or less. Putting a
morph in that deck made a face-down 2/2 for {3} castable off the ritual's own mana, which is **the
rule working**, and the test called it a regression. The hand is now emptied explicitly down to the
one card the premise names. A test whose setup is "and whatever else turned up" cannot tell a
regression from the feature it is testing.

## D131 — Redirection, and the deck whose record this instrument cannot read

**Decision: `retarget` lives in `targeting.ts` beside the legality rules, the second target is
declared wider than the spell's own spec on purpose, and Willbender ships for spells only with the
ability half named rather than approximated.**

The last item on the engine doc's "Next" list that was neither blocked nor open-ended, and a
different kind of work from everything before it: every other effect in this engine reads the board
and changes the board, while this one reaches into an object already on the stack and alters a
choice its controller made.

Three rules travel with it, all CR 114.6: the new target must be legal **for that spell**, judged
with the spell's own controller as the chooser; it must be a *different* target; and if either fails
**nothing happens** — the spell keeps the target it had (CR 115.7b), rather than erroring or being
countered.

**The second target is `any`, which is wider than the spell's own spec, and that is the design.**
Both cards ask for two targets — the spell, and where it is going — which nothing in the pool had
done before. A player may therefore point a Doom Blade at a player: the engine accepts the choice
and `retarget` declines to make the change. Narrowing the second spec to the first target's spec
would have been possible and would have been wrong, because the rule that governs this is CR 115.7b
and not target legality, and a card that refused the *choice* would be telling the player something
the rules do not say.

**What is narrowed instead is which spells may be named**, so the offer and the effect cannot
disagree — the rule convoke, crew and morph are all built on. `soleTargetSpecOf` returns `null` for
an ability, for a spell with no targets or several, and for a modal spell whose targets belong to the
mode rather than the card; and the filter additionally requires **somewhere else to send it**, at
least one legal target other than the one the spell already has. A Flame Slash aimed at the only
creature on the table is not a Swerve target at all.

**Spells, and not abilities, with the reason recorded.** Willbender is printed "target spell *or
ability* with a single target". A `Target` is a card or a player; a spell on the stack is a card,
while a triggered or activated ability has a synthetic id and no card anywhere — so the ability half
needs a third `Target` shape threaded through some thirty call sites, for one clause. Said out loud
rather than silently approximated, which is the decision the magecraft cards' "or copy" half got,
and **Move by hand** covers it meanwhile.

**The bot needed no rule at all, and the number is the argument.** `morph-use.mjs` over 432 games:
Willbender cast 27 times, 85% face down, **turned up 17 of 23 (74%)** — second only to the Zombie
Cutthroat. That is sharper than it reads, because turning a Willbender up makes it *smaller*: a
face-down 2/2 becomes a 1/1, so the only reason to do it is the redirect, and the trigger only
exists when a redirect is available. The one-ply search can see what the redirected spell does, so
the legality clause did the teaching.

**The finding worth keeping is a limit on the instrument, not on the card.** Willbender for the Dive
Down measured **+11 and −10** across the two seed sets — opposite signs, so unmeasured by this log's
own rule. Re-asking the cut per D127 gave **+5 and −2** for taking the Behold the Multiverse
instead: also opposite signs. Three results, none with a consistent direction, all inside the floor.

Why becomes clear from the arms themselves. The *unchanged* Tidal Mind list came back 69-170 and
71-169 on the two sets, two games apart — while its one-card variants came back 58-182 and 81-159, a
**23-game spread for a single slot**. The deck at the bottom of the table has the least reliable
record in the pool, and not by accident: a deck that wins 29% of its games wins most of those
narrowly, so one card moves more of them in both directions. **The eighteen-game noise floor was
established on the pool's average deck and is too generous for its worst one.** Nothing here fixes
that; the honest move was to ship the arrangement that was already in place, write the number down
as unknown, and stop pretending a sign that flips is a result. Swerve, in a deck at 46%, measured
+1 and −2 — a clean wash, the way almost every slot in that band has.

## D132 — A lobby you can see, and a default that is a privacy decision

**Decision: the Play Realm lists open tables, a table is unlisted unless its host says otherwise,
and the default is enforced on the server rather than trusted to the client.**

The setup doc's *What is not done* said "no way to watch a *list* of tables: you need the code", and
half of that was wrong in the easy direction: `apps/realtime` has had a `pod:list` event, a
`visibility: 'public' | 'private'` field and a Redis set of listed codes since the pod store was
written. Nothing in `apps/web` had ever called it. So this is almost entirely a client change, and
the interesting part is the one decision in it.

**Unlisted by default.** Creating a table offers *Just us* (shared by code only) and *Open table*
(listed for anyone), and the first is selected. A shared server that listed every table as it was
made would show strangers each other's games, and nobody choosing a default in a lobby is thinking
about that — so the lobby makes the choice rather than the player, and the labels say which is
which rather than leaving it to a doc nobody has open.

**And the default is asserted where it is enforced.** The client sending `visibility: 'private'` is
not the guarantee; `listPublic` returning nothing for a private table is. `apps/realtime` gained a
test that makes a public table and a private one in the same breath and watches a third client get
exactly one of them back. A privacy default whose only proof is in the code that chooses it is a
privacy default one refactor from being wrong.

**Three things beyond rendering rows**, each of which is why this is more than a button:

- The **empty state is the normal one**. Two people playing privately see no tables, so the lobby
  has to read well that way round and the code box has to stay the obvious way in. The browser
  suite asserts the empty state *before* anything is created, which is the order a first-time
  player meets it in.
- A row can be **stale** — a table that filled up or started between the render and the tap. The
  server refuses the join and the existing error banner says so, which is better than a client that
  pretends to check first and still races.
- A listed table's name and code come from **other people**, so they go through React as text and
  never as markup, and a listing reveals nothing a watcher could not already see with the code.

**The browser suite is where this is really tested**, because the decision is a flow rather than a
function: Friend now finds Nick's table *without being told the code* and joins from the row, with a
Refresh press as the retry for a socket that connected in the instant before the table existed. The
code path keeps its coverage in `e2e-arena` (join and watch) and `e2e-pod`. 59 checks became 62.

What is still missing in that paragraph of the doc, now that the list exists, is spectator chat: a
watcher reads the table's chat and cannot write to it. The doc says that instead of the thing that
was already built.

## D133 — The creature the event was about, the clause that is asked twice, and a cut worth seventeen games

**Decision: the three events that are about one permanent now carry *which* permanent, a trigger
may carry an intervening-if clause checked at both of the two times the rules check it, and exalted
and evolve are the two cards that needed each.**

Before this, every board-watching trigger in the engine could only talk about itself or about a
player. `etb`, `dies` and `attacks` each carried `subjectSeat` — *whose* creature entered, died or
attacked — and `subjectIsCreature`, and neither of them is *which*. That is enough for a Blood
Artist and not enough for an entire shape of printed card:

- **Exalted** (CR 702.90): "whenever a creature you control attacks alone, **that creature** gets
  +1/+1 until end of turn."
- **Evolve** (CR 702.100): "whenever a creature enters the battlefield under your control, **if
  that creature** has greater power or toughness than this creature, put a +1/+1 counter on this
  creature."

So `raise` now writes the subject's instance id onto the event, `pushAbility` carries it onto the
stack object, and `EffectContext.subject` is where a script reads it. It travels exactly the way
`attacked` and `answering` already do, and for exactly the same reason both of those exist: the
event is gone by the time anything reads it, and the board no longer says what happened. The three
of them became one `TriggerAbout` parameter rather than a third optional argument in a row — three
optionals positionally is one call site away from a bug nothing catches.

**`alone` is on the event, not derived on resolution.** "Attacks alone" is a fact about the
*declaration*: by the time an exalted trigger resolves, a second attacker may have been removed from
combat and the board reads identically either way. `auto:attack` knows the answer (`attacks.length
=== 1`) and writes it down.

**The intervening-if clause is a rule, and it is two checks.** `TriggerDef.condition` is asked once
before the ability would go on the stack and again as it resolves (CR 603.4), and a false answer
either time means the ability does nothing at all. Both halves are observable at a table and both
have a test:

- The **first** ask is why a Raptor that is already the biggest thing you control puts *nothing* on
  the stack when a 1/1 arrives. Without it, every creature an evolve deck plays for the rest of the
  game adds an ability that resolves into nothing, which a player reads as the engine being broken.
- The **second** ask is why answering the creature answers the trigger: Unsummon the creature that
  caused it and the counter never arrives. This is the one that makes evolve *interactive* rather
  than a tempo tax, and both tests were confirmed load-bearing by disabling each check in turn and
  watching the matching assertion fail.

A condition is given the same `EffectContext` an effect is, so the condition and the effect read the
same board the same way. It is asked, not run: a condition that changed the game would be a
replacement effect wearing a trigger's clothes.

**And what this task actually measured: which card comes out is worth more than the card going in.**
Guardians of Akrasa went into Skyward Writ twice, with two different cuts, 240 paired duels against
the field each time, two seed sets each:

| the cut | seeds from 3300 | seeds from 8800 |
| --- | --- | --- |
| cutting the **Wall of Air** | 103-137 | 100-140 |
| cutting the **Negate** | **120-120** | **113-127** |
| the list before either | 103-137 | 97-143 |

The same new card is worth nothing in one arrangement (−2 and +1, inside the noise) and +17 and +16
in the other — on the same side both times and right at this instrument's eighteen-game floor. The
Wall of Air was the wrong cut because its *flying* was the redundant part, and this deck already
answers the air with two Fog Banks; the Negate was the right cut because it was the deck's
least-cast card at 55% and what it answers is the half of the field Skyward Writ already beats.
D127 and D129 both said measuring the cut is half of what a slot change is. This is the third data
point and the loudest: two cuts, seventeen games, one card.

Cloudfin Raptor went into Hollow Tide for the second Psychic Strike and measured +3 and +4 — both
seed sets on the same side, both far inside the floor. Written down as what it is: the swap costs
that deck nothing, and nothing is all a new keyword's card has to cost. A card has to live
*somewhere* for the keyword to be playable at all, and "free" is the bar for that, not "better".

One thing the engine still does not have, and it is deliberate: a `condition` is checked for
triggers only. An activated ability whose "if" clause has stopped being true is a different rule
(CR 603.4 is about triggered abilities), and nothing in the pool wants it.

## D134 — An ability on the stack is a thing you can point at, and a `Target` grows a third shape

**Decision: `Target` gains `{ kind: 'ability', id }`, two `TargetSpec` kinds come with it, and
Willbender's printed "or ability" half works — which the comment in `scripts.ts` had been promising
to be wrong about.**

D131 wrote this down as the reason Willbender shipped half-finished: "a `Target` is a card or a
player, a spell on the stack *is* a card, and an ability has a synthetic id and no card anywhere —
so Willbender's printed 'or ability' half needs a third `Target` shape threaded through thirty call
sites for one clause." That estimate was wrong by an order of magnitude, and the way it was wrong is
the useful part.

**The union has seventy readers and five of them needed changing.** `tsc` found every one, because
almost every reader of a `Target` reaches for `.seat` on the non-card branch — and a third member
with no `seat` makes that a type error rather than a silent fall-through. The five were `targetKey`
and four copies of it in `bot.ts`, written as `t.kind === 'card' ? \`c${t.id}\` : \`p${t.seat}\``.
They are now one call to the shared `targetKey`, which is the fix those four should have had anyway:
"what makes two targets the same target" had five definitions in this repo, and a sixth in
`apps/web`. It now has one.

**What was left was four honest refusals**, and each of them is a sentence about what an ability is:

- it is in **no zone**, so "still on the stack" is the whole of its legality;
- it has no **`objectSeq`**, so it cannot be *a different object* the way a bounced creature is
  (CR 400.7) — it either is still there or it does not exist, and the fizzle check catches that
  through plain legality;
- it has no permanent to carry **hexproof, shroud, protection or ward**, so none of them touch it,
  and `raiseWard` skips it;
- it cannot be **damaged or shielded** (CR 120.3), so `dealDamage` and `preventDamage` refuse it at
  the top rather than falling through into the creature branch with an id that names nothing. That
  fall-through would have returned the same state by accident; the point of saying it is that the
  next person reading it cannot tell those apart.

One real correctness fix came out of it: `retarget` was passing the *stack object's* id as the
source for the legality check, which is right for a spell (a spell's id is its card) and wrong for
an ability (whose id names nothing in `instances`). Protection from black is a fact about the
permanent an ability came from, so it now resolves `object.source` for an ability.

**Three cards, because the shape has three uses.** `spell`, `ability` and `spell-or-ability` are
three kinds rather than a filter, and they are the printed difference between three cards:

- **Squelch** ({1}{U}, "counter target activated ability, draw a card") is the narrow one, and the
  first card in the pool whose spec puts a `filter` on an ability candidate: it reads the stack
  object's own `kind` to tell an activated ability from a triggered one.
- **Disallow** ({1}{U}{U}, "counter target spell, activated ability, or triggered ability") is the
  wide one and the argument for the third kind existing: a card that takes either should say so
  rather than hoping whatever it is handed has an `id`.
- **Willbender** now redirects either, which is what it says on the card.

What this adds to the pool is not a card but a *kind of answer*: everything here that answers a
permanent answers the permanent. A Doom Blade kills the Icy Manipulator and not the tap it already
activated; a Murder kills the Jace and not the loyalty ability above it. An ability on the stack is
independent of its source (CR 113.7a) and was, until now, the one object at this table that nothing
could touch. And the cost stays paid: countering an Icy Manipulator's tap does not untap the Icy
Manipulator, which is the half players get wrong and the engine gets right for free, because the
cost was paid to put the ability on the stack at all.

**And the cut mattered more than the card, for the fourth time.** Squelch went into Arc Tempest
twice, 240 paired duels against the field each, two seed sets:

| the arrangement | seeds from 3300 | seeds from 8800 |
| --- | --- | --- |
| no Squelch | 100-140 | 99-141 |
| Squelch for the **Divination** | 98-142 | 89-151 |
| Squelch for the **Essence Scatter** | **102-137** | **103-137** |

Worse both times with one cut and better both times with the other, four and fourteen games apart.
The reason is readable off the cards: the Divination is this deck's only refill and every one of its
four spell-payoff creatures gets paid for casting it, while the Essence Scatter was the redundant
answer — Arc Tempest beats the slow decks it could counter a creature from and loses to the fast
ones it cannot counter enough of. D133's corollary held again: both wrong cuts in this project have
removed a deck's *only* copy of something it needed, and both right ones removed something the deck
had another answer for.

Disallow went into Tidal Mind for *its* Essence Scatter and the instrument could not price it: +8
one seed set, −10 the other, no consistent sign. That is D131's finding restated — the deck at the
bottom of the table has the least reliable record in the pool — so it ships on the rules argument
("counter target creature spell" is a subset of what Disallow does) and the number is written down
as unknown. Between the two swaps the pool now has two Essence Scatters where it had four, which is
the one pool-level change here worth noticing.

**Still not done, and now it is the only thing on this list:** nothing copies an ability. "Copy
target activated or triggered ability" (a Strionic Resonator, a Lithoform Engine) needs the stack
object duplicated with its targets and its `subject`, which is a different piece of work from
pointing at one — and nothing in the pool wants it yet.

## D135 — The question whose answer is a word, and two cards that choose as they enter

**Decision: `DecisionSpec` becomes a union — the card question it already had, and a new one whose
answer is a word — and the card that asks it also answers it for the engine's own opponent.**

Every mid-resolution question this engine could ask was "choose some cards from a zone":
`pendingDecision` carried `candidates`, a `min`, a `max` and a `DecisionZone`, and `DecisionAnswer`
carried `ids`. That covers a search, a discard, a scry and a sacrifice, and it cannot express the
other half of what printed cards ask. "Choose a creature type." "Choose a colour." "Tap or untap."
"You may." None of those names an object, and the only yes-or-no the engine had was
`pendingPayment`, which is ward's special case with a mana cost attached.

**One shape for all of them, not a separate yes-or-no.** `ChoiceDecisionSpec` is `{ who, prompt,
options }`, and "you may" is a choice between two words. The table draws the same row of buttons
either way, a single mechanism is a single place for the rules about it to live, and a spec with
fewer than two options is answered by the engine rather than asked — the same rule that already
keeps a discard of two from a hand of two off the screen, because a prompt with one button is noise.

**The card answers its own question, for the bot.** `ChoiceDecisionSpec.best` is a function on the
spec, and it has to be there because only the card knows what its words *mean*: "Vampire" is a
creature type to count on a battlefield and "black" is a colour to fear in a graveyard, and nothing
generic can tell those two lists apart without guessing. Both implementations are board reads rather
than weights, which is the line the rest of this bot is held to — and `colourToFear` reads only
other seats' battlefields and graveyards, both public, because a bot that read their hands would be
answering a question no player can answer. The engine still checks the card's own hint against the
offered list before using it: a hint naming something that was not offered would be a refused action
and a stopped table.

**Both cards choose as they enter, and that is a rule rather than a detail.** A `decisions` list is
asked during the spell's own resolution — before the permanent is put onto the battlefield — which
is exactly what "as ~ enters the battlefield" means (CR 614.12). An entry *trigger* would be a
different card: it would go on the stack after the permanent arrived, both players would get
priority, and killing the Obelisk in that window would leave a creature type chosen and nothing
pumping it. The test says so directly: after the answer, the stack is empty, the Obelisk is on the
battlefield and the Elf is already a 3/3, all in one action.

The same resolution-order fact is why each card installs its own continuous effect from `onResolve`
rather than declaring a `statics` entry. A declared static is fixed and the engine installs it on
arrival; these two are not fixed until somebody answers, so the effect is built with the answer in
it. `duration: 'permanent'` means "while the source is on the battlefield", and state-based actions
— which are what purge an effect whose source has gone — do not run in the middle of a resolution,
so pushing it a moment early is safe. A test kills the Obelisk and watches the Elf go back to 1/1.

**Two cards:**

- **Obelisk of Urd** ({5}, convoke) in Rot Harvest. Three things the engine already had and one it
  did not: convoke pays for a five-mana artifact on turn three (D101), the `controller-subtype`
  scope performs the filter from a stored string so an Elf token made four turns later is pumped
  with nothing recomputed (D129), and `duration: 'permanent'` ends it when the Obelisk leaves. The
  choice is the new part and it is the whole card — the same artifact is an anthem for nine
  creatures in one deck and three in another.
- **Voice of All** ({3}{W} 2/2 flier) in Skyward Writ. The closed-set half: five options, so there
  is no approximation to admit to, and it makes protection's four rules (D83) worth having had.

**The honest deviation** is the Obelisk's option list. The card says "choose a creature type",
meaning any of several hundred; a table cannot draw several hundred buttons, so the list is the
thirteen types this pool actually contains in numbers — every one with eight or more copies. It is a
derived rule rather than a judged list, and it makes the same choices for the same reasons.

**The measurements, and one of them is a carry.** The Obelisk swap is +4 and −3 over 240 paired
duels on two seed sets: no consistent sign, far inside the floor, free. The Voice is −3 and −2 —
the same side both times, still inside the floor, and the cut was re-asked per D127 (a *Raise the
Alarm* instead gives −4 and −5, worse again). So the Serra Angel is the better cut and the card
itself costs about one per cent, carried on purpose: this is the one card in the pool where the gap
between a bot's answer and a person's *is* the card, since a player chooses the colour from the
matchup in front of them and the engine chooses it by counting what it can already see. D102 carries
the Samite Healer at five times the cost for a weaker reason.

**What this unlocks and nobody has written yet:** "you may", as a two-word choice; "tap or untap";
"choose one —" on a trigger rather than at cast time. All three are now a few declarative lines. The
one thing still missing from the family is a choice whose answer is a *number* — "choose a number",
"pay any amount of life" — which wants a range rather than a list and has no card in the pool asking
for it.

## D136 — A tenth deck, and the first time anybody measured what a commander is worth

**Decision: Dawn Tithe ships at 62% after a measured weakening, and `deck-probe` grew a
`COMMANDER` lever that answered a question every deck's write-up had been asserting unmeasured.**

Nine decks, and eight of them measured the game in damage while one measured it in cards. Not one
gained life on purpose — and `life-gained` has been a trigger event since the triggers were written,
with **exactly one card in the pool reading it**: an Ajani's Pridemate in a red-white deck that
gains life by accident. An engine path with one reader is a gap in the pool rather than in the
engine, which is the argument the ninth deck was built on too.

So Dawn Tithe, white-black, where the gain is an **input**: two creatures turn it into a body that
grows, two turn a death into both totals moving at once, and the removal spell gains two life while
it removes. Six new cards (Impassioned Orator, Bloodthirsty Aerialist, Cruel Celebrant, Revitalize,
Vraska's Contempt, Kambal) and an Orzhov Guildgate; everything else in the sixty was already here.

**One engine addition came with it, and it is the third of a family.** Kambal says "whenever an
opponent casts a noncreature spell, **that player** loses 2 life" — and `EffectContext` could say
which permanent an event happened to (`subject`, D134) and what an attack was aimed at (`attacked`)
but not *who did it*. `actor` is now on the stack object and the context, set from the event the
same way, and set only when it is somebody other than the watcher: a card that means its own
controller says `controller` and always could. In a two-player game the wrong reading — every
opponent — is indistinguishable from the right one, which is the kind of bug a four-seat pod finds
a year later, so the test is a four-seat pod where the seat that cast nothing pays nothing.

**The deck came in too strong, and the number said so before anybody's judgement did.** 66% against
the nine-deck field, second in the pool, winning the four slowest matchups between 19-5 and 22-2.
Two weakenings were measured over 270 paired duels each on two seed sets:

| the list | seeds from 3300 | seeds from 8800 |
| --- | --- | --- |
| as first written | 172-98 | 169-101 |
| −1 Aerialist, −1 Contempt | 157-113 | 162-108 |
| also −1 Exsanguinate | **158-112** | **155-115** |

The third row is the one that shipped: −14 and −14, the same on both sets, where the second row was
−15 and −7. What it costs is the deck's *inevitability* — Exsanguinate was the only card that ended
a game the deck was not already winning — and that is the intended loss rather than a side effect.
The card the archetype is built around is a one-of as a result, which is uncomfortable and is in the
deck list in those words.

**And the finding that was not the plan.** The hypothesis was that Kambal was the problem: a deck of
twenty-five noncreature spells losing 2 life a cast looks like a lock, and Arc Tempest was losing
22-2. So `deck-probe` gained a `COMMANDER` lever — point it at a legend whose text is *dead* in the
subject deck (Balan, Wandering Knight in a deck with no Equipment is a plain 2/2 double striker) and
the gap between the arms is what the real commander is worth.

**Kambal is worth −2 and −7 of 270.** Both inside the floor. Against Arc Tempest the arms are 23-7
and 21-9 with him and 23-7 and 22-8 without: the 22-2 was never the commander. Every deck in this
pool has a write-up calling its commander "the half a deck list cannot be", and the first time one
of them was measured it was worth at most two per cent. That is a claim this project has made nine
times and should stop making without a number — and the likely reason is dull: the commander tax,
four mana, and a bot that has sixty other cards to cast.

What is still lopsided is Dawn Tithe against Tidal Mind (22-2), Arc Tempest (20-4) and the two
grind decks (18-6 each). Those four are the bottom of the table against *everybody* — Ember Rush
beats Tidal Mind 23-1 — so the open problem is the bottom of the table, and D108 and D110 already
established that it is a pilot problem rather than a card problem.

**And one thing the browser suite caught that nothing else could.** A four-seat pod stalled on turn
110 with "Cleo stuck at Main phase 1" — a prompt nobody could answer. The cause was D135's own work:
Rot Harvest now holds an Obelisk of Urd, which asks a question whose answer is a *word*, and the
browser driver only knew how to answer a question by tapping a lit card. It found nothing lit and
reported the table as stuck, which is exactly what `every prompt the table shows can be answered`
exists to do — the check is three years of this project's convention in one line, and it is the only
thing in the repository that could have found this: 729 engine tests pass, because the engine is
right and the *table* had never been driven through that prompt.

So the driver learned to tap a `decide-option-` button, and the arena suite now reports it the way
it reports a modal spell: asserted when the shuffle produced one, noted when it did not. On
`DECK_A=rot-harvest DECK_B=skyward-writ` it produced one, and that run is the first time either of
D135's two cards has been answered through the real buttons by anything.

## D137 — The watcher who could always talk, and the label that was missing

**Decision: a watcher gets the chat drawer, sends its name when it starts watching, and the server
marks its line `watching` rather than leaving the table to work that out.**

The setup doc's last remaining gap in that paragraph — written at the end of D132 — said a watcher
"reads the table's chat and cannot write to it". That was wrong in the same easy direction D132's
own gap was wrong in: `pod:chat` calls `requireSeat`, and `requireSeat` asks only that the socket
is **in** a pod, which a watcher is. The server has accepted a spectator's chat since the day
watching was built. Nothing had ever sent one, because the watcher screen had no chat in it.

So there were two real defects, and neither was a permission:

- **The drawer was missing.** `Watching` rendered both boards, both graveyards, the stack and the
  log, and no way to say anything. The chat markup lived inline in the player's screen, so the fix
  started by extracting `ChatPanel.tsx` — one component now used on both screens, which is the
  only way the two stay the same thing as either changes.
- **The line read "Player".** With no seat and no name the server fell back to `'Player'`, which
  is exactly what one of the two people playing is called. A spectator's "I'm responding to that"
  read as an opponent's is a wrong move made in good faith — the worst kind to debug, because
  everybody involved did what the screen told them.

**The flag is set on the server, from the socket's own seat.** The client could have inferred it:
a line with `seat === null` is a watcher's, and the web already knows that. It does not, because
that would be a second answer to a question that has one, and the second answer is the one that
goes stale in a refactor. This is the same rule as D132's privacy default — *asserted where it is
enforced* — applied to a label instead of to a guarantee. `apps/realtime` gained a test that seats
one client, watches with another, has both talk, and checks that exactly one line comes back
marked.

**The name is optional and is not about the view.** `PodWatchInput` takes the name the lobby box
already holds, and a watcher who gives none talks as "Watcher" — which is at least not a player's
name. Nothing else about watching changed: no seat token is stored, no state is sent to the table
when somebody starts watching, and the spectator view is the same redacted view it has been since
D100. A watcher still cannot see a hand, still is offered no moves, and now a listing reveals
nothing a watcher could not already see with the code.

**And the browser suite is where this is really proven**, because it is a two-screen fact and no
unit test can hold two screens. In `e2e-arena` the watcher now fills its name, opens the drawer,
sends "good luck", and the *player's* screen is checked for the `chat-watching-` badge on that
line. The suite reports 55 of 55. The drawer is closed by clicking the backdrop at `{x: 5, y: 5}`
rather than by pressing the toggle again, because the toggle is behind the overlay — a detail worth
writing down only because it cost a timeout to learn.

One harness note that cost longer than the feature. The first run of that check showed the line
reading "Player" with no badge, with the handler change plainly in the file: the realtime server
running under `scripts/play.mjs` predated it. **Rebuild and restart the play stack before a browser
suite**, every time; a stale server fails in the shape of a bug in the code you just wrote.

## D138 — Damage divided as you choose, and the range that comes free of the amount

**Decision: a target spec may carry a quantity to be divided among its targets, the division is
announced with the spell and checked as a sum, and the table spends it one tap at a time.**

Everything in this pool that points at more than one thing does the same thing to each: Garruk
untaps two lands, Breath of Darigaaz deals one to everything. "Three damage divided as you choose
among one, two, or three targets" is a shape printed on dozens of cards — Arc Lightning, Chandra's
Pyrohelix, Forked Bolt, Fiery Confluence — and it was not expressible here at all, which is why the
engine doc's *Next* list has had "a choice whose answer is a number" on it since D135.

**The spec says it in three fields, and the fourth is a consequence rather than a field.**
`count: 3` is the most targets it may take, `optional: true` lets it be cast with fewer, and
`divided: 3` is the budget. "One, two, or three targets" then falls out of CR 601.2d: every chosen
target must be assigned at least one and the whole amount must be assigned, so zero targets cannot
spend three and a fourth target has nothing left to pay it. No `min` on `TargetSpec`, which is the
kind of field that gets added and then has to agree with a rule that was already deciding the
answer.

**Positional, not keyed.** `division[i]` is the share of `targets[i]`, on the action, on the stack
object and in the view. Keyed by target would survive the fizzle check on its own, and would also
mean that every reader — the wire, the table, the bot — had to learn what a target's key is to ask
a question about a number. Instead the one place that filters the list filters both: a target
dropped for being a different object (CR 400.7) takes its share out of the array in the same
expression, and `retarget` keeps the share of the slot it took over, which is what CR 114.6 says —
changing what a spell is pointed at does not re-divide it.

**What a lost target takes with it is its own share and nothing else (CR 608.2b).** Three damage
split two and one, with the two-damage creature bounced in response, deals one. It is *not*
redistributed onto what is left: a controller who could move it would be re-dividing after the
window to respond had closed, which is exactly the half of the card an Unsummon is answering. The
test is that Unsummon, cast in response, and the assertion is on the Squid in hand with no damage
on it rather than on the Rats that was dying either way.

**Four refusals, because a client can get this wrong in four ways**, and the one that matters most
is the total: a spell cast with two of its three damage assigned is a card that quietly did less
than it says. So `checkDivision` refuses a division on a spell that divides nothing, one that is
not one number per target, a share of zero or less, and a total that is not the amount. It also
refuses, honestly, a dividing spec on a card with more than one spec: every printed card that
divides something divides it among all of its targets, and a division that had to say *which* spec
it was about would be a guess the day something printed both.

**The bot gets three divisions and no judgement.** How to split three damage is the kind of
question this file has a rule about: read a fact, hand it to the search, do not carry a weight. So
`dividedAimings` builds three options from facts — all of it on the best target by the enemy-first
ranking; *lethal first*, walking the opponents' creatures and paying exactly what each costs to
kill while the budget lasts; and one each, as wide as the card allows — and `simulate` prices them.
The lethal-first aim is the one a heuristic would never find, because it is worth less by every
"biggest target" measure and kills two creatures. In 108 games the bot cast Arc Lightning in 88% of
the games it drew one (61 of 69), which is the top of that deck's list beside Magma Jet.

**And the table spends it a tap at a time.** A tap on a target the spell already points at adds
*another* point to it rather than dropping it, which is the whole interface: three damage split two
and one is three taps, and the spell is cast the moment the last point is spent. That costs the one
gesture every other prompt here uses for "I changed my mind", so the division gets a **Back** button
that peels one point back off, and no Cast button at all — a Cast on a half-spent division is a
button the engine would refuse, which is worse than no button. The bar shows what is left ("2 of 3
left") and what each target has so far, and the stack row shows the division to *both* players
(`Arc Lightning → Blood Artist (1), Monastery Swiftspear (2)`), because it is announced as the
spell is cast and is exactly what somebody deciding whether to answer it needs.

**The card measures as free, which is all a new card has to be.** 270 paired duels against the
field, two seed sets. Taking Arc Lightning back out for a second Shock is −9 and −1, so the card is
worth **+9 and +1** — same sign twice and both well inside the eighteen-game floor.

**The cut is unpriceable, so the cards decided it.** Cutting the Magma Jet instead measured −10 and
+1: no consistent sign, which is this instrument saying it cannot tell the two cuts apart. The
argument that shipped is the one the Squelch cut used (D134): the second Shock is the most redundant
card in a deck already holding twelve spells that point at a face, and Magma Jet's scry is the half
this deck is short of, since a deck that needs its one Guttersnipe needs to find it.

**One instrument gap found, and worked around rather than papered over.** `deck-probe` can only
*add* a card that already exists in some deck's list — `defNamed` looks through `STARTER_DECKS` —
so a brand-new card cannot be priced before it is slotted, which is the order every previous entry
did it in. The way round is exact rather than approximate: put the card in the list, then measure
**taking it out**, and negate the sign. Worth writing down because the README says a change "is
looked up anywhere in the pool", and the pool means the decks.

**And the browser caught nothing, which took three runs to establish.** The arena suite reports the
division when the shuffle produces one — Arc Lightning is a one-of, so that is a coin flip — and in
three runs it did not come up. Rather than call that covered, the UI was driven directly in a solo
game until the card was drawn: the prompt counted 3 → 2 → 1 as targets were tapped, the second tap
on a target already picked added to it instead of dropping it, the cast went through on the last
point, and the spell resolved. The suites are 59/59, 56/56 and 55/55 on three arc-tempest pairings,
62/62 on the tabletop.

## D139 — Copying an ability, and the clause that is not offered

**Decision: an ability on the stack can be copied (CR 706.10), the copy carries everything that
made the original mean something, and the printed "you may choose new targets for the copy" is
declined rather than approximated.**

The last item on the engine doc's own *Next* list, and it is the second half of a sentence D134
started. That entry made an ability on the stack a thing you can *point at*; this makes one a thing
you can *duplicate*, and the two are not neighbours. Countering removes an object. Copying builds a
second one — with the first one's targets, the first one's `subject`, the first one's `actor`, the
object it was answering, and now its division — and puts it **above** the original, so the copy
resolves first.

**It is a few fields rather than a call into the engine, and that is the design.** A copy is
*created* on the stack: nothing is cast, nothing is activated, no cost is paid, no cast or
activation trigger fires. So `copyAbilityOnStack` lives in `effects.ts` beside `counterSpell` and
reaches the stack directly, for the reason that function already gives — `automation.ts` imports
this module, and routing through it would only buy a cycle. The fields that travel are the ones
`resolveTop` reads to find the script (`source`, `cardKey`, `abilityIndex`) plus the four that say
what the original was *about*. A copy of "whenever that creature dies, you gain 1 life" that had
forgotten which creature would do nothing at all, which is exactly the bug D133's `subject` exists
to prevent, now inherited for free.

**A spell is refused rather than copied.** `kind === 'spell'` returns the state unchanged: copying a
spell makes a token copy or a new object with its own card, which is different work and a different
card — this pool already has a Cackling Counterpart for that.

**The clause that is not offered, said out loud.** Every printed card that does this reads "you may
choose new targets for the copy", and that half is not implemented: offering it needs a way to ask
for a target while something is resolving, which this engine does not have. Declining is always a
legal play of the card, so the deviation is a worse card rather than a wrong one — and it has a
visible consequence, which is why it is a **test** and not a comment. A copied Gravedigger trigger
is pointed at the card the original already returned; the copy resolves first and returns it, and
the original is then countered for having no legal target left (CR 608.2b, CR 400.7). One creature
back instead of two, which is precisely the case the printed clause exists to fix. The card's
oracle text in `starterDecks.ts` still says what the card says: a card that printed less than it
says would be a worse lie than a documented gap.

**Strionic Resonator goes into Rot Harvest, because that is the deck made of triggers** — a Zulaport
Cutthroat on every death, a Doomed Dissenter that leaves a Zombie, a Wall of Blossoms and a
Gravedigger and a Fleshbag Marauder and a Lotleth Giant as they arrive. The one filter the engine
had no card for is the card's own: an ability on the stack that is *triggered* and is *yours*. Both
halves are tested — an opponent's trigger is refused and is not even offered, and a Vampire
Aristocrat's activated ability waiting under its own death triggers is refused by name.

**It measures as nothing, and it is used.** Removing it is +4 on one seed set and −2 on the other
over 270 paired duels: no consistent sign, which is this instrument saying the card is free. The
half worth saying is the second one: in 108 games the bot cast the Resonator in 19 of the 20 games
it drew one and **activated it 14 times**, so this is a measurement of the card rather than of a
card nobody touched — the distinction D127 had to invent after measuring a slot nothing ever cast.
The cut is the second Basilisk Collar; cutting an Endless One instead measured −1 and −5, worse on
both sets.

**And the bot needed no teaching at all**, which is worth recording because the last four cards
each needed a line. The Resonator's ability is offered by `legalActions` only when there is a
trigger of its controller's on the stack — `hasAnyLegalTargets` does that with no card-specific
code — and the one-move search prices activating it like any other play. "A card that is a few
declarative lines" has been the claim in that doc for months; this is the first one that was
genuinely nothing but lines.

## D140 — Two more planeswalkers, and the reading the paired probe could not resolve

**Decision: the pool gets a third and fourth planeswalker, chosen for having no emblem, and the
table instrument overrules the paired probe about what one of them is worth.**

Ten decks shared two planeswalkers — a Jace Beleren and a Garruk Wildspeaker — and a planeswalker is
the one card type here that plays unlike everything else: it arrives, it survives, and it does
something every turn without being tapped or sacrificed. **Ajani, Caller of the Pride** goes into
Skyward Writ and **Nissa, Voice of Zendikar** into Verdant Guard, six abilities between them, and
not one of them needed anything new in the engine. That is the claim `scripts.ts` has been making
for months — "adding a card is a few declarative lines" — tested on six lines at once: a counter, a
pump carrying two keywords, five tokens, one token, counters across a team, and a pair of numbers
read off the board as it resolves.

**The emblem is the constraint on which planeswalkers this pool can carry**, and it is worth
writing down because it decided the two. An emblem is a permanent ability with no permanent behind
it, and the engine has nowhere to put one — so a Liliana of the Dark Realms, whose −6 is an emblem,
is not a card this pool can hold honestly. Both of these end in something that happens *once*: five
Cats, and a gain-and-draw as big as your lands. The ultimates kill their own planeswalker, which is
the rules rather than the card (nought loyalty is a state-based action, CR 704.5i), and the test
says so.

**Ajani measures as free and is used constantly.** Removing it is −1 and −5 of 270 paired duels on
two seed sets, both well inside the floor. The cast counts are the other half: over 108 games the
bot cast it in 52 of the 61 games it drew one and **activated it 186 times** — about 1.7 activations
a game, which is what a permanent that does something every turn looks like when nothing has to
teach the search to use it.

**Nissa is the interesting one, and it is a finding about the instrument rather than about the
card.** The paired probe said −15 and −5: the same sign twice, which is rare, and both under the
eighteen-game floor — so "free, with the number written down". Then the refreshed ten-deck table,
same seeds as the run before it, moved **Verdant Guard 52% → 61%, +18 games of 216**, with Skyward
Writ +7 for the Ajani. The two decks that changed a card are the two that moved up, which is the
D133 signature, and it is the clearest demonstration yet of what the measurement README warns about:
**a reading at the floor is a reading the paired probe cannot resolve**, and when a second instrument
with a different design agrees on the sign and lands above the floor, the second instrument is the
one to read.

So Nissa ships, at 61% and third, in the same band as Dawn Tithe and well under Forge Alliance, with
no matchup worse than 20-4 against the deck at the bottom of the table — and the note in the deck
list says that if the next change pushes Verdant Guard further, it is the deck to look at. The
alternative cut was measured and could not be told apart (cutting the Centaur Courser instead: −6
and +1), so the cards decided it: six accelerants plus nineteen lands was the most redundant thing
in the list, and a three-mana permanent is what the second Rampant Growth was ramping towards.

**And a null result both instruments agree on, which is new.** The same seeds were run once more
with the previous two cards in and the planeswalkers out: 78/66/61/52/50/48/40/39/38/27, the same
order and within a point of the ten-deck run on every row. Arc Lightning (D138) and the Strionic
Resonator (D139) each measured free in a paired probe and moved the table by nothing at all — the
first time this project has had two instruments of different designs agree that a change was worth
*nothing*, which is the claim that is hardest to support and the one most often asserted without
evidence.

**And the second instrument gap of the session, found the same way as the first.** `deck-probe`
splits `CHANGE` on commas, and every legendary creature's name has one in it — "Nissa, Voice of
Zendikar:-1" became two names the probe could not find, and all four runs died in a second. A `;`
anywhere in the string now makes `;` the separator for the whole of it, which keeps every
invocation this project has already written down working and makes the rest expressible. Both gaps
this session were in the same place and neither was in the engine: an instrument that has only ever
been pointed at the cards it was built for has corners nobody has stood in.

## D141 — An eleventh deck whose plan is its mana, and two things the engine had never been asked

**Decision: green-blue, twenty-three lands, and the two engine additions a landfall deck needs —
an `etb` trigger that can watch a land, and a per-turn extra land drop.**

Green-blue was the last colour pair the ten-deck pool did not use, and the plan is newer than the
colours: every other list spends mana on a plan, and **Delta Bloom's plan is the mana**. Nine
accelerants, twenty-three lands — two more than anything else here — and a top end of four X spells
rather than creatures, which is the difference between this and Verdant Guard's ramp. Verdant Guard
ramps into creatures it would have cast anyway; this ramps into a Mind Spring for seven.

**Two engine additions, one line each at the point of use.**

- **An `etb` trigger can watch a land** (`what: 'land'`). The event has always been raised for a
  land entering; nothing in the pool could hear it, so the field was never added. Tatyova, Benthic
  Druid — "whenever a land you control enters, draw a card and you gain 1 life" — is the whole of
  what it is for, and the filter is asked the same way round as the creature one: only when the
  trigger asks, so nothing written before this changes meaning.
- **An extra land drop** (CR 505.5b), which is the first permission in this engine that changes
  what a **player** may do rather than what a permanent is. `extraLands` is a per-turn count beside
  `landsPlayed`, read by the land-drop rule in both places that enforce it, and reset in the untap
  step — a permission that outlived its turn would be a different card. The count is read rather
  than decremented when it is given, so an Explore cast before the turn's land and one cast after
  it both leave you able to play two. Three tests, and the third is the one that matters: the
  allowance ends with the turn.

**And the first card to hear that event found a bug the engine had carried for months.** Tatyova's
first test drew **two** cards off one Forest. `auto:playLand` raised `etb` itself and then called
`settle`, whose arrivals loop raises `etb` for every permanent that arrived — so a land played from
hand raised the event twice. Nothing in the pool could hear a land entering, so the double fire sat
there unnoticed; the fix is deleting the raise in `playLand`, because the arrivals loop is the one
place that sees every way onto the battlefield, which is the same lesson this file recorded when
statics and the `dies` event moved there.

**A second finding, and this one is about the bot rather than the engine.** The deck's first version
ran two Kiora's Followers — "{T}: untap another target permanent" — and `cast-counts` reported the
ability **used 13,581 times across 120 games**, about a hundred and forty-six a game. Two of them
untap each other for ever: A taps to untap B, B taps to untap A, and the board is exactly where it
started. The engine is right to allow it (an untap ability may point at anything, and a cycle of
legal actions is legal), and a person would never do it — so the fix is the deck list. One copy has
nothing to untap it, and the same measurement came back at 164 uses in 46 games, about three a game,
which is a card untapping a land once a turn. **The general problem is written down rather than
solved:** this bot will happily repeat a cycle that returns the board to where it started, and
nothing in the search notices. No other card in the pool offers one.

**It debuts seventh of eleven at 42%**, over 240 paired games against every other deck in both
seats. The shape is in the matchups rather than the total: 12-12 with both mill decks, 16-8 and 15-7
against the two grind decks, and **4-20 against Ember Rush** with 5-19 against the two white
midrange decks. That is the deck working as written — nothing in it attacks before turn six — and it
is the clearest statement the table has produced about what the bottom of this pool is: a deck that
has to survive to turn seven, in a field whose top row wins 78%. Every other deck moved a point or
two because the field grew by one, which is D108's field effect for the third time, and the order is
unchanged apart from the new row.

Five new cards: Explore, Tatyova (the commander), Kiora's Follower, Pelakka Wurm and a Simic
Guildgate. Everything else in the sixty was already here — which is the second time a new deck has
been built mostly out of the existing pool, and the ratio keeps improving: the ninth deck needed
six new cards, the tenth six, this one five.

## D142 — Play with your own list: the pool is the engine's, not the table's

**Decision: a player pastes their decklist into the lobby, the server reads it, and a name the
engine knows becomes the real card while a name it does not becomes cardboard.**

The Play Realm's one real gap was that it only ever dealt the eleven built-in decks. A player keeps
their deck as text — four lines of "4 Lightning Bolt" from Arena, a Moxfield export with a
Commander section, a sideboard nobody asked for — and there was nowhere to put it. Now there is a
box in the lobby.

**The parser knows nothing about cards, and that is the whole split.** `parseDecklist` in
`@grimore/shared` turns text into counts and names: counts may be `4`, `4x` or absent, set codes
and collector numbers are dropped, section headers are understood, and a sideboard is left out with
a word about it rather than silently mixed in. It is forgiving about format because a player pasting
their deck should not have to learn a syntax, and strict about size because the text arrives from a
client and ends up as one card instance per copy in a game state that lives in Redis. A list with
errors is **not loaded**: a deck that silently lost half its cards is worse than a deck refused.

`customDeck` in the engine is the other half, and it is there because the *pool* is there. Every
name is looked up across all eleven decks, commanders included — a hit is the real card, with its
script, its mana cost and its type line, and plays exactly as it does in the deck it came from. A
miss is **cardboard**: a card with a name and nothing else, which is what a kitchen table is. The
type line is left **empty** rather than filled with "Card", because a type line the engine invented
would make the card look like something it can reason about, and the point is that it cannot.

**Both halves matter, and they decide different things.** A list built out of the pool is fully
automated, which is the good case. A list that is not can still be played — on the tabletop, which
is how two people play Magic with their own decks — and `auto:start` **refuses** such a table,
naming the card. That refusal lives in the engine, where it is enforced, and the lobby's badge
("12 the engine cannot read") is a report of it: the rule D132 set for the privacy default, applied
again. The deck still loads, because loading it is exactly what the tabletop wants.

**What the table may know about somebody else's list is a name, a size and a count.** Never its
cards. The seat row says "Nick's list · 60 cards · 1 the engine cannot read" to everybody, because
that is what decides whether the host can press the engine button — a disabled button with no
indication of whose deck is the problem is a dead end rather than an explanation.

**One id per seat, which took a second pass to get right.** The first version gave every pasted
list the same id, `custom`, and leaned on the fact that `ctx.decks` is built per *action* and an
action is stamped with its sender: `custom` always meant the actor's own list, so two seats could
paste different decks with no namespacing. It also broke **play again**. A rematch is composed by
the engine out of the deck id each seat already has, so the host's rematch asked for a `custom`
that only the guest's actions could resolve, and the rematch was refused at any table where the
other player had pasted a deck. So the ids are `custom:0` and `custom:1`, and *which* of them an
action may resolve stays the server's decision: its own sender's always, every seat's for a rematch
and only for a rematch, because a rematch takes no deck id from anybody and cannot be aimed.
Handing every list to every action would let the host load the guest's list onto their own seat and
read it out of their own library, which is now a test.

**Proved by playing with one.** `e2e-solo` no longer clicks a deck: it writes Ember Rush's own
sixty cards out as text, pastes them, and plays a whole game against the computer under the rules
engine — the same game that suite has always played, with one thing changed, which is where the
cards came from. `e2e-table` pastes a list with a card the engine has never scripted, checks that
the engine is refused and the tabletop is not, then pastes one without it and plays the rest of a
two-browser game on a deck nobody built into this repo.

## D143 — The cycle that changes nothing, and what the untap has to buy

**Decision: an ability whose whole effect is untapping something is dropped unless the untap bought
this seat a spell, a body in a combat, or an ability that does something else.**

D141 wrote this problem down rather than solving it. Two Kiora's Followers ("{T}: untap another
target permanent") untap each other for ever: A taps to untap B, B taps to untap A, and the board
is exactly where it started. The engine is right to allow it — an untap ability may point at
anything, and a cycle of legal actions is legal — and the search is perfectly happy, because
`evaluate` sums material and which of two permanents is tapped is worth the same either way. With
no baseline for doing nothing, the free zero gets taken whenever nothing better is affordable. The
deck shipped with one copy as the workaround and the general problem as a note.

**The honest fix is not "do not repeat yourself".** A Gelectrode pinging twice in a step is the
same shape and entirely right, and so is untapping a land twice in a turn. The question is the one
the ritual rule asks of mana: *what did it buy?* One fact about the board, then three comparisons:

- the target has to be **tapped**, because untapping an untapped permanent does nothing whatsoever;
- a **cast** that was not affordable before is affordable now, which is what untapping a land is for;
- one more creature that can **block** an attack already on the table, or one more that can
  **attack** before this seat's own attack is declared — counted, which is what makes the wash a
  wash: the ability taps a creature to untap a creature, so the count only moves if the source was
  not a body to begin with;
- an **ability that does something other than untap or make mana**, handed back.

The last clause is worded that way for two mirror-image reasons. Untapping a Kiora's Follower does
hand back an ability, and that ability is another untap — counting it would make the cycle its own
justification. And untapping a *land* hands back a mana ability, which counted here would make
every tapped land worth untapping whether or not there was anything to spend it on; what a land
buys is a spell, and the cast comparison asks about that directly.

**Two traps, both found by instrumenting a version that fell into them**, and both worth recording
because they are properties of this bot's search rather than of this card.

1. **The step.** With auto-pass on, a simulated line that had nothing to do with the untap has
   already left the step by the time `simulate` returns. Same lesson as the ritual rule (D70).
2. **The stack, which is new.** `simulate` *drains* the stack. So with anything on the stack when
   the decision is made, every sorcery-speed play in hand is missing from the before state and
   present in the after state — and the untap gets the credit for a Preordain it had nothing to do
   with. That was the whole of the first version's surviving activations: 57 of them, 36 pointing at
   a permanent that was **already untapped**, each one justified by a cast that was going to be
   available anyway. Any rule of this family that compares two states has to compare states whose
   stacks match; this one requires the stack to be empty and refuses an untap held for a moment when
   something is already on it, which no card in the pool wants.

**Measured, paired on identical seeds, Delta Bloom against the other ten decks, 120 games per arm:**

| | activations | record |
| --- | --- | --- |
| one copy, without the rule | 165 | 47-73 |
| one copy, with it | **1** | 52-68 |
| two copies, without | 29,432 | 45-75 |
| two copies, with | **10** | 48-72 |

Five games and three, both well inside the eighteen-game floor: free, with the number written down.
Kept for the first column — a bot pressing a button a hundred times a turn to put the board back
where it was looks broken to the person sitting opposite — and **nine of the ten remaining
activations with two copies point at a tapped land**, which is the card's real use and the thing
the rule is written to keep.

**Two consequences worth stating.** The deck stays at one copy: two measures four games worse,
inside the floor, so there is no reason to change a list over it. And the card is nearly dead in
*this* bot's hands — one activation in 120 games — because untapping a land only helps a player who
has a second spell waiting, and three separate measurements have already found that this bot cannot
hold mana (D70, D110, the ward rule). That is a reason to leave the card in the list rather than to
cut it: a person untaps a Guildgate for the Counterspell they are holding, which is exactly what
the card is in a Simic deck for.

**And the deck table was not re-run.** Kiora's Follower is in one deck of eleven, the field has not
changed, and the paired arms above are the measurement — an eleven-by-eleven refresh would move
every row by the usual point or two of its own noise and say nothing this does not.

## D144 — The spell the trigger is about, {X}{X}, and a card measured at nothing

**Decision: a `spell-cast` event carries the spell that was cast, a cost may contain two {X}
symbols, and Chalice of the Void is scripted and shipped in Tidal Mind — at −4 games of 240, with
the reason it is worth nothing to the bot written down rather than tuned away.**

Three small engine gaps, one card, and one measurement that says more about the pilot than the card.

**The event.** A `spell-cast` trigger has been in the engine since the first red deck, and it said
what *kind* of spell was cast — creature, noncreature, instant-or-sorcery — which is everything
prowess, Talrand and Guttersnipe need. It did not say *which* spell, so no card could read a
spell's mana value or counter it. It carries the object now, and that object reaches the ability as
`EffectContext.answering` — the channel ward already used for the spell that targeted its creature.
One field, two callers, no new concept.

**The clause.** The intervening-if condition (CR 603.4) is asked twice, and the second ask always
had `answering` while the first did not. That asymmetry is invisible until a condition needs it:
without `answering` in the first ask, Chalice's trigger would go on the stack for *every* spell
anybody cast and then vanish on resolution — so an opponent casting a two-mana spell into a Chalice
set to one would see a trigger they could respond to for a spell that was never going to be
countered. Both asks now get the same context, which is the only way "asked twice" means anything.

**The cost.** `{X}{X}` is one chosen number paid twice (CR 107.3b), and `ManaCost` had a boolean.
It is a count now, written only when it is more than one so every cost parsed before this field
existed is deep-equal to what it was. Two readers multiply by it, and the whole of `maxX`,
`canAfford` and the X prompt follow for free: with three Islands the table offers X=1 and refuses
X=2, which is a test. It also unlocks the rest of a real family — Walking Ballista and Hangarback
Walker are both `{X}{X}` — without a line of card-specific code.

**The card.** Chalice enters with X charge counters, counters any spell whose mana value equals
that number, and counters its controller's spells too. Tidal Mind is its home by arithmetic: that
deck casts four one-mana spells, and the field it is measured against casts twenty-two in Ember
Rush, fifteen in Verdant Guard and thirteen each in Forge Alliance and Arc Tempest. Mana value is
read **on the stack**, which is the one place {X} is not nought (CR 202.3b), so an Endless One cast
for X=1 is caught by a Chalice on one.

**And the bot's X**, which is the first X in this engine where bigger is worse. Every other X spell
is cast for as much as the mana allows and the search sees what that buys; a Chalice for four is a
blank. The number is chosen instead from what the opponents have **shown** — the mana values of
every nonland card in their graveyards and on their battlefields, commonest first, ties to the
smaller number, one when they have shown nothing. Public zones only, which is the line D110 drew:
this is not the bot reading a hand.

**The measurement, and the finding in it.** The slot is −4 of 240 paired games, inside the
eighteen-game floor. The interesting number is not that one:

| | |
| --- | --- |
| games the Chalice reached hand | 25 of 120 |
| of those, games it was cast in | 21 |
| earliest turn it was ever cast | **14** |
| games moved v Ember Rush, Verdant Guard, Forge Alliance | **0, 0, 0** |

It is cast on turn fourteen because **that is when one copy of a sixty-card deck arrives**, not
because the bot is holding it: a rule that cast it before the search saw anything else — the
land-drop shape, justified the same way — was written, measured and reverted, because it moved the
turn it was cast by nothing at all (21 casts to 24, the same turns, 35-85 to 34-86). The card that
answers the first three turns of a game cannot answer them from the seventh.

So it ships as what it is: correct, tested nine ways, worth nothing to this bot and worth a great
deal to a person — who casts it on turn two, and who can run four copies of it in a pasted list.
That is the same conclusion D143 reached about Kiora's Follower by a different road, and it is
becoming the honest shape of this pool: the cards this bot cannot use are the cards a person gets
the most out of.

## D145 — A counter as a cost, last known information, and two cards the bot values less than the slots they took

**Decision: an ability may be paid for by removing a counter from its own permanent; a permanent
leaving the battlefield is snapshotted so a death trigger can count what it had; Walking Ballista
and Hangarback Walker ship in Forge Alliance at −1 and −6 of 240.**

The `{X}{X}` cost from D144 made both cards expressible; two small engine additions finished them,
and both are rules rather than conveniences.

**A counter as a cost.** "Remove a +1/+1 counter from this permanent: it deals 1 damage to any
target" is the fifth non-mana cost here, after the sacrifice, the life, the discard and the crew. A
cost, not an effect, and the difference is the card: the counter comes off as the ability is
activated, so a Ballista firing its last counter is a 0/0 while its own damage is still on the
stack. The state-based actions kill it and the damage is dealt anyway, because an ability on the
stack has nothing further to do with its source (CR 608.2). That is how the card is played, not an
edge case — and a planeswalker's last loyalty was already the same shape, which is why it needed no
new machinery. It also inherits the rule the whole family has: an ability whose cost cannot be paid
is **not offered**, so a Ballista with no counters shows no damage ability rather than one the
engine then refuses.

**Last known information** (CR 608.2h / 603.6e). Hangarback Walker makes a Thopter for each +1/+1
counter it had, and a card in a graveyard has none — `relocate` takes them off on the way out,
which is the rule. Tokens already had this solved: a token that ceases to exist leaves its last
state in `vanished` so its own death trigger can read it. That now covers **every** permanent
leaving the battlefield, which is a two-line change with the same lifetime (`settle` clears the map
once the triggers are on the stack) — and because the trigger resolves later than that, the one
fact it needs rides on the stack object as `subjectCounters`. A counters map rather than a whole
snapshot, deliberately: when a card needs the power it had, that is where it goes.

**And then the measurement, which is the third of these in a row to say the same thing.**

| the slot | measured |
| --- | --- |
| Walking Ballista in Forge Alliance, for a third Monastery Swiftspear | **−1** |
| Hangarback Walker in Forge Alliance, for a second Firebrand Archer | **−6** |
| Hangarback Walker in Rot Harvest, for a Doomed Dissenter | −7 |
| Hangarback Walker in Hollow Tide, for a Returned Centaur | −9 |

All four inside the eighteen-game floor, and all four negative. The Ballista is free: a creature on
any curve, a mana sink, and the pool's only removal that costs no card. The Walker is not, and this
time it is **not** the bot playing it badly — instrumented, it was cast in 37 of the 40 games it
was drawn and **eighteen of those on its second turn**, for X=1 or X=2, which is exactly what a
person does. It is simply a grindy card, and a 1/1 that grows is worth less to this bot than the
2/1 that pings every turn. Three homes were measured before shipping it in the least bad one, where
the Thopters at least have a Loxodon Warhammer and a Hellrider to play with.

Which is worth saying plainly, because it is now a pattern rather than an anecdote: **this pool has
three cards whose value a one-ply search cannot realise** — Kiora's Follower (D143), Chalice of the
Void (D144) and Hangarback Walker. Every one of them is a card a person uses well, every one of
them measured negative-but-noise, and every one shipped anyway, with its number written down. The
alternative — a pool containing only what the bot pilots well — would be a worse pool for the two
people this table is built for.

## D146 — Two things a player does every session, and neither of them was there

**Decision: a deck says what is in it before you pick it, and the last list you pasted is kept in
your own browser.**

Both are small, both are presentation rather than plumbing, and both were missing for the same
reason: the work has been going into what the engine can express, and these are what a person
touches on the way to using any of it.

**What is in it.** Eleven decks were offered as a name and one line of prose, which is enough to
tell Ember Rush from Tidal Mind and nothing like enough to *choose*: "blue-black control" does not
say whether there is a sweeper in it, how many counterspells, or what it wins with. The card list
has been in the browser the whole time — `STARTER_DECKS` is bundled, because the table deals from
it — so the panel costs no request and no server work at all. It is grouped the way a player reads
a decklist rather than the way the engine stores one (lands, creatures, spells; each sorted by cost
then name), with the curve drawn as bars over the counts and the colours read off the cards rather
than declared. It is shut by default and it is in two places: the pregame picker, where you choose
your own, and the solo list in the lobby, where a new player chooses the computer's first.

Text rather than card images, which is not a placeholder: there are no images in this product (the
card table has never been populated and this environment cannot reach Scryfall), and a list is what
a player compares two decks with anyway.

**The list you pasted.** D142 let a player paste their decklist; it survived exactly one table.
Paste it, play it, and tomorrow you paste it again — which is the kind of friction that decides
whether a feature gets used twice. It is now kept in `localStorage` and offered back in the paste
box as one button, and the three properties that follow from choosing storage over an account are
all deliberate: it survives a reload and a new table, it does not follow the player to another
device, and a browser that refuses storage simply never offers it. The same three the remembered
seat has had since the first version of this table.

The server keeps nothing it did not already keep. A decklist is the player's, and the only copy
that outlives the table is in their own browser.

**Checked through a real reload**, because `localStorage` is the whole mechanism: the browser comes
back on the same seat, presses the paste box, and finds the list it had. Seventy-two checks in
`e2e-table` now, up from sixty-eight.

## D147 — The host went first in every game ever played here

**Decision: a `game:start` that names no seat gets one rolled for it, in the server rather than the
engine.**

`game:start` with no `firstSeat` starts seat zero, and the lobby has never sent one. So the host
went first in **every game on every table** since this was built — and going first is a real edge,
which this engine already knows: a rematch hands the previous winner the *second* turn (see
`rematch`). The only game nobody rolled for was the first one.

**Rolled in the pod layer, not in the engine**, and the split is the usual one. The engine's
default is explicit and test-friendly — name a seat and you get that seat, name none and you get
seat zero — and three hundred tests, the rematch and the whole testkit depend on that. "The table
rolls" is a fact about a *table*, not a rule of Magic, and `apps/realtime` is the table. A
`game:start` that names a seat is passed through untouched, which is what keeps every one of those
deterministic.

Uniform across the seated players, the computer's seats included: a bot that always went second
would be the same unfairness pointed the other way.

**The roll is injected rather than observed.** A test that started twenty tables and checked both
seats came up would fail one run in a million for being unlucky, which is how a suite earns a
`--retry` flag. So the function takes its randomness as an argument, and the tests assert the
mapping: nought lands on the first seat, 0.99 on the last, a stub that returns exactly 1 lands on
the last rather than past the end of the table, a start that named a seat comes back identical, and
every other action is returned by reference.

The lobby says it in one line under the two start buttons, because the first thing a player notices
otherwise is that something changed.

**What it broke, found two days later:** `e2e-table`'s "passing the turn moves it to the other
player" had Friend hard-coded as the other player, because the host always went first when it was
written. With the roll it failed on the runs where the roll went the other way — Nick pressed Pass
turn on a turn that was not his, the turn moved *to* him, and Friend was never told anything. The
check now reads which page says "your turn" before the press and asks the other one. Worth recording
because the failure did not look like a roll: it looked like a socket that had not delivered, and
the first fix attempted was a longer timeout.

## D148 — The number chosen while the spell is resolving

**Decision: a third shape of mid-resolution question, whose answer is a number and whose range the
card computes when the question is asked.**

This engine could already ask two kinds of question in the middle of a resolution: *which cards*
(`CardsDecisionSpec`) and *which word* (`ChoiceDecisionSpec`). Toxic Deluge is neither. "Pay X life.
All creatures get -X/-X until end of turn" is a number, and — this is the part that matters — it is
chosen **as the spell resolves**, not as it is cast.

**Which is why it is not an X cost.** The engine has had `{X}` since D32: X is announced on the
stack, is part of the spell an opponent is deciding whether to counter, and is locked in before
anybody responds. A Deluge is the opposite: every response has already happened, the board is
whatever it ended up being, and *then* the number is chosen from it. Folding this into `xMax` would
have been a lie about the card in exactly the way a player would notice — holding up a Deluge and
choosing four after the opponent flashes in a fifth creature is the card.

**The card owns the range, not the engine.** `range(state, chooser)` is called when the question is
asked, and Toxic Deluge's is nought up to the *smaller* of two numbers: one less than its caster's
life (CR 118.4 — a cost that kills you is not one you may choose to pay, the same rule that stops a
Mana Confluence at one life) and the biggest toughness on the board. The second bound is a question
about question design rather than about rules: -9/-9 and -4/-4 kill precisely the same creatures
when nothing has five toughness, so offering forty answers where four differ is a *worse* question,
not a more honest one. A range with one answer in it is not a question at all — the engine takes
that answer and carries on, the way a one-word list already did.

**The bot gets an opinion, not a maximum,** because the card hits its own creatures too. `best` is
the card's, for the same reason `ChoiceDecisionSpec.best` is: only Toxic Deluge knows that its
number is life. It answers the way a person does — walk the range, count how many of theirs dies
and how many of mine, take the smallest number where theirs outnumbers mine, and nought when no
number does. Nought is also the fallback everywhere else: a hint outside the range, a missing hint,
a stack object that has gone. The answer that does least is the safe one to default to.

**Validated where it is enforced.** The range the engine computed *is* the authorisation, so
`auto:decide` refuses a number that is not an integer inside it — a crafted action cannot pay nine
life out of a four-life range — and the reducer in the browser refuses the same before it ever
sends one. The table draws a row of numbers because the engine said which numbers are answerable;
it is never the forty buttons a raw life total would be.

**The life is paid before the effect**, not as part of it: a Deluge for four takes four life whether
or not anything on the board has four toughness. It is a cost, and the order is the one thing a
player would check.

**And the twelfth "spent on nothing" rule, which the instrument found and the record did not.**
Over 120 Hollow Tide duels the bot cast the Deluge 18 times and chose well — 30 of the opponent's
creatures dead against 3 of its own — but three of those casts chose **nought**, which is a card put
in the graveyard to do nothing at all. The search cannot see it for a structural reason rather than
a missing term: a cast puts the spell on the *stack*, and the number is not chosen until it
resolves, so one ply out the board after the cast is the board before it plus a stack object, which
scores the same as any other play that does nothing. So `chosenNumberIsNothing` drops a cast whose
card answers its own question with the bottom of its own range — a fact about the board, like every
other member of the family, never a weight in `evaluate`.

| | casts | numbers chosen | their creatures dead | its own |
| --- | --- | --- | --- | --- |
| without the rule | 18 | **0:3** 1:5 2:3 3:2 4:4 | 30 | 3 |
| with it | 18 | 1:8 2:3 3:2 4:4 | **33** | 3 |

**The slot measures −3 of 240** against the field, paired on identical seeds (Hollow Tide, the
Deluge against a second Returned Centaur), and the drop rule moved it by *exactly* nothing: 81-159
with the Deluge and 84-156 without it, the same in both runs, every per-opponent row identical. Both numbers are far inside the
eighteen-game noise floor. That is the fourth card in a row to measure this way — Kiora's Follower,
Chalice of the Void, Hangarback Walker — and for the fourth time the same reason: a one-ply search
cannot realise a card whose value is in *when* it is cast. Shipped with the number written down, and
the rule kept on the untap cycle's grounds rather than the record's: a bot that spends a card to
choose nothing looks broken to the person sitting opposite, and three more dead creatures for the
same three of its own is not worse.

Asked of the board *now* rather than at resolution, which is the approximation every rule in this
family makes. The bot casts in its own main phase with an empty stack, so the two are the same board
unless somebody responds — and a card held for the turn somebody does respond is the card kept.

The rule is the bot's judgement and never a refusal: a person holding up a sweeper with nothing to
sweep is allowed to be wrong, and the cast stays legal and offered, which the tests assert.

## D149 — A check that presses a button on every retry

**Decision: a retry loop reads before it presses, and never presses a toggle twice.**

`e2e-table` came back 70 of 72 against a stack that had just started, and green on every warm run.
Two checks, both failing on the browser that had just reloaded, and both the same mistake in the
test rather than anything wrong with the table.

The reclaimed-seat check clicked **life down** and then demanded exactly `lifeBeforeReload - 1`, all
inside the retried predicate. A click that is slow to land is therefore clicked again, life goes
down twice, and the one number the check will accept is behind it for ever — it cannot pass, however
long the timeout. It now reads first and clicks only if nothing has landed yet, accepts **any**
decrease as proof the seat can act, and then puts the total back wherever those clicks left it,
because the end of that game counts life down to nought and expects to start from the same place.

The search check pressed a **toggle**. "Search deck" and "Close deck" are one button, so the second
press shuts the drawer the check is waiting for. It now lets the library decide, reads the button's
own label to see whether a press is still wanted, and gives a press a second and a half to land
before another one.

**Neither was retried away, and neither got a `--retry` flag.** A test that fails once on a cold
stack is a test with a race in it, and the fix is to make the press idempotent — which is also the
only version of the check that would catch the table genuinely losing the seat, because a check that
can only pass by luck cannot fail for the right reason either. Run twice against a freshly started
stack and a warm one: 73 of 73 both times.

## D150 — The target chosen while something resolves, and the copy that is not a card

**Decision: a fourth shape of mid-resolution question, whose answer is a target for a *different*
object on the stack — and a spell copy that has no card behind it.**

Three shapes of question existed: which cards, which word, which number. "You may choose new
targets for the copy" is none of them, and it is the clause every printed copy effect ends with. So
Strionic Resonator arrived (D136) without it, and the engine said so out loud: the copy kept
whatever the original chose, and a copied Gravedigger trigger pointing at a card the original had
already returned was countered for having no legal target. That limitation was a test. It is now the
test one line above the one that undoes it.

**The question is asked about the object being copied, not about the copy.** A copy's
characteristics are the original's (CR 707.2), so its legal targets are the same set — which means
the question can be answered *before* the copy exists, and the answer handed to `copySpellOnStack`
as it makes one. The alternative was to make the copy aimed at the old target and then re-aim it,
which is two states where one will do, and a visible flicker in the log.

**Only a single-target object is asked about.** That is the same restriction `soleTargetSpecOf`
puts on Swerve and Willbender, and the reason is sharper here: the rules copy a divided quantity as
it was divided (CR 706.10c), so re-aiming an Arc Lightning would need its three points
re-divided — and "choose new targets" is not permission to re-divide. No targets, several targets,
or one legal target and it is the one already chosen: all three are "no question", answered by the
engine the way a one-word list and a one-number range already are.

**Not a cast-time target, which is the distinction worth being careful about.** Swerve and
Willbender *do* choose where a spell is going as they are cast, and they are different cards for
it: both choices are on the stack where an opponent can read and answer them. A copy effect chooses
after every response, from the board as it ended up — a creature that arrived since is a legal new
target, and one that died is not.

**A copy of a spell is a spell with no card** (CR 707.10), which is where the work was. A spell's
stack id has always *been* its card instance — `id` and `source` are the same field twice — so the
copy takes a new id, leaves `source` pointing at the original's card, and has no instance at all.
Everything in `completeResolution` that moves a spell's card was already written as "if there is an
instance", so the copy runs its effect and ceases to exist with nothing added there. Two readers had
to learn it: `ctx.source` for a spell, which now reads `source` rather than `id` (identical for
every spell that was cast, correct for a copy), and the view, which must not name a card the table
has no card for.

**The copy is not cast**, and that is asserted in the deck where it would be wrong in the player's
favour: Arc Tempest is built on triggers that read a cast, and a Guttersnipe seeing a copy would
quietly deal two extra damage a turn. Two casts, two triggers, ten damage rather than twelve.

**And the copy can be countered**, which needed a second fix nobody would have found without the
first. Spell targets were enumerated out of the stack *zone*, which holds cards — so a copy, having
none, was invisible to "counter target spell". They are now read off `stackOrder` with the spells
kept, which is the shape the abilities already used, and `isLegalTarget` answers for a copy the way
it answers for an ability: no zone, no type line, no keywords, so the spec's kind and the card's
filter are the whole of the legality. A real Counterspell countering a real copy is the test.

**The target sequence numbers move with a target that moved, and not otherwise** (CR 400.7), which
is the subtlest line in the change and was written the wrong way round first. Those numbers are what
the fizzle check compares a target against, so a copy aimed somewhere new needs the numbers of
*now* — while a copy that kept the original's targets needs the *original's* numbers, because it is
pointed at the same objects the original is and has to be countered alongside it when one of them
has been replaced by a new object. Recomputing them either way, which is what the first version did,
would have let a copy resolve against a card the original could no longer see. It is a test.

**The bot answers it the way it aims a cast,** because no card can: the spell being copied is not
the card asking. So `newTargetFor` ranks the offered targets the same way `chooseTargets` does —
enemies and enemy creatures first, reversed for a spec the copied card marked `friendly` — and
declines when the best answer is the one already chosen. The interesting half is the other one: a
copy of *their* removal spell arrives pointed at my own creature and is worth a card only once it
is pointed back, which is what the bot now does.

**Where the card goes was decided by measurement, twice over, and the instrument said why.**
Twincast went into Arc Tempest first, because Izzet is where the card is printed and that deck is
made of spells worth copying. Against the field, paired on identical seeds, it cost about **nine
games in 240 whatever it replaced**: −8 and −10 in the Lava Spike's slot on two seed sets, and −9
against a second Faithless Looting. Three measurements, one sign.

The usage instrument explained it rather than leaving it a mystery. Over 120 duels Arc Tempest drew
it in 71 games and **cast it 23 times** — seven copying its own Lightning Bolt, and *seven copying a
cantrip* (five Think Twice, two Faithless Looting), which is four mana for one card in a deck whose
clock starts on turn three. The rest were four of the opponent's spells and a handful of its own
burn. A card the bot uses often and half of the time badly.

So it moved to **Tidal Mind**, where it measures **−4 of 240** — inside the eighteen-game floor —
and the same instrument says the use is different in kind: 7 casts in 120 duels, **all seven copying
the opponent's spell**, and three of the four new-target questions moving the copy. Rarely, and for
the thing the clause exists for. The reading is that this was never a card-quality question: a
four-mana reactive spell belongs in the deck that can afford four mana and holds up its turn
anyway, and the bot's own behaviour changes to match the deck it is in.

**The cut inside Tidal Mind the instrument could not call, so a rule did.** The second Omenspeaker
against the Turn to Frog measured 58-182 and 60-180 — two games of 240, which is this instrument
saying nothing. Turn to Frog is the pool's only characteristic-setting trick and the only card in
any deck that covers that layer (D88), so cutting it would take a *rule* out of every game rather
than a card out of one deck. The Omenspeaker is a 2/1 that scrys two, and this deck still has one.

A note for whoever reads the Arc Tempest comment: the card's doc comment there predicted "the
computer will be poor with this" before any of this was run, and the prediction was wrong in both
directions — the bot used it far more than expected, because a seat's lands are *already* untapped
on an opponent's turn and the engine taps for a cost as it pays it, so nothing has to be held. That
guess is corrected where it was made rather than quietly deleted.


## D151 — What a spell costs is a question about the board

**Decision: a permanent may change what other spells cost, through one function that both the offer
and the payment call.**

The engine could *replace* a cost — flashback, foretell, morph — and the command zone could tax one
(CR 903.8). What nothing could do was reach a card in somebody's hand and make it cheaper or dearer,
which is the whole "costs {1} less" family and one of the most common static effects printed. So a
Goblin Electromancer was unwritable, and so was every card that taxes.

**One function, two callers, and that is the point.** `costChangeFor` is asked by `legalActions`
(what does this cast cost, and can this seat afford it) and by `castSpell` (what do I charge). The
same rule convoke, crew and morph are built on: a table that offered a spell for two and then took
three would be a table nobody could play on. The alternative — computing it twice, once per side —
is exactly the bug this project has already fixed three times.

**Only generic mana moves** (CR 601.2f). A reduction never touches a coloured requirement, so an
Electromancer leaves Counterspell at {U}{U} and a Lightning Bolt at {R}, and makes Arc Lightning
{1}{R} instead of {2}{R}. The generic floors at nought and stops: two Electromancers do not make a
one-generic spell owe anybody mana.

**Increases and reductions are netted and floored once**, which is the answer the rules' staged
order gives — increases, then reductions, with the floor only at the end. They are still counted
separately, because the first card that says "costs {1} less for *each*" wants a count rather than a
total, and a sum would have thrown that away.

**Applied after the commander tax, not before.** The tax is an increase, and a reduction taken off
the printed cost first would floor at nought and then have the tax added on top — which would make a
taxed commander cheaper than an untaxed one is dear.

**A face-down permanent contributes nothing**, which is the morph rule rather than a special case
(CR 707.2): an Electromancer hiding under a 2/2 is doing nothing for anybody, and the test says so.

**The printed cost is not rewritten.** The play carries `costChange` and `costNote` beside
`manaCost`, the way it already carries `commanderTax`, and the table draws "−{1}" next to the
printed cost. A row that silently showed `{1}{R}` for a card that reads `{2}{R}` would be telling
the player the card says something it does not — and would also be wrong the moment the
Electromancer dies in response.

**The two cards are the two directions.** Goblin Electromancer ({U}{R}, instants and sorceries *you*
cast cost {1} less) goes to Arc Tempest, where twenty-five of sixty cards are instants and
sorceries. Thalia, Guardian of Thraben ({1}{W}, noncreature spells cost {1} more) goes to Skyward
Writ, and taxes **everybody** — her own controller included, which is the printed card and the
reason she is a cost rather than a free advantage. Skyward Writ is the white deck with the fewest
noncreature spells of its own (seventeen, against a field averaging twenty), so the tax is
asymmetric in its favour by the margin a deckbuilder would want.

**Both measure free, and the instrument says what they actually did.** The Electromancer, in for the
second Stormchaser Mage, is **−2 of 240** — and over 120 duels Arc Tempest cast 1390 spells of which
**24 were discounted**, saving 24 mana. About one cast in sixty, because one copy in sixty cards has
to be drawn, survive, and then meet a spell with generic in it; the cards it cheapened were Behold
the Multiverse ten times, Arc Lightning five and Swerve four.

Thalia, in for the Youthful Knight, is **−4 of 240**, and the instrument found the more interesting
number: over 120 duels she taxed **85 of the opponent's spells and 70 of her own**. Fifteen spells
of a hundred and fifty-five is the whole asymmetry, in the white deck chosen *because* it has the
fewest noncreature spells in the pool. The honest reading is about the format rather than the card:
in a 60-card starter pool where every deck runs about twenty noncreature spells, a symmetric tax is
very nearly symmetric, and the deckbuilding argument for where to put her is worth less than it
sounds. She is kept because she measures free, the tax is real on both sides, and a person holding
a hand of creatures gets the half of the card the computer cannot.


## D152 — A new prompt is not finished until the driver can answer it

**Decision: every question the table can ask gets a branch in the browser driver, in the same
change that adds the question.**

The pod suite failed with "Boris stuck at Draw on turn 43" — a seat whose table said it was their
move and whose page offered nothing the driver knew how to press. The table was fine: a Strionic
Resonator's copy was waiting to be aimed, and the buttons were on the screen. What could not answer
it was `makeMove`, which knew how to tap a lit card, choose a word, pick an X and pay a ward, and
had never heard of a row of targets.

**The check that caught it is the one that exists for exactly this**: "every prompt the table shows
can be answered". It is not a check about the engine — the engine was right — it is a check about
whether a *player* could get through the turn, and the driver is the only proxy for a player these
suites have.

The same hole was already there, unseen, for the **number** prompt added one change earlier: a Toxic
Deluge in a pod would have stalled the driver the same way, and did not only because one copy in
sixty cards rarely comes up in a four-seat game. Both branches are in now, and both choose the
answer that exercises the mechanism rather than the one that does nothing: the largest number, and
the last target rather than **Leave it**, which is first.

The rule this leaves behind is short. A question added to the table is three places, not two: the
engine that asks it, the component that draws it, and the driver that answers it. Two of the three
are tested by the unit suites; the third is tested by a pod that gets stuck forty turns in, and only
sometimes.


## D153 — Evasion that is not a keyword, and the one that reads the other player's board

**Decision: two more blocking restrictions, both read off the attacker, one of them answered by the
defending player's lands.**

The pool's evasion was flying and reach, menace, protection, and "can't be blocked by Walls". Two
families were missing, and they are not variations of each other:

- **"Can't be blocked"**, full stop. Nothing on the blocker's side answers it, so it is one flag on
  the attacker and one line in `canBlock`. Tormented Soul ({B} 1/1) is the version that pays for
  itself: it cannot block either.
- **Landwalk** (CR 702.14), which is the only evasion in this engine whose answer is **somewhere
  else**. Every other check compares the attacker with the blocker; islandwalk compares the
  attacker with the *defending player's lands*. The same River Boa is unblockable against the five
  decks with Islands and an ordinary {1}{G} 2/1 against the rest, and it changes between one combat
  and the next as lands arrive.

**A list of subtypes rather than a keyword or an enum.** Landwalk is one rule and a dozen land
types, which is the shape `statics`' subtype scope already settled (D57): "islandwalk" is
`['Island']`, and the next card that wants swampwalk is a word, not a code change. It cannot be a
`Keyword` for a sharper reason than taste — a keyword is a fact about the creature, and this one is
a fact about somebody else's board at the moment blockers are declared.

**Checked when the block is offered, which is when the rules check it** (CR 509.1b). A player who
plays their first Island after blockers are declared has still blocked, and a player who cracks
their last one has still been walked past.

**Both are declared the way the Wall clause already was** — a static scoped to the card itself — so
no new mechanism was added to the script API, and `canBlock` explains the refusal in the card's own
words: "River Boa can't be blocked while you control an Island".

**Both are priced, and one of them moved a slot.** Tormented Soul costs the deck it is in **10
games of 240** against the Goblin Arsonist it replaced (a death trigger in a deck with three Blood
Artists), and the alternative cut measured three games worse still, so the card ships at a price
that is written down rather than at no price. River Boa's first cut — a second Journey to Nowhere —
cost eight games; cutting the **Rampant Growth** instead came back nine better, and the shipped deck
then priced at **157-83 with the Boa against 148-92 without**, +9 of 240. Nine is half this
instrument's noise floor (D86: 18 games in 240), so the claim is **free**, not better. That is the
rule this log keeps re-learning: measure the cut as well as the card, and do not promote a number
the instrument cannot resolve.

**One thing the engine does that is worth knowing**: an attack by one unblockable creature is not a
decision, so the defender is never asked to block it — the table auto-declares past a choice with
one possible answer, the same rule that skips a one-word question. The test that proves the refusal
needs a *second* attacker to make blocking a real choice, which is the engine being right rather
than the test being awkward.


## D154 — The two combat triggers, and the declaration that happens in two places

**Decision: `blocks` and `attacks-unblocked` are their own events, raised in the declare-blockers
step, and neither could have been a filter on the attack event.**

Combat raised exactly one thing: an attack was declared. Everything after that was invisible to
every script in the pool.

- **`blocks`** is somebody *else's* declaration, a step later. The **blocking** creature is the
  subject, so `who` and `of` mean what they mean on `attacks`, and the attacker it blocked travels
  on the event as `blocked` — a new channel alongside `attacked`, for the same reason that one
  exists: "whenever ~ blocks a creature, **that creature** doesn't untap" is about one particular
  attacker, and by the time the ability resolves the board says only that the Wall is blocking
  something. Raised **once per block**, which is what the printed card says: two Walls on one
  attacker put two triggers on the stack.
- **`attacks-unblocked`** cannot be a filter on `attacks`, because when attackers are declared
  nobody has blocked yet and the answer is not knowable. It is raised at the end of the
  declare-blockers step, which is the first moment at which "isn't blocked" is a fact.

**A new mechanism for "doesn't untap", and it is deliberately not a continuous effect.** Nothing
about a frozen creature is different — same power, same abilities, same keywords — so a
`ContinuousEffect` would be describing a change that does not exist. It is one flag on the
instance, read by exactly one thing (the untap step), and cleared as that step declines to untap.
Cleared whether or not the creature was tapped, because the effect is spent by the step happening
rather than by an untap being prevented. See `CardInstance.frozen`.

**The bot needed nothing.** A frozen creature is a tapped creature when blockers are declared, and
`legalBlockers` has always known that a tapped creature cannot block — so the search sees the turn
the freeze cost without a term for it, which is the same rule the rest of the bot follows: read a
fact off the board, do not carry a weight.

**The bug this found, which is the lesson worth keeping: a seat can come to have declared blockers
in two different places.** It said so with `auto:block`, or it had nothing that could legally block
and the step declared for it (`automation.ts`, the `declare-blockers` turn-based action). The first
version of this raised the unblocked event only in the first place, so an Ophidian attacking into an
empty board — the one board where it is certain to get through — triggered nothing at all. Both
callers now go through one `raiseUnblockedAttacks`, each guarded by "no blocker declaration
outstanding", so exactly one of them fires. This is D152's rule one layer down: a *question* added
to the table is three places, and a *turn-based action* is as many places as can perform it.

**Measured, both the record and the mechanism** (`scripts/measure/combat-triggers.mjs`, 660 games):

- Wall of Frost went on the battlefield in 29 games, **blocked 47 times and froze 46** — every one
  of them a creature that was already tapped, because attacking taps it — and **34 of those were
  still tapped when their controller's next turn came round**. That is the card doing the thing it
  promises, 34 turns taken off attackers; the other 12 died, left, or the game ended first. In its
  slot (the second Fog Bank) it measures **+4 of 240**, which is free rather than better.
- Ophidian attacked 41 times, **got through 25 of them (61%)**, and the bot drew the card 24 times
  and kept the damage once. A question whose answer is nearly always the same is worth saying out
  loud: it is still a real decision — the one board that said "attack" was a lethal swing, which is
  the whole reason the card asks — but anybody reading the card as a hard choice would be wrong.
  In its slot (the Child of Night) it measures **+3 of 240**: free again.

**And the instrument was wrong before the mechanism was.** The first version of the measurement
watched for `step: 'untap'` and reported a flat zero freezes held. Nobody ever holds priority in
the untap step (CR 502.1), so no state the loop sees is ever at that step: the check could never
have fired. A zero from an instrument that cannot observe the thing is not a measurement, and the
only reason it was caught is that 46 freezes on tapped creatures and 0 of them holding is not a
story about Magic.

## D155 — A trigger that happens later, and the two cards that need it

**Decision: a delayed triggered ability is an entry in the card's own `triggers`, marked `delayed`,
plus a scheduled record on the game state (CR 603.7).**

Every trigger in this engine fires the moment its event happens. A whole shelf of printed text does
not: "destroy that creature **at end of combat**", "return it to the battlefield **at the beginning
of the next end step**". None of it was expressible.

**Not a step trigger with a flag.** A step trigger fires every turn for as long as its permanent is
on the battlefield; a delayed trigger fires **once**, at a named step, whether or not the permanent
is still there. The two are different cards, so `delayed: true` takes the ability *out* of the event
path and `fireDelayed` drains it at the step it names.

**On the state rather than on the permanent**, which is the rule rather than a convenience
(CR 603.7d): the ability stops belonging to its source the moment it is created. A Flickerwisp
killed before the end step still gives the exiled card back, which is the exact opposite of how
"exile until this leaves" behaves — and having both in one pool is worth more than having either.

**"The next" one is not the one in progress** (CR 603.7b). Each record carries the turn and step it
was created in, so an ability created during an end step waits for the following turn's rather than
firing immediately into the step that created it.

**Drained on entering every step, not only the two steps cards currently name.** The mechanism is
about *a* step; a card that said "at the beginning of the next upkeep" would otherwise need a
second place to be remembered.

**The table says so, because all of it is public.** `AutomationView.later` carries the description
and the step, and the stack panel draws it under the stack as a "later" row. A delayed trigger is
the one thing on the board that is going to happen and is not on the stack — without it a permanent
leaves two steps after the combat that doomed it with nothing on screen to have warned anybody,
which is the same argument the prevention shield and the freeze already won.

**Measured, and the two cards came back differently honest**
(`scripts/measure/delayed-triggers.mjs`, 660 games; 33 delayed triggers scheduled and 32 fired):

- **Flickerwisp** blinked **43 permanents, every single one an opponent's** — 36 creatures, 6 lands,
  one artifact. The bot aims it correctly with no help at all, which is the search doing its job
  (D46, D92): the card has no "this helps" hint and the lookahead works out that blinking your own
  Plains is worth nothing. It still measures **0 of 240** in its slot — exactly level, with eight of
  ten matchups identical game for game. A blink that gives the permanent back a step later is a turn
  of tempo, and a turn of tempo against this field is worth nothing measurable.
- **Thicket Basilisk** was on the battlefield in 42 games and its clause fired **three times**. Not
  a bug and not a dead card: a creature that kills whatever it fights is a **deterrent**, and a
  deterrent is invisible to an instrument that counts what happened. What the measurement can say
  honestly is that the clause almost never resolves, so in practice the card is a 2/4 for five — and
  it prices at **−1 of 240**, which is the same answer from the other direction. The value it may
  have, in attacks that were never declared, is not something this instrument can see, and saying so
  is better than claiming it.

The pair is the point for the engine rather than for the decks: `becomes-blocked` now has a card
behind it, and so does the delayed trigger, and both will be a few declarative lines for the next
card that wants them.

## D156 — The crown is a rule, not a button

**Decision: the monarch (CR 720) is enforced by the engine — the draw, the steal and the crowning —
and the tabletop button that used to be the whole feature is refused while the engine is running.**

`GameState.monarch` has existed since the tabletop was written, with a `monarch:set` action anybody
could press and **nothing in the rules touching it**: no card gave the crown, combat damage did not
take it, and the monarch never drew a card. It was a sticker, not a designation.

**Three rules, and only one of them belongs on a card.** "You become the monarch" is card text, so
it is one line in an effect (`becomeMonarch`). The other two are rules of the *game* and live beside
the other turn-based actions:

- the monarch draws a card at the beginning of **their own** end step (CR 720.4), in
  `onEnterStep('end')` before the step's own triggers go on the stack;
- a creature that deals combat damage to the monarch hands the crown to its controller (CR 720.5),
  applied where `settle` drains `dealtCombatDamage` — which is the list of damage that actually
  **landed**, so a swing a Fog or a shield stopped steals nothing. One list, one answer to "did it
  connect", rather than a second opinion in `dealCombatDamage`.

**Both are applied immediately rather than as triggered abilities, and that is a real
simplification.** In the rules each is a triggered ability the monarch controls, so at a real table
a Disallow could counter the crown changing hands. Nothing in this engine can put an ability on the
stack without a card to own it — `StackObject` is identified by its source card — so the crown moves
and the log says so. Written down here rather than discovered later.

**The button is refused on an automated table.** A designation the rules move cannot also be
something a player sets by hand: the two would disagree and the table would show a crown the engine
does not believe in. Refused in the engine rather than merely hidden in the UI, which is what the
commander-damage counters do, because this one the rules actually change.

**Measured, and the two cards came back different** (`scripts/measure/monarch.mjs`, 660 duels):

- A crown existed in **57 games** (the two cards are in two of eleven decks). It was given by a card
  57 times and **stolen in combat 142 times** — two and a half changes of hands per game it appeared
  in — while drawing **74 cards** in total. In a duel the crown is less a card engine than a reason
  to attack: it changed hands nearly twice as often as it drew anything.
- **Palace Sentinels** in Dawn Tithe measures **+15 of 240**, which is just under this instrument's
  noise floor (D86: 18 games) — but **not one of the ten matchups moved the other way**: eight went
  the deck's way by one to three games and two were level. Ten paired matchups all pointing one
  direction is a sign test at roughly p=0.004, which the floor's own derivation (a single total) does
  not cover. So this one is believed, carefully: it moves Dawn Tithe from 57% to about 63%, which is
  third in the pool and inside the existing spread rather than a new outlier.
- **Thorn of the Black Rose** in Ashen Rite measures **−2 of 240** with the matchups split five ways
  either side: level. The deckbuilding argument for putting it there — a deck with an unblockable
  creature can always take the crown back — is *also* the argument against it, because an aggressive
  deck with four removal spells is the deck most likely to be hit back. The card ships because the
  measurement says it costs nothing and the mechanic is worth having in two colours.
- **The correlation worth not over-reading**: the winner held the crown at the end in 53 of those 57
  games. That is almost certainly the winner taking the crown rather than the crown making a winner
  — stealing it requires connecting, and connecting is what winning looks like. The number is in the
  log because it is striking, not because it is causal.

**What is not done, and deliberately.** In a duel there is one player to attack, so the bot takes
the crown 142 times without being taught anything about it. In a **pod** choosing whom to attack is
a real decision and "prefer the player holding the crown" would be a bot rule worth having — but the
measuring harness is duel-only, and a behaviour change this project cannot measure is a weight, not
a fact. Left undone and written down.

## D157 — An instrument for the pod, and what it said about chasing the crown

**Decision: `scripts/measure/pod-duel.mjs` — two bots against two in a four-seat pod, seats
rotated — and the first rule it priced ships anyway, on grounds the measurement does not supply.**

Every harness in `scripts/measure/` was a duel, which made a whole family of questions
unmeasurable: goad, the deals, the threat read and "attack the player holding the crown" are all
about *which opponent*, and a duel has one. Those changes had been argued rather than priced.

**The design.** Each table seats two bots on `TESTED` and two on `CONTROL` and is played four times
with the arms rotated one seat each time, so each arm occupies every seat equally often and turn
order cancels. `ALWAYS=<deck>` seats one deck at every table, for a setting that only means anything
while a particular card is in the game.

**Its negative control is arithmetic, not evidence — and nearly fooled me.** With both arms empty,
all four rotations of a table are the *same game*: same seed, same decks, same bot. So one seat wins
all four, and the rotation credits that seat to `TESTED` on exactly two of them. It printed 66-66 of
132 and could not have printed anything else. `bot-duel`'s 56-56 is a real reading of a duel's
noise; this one is a tautology, and the first draft of the script's own documentation claimed it as
a floor. **The floor has to come from re-running a real arm on a disjoint seed set.**

**Which is what it took to get the answer.** `chaseTheCrown: false` against the default, with Dawn
Tithe seated at every table:

```
SEED0=3300 → 70-62   (the arm *without* the rule, ahead by 8)
SEED0=4100 → 62-70   (the same arm, behind by 8)
```

The result flips sign on a different seed set, so this harness wobbles by at least ±8 games in 132
and the rule measures **nothing at all**. That is the honest reading, and it is also the floor for
every pod measurement after this one.

**The rule ships on, and not because of the number.** Three reasons, in the order they matter:

1. It is a **fact about the board**, not a weight: the monarch draws an extra card at the beginning
   of each of their own end steps, and combat damage is the only thing that takes the crown. "Go at
   the monarch" is the one attack that does something no other attack can.
2. It is **level**, not worse. The project has deleted a bot change that measurably lost games
   (D98's untapped-creature term); this is not that.
3. It makes the bot **legible**, which is the part no instrument prices. A pod where nobody ever
   contests the crown looks broken to a person who knows the rule — and a table that plays its own
   mechanics visibly is most of what "it feels like a real game" means. Shipping on that ground is
   fine as long as it is said out loud rather than dressed up as a win, which is what this entry is
   for.

**What it does not do.** The switch changes only what the bot itself declares; inside its own search
the opponents are still modelled with the rule on, because threading a measurement control through
`scoreDeclaration` and `throughCombat` would be a larger change than the thing being measured. And
in a duel the rule is a no-op by construction — a test pins that the two settings are the same bot
when there is no crown in the game.

## D158 — Infect, the twelfth deck, and the combat bug infect found

**Decision: infect is a damage replacement read off the source, and it gets a whole deck rather than
three cards sprinkled into existing ones.**

Poison counters, `-1/-1` counters and the ten-poison elimination have been in this engine since it
was written, and **not one card in the pool produced a single point of any of them**: the second way
to lose a game of Magic was unreachable by construction. Infect (CR 702.90) is the keyword that
connects all three.

**Read off the source, like protection and deathtouch.** `dealDamage` asks `characteristicsOf` what
is dealing the damage, so a **granted** keyword costs nothing extra — Tainted Strike puts infect on
anything for a turn and the same branch handles it. Poison instead of life for a player, `-1/-1`
counters instead of marked damage for a creature, and **the commander tally still counts** (CR
903.10): infect replaces what being dealt the damage does to you, not whether it happened.

**One deliberate divergence, named.** The rules treat a planeswalker as a permanent here, so infect
damage would be `-1/-1` counters, which do nothing to something that is not a creature — an infect
attacker cannot touch a planeswalker at all. This engine removes loyalty as normal: a strange rule
against a strange table, nothing in the pool makes it common, and the divergence favours the
attacker rather than quietly eating their damage.

**A whole deck, because three cards would have been three dead cards.** Ten poison needs bodies that
connect over and over; a list with one infect creature has a bad card rather than a plan. Blight
Vector runs eighteen infect cards, eight of them new (Glistener Elf, Blight Mamba, Ichorclaw Myr,
Plague Stinger, Cystbearer, Phyrexian Crusader, Tainted Strike, and Skithiryx leading it).

**Infect found a real bug in combat damage, and it had been there since combat was written.**
`dealCombatDamage` read each blocker's power *after* the attacker's damage had already landed, so a
blocker that had just been shrunk hit back for less — a violation of CR 510.2, which says combat
damage is simultaneous. Nothing in the pool could change a creature's size mid-step, because marked
damage does not, so for two hundred and fifty cards the two readings were identical. A `-1/-1`
counter is a smaller creature *at once*, and the first test written for it watched a 3/3 Centaur
Courser deal one damage instead of three. Fixed with a snapshot of every combatant taken before any
damage is dealt. **The lesson is the one worth keeping: a rule that is only ever asked in cases
where two readings agree is a rule nobody has tested.**

**Measured** (`scripts/measure/poison.mjs`, 132 duels, and `deck-table` over 264 games a row):

- **Poison is reached, not theoretical**: poison was dealt in **80% of its games**, 884 counters in
  all, most in one game 17 — and **every single one of its 51 wins in the shipped version was a
  poison elimination**, none by damage. The win condition exists now.
- The deck lands **eleventh of twelve at 38%**, which is the bottom third and honest for what it is:
  it beats Tidal Mind 15-9 and Arc Tempest 14-10 and loses **3-21 to Ember Rush**. Every creature in
  it dies to one blocker; against a deck that curves out it is a turn too slow.
- **Twenty lands, which the instrument asked for.** The first version ran twenty-two and measured
  82-182; cutting a Forest and a Swamp for a fourth Elf and a fourth Myr came back **96-168, +14 of
  264**, seven matchups up and three down. Across two full table runs the row only moved +4, which
  is the honest caveat: the paired probe is the measurement designed to answer this and the table is
  not, so the land cut is kept on the probe's number with the table's written next to it.
- **The field moved, as it does with every new deck** (D108, D128, three times before this). Two
  movements are named in the setup doc rather than left to be noticed: Dawn Tithe up five points
  (Palace Sentinels, matching its own +15 probe) and **Tidal Mind down five to 22%, now the worst
  deck in the pool by sixteen points** — a balance question this table has now asked three times and
  nobody has answered.

**And a maintenance bug the twelfth deck exposed in the instruments themselves.** Seven of the
twelve harnesses in `scripts/measure/` had the deck list written out as a literal array. The first
table run after the new deck measured the same eleven-deck field as the day before and said nothing
about it. All of them now read `Object.keys(STARTER_DECKS)`. A list in seven files is a list that
goes stale in six of them, and a measurement that silently answers last week's question is worse
than one that fails.

## D159 — The worst deck in the pool, and the one card that was most of it

**Decision: cut Tidal Mind's Diabolic Tutor for a third Vampire Nighthawk, move the Tutor to Hollow
Tide, and stop there — six other candidate changes were priced and none of them did anything.**

The twelve-deck table had said the same thing three times: Tidal Mind last, 22%, sixteen points
behind the next deck. Three write-ups noted it and nobody acted, which is the failure mode this log
exists to catch — a number nobody owns.

**The diagnosis took one run of an instrument that already existed.** `cast-counts` on the deck:

```
 16%  cast  9 / in hand 55 games   Twincast
 17%  cast  8 / in hand 46 games   Diabolic Tutor
 38%  cast  9 / in hand 24 games   Counterspell
```

**Diabolic Tutor was the deadest card in any deck in the pool.** Four mana for a card you then have
to cast is a turn spent doing nothing, and a deck that spends turns doing nothing against a field
with a 77% aggro deck in it dies holding answers.

**The fix: a third Vampire Nighthawk, +27 of 264** — nine of eleven matchups up, two level, **none
down**, which is the largest and most consistent single slot change this project has measured. It is
the opposite card in every way that matters: three mana, flies, kills whatever it blocks, gains the
life back, and it is a clock and a wall at the same time.

**Six other changes were priced and six did nothing**, which is the more useful half of the result:

| change | result |
| --- | --- |
| Mind Rot → second Wind Drake | +2 |
| Twincast → third Man-o'-War | −5 |
| Cancel → third Man-o'-War | −6 |
| Mind Rot → second Dirgur Nemesis | −2 |
| Swamp → second Omenspeaker | −19 |
| Twincast → **fourth** Nighthawk | −13 |

The last two are worth keeping. Cutting a land from a 21-land control deck is not a tempo gain, it
is a mulligan; and the fourth copy of the card that was worth +27 is worth −13, which is diminishing
returns written in games rather than in theory. **The rest of the list is not the problem.** This is
still the deck whose plan — hold mana, answer the threat, win later — is the one the bot cannot
pilot, and that was already written down twice (D61, and the setup doc's note on Skyward Writ).

**The Tutor kept a home, because a script with no card is an orphan.** It went to Hollow Tide for a
Tome Scour and measured **−1 of 264** there: free. A tutor in a deck with two cards worth finding is
a different card from a tutor in a deck that just wants to untap.

**And a measurement trap worth more than the deck change.** The first version of the edit moved the
Nighthawk entry to where the Tutor had been, and the "same sixty cards" then measured **sixteen games
worse** than the variant the probe had approved. `deck:load` expands a list in **order** and shuffles
it afterwards, so the same multiset written in a different order is a different sequence of shuffles.
`deck-probe` builds its variant by adjusting counts **in place**, so a measured change has to be
applied in place too. Written into the deck list where the swap happened, because the next person to
ship a measured change will make exactly this mistake.

**Three tests broke on the move, and all three were right to.** Moving one card between two decks
failed a Diabolic Tutor script test, a whole-game test that asserts the bot answers mid-resolution
questions in the direction that helps it, and the view-payload budget test — because each of them had
named `tidal-mind` as the deck that happens to contain a tutor. That is the test suite doing its job:
a deck list is a fixture, and a fixture that silently stops containing the card the test is about
would have left three assertions passing on nothing. They now name the deck that runs the card
(`hollow-tide`), and the mid-resolution test names *both* decks on purpose — Tidal Mind for the Mind
Rot that asks a player to discard, Hollow Tide for the Tutor that asks its controller to search.

**And the new matchup found a real bug in that test's instrumentation.** Reading the chosen card's
cost out of the state *after* the choice was answered throws the moment the chosen card is a token:
Talrand's Drakes are in the field now, a token that reaches a graveyard ceases to exist (CR 111.7),
and its instance is gone by the next state. It reads out of the state the question was asked in
instead, which is also the more honest number — what a choice was worth is what it was worth when it
was made. Measured peak on the wire moved with the deck too: **25.7KB packed, 55.6KB inlined**,
against the 64KB cap.

## D160 — A card with two castable faces: the half is the spell

**Decision: give `CardDef` a `faces` field, register each face as its own card definition, and let
a cast point the card at one of them for as long as it is on the stack. Split cards and adventurer
cards then need no special case anywhere else in the engine.**

Four cards wanted a mechanic the engine did not have: one physical card with **more than one
castable face**. A split card (Fire // Ice) is two spells on one piece of cardboard and is never
cast as itself; an adventurer (Garenbrig Carver // Shield's Might) is a creature card that can
instead be cast as an instant, which then exiles itself and may be cast as the creature later.

**The whole design is one line in `characteristicsOf`.** `CardInstance` gained `castAs`, a def key
read in preference to `defKey`, and `relocate` clears it on every zone change but the one onto the
stack. That is the rule the engine needed (CR 708.4: a spell on the stack has the characteristics
of only the half being cast) and it buys everything downstream for free:

- the cost paid, the timing checked and the targets offered are the half's, because `legalActions`
  and `castSpell` both read `def` and both now read the face;
- the **script** that resolves is the half's, because the stack object's `cardKey` is the face;
- a counterspell's filter is handed a card id and looks up its characteristics, so "counter target
  creature spell" misses Venture Deeper and catches Merfolk Secretkeeper with no code at all;
- the card in the graveyard afterwards is the **whole** card, mana value four for a Fire // Ice —
  which is what a Chalice of the Void counts, and the rule rather than an oversight.

**Two refusals, which are opposite mistakes.** A split card cast with no half named is refused
("choose which half") rather than falling back to the first one, because a fallback casts the wrong
spell; and a card with no second face refuses a half outright, because a client sending one has
misread the card. The same pair of refusals the modes, the kicker and morph each have.

**The adventure's second half is one parameter.** `spellLeavesStack` already decided where a spell
card goes — graveyard, or exile for flashback — so the adventure went there too, with a `resolved`
argument the three call sites answer for themselves. An adventure that is **countered** never went
on an adventure, so its card goes to the graveyard like any other countered spell; only the one that
finished resolving is exiled with `onAdventure`, and only that flag makes the creature castable out
of exile. One test asserts each half of that.

**`halves-use.mjs`, and what it found.** `cast-counts` reads a card with two faces as healthy while
one of them has never been cast, which is the same blind spot `morph-use` exists for. Over 660 games:

| card | halves | came back |
| --- | --- | --- |
| Fire // Ice (arc-tempest) | Fire 26, Ice 3 | — |
| Wax // Wane (verdant-guard) | Wax 23, **Wane 0** | — |
| Garenbrig Carver (delta-bloom) | creature 4, Shield's Might 65 | **62 of 65 (95%)** |
| Merfolk Secretkeeper (hollow-tide) | creature 62, **Venture Deeper 1** | 0 of 1 |

Garenbrig Carver is the mechanic working as printed: the bot casts the instant, and then casts the
creature out of exile 95% of the time. **Wane is cast zero times** — "destroy target enchantment" in
a pool with four enchantments is a half that is usually not castable, which was written into the
script before it was measured and is now a number. And Merfolk Secretkeeper is the opposite
surprise: the bot takes the one-mana body and almost never casts the mill, which is a fact about the
evaluation rather than about the card.

**A half nobody casts is not the same as a bad card**, and this is the clean case: Wax // Wane
measured **+19 of 264** — nine matchups down for the old list, none up by more than one — because
the half it *does* cast is better than the Naturalize it replaced. Two findings, two instruments.

**All four changes, priced in reverse.** `deck-probe` looks a name up in the pool, so a card in no
deck cannot be priced; each change was therefore shipped first and then measured by probing the
*old* list as the variant, with the sign read the other way round:

| deck | change | worth |
| --- | --- | --- |
| verdant-guard | Wax // Wane for the Naturalize | **+19 of 264** |
| delta-bloom | Garenbrig Carver for the Harmonize | +5 of 262 |
| hollow-tide | Merfolk Secretkeeper for the Sign in Blood | −2 of 264 |
| arc-tempest | Fire // Ice for the last Shock | −8 of 263 |

Three of the four are inside the 18-game duel floor (D86) and one is above it. The twelve-deck table
is unmoved: 28%–78%, the same spread as before.

**And the cut was not the slot the cast-count pointed at.** `cast-counts` put Arc Tempest's Squelch
at **19%**, the deadest card in any deck in the pool, and cutting it would have taken the only
"counter target activated ability" out of every deck — orphaning a script, a definition and three
tests to buy one slot. The Shock went instead: cast in nine games out of ten and still the weakest
card in a deck that runs two Lightning Bolts, two Lightning Strikes, a Lava Spike, a Burst Lightning,
two Magma Jets and a Firebolt. **Cast rate measures how often a card is castable, not how much it
does when it is**, and the same reasoning saved Hollow Tide's Psychic Strike (35%, the pool's only
copy) at the cost of its Sign in Blood (62%, two other decks have one). The Squelch slot stays a
known-dead card with nowhere to go, written down rather than quietly cut.

**And a guard in the browser driver that did not guard.** The arena suite asks for a combat arrow
"only when a creature actually attacked", and the flag it asks that question with was set by
`declared 0 attackers` as well — a real and frequent answer, every turn whose only creatures are
summoning-sick. So the check could fail for a game that was fine, and after the deck changes moved
the shuffle, it did. `seen.swung` now needs `[1-9]\d*` attackers, and the three-second wait for the
overlay is skipped on an empty declaration rather than spent proving nothing. Found by changing four
deck lists, which is the second time this project has had a browser check that could not pass on a
board the game was entitled to build.

## D161 — The land on the back: a modal card is a `defKey` swap, not a third mechanic

**Decision: add `faces.kind: 'modal'` and play the back face by pointing the instance's `defKey` at
it, keeping the card in `printedDefKey`. The permanent then *is* the land, for every reader in the
engine, with no reader told that two-faced cards exist.**

A modal double-faced card (CR 712) has a spell on the front and a land on the back, and the land is
**played** rather than cast — it costs that turn's land drop. Two cards: **Hagra Mauling // Hagra
Broodpit** in Ashen Rite and **Vastwood Fortification // Vastwood Thicket** in Blight Vector.

**Why not `castAs`, which D160 built for exactly this shape.** `castAs` describes a card *on the
stack* and is cleared on the way off it, which is right for a split card and wrong for a permanent:
an MDFC that arrived as its back face is that face for as long as it is on the battlefield. The
mechanism that already does precisely that is the one copy effects use — `defKey` for what it is
now, `printedDefKey` for what it is printed as, and `relocate` restoring the second on the way off
the battlefield. So `playLand` sets both, and:

- the land's **mana ability** works, because `manaSources` looks the script up by `defKey`;
- it **enters tapped**, because `settle`'s arrival loop reads `entersTapped` off the same key — which
  is why the swap happens before `settle` and not after;
- the card in the graveyard afterwards is the **front face**, mana value three, which is CR 712.4a
  and came for free from the line that un-copies a Clone.

Sixty-three places in the engine look a definition up from an instance. Nought of them changed.

**The bot needed one fix and it was the same bug twice.** Its land tie-break — "play the land that
is ready now" — read `entersTapped` off the *card* rather than the face, so a Hagra Mauling looked
like an untapped land and got played over a basic Swamp that was free. Reading the face makes the
tie-break do the right thing for nothing: the basic goes first, and the flexible card stays in hand
until there is nothing better, which is how the card is meant to be used.

**`halves-use` gained the number the mechanic is actually for.** A 50/50 split of uses says nothing
on its own; what says something is whether the hand held another land at the moment the back face
was played. Over 660 games:

```
Hagra Mauling (ashen-rite, modal) — cast 60 over 60 games
  Hagra Mauling              30 (50%)  mean turn 10.6
  Hagra Broodpit             30 (50%)  mean turn 7.8
  played as a land with no other land in hand    30 of 30 (100%)
```

**Thirty land drops the deck would otherwise have missed, and not one tapped land played over an
untapped one.** The turns say the rest: the land goes down on turn 7.8 and the spell is cast on
10.6 — early as a land, late as removal, which is the card doing both jobs rather than one.

**And the first card in the pool that is never a dead draw.** `cast-counts` reads Hagra Mauling at
**100% — used in all 50 of the 88 games it was in hand**, because the worst case is a land. Every
other card in the pool has a floor set by how often it is castable; this one has none.

**Both changes are free, and the slot usage went up.** Hagra Mauling for Ashen Rite's Read the Bones
(31%, cast in 16 of 51 games in hand) measures **+2 of 263**; Vastwood Fortification for one of
Blight Vector's two Titanic Growths (23%, cast 7 of 30) measures **−4 of 264**. Both inside the
18-game duel floor (D86), and both slots are used more often than before: Vastwood Fortification is
33% against the Titanic Growth's 25%. The twelve-deck table is unmoved — 28%–78%, Ashen Rite 42%
against 44%, which is the same two points the probe put inside the floor.

**One shape deliberately left unbuilt**, and written into `CardFaces` rather than discovered later:
a modal back face that is a *spell* resolving into a permanent — a creature on the back of a sorcery.
`castAs` would clear as it left the stack and the permanent would arrive as its front face. Nothing
in the pool is one, so the branch is not there; a card that needs it should add it with a test.

## D162 — A static that comes and goes, and three measurement traps found measuring it

**Decision: add `ContinuousEffect.while`, a condition asked every time the effect is read, and put
metalcraft behind it. Chrome Steed, Etched Champion and Galvanic Blast go into Forge Alliance, which
already controlled ten artifacts and counted none of them.**

Every continuous effect in the engine had the same life: created, applies for a duration, expires.
"As long as you control three or more artifacts" is a different shape — there is no moment at which
it turns on. The board changes and the creature is a 4/4; something leaves and it is a 2/2 again,
with nothing announced and no trigger to watch.

**Asked, not stored, and data rather than a predicate.** `conditionMet` runs inside
`effectApplies`, which is the same answer `definesSize` already gives for a size that is a count of
the board (D94). A predicate would have been shorter and wrong: `state.effects` is part of the game
state and the state is serialised to Redis, so a function in there would not survive the trip. One
`kind`, because one card shape needs one count — the rule D57 is about.

**Counted off the printed type line, and that is load-bearing.** `conditionMet` is called from
inside `characteristicsOf`, so asking a permanent for its *current* characteristics there would
recurse until the stack ran out. Nothing in the pool gives something the artifact type, so printed
and current are the same answer for every board that exists; a card that changed that would need
this count in a pass of its own, the way layer 4 has one.

**Three cards, and only two of them needed any of it.** Chrome Steed (+2/+2) and Etched Champion
(protection from all five colours) are conditional statics. **Galvanic Blast is the contrast**: one
damage or four, read **once** as the spell resolves, so it is an ordinary `onResolve` that counts
the board. A condition only needs to live in the effect when the thing it controls persists — and
the difference is visible at the table, because answering an artifact while the Blast is on the
stack turns it back into a Shock. One test asserts exactly that.

**What the new instrument says, which is the point of having it.** `metalcraft.mjs` samples the
condition once per turn for every such permanent on the board, over 660 games:

```
Chrome Steed (forge-alliance, needs 3)
  on the board for 152 turns over 32 games
  condition met on 85 of them (56%), mean artifacts 2.6
Etched Champion (forge-alliance, needs 3)
  condition met on 11 of 16 turns (69%), mean artifacts 3.1

Galvanic Blast: 43 casts, 9 for four damage (21%)
```

The **mean count beside the share** is the half that makes it useful: 56% on a mean of 2.6 is "nearly
there, often", and 56% on a mean of 0.8 would be "never close, occasionally lucky" — the same
percentage and two different cards to fix. Galvanic Blast is mostly a Shock (21%), which is an
honest reading of a one-mana spell in a twelve-artifact deck rather than a complaint.

**The bundle measures +9 of 264 on one seed set, +8 of 263 on a second — and the twelve-deck table,
on a third, puts Forge Alliance four points *lower* than before.** All three are inside the 18-game
duel floor (D86), so the honest reading is that the change is **free rather than good**: two paired
probes agreeing on +8 and +9 is not enough to outvote a −12 from the table's own seeds, and a
measurement at the floor is a measurement the instruments cannot resolve. Written down as three
numbers rather than as the two that flatter the change. It cost one of two Ajani's Pridemates (65%),
the Disenchant (69%, the same complaint that priced Wane) and one of two Hellriders. The two new creatures are artifacts themselves, so the
deck's count went from ten to twelve — the cards that read the condition are part of meeting it,
which is how the printed mechanic works.

### Three traps in the instruments, all found by this one change

**1. A 1-of's denominator in `cast-counts` is a handful of shuffles, not a handful of games.** At
`SEEDS=4`, two 1-ofs in the same deck read **"in hand 54 games" and "in hand 4 games"** — which
looked like a fact about the cards and is a fact about four libraries. The seed drives the shuffle,
so 88 games are built from four of them, and whether a single copy sits near the top or the bottom
is most of its count. At `SEEDS=12` the same pair read 84 and 29. Read the **rate** (cast ÷ in
hand), never the denominator, and distrust a 1-of's row below a dozen seeds.

**2. An instrument that cannot see a mechanic prints zero for it.** `cast-counts` reads Forge
Alliance's **Disrupt Decorum at 0% — never cast in 24 games it was in hand**, which looks like the
deadest card in the pool and is nothing of the kind: goading every creature you do not control is a
pod card, and this harness plays duels, where there is nobody else for a goaded creature to attack.
It stayed in the deck. A cut made on that reading would have removed the pool's only goad card for
being unmeasurable rather than for being bad.

**3. "Cast every game" and "does what it says" are different questions.** Etched Champion is cast in
**28%** of the games it reaches hand — a 1/1 body for {3} scores badly in the evaluation — while its
*ability* is live 69% of the turns it is on the board. The card is strong for a person and weak for
this opponent, and only two instruments together say so.

## D163 — The thirteenth deck, and the gap only a card could show

**Decision: build Kindle Grove, a red-green deck, because twelve decks covered every pair of colours
but that one — and nothing noticed until a card had nowhere to live.**

Assault // Battery is {R} on one half and {3}{G} on the other. When the split cards shipped (D160),
Fire // Ice went into Arc Tempest and Wax // Wane into Verdant Guard, and the third card of the
cycle was left out because **no deck in the pool could cast both halves**. A hole in a card pool is
easier to see from a card than from a list of decks, which is the useful part of this entry.

**Eight new cards and no new machinery**, which is the claim the deck is really testing. The
vocabulary has been ahead of the pool for a long time; this is what that is worth:

| card | what it needed |
| --- | --- |
| Ruric Thar, the Unbowed | a `spell-cast` trigger with `actor`, and `mustAttack` on `all-creatures` |
| Assault // Battery | the split-card machinery from D160, unchanged |
| Burning-Tree Emissary | an `etb` trigger and `addToPool` |
| Gruul Ragebeast | the `etb` event's `subject`, plus the `fight` Prey Upon already had |
| Savage Twister | the {X} that has been in the engine since the fifth deck |
| Rancor | a `dies` trigger on a permanent that is **not** a creature (corrected in D179: the card says *from anywhere*, so it is a `to-graveyard` trigger) |
| Thragtusk | `leaves`, which fires for exile and bounce as well as death |
| Gruul Guildgate | the `guildgate` helper |

`fight` was pulled out of Prey Upon into a function the Ragebeast shares, because both halves have
to be read before either is dealt (CR 701.12a) and writing that twice gets the simultaneity wrong
eventually.

**Two bugs found by two cards, and both were in the engine's edges rather than in the cards.**

**1. An absent `actor` means "me", and reading it as "nobody" is silent.** `raise` leaves `actor`
off the stack object when the actor is the trigger source's own controller — free while every card
asking "that player" asked about an *opponent*, which every card before this one did. Ruric Thar
taxes the table **including its own side**, and the first version dealt no damage at all to its
controller: `c.actor` was undefined and the effect returned the state unchanged. A card reading that
field wants `actor ?? controller`, and `StackObject.actor` now says so.

**2. `makesMana` is for a spell whose *whole* effect is mana, and the field's own doc says so.**
Burning-Tree Emissary was declared with it, and the bot then held a 2/2 in hand waiting for a second
spell to spend the mana on — which is the Dark Ritual rule (D63) applied to a card that does not
want it, because a creature's body is priced by the evaluation already. Measured both ways on the
same 192 games: **46% cast with the flag, 101% without it** — which is both copies cast in every
game one was drawn.

**It debuts fifth of thirteen at 59% (170-118), and the row is its matchups.** It beats **Tidal Mind
20-4**, Ashen Rite 19-5, Rot Harvest 17-7, Hollow Tide 16-8, Delta Bloom 16-8, and loses 10-14 to
each of the three decks above it. A commander that costs the whole table six life per noncreature
spell is close to unanswerable for three control decks and four turns too slow against a 76% aggro
deck. **The limit was named in the deck's own write-up before it was measured**, which is the only
honest way to publish a 59%: the bot plays a deck of big creatures better than it plays a deck of
answers, so this row reads higher than a person would make it — the exact opposite of Tidal Mind's
problem and the same cause.

## D164 — Evasion priced against the board: built, measured, deleted

**Decision: do not keep a term that values a flier by whether anything opposite it can block. Level
at every weight that changes anything, and 8% slower.**

`KEYWORD_VALUE` prices flying at 1.5 whatever is in front of it, and that is two different cards: a
2/2 flier against a board with no flying and no reach is an unanswerable clock, and the same 2/2
against two Giant Spiders is a 2/2. Nothing in the evaluation could tell those boards apart — which
is the first thing a person reads off a battlefield, so it was worth asking properly.

**The term.** A creature with flying whose controller's opponents have nothing with flying or reach,
or one that simply cannot be blocked, is worth **its power again** times a weight. Asked once per
`seatValue` rather than once per creature, so the extra work is one scan of the opponents'
battlefields rather than one per creature — O(n) instead of O(n²) in the hottest loop the bot has.
Added to `seatValue` rather than to `creatureValue`, deliberately: `creatureValue` is read by the
*combat* heuristics too, and there the question is already asked properly.

**Level, on the paired bot-against-bot instrument, 936 games a run with thirteen decks in both
seats:**

| weight | seeds 3300 | seeds 8800 |
| --- | --- | --- |
| 0.5 | 467-469 | 470-464 |
| 1.0 | 471-465 | — |
| 2.0 | 468-468 | — |

**The negative control is exactly 468-468** — the same bot in both arms — which is what makes those
rows readable as level rather than arguable, and is the reason the README insists on running it.

**And it is a real wash rather than a setting that never fired**, which is the other check the README
insists on: `disagree.mjs` says **83 of 30,176 decisions differed**, 51 of them casts, 20
activations, 11 blocks. The term changed the bot's mind 83 times and won nothing for it.

**It also costs time.** Identical arms on identical seeds, which is the clean comparison: **157s
with the term off, 169s with it on** over the same 936 games — about 8% for nothing.

**The lesson is narrower than the idea.** The bot's attacks and blocks *already* ask whether a
creature can be blocked: `canBlock` knows, and the combat heuristics read it. What the evaluation
was being asked to add is a judgement about the **next few turns** — "this creature will keep
getting through" — and a bot that cannot plan a turn ahead has nothing to do with that. Which is the
same answer the mana-up term got (D117/D119), for the same underlying reason, and the sixth
evaluation term to be deleted with its numbers kept.

## D165 — The mill deck does win by decking, and the instrument came with the fix attached

**Decision: write `mill.mjs`, and act on what it said — a third Fog Bank for Hollow Tide's Essence
Scatter, because the deck needed *turns* rather than more mill.**

Drawing from an empty library has been an elimination in this engine since it was written
(CR 104.3c), and Hollow Tide is thirteen cards' worth of trying to cause it. Nobody had ever
measured whether it happens. Poison got an instrument the day it shipped (D138); milling had gone
without one for five deck revisions.

**What it found, over 144 games:**

```
hollow-tide: 48-96 of 144 [33%]
milled 2594 cards off its opponents (18.0 a game, most in one: 48)
  the opponent's library got down to 24.3 on average, 0 at its lowest
  games it decked somebody: 23 (16%)
  wins by empty library: 23, wins by damage: 25
```

**The plan works and the clock does not.** Half the deck's wins were already empty libraries — this
is a second archetype rather than a theoretical one — and at the same time the opponent's library
was **still at 24 on average when the game ended**. A deck that leaves its win condition at 24 is
not short of mill; it is short of turns. That is a hypothesis a win-rate cannot produce.

**So the two candidates were priced against the same cut**, which is the README's own rule: a fourth
Mind Sculpt (more mill) at **+12 of 288** and a third Fog Bank (more turns) at **+16**, and **+23**
on a second seed set. Four games between the two adds is deep inside the floor, so the honest
reading of the probes alone is "most of the gain is the cut" — the Essence Scatter was the deck's
fourth counterspell and the answer it had most of.

**And then the instrument showed the mechanism, which is the part a win-rate could never give.** The
same measurement after the change:

| | before | after |
| --- | --- | --- |
| milled a game | 18.0 | **22.1** |
| opponent's library at the end | 24.3 | **19.9** |
| games it decked somebody | 23 (16%) | **40 (28%)** |
| wins by empty library | 23 | **40** |
| wins by damage | 25 | 18 |
| record on those seeds | 33% | **40%** |

**One extra blocker bought four more cards of milling a game and nearly doubled the mill wins.** The
deck did not get better at milling; it got to keep doing it for longer, which is exactly what the
instrument predicted and the probes could not distinguish. The thirteen-deck table agrees from a
third seed set: Hollow Tide 38% → 40%.

This is the clearest case this project has of **instrument the mechanism, not just the record** —
written into the measurement README beside the deck-probe caveat it corrects.

## D166 — What kills the worst deck, and why Hollow Tide's fix did nothing for it

**Decision: write `killed-by.mjs`; ship no change to Tidal Mind, because the two blocker adds the
instrument pointed at measure −2 and +4 of 288 — and record *why* they do, which is the useful part.**

Tidal Mind is 28% on the thirteen-deck table, eleven points below the next-worst deck, and three
balance passes have moved it two points. D165 had just shown that instrumenting the *mechanism*
produces the fix, so: nothing instrumented **how a game ends**.

**What it records, per loss:** what took the last of the subject's life (combat, or the name of the
spell or ability — attributed by watching the life move and reading the action that moved it), the
turn, and how many cards were still in hand. For a win, the turn and the life left.

**Tidal Mind, 144 games:**

```
it loses on turn 23.1 of the table's (about its own turn 11.6), holding 3.5 cards
it wins on turn 27.6 with 21.2 life left

how it died:        89 life (87%), 7 library (7%), 6 poison (6%)
what took the last: 78 combat (76%), then eleven single-copy spells
```

**It does not lose fast, and it does not lose to spells.** Three quarters of its deaths are combat
damage, the games run to the table's twenty-third turn, and it dies **holding three and a half
cards**. That is not a deck short of answers or short of time.

**The contrast is what made the reading sharp.** The same instrument on the best deck in the pool:

| | Tidal Mind (28%) | Ember Rush (80%) |
| --- | --- | --- |
| wins on table turn | 27.6, with 21.2 life | **15.5**, with 15.6 life |
| loses on table turn | 23.1 | 19.1 |
| cards in hand at death | **3.5** | 1.1 |
| deaths to combat | 76% | 93% |

Tidal Mind's games run **twelve table turns longer** than Ember Rush's *wins*, and it is still
holding cards when they end. The deck has the time and cannot use it.

**Which is why Hollow Tide's fix did nothing here, and that is the result worth keeping.** A third
blocker took Hollow Tide from 33% to 40% because that deck converts turns into an empty library.
Priced against Tidal Mind's weakest shared slot — its single Counterspell, 38% in `cast-counts` and
one of five counters in the list — the same shape of change measures **−2 of 288 for a second Fog
Bank and +4 for a second Wall of Frost**. Both deep inside the floor. So nothing ships, and the
conclusion is not "the pilot is bad" (which is where the last three passes stopped) but something a
deck list can act on: **the deck needs a clock, not more time**. Its threats are a commander that
makes a 2/2 flier per spell, three Vampire Nighthawks and an Air Elemental, and 21.2 life left in
its wins says it is never close to losing the games it wins — it simply does not finish the others.
Whoever tries next should add a way to win, and `killed-by.mjs` will say whether the turn number
moved.

## D167 — Six slots at once: the change that worked after twelve that did not

**Decision: rebuild six of Tidal Mind's sixty slots rather than price another one; relocate the two
cuts the pool could not afford to lose; and split the playout harness's attacker-loss assertion into
the three different things it had been adding together.**

D166 left a brief: *the deck needs a clock, not more time*, and `killed-by.mjs` will say whether the
turn number moved. This is that work, and the useful part is not the deck list.

### Twelve probes found nothing, and the thirteenth found +42

Every change to this deck has been priced one or two slots at a time, and all of them read as
noise: a second Air Elemental **−14**, a second Exsanguinate **0**, cutting the Fog Bank **−2**,
cutting the Wall of Frost **+4**, one Thieving Magpie for one Counterspell **−14**, and the best of
them — two Magpies for a Counterspell and a Cancel — **+6, +37, +23 and −6** across four seed sets
of 288 duels.

**Those four numbers are the finding.** The same four seed sets measure the *unchanged* list at 83,
64, 88 and 90 wins, so a twenty-game swing is what this instrument does when nothing has changed at
all. Eleven of the twelve probes were inside that, and the twelfth straddled it.

Six slots are not:

| | seeds 3300 | seeds 8800 |
| --- | --- | --- |
| stock | 83-205 | 64-224 |
| **the rebuild** | **130-157 (+47)** | **102-186 (+38)** |
| Magpies + Witch only (3 slots) | 91-197 (+8) | 84-204 (+20) |
| Aerialists + Thorn only (3 slots) | 95-191 (+12) | 83-205 (+19) |

**Each half is inside the floor and the whole is more than the two of them added up.** That is the
result worth keeping, and it generalises past this deck: a deck that loses for want of a clock does
not have a *slot* wrong with it, it has a *shape* wrong with it, and a shape is not priceable one
card at a time. Twelve probes found nothing because they were all asking a question whose answer is
no.

What went in: **two Thieving Magpies** (a flier that draws when it connects — the clock and the card
advantage on one body), **a Sedgemoor Witch** (3/2 menace, ward {3}, a 1/1 per instant, in a deck
still holding fifteen), **two Bloodthirsty Aerialists** (a flier that grows off three Nighthawks'
lifelink) and **a Thorn of the Black Rose** (deathtouch, and the monarch — the Phyrexian Arena's job
done by something that also blocks). What came out was the six lowest-cast cards: the Twincast
(20%), the Phyrexian Arena (44%), the Counterspell (40%), the Behold the Multiverse (48%), the Mind
Spring (73%) and the Fog Bank.

### The instrument answered the question it was asked

`killed-by.mjs`, same 144 games and same seed set as D166's baseline:

| | before | after |
| --- | --- | --- |
| record | 42-102 (29%) | **77-67 (53%)** |
| wins on table turn | 27.6, with 21.2 life | **24.9**, with 20.6 life |
| loses on table turn | 23.1, holding 3.5 cards | 24.8, holding 3.1 cards |
| deaths to combat damage | 76% | 66% |

**The clock moved the clock.** Its wins come nearly three table turns sooner and from the same
comfortable life total — it was never close to losing those games, it just took too long to end
them. `cast-counts` agrees from the other side: the four new cards are cast in 77%, 78%, 79% and
112% of the games they reach hand, where the six cut cards sat between 20% and 48%, and the deck's
deadest slot is now **Cancel at 34%** rather than the Twincast at 20%.

### The pool's orphanage, which is why two cuts had to move rather than go

**Nineteen of Tidal Mind's forty-one card slots were the pool's only copy of that card.** It is
where every card no other deck wanted ended up — the Twincast, the Clone, the Turn to Frog, the
Cackling Counterpart, the Robe of Mirrors, the Icy Manipulator, the Chalice of the Void — and
cutting the last copy of a card deletes its script's only test. So the deck at the bottom of the
table was also the deck holding the pool's script coverage hostage, and that, not the measurement,
is what had bounded every previous pass.

Two cuts moved instead:

- **Twincast → Arc Tempest**, for its second Behold the Multiverse: **+3 and +2**, free. The card
  was tried there before and measured out at about −9 in the *burn* slots; the same card in the same
  deck, in a cantrip's slot rather than a Lava Spike's, is free. The slot is the whole difference.
- **Phyrexian Arena → Ashen Rite**, for its Sedgemoor Witch: **0 and −12**. That is the entire price
  of this change, and it is paid by the strongest deck in the field, so the spread narrows at both
  ends.

One more change shipped **without** clearing the floor, and it is labelled as such in the source: an
Island became a Swamp, **+2 and +3**. It ships on the pips — the rebuild added four black cards and
two double-black ones against nine black sources — and the measurement's job was only to show it
costs nothing.

### The harness was counting three things as one

The rebuild turned `playout.test.ts`'s attacker-loss assertion red: 44 of 336 attackers died, 13.1%,
against a threshold of 12%. It was not a regression, and finding that out fixed the instrument.

Of the 44: **7 sacrificed themselves** (Ball Lightning is sacrificed at the beginning of the end
step whatever happens to it, so attacking with it costs nothing and *not* attacking wastes the
card); **10 traded**, killing something that blocked them; **27 were thrown away** — dead with the
defender's board intact. That last is 8.0%, and it is the only one of the three the test's claim was
ever about. The three are now counted apart, with the raw rate still asserted loosely so a policy
that attacked into everything would still fail. The comment above the test had already recorded this
number drifting twice as the pool grew; this is why it drifted.

Twenty-three tests also moved deck: a test that pulls a Counterspell out of Tidal Mind's library
has to pull it out of Hollow Tide's now. Two could not simply move — the Cackling Counterpart and
the Fog Bank stopped sharing a deck, so that test builds a two-card pasted list instead, and the
Sedgemoor Witch's magecraft test casts a Think Twice rather than a Lightning Bolt because the Witch
now lives in a blue deck.

### What the thirteen-deck table says

288 games per deck on a third seed set (`SEEDS=12 node scripts/measure/deck-table.mjs`, seeds from
4400), against the same run before the change:

```
 77%  223-65   ember-rush     (76%)
 64%  183-105  dawn-tithe     (65%)
 63%  181-107  verdant-guard  (63%)
 57%  165-123  forge-alliance (58%)
 57%  164-124  kindle-grove   (60%)
 55%  158-130  skyward-writ   (58%)
 43%  124-164  arc-tempest    (40%)  ← the Twincast
 43%  124-164  delta-bloom    (44%)
 41%  117-171  ashen-rite     (41%)  ← the Arena for the Witch
 38%  109-179  rot-harvest    (39%)
 38%  108-180  blight-vector  (38%)
 37%  107-181  tidal-mind     (28%)  ← the rebuild
 37%  106-182  hollow-tide    (40%)
```

**+9 points, and the cliff at the bottom of the table is a cluster.** Tidal Mind spent five runs
eleven points below the next-worst deck; the last four rows are now 38, 38, 37 and 37, and the whole
field spans forty points where it spanned forty-eight. Arc Tempest's +3 is the only movement in the
run a probe predicted beforehand (+3 and +2 for the Twincast), which is the sort of agreement worth
noting when it happens. Ashen Rite did not move at all here despite paying the price on two other
seed sets, and Hollow Tide lost three points **with no card of its changed** — the standing caveat
that a `deck-table` percentage is a statement about a field rather than about a deck.

**What is left, and it is the same thing it has been:** the counterspells. The deck's deadest card
is now Cancel at 34% and Disallow at 51%, and holding mana for an answer is still the one thing the
bot cannot do. That is a pilot problem rather than a list problem, and the honest expectation is that
a person plays this deck above 37%.

## D168 — Why the counterspell is still in hand, and what happens when it is not

**Decision: write `held-answers.mjs`, which says where a counterspell's windows actually go; build
the reservation rule it asks for; and measure it against the bot without it rather than shipping it
on the strength of the mechanism.**

Three decks' records have been explained by the same sentence for months, written down three times
in three different files: holding mana for an answer is half the plan of Tidal Mind, Skyward Writ
and Arc Tempest, and the bot cannot do it. **Nothing had ever measured which part of that was
true.**

### Six ends a counterspell can meet

The instrument counts one *window* per (opponent's spell on the stack, answer in hand) and asks
`legalActions` — the same function the table and the bot read — what it would offer:

- **cast** — the window opened, the mana was there, and the bot spent it.
- **answered by the other card** — the spell was countered, by a *different* answer in the same
  hand. Nothing was declined; this window is the same decision counted twice.
- **genuinely declined** — the window opened on a move this seat was making, the mana was there, and
  the bot chose something else. A judgement problem; only an evaluation change helps.
- **never offered** — the pair was only ever seen on a move this seat was not making, so there was
  no decision to get wrong.
- **no mana** — it could not pay. A tempo problem.
- **no target** — nothing the card could legally point at.

**The middle two were added after this entry was first published, and they correct the numbers it
published.** The first instrument had four buckets and folded both into `passed`, which is the one
column a reader draws a conclusion from. Both inflated it, and for the same underlying reason — one
window per (spell, answer in hand) is the right unit for *could this card have been cast* and the
wrong unit for *what did this seat decide*:

- A hand holding two answers facing one spell is two windows, so spending either leaves the other
  looking passed over. **26 of Skyward Writ's 31 "declines" were `cast Counterspell`.**
- A pair is usually first seen on a move this seat was not making, and where no later sighting on
  its own move exists there was never a decision at all. **8 of Tidal Mind's 14 were those.**

Everything below is the corrected instrument, both arms re-run against the current pool. What it
supersedes is listed at the end of this entry.

**144 games each against the twelve-deck field, the rule off:**

| deck | windows | cast | the other card | **declined** | never offered | **could not pay** | no target |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tidal Mind | 229 | 7% | 0% | **0%** | 0% | **87%** | 6% |
| Arc Tempest | 151 | 12% | 0% | **3%** | 0% | **77%** | 8% |
| Skyward Writ | 218 | 30% | 7% | **0%** | 1% | **54%** | 8% |

**It is not a judgement problem.** The bot almost never gets to *make* the bad choice D69 found:
over 229 of Tidal Mind's windows it declined an affordable answer **not once**. It is a tempo
problem with a precise shape — a seat that taps out in its own main phase has no mana for the whole
of the opponent's turn, because lands untap in their controller's own untap step. And the severity
tracks the counter's **cost** exactly: Skyward Writ's {U}{U} Counterspell is cast in 30% of its
windows, where Tidal Mind's {1}{U}{U} Disallow was cast **4 times** against **118** windows it
could not pay for.

### The instrument could not see any of it until priority moved

The first version saw almost nothing: across 24 games there were 163 moments with an opponent's
spell on the stack, and the subject seat was offered priority in **three** of them. That is not a
bug in the engine, it is auto-pass doing its job — it passes for a seat whose only legal move is to
pass, inside the same applied action — and it means the 160 moments the harness could not see were
exactly the ones it existed to explain.

So the question is put to the engine with `priority` moved to that seat on a local copy of the
state: *if you were asked now, what would you offer and what would you refuse?* Nothing is applied.
This is the second instrument in a week to find that **the thing it was built to count is the thing
the engine never stops to ask about** — the first was the combat arrow that is never on screen
because auto-pass runs the whole of combat inside one action. Both are now written into the
measurement README, because an instrument that reads `legalActions` for a seat that is not acting
will print a confident zero.

### The rule, and why it ships at level

A **filter**, not a weight, and that distinction is the whole of why this attempt is different from
the two that were deleted. A weight can only say "untapped mana is worth a little", and the search
then spends it anyway on whatever is worth more *right now* — correctly, because the thing the mana
is for is on the far side of the search horizon. A filter says "not that one" and leaves every other
play on the table. It is the thirteenth member of the drop-this-option family in `botAction`, beside
the ritual that buys nothing and the Fog with nothing attacking.

Four conditions keep it narrow: this seat's own turn at sorcery speed (responding is what the mana
was saved for); the **cheapest** answer in hand only; affordable before the play and unaffordable
after, so a turn with mana to spare costs nothing; and never the answer itself. One more was added
after the first measurement — **nobody to answer**: a player with no cards in hand is not going to
cast a spell, and the fastest decks in this pool empty their hands by about turn six, so without
that clause a control deck spends the rest of those games holding mana up for nothing. It is worth a
consistent +8 to +12 on matched seeds.

**What it fixes, measured:**

| Tidal Mind's windows | rule off | rule on |
| --- | --- | --- |
| windows | 229 | 208 |
| cast | 7% | **44%** |
| the other card | 0% | 0% |
| declined | 0% | 3% |
| never offered | 0% | 4% |
| **could not pay** | **87%** | **41%** |
| no target | 6% | 8% |

**What it is worth, measured twice:**

- Bot against bot, three seed sets of 2808 paired duels: **+72, +17 and +2**. The right sign three
  times, and the per-set spread is 70 games, so this is **inside the floor**. (The rule without the
  empty-hand clause: +60, +7, −6.)
- The thirteen-deck table, the same seeds both ways, 288 games per deck: the five decks that hold
  counterspells moved **+1 between them** — Hollow Tide +4, Tidal Mind +2, Arc Tempest −1, Skyward
  Writ −2, Delta Bloom −2. The three fastest decks each gave up a point or two, which is the right
  direction for "their opponents now answer things".

**It ships on by default anyway, and the reason is not the record.** Level is level, and this project
deletes terms that measure level — but every member of the filter family shipped because the *play*
was wrong rather than because it won: a Fog cast with nothing attacking has done nothing at all,
whatever the win rate says. A counterspell held with no mana for it is the same kind of wrongness,
and the asymmetry with the deleted terms is real: those cost a scan of the board on every
evaluation, this costs one affordability check on the bot's own turn while it holds an answer. The
deciding question was whether fidelity cost the control decks anything, and the table says it does
not. So the engine's opponent now plays its counterspells, and `reserveForAnswers: false` is the
control it was measured against.

**The honest limit, written where it bites.** The reservation is only as good as the payment, and the
payment is not trying to help it: the engine taps to pay the cost in front of it with no opinion
about what is being held back, so with three Islands and two Swamps a {1}{U} creature can be paid
for with two Islands, leaving one blue source where a {1}{U}{U} answer needs two. The rule then drops
a play a smarter payment would have allowed. It errs towards holding the answer, which is the
direction it exists to err in; a payment solver that preferred to leave a named cost payable is its
own piece of work.

**And the next problem is now reachable, which is the other reason to ship it.** With the rule on,
Tidal Mind casts an answer in 44% of its windows against 7%, and the windows it declines are now
visible at all: six of 208, where before there were none. Six is not a judgement problem, and
**D170 is the measurement that says so** — what the bot did instead was another answer every time,
and the spells it let through are the cheap ones. D69's judgement problem does not appear once the
bot can pay.

### Corrections to this entry

Published first and superseded above, in this file, in `claude/arena-engine-2026-10-23.md`,
`claude/play-realm-setup.md`, the `spendsAnAnswersMana` comment in `bot.ts` and the
`held-answers` describe in `playout.test.ts`:

- the four-bucket control table (`4%/0%/92%/3%`, `11%/3%/79%/7%`, `28%/8%/56%/7%`) — the `passed`
  column included windows another card answered and windows this seat was never offered;
- the before/after table reading `4% → 48%` cast and `0% → 11%` passed;
- "it declines an affordable answer in about one window in nine" — it is one in 35;
- "it declined a Shivan Dragon four times in 96 games" — once, in 144;
- the mana-value proxy "2.4 countered against 2.9 declined" — it is **2.6 countered against 2.0
  declined**, which points the other way: the spells it lets through are the cheaper ones.

The rule itself was not measured by the broken buckets — it was priced by `bot-duel` and the
thirteen-deck table, which read win rates and not windows — so nothing about what shipped depends
on the correction.


## D169 — The event every deck raised every turn and nothing watched

**Decision: add `draws` as the fifth member of the detect-rather-than-announce family, recorded
where a card is actually drawn rather than noticed afterwards; script the two cards that read it,
one per half of the event; and offer no `any` option, because nothing in this pool wants one.**

`draw` in `effects.ts` is the single choke point for every card anybody draws — the draw step, the
crown, and about two dozen card effects all come through it — and it announced the fact to nobody.
So the most frequent event in the engine was the one event no card could read, and a whole shelf of
printed Magic was unwritable: Chasm Skulker, Underworld Dreams, Niv-Mizzet.

### Why it is recorded and not compared

`died`, `entered` and `left` are all found by looking at the board afterwards, and `life-gained` is
found by comparing two life totals. A draw cannot be found either way, and the two failures are
opposite:

- **A card arriving in a hand is not a card being drawn.** A Diabolic Tutor, a Gravedigger and a
  Man-o'-War all put a card in a hand without anybody drawing one. A hand-size comparison fires
  "whenever you draw a card" on all three, and the rules say it fires on none of them.
- **A draw does not always change hand size.** Draw a card and discard it in the same breath and the
  comparison comes out level, so the trigger that should have fired does not.

So `draw` appends one entry per card that actually arrived — `dealtCombatDamage` is the precedent,
the other member of the family that has to be recorded rather than compared — and `settle` drains
the queue. **Per card rather than per draw**, which is what the rules say (CR 121.2) and what makes
a Chasm Skulker three counters bigger for a Harmonize rather than one. And only for cards that
really arrived: a seat drawing from an empty library draws nothing and loses the game, and nothing
should trigger off the card it did not get.

Draws are raised **before** the deaths and arrivals in the same pass, which matters for exactly one
reason and it is not subtle: a Chasm Skulker that draws a card as it dies should take its counter
before the death trigger reads how many it has.

### Two cards, and the option with no card behind it

`by` works the way it does on `spell-cast` rather than on `life-gained`: `you` by default,
`opponent` said out loud. The three-way `any` is **not offered**, because nothing printed in this
pool wants it and a trigger option nothing fires is worse than no option — the same rule that keeps
`becomes-tapped` the one trigger in the engine with no card behind it.

- **Chasm Skulker** ({1}{U}{U} 1/1) in Hollow Tide, for a second Compelling Argument. Its second
  half reads **counters the permanent no longer has**: it is in a graveyard by the time the ability
  resolves and `relocate` took its counters off on the way, as the rules require, so the number
  travels with the event through `EffectContext.subjectCounters`. Hangarback Walker found that path;
  this is the second card on it and the first whose counters were put there by a trigger rather than
  paid for. It leaves a 1/1 **islandwalker** per counter, which needed a script on the token —
  flying on the Thopter is read straight off oracle text by `printedKeywords`, and landwalk is a
  land *type* plus a rule, so the Squid declares it the way River Boa does.
- **Fate Unraveler** ({3}{B} 2/4) in Ashen Rite, for a second Doomed Dissenter. A drain stapled to
  the one thing every deck does every turn, in the deck whose plan is already a life total going
  down a point at a time. **Underworld Dreams is the card that deck would rather have and it is not
  here on purpose:** same trigger, one mana cheaper, and {B}{B}{B} in a list with eleven black
  sources and seven Mountains is a card that sits in hand — the exact failure `cast-counts` keeps
  finding, and the reason a Diabolic Tutor and a Behold the Multiverse were both cut from decks this
  week.

**Both cuts came off `cast-counts` rather than instinct, and in both decks the genuinely deadest
card was untouchable.** Hollow Tide's deadest are the Diabolic Tutor (52%) and The Eldest Reborn
(52%); Ashen Rite's are the Bone Splinters (34%) and the Night of Souls' Betrayal (43%). Every one
of those is the pool's only copy of its card, and the Bone Splinters is additionally the only card
in the game that pays a cost by sacrificing — a rules path rather than a slot. That is the orphanage
constraint D167 documented, biting for the second time in a week.

### What the probes and the instrument say

Priced by probing the **revert**, two seed sets of 288 duels each, so a negative revert means the
new card earns its place:

| | seeds 3300 | seeds 8800 | the card is worth |
| --- | --- | --- | --- |
| Chasm Skulker out of Hollow Tide | revert +3 | revert −2 | **−0.5**, level |
| Fate Unraveler out of Ashen Rite | revert −7 | revert −3 | **+5**, positive both sets |

Neither loses, which is the bar for a slot whose job is to give a new event a card. The Unraveler's
+5 is inside the floor and consistent in sign; the Skulker is a free swap.

**And `draw-triggers.mjs` says the abilities actually fire**, which is the claim a unit test cannot
make. It counts the ability reaching the *stack* rather than reading `GameState.drew` — that list is
filled and drained inside a single applied action, so a harness watching between actions would see
an empty list every time and print a confident zero. Over 144 games with each deck as the subject:

```
hollow-tide:  36 Chasm Skulker triggers; it reached the battlefield in 51 of 144 games,
              got as big as 13/13, averaged 4.0 at its best, and its death trigger made Squids
ashen-rite:   75 Fate Unraveler triggers
```

A 13/13 squid is the engine working rather than a bug: thirteen cards drawn with it on the board is
a long game in a deck with two Thought Scours, a Preordain, a Divination, two Thieving Magpies and a
Jace, Memory Adept in it.

**One test caught me rather than the engine.** Three of the six new tests asserted a Chasm Skulker
with no counters on a board that `advanceTo` had already walked through its own draw step — so the
card had a counter before the test did anything, which is the engine being right about the most
ordinary draw there is. They measure the delta now and say why.

## D170 — The judgement problem that is not there, and the instrument that invented it

**Decision: write no fact-about-the-board filter for the counterspell the bot declines, because
with the reservation rule on it declines 13 of 556 windows, spends the mana on another instant every
one of those times, and lets through spells that are *cheaper* than the ones it counters. Close
D69's judgement problem as not-reproducing, and fix the instrument that made it look open.**

D68 and D69 both built an evaluation term for holding mana and both were deleted. D168 built the
filter instead, measured that the real failure was tempo, and closed with a sentence that has turned
out to be wrong: *"with the rule on, the bot declines an affordable answer in about one window in
nine… that is D69's judgement problem, finally in a position where something could be done about
it."* This entry is the measurement that was supposed to characterise that problem, and the result is
that it does not exist.

### The instrument was counting two things that are not decisions

`held-answers.mjs` counts one window per (opponent's spell on the stack, answer in hand), which is
the right unit for *could this card have been cast* and the wrong unit for *what did this seat
decide*. Both errors pushed the same way, into the one column a conclusion gets drawn from:

- **A window another answer covered.** A hand holding a Counterspell and an Essence Scatter facing
  one spell is two windows. Casting either leaves the other recorded as affordable and passed over —
  so the deck answering the spell reads as the deck declining to. **26 of Skyward Writ's 31
  "declines" were `cast Counterspell`.**
- **A window this seat was never offered.** The loop looks at every move and most moves belong to
  the opponent, so a (spell, answer) pair is usually *first* seen on a move this seat was not
  making. Where a later sighting on its own move exists that one wins — but sometimes there is none,
  because a trigger goes on the stack above the spell and the pair gets a new key, or the bot spends
  the mana first and the answer stops being affordable. **8 of Tidal Mind's 14 were those.**

So `covered` and `unseen` are now their own columns and `passed` means what it says. Both bugs are
the same bug the priority counterfactual was: **the unit a harness counts in is a claim about the
engine, and it needs stating out loud.** "One window per spell the deck could have answered" and
"one decision per spell the deck was asked about" differ by a factor of three here, and the first
version silently answered the first question while the entry it fed answered the second.

### What the corrected instrument says, 144 games each with the rule on

| deck | windows | cast | the other card | **declined** | never offered | could not pay | no target |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tidal Mind | 208 | 44% | 0% | **3%** (6) | 4% | 41% | 8% |
| Skyward Writ | 196 | 60% | 13% | **1%** (1) | 2% | 12% | 12% |
| Arc Tempest | 152 | 34% | 1% | **4%** (6) | 4% | 38% | 20% |

**Thirteen declines in 556 windows over 432 games**, and the two diagnostics that were added to
describe them both say there is nothing to describe:

- **What it did instead was another instant, all thirteen times.** Murder ×2, Cackling Counterpart
  ×2 and Unsummon ×2 for Tidal Mind; Swerve ×4, a Think Twice and a Twincast for Arc Tempest; one
  activated ability for Skyward Writ. Not one of them is the mana going on a creature or a sorcery —
  the bot was responding, it just responded with the other card.
- **It counters the expensive half and lets the cheap half through**, which is the opposite of the
  failure D69 predicted. Mana value countered against declined: **2.6 / 2.0** (Tidal Mind), **2.4 /
  2.0** (Skyward Writ), **2.2 / 1.0** (Arc Tempest). Twelve of the thirteen declined spells have
  mana value 2 or less — Burst Lightning, Galvanic Blast, Tainted Strike, Think Twice, Golgari
  Charm, Chalice of the Void for {0} — against countered lists headed by Vampire Nighthawk, Shivan
  Dragon and Flametongue Kavu. And the spell it counters is a creature 49–71% of the time.

The four board facts recorded for a candidate filter — creature or not, mana value, ahead on
creatures, ahead on life — separate the two lists in the *right* direction on every deck. There is
no filter to write, because the behaviour the filter would correct is already correct.

### Why this is a result and not a non-event

Three things come out of it that are worth more than a thirteenth bot rule:

1. **D69 is closed by measurement rather than by argument.** It stood for months as "the bot will
   counter anything it can pay for", quoted in `bot.ts` and in two progress docs, and the thing that
   made it true was that the bot could almost never pay. Fix the paying and the judgement is fine.
2. **A published number was wrong and is now corrected in all five places it was quoted** —
   D168 above, `claude/arena-engine-2026-10-23.md`, `claude/play-realm-setup.md`, the
   `spendsAnAnswersMana` comment in `bot.ts`, and the `held-answers` describe in `playout.test.ts`.
   The rule that shipped does not depend on the correction: it was priced by `bot-duel` and the
   thirteen-deck table, which read win rates and never read a window.
3. **The next thing to doubt is named.** `no target` is 20% of Arc Tempest's windows and 12% of
   Skyward Writ's, which is Squelch and Essence Scatter holding up mana for a spell type that is not
   coming. That is a real cost of the reservation rule and nothing has measured it; it would be a
   narrowing of the rule (reserve only for an answer that can point at something) rather than a new
   family member.


## D171 — A cost paid out of the graveyard: escape, and delve

**Decision: make the graveyard a thing you can spend. One primitive — exile N cards from your own
graveyard as part of a cost — and the two printed mechanics that use it from opposite ends: escape
(a fixed price, paid to cast the card out of the graveyard) and delve (a price chosen as the spell
is cast, which pays generic mana). Three cards, one per deck, all three in the bottom cluster of
the table.**

Everything that paid for anything in this engine paid with something on the battlefield — tap it,
sacrifice it, crew with it — or with a life total. `additionalCost` was one field wide
(`{ sacrifice: 'creature' | 'another-creature' }`) and the graveyard was a place cards went. That
left a whole shelf of printed Magic unwritable, and it left the three decks that fill a graveyard
by playing their own game with nothing to do with one.

### Two mechanics, one primitive, opposite ends of it

- **Escape** (CR 702.139) is a fixed price printed on the card: Phoenix of Ash comes back for
  {2}{R}{R} **and three other cards**, as often as the graveyard can stand it. It is an
  *alternative* cost, so it replaces the printed one and nothing else is paid beside it — no
  kicker, no commander tax.
- **Delve** (CR 702.112) is a price chosen at cast time: each card exiled pays for {1}. A Gurmag
  Angler is a seven-mana 5/5 on an empty graveyard and a one-mana 5/5 on a full one, which makes
  it the first card in the pool whose **mana cost is a fact about the game** rather than about the
  card.

**The difference that carries the balance is at the end, not the start.** Flashback cast a card out
of the graveyard too, and what made it fair was that the card is exiled as it leaves the stack —
there is no third casting. An escaped permanent is ordinary: it dies into the graveyard it came
from, ready to escape again for three more cards. So escape sets no `flashback` flag on the stack
object, and a test asserts exactly that, because that one flag is what `onLeaveStack` reads.

### Three rules that are easy to get almost right

- **"Other" is load-bearing.** The card escaping is in the graveyard too and is not one of the
  cards exiled for its own cost. A Phoenix with exactly three cards in the graveyard *including
  itself* cannot escape, and the play is **absent** rather than offered and refused — CR 601.2h,
  the same rule that keeps a Bone Splinters off the table with no creature to sacrifice.
- **The cards go as the spell is cast, not when it resolves.** It is a cost: they are gone before
  anybody may respond, a countered Angler does not give them back, and nobody can answer an escape
  by exiling the graveyard in reply.
- **Delve pays generic and only generic** (CR 702.112a). Seven Islands and nine cards in the
  graveyard still cannot cast a {6}{B} creature, because no number of cards makes a {B} into a {1}.

### Which cards get spent is the engine's, and the ordering rule is the only judgement in it

`graveyardFodder` chooses, the way `convokePlan` chooses which creatures get tapped, and for the
same reason: a client naming them would be choosing which of its own resources to spend, a turn
before the engine chooses, and then the offer and the payment could disagree. The order is one
rule — **a card nothing can use goes first**. A graveyard in this pool is not a pile: a Think Twice
can be cast out of it, a Phoenix can escape out of it, a Gravedigger can take a creature back from
it, so exiling the wrong three cards is paying twice for one spell. Cards with no second life of
their own go before the ones that have one, oldest first within each group. It is the cheap
heuristic and it is named as one: a Gravedigger *in hand* makes a dead creature worth keeping and
nothing here knows that.

**And `delvePlan` takes the fewest cards it can get away with, not the most.** The maximum is free
in mana and expensive in everything else, and these three cards are each other's evidence: a
graveyard emptied for an Angler is a Phoenix that cannot escape and a Think Twice that cannot be
flashed back. So the plan walks up from nothing and stops at the first count that can be paid for.

### The cards, and the slots they came out of

Every cut was taken off `cast-counts` over 144 games, and every one is a card the **pool keeps a
copy of elsewhere** — the orphanage constraint D167 named, respected rather than fought this time:

| deck | in | out | why that slot |
| --- | --- | --- | --- |
| Arc Tempest (42%) | Phoenix of Ash | Divination (65%, 3 in the pool) | four mana for two cards in a deck whose curve stops at four |
| Hollow Tide (41%) | Gurmag Angler | Wall of Air (79%, 2 in the pool) | three Fog Banks already hold the ground; the deck had no clock |
| Tidal Mind (39%) | Treasure Cruise | Preordain (75%, 4 in the pool) | one card deeper for one mana, against three for one mana |

All three decks are in the table's bottom cluster, all three fill a graveyard without trying, and
each gets the half of the mechanic that suits it: the recursive threat to the deck that casts two
spells a turn, the 5/5 to the mill deck that could never close, the three cards to the deck that
was rebuilt for a clock and still has to find it.

### Does the bot actually pay these costs? `graveyard-costs.mjs`

The instrument reads the **stack**, because that is where the engine writes down how a spell was
paid for — "(escaped, 3 cards)", "(delved 6)" — and both halves are there because an opponent is
entitled to read them before deciding whether to answer. `cast-counts` could not have answered
this: it counts a Phoenix cast twice and cannot say whether the second came out of the graveyard,
and a delved Angler and a seven-mana one are the same row.

Over 144 games with each deck as the subject:

```
arc-tempest:   5 escapes (Phoenix of Ash), always 3 cards
hollow-tide:  11 delved casts (Gurmag Angler), 30 cards — 1, 2, 3 and 4 deep
tidal-mind:   10 delved casts (Treasure Cruise), 48 cards — six of them 6 or 7 deep
```

**The escape count is the honest surprise and it is not a bug.** Five in 144 is low because three
things have to line up: the Phoenix has to die first, the graveyard has to hold three other cards,
and the bot needs four mana spare at **sorcery speed** on its own turn — and Arc Tempest is one of
the three decks the reservation rule (D168) now keeps mana back in, so an escape that would spend a
Counterspell's mana is dropped by that filter before the search ever sees it. The two interact
exactly as written and neither is wrong; it is worth knowing that the pool's first escape card
lives in the deck least able to use it.

The delve spread is the mechanic doing what it says: the Angler is cast one to four cards deep,
which is a deck casting it the turn it becomes affordable rather than the turn the graveyard is
deepest, and the Cruise goes six or seven deep because {7}{U} has further to come down.

> **Corrected by D203.** Every count in this block is about one in eight of the truth, and the
> paragraph above it has the reason backwards. Reading the **stack** between actions only sees the
> objects somebody held priority over; with `autoPass: true` the rest are put on the stack and
> resolved inside the same `applyAction`. `graveyard-costs.mjs` now counts the **action**, and the
> escape count is not low at all — so "the pool's first escape card lives in the deck least able to
> use it" was an artefact of the instrument, not a fact about Arc Tempest. The re-measured numbers
> are in D203; the *shape* of the delve spread survives, because that was never about the count.

### What the three slots are worth

Priced by probing the **revert**, so a negative revert means the new card earns its place. Two seed
sets of 288 duels each, and four for the one that disagreed:

| | seeds 3300 | seeds 8800 | the card is worth |
| --- | --- | --- | --- |
| Phoenix of Ash out of Arc Tempest | revert −10 | revert −5 | **+10 and +5**, positive both sets |
| Gurmag Angler out of Hollow Tide | revert −17 | revert −2 | **+17 and +2**, positive both sets |
| Treasure Cruise out of Tidal Mind | revert **+9** | revert **+1** | **−9 and −1** — and then −4 and −3 |

**The Cruise lost its slot and the probe is the only reason anybody knows.** Four seed sets, every
one of them negative: −9, −1, −4, −3 of 288. Each is inside the ±20 floor on its own and the sign
test is what makes it a verdict — this project's own measurement README says two seed sets are
enough to *kill* a change and four are what it takes to ship a small one, and this is the first time
that rule has had to be applied against a card I had already written up.

The reason it lost is a fact about the deck rather than about the mechanic. **Tidal Mind runs six
Islands** against eight Swamps, so a {U} is not a given on turn four; and its graveyard is already
being spent by a Think Twice that wants to be cast out of it. Delve wants the deck whose graveyard
nothing else is spending.

**So it moved rather than went.** Into Hollow Tide, where the Angler had just measured +17 and +2,
for that deck's second Thieving Magpie (81%): eight Islands, three Mind Sculpts and two Thought
Scours filling its own graveyard, and a deck that wins with about four cards and has to find them.
There it measures **−9 and +15** — opposite signs on two sets, which is level, and level is the bar
for a slot that gives a mechanic a second card. The Divination beside it was the better cut on cast
counts by two points and is the card seven engine tests reach for when they want a plain draw-two,
so the test coverage broke a tie the measurement could not.

**The honest limit, and where it bites.** The search prices a position by what is on the board and
in hand; **nothing in the evaluation knows a graveyard is worth anything**, so to the bot a cost
paid in cards is free. That is why `delvePlan` taking the minimum is not a refinement but the only
thing protecting the resource: a maximum-delve plan would be chosen just as happily, and would
quietly empty the zone two other mechanics in this pool are built on. A term for "cards in your own
graveyard you could still use" is the obvious next thing to want, and on this project's record with
evaluation terms (D68, D69, three deleted) it would have to be measured rather than argued — and
the thing to measure it against is a Phoenix that failed to escape, not a win rate.

## D172 — A card put into a graveyard from anywhere, and the two cards that answer one

**Decision: add `to-graveyard` as the sixth member of the detect-rather-than-announce family —
recorded in `relocate`, drained by `settle`, carrying which card it was — and use it for Planar
Void, the pool's first standing answer to a graveyard. Ship Scavenging Ooze beside it, which needed
no engine change at all, because the pair is the point: the graveyard had become a resource with
nothing that could touch it.**

D171 made the graveyard something you spend. It was already something you *used* — flashback, Raise
Dead, Zombify, a Gravedigger, a Lhurgoyf whose power **is** the graveyard — and the only card in
thirteen decks that could interfere with one was a Tormod's Crypt: one copy, one deck, one shot.
That is a whole dimension of the game with no answer in it, which in a field this size is a balance
hole rather than a flavour choice.

### Why it is a sixth event rather than a widening of `dies`

`died` is the **battlefield** half of a printed wording that says "put into a graveyard **from
anywhere**", and the other three anywheres are not deaths:

- a card **milled** off a library,
- a card **discarded** out of a hand,
- a **spell** that has finished resolving.

Nothing in the engine could see any of them, and none of them can be reached by adding a `who` to
the death event — they are not deaths and a card that treated them as deaths would trigger a Blood
Artist off a discard. So it is recorded where the other five are recorded: in `relocate`, the one
place a card changes zone, which is why no path can forget. There is one test per anywhere, because
"no path can forget" is a claim and four callers are four chances to be wrong about it.

**Both events are raised for the same card**, death first. A creature destroyed in combat really is
a death *and* a card put into a graveyard, which is what the two printed wordings say about it —
and the order puts a Blood Artist's drain on the stack underneath a Planar Void's exile, which is
the order a player watching the table would describe.

### Planar Void is a trigger because Planar Void is printed as a trigger

The tempting version of this card is a replacement effect: "if a card would be put into a graveyard,
exile it instead". That is Rest in Peace and Leyline of the Void, it is a **stronger** card, and
building it would have meant moving the replacement pass upstream into `relocate` — which the
`replaceDeaths` comment has said for months would be the right response to a card that earns it.

Planar Void does not earn it, because it is not that card. "Whenever another card is put into a
graveyard from anywhere, exile that card" means the card genuinely reaches the graveyard and is
exiled afterwards, so a Blood Artist still sees the creature die and a trigger can still be answered
on the way down. Implementing it as a replacement would have been implementing a different card and
calling it this one.

**"Another" is the whole of the matcher**, and it is not a formality: a Planar Void that is destroyed
would otherwise exile itself on the way down, which is the one reading the printed word exists to
rule out. And a Naturalize that destroys it is **not** exiled, which a test asserts: a spell goes to
its owner's graveyard as the last step of its own resolution (CR 608.2m), by which time the
enchantment has already left the battlefield and nothing is watching.

### No options, again, and for the third time the same reason

The event has no `by` and no `what`. Planar Void does not care whose graveyard or what kind of card,
and the rule this engine keeps is that **an option with no card behind it is worse than no option**
— `becomes-tapped` is the one trigger with no card at all and that is deliberate, `draws` has no
`any` for the same reason. The event already carries the subject and the seat, so the day a card
wants "whenever a creature card is put into *your* graveyard", the two facts it needs are there and
the matcher grows a line.

### Scavenging Ooze, which needed nothing

The other half of why this pair ships together. A `graveyard-card` target spec and an activated
ability with a mana cost have both been in the engine for months, so the second answer to a
graveyard is **twelve lines of script and no engine change**: `{G}`, exile target card from a
graveyard, and if it was a creature card take a +1/+1 counter and a life. One card asked for a new
event; the other proved the vocabulary was already there for a card nobody had written.

Its one piece of care is ordering: "if it was a creature card" is asked **before** the exile, off
the printed type line rather than `characteristicsOf`, because a card in a graveyard has no
continuous effects applied to it and what it is is what is printed on it.

### Where they went, and what fired

Both into the bottom cluster of the table, and both cuts taken off `cast-counts` over 144 games
with a card the pool keeps elsewhere:

| deck | in | out | why |
| --- | --- | --- | --- |
| Blight Vector (39%) | Planar Void | Titanic Growth (25%, 2 in the pool) | the one black deck with no use for its own graveyard, and the deck's least-cast card by twelve points |
| Delta Bloom (41%) | Scavenging Ooze | second Divination (81%) | a ramp deck short of a mana sink, and four mana for two cards in a deck that already runs two Preordains, a Mind Spring and a Tatyova |

### What they are worth, and the conflict the probe found

**Scavenging Ooze: +14 and +4** of 288, probing the revert on two seed sets — positive both times,
which for a two-mana creature in a deck short of a mana sink is the expected shape.

**Planar Void took two attempts, and the first one is the finding.** Cutting the Titanic Growth for
it measured **0 and −12**: a card that costs its own deck games. The reason was a conflict I had not
looked for — this deck's one graveyard card is a **Raise Dead**, cast in 40 of 144 games, and a
Planar Void turns it off completely. *A deck that denies graveyards cannot be playing a card that
needs its own*, which is obvious written down and was invisible while I was choosing the cut by
cast count alone.

So the slot became the Raise Dead rather than the Titanic Growth: a card used three times as often,
given up for coherence. Pool coverage is safe either way — Rot Harvest runs the other Raise Dead.
Re-measured there, the Void is **+4 and −3**: opposite signs, which is level, and level is the bar
for a card whose job is to give a dimension an answer.

**What that can and cannot claim.** All four readings — 0, −12, +4, −3 — are inside the ±20 floor,
so the improvement is consistent with the conflict being the cause and is not proof of it. What the
four do support is the thing the card had to clear: on the Raise Dead slot it no longer costs its
deck anything measurable, where on the Titanic Growth slot one of two sets said it did.

`graveyard-costs.mjs` now counts both ends of the dimension in one run, because a harness that
reports "eleven delved Anglers" and another that reports "nine Planar Void triggers" cannot be
compared and the thing worth knowing is whether the hate ever meets the cost. With Blight Vector as
the subject over 144 games: **132 Planar Void triggers reached the stack.** The bot casts the
one-mana enchantment that does nothing for its own board, and once it is down the table has no
graveyard.

## D173 — The one card the reservation rule should never have held mana for

**Decision: narrow `affordableAnswerInHand` from "counter target" to "counter target … spell", which
drops Squelch out of the reservation rule. Ship it on fidelity, because at this pool size it is not
measurable in isolation — and say so rather than inventing a number for it.**

D170 closed the judgement question with a negative result and left one loose end, the only column
where the reservation rule costs its own deck something: **nothing to point at**, 20% of Arc
Tempest's windows and 12% of Skyward Writ's. The per-card rows say where it comes from. Of Squelch's
17 windows in Arc Tempest, **11 ended with no legal target** — the bot held two mana on its own turn
for a card that was never going to be castable when the moment came.

The cause is one word in a regular expression. `affordableAnswerInHand` matched `/counter target/`,
and Squelch reads "Counter target activated ability" — its target is an **ability**, not a spell, so
it can do nothing whatever about the spell the opponent is about to cast. The rule exists to hold
mana for an answer to a spell; it now only counts cards that can answer one
(`/counter target[^.]*spell/`), which keeps every real answer in the pool — Counterspell, Cancel,
Negate, Essence Scatter, Psychic Strike, Saw It Coming, Disallow ("Counter target spell, activated
ability, or triggered ability") and Soul Manipulation's first mode — and drops Squelch and Chalice
of the Void's "counter it".

**It stays a text match rather than a look at the card's target spec**, which is worth saying
because the spec looks like the better answer. The spec says what the *engine will offer*, and this
question is asked on a turn when the engine offers nothing at all: the counterfactual D168 is built
around. A card's own words are the only thing available on the turn the mana is being held.

**What it is worth: unmeasurable, and that is the honest report.** Squelch is one card in one deck —
780 cards in the pool — and it is in hand in about 19 games in 144, so no 288-game probe can see the
difference and `bot-duel` cannot either, because the rule it changes is not behind a flag. It ships
for the reason every member of the drop-this-option family shipped: **the play was wrong**. A Fog
cast with nothing attacking has done nothing at all whatever the win rate says, and two mana held
back for a card that cannot be cast is the same kind of wrongness. The check that it costs nothing
is the thirteen-deck table, which was re-run with it in place.

Two tests, and the second is the one that makes the first mean anything: the same reserving board
with a Squelch in hand casts the creature, and with a Counterspell in hand passes. Without the
control, a test that asserts "it cast the creature" could be passing because the board was never a
reserving board at all.

## D174 — Escape's second card, and the outlet eight cards had been waiting for

**Decision: give escape a second card. Woe Strider ({2}{B} 3/2) into Ashen Rite, which needed no new
engine vocabulary at all — a token on an entry trigger, an activated ability whose cost is
sacrificing another creature, and a scry as its decision. The only new line in the engine is the
0/1 Goat.**

A mechanic with one card has one card's worth of coverage, and escape shipped with one. The second
is a different *kind* of escape card, which is the reason it is worth a slot rather than a copy: a
Phoenix of Ash escapes because it is a threat that will not stay dead, and a Woe Strider escapes
because it is an **engine the opponent cannot answer by killing it**.

### What it is for, in the deck it is in

Ashen Rite has eight cards that read a creature dying — three Blood Artists, two Vampire
Aristocrats, a Bloodthrone Vampire, a Judith and a Village Rites — and not one of them could make a
creature die for **free**. Every outlet in the deck costs a card or a mana. A `{0}` sacrifice
ability is the thing that list has been short of since the deck was built, and the card arrives
**with its own first meal** in the 0/1 Goat, which is the printed joke and also why the 3/2 body is
not the point.

### `AbilityCost.sacrifice` had been there since D24 and no card had ever asked for it

The engine has been able to pay for an *activated ability* by sacrificing another creature since the
Bone Splinters went in — `sacrificeOptions` enforces the "another" clause, the choice travels on the
action, and the victim dies as the ability is activated rather than when it resolves. Nothing had
ever used it on an ability: Bone Splinters is a *spell* with an additional cost. So this card is the
first user of a path that was built, tested through its spell cousin, and otherwise dead.

**"Another" is the difference between an outlet and a mistake**, and it is enforced by the cost
rather than checked in the effect: a Woe Strider that could eat itself is a card the bot feeds to its
own ability on an empty board. A test asserts the refusal.

### Five tests, and the two that are about something other than the card

- the Goat arrives, 0/1, beside a 3/2;
- the ability eats the Goat for nothing and then scries — and the Goat is **gone** rather than in a
  graveyard, because a token that leaves the battlefield ceases to exist (CR 111.7);
- it cannot eat itself;
- **the free outlet reaches the payoff**: a Blood Artist's drain is on the stack after the
  activation. Asserted on the stack rather than on a life total, because the drain targets a player
  and following it through would mean answering a targeting question that has nothing to do with
  this card;
- it escapes for {4}{B} and three other cards, and **arrives with a second Goat**, because the entry
  trigger does not care which zone the card was cast from.

It replaced Ashen Rite's **Thorn of the Black Rose** (65%, the deck's weakest card that is not the
pool's only copy — Tidal Mind runs the other, so the monarch keeps its coverage).

### What it is worth, and the weakest "keep" in the pool

Probing the revert, and the first two readings are the reason D175 exists: **−20 and −8** before the
fodder bug was found, and **−4, −2, +1 and −4** on four seed sets after it. Mean −2.25 of 288, every
one of them well inside the ±20 floor, three of the four with a negative sign.

**It stays, and the comparison that decides it is the Treasure Cruise's.** That card read −9, −1,
−4 and −3 — mean −4.25, four signs out of four — and was moved out of the deck it was in. This is a
weaker signal than that one, there is no better home for a `{0}` outlet in the pool (Rot Harvest is
the only other deck that wants it, and its Lhurgoyf's power *is* the graveyard an escape cost
exiles), and escape needs a second card for the same reason any mechanic does. So it is kept with
the condition written down: **when the field next changes, measure it again** — if the sign holds
negative over another two sets, the Thorn comes back and escape stays a one-card mechanic until a
better home exists.

## D175 — The sacrifice outlet that was eating its own engine

**Decision: rank fodder by what a creature is *worth to its own deck* rather than by its power, and
never feed a creature with text of its own to an activated ability. The fourteenth member of the
drop-this-option family, found by adding a card and priced at about eleven points of win rate for
the deck that cares most.**

Woe Strider went into Ashen Rite and measured **−20 and −8** against the Thorn of the Black Rose it
replaced — a card that loses games. The obvious conclusion was that the Thorn is better, and it was
wrong. `cast-counts` asked the other question first: **does the bot use it?** Over 144 games the
deck cast the Strider 146 times and **activated its `{0}` outlet 348 times** — two and a half times
a game. The card was not being ignored; it was being used wrongly.

### The bug is one comparison, written for a different card

The rule for an ability paid for by a sacrifice was:

```
fodder.power < source.power
```

which is a fair proxy for a **Bloodthrone Vampire** — its ability makes it bigger, so feeding it
something smaller than itself is roughly right — and means nothing at all for a Woe Strider, whose
`{0}` buys a scry and leaves the body alone. A Woe Strider is a 3/2, so the comparison allowed it to
eat anything with power under three.

And `cheapestCreature`, which chose *which* creature, ordered by power alone. **A Blood Artist is
0/1 and a Goat is 0/1.** The ordering could not tell them apart, so the deck spent 144 games eating
the three cards it is built around for a look at the top of its library.

### What replaced it

Two changes, both small:

- **`cheapestCreature` ranks before it compares.** A token is not a card and costs nothing to lose;
  a creature with no text is a body; a creature with text is the deck's plan. Rank first, power
  second, so a Goat goes before a Blood Artist of the same size and a Centaur Courser goes before an
  Izoni.
- **A creature with text is never fed to an activated ability at all.** A token is fed freely, a
  textless body is fed when the old arithmetic says so, and a card is not fed. The bot cannot tell
  when eating a Blood Artist to push lethal damage is right, and the measurement says the cost of
  guessing is enormous.

### What it is worth

`cast-counts`, same 144 games: the outlet goes from **348 activations to 136** — about once a game,
which is the Goat it arrived with, and that is what the card is for.

And the win rate, which is the number that makes this more than a tidy-up. The Woe Strider probe
re-run on the same seeds measures Ashen Rite's **stock arm at 159-127 where it had been 127-160** —
the same deck, the same opponents, the same seeds, **+32 games of 288** from the bot no longer eating
its own Blood Artists. That is about eleven points of win rate, four times the size of any card
change made this week, and it was found by putting in a card that looked like it lost games.

**Woe Strider itself is now −4** on the first seed set against the Thorn, where it had been −20. The
card was never the problem.

### The lesson, which is the one D170 taught in the other direction

A card that measures badly has two explanations and the cheap one is wrong half the time: *the card
is bad*, or *the bot plays it badly*. D170 found an instrument that invented a problem; this found a
card that exposed one. The order to ask them in is fixed from now on: **before pricing a slot, ask
`cast-counts` whether the bot uses the card, and how often.** 348 activations in 144 games is not a
number anybody has to interpret.

## D176 — Blight Vector is a turn short, and the instruments say so in one voice

**Decision: measure before touching the deck, and the measurement says the plan is fine and the
clock is not. One change — a Wall of Blossoms for the Titanic Growth (25%) — because what the deck
needs is the two turns that let the reach it already has arrive.**

The re-run thirteen-deck table put Blight Vector last at **31%** (88-200), five points below the
next deck and the first time since the Tidal Mind rebuild that the bottom of the table was a cliff
rather than a cluster. Some of that is the field rather than the deck: Hollow Tide and Delta Bloom
each gained about seven points in the same run, and wins come from somewhere. The Planar Void is
level on its own seeds (+4, −3), so it is not the cause.

### Two instruments, one answer

`killed-by` over 144 games:

- it loses on the table's **turn 20.4** (its own turn 10.2) **holding 2.2 cards** — not flooding,
  not starving;
- **71% of the time to plain combat damage**, with the next cause at 10%;
- and the games it wins, it wins on turn 18.4 **with 15.6 life left**.

`poison` over the same games:

- poison is dealt in **117 of 144 games (81%)**, 903 counters in all;
- **50 of its 53 wins are by poison**, 3 by damage;
- by opponent: 40 poison and 2-10 against Ember Rush, **108 poison and 6-6 against Hollow Tide**.

Nothing is broken. The win condition D138 built this deck for is the win condition it wins with. It
never gets going against fast red and nearly gets there against everything slow — so it is losing a
race by about a turn, and more reach would not help a deck that already has 903 counters' worth.

### The cheapest two turns in these colours

A **Wall of Blossoms** ({1}{G} 0/4, draws a card) blocks every one- and two-power creature Ember
Rush and Forge Alliance have, replaces itself so playing defence does not shrink the hand, and —
the part that makes it right for *this* deck rather than any deck — **it is never dead**. An infect
deck's creatures all have to attack to do anything; a card that only blocks is a card none of the
others can be.

It replaced the **Titanic Growth** (25%, the deck's least-cast card by ten points, and Kindle Grove
runs the other copy).

### And it measured level, which is a result rather than a disappointment

Probing the revert, two seed sets: **−3 and +5** of 288. Opposite signs, both inside the floor — the
Wall is neither better nor worse than the Titanic Growth it replaced.

So the diagnosis does not translate into the obvious change. "A turn short" reads as *add a card
that buys turns*, and the deck's absolute level barely moved: 99-189 and 112-176 across the two
stock arms, which is 34% and 39%. Whatever is costing Blight Vector its games is not a missing
blocker.

**The sharper hypothesis is in the same data and it is about evasion rather than defence.** The deck
goes 2-10 against Ember Rush, 3-9 against Forge Alliance and 3-9 against Dawn Tithe — three decks
that are entirely red and white between them — and it already runs the card that cannot be blocked
by any of them: **Phyrexian Crusader**, a 2/2 infect with protection from red *and* white, cast in
85% of games off two copies. A third Crusader is being probed against the Wall directly, which is
the cleaner experiment: `CHANGE='Phyrexian Crusader:+1,Wall of Blossoms:-1'` asks the question in
one run rather than committing a card and measuring it afterwards.

The Wall stays until that answers, because level is not a reason to revert and a deck list should
not churn between two measurements.

### And the third Crusader is worse, which closes the slot-at-a-time approach

**−7 and −15** of 288 against the Wall, both arms negative. So the deck does not want another
attacker either, and the Wall — level against the Titanic Growth — is better than the alternative
that was supposed to beat it.

### `infect-clock.mjs`, and the number that explains both nulls

Before reshaping anything it was worth knowing whether the problem is the cards at all. Poison only
counts when a creature *connects*: one that stays home deals nothing, and one that is blocked deals
its damage to the blocker as −1/−1 counters, which does not win the game. The bot's combat rule is
"do not throw creatures away" (D40, D47) — correct for a deck that wins by damage and possibly fatal
for a deck whose 1/1s have to get through — so the number nobody had was *of the infect creatures it
could attack with, how many does it send?*

Over 144 games, at every declare-attackers step where it held at least one:

```
530 declarations with an infect creature able to go
  could have sent 736, sent 663 — 90%
  sent nothing at all: 42 (8%)
  sent every one of them: 477 (90%)
  widest board of infect creatures: 5; widest attack: 5
```

**It attacks with everything. The bot is not the problem.** And the last line is the finding: across
144 games, the widest board of infect creatures it ever had is **five** — an eighteen-creature deck
that never gets more than five bodies down at once, swinging with 90% of them, needing ten poison.
Its creatures are dying as fast as it plays them.

### What this deck actually needs, and why it is not this pass's job

That is an **attrition** problem, not a slot: one- and two-power creatures in a field of 3/3s and
removal, with a ceiling of five bodies. It is D167's lesson a second time — *a shape is not priceable
one card at a time*; Tidal Mind took six slots at once after eleven single-slot probes found
nothing, and this deck has now spent six probe arms and three instruments on two slots and found
level and worse.

So the next pass is a **reshape measured as a shape**, with the direction the instruments point at:
resilience over count (the three Blight Mambas regenerate and are the deck's only creatures that
survive a block), evasion over bodies, and the Loxodon Warhammer package that turns one connection
into several poison counters through a blocker. `infect-clock` is the instrument to judge it with,
because the number to move is the widest board and the share that connects — not the win rate, which
is three noisy points away from anything a single card can do.

## D177 — The table republished, and a bot fix that moved a deck further than any card ever has

**Decision: publish the thirteen-deck table as it stands after the last three changes, and read only
one of its thirteen moves as real — Ashen Rite's ten points, which is the sacrifice-fodder fix
(D175) arriving in the field exactly as its own probe said it would.**

Every deck against every other, both seats, 288 games each
(`SEEDS=12 SEED0=4400 node scripts/measure/deck-table.mjs`):

```
 75%  215-73   ember-rush
 59%  170-118  verdant-guard
 58%  167-121  dawn-tithe
 57%  163-125  forge-alliance
 54%  156-132  kindle-grove
 51%  147-141  skyward-writ
 49%  142-146  ashen-rite
 47%  135-153  hollow-tide
 46%  133-155  delta-bloom
 43%  124-164  arc-tempest
 41%  117-171  rot-harvest
 36%  103-185  tidal-mind
 33%  95-193   blight-vector
```

### What changed between the two runs, which is why this comparison is worth making at all

The control arm is the run D176 quotes (the one that put Blight Vector last at 31%), on **the same
twelve seeds from 4400** — so every pairing in both arms is the same games. It already had the escape
and delve cards in it, the two answers to a graveyard, and the Squelch narrowing (D173 says so: the
table *was* the check that the narrowing costs nothing). The three things it does **not** have are
**Woe Strider** in Ashen Rite (D174), the **fodder-choice fix** (D175) and the **Wall of Blossoms**
in Blight Vector (D176).

Wins per deck, control → this run, in games of 288:

```
ashen-rite      113 → 142   +29      arc-tempest     125 → 124    -1
rot-harvest     104 → 117   +13      hollow-tide     138 → 135    -3
blight-vector     88 →  95    +7      delta-bloom     137 → 133    -4
forge-alliance  161 → 163    +2      verdant-guard   177 → 170    -7
ember-rush      214 → 215    +1      kindle-grove    163 → 156    -7
                                        skyward-writ    156 → 147    -9
                                        tidal-mind      112 → 103    -9
                                        dawn-tithe      178 → 167   -11
```

**One of those is outside the ±20-game floor and twelve are inside it.** Ashen Rite's +29 is the
fodder fix, whose own probe measured **+32 of 288** on the deck in isolation — a prediction and an
arrival that agree to three games, which is as close as this instrument gets to confirming anything.
It moves the deck from 39% and fourth-worst to **49% and seventh**, and it is the largest move any
single change has produced in this pool: larger than the six-slot Tidal Mind rebuild (D167) and
larger than every card that has ever been priced here.

**The second-largest move is the same fix on another deck.** Rot Harvest gained 13 games, and Rot
Harvest is the only other deck in the pool with repeatable sacrifice outlets in it — a Vampire
Aristocrat and a Bloodthrone Vampire, the exact two cards the fix guards. Thirteen games is inside
the floor and means nothing on its own; it is worth writing down because it is the right *sign* on
the right deck, and because the two decks that gained are the two decks the change was about.

Everything else is noise, including dawn-tithe's −11 and tidal-mind's −9, and both of those are the
other half of a zero-sum table: the wins Ashen Rite and Rot Harvest gained came off somebody.

### Two claims in the published write-ups are now wrong, and this is the correction

The previously published table said **"the bottom of that table used to be a cliff and is now a
cluster"** and **"the spread across the whole field is thirty-six points where it was forty-eight"**.
Neither survives this run: the spread is **forty-two points** (75% to 33%), and the bottom is two
decks standing apart again — Tidal Mind at 36% and Blight Vector at 33%, five points below Rot
Harvest. Both of those documents have been corrected rather than left as they were.

That is not a regression so much as the field moving: the published table was a **different seed
set** (the default 3300), so its deck-by-deck numbers carry the floor once each and comparing the two
run-to-run carries it twice. The honest statement of what this table says about the pool is the
shape rather than any one row — one deck clearly ahead at 75%, nine within eight points of even, and
two that are measurably short.

### And the one the table does not answer

Blight Vector is still last at 33%, +7 games on a control arm whose only change for it was a card
that had already measured level. D176's reshape is still the open question, and this run neither
helps nor hurts it: a deck that needs ten poison counters off a board that peaks at five creatures
was never going to be moved by one blocker, and the table has now said so twice.

## D178 — The reshape Blight Vector asked for, measured and rejected — twice

**Decision: revert the reshape and the smaller version of it. Four slots measured −11 and −10, the
two-slot equipment package measured −3 and +23, and the instrument that was supposed to judge the
shape says why neither worked: the five-wide ceiling is not a supply problem.**

D176 ended with a direction rather than a list: resilience over count, evasion over bodies, and the
Loxodon Warhammer package. This is that list, built, measured and taken back out.

### What was tried

Four in, four out, from `cast-counts` over 144 games:

- **+1 Blight Mamba** (to four). The regeneration is pressed **406 times** off three copies — 471%,
  the most any button in this pool is pressed, and the deck's only creature that survives a block.
- **+1 Plague Stinger** (to four), the one infect creature four decks in the pool cannot block.
- **+1 Loxodon Warhammer** (to two). 149% — 38 casts and 53 equips in the 61 games a copy was in
  hand, and the deck's second-best card by use.
- **+1 Whispersilk Cloak**, a new Equipment: {3} to cast, equip {2}, *equipped creature can't be
  blocked and has shroud*. The pool's first card that makes anything unblockable, and in an infect
  deck a 1/1 nobody can block is a poison counter a turn for as long as it lives.
- Out: **2 Blossoming Defense** (44%, the deck's least-cast card), **1 Read the Bones** (62%, three
  mana in a deck losing a race by a turn), **1 Cystbearer** (a 2/3 that holds ground, which the
  Wall of Blossoms now does).

### The measurement, which is two arms of the same sign

Probing the revert, 288 games an arm: **+11 and +10**. Both inside the ±20 floor, both the *same
sign*, which is the pattern that kills a change rather than the pattern that leaves it open — the
old shape is better than the new one on both seed sets.

**Then the narrow version, because four changes at once cannot say which one was wrong.** The
equipment package alone — the second Warhammer and the Cloak for the two Blossoming Defenses, the
part of the reshape with the strongest argument behind it — measured **−3 and +23** on its revert.
Opposite signs with one arm well outside the floor is not a card that earns a slot either.

One number from inside those runs is worth keeping, because it says which half of the reshape was
the expensive one. On the same seeds: the committed deck won **114** of 288, the equipment package
**117**, and the full reshape **103**. The four creature-and-draw slots cost about fourteen games on
their own, and the matchup columns name the two cards it missed — the reshape is worse against
Ember Rush, Forge Alliance and Arc Tempest, the three fastest decks it plays, which is exactly what
cutting a 2/3 blocker and a card-draw spell does.

### And `infect-clock` says the ceiling is not about the list at all

The instrument D176 chose to judge this by, run on the reshaped deck against the same field:

```
                       committed      reshaped
attack windows              530            574
infect creatures able       736            826   (+12%)
            ...sent         663            737
                            90%            89%
widest board                  5              5
widest attack                 5              5
```

**Twelve percent more infect creatures reaching an attack step, the same ceiling, and ten fewer
wins.** The deck is not short of creatures to draw; it is short of creatures that are still there
next turn. Adding bodies to a board that loses them at this rate adds attack windows and nothing
else, which is the whole result and the reason no slot change has moved this deck in nine probe
arms.

### The Cloak was built, measured in two decks and deleted

`cantBeBlocked` has existed since D133 with one creature behind it that could not block either, so
an Equipment carrying it looked like a mechanic the pool was missing rather than a slot in one deck.
Its shroud is the half that makes it wrong in an infect deck: nine of Blight Vector's cards target,
so a cloaked creature cannot be grown, saved or handed the Warhammer, and five mana of setup in a
deck whose curve stops at three is a different deck's plan.

So it was measured where Equipment is already the plan — **Forge Alliance**, four Equipment and a
Balan that moves all of them at once — against that deck's **Hellrider** (32%: twelve casts in the
thirty-seven games a copy was in hand, and the deck's second-deadest card after a pod-only Disrupt
Decorum). The bot *likes* the Cloak there: `cast-counts` gives it **149%**, 29 casts and 26 equips
in 37 games, which is the same usage the Loxodon Warhammer gets. It still loses:

```
revert (Hellrider back in): -2, +17, +23, +14 over four seed sets
                            617 wins with the Cloak, 669 with the Hellrider, of 1152
```

Three arms of four say the Hellrider, and four and a half points of a deck's record is not a
rounding error. **So the card is deleted** — definition, script and tests — which is D144's
precedent (*built, measured, deleted*) and the rule this pool keeps: a script with no card in a deck
has no coverage, and a card kept because it was written is a card nobody measured.

One thing is worth keeping out of it, and it is about the bot rather than the card: it cast and
equipped a Cloak at the first opportunity in nearly every game it drew one, and the games came out
worse. `evaluate` does not know that unblockable on a 2/2 is worth less than an extra damage per
attacker, and a card the bot reaches for eagerly while losing is a **trap** rather than an option.
That is the second time an evasion idea has measured negative while looking obviously good (D144 was
the first), and both were priced rather than argued.

### What happens next

And the reshape is not getting a third guess. The next thing for this deck is an instrument, not a
list: **what takes its creatures away** — blockers, removal, or its own costs — because the three
answers point at three different decks and two reshapes have now been priced on a hunch and both
measured worse. That is #158.

**One sentence of this entry was wrong when it was written and the correction is D179.** It said the
card the reshape wanted at the right price is a **Rancor** — {G} for +2/+0 and trample that comes
back when it reaches a graveyard — and that the event needed a self-subject filter before it could
be written. The event did need the filter. But Rancor has been in the pool since the thirteenth deck
(D162), two copies in Kindle Grove, and **Blight Vector cannot run it at all**: its Planar Void
exiles every card that reaches a graveyard, which is the third time that card has turned out to be
incompatible with something its own deck would otherwise want.

## D179 — Rancor says "from anywhere", and the event grows the option that lets it

**Decision: give `to-graveyard` a `who` filter with `another` as its default, move Rancor's trigger
onto it, and correct three places that described the card by its old printing. The engine gains the
self-subject half of its newest event; the card gains the three directions a death could not see.**

### What was actually wrong, which is one word of card text

Rancor has been in the pool since the thirteenth deck (D162), two copies in Kindle Grove, scripted
as `{ kind: 'dies', who: 'self', what: 'permanent' }` — the first and still the only `dies` trigger
in the pool on a permanent that is not a creature. That is the **old** printing: *"when Rancor is
put into a graveyard **from the battlefield**"*. The card has read **"from anywhere"** for years,
and D172 built the event for exactly that difference: a card discarded out of a hand, milled off a
library, or put into a graveyard by anything that is not a death were all invisible to `dies`.

So this is a fidelity fix with an engine capability under it, not a new card. The capability is the
part worth describing.

### `who` on `to-graveyard`, and why its default is the opposite of every other event's

The five board events (`etb`, `dies`, `attacks`, `blocks`, `becomes-blocked`) default `who` to
`self`, because a trigger that says nothing watches its own permanent. `to-graveyard` defaults to
**`another`**, and the default is a card rather than a convention: the event was written for Planar
Void, whose printed word is "another", and every script written against it means that. A default of
`self` would have silently changed the one card already using it.

Two things travel with `who: 'self'`:

- **The watcher fires from the graveyard it has just reached.** `raise` skips any watcher that is
  not on the battlefield, with an exception for the subject of a `dies` or a `leaves` — a creature
  that died is in a graveyard by the time its own trigger is offered. `to-graveyard` is the third
  member of that exception now, and for this card it is the whole thing: the trigger is *about* the
  graveyard the card is in.
- **The effect is guarded.** By the time the ability resolves the card may have been exiled — by the
  Planar Void whose own trigger was on the stack beside it, or by a Scavenging Ooze in between — and
  an unguarded return would pull it back out of exile. An ability does as much as it can and no more
  (CR 608.2), so a Rancor that is no longer in a graveyard stays where it is.

There is still no `by` and no `what` on this event, for the reason its declaration gives: an option
with no card behind it is worse than no option.

### Two new tests, and they are the two new directions

The battlefield half already had a test and still passes. The new ones are a **discard** — a Rancor
that was never cast, taken out of hand by Tidal Mind's Mind Rot, back in hand a moment later — and
the **Planar Void**, which is the one card in the pool that beats it: both are `to-graveyard`
watchers of the same event, and whichever order they resolve in the Rancor ends in exile. 925 engine
tests green.

### What it is worth, said honestly

**Unmeasurable in a win rate, and the usage number is the interesting one instead.** `cast-counts`
over 144 games says Kindle Grove casts its two Rancors **139 times in the 64 games it draws one** —
217%, more than twice per game, which is what a card that comes back is worth and was already worth
before this change. The paths this fix adds are a Rancor discarded or milled, which in a deck with
no self-discard happens when an opponent's Mind Rot or Tome Scour finds it: rare enough that no
288-game probe could see the difference. It ships on fidelity, which is D173's precedent — *the play
was wrong* — and here the printed card was being played incorrectly.

### Three corrections, because the old description is in three places

- `claude/decisions-log.md` D162's capability table said *"Rancor | a `dies` trigger on a permanent
  that is not a creature"*. Annotated rather than rewritten: it was true of the script, and the
  script was wrong about the card.
- `claude/arena-engine-2026-10-23.md` said the same thing in the Kindle Grove section.
- `claude/play-realm-setup.md` told a player the card *"comes back to your hand when it leaves the
  battlefield"*, which is the sentence a person would have found to be false at the table. It now
  says from anywhere, names the three directions, and names the Planar Void as the answer.

And one correction inside **D178**, written an hour earlier in this same session: it said the card
the Blight Vector reshape wanted was a Rancor that *needed* the self-subject filter to exist. The
filter did need building. The card did not — it was already in the pool — and Blight Vector cannot
play it in any case, because its own Planar Void exiles it. That is the third thing the Void has
turned out to be incompatible with inside its own deck (a Raise Dead in D172, a Naturalize's own
resolution in the same entry, and now this), and it is the clearest argument yet that a deck running
graveyard denial has to be built as a denial deck rather than one with a hate card in it.

## D180 — The fifteenth drop-this-option rule, found by an instrument rather than by a suspicion

**Decision: build `creature-fate.mjs`, and fix what its first run reported — the bot casting its own
Naturalize on its own creature. Drop any cast that would destroy a permanent its own controller
controls.**

### The instrument #158 asked for

`infect-clock` had ended on a ceiling nobody could act on: Blight Vector's board of infect creatures
never got wider than five, and a reshape that put 12% more of them into attack steps moved it by
nothing (D178). The missing number was what *takes them away*, and the three possible answers point
at three different decks — blockers (evasion), removal (resilience), or its own costs (a bot rule).

`creature-fate.mjs` follows every creature a deck puts onto the battlefield and records how it left,
where it went, and how long it lived. Attribution is the same trick `killed-by` uses, with one
addition that mattered: the cause is the **stack object that resolved on that action**, not the
action's own card, because auto-pass resolves the top of the stack as part of applying a *pass* — a
Doom Blade cast last turn and resolving now carries no card on the action at all. The first version
read the action and put 22% of all departures into "a state-based action", which is true of the
mechanism and useless as an answer. When a single action resolves several objects it says so in its
own bucket rather than guessing: whichever end of the stack you read is wrong about half the time.

### What it said, on its first run

```
blight-vector: 48 games
  261 creatures onto the battlefield, 148 left it, widest board 7
  they last 3.0 turns of the table (about 1.5 of its own)

  47%  combat
  47%  the opponent's card
   9%  its own card      ← and six percent of that was one card
```

**Six percent of this deck's creatures were killed by its own Naturalize.** Nine creatures across
48 games, every one of them a Plague Stinger: Naturalize is "destroy target artifact or
enchantment", a Plague Stinger and an Ichorclaw Myr are **artifact creatures**, and with nothing of
the opponent's to point at the only legal targets the engine can offer are its own. The search took
one every time — a card spent to kill its own 1/1 — for the reason this whole family exists: with
auto-pass on, the state after a one-mana instant can be a turn later, and two positions a turn apart
do not compare.

D89 had already fixed the creature half of exactly this (`removesACreature` plus "is there anything
of theirs to remove"). This is the other half, and it has to read the **target** rather than the
card, because the same Naturalize with a real target is a fine card.

### The rule, and why it is a text match

`destroysOneOfItsOwn`: drop an `auto:cast` whose card says "destroy target" and whose chosen target
is a permanent this seat controls. A text match rather than a script flag, for D173's reason — the
card's own words are what say whether it destroys — and unconditional, because nothing printed in
this pool wants to destroy its own permanent: there is no Oblivion Ring and no "destroy target
permanent you control". The day a card wants it (a symmetric enchantment its own controller is
losing to), that is the line to narrow.

Two tests, the second being the one that makes the first mean anything: with only its own Plague
Stinger on the table the bot declines the Naturalize (and the table is still *offered* it, because
the rules do allow it), and with a Bonesplitter across the table it casts it at the Bonesplitter.

### What it is worth: one deck, and the right deck

The fix is not behind a flag, so the measurement is the thirteen-deck table before and after on the
same twelve seeds from 4400. Wins of 288:

```
dawn-tithe      167 → 186  +19      ember-rush      215 → 212   -3
blight-vector    95 → 100   +5      kindle-grove    156 → 152   -4
forge-alliance  163 → 164   +1      tidal-mind      103 →  99   -4
skyward-writ    147 → 147    0      hollow-tide     135 → 130   -5
                                      delta-bloom     133 → 130   -3
                                      arc-tempest     124 → 121   -3
                                      verdant-guard   170 → 169   -1
                                      ashen-rite      142 → 141   -1
                                      rot-harvest     117 → 115   -2
```

**Dawn Tithe gains 19 games (58% → 65%) and it is one of the four decks that runs a card this rule
can fire on** — a Disenchant, beside its own Darksteel Plate, its own Angelic Gift and eight other
artifacts and enchantments. Nineteen is at the edge of the ±20 floor rather than past it, and the
other three affected decks moved +5, −2 and 0, so the honest summary is: *worth something to one
deck, nothing measurable to the rest, and the play it stops is wrong whatever the table says.* That
is the same report D173 wrote for the Squelch narrowing and the same reason it shipped.

The rest of the table is noise and the other half of a zero-sum run. One ordering change is worth
naming because it is published: **Dawn Tithe is second now** and Tidal Mind is last at 34%, one
point below Blight Vector.

### And the answer the instrument was built for, which is not a card

Across four decks the split is remarkably stable — combat and the opponent's removal take roughly
half each, everywhere:

```
                 creatures   left   widest   lifetime   combat   theirs   ours
blight-vector          261    148        7    3.0 / 1.5    47%      47%     4%
rot-harvest            415    228        9    3.9 / 2.0    45%      41%    14%
skyward-writ           401    203       12    4.5 / 2.2    47%      51%     1%
dawn-tithe             362    256        8    3.4 / 1.7    49%      41%     7%
```

So Blight Vector's ceiling is **not** a different cause from everybody else's. It is the same two
causes at the same ratio, applied to a deck that puts **261** creatures onto the table where Skyward
Writ puts 401 and whose creatures live **1.5 of its own turns** where Skyward Writ's live 2.2. The
infect deck is not losing its creatures to something unusual; it has fewer of them, each one dies to
anything, and nothing in the list replaces them. Which makes the next question for that deck
"where do more bodies come from" — tokens, or a creature that leaves one behind — rather than
evasion or resilience, and both of the shapes D178 priced were answers to the wrong question.

## D181 — Undying and persist, and the fourth null on the same deck

**Decision: script undying and persist as the triggered abilities they are printed as, with three
cards. Ship the Young Wolf on a +36/+10 measurement, the Butcher Ghoul as level, and the Murderous
Redcap for the mechanic with the honest number against it. And stop asking Blight Vector the same
question a fifth way.**

### The mechanic, and the implementation that would have been wrong

"When this creature dies, if it had no +1/+1 counter on it, return it to the battlefield under its
owner's control with a +1/+1 counter on it." Persist is that sentence with −1/−1 in both halves.

The obvious reading is a replacement effect — the creature *looks* like it never dies — and the
engine has had `replaces: [{ on: 'dies' }]` since regeneration (D37), so it would have been three
lines. It is wrong. Both keywords are **triggered abilities** (CR 702.92a, 702.79a): the creature
reaches the graveyard, every death trigger sees it, and only then does the body come back. As a
replacement it would have been a creature a Blood Artist cannot drain for, a sacrifice outlet gets
nothing from, and a Village Rites cannot pay with — which is the opposite of what these cards are
played for, and the first thing the tests check.

So the whole mechanic is a `dies` trigger with `who: 'self'` and an **intervening-if**, over
machinery that already existed. Two notes worth keeping:

- **The if reads the counters it had as it died** (CR 603.4), which is what makes the second death
  permanent. Those counters are gone from the card by the time anything can look — `relocate` takes
  them off on the way to the graveyard — so both asks read `subjectCounters`, the snapshot the event
  carries. The **first** ask did not have it; it does now, because without it the ability would go
  on the stack for an opponent to respond to and then do nothing, which is the shape of wrongness
  an intervening-if exists to prevent.
- **The return is guarded** like Rancor's (D179): a card that has left the graveyard in between
  stays where it is.

Four tests: it comes back bigger the first time, it stays dead the second (and nothing goes on the
stack at all), a Blood Artist and the persist trigger are on the stack together — so the death
really happened — and the Redcap's second body is a 0/0 that dies on its own, which is the printed
card rather than a limitation.

### Three cards, three decks, and the measurements are not alike

```
card              deck            slot                      revert, two seed sets
Young Wolf        rot-harvest     Naturalize (70%)           -36 and -10
Butcher Ghoul     blight-vector   Blossoming Defense (44%)     0 and  +2
Murderous Redcap  ashen-rite      3rd Blood Artist (92%)      +7 and +29
Murderous Redcap  ashen-rite      2nd Gravedigger (83%)       +6 and +11
```

**The Young Wolf is the clearest single-card result this pool has produced in weeks, and the reason
is the deck rather than the card.** One mana for a 1/1 that comes back as a 2/2, in the deck with a
Vampire Aristocrat, a Bloodthrone Vampire, a Lotleth Giant and a Blood Artist in it: a body that can
be spent **twice** is two activations of an outlet for one draw, and D175's fodder fix means the bot
now reaches for the cheap end of the board when it feeds one. Rot Harvest wins 142 of 288 with it
and 106 without on the same seeds — 37% to 49% on one arm, 43% to 47% on the other.

**And the field run on a third seed set says +7, which is the number to believe.** The thirteen-deck
table was re-run after all three cards (same twelve seeds from 4400) and Rot Harvest moved 115 →
122, with Ashen Rite and Blight Vector unmoved — both consistent with their own probes. So the
honest statement of the Young Wolf's worth is *positive and inside the spread*: +36 was the top of
the range rather than the expectation, and three arms read +36, +10 and +7. A card measured once at
the high end of the noise and published as that number is how a deck list drifts away from what the
instrument actually said, which is why the third arm is here rather than left out.

**The Redcap is worse than the cards it was tried against, twice.** Against the third Blood Artist
it measured +7 and +29 on the revert, which says plainly that a Blood Artist is a better card than a
Redcap and that the drain payoff was never what this deck had too much of. Against the second
Gravedigger it measures **+6 and +11**: inside the ±20 floor on both arms, the right sign on
neither. It ships there anyway, and the reason is stated rather than dressed up — **persist has no
other card in the pool**, the mechanic is the point, and the Gravedigger slot is the one it loses
least in. A reader who wants the strongest Ashen Rite should put the Gravedigger back.

### And the Butcher Ghoul is Blight Vector's fourth null in a row

The hypothesis was D180's: that deck's problem is the **denominator** — 261 creatures onto the
battlefield where Skyward Writ puts 401, each living 1.5 of its own turns — so a 1/1 that arrives
twice is bodies per card, which is the one thing it is short of.

`creature-fate.mjs` says the bodies arrived:

```
                     before   after
creatures played        261     279
still standing at end   113     120
lifetime (table turns)  3.0     3.1
```

**And the win rate did not move: 0 and +2.** So that deck has now been asked four different
questions with four different cards and answered null to all of them: a blocker that buys turns
(D176, level), evasion and an equipment package (D178, −11/−10 and −3/+23), and bodies per card
(this entry, level). Each hypothesis came from an instrument, each was implemented as the instrument
asked, and each time the cards did what they were added to do while the record stayed where it was.

The honest conclusion is about the deck rather than the next card: **ten poison counters off
one-power creatures is a slower clock than twenty life off three-power ones, in a field where both
sides' creatures die at the same rate.** It is 35% because of what it is, not because of which forty
cards fill the gaps around the infect. Making it better means changing what it is — a different
commander, a different curve, or accepting that the pool's thirteenth-best deck is the one that
wins a way nothing else can. Blight Vector gets no more single-card passes; the Butcher Ghoul stays
because level is not a reason to revert and the card is the pool's cheapest undying.

## D182 — Monstrosity and adapt, and the sixteenth drop-this-option rule the second keyword asked for

**Decision: script both keywords, with the difference between them written where the cards write it
— monstrosity's "only if" on the ability and adapt's inside the effect. Ship the Fleecemane Lion as
level over four seed sets and the Aeromunculus for the mechanic with its number stated. And add the
rule adapt exposed: the bot was paying four mana three times for one effect.**

### Two keywords, one word apart

"{2}{G}{W}: Monstrosity 1" is *activate only if this creature isn't monstrous*; "{2}{G}{U}: Adapt 3"
is *if this creature has no +1/+1 counters on it, put three on it*. Same growth — permanent, once —
and the restriction is in two different places, which is observable and now tested both ways:

- **Monstrosity's** is a restriction on the **ability**, so the table must stop offering it. That
  needed one engine line, `AbilityDef.activateOnlyIf`, asked where the play is offered *and* where
  an action is validated — the two places every ability restriction is checked in, for D67 and
  D89's reason: an option offered and then refused is worse than one that was never there.
- **Adapt's** is a condition inside the **effect**, so the ability stays offered and a player may
  pay for nothing. That is the printed card, and the engine owes the player the play the rules
  allow.

And the Lion's other half is the second thing `ContinuousEffect.while` has ever been asked. *Hexproof
and indestructible as long as it is monstrous* is a condition about the permanent's **own** counters
rather than a count of its controller's board, so `while` grew a second kind —
`source-has-counter`. The simplification that comes with it is written into the test rather than
hidden: the engine's answer to "is it monstrous" is the counter it is carrying, so a Toxic Deluge
that takes the counter off takes the hexproof with it, where a real Fleecemane Lion stays monstrous.
A flag on the instance for one card is the trade D57's rule is about.

### The sixteenth of the drop-this-option family, and adapt found it in one run

`cast-counts` on the first version, one Aeromunculus in Delta Bloom: **29 casts and 88 adapt
activations across 34 games**. Three payments of {2}{G}{U} per creature for one effect — because
after the first one the ability still appears, still resolves, and does nothing. The search cannot
see it for the reason this whole family exists: with auto-pass on, the state after a four-mana
ability can be a turn later, and two positions a turn apart do not compare.

So `AbilityDef.buysNothingIf` is the twin of `activateOnlyIf` and is read by the **bot alone**: the
rules keep offering what the card allows, and the search stops taking it. After it: **29 casts and
24 activations**, which is about one per creature. Two tests, as every member of this family has:
with a counter already on it the bot declines (and `legalActions` still offers it), and with no
counter the same board takes the same ability.

### What the two cards are worth

```
card              deck            slot                    revert
Fleecemane Lion   verdant-guard   Prey Upon (59%)          -28, +11, +6, -1
Aeromunculus      delta-bloom     Air Elemental (76%)      +13, +8  (before the rule)
                                                           +11, +5  (after it)
```

**The Lion is level and ships.** Four arms with a mean of about −3 and one of them −28: that is
what this instrument does when nothing much has changed, and the −28 is a reminder of why two arms
are the minimum and four are better. `cast-counts` says the card is live either way — **47 casts and
21 monstrosities** in the 56 games a copy was in hand, so the bot pays the five mana in about half
the games it draws it.

**The Aeromunculus is about eight games short of the Air Elemental and ships anyway**, which is the
second time this session a card has shipped with a number against it (the Murderous Redcap was the
first, D181) and the reason is the same: **adapt has no other card in this pool**, a 2/3 flier for
three that becomes a 5/6 is the cleanest version of the mechanic the pool can cast, and four mana
for a 4/4 flier is simply a strong card to be measured against. The bot rule is worth two or three
games of the gap and the rest is the card. A reader who wants the strongest Delta Bloom should put
the Air Elemental back — and Pteramander, which is the famous adapt card, is **not** here for a
better reason: its adapt costs {7}{U} reduced by one for each instant and sorcery in its
controller's graveyard, which is a cost modification on an *ability* read off the board, and
`costModifiers` applies to spells with a fixed number. A card the engine can only approximate is
better left unwritten.

## D183 — Unearth, the self-replacement it needed, and a sacrifice that was moving cards out of exile

**Decision: script unearth as an activated ability whose cost is "from your graveyard", give
`replaceDeaths` the dying permanent's own effects so the printed exile clause can exist, and fix the
bug that found: "sacrifice this" was moving a card out of exile and into a graveyard it could be
bought from again.**

### The third thing a cost can be paid out of a graveyard, and the first that is not a cast

Escape and delve (D171) are **casts** from the graveyard: the card goes on the stack, an opponent can
counter it, and "whenever a player casts a spell" sees it. Unearth is none of that — an activated
ability puts the creature straight onto the battlefield with haste, and a delayed trigger exiles it
at the beginning of the next end step. So it is an ability whose cost carries a **zone**:
`AbilityCost.fromGraveyard`, which is cycling's `discardSelf` one zone along, and
`activatablePlays` now walks the graveyard as a third zone for exactly the same reason it walks the
hand.

Everything else existed. The haste is an ordinary end-of-turn grant; the exile is D135's delayed
trigger; the sorcery-speed restriction is the keyword's own words.

### The clause that was not optional, and the measurement that proved it

Unearth reads "exile it at the beginning of the next end step **or if it would leave the
battlefield**", and the second half looked like a nicety. `cast-counts` said otherwise. With one
Hellspark Elemental in Kindle Grove: **18 casts and 42 unearths across 22 games** — twice the card
the printed one is.

The reason is a two-line story worth keeping, because the first explanation was wrong. A Hellspark
carries two end-step abilities: its own printed sacrifice, and the exile unearth schedules. The
exile resolved **first** and did its job. Then the sacrifice resolved, called `moveToGraveyard`, and
moved the card **out of exile and into the graveyard** — where it was unearthable again. That is not
an unearth bug at all: a sacrifice is something you do to a permanent you control, and a card in
exile is not one (CR 701.17a). So `sacrificeSelf` guards it, and the same latent bug had been
sitting on Ball Lightning for twenty entries with nothing in the pool able to exile it first.

With that fixed the exile clause is still needed for the ordinary case — an unearthed creature that
dies in combat. That is a replacement effect a permanent applies to **its own** death, which D181
decided not to add for undying because undying does not want one. Unearth is the card that does, so
`replaceDeaths` now considers the dying permanent's own `replaces` entries first (the choice between
two applicable replacements belongs to the affected object's controller, CR 616.1). It applies to
the unearthed body alone, read off an `UNEARTHED` counter in the `vanished` snapshot — because a
Hellspark that was *cast* and died is in a graveyard it can be unearthed from, which is the whole
point of the card.

One gap remains and is written into the script: "would leave the battlefield" also covers a bounce
or an exile, and `replaces` only knows `dies`. A bounced unearthed creature goes to its owner's
hand, where the printed card exiles it. Nothing in this pool bounces its own creature.

### What the cards are worth, before and after the fidelity fix

```
card                deck            slot                  revert, two seed sets
Dregscape Zombie    ashen-rite      Gravedigger (59%)      -5 and +1
Hellspark Elemental kindle-grove    2nd Giant Growth (64%) -10 and -19  (with the leak)
                                                           -4 and  -6  (fixed)
```

**The leak was worth about half the card.** A Hellspark that could be unearthed twice measured +10
and +19; the printed one measures +4 and +6. Both are positive and both are inside the floor — so
the card ships on a consistent sign and a modest number, which is what it should have measured all
along. `cast-counts` tracks the same correction: **42 unearths before, 17 after**, from 18 casts.
A rules deviation nobody notices is worth real games, and that is the argument for fidelity put as
a number rather than as a principle.

**The Dregscape Zombie is level**, and the slot is the interesting half: it replaced Ashen Rite's
last **Gravedigger** (59%), which is the same idea one card more expensive — three mana for a 2/2
that buys a creature back, against two mana for a 2/1 that buys **itself** back for {B}. Its usage
says the deck means it: **33 casts and 32 unearths in 32 games**, one per game, and in a deck with a
Vampire Aristocrat, a Bloodthrone Vampire, three Blood Artists and two Zulaport Cutthroats, a body
that can be eaten twice for three mana in total is the cheapest version of the whole plan.

## D184 — An instrument for plays that bought nothing, and the seventeenth drop-this-option rule it found

**Decision: build `wasted-plays.mjs`, which asks of every card at once the question sixteen bot
rules had each answered about one card, and ship the first rule it found by itself — an Equipment
moved onto a creature that is no bigger.**

### The family, and why it needed an instrument

Sixteen members of the "spent on nothing" family exist and **every one of them was found by hand**:
a Dark Ritual into nothing (D63), a Fog with nothing attacking (D66), a pump that wears off before
it matters (D73), an animated land that never attacks, a Clone with nothing to copy, removal with
nothing to remove (D89), a goad in a duel, a foretell with nothing spare, an untap cycle that
changes nothing (D124), a Naturalize aimed at its own board (D180), a second adapt (D182). Each one
cost a session of suspicion, instrumentation and measurement, and each was worth between nothing and
twenty-nine games of 288 — D175 was +29 to Ashen Rite, D180 was +19 to Dawn Tithe, and several were
level. The pattern is strong enough to have a name and weak enough that nobody could say which card
was next.

So `wasted-plays.mjs` asks it generically. For every `auto:cast` and `auto:activate` the bot takes,
it fingerprints everything a player would call value — life and poison, permanents per seat, total
power, toughness, counters and granted keywords on the battlefield, untapped permanents, and the
size of every zone — before the action and again after it has finished resolving. A play where
**nothing** in that fingerprint changed, except the card paying for itself out of hand, is a
suspect, and suspects are grouped by card name.

### Three things it had to get right to say anything at all

**Drain the stack first.** A cast, and every activation that is not a mana ability, only puts an
object on the **stack** — so comparing the two states either side of the action says "nothing
moved" about every spell in the game. The first version reported 78% of a Scavenging Ooze's
activations and 94% of a Basilisk Collar's equips as waste. The fix is to pass priority while there
is something on the stack and nothing is owed; passing never buys the acting seat anything, which
is what makes it fair, and it does let the opponent respond, which is the same question asked of a
board that includes their answer.

**Drop the samples where the turn advanced.** With auto-pass on, applying one action can resolve the
stack, finish the combat and hand the turn over, and two positions a turn apart are not comparable.
This is the trap every member of the family fell into — D99 is the entry about it — and 771 of 3,771
plays hit it here. They are dropped rather than guessed at.

**Count the right things, and not the cost.** Three false-positive classes were found and fixed by
reading the flagged list rather than by reasoning:

- an Equipment that grants only keywords is invisible to a power-and-toughness sum, so a Basilisk
  Collar's deathtouch read as nothing. The fingerprint counts **granted keywords**.
- tapping something is value and leaves everything else alone, so an Icy Manipulator read as
  nothing. It counts **untapped permanents**.
- and counting untapped permanents naively counts **the payer's own lands**, which every paid play
  taps. That made every spell look as if it had changed the board: the flagged list collapsed from
  two hundred suspects to five. A land tapped for mana is the cost, not the thing bought, so the
  payer's lands are left out.

The header documents the five blind spots that are left — information, later, denial, mana in the
pool, and where a bonus is — which is why the output is a list of **suspects** rather than a list of
bugs.

### What it found

```
156 games, 3,771 casts and activations watched, 170 suspects (5%)

    62 of  106  58%  Basilisk Collar
    27 of   57  47%  Darksteel Plate
    20 of   67  30%  Loxodon Warhammer
    15 of   44  34%  Bonesplitter
    10 of   10 100%  Fog
     7 of    9  78%  Disallow
     5 of   10  50%  Soul Manipulation
     4 of    4 100%  Dark Ritual
     4 of    7  57%  Rancor
     3 of   10  30%  Glistener Elf
```

**124 of the 170 suspects are equips**, and the top four rows are the only four Equipment in the
pool. Most of what is left is the instrument's own blind spots answering back, which is the evidence
that it is calibrated rather than broken: Fog is prevention, and damage that did not happen is not
in any fingerprint; Disallow and Soul Manipulation are **denial**, and a countered spell leaves a
board that looks exactly like the board where it was never cast; Dark Ritual's mana is in the pool,
which this does not read. Those three rows are 26 of the 46 non-equip suspects and not one of them
is a bug.

The small rows — Rancor at 4, Glistener Elf at 3, a Lightning Bolt, a Mind Sculpt, a Doom Blade —
were not run down, and there is one mechanism that makes them expected: draining the stack lets the
**opponent respond**, so a spell answered in response reads as a play that bought nothing. That is
true of the measurement and arguably true of the play. It is also why a single-digit row here is not
worth a session: the instrument's job is to find the rows with three digits of waste behind them.

### The rule: an Equipment moved sideways

D35 taught the engine not to **offer** an equip onto the creature the Equipment is already on,
because that does nothing at all. This is the shell outside it: a different creature, the same
bonus, no gain. A Basilisk Collar was moved onto a Wall of Blossoms twenty-one times, onto a
Gravedigger twelve, onto Llanowar Elves ten — a 0/4 defender, a 2/2 and a 1/1 — while the Collar was
already on something.

So `equipMovesSideways` drops an equip that moves an Equipment off a creature this seat controls and
onto one whose power is no greater. **Power is the test, and it is a proxy** — deathtouch is worth
more on the creature that will block than on the bigger one that will not, and the rule drops that
move too. What it keeps is every first equip, every move onto something bigger, and every move off a
host that has left, tapped, or stopped being a creature, which is what the printed reason to move an
Equipment usually is.

After it:

```
156 games, 3,597 casts and activations watched, 79 suspects (2%)

    17 of   46  37%  Darksteel Plate
    12 of   41  29%  Bonesplitter
     7 of   49  14%  Basilisk Collar
```

**Equip suspects fall from 124 to 36 and Loxodon Warhammer disappears from the list entirely.** The
36 that are left are the blind spot the header now names by itself: the fingerprint *sums* power
across the battlefield, so an Equipment moved from one creature to a bigger one changes nothing in
it — same sum, different carrier. Those rows are the moves that are upgrades, and the instrument
cannot tell them from the ones that are not. Reading that needs the board, which is what the bot
rule does.

### What it is worth, which is nothing in the standings and a quarter of the pool's waste

**And it is level in the standings, which took two seed sets to say.** Paired thirteen-deck tables,
the rule off and on, on the same seeds. At `SEED0=4400` the two decks whose Equipment it governs
both gained five games of 288 — Forge Alliance 160→165, Rot Harvest 124→129 — and nothing else moved
more than four. That looks like a signal. At `SEED0=5600` the same pairing gives Forge Alliance
**0** and Rot Harvest **0**, and the largest move anywhere in the table is +4 on Ember Rush, the
Bonesplitter deck. So the +5s were the ±20 floor talking, and the discipline that usually kills a
change here confirmed a level one instead. The rule ships the way D35 did: on the play being wrong,
and on the instrument's own count going from 124 wasted equips to 36.

The republished table (`SEEDS=12 SEED0=4400`, 288 games a deck, the rule in it):

```
 75%  216-72   ember-rush      44%  128-160  delta-bloom
 64%  184-104  dawn-tithe      43%  124-164  hollow-tide
 61%  175-113  verdant-guard   39%  113-175  arc-tempest
 57%  165-123  forge-alliance  34%  99-189   blight-vector
 57%  164-124  kindle-grove    34%  97-191   tidal-mind
 49%  141-147  skyward-writ
 46%  133-155  ashen-rite
 45%  129-159  rot-harvest
```

Every row is within five games of D183's run, which is what a level change looks like on a zero-sum
table.

### And one rule built, measured and deleted

`equipAddsNothing` was the obvious companion: drop an equip onto a creature the Equipment's bonus
cannot help. It fired **zero times** in 156 games, because every Equipment in the pool grants either
power or a keyword that any creature can use. It is not in the tree. A rule with no measured waste
behind it is a rule that will be wrong about a card nobody has written yet.

## D185 — A replacement effect for any zone change, Rest in Peace, and a fidelity fix worth nothing

**Decision: widen `CardScript.replaces` from "dies" to the three widths a printed card actually
uses — `dies`, `to-graveyard` and `leaves-battlefield` — ship Rest in Peace on the widest of them,
and close unearth's remaining gap while saying out loud that closing it bought no games.**

### The field was one event wide, and printed cards are three

`replaces` has existed since D82 (Kalitas) with a one-member union: `on: 'dies'`, a permanent going
to a graveyard from the battlefield (CR 700.4). Two cards since then have wanted something wider and
both settled for less:

- **Rest in Peace** could not be written at all. "If a card would be put into a graveyard **from
  anywhere**, exile it instead" is not a death — it is a discard, a mill, a spell finishing its
  resolution, and a death among them.
- **Unearth** shipped half a clause. D183 implemented "exile it … or if it would leave the
  battlefield" as a replacement on the body's own *death*, and wrote down that a bounce is the same
  clause with the excuse that nothing in this pool bounces its own creature.

So the field is now `ReplacementEvent = 'dies' | 'to-graveyard' | 'leaves-battlefield'`, and `settle`
asks the three in that order of width.

**One move is replaced once, which is the whole of the bookkeeping.** A creature destroyed in combat
is in `left`, in `toGraveyard` and in `died` all at the same time — three names for one zone change.
So the wide passes run first and whatever they handled is dropped from the narrower lists, and the
narrow pass hands back the same favour: a creature a Kalitas exiles instead of letting die never
reached a graveyard either, so nothing that watches graveyards sees it. `ReplacementContext.dying`
is `subject` now, because the thing it names is no longer always dying.

Nothing in the pool can observe that last correction today — Planar Void's exile guards on the card
still being in a graveyard, so it was already a no-op — and it is in because "exiled instead" means
the graveyard was never touched (CR 614.6), and the next card that counts graveyard cards as it
resolves would read it.

### Rest in Peace, and why it is not Planar Void

The two read almost the same in English and are different cards. Planar Void is a **trigger** —
"whenever another card is put into a graveyard, exile that card" — so the card really arrives, an
ability goes on the stack, and the exile happens afterwards: a Blood Artist still drains, and a
Gravedigger resolving first still buys something back. Rest in Peace says **instead**. Nothing
arrives, so **the creature never died**, and that is the assertion the test exists for: the same
board that drains for one with a Void on it drains for nothing with a Rest in Peace on it.

Two halves and both are the card: the arrival empties every graveyard that already exists, because
the replacement only covers the rest of the game. And it is unconditional, **itself included** — a
destroyed Rest in Peace exiles itself, which works only because the engine asks the moving card's
own effects first (D183's change, made for unearth and reused here without a line).

**The slot is the interesting half.** It replaced Skyward Writ's **Divine Verdict** (57% of the
games it was in hand, 16 casts in 96), and it is in that deck because none of its sixty cards reads
a graveyard — no flashback, no escape, no Gravedigger. A symmetrical card in a deck that pays
nothing for it is a one-sided card. Against Ashen Rite's Gravedigger loops, Arc Tempest's flashback,
Hollow Tide's delve and Rot Harvest's recursion it is two mana for half a deck.

The exception is written into the deck comment rather than left for somebody to find: in a **pod**,
Skyward Writ's commander is Hanna, Ship's Navigator, whose whole ability is returning an artifact or
enchantment from her controller's graveyard. In a duel Hanna is not in the game; at a Commander
table the two cards fight.

**Measured: level, and the number says as much about the bot as about the card.** Probing the
revert — Rest in Peace out, the Divine Verdict back — gives **+10 and 0** of 288 on two seed sets.
Both are inside the ±20 floor and neither is in the card's favour, so it ships the way D182's
Aeromunculus did: for the mechanic, with the number said out loud rather than buried.

And there is a reason to expect that number to be low which is not about the card. The evaluation
has **no term for an opponent's graveyard**, so a two-mana enchantment whose whole effect is denying
one scores as a blank — the deck holding it cannot see what it bought, while a person sitting across
from Ashen Rite's Gravedigger loops or Arc Tempest's flashback can. That is the same shape as the
counterspell (D148): the handicap was never the card. Teaching the search to read a graveyard is a
term rather than a slot, and it is on the list.

### And the fidelity fix that was worth nothing, measured rather than assumed

D183's excuse for shipping half the clause was that nothing in the pool bounces its own creature.
That is true and beside the point: the **opponent's** Unsummon and Man-o'-War bounce it perfectly
well, and Tidal Mind, Skyward Writ, Hollow Tide and Delta Bloom all run one. On a constructed board
an unearthed Dregscape Zombie, Unsummoned in response, went to its owner's **hand** — a two-mana
2/1 to cast again, or to discard and unearth again — where the printed card exiles it. There is a
test for it now and the engine gets it right.

**It is worth no games at all, and that is the finding.** `cast-counts` both ways, 96 games each:

```
                      with the fix        without it
Dregscape Zombie      28 casts, 21 unearths   28 casts, 21 unearths
Hellspark Elemental   17 casts, 16 unearths   17 casts, 16 unearths
```

Not one game in 192 differed. The window is narrow in a way the sacrifice leak's was not: an
unearthed creature is exiled at the end of the turn it arrived on anyway, so the bounce has to
happen inside that same turn, and the bot almost never has the chance. D183's leak was worth about
half a card (+10/+19 leaky against +4/+6 fixed); this one is worth zero.

Both are the same kind of change and only one of them paid, which is the argument for measuring
fidelity fixes rather than assuming them either way. The reason to ship this one is that the card
reads that way and a person playing it will expect it to — not a win rate.

## D186 — Does the opponent read your hand? Measured, and now enforced by a test

**Decision: build `hidden-info.mjs`, which asks the bot the same position twice with every card it
cannot identify dealt out again; find that the shipped bot uses no hidden information at all (0 of
8,945 decisions); keep the check as a test; and correct the published claim that said otherwise.**

### A claim that outlived its code

D110 built the *reply* — the search letting the opponent answer inside it — measured it level over
240 paired duels, and reverted it with a sentence that has been quoted in the "Next" list ever
since: *a bot that declines to attack because of the exact card you are holding is not a better
opponent; it is a cheating one.* The reply went. The sentence stayed, and the item next to it has
read "a search that reasons from the redacted view a person gets rather than from everybody's hand"
for five months — which states, in the present tense, that the bot that ships reads your hand.

Nobody had checked. Reading the code says it probably does not: `evaluate` sums life, hand **count**,
library **count**, and the battlefield, and the only other hand it touches is its own
(`affordableAnswerInHand`). Hand size is public. But "probably does not" is the kind of claim this
project has been wrong about four times, and it is the exact claim a person would most want to be
true.

### The check that cannot be argued with

Ask the bot the position twice: once as it is, and once with **everything the acting seat cannot
identify replaced by something else**. A bot using hidden information must sometimes answer
differently; a bot answering identically every time is not reading it.

What counts as hidden is `viewFor`'s own redaction rather than the harness's opinion — another
seat's hand identities (the ids and the count travel so a hand can be drawn and counted; the cards
do not), every library's identities and order including the acting seat's own, and the card under
somebody else's face-down permanent, which is publicly a 2/2 (CR 707.2). The scramble permutes
`defKey`s **inside one seat's hidden pool**, so every zone keeps its length and every card keeps its
owner: the only thing that changes is which card is which.

Positions where a scry or a tutor is pending are dropped, because reading a library is what the card
on the stack is for.

### The answer

```
78 games, 8,945 decisions asked both ways, 2 scrambles each
1,583,797 card identities moved by the scrambles

decisions that changed: 0 (0%)
   0 of 4,268  auto:pass       0 of   764  auto:attack
   0 of 1,718  auto:cast       0 of   655  auto:activate
   0 of 1,000  auto:playLand   0 of   334  auto:block
   0 of   156  auto:keep       0 of    35  auto:order
```

**Not one decision in 8,945.** The computer opponent plays from what it can see.

**And the instrument has a positive control, which is what makes that zero worth printing.** A
deliberate cheat was wired into `legalDeclaration` — refuse to attack whenever any opponent holds a
Lightning Bolt — built to its own `dist` and measured on the same 78 games: **26 of 764 attack
declarations changed**, and nothing else did. So the harness can see a leak, and it can say which
kind of decision leaked. The 1.58 million moved identities are the other half of the control: a
scramble that silently did nothing would report a perfectly honest bot about a bot reading
everything, which is why that number is in the output and not in a comment.

**The sensitivity is bounded and worth stating.** The cheat fires on one card name in a
thirteen-deck field, and it only shows up when a scramble moves that card into or out of a hand at a
moment an attack is being declared — 3% of attacks. A leak about something rarer, or one that
changes a decision only occasionally, could sit below this floor. What the zero rules out is any leak
of the size a person would notice.

### What is kept

`playout.test.ts` has the regression test: three pairings played out, every decision asked both ways,
and two assertions that stop it being vacuous — more than 200 decisions asked and more than 10,000
identities moved. It runs in about a second, so the property is now enforced rather than believed,
and a future search that peeks fails the suite instead of shipping.

The "Next" item is corrected rather than left standing. The honest version of the opponent model —
the redacted view *plus* what their deck could be holding and whether their open mana pays for it —
is still the missing piece for any deeper search, and that is what the entry now says.

## D187 — The legacy server initialised its database twice, and raced itself every boot

**Decision: delete the second `db.initDb()` from `server.js`, guard against its return in
`scripts/guards.js`, and record that the Postgres container log's refused statements were evidence
rather than noise — which is the one thing task #111 had written off.**

### What was there

```js
// line 558
db.initDb().then(async () => { /* the whole boot chain */ });
// line 8145
db.initDb().then(() => { console.log("Database initialized successfully."); });
```

Two un-awaited calls, both starting at module load, against a pool with `max: 35`. `initDb()` runs
**85** `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements and swallows each
failure into a `console.warn("Postgres DDL statement notice:", …)`.

`CREATE TABLE IF NOT EXISTS` is **not race-safe between sessions** in Postgres: two sessions that
both find the table missing both try to create it, and the loser fails inserting into `pg_type` or
`pg_class` rather than being quietly skipped. So every cold boot of the legacy server on Postgres
raced its own schema creation.

### Reproduced, 20 of 20

A fresh database per run, `initDb()` called twice concurrently in one process, 20 runs:

```
20 of 20 concurrent double-init runs hit an error

duplicate key value violates unique constraint "pg_type_typname_nsp_index"
duplicate key value violates unique constraint "pg_class_relname_nsp_index"
relation "players" already exists
type "players" already exists
relation "deck_cards" already exists
relation "card_price_cache" already exists
relation "price_overrides" already exists
```

Not one run in twenty was clean. The outcome was benign — every refusal is an "already exists"
variant, so the schema ends up complete — which is exactly why it survived: the symptom was a log
line nobody read, on a boot that worked.

### The note this corrects

Task #111 — the intermittent `legacy-postgres` failure — had this written down:

> A service container's error log records every statement the database refused, not anything the
> program minded — do not go back down that path.

That sentence is right about the `column "id" does not exist` lines it was written for (`db.js`'s
`run()` appends `RETURNING id` and retries without it, by design). It was **wrong as a general
rule**, and the generalisation hid this: the refused DDL in the same log was the fingerprint of a
double initialisation. The lesson is narrower than either version — a refused statement is not
automatically a problem, and it is not automatically noise either; it has to be attributed to the
code that issued it.

### Is this the flake? Unproven, and #111 stays open

It is the right shape — a race, on a cold database, invisible locally — but the race's observed
outcome is an "already exists" refusal that leaves the schema correct, and the suite passed 25 of 25
cold-start runs locally both before and after the fix. So this is a real bug fixed on its own merits,
not a diagnosis. #111 keeps its instruction to wait for an occurrence and to add no retry.

### What guards it

A **source-text guard**, not a test, and the reason is worth keeping: the legacy Postgres suite
builds its database from the v2 baseline and every migration *before* the server boots, so by the
time `initDb()` runs every table already exists, no creation is attempted, and nothing races.
Re-introducing the second call does not fail that suite — measured, not assumed. `guards.js` now
counts the calls and fails on anything but one.

Two smaller things from the same session, both about making the next occurrence readable:

- Every test in `test/postgres-write-paths.test.js` goes through a `pgTest` wrapper that attaches
  **the server's own log, last sixty lines**, to whatever the body throws. The suite drives the
  legacy server over HTTP, so a failure usually reads "expected 200, got 500" with the reason in a
  log this process is holding and nobody printed. The whole tail rather than lines matching an error
  pattern, because a healthy boot log is 1.7KB and a filter is what loses the line that explains it.
- A new test asserts the boot refuses **no** statement at all. It could not have caught the race, for
  the reason above, but it catches the other half: a statement that is simply wrong for this dialect,
  which is what this file exists for.

## D188 — Four keywords that read the attack, and the one field they needed

**Decision: script battalion, mentor, renown and battle cry; add one field to the `attacks` event
(`withAtLeast`, the sibling of exalted's `alone`); and report that the first slot chosen for renown
was wrong, which `cast-counts` said long before any win rate could.**

### What the trigger vocabulary was missing

The engine's seventeen keywords are all facts about a permanent — flying, deathtouch, first strike —
and its combat triggers could already say "whenever this attacks", with `who`, `of` and `attacked`
on the event. What none of them could say is anything about the **shape of the declaration**.

`alone` was already there for exalted, and its comment says why it has to be: "attacks alone" is a
fact about the *declaration*, and a creature removed from combat before the trigger resolves leaves
a board that cannot be counted (CR 506.4). Battalion is the same question with a number, so the
event now carries `declared` (how many creatures were declared) and a trigger may ask
`withAtLeast: 3`. `alone` is kept separate rather than folded in, because it means *exactly* one and
five entries depend on it; `withAtLeast` is **at least** N, which is what every printed card that
counts attackers says.

That is the whole engine change. The other three needed nothing:

- **Mentor** is a target filter: attacking, and lesser power than the source. Both are read off the
  board as the trigger goes on the stack — `state.combat.attacks` is the declaration and
  `characteristicsOf` is the comparison — and `TargetSpec.filter` has taken a `source` since D35.
- **Renown** is an intervening-if about a state the creature holds, so the engine's answer is a
  counter: `RENOWNED`, beside `REGENERATION` and `UNEARTHED`. A creature that leaves and comes back
  is a new object with no counters and renown is available again, which is what the rules say.
- **Battle cry** reads the declaration in its *effect* rather than its condition: every other
  attacker in `state.combat.attacks` gets +1/+0, as the list stands when it resolves.

One thing worth writing down because it was checked rather than assumed: renown needs no `to:
'player'` option on `combat-damage`, because the engine raises that event **only** for damage that
actually took a player's life total down. Blocked damage and a swing stopped by a Fog raise nothing.

### The cards

```
card               deck            replaced                       casts in 96 games
Firemane Avenger   forge-alliance  Hellrider (28%, 7 casts)        25, every game in hand
Sunhome Stalwart   forge-alliance  Firebrand Archer (63%, 20)      29
Goblin Wardriver   kindle-grove    Pelakka Wurm (18%, 3 casts)     15
Topan Freeblade    verdant-guard   Soul Warden (60%, 25 casts)     27
```

The Pelakka Wurm's **3 casts in 96 games** is the lowest usage of any nonland card ever measured in
this pool; Delta Bloom keeps the other copy, where seven mana is reachable.

### What they are worth

Probing the revert — the new card out, the old one back — on two seed sets of 288:

```
deck            revert, seeds 3300   seeds 5100
forge-alliance        -9                -36
verdant-guard        -10                 -3
kindle-grove          -2                 +8
```

**Forge Alliance is the real result: −9 and −36, and −36 is outside the ±20 floor.** Two arms of the
same sign with one of them large is as close to a settled card result as this instrument gets. It is
also a **two-card** change, so it cannot be split between battalion and mentor from these numbers —
what it says is that the pair beats the pair it replaced, in the deck that attacks with the most
creatures.

**Verdant Guard is level and positive** (−10 and −3, both inside the floor), which is the same
reading D183's Hellspark shipped on. **Kindle Grove is a wash** (−2 and +8, mixed signs): battle cry
costs the deck nothing against a seven-drop it cast three times in 96 games, and it ships for the
mechanic and for the curve rather than for a win rate.

### The slot was wrong first, and the instrument said so

Renown went into **Skyward Writ** first — the other white deck, the one whose plan is to still be
alive later, which a 2/2 with vigilance that grows looked built for. `cast-counts`:

```
Topan Freeblade    3 casts in the 16 games it was in hand   (19%)
Leonin Skyhunter  44 casts, same cost
Omenspeaker       53 casts, same cost
```

Three casts in 96 games. The obvious suspect was the mana-reservation rule (D152) — a deck holding
two mana for a Counterspell is exactly the deck that cannot afford a two-drop — and it was wrong:
with `reserveForAnswers: false` the same card is cast **twice**. It was simply the 61st-best card in
a deck that already has two better two-drops and bigger things to do by turn four.

In **Verdant Guard**, in place of the last Soul Warden, the same card is cast **27 times in 42**.
Same card, same cost, three times the usage.

**And a correction to a number this entry nearly published.** The first probe of the Verdant Guard
slot replaced its **Centaur Courser** and measured 50 casts in 48 — higher again. That is not the
slot that shipped: cutting the Courser breaks **49 tests** that use it as the board's default
creature, so the shipped list cuts the Soul Warden, and the number in the deck comment is the one
this list actually produces. A measurement taken against a change that was not made is worth exactly
nothing, however good it looks.

### Four tests repointed

Cutting cards moves the boards other tests stand on: the two Soul Warden tests and a Fire // Ice
board now use Dawn Tithe (which keeps its Soul Warden), and the renown test uses Verdant Guard. That
is the fourth time a deck change has done this, and the pattern is stable enough to be a habit:
after cutting a card, run the suite before measuring anything.

## D189 — The pod's politics, recorded: who has been hitting whom

**Decision: give each seat a tally of all damage taken from each other seat, ship it in the view,
and read it on every opponent's strip in a pod as `hit you N`. Information, never enforcement.**

### The question the table could not answer

The pod's own notes have listed this as the missing half of its politics since deals were built:
*"nothing that records who was politically on whose side over a game — the badge says who broke a
deal, not who was helping whom."*

A four-player table asks it every turn. **Who has been coming at me, and who has left me alone.**
Nothing on the screen could answer it: a life total is everybody's work added up, and the log is one
event at a time in a panel nobody scrolls mid-combat. Players answer it from memory, badly, and
memory is exactly what a pod's politics runs on.

### The field

`Seat.damageFrom` — all damage dealt to this seat by each other seat this game, keyed by seat index.
It is `commanderDamage`'s wider sibling and sits beside it, which is the whole of its design: that
record was already per-seat, already serialised, already in the view, and already keyed by *the
player* rather than by the card, for reasons D33 wrote down.

It is also **the first field in this state that no rule reads.** Twenty-one commander damage
eliminates a player, so that tally is machinery; this one decides nothing and no state-based action
looks at it. That is the point rather than a weakness: a pod needs a memory more than it needs
another rule.

**Attribution is the most specific thing the caller passed**, in order: the attacking creature when
the damage is combat, then whatever `source` is — a permanent on the battlefield belongs to the seat
controlling it, a spell on the stack to its owner — and `controller` last, which callers pass for
lifelink rather than for attribution. Damage with no source at all is counted against nobody rather
than against a guess.

Two lines the rules draw and this follows:

- **Prevented damage is not damage.** A Fog, a shield, protection from the source's colour: the
  points were never dealt, so they are not in the tally and the player they were aimed at is right
  to read nothing.
- **Life paid is not damage.** A Phyrexian Arena's upkeep, a Toxic Deluge's own payment, a Thoughtseize's
  two. A player bleeding themselves for cards does not show up as somebody attacking them, which is
  both the rule and the right answer to the political question.

A seat's own id can appear — a Fireball at your own face is damage you dealt yourself — and the
table skips that entry rather than the engine lying about it.

### What it looks like

Each opponent's strip in a pod reads `hit you 7`, next to the deal badge and the broke-a-deal badge.
Shown only when it is not nought, for a reason worth stating: a row of "hit you 0" on every strip
from turn one is noise rather than a read, and **a strip with no badge is itself the answer to the
other half of the question**. The pair is the whole political picture — what somebody promised, and
what they have actually done.

`damageTakenFrom(view, other)` is the helper, beside `pactBadge` and `brokeADeal`, so the logic is
tested where the other political reads are tested rather than inside a component: nought for a
watcher with no seat, nought for your own row, nought when nothing has landed.

### What it deliberately is not

It does not enforce, judge, or score. There is no "aggression" rating, no "most hated player"
badge, no table talk generated from it. The deals already drew that line and it is the right one: a
table where the software stops you breaking your word is a table where your word costs nothing, and
a table that told you who to be angry with would be playing the politics for you.

## D190 — Hybrid mana, and the cost this pool had been carrying wrong

**Decision: teach the mana layer colour-hybrid symbols (`{B/R}`: one mana, either colour), fix
Murderous Redcap's cost to the one printed on it, add Kitchen Finks — and report that the fix to
the Redcap changed nothing measurable, which is the second fidelity fix in a row worth zero.**

### A refusal that was right, and what it was hiding

`parseManaCost` has refused every slashed symbol since it was written, and its header said why:
reading `{R/G}` as generic would offer a player a spell they cannot cast, which is worse than
refusing a card no deck contains. That reasoning is sound and the refusal was the right call at the
time.

What it was hiding is that a deck *did* contain one. **Murderous Redcap is `{2}{B/R}{B/R}`**, and
D181 put it into Ashen Rite written as `{2}{B}{R}` — the closest thing the parser could read. The
approximation is strictly harsher than the card: the real Redcap is castable off four Swamps, and
the pool's copy demanded one of each colour. Nobody noticed because it is invisible until somebody
holds the card with the wrong three lands out.

### What hybrid needed

`ManaCost.hybrids` is a list of symbols, each listing the types that may pay it:
`{2}{B/R}{B/R}` is `[['B','R'],['B','R']]`. A list rather than anything folded into `colors`,
because the choice is **per symbol** and the whole point is that two of them can be paid two
different ways.

**The payment cannot be greedy, and that is the one interesting line of this entry.** Two symbols
and one pool is an assignment problem: `{G/W}{W/U}` against one white and one blue has exactly one
answer — the white pays the first symbol and the blue the second — and a greedy pass in symbol
order that takes the white for `{W/U}` leaves `{G/W}` unpayable and the cost refused. So `payCost`
searches: depth-first over the symbols, at most a handful with two options each, which is a few
dozen possibilities at the very worst. Hybrids are assigned **after** the coloured symbols and
**before** the generic part, for the same reason colours come first — a hybrid can only be paid two
ways and generic can be paid any way.

`solveTap` learns it through `shortColors`, which now reports the **union of the halves** of the
symbols it cannot pay: "any of these would help". That is deliberately not a claim that all of them
are needed, and it is enough because the tap loop re-asks after every land.

And the mana value counts a hybrid symbol as **one** (CR 202.3f), whichever half pays it.

**Still refused, and each for its own reason:** phyrexian (`{R/P}`, one red *or two life*), snow
(`{S}`), and *monocoloured* hybrid (`{2/W}`, two generic *or* one white). Each is a different shape,
and approximating any of them into colour hybrid would be wrong in a way a player would feel.

### The test that got better rather than edited

A deck-coverage test asserted that no scripted card's printed cost contains a `/`. That was a proxy
for "the engine can read this", and the proxy is now false: `{G/W}` is fine and `{2/W}` is not. It
asks `parseManaCost(...).unsupported` instead — the property that actually matters — so the next
symbol taught will not need the test edited. A guard written against a limitation ages into a guard
against the fix.

### Kitchen Finks, and persist's second card

`{1}{G/W}{G/W}`, a 3/2 that gains two life as it arrives, with persist. Two declarative lines and
nothing else new: the cost is the mana layer's business, the life is `gainLife`, and persist has
been `comesBackWithACounter` since D181.

Adding it is the point. **Persist had exactly one card behind it**, and that card is a 1/1 — so the
body persist returns is a 0/0 that the state-based actions put straight back in the graveyard.
Correct, and not much of a demonstration. The Finks is a 3/2, so what comes back is a **2/1 still
standing**, which is the half of the mechanic the pool could not show. It replaced Verdant Guard's
**Pacifism** (64% of the games it was in hand, 27 casts in 96) — the fifth piece of removal in a
list that already holds two Journeys to Nowhere, a Swords, a Conclave Tribunal, a Selesnya Charm
and a Banisher Priest. Measured at **36 casts in the 43 games it was in hand**.

**Measured: the largest single-slot card result this pool has produced.** Probing the revert — the
Finks out, the Pacifism back — on two seed sets of 288:

```
seeds 3300   203 against 173   revert -30
seeds 5100   196 against 181   revert -15
```

Both negative and one of them **outside the ±20 floor**, which no card in this pool had managed
before: the biggest previous card number was D183's Hellspark at +4 and +6, and the only larger
moves of any kind were bot rules (D175's +29, D180's +19).

Three things to keep it honest. It prices the **pair** — this Pacifism out, this Finks in — and
cannot say how much of thirty games is the body arriving and how much is the fifth removal spell
leaving; a deck with six answers and fourteen creatures was probably over-answered. One arm outside
the floor is one arm, and the second is inside it, so "between fifteen and thirty" is the honest
range rather than thirty. And a gain this size is a **balance fact** as much as a card result:
Verdant Guard was third at 61%, and a card worth twenty-odd games moves it towards the top of the
field, which is why the thirteen-deck table is republished with this entry rather than after it.

### And the Redcap's fix is worth nothing, measured

`cast-counts` on Ashen Rite, before and after the cost was corrected:

```
                       casts   games in hand
{2}{B}{R}  (wrong)       35         67
{2}{B/R}{B/R} (printed)  35         67
```

Identical. The reason is the mana base: seven Swamps, seven Mountains, two Rakdos Guildgates and a
City of Brass mean that by the turn four mana is available, one of each colour almost always is too.
The harsher cost never actually bit in 96 games.

**That is the second fidelity fix in a row measured at zero** — D185's unearth bounce was the first —
and two is enough to say the thing plainly: a rules deviation is worth *measuring* rather than
assuming, in either direction. D183's unearth leak was worth half a card; these two were worth
nothing. The reason to ship them is the same either way: the card says so, and a player who knows
the card will expect it to work.

## D191 — Cascade: the first trigger that fires from the stack, and the first cast with nothing paid

Two engine firsts arrived behind one keyword, and they are worth separating because only one of
them is about cascade.

### A trigger that fires from the stack

Every watcher in this engine, up to now, was a permanent on a battlefield. `raise` walks the
battlefields in APNAP order, offers each permanent the event, and `triggerMatches` decides from the
trigger's own wording whether it wants it; the three exceptions — a death, a leave, a card arriving
in a graveyard — fire from wherever the permanent *went*, and only for the permanent it happened
to.

"When you cast this spell" is none of those. It is an ability of a card that is **on the stack**,
and it is the shape a whole family of keywords abbreviates: cascade, storm, replicate, conspire,
ripple. So the `spell-cast` trigger gained a `self` flag, `raise` puts the card being cast at the
head of the watcher list for that event, and the zone check lets it through — `fromStack`, beside
the `fromGraveyard` that Rancor needed in D157.

**The guard matters more than the feature.** A card's script may hold a battlefield cast trigger —
Guttersnipe, Firebrand Archer, Chalice of the Void — and a stack watcher that answered those would
fire them off the card's own casting on the way past. Chalice is the one that would have been
visibly wrong: its trigger is `by: 'any', spell: 'any'` and its condition compares the spell's mana
value with its own charge counters, which a Chalice still on the stack has none of. A Chalice cast
for X=0 is a nought-cost spell, so it would have **countered itself** on the way in. The loop
therefore skips a stack watcher for any trigger that does not say `self`, and there is a test on
exactly that cast.

### A cast with nothing paid

The engine had five places a spell could be cast *from* — hand, command zone, graveyard (flashback,
escape), exile (foretell, an adventure) — and every one of them was a player action with a cost
paid and a timing checked. Cascade needs neither: the cast happens **inside the resolution of a
triggered ability**, with a spell on the stack underneath it, and nothing is paid at all.

The design question was whether to have the engine cast the card itself. It cannot: casting is a
choice with every other choice inside it — which half of a split card, which creature the spell is
pointed at, how three damage is divided — and an engine that answered those for the player would be
playing their turn for them. So the resolution stops and **offers**:

```ts
readonly pendingFreeCast: {
  readonly seat: SeatIndex;     // who may cast it
  readonly card: string;        // the card in exile, face up
  readonly prompt: string;      // what the table says
  readonly bottom: readonly string[];  // the rest of the pile, bound for the bottom
  readonly source: string;      // the spell whose keyword did this
} | null;
```

The fourth thing that stops the table dead, after a mid-resolution question, a trigger waiting for
its targets and a ward — and the first one that is answered with a **play** rather than an answer.
`legalActions` narrows that seat's plays to the casts of that one card, every other seat is given
nothing, and `auto:cast` with `free: true` claims the offer. Three refusals make the flag a claim
rather than a licence: nothing on offer, an offer belonging to somebody else, an offer for a
different card. A fourth refuses an X, because X is nought in a cost that is not paid
(CR 107.3b) — otherwise "without paying its mana cost" would buy a Fireball for twenty.

**Declining is a pass.** No second action for it: a seat with a free cast on offer holds no
priority, so there is nothing else a pass could mean, and the table already draws that button on
every other turn of the game. The pile goes under the library either way, which is what the
keyword costs.

Everything else about the cast is ordinary, and deliberately so. It goes through `castSpell`, so it
chooses targets and modes, it pays an additional cost if the card has one, it rings every cast
trigger on the table, it can be countered, and it reads `(free)` on the stack beside the
`(flashback)` and `(foretold)` labels. The one line that makes it free is an empty cost handed to
the same `payFrom` every other cast uses.

### What cascade is worth, and what it hits

`scripts/measure/offers.mjs` (built here as `cascade.mjs`, renamed in D193 when madness joined it)
is the new instrument, and it exists because the keyword reads better
than it measures: a free spell off the top of a sixty-card deck is a free spell only when the top of
the deck is not one of the twenty-three lands. It watches `pendingFreeCast` in the state rather than
the log, counts the depth of each dig, names the hit, and splits the answers into cast and declined.

First reading, 144 games of Kindle Grove against the field:

```
20 cascades fired, 1.95 cards exiled each (the hit included)
of them: 18 cast, 2 declined

what it hit:
   8  Llanowar Elves      1  Lightning Bolt      1  Thornweald Archer
   3  Ambush Viper        1  Lightning Strike    1  Prey Upon
   2  River Boa           1  Rancor              1  Borderland Marauder
                                                 1  Rampant Growth
```

**Twenty cascades in 144 games is the number that explains everything else.** A one-of four-drop is
cast in about one game in seven, so the keyword fires about as often as the card is drawn, and what
it buys is most often a **Llanowar Elves** — a one-mana creature, which is roughly half a card.
Two offers of twenty were declined, both because there was no legal way to cast what came up.

### Measured: a small gain this instrument can only just see

Probing the revert — the Elf out, the Giant Growth back — on four seed sets of 288:

```
seeds 3300   162 against 153   revert  -9
seeds 5100   174 against 181   revert  +7
seeds 7100   186 against 169   revert -17
seeds 9100   177 against 156   revert -21
```

Three of the four say the card is worth something and one says it is worth less than nothing; the
mean is about **ten games of 288**, which is half the ±20 noise floor, and only one arm (−21) sits
outside it. Under the rule this project has been using — two seed sets kill a change, four ship a
small one — this is the four-set case: the direction is consistent enough to keep and the size is
too small to publish as a single number.

**That is the honest expectation rather than a disappointment.** Twenty firings in 144 games, each
worth about half a card, cannot move a win rate by more than a few games — and a keyword shipped
for the engine path and for the player who knows the card does not need to. What the measurement
rules out is the opposite worry: a free spell every game, which this is not.

### What it cost, and the one thing not driven in a browser

`pendingFreeCast` is the fourth thing that stops the table, which means four places had to learn
about it: `resetPriority` and `legalActions` (nobody holds priority while it stands), `seatsToAct`
(the seat it belongs to is the only one with a move), and the bot in two places — `botAction`, where
the offer is let past the priority guard so the search picks the target, and `answerPending`, where
a simulated line takes it greedily rather than searching inside a search (D71's lesson).

The web path is a sentence in the arena bar, a **Cast it** button beside a **Decline** that sends a
pass, the playable badge on the exile row, and the `free` flag on the action the table builds —
which is the fifth time that one line has been needed and the sharpest, because without it the
engine refuses a cast the table had just offered.

**And it is now driven in a browser**, which the first version of this entry said it was not. The
gap was real and the way round it was a deck rather than a harness: `LIST=cascade` in
`scripts/e2e-solo.mjs` pastes sixty cards built for the keyword — eight Bloodbraid Elves,
twenty-three lands, and nothing else over three mana — through the same pasted-list path a player
uses, and then **requires** the free cast that the default run only samples. Four runs in a row
reach it, take it, and finish the game.

That run found two things the engine's own tests could not, and both were in the table rather than
in the rules:

1. **The table stalled on its own offer.** Nobody holds priority while a free cast stands, so the
   control bar had no primary action and `isMyMove` read the table as "nobody has anything to do" —
   the game stopped at turn seven, one move after a Bloodbraid Elf was cast. The driver's list of
   prompts that block the bar carries a comment warning about exactly this, written the last time
   somebody left one off it.
2. **A cascade into an Aura looped.** Rancor needs a target, so taking the free cast opens the
   targeting prompt *while the offer is still on the table* — and a driver branch placed above the
   targeting prompt pressed "Cast it" again instead of choosing what to enchant, forty moves
   running. The branch belongs below every prompt that is the browser's own half-finished
   interaction, which is where it is now.

Neither is a rules bug and both are the reason a browser suite exists: the engine was right both
times and the table was unusable.

## D192 — Storm, the first count of a turn's spells, and a rule measured at zero firings

Cascade (D191) built a path: a trigger that fires from the stack, for the family of keywords
printed as "when you cast this spell". Storm is the second card down it, and it cost one new fact
and nothing else — which is what a path being right looks like.

### The fact: how many spells have been cast this turn

`GameState.spellsCastThisTurn` is a running total of everybody's spells, reset in the cleanup step
with the rest of what "this turn" means. The first thing this engine has ever counted about a
**turn** rather than about a permanent, a seat or the stack, and the reason it has to exist is that
nothing else remembers: a Lightning Bolt cast and resolved two spells ago leaves exactly the same
trace as one cast last turn.

Each spell also carries `StackObject.castNumber` — the total **as that spell was cast**. The
snapshot is the half worth being careful about, and it is not a micro-optimisation: an opponent
answering a storm spell casts a spell of their own while the storm trigger is still on the stack,
and that one was not cast "before it" (CR 702.40a). Reading the live total on resolution would
quietly turn every answer to a storm spell into a copy for its caster. There is a test on exactly
that sequence.

**Grapeshot** ({R}, one damage to any target, storm) goes into Arc Tempest for its second Magma Jet.
Each copy keeps the original's target, which is the rules' own default (CR 707.10) rather than a
simplification of "you may choose new targets for the copies": the engine does not offer the
re-aim, so a Grapeshot pointed at a player is four damage to that player and not one each to four
creatures — the narrower reading, and the one that cannot be wrong in the player's favour.

The slot is deliberately **not** the obvious one. Twincast is the least-cast card in Arc Tempest by
a distance — 2 casts in 96 games — but it is the only card in any deck that copies a *spell* and
offers "you may choose new targets for the copy", and this pool does not keep paths with no card
behind them. So the Magma Jet went instead.

### Measured: level, and the bot cannot use the keyword at all

`scripts/measure/storm.mjs` is the new instrument, and it asks two things. The second is the one
worth keeping: **how many spells a turn of this format actually holds**, read off
`spellsCastThisTurn` as each turn ends.

```
848 turns: 42% held no spell at all, 37% one, 18% two, 3% three, one turn in 848 held four
```

And the first is the card's own number, which is where it gets interesting:

```
7 storm spells cast, 7 of them with a count of nought
```

**Every Grapeshot the bot cast was the first spell of its turn** — one mana for one damage, with the
keyword doing nothing. The paired probe agrees that this costs nothing either way: stock against the
revert on two seed sets of 288 is 126-128 and 114-113, which is level to within two games.

### The rule that looked obvious, and fired zero times

The reading above has an obvious explanation — the bot casts its cheapest spell first, so the storm
card goes down before the spells that would have counted — and an obvious fix in the family this
project has sixteen members of already: **drop a storm cast that is the first spell of a turn when
there is another spell to cast first**. An eighteenth filter, about *order* rather than waste.

It was written, wired in, and measured at **zero firings**: 7 of 7 still at nought. So the
explanation was wrong, and asking the bot directly says why — given a Grapeshot, a Lightning Bolt
and three mana, it **already** casts the Bolt first. The Grapeshots at nought are the ones cast when
there was nothing else castable at all, which is a mana problem and not a sequencing one, and the
same instrument says how common that is: 42% of turns in this pool hold no spell whatsoever.

The filter is deleted, and this is the second rule in nine entries to be built and deleted on a zero
(D184's `equipAddsNothing` was the first). The number is worth more than the rule would have been:
it says the ceiling on storm in this engine is the mana curve, not the bot's judgement, and that a
card which multiplies by a turn's spell count is a card for the two people at the table rather than
for the computer opponent.

## D193 — Madness, the offer with a price on it, and a bot rule that is right and worth nothing

Cascade's `pendingFreeCast` has become `pendingOfferedCast` with a `cost`, because madness
(CR 702.35a) turned out to be the same question with a price on it: *you may cast this card, now,
out of exile*. One field, two keywords, and the action flag is `offered` rather than `free` for the
same reason — the flag claims an offer, and what the offer costs is the offer's business.

### What madness needed that cascade did not

**A discard has to be distinguishable from every other way a card reaches a graveyard.** Madness
replaces the *discard* — not a mill, not a spell finishing its resolution — and by the time a
replacement runs the card has already moved, so the zone it came from is gone. `relocate` now
records hand-to-graveyard moves in `GameState.discarded`, in the one place a card changes zone, and
`ReplacementContext` carries it. Without that the keyword would fire on a Fiery Temper that had just
resolved as a spell, and offer it again, every time, forever.

**And an offer nobody can pay for is not a choice.** A Temper discarded with no red mana up would
otherwise stop the table to ask a question with one answer. `settleOffer` takes it back and says so
through the replacement channel, which is the rule and the mechanism `settlePayment` already used
for a ward nobody can pay.

Declining now finishes the move the replacement interrupted: a cascade hit goes to the bottom of the
library with the rest of its pile, a madness card to the graveyard it was being discarded to.

The keyword is a **field** on the script rather than a replacement each card writes out —
`madness: { cost: '{R}' }` — because the cost has to be readable by everything that wants it:
`legalActions` prices the play from it, `settleOffer` asks whether it can be paid, and the bot's
discard policy reads it. A cost inside a closure is a cost only that closure can see.

**Fiery Temper** goes into Ashen Rite for its third Blood Artist. The slot is a redundant copy
rather than the least-cast card, and that is a finding about the list rather than a preference:
every card below the Temper in usage is the only card in any deck behind some engine path — Hagra
Mauling is the pool's one modal double-faced card, Bone Splinters the one removal spell with an
additional cost, Phyrexian Arena and Dark Confidant each carry tests nothing else carries.

### Measured: level, and the keyword never fires in a bot's hands

The paired probe on the slot, two seed sets of 288: **153-150** and **132-133**. Level to within
three games, which is what a three-mana removal spell traded for a third copy of a drain effect
should be.

`offers.mjs` — the cascade instrument, generalised to the machinery both keywords share — says the
more interesting thing. Over 96 games of Ashen Rite:

```
281 cards discarded, 0 of them a madness card
 41 discards made out of a hand that was holding one
 29 of those had the madness cost payable *before* the action
  0 offers made, 0 taken back
```

The bot had the Temper in hand and discarded something else forty-one times, because both discard
policies rank by mana value — one pitches the cheapest card, the other the dearest, and a
three-mana sorcery is neither.

### The rule, and the honest number for it

So the rule writes itself: **when a discard is owed and a madness card is in hand whose cost is
payable, give up that card first.** It is not a discard at all; it is a cheap spell. There is a test
on both halves — with two Mountains the bot pitches the Temper and the offer appears, with one (the
Looting having spent it) it leaves the Temper alone and the ordinary policy wins.

And it fires **zero times in 96 games**, which the same instrument says and which this entry has to
say too. The 29 chances were payable *before* the action and not at the moment of the discard: the
bot casts the Faithless Looting with the mana that would have paid for the madness cast, or it is
discarding at cleanup because it has spent everything. That is not a new finding — it is the ceiling
D108, D110 and D119 each measured from a different direction: **this bot does not hold mana.**

The rule stays, and the difference from the two rules this project has built and deleted on a zero
(D184's `equipAddsNothing`, D192's storm filter) is worth being precise about. Those two were
*wrong*: one was subsumed by a rule that already caught the case, and the other was written from an
explanation the measurement then contradicted. This one is right — there is a position where it
changes the play, and a test that holds it there — and it is unreachable today for a reason that is
documented, measured and not about madness. A correct rule worth nothing is kept and labelled; an
incorrect rule worth nothing is deleted.

## D194 — Evoke: the first alternative cost that changes what the permanent does afterwards

Flashback, escape and foretell each replaced a cost and were finished with it. Evoke (CR 702.74) is
the first one in this engine where the cost is only half the sentence: *you may cast this for
{2}{U}, and when it arrives you sacrifice it.* A Mulldrifter cast for its evoke cost is still a
Mulldrifter spell — it resolves onto the battlefield, it draws its two cards — and then it goes
away, which is the whole trade and the whole of what had to be built.

### The sacrifice is a trigger, not a mechanism

The keyword's second half is printed as a triggered ability with an intervening-if clause: "When
this permanent enters, **if its evoke cost was paid**, sacrifice it." The engine already asks an
intervening-if twice (CR 603.4), already sacrifices permanents, and already puts two of a card's
triggers on the stack at once — so evoke's sacrifice is written out as `evokeSacrifice()`, a
TriggerDef factory beside `cascade()` and `storm()`, and nothing new was added to resolution at all.

What the condition reads is the one thing the card cannot know. By the time the trigger resolves the
stack object is gone, and a Mulldrifter on the battlefield is a Mulldrifter however it was paid
for — cast for five, cast for three, reanimated, copied. So the fact is written onto the permanent
as it arrives, as the `EVOKED` counter, for the three reasons unearth's marker was: a counter is
already per-permanent, already serialised and already visible on the card. It travels no further
than this body, which is also the rule — a creature that evoked, died and came back is a new object
and stays.

**The sacrifice is listed first in the card's triggers, and that ordering is the card.** Triggers of
one controller go on the stack in the order their script lists them, so the first listed is at the
bottom and resolves last. A Mulldrifter whose sacrifice resolved before its draw would be three mana
for nothing at all. There is a test on exactly that: both abilities on the stack, the sacrifice
underneath.

### Where the play is offered, which is not where the kicker's is

The cast itself is a second play on the same card in the same zone — the kicker's shape, with the
trade reversed. The kicker can only ever make a cast *more* expensive, so `legalActions` can offer
it last, after the printed cost has been priced. This one is cheaper, and the turn the card is in
the deck for is the turn the printed cost cannot be paid: a Mulldrifter with three lands untapped is
a Divination. So the evoke play is pushed **above** the affordability check, beside morph's and
foretell's, and it asks `specsFor`/`playableTargets` for itself rather than borrowing the work the
ordinary cast does further down.

Everything else is the ordinary cast: `evoked` is a flag on `auto:cast`, refused on a card with no
evoke and refused beside flashback, escape, foretell, an offered cast or a kicker, because an
alternative cost is paid *instead of* another and not beside one (CR 601.2f). It is announced on the
stack as "(evoked)" for the reason every other cast flag is announced there: a player deciding
whether to counter this creature spell is deciding whether to spend a card on a creature that is
about to sacrifice itself anyway.

### Mulldrifter, and the slot it takes

**Mulldrifter into Tidal Mind**, for the Think Twice. The deck is the pool's weakest and its
diagnosis has not moved since `killed-by.mjs` read it (D139): it answers four or five things, kills
nobody, and what it does on a turn with three mana and nothing to answer is draw a card and pass.
This card is that turn's Divination and, on a turn the game has gone long, five mana for a 2/2 flier
that draws two — one slot doing the deck's two jobs rather than one of them twice. The Think Twice
is the right slot because it is the other card there that draws a card and does nothing else, and
because Arc Tempest runs two copies, so the flashback path keeps a home.

### Measured: the slot is level, and the cheap half is taken once in thirty-three

Two seed sets of 288 paired duels, probing the revert:

```
3300   with Mulldrifter 119-167   with Think Twice 109-179   +10
5100   with Mulldrifter  92-193   with Think Twice 106-181   -14
```

Opposite signs, both inside the ±20 floor this instrument has for a one-slot change on 288 games.
The slot ships on the rules argument and the role, and the number is written down as nothing.

`cast-counts.mjs` says the thing worth keeping, and it needed one small addition to say it: every
cast that carries an alternative-cost flag is now tallied under `name (flag)` beneath the table, so
"which of the two costs did the bot pay" is a question the instrument can answer for any keyword,
including ones added after it. Over 96 games of Tidal Mind:

```
75%  cast 33 + used 0 / in hand 44 games  x1  Mulldrifter
  1  Mulldrifter (evoked)
```

The card is cast in three quarters of the games it reaches hand, which makes it one of the busier
slots in the deck — and **one** of those thirty-three castings paid the evoke cost. That is not the
keyword failing: it is the bot reaching a five-mana card on a turn it has five lands, which is what
happens when a card is drawn on turn six rather than turn three. The choice the keyword exists for
is a choice about *this* turn's mana, and the measured answer is that the position comes up about
once in a hundred games. Written down rather than tuned around.

## D195 — Dash: evoke's mirror, and the first cost whose consequence nothing can respond to

Evoke buys the spell and gives up the body. Dash (CR 702.109) buys the body for one turn and gives
up keeping it: cast a Mardu Scout for {R} rather than {1}{R}, it has haste, it attacks the turn it
arrives, and at the beginning of the next end step it goes back to its owner's hand — the same card
again next turn, for the same one mana.

### Why the two halves live in different places

Evoke's sacrifice is a **triggered ability printed on the card**, so the card carries it and the
engine's only job is to record how the spell was paid for. Dash's haste and return are part of the
**resolution of the spell itself** (CR 702.109a) — nothing goes on the stack for either, so there is
no window between the creature arriving and it having haste, and no trigger an opponent can counter
to keep it on the battlefield. So `completeResolution` does both as the permanent arrives, and the
difference from evoke is the whole of what this entry is about: the same question — "how was this
paid for?" — answered in the same place, with one answer belonging to the card and the other to the
rules.

The return is a **delayed trigger** (D135's machinery), which is what the card says it is: once
created it stops belonging to the permanent (CR 603.7d), so a dashed creature killed, exiled or
bounced before the end step leaves the ability behind, and the ability does as much as it can,
which is nothing. There is a test on exactly that — the card must not come back out of a graveyard.

The ability itself lives on the card as its one `delayed` end-step trigger, found rather than
declared, which is the arrangement unearth's exile already uses: an index written beside the keyword
is an index that eventually disagrees with the list it points into. A test walks every scripted card
with `dash` and asserts it carries exactly one.

`DASHED` is a counter like `EVOKED`, and kept for a different reason: nothing in the rules reads it.
The haste and the return are both arranged on arrival. What it is for is the table — a 3/1 that is
about to vanish looks exactly like a 3/1 that is staying — and the next card to want "if its dash
cost was paid".

### One block in `legalActions`, because the two are the same shape

Both are a second play on a card in hand, cheaper than printed, offered above the affordability
check. So the evoke block became a list of alternatives with one sentence each saying what the cheap
cast costs besides mana: "sacrificed as it arrives", "hasty, back to your hand at end of turn". A
card printed with both would be offered twice, which is also the rule.

### Mardu Scout, and the slot it takes

**Mardu Scout into Kindle Grove**, for the second Centaur Courser. The deck's plan is damage now,
and the Scout is the only card in the pool that offers the same damage every turn for one mana
without ever being on the board to be answered. The Courser is a vanilla 3/3 in a list that already
curves Burning-Tree Emissary into Borderland Marauder into Ambush Viper; one copy stays.

It sits beside the **Hellspark Elemental** on purpose. Both are three damage that does not stay, and
they pay for it differently: the Hellspark goes to the graveyard and costs {1}{R} to buy back once,
the Scout goes to hand and costs {R} every turn, for ever. One list, two answers to the same
question.

### Measured: level again, and a keyword the bot actually takes

Two seed sets of 288, probing the revert:

```
3300   with Mardu Scout 164-122   with a 2nd Courser 162-124   +2
5100   with Mardu Scout 169-119   with a 2nd Courser 174-114   -5
```

Level, well inside the floor, and the slot ships on the role — the same finding the Mulldrifter
slot got in D194, from a deck at the other end of the table.

What is *not* the same is the usage, and that is the pair of numbers worth having. Over 96 games:

```
128%  cast 60 + used 0 / in hand 47 games  x1  Mardu Scout
  14  Mardu Scout (dashed)
```

Sixty castings out of forty-seven games that had the card in hand — more than one per game, which is
only possible because the dashed copies came back. Fourteen dashes, against the Mulldrifter's
**one** evoke in the same number of games. The two keywords are the same engine path and the same
kind of choice, and the bot takes one of them fourteen times as often, because dash's choice is
"spend one mana now" and evoke's is "give up a creature you could have had" — the first is a
decision a greedy player makes every turn and the second needs a plan for the turn after.

That is also the honest limit of the comparison: a bot that does not hold mana (D108, D110, D119)
will always prefer the keyword whose cheap half costs it nothing it was saving.

## D196 — Bestow: the spell that is a different kind of thing depending on what you paid

Evoke and dash (D194, D195) change what happens to the permanent after it arrives. Bestow
(CR 702.103) changes what the spell **is**: cast a Boon Satyr for {1}{G}{G} and it is a 4/2 with
flash; cast it for {3}{G}{G} and it is an **Aura** that gives +4/+2 — not a creature at all — until
the creature it enchants leaves, and then it becomes the 4/2 where it stands.

That last clause is the only rule in this engine that changes a permanent's type without the
permanent moving, and it is the whole reason the keyword is played: the removal spell aimed at your
creature leaves you a creature instead of two cards in the graveyard.

### What it is, rather than what it does

The fact lives on the **card**, as `CardInstance.bestowed`, and is read by `characteristicsOf` in
the same breath as `castAs` and the face-down profile. All three answer the same question — *what
is this object?* — and the reason they are read together is that everything downstream asks one
function. A reader that had to know bestow exists is a reader that eventually forgets: "counter
target creature spell" hands a card id to a filter, a board wipe walks the battlefield asking which
permanents are creatures, and neither of them has been told anything.

It is set at **cast time**, before the object reaches the stack, because the difference is public
from the moment the spell is announced (CR 702.103b): a bestowed Boon Satyr on the stack is an Aura
spell, so an Essence Scatter cannot be pointed at it and a prowess creature sees a noncreature
spell. `relocate` keeps it on the stack and the battlefield and clears it everywhere else, the way
it treats `faceDown` — the card in the graveyard afterwards is a creature card again, which is what
a reanimation spell brings back.

Three consequences came free from putting it there rather than in a continuous effect: a bestowed
permanent is not swept by Day of Judgment (which Verdant Guard runs), it cannot attack or block,
and layer 4 still works on top of it — something that animates an Aura makes it a creature once
rather than twice.

### Becoming a creature is a state-based action, not a replacement

CR 702.103c says the Aura stops being one when the creature it enchants leaves. The engine already
has the rule that sends an Aura with no host to the graveyard (CR 704.5m) and this is a clause
inside it: a bestowed permanent clears its flag, drops its attachment and stays. Not a replacement
effect, because nothing is being replaced — the Aura never begins to go anywhere, it simply stops
meeting the condition that would send it. The pump goes with the attachment through
`removeEffectsFrom`, the way the Equipment rule beside it already does, or a dead creature's +4/+2
would sit in `effects` for the rest of the game.

### One block for three keywords, and the one that points at something

`legalActions` now offers evoke, dash and bestow from one list of alternatives, each carrying its
cost, the sentence that says what the cheap cast costs besides mana, and — new with this one — **its
own target specs**. A bestowed cast enchants a creature where the ordinary cast of the same card
targets nothing, so the two plays on one card ask different questions, and an Aura with nothing to
enchant is not offered at all (CR 601.2c). The target spec is a constant rather than a field on each
card: every card ever printed with bestow says "enchant creature", and a field thirty cards would
fill in identically is a field twenty-nine of them eventually get wrong.

### Boon Satyr, and the slot it takes

**Boon Satyr into Verdant Guard**, for the second Secure the Wastes. The deck's recurring problem is
being two-for-oned — a Loxodon Warhammer on a creature that then dies, a Giant Growth that fizzles —
and a bestowed Satyr is the only card in the pool that cannot be: answer the creature and the Aura
stands up as a creature itself. The slot is a second copy rather than a card the deck only has one
of, which is this list's own rule for a cut.

### Measured: level again, and a keyword the bot never reaches for

Two seed sets of 288 paired duels, probing the revert:

```
3300   with Boon Satyr 199-88   with a 2nd Secure the Wastes 202-85   -3
5100   with Boon Satyr 189-99   with a 2nd Secure the Wastes 193-95   -4
```

Level, and the third slot in a row to come out that way — which is itself worth noticing: three
keywords, three decks at three different places in the standings, and each new card neither helps
nor hurts a list that was already tuned. A one-card swap is below this instrument's resolution
unless the card is doing something the deck could not do at all.

`cast-counts.mjs` over 288 games says the Satyr is one of the busiest cards in the deck — **cast 63
times in the 66 games it reached hand, 95%** — and that **none** of those castings paid the bestow
cost. Not one.

That is the same finding evoke got (one casting in thirty-three) with the volume turned up, and the
cause is the same and simpler than it looks: the bot casts the cheap half because the cheap half is
cheaper. A Boon Satyr for {1}{G}{G} is a 4/2 on the board; for {3}{G}{G} it is +4/+2 on a creature
that is already there, for two more mana. A greedy evaluation picks the body every time, and it is
usually *right* to — bestow is for the turn you have a creature worth protecting and the mana to
spare, which is a plan about the turn after rather than a bigger number now. No rule is written for
it, because D193's doctrine holds: a bot rule gets written when an instrument says what it is worth,
not when a keyword looks lonely.

**And the instrument needed more seeds than usual to say even that.** The first run of `cast-counts`
at `SEEDS=4` read "in hand 4 games" for the Satyr, which looked like a bug and was not: the subject
deck gets one shuffle per seed per seating, so four seeds is **eight** library orders, and a card
that happens to sit deep in all eight is never drawn. Twelve seeds is twenty-four orders and the
same card reads 66 of 288. A per-card usage question needs more seeds than a per-deck record does,
and that is now written in the harness's README.

### And all three are driven in a browser

`LIST=costs` in `scripts/e2e-solo.mjs` is the cascade scenario's idea applied to a wider question.
Evoke, dash and bestow each add a second row to a card already in your hand, and the table is the
only place the choice between the two rows is made: the engine's own tests build the action by
hand, so a row offered wrongly — or a bestow that never asked which creature to enchant — would
pass all 997 of them. The deck is six Mulldrifters, eight Mardu Scouts, six Boon Satyrs and twelve
guildgates to cast them with, pasted in as text through the path a player uses, and the run
requires all three rows to be pressed.

What it needed that the cascade scenario did not says the same thing twice: **one game is not
enough**. Which of the three a game reaches depends on what it draws and how long it lasts. The
first run failed on dash with 27 moves in sixteen turns — a three-colour mana base failing rather
than a keyword, and the fix was twelve guildgates, four from each guild involved. Three runs after
that each pressed a different *two* of the three. So the scenario deals again, up to three games,
through the same "play again" button the rematch check presses, and three runs in a row then
reached all three.

**The tidier-looking fix was tried and made it worse**, which is the part worth keeping. Teaching
the driver to prefer the row that pays an alternative cost turns the run into a loop: a dashed
Mardu Scout is back in hand at the end of the turn, so the cheap row is always available and always
cheapest. One run paid the dash cost **twenty-one times across three games and never cast the
Mulldrifter once**. The driver's random pick is what gives the other two cards a turn, and it stays
— the bias was reverted, and this paragraph is what is left of it.

## D197 — Spectacle: the first cheap cast the board has to earn, and the engine's first fact about a turn's life loss

Evoke, dash and bestow (D194–D196) are always on offer: the row is on the card from the moment the
card is in hand, and the only question is whether you can pay. Spectacle (CR 702.137) is the first
alternative cost in this engine that **has to be earned** — "you may cast this spell for its
spectacle cost if an opponent lost life this turn" — so the row appears mid-turn, and on a turn
nobody has been hit it is not there at all.

A Skewer the Critics is a Lightning Bolt after an attack and a bad Lava Spike before one. The
keyword is the second half of a turn rather than a card.

### The fact a condition needs, and why nothing already held it

The condition cannot be answered from anything this engine had. Not from the life totals: a player
on eighteen may have been on twenty a moment ago or for the last four turns. Not from the board,
which does not record what happened to produce it. And not from `Seat.damageFrom`, which is the
whole game rather than this turn, and counts **damage** rather than life — an opponent who paid two
life to a City of Brass has lost life and taken none.

So `GameState.lifeLostThisTurn` — a map of seat index to life lost, and the second thing this engine
remembers about a *turn* rather than about a permanent or a seat, after storm's `spellsCastThisTurn`
(D192). Reset in `endTurnCleanup` beside it, and for the same reason: life lost in somebody's end
step was lost *this* turn, so the cheap cast is payable until the turn is actually over.

It is recorded by **one function called from two places**, `recordLifeLost` in `effects.ts`, reached
from the player half of `dealDamage` and from `loseLife`. That is `relocate`'s discipline applied to
a smaller fact: one place per kind of event means no path can forget, and a tally written at each
call site is a tally some call site eventually misses. The two places are the two places a seat's
life goes down, which was worth checking rather than assuming — every drain, every burn spell,
every Dark Confidant trigger and every painland in the pool goes through one of them.

**Damage replaced by poison is not life lost**, which is the rule (CR 120.3) and not an oversight:
infect replaces what being dealt damage does to you, and what it does is not lose you life. Blight
Vector's hits do not turn on a spectacle cost, and there is a test that says so.

### A row that comes and goes, and the refusal under it

`legalActions` builds the spectacle entry **conditionally** — the first of the four alternatives
that is not simply pushed — and when the condition is false the row is absent rather than present
and unpayable. That is how every other cost this engine cannot pay is handled, and it is better
than a greyed-out row nobody can read a reason off. When it *is* there it says why:

```
Cast Skewer the Critics for its spectacle cost ({R}, because an opponent has lost life this turn)
```

"An opponent" is every other seat still in the game, so in a pod a hit on anybody but you pays for
it, and your own life never does. `castSpell` refuses a spectacle cast whose condition is false with
its own message, which is the same belt-and-braces the other three flags have: the engine is the
authority on what a spell cost, not the client.

There is no second consequence to build. Evoke had a sacrifice, dash a haste and a return, bestow a
type change; spectacle changes the **price and nothing else**, which is why the card is two
declarative lines and the work was all in the fact underneath it.

### Skewer the Critics, and the slot it takes

**Skewer the Critics into Ashen Rite**, for the second Zulaport Cutthroat. The deck earns the
condition without trying: two Blood Artists, a Zulaport Cutthroat, a Fate Unraveler and an Impact
Tremors take life off the other seat whenever anything happens, and five burn spells do it on
purpose — so by the time three mana is available, one mana usually is enough. The cut is a second
copy of a card the list effectively has four of (Blood Artist and Zulaport Cutthroat are the same
card at different rates), and one Cutthroat stays, so the script and the "your own side only" rule
it is the pool's test case for are both still there.

### Measured: level again, and the first of the four the bot actually reaches for

Two seed sets of 288 paired duels, probing the revert:

```
3300   with Skewer the Critics 147-140   with a 2nd Zulaport Cutthroat 150-137   -3
5100   with Skewer the Critics 127-161   with a 2nd Zulaport Cutthroat 131-157   -4
```

Level — the fourth slot in a row to come out that way, and the same two numbers the Boon Satyr
produced, which is coincidence rather than a signal: both are well inside this instrument's ±20
floor. A one-card swap is below the resolution unless the card does something the deck could not do
at all, and that result has now held for four keywords in four different decks.

The **usage** is where this one parts from the other three. `cast-counts.mjs` over 288 games:

```
 82%  cast  102 + used    0 / in hand  124 games  x1  Skewer the Critics
    28  Skewer the Critics (spectacled)
```

**Twenty-eight of a hundred and two castings paid the spectacle cost** — 27%, against dash's 23%,
evoke's one in thirty-three, and bestow's nought in sixty-three. So the answer to the question the
card was added to ask is yes: the bot does have the condition when it wants to cast the card, and
roughly one casting in four is the cheap one.

And the reason is the reason bestow's answer was no, read from the other side. The bot is greedy
about this turn (D108, D110, D119): it takes an alternative cost when the cost is simply smaller and
nothing is given up. Dash is cheaper and costs a turn of board; spectacle is cheaper and costs
*nothing at all* — the spell is identical either way — so there is nothing for the bot to weigh.
Twenty-eight is therefore much less a measure of its judgement than of **how often Ashen Rite has
already drawn blood by the time it wants to cast a three-mana burn spell**, which is a fact about
the deck and a fair one: about a quarter of the time. Evoke and bestow ask the bot to give something
up, and it almost never does.

Which is also why no bot rule is written here, for the fourth time: there is nothing to decide. The
greedy choice and the right choice are the same choice.

### The test that could not use the debug action

Writing the tests turned up one thing worth recording: `life:adjust` — the manual-table action that
moves a life total, and the quickest way to set up a board in a test — **records nothing**. It
writes the new total straight onto the seat without going through `loseLife`, which is right for
what it is (somebody at a manual table correcting a number, not an event in a game) and means it
does not turn a spectacle cost on. The test that needed an opponent to have lost life had to make
them lose it for real, with a Lightning Bolt pointed at them. That is the right shape: the fact is
recorded by the rules, and a test that could fake it would not be testing the rules.

## D198 — Overload: the first alternative cost that changes what the spell does

Four alternative costs in, the family had a shape: evoke and dash change what becomes of the
permanent (D194, D195), bestow changes what kind of object the spell is (D196), spectacle changes
only the price (D197). Overload (CR 702.96) breaks it in the one direction left — it rewrites the
**text**: "change each instance of 'target' to 'each'".

A Mizzium Mortars for {1}{R} deals four damage to one creature you don't control. The same card for
{3}{R}{R}{R} deals four damage to **every** creature you don't control, and points at nothing while
it does it.

### Two effects on one card, rather than one effect with a flag in it

`CardScript.overload` holds a cost **and an `onResolve` of its own**, and `completeResolution` picks
between the two on the stack object's `overloaded`. That was a choice, and the alternative — one
effect branching on `c.overloaded` — is worse for a reason worth writing down: the printed half
reads `cardTargets`, which is empty on an overloaded cast, so every line of it would have to guard
against a target it will never have, and the sweep would have to ignore a target it was never
given. The two halves are two different spells with one name, and two functions is what that is.

It is also the only one of the five where the *resolution* reads the flag at all. The other four
are spent by the time the spell resolves: evoke's sacrifice is a card trigger, dash's return is
scheduled as the permanent arrives, bestow's difference is on the card itself, and spectacle's is
over once the mana is paid. This one has to be asked at the moment the effect runs.

### Targeting nothing is the point, not a detail

The overloaded entry in `legalActions` carries `specs: []`, and `castSpell` sets `specs` to the
empty list when the flag is set — which refuses a target sent with it through the same
`checkTargets` every other cast goes through. That empty list is most of what the keyword is worth
at a table:

- a ward (CR 702.21) never triggers, because nothing becomes the target of anything — the printed
  Mortars at a Sedgemoor Witch has to pay {3} on top of its {1}{R} or be countered, and the
  overloaded one walks through;
- a Willbender has nothing to redirect and a Swerve nothing to point elsewhere;
- protection, hexproof and a Dive Down save nothing;
- and the spell cannot fizzle, so answering the one creature worth killing no longer answers the
  card.

The only answer left is a counterspell, which is why the stack says `(overloaded)`: the player
holding a Counterspell is deciding about a sweeper rather than a removal spell, and both players can
read which it is.

It is also four damage rather than "destroy", which a test says out loud with a Wall of Frost: a 0/7
takes the four and stands. That is the difference between this card and the Day of Judgment in the
same pool, and the reason it is not simply better.

### Dearer, and still an alternative cost

Overload is the first of the five that costs *more* than printed, which makes it the kicker's
neighbour on price and its opposite in mechanics: a kicker is paid **on top of** the printed cost,
an overload cost **replaces** it. So it goes in the alternatives list with the other four rather
than beside the kicker, and being dearer costs nothing there — the loop asks `canAfford` per
alternative, so the row is simply absent on a turn six mana is out of reach. That is the same answer
the printed cast gets when it cannot be paid, rather than a greyed-out row.

### One loop instead of eleven spreads, because TypeScript said so

`apps/web`'s `playAction` had grown one `const withX = play.flag === true ? { flag: true } : {}` per
alternative cost, each spread into the action it builds. The eleventh — this one — made the web
typecheck fail with **TS2590, "expression produces a union type that is too complex to represent"**:
eleven spreads of `{} | { flag: true }` is a union of 2,048 object types, and TypeScript stops
before it gets there.

So the eleven are now one `COST_FLAGS` list and one loop into a single object, and the eleven
comments are one comment that says what the family is: the engine offers a card as two or three
separate plays, one per price, and the flag is what tells it which row the player tapped. A cast
sent without the flag is not a validation error — it is quietly the *other* play, refused for want
of mana or for being in the wrong zone, about a card the table had just offered. Most of the eleven
were found that way in a browser suite rather than by reasoning, because the engine's own tests
build the action by hand.

A type error is not usually a design note, but this one is: it was counting the shape the code had
drifted into.

### Mizzium Mortars, and the slot it takes

**Mizzium Mortars into Ember Rush**, for the second Raging Goblin. Ember Rush is the deck that can
pay either half — eighteen Mountains and a Mutavault, so six lands is six red — and the one that
wants both: the cheap half is the answer a burn deck never had for a 4/4 blocker, and the dear half
wins the game this deck has otherwise already lost, the one where it is out of cards against a board
it cannot attack into. The cut is the second copy of the weakest card in the list, which is this
list's own rule; one Raging Goblin stays, so the three test files that use it by name are untouched.

### Measured: level again, and the first alternative cost the bot pays without being told to

Two seed sets of 288 paired duels, probing the revert:

```
3300   with Mizzium Mortars 210-78   with a 2nd Raging Goblin 208-80   +2
5100   with Mizzium Mortars 208-79   with a 2nd Raging Goblin 203-85   +5
```

Level — the fifth slot in a row inside the ±20 floor. Worth one honest note: this is the first of
the five where both arms lean the *same* way, and the lean is positive. Two and five are still
noise, so the entry is "level" and not "worth four games"; a card that is actually worth something
to this instrument looks like D139's clock, not like this.

`cast-counts.mjs` over the same 288 games:

```
 63%  cast   62 + used    0 / in hand   98 games  x1  Mizzium Mortars
    11  Mizzium Mortars (overloaded)
```

**Eleven of sixty-two castings were the sweep** — 18%, against spectacle's 27%, dash's 23%, evoke's
one in thirty-three and bestow's nought in sixty-three. And this one is the interesting number of
the five, because it is the first that is a *judgement* rather than an arithmetic consequence.
Spectacle and dash are cheaper and give up nothing the bot values, so taking them is not a decision;
bestow and evoke cost a body, so a greedy evaluation never takes them. Overload costs **four more
mana** and the bot still pays it almost one time in five — which it can only be doing because the
one-ply search can see the board it clears.

And `wasted-plays.mjs` says it is not paying it into nothing: over 72 games and 576 plays, the
suspects are a Goblin Arsonist (1 of 27) and a Flame Slash (1 of 22), and **Mizzium Mortars is not
in the list at all**. The sixteenth member of the "spent on nothing" family did not need writing,
because the search already prices a sweeper against an empty board correctly. That is the first time
one of these keywords has needed no bot work for a reason better than "it never presses it".

## D199 — The two rows that behave unlike the others, driven in a browser, and four tries at one deck

`LIST=costs` (D196) asks whether a second row on a card in hand can be pressed at all. Spectacle
and overload each add something no other row has, and neither could be reached by the existing
scenarios:

- **Spectacle's row appears mid-turn.** It is not on the card until an opponent has lost life this
  turn, and it is gone when the turn ends. Pressing it is a claim about a table that redraws its own
  sheet while the player is looking at it.
- **Overload's row has no targets at all.** The table has to send it the moment it is chosen; one
  that walked the player through picking a creature would hang on a question the engine refuses.

So `LIST=earned`: a mono-red sixty pasted in as text, and both rows required. What it cost to get
the deck right is the interesting part, because every attempt failed for a reason about the *game*
rather than about the harness.

**Try one — twelve Swiftspears, nothing else to earn it.** Three games, spectacle row reached in
none of them. An attack lands in *combat*, so the row only exists in that turn's postcombat main
phase, which is not where most casting happens. Six Lightning Bolts earn it precombat instead, and
a Skewer in the same hand then shows both of its rows at once.

**Try two — twenty-four burn spells and no bodies.** Against Tidal Mind's Wall of Frost that is two
decks that cannot close: one run went **450 moves of nothing but Pass** without reaching a winner,
and a second had to be killed. The list needed a clock, and prowess creatures are the clock a list
of twenty-four spells wants.

**Try three — the clock, plus Ember Rush as the opponent.** Both at once, and the second half was
wrong. Games came down to about **six moves**, three of them inside twenty-nine, and never saw a
sixth land: three runs pressed the spectacle row five times between them and the overload row not
once. One row wants a turn of combat behind it and the other wants six mana; a game short enough
for the first is too short for the second.

**Try four — Sol Rings, and the opponent back to Tidal Mind.** Eight mana rocks are what a player
would add to a deck that means to overload on time: three Mountains and two rocks is {3}{R}{R}{R} on
turn four, and an artifact spell is a noncreature spell, so each rock is a prowess trigger too. And
with the clock in the list, Tidal Mind is the right opponent after all — games of 36 to 59 moves,
**three runs out of three**, where Ember Rush managed three out of four. The stall was the missing
clock rather than the matchup, which is only visible in hindsight and is why the Ember Rush attempt
is written up in the file where it was made rather than deleted.

The deal budget is **five games** rather than `LIST=costs`'s three, for the reason the runs showed:
whichever row a shuffle offers, the other is usually one deal away, and a game under this list is
short enough that a re-deal costs nothing. A required check that fails one run in four is not a
check.

## D200 — A finished game stops asking: the one outstanding question that was not a field

CI failed once, on a commit that changed nothing but a browser script:
`apps/realtime`'s whole-game test got `awaiting: { kind: 'attackers', seats: [ 1 ] }` where it
expects null. The next commit was green and fifteen local repeats of that suite passed, so it was
intermittent and never reproduced — but looking for a mechanism that could produce exactly that
symptom found one, and it is a real bug that had been there since the automation layer.

`engine.ts`'s game-over block is careful about this already, and says so: a resolution can be
halfway through asking somebody a question when the last opponent dies, so ending the game sets
`pendingDecision`, `pendingChoice`, `pendingPayment`, `pendingOfferedCast` and `pendingDiscard` to
null and takes priority away (CR 104.1). It was found by a playout — a game that ended on a Magma
Jet left its scry standing.

Every one of those is a **field**. A combat declaration is not: `pendingDeclaration` derives it from
the step and the combat record. So a game that ended while attackers or blockers were owed went on
asking for them forever, and because `legalActions` withholds priority while a declaration stands,
the table had nothing else to offer either — a game-over screen that is also demanding attackers,
with no way out of it.

One line, where the other five are set: `pendingDeclaration` returns null on a finished game. The
test owes a declaration and then ends the game.

**And the fix is a candidate rather than a confirmed cause**, which is worth keeping straight. The
failure was never tied to either of that test's two `awaiting` assertions — they produce the
identical CI line and mean opposite things, one being the server not having finished the turn the
roll gave it and the other a finished table still asking — so both now carry a message naming
themselves, and the hunt stays open with the other suspect written down: a race between `runBots`
taking the bot's first turn and the view the test reads straight after `auto:keep`.

The general lesson is the one the game-over block had already half-learned. A rule that clears
outstanding questions has to enumerate them, and a derived question is the one that escapes the
list — because nothing in it looks like a field to set to null.

## D201 — The table's own atmosphere, and the test that had to be a browser

The engine had got a long way ahead of the table. Thirteen decks, two hundred scripted cards, five
alternative costs — played on a board that looked like a well-organised form. Two of the pieces
CLAUDE.md specifies for the Play Realm were simply not built, and they are the two that make a board
feel like a game: the mana embers behind it, and cards that move under the cursor.

### A second canvas, because it belongs to the game rather than the app

`AmbientCanvas` already exists and is the wrong thing to reuse. It is the *app's* backdrop — violet
runes and sigil rings, `position: fixed`, the same on the deck builder and the login page. What a
table wants is the opposite of shared: WUBRG embers at the board's own layer, moving with it, and
reacting to the cursor the way the spec asks (a 160px aura, embers pulled towards the pointer).

So `ArenaEmbers` is its own component, and four rules keep it from costing anything:

- **Reduced motion allocates nothing**, returning before the first array is built.
- **A hidden tab stops it.** `visibilitychange` cancels the loop; a table left open in a background
  tab should not be drawing.
- **The count is capped by width**, because a four-seat pod on a phone is the smallest screen with
  the most on it.
- **Two arcs per ember, not `shadowBlur`.** A core inside a dim halo is what makes an ember read as
  glowing rather than as a speck of dust, and the obvious way to get the same look is the one canvas
  property that reliably costs a frame on a phone. The first version drew one dot per ember and
  looked like dust in the screenshot, which is how this was found.

`isolate` on the table root is the line that makes `-z-10` safe. Without a stacking context there, a
negative index puts the canvas behind the page's own background and nothing is visible at all.

### One transform, three jobs

A card at this table is already carrying two transforms: it is centred on a slot that is bigger than
it, and it turns a quarter when tapped. The tilt is a third, and Tailwind's utilities cannot be
ordered against each other — so the three are written as one arbitrary transform in the order that
reads correctly (centre, turn, lean), with the tapped rotation travelling as `--card-rot` so the
tilt never has to know whether the card is tapped.

The pointer handler writes custom properties **straight onto the node**, not through React state.
Forty cards times a pointermove each is the one place in this app where a re-render per frame would
be felt, and none of what changes is state any component reads: it is four numbers that only CSS
looks at. The same argument `CombatArrows` makes for drawing itself.

Mouse only. A touch "hover" is a tap in progress, and tilting the card somebody is pressing is the
opposite of helpful.

### Reduced motion needed its own rule

`index.css` already kills every transition under `prefers-reduced-motion`, and that is not enough
here: a tilt with no transition is not an absent tilt, it is an **instant** one, and a board of
cards snapping between angles under the cursor is worse for somebody who asked for less movement
than a smooth lean. So the tilt variables are pinned flat, and the handler's work lands on nothing.

### The test had to be a browser, and that is the general lesson

Neither of these can be seen by any test that does not move a real pointer. The web package's tests
are reducer tests that never touch the DOM; a component test for the card would be asserting that a
handler it called by hand did what it says it does. Playwright's `hover` dispatches a genuine
`pointermove`, so the solo suite hovers a card — off centre, because both tilt variables are zero at
the middle — and reads the variables back off the element.

An effect that lives entirely in the browser is one only a browser can be asked about. That is the
same argument `LIST=cascade`, `LIST=costs` and `LIST=earned` each made about a *row* the engine
offers, arriving from the other direction: there the engine knew the answer and the table was
untested, here nothing but the table knows anything at all.

## D202 — Energy: a resource that is saved, and an instrument that found a bug by its absence

Every cost this engine could pay came out of one of five pots: mana, life, tapping something, cards
in a graveyard, or counters on a permanent. Energy (CR 122) is none of them. It is a counter on the
**player**, it is never emptied, and it is the first resource here that a deck *saves up* over
several turns and spends at once.

### It needed no new state, which is the part worth noticing

`Seat.counters` has read "arbitrary named counters (energy, experience, rad, tickets, ...)" since
the first week and nothing had ever used it. So the work is not in the state at all — it is in the
cost (`AbilityCost.energy`), in the offer (`legalActions` skips an ability whose energy the seat
does not have, the same CR 118.4 rule life and `removeCounter` already follow), in the payment and
its refusal (`autoActions`), and in one place for the arithmetic: `addEnergy` / `spendEnergy` /
`energyOf` in `effects.ts`, which is `recordLifeLost`'s discipline for the same reason — a resource
whose arithmetic is written out at each call site is one that eventually goes negative somewhere.

Nothing in `endTurnCleanup` touches it. That absence is the whole character of the resource, so it
is said out loud there and has a test of its own: a Longtusk Cub that connects on turn five has its
counters on turn six, which is the only reason a three-energy card is ever castable.

### Four cards, which are the whole mechanic

**Aether Hub** ties energy to mana: a land that arrives with one and spends it for a colour.
**Longtusk Cub** makes it — two every time it connects, and two of them for a +1/+1 counter.
**Bristling Hydra** is the payoff: three on arrival, three to grow *and* gain hexproof until end of
turn, which is the one answer in that deck to a removal spell already on the stack. And **Harnessed
Lightning** is the first spell here whose effect asks **how much of a resource to spend** — D130's
number-decision shape, built for Toxic Deluge's life, pointed at a different pot. Its `best` is the
cheapest kill rather than the whole pool, because energy kept is a Hydra protected later.

All four into Kindle Grove, which can cast them and already wants creatures to connect: a Mountain
becomes the Hub, and one each of Borderland Marauder, Ambush Viper and Lightning Strike makes room.

### The instrument, and the bug it found by looking for an absence

No existing harness could see this mechanic. `cast-counts.mjs` counts **casts** and three of the
four cards spend through an *activated ability*; `deck-probe.mjs` answers whether the deck won more;
`wasted-plays.mjs` never flags spending energy because spending it always moves something. So
`scripts/measure/energy.mjs` watches the pot itself: in, out, the high-water mark, and what was left
unspent when the game ended.

Its first full run reported that the Aether Hub had given out thirty-six energy and **none of it was
ever spent** — and that absence was a real bug, one zone away from the cards. `manaSources`, the
list the engine auto-taps from, read the mana, the tap, the sacrifice and the life on an ability and
nothing else. A Hub's coloured rows cost `{T}` and one energy, so the auto-tapper saw five free rows
and would tap the Hub for any colour with no energy at all. A land that quietly makes any colour for
nothing is not the card.

Two halves to the fix, and the second is a judgement rather than a rule. A row whose energy the seat
does not have is not a source. And where a permanent offers both a free tap and a paid one — the Hub
is the pool's first card actually shaped that way — the auto-tapper takes the free one, the same
conservative rule that stops it charging life for a tap that did not need it. Spending a saved
resource to fix a colour is a judgement about the next three turns, and a solver that knows about
one cost is not in a position to make it; the player still sees all six rows.

### Measured: level, and a bot that does not hoard

Two seed sets of 288 paired duels, probing the revert of all four cards at once:

```
3300   with the energy four 157-131   without 164-122   -7
5100   with the energy four 165-123   without 168-119   -3
```

Level and faintly negative — both arms the same way for the second time in the session, from a
**four-card** swap rather than a one-card slot, and still inside the ±20 floor.

And the question this piece was written around, which was whether the bot would simply sit on the
counters:

```
energy in: 401        out: 326        81% of it spent
  225  Bristling Hydra            222  Hydra — grow and gain hexproof
  113  (a chain not attributed)   104  Longtusk Cub — a +1/+1 counter
   36  Aether Hub
   18  Harnessed Lightning
    9  Longtusk Cub
111 seat-games of 576 had any; mean peak 2.6, most ever 6; 0.6 unspent at the end
28 of those 111 spent none of it
```

**It spends it**, which is the opposite of the worry. Four fifths of everything handed out, with
little more than half a counter left over at the end of an average game.

The honest surprise is elsewhere in that table. **Longtusk Cub gave nine energy in 288 games** — the
card whose job is to *make* the resource makes almost none of it, because a 2/2 that has to connect
rarely connects in a format full of blockers. The mechanic in this deck runs on the payoff card's
own arrival trigger: the Hydra is its own enabler. That is worth knowing before anybody designs a
second energy deck around a creature that has to get through.

## D203 — Embalm and eternalize: a copy with exceptions, and the cheap ability the bot never sees

Embalm (CR 702.89) and eternalize (CR 702.100) are the fourth and fifth things this engine can pay
for out of a graveyard, and the first two whose product is **not the card**. Flashback and escape
cast it, delve feeds another spell with it, unearth puts the creature itself back for one turn.
These exile the card for good and hand over a *token copy of it* — "except it's a white Zombie with
no mana cost", or a black Zombie with base power and toughness 4/4.

### The exception clause was the only thing missing

`copyAsToken` already built a token from the copied card's own definition, which is what a copy is
(CR 707.2). A copy with *different* characteristics needs a different definition — and `defKey` is a
card's lowercased **name**, so an altered definition registered under its own name would have
rewritten the printed card every other copy reads. The Sacred Cat still in the library would have
become a Zombie with no mana cost too; or, because `createToken` keeps whatever is already
registered, the alteration would have been silently dropped. Either way nothing would have thrown.

So `TokenCopyProfile` is a short list of printed fields to replace, registered under the card's key
plus a suffix (`sacred cat#embalmed`), with the token's `name` left alone. That last part is not
cosmetic: `scriptFor` looks a script up by **name**, so leaving the name alone is exactly what gives
the token the copied card's abilities — which is the whole reason these keywords are printed on
cards with text rather than on bears. An Angel of Sanctions token exiles another permanent when it
arrives and hands it back when the token dies, and a token built as a plain 3/4 flier would have
been a strictly worse card with no error anywhere to find it. There is a test for that, and one for
the printed card in the library being untouched.

`oracleText` is deliberately left alone, embalm reminder text and all: the ability is gated on
`fromGraveyard`, so a permanent on the battlefield is never offered it, and a token never reaches a
graveyard to be offered it there. Printing the card's own text on the token is also what a player
wants to read.

### The cost is paid at activation, which is the half that is not bookkeeping

`AbilityCost.exileSelf` is `discardSelf` one zone along, and it is a cost rather than an effect for
one reason: embalm exiles the card **as the cost**. Done on resolution instead, the same Sacred Cat
could be embalmed again while the first ability was still on the stack — two Cats for one card,
which is the kind of bug that never gets reported as one because the deck just quietly plays better
than it should. There is a test that activates it twice and reads the refusal.

### Four cards into Dawn Tithe, and the Rest in Peace that could not come with them

**Sacred Cat** ({W} 1/1 lifelink, *Embalm {W}*) is the keyword at its clearest: a one-drop that
blocks, gains a life, dies, and is a one-drop again. **Adorned Pouncer** ({1}{W} 1/1 double strike,
*Eternalize {4}{W}{W}*) is eternalize's size clause as the whole card — two damage becomes eight.
**Sunscourge Champion** ({2}{W} 2/2, gain 2 life, *Eternalize {5}{W}{W}*) makes the keyword an
*input* in the deck whose archetype is that gaining life is something other cards read. And **Angel
of Sanctions** ({3}{W}{W} 3/4 flying, *Embalm {3}{W}{W}*) is the one that proves the token is a copy.

Dawn Tithe rather than Skyward Writ, which was the first choice and the wrong one. Skyward Writ runs
the pool's only **Rest in Peace**, and a symmetric graveyard hoser cannot sensibly share a sixty
with four cards that need a graveyard. Moving the hoser was worse than moving the cards: it is the
pool's only copy of itself, three tests build boards out of it, and the decks that have no graveyard
of their own all have *death* triggers that a graveyard replacement would switch off as well. So the
four went to the deck that wants them and the hoser stayed where it was.

### Measured: the slot is not level, and the measurement needed fixing first

Probing the revert of all six cards, two seed sets of 288 paired duels:

```
seeds 3300   with: 206-81    without: 159-129    +47
seeds 4400   with: 198-90    without: 179-108    +19
```

Two answers 28 games apart, which is the first thing to say about them: the same *old* list measures
55% on one seed set and 62% on the other, so this deck's own noise is wider than the ±20 the
measurement README quotes. What both runs agree on is the sign and roughly the size — the new list
is somewhere around seven to ten points up, against a recorded table standing of 62%. Isolating the
one swap that looked like a clear upgrade on card quality alone, Angel of Sanctions over Serra Angel,
came back at **+11 of 287** — inside the floor and unresolvable — so the gain is spread across the
six cards rather than carried by one of them.

**And then the field table said the probe was reading far too much into it.** Run on the same seeds
as the table already published (`SEEDS=12 SEED0=4400`), Dawn Tithe goes from **187-101 (65%, joint
second)** to **198-90 (69%, clear second)** — eleven games and four points, against a probe that
wanted to call it forty-seven. The pool's whole spread is unchanged: 41 points before, 42 now, with
Ember Rush still alone at the top on 76% and Blight Vector still last on 34%. Verdant Guard dropped
four points without changing a card, which is the field effect this table has shown five times now.

So the slot is **+4 points on the instrument that answers this question**, and the deck does not need
trimming: it has two losing matchups (Kindle Grove 10-14, Verdant Guard 11-13), nothing in the
pool's bottom half that it beats worse than Ember Rush does, and its arrival in second place
*narrows* the gap at the top from twelve points to seven.

The lesson is the one the measurement README already warns about, pointing the other way this time.
D183's planeswalker run found the **table** larger than the paired probes; here the probe was three
to ten times the table. A paired probe swaps cards inside one deck and amplifies whatever the seeds
gave it; the table re-measures the whole field and lets the field move too. Where the two disagree,
believe the table — and never publish the probe alone.

```
 76%  218-70   ember-rush        (was 75%, 215-73)
 69%  198-90   dawn-tithe        (was 65%, 187-101)   <- the six cards
 61%  176-112  verdant-guard     (was 65%, 187-101)
 56%  162-126  kindle-grove      (was 55%)
 53%  154-134  forge-alliance    (was 56%)
 50%  144-144  skyward-writ      (was 49%)
 45%  130-158  rot-harvest       (was 45%)
 43%  124-164  ashen-rite        (was 46%)
 42%  121-167  arc-tempest       (was 39%)
 41%  119-169  hollow-tide       (was 42%)
 41%  119-169  delta-bloom       (was 44%)
 37%  107-181  tidal-mind        (was 34%)
 34%  97-191   blight-vector     (was 34%)
```

### And a correction worth more than the finding it replaced

The first version of this entry said the bot would not press the button: the new block in
`graveyard-costs.mjs` reported a Sacred Cat embalmed **12 times** across 288 games against 144 turns
on which the engine offered it, and the cause looked like `candidateActions` in `bot.ts`, which
sorts the legal plays by mana cost and keeps the top eight — descending, so the cheapest plays are
the first dropped. A tidy story about a one-mana ability never reaching the search.

It was wrong, and `cast-counts.mjs` is what said so: the same games, the same seeds, **125 embalms**.
At two seeds the two harnesses agree to the game (44 and 44), so the disagreement was never about
the decks or the bot. It was about where the two instruments look. `cast-counts` counts the
**action** a seat took; this block was reading the **stack** between actions — and with
`autoPass: true` an object nobody wants to respond to is put on the stack and resolved *inside the
same `applyAction`*, so a harness that looks between actions sees only the few that somebody held
priority over. Roughly one in eight.

Which also means every escape and delve number this harness has ever printed was that fraction. It
reported **17 escaped Woe Striders** across 288 games; `cast-counts` reads **23 in 48**. So the whole
block now counts actions, and the cards a cost spent are read as the cards that left the seat's
graveyard for exile while the action was applied — which keeps the per-cast spread without the
stack. One more trap on the way: counting every cast of a watched card read **97 "escapes"** of a
Phoenix of Ash in 144 games, of which 72 exiled nothing at all, because a Phoenix cast from *hand*
is the same card and the same action type. Escape says so on the action; for delve the test is
whether any card was actually exiled.

The lesson is the general one: an instrument that watches a *place* sees what happens to be sitting
there, and an instrument that watches an *action* sees the action. Prefer the action, and then check
that the action paid the cost you are counting.

**D171's three numbers, re-measured on its own seeds and 144 games each:**

| | D171 said | it is |
| --- | --- | --- |
| Phoenix of Ash escapes (Arc Tempest) | 5 | **25**, every one of them 3 cards |
| Gurmag Angler delved casts (Hollow Tide) | 11, 30 cards | **29**, 98 cards — one to six deep |
| Treasure Cruise delved casts | 10, 48 cards | **51**, 204 cards — most of them four deep |
| Woe Strider escapes (Ashen Rite) | not measured | **52**, and 11 of 144 games saw two |

So escape is not rare, Arc Tempest's reservation rule was never suppressing it, and the "pool's
first escape card lives in the deck least able to use it" line in D171 and in the arena-engine doc
was an instrument artefact. The *shape* of the delve spread survives, because that was never about
the count. (One deck note that changed underneath this: Treasure Cruise is in Hollow Tide now, not
Tidal Mind, which runs neither delve card.)

With that fixed the two harnesses agree to the game, and the real answer is the opposite of the
first one. **The bot takes very nearly every chance it is given**, counted against the turns on
which the engine actually offered the ability:

```
125  Sacred Cat (embalm)           offered on 144 turns   87%
 80  Adorned Pouncer (eternalize)  offered on  89 turns   90%
 32  Angel of Sanctions (embalm)   offered on  32 turns  100%
 18  Sunscourge Champion           offered on  20 turns   90%
```

`cast-counts` says the same thing from the other end: all four are among the deck's most-used cards,
each worth well over one use per game it is drawn — Sacred Cat at **202%** (192 casts and 125
embalms across 157 games it was in hand), Adorned Pouncer 155%, Angel of Sanctions 110%, Sunscourge
Champion 106%. A card used twice as often as it is drawn is a card that really is two cards.

A card that is used twice as often as it is drawn is a card that really is two cards, which is what
the keyword promises and the first measurement hid. The honest unearth comparison sits beside it: in
Ashen Rite's 288 games a Dregscape Zombie reached the graveyard in 64 of them, and the same block —
before the fix — read 10 unearths where `cast-counts` reads 6 in 48 games. Both numbers in that pair
are now worth re-reading.
