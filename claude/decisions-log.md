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
