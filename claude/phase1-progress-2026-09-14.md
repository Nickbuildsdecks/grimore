# Grimore v2 — Phase 1 progress (2026-09-14)

Continuation of the v2 build after Phase 0 merged to `main` (PR #2) with CI green.

## Session preconditions (verified at start)

| Check | Result |
| --- | --- |
| Push access to `Nickbuildsdecks/grimore` | Confirmed — a throwaway branch pushed and accepted. Branch **deletion** is refused (HTTP 403), so the probe branch `claude/push-access-probe-3j5j49` has to be deleted from the GitHub UI. |
| `claude/grimore-v2-roadmap-2026-09-13.md` | **Not in the repo** — absent from `main`, from every ref, and from git history. |
| `claude/phase0-progress-2026-09-13.md` | **Not in the repo** (same). |
| `claude/decisions-log.md` | **Not in the repo** (same). |
| `api.scryfall.com` reachable | **No** — the session egress proxy denies CONNECT to it. |
| Local Postgres 16 + Redis 7 | Started in-session; the full v2 suite runs against them. |
| Baseline suite on `main` | Green: 18 api + 14 realtime + 39 rules-engine + 28 shared + 4 db + theme. |

The three planning docs were never committed, so Phase 0 intent has been reconstructed from the
code itself — chiefly the header comment block on `apps/api/src/routes/decks.ts`, which records the
deliberate deviations from legacy, and the `NOTE:` comments in `packages/shared/src/contracts/`,
which are where the collections id/column bugs are actually written down. This file replaces the
missing progress doc going forward; a decisions log is kept alongside it.

## Plan

1. **CI action bump** — Node 20 runtime deprecation warnings. *(this checkpoint)*
2. **Route ports into `apps/api`** — cards/search, collections, players/profile, social.
3. **`apps/web` data layer** — typed `apiClient` + TanStack Query; Login and Decks pages onto `apps/api`.

## Checkpoint 1 — CI action bump

`.github/workflows/ci.yml` only. The three actions in use were all on the Node 20 runtime, which
GitHub now warns about on every run:

| Action | Was | Now | Runtime |
| --- | --- | --- | --- |
| `actions/checkout` | v4 | v7 | node24 |
| `actions/setup-node` | v4 | v7 | node24 |
| `pnpm/action-setup` | v4 | v6 | node24 |

`pnpm/action-setup@v6` keeps the `packageManager` lookup this workflow relies on (no `version:`
input needed), so the bump is a drop-in. `pnpm/setup` — the newer replacement action — is **not**
usable here: it requires pnpm v11+, and the repo pins `pnpm@10.0.0` in `packageManager`.

`node-version: 22` is unchanged on both jobs: it matches `Dockerfile` (`node:22-slim`) and the
local toolchain. Bumping the app's Node version is a separate decision from clearing the runtime
warnings, and is not made here.

## Open item for Nick

To port `cards/search` against the real Scryfall API rather than the local `scryfall_cards` table,
these hosts need allowlisting on the session egress proxy:

- `api.scryfall.com` — card search, named lookup, autocomplete, bulk-data manifests.
- `cards.scryfall.io` — card images (`image_uris`).
- `svgs.scryfall.io` — set symbols.

Until then `cards/search` is built against the local `scryfall_cards` table, which is the same
source the legacy search endpoint falls back to.

## Checkpoint 2 — cards slice (`apps/api/src/routes/cards.ts`)

`GET /api/cards/search`, `/api/cards/autocomplete`, `/api/cards/details`, plus migration
`0004_card_search.sql`. 16 new tests; api suite 18 -> 34.

Built against the local `scryfall_cards` table only — see the open item above for the allowlist. Every
point where the Scryfall fallback would slot back in is marked `TODO(scryfall-fallback)` in the route
file; the response shape is already Scryfall's, so adding it later is additive.

### Legacy bugs the port fixes

1. **Local search was dead code on Postgres.** Legacy selects `c.card_name` and `c.scryfall_id` from
   `scryfall_cards`. The canonical Postgres columns are `name` and `id` — `card_name` is a nullable
   mirror and `scryfall_id` does not exist on the table at all. The query therefore raised, the
   catch-all swallowed it, and *every* search fell through to the Scryfall API. With Scryfall blocked
   that path returns nothing, so card search is currently non-functional against Postgres.
2. **Case-sensitive search.** `LIKE` is case-insensitive in SQLite, case-sensitive in Postgres. Now `ILIKE`.
3. **`subtype` sort used SQLite `INSTR`/`SUBSTR`** — raises on Postgres. Now `split_part`.
4. **Price join fanned out.** `LEFT JOIN card_price_cache ON card_name` duplicates a card once per
   cached printing. Now `LEFT JOIN LATERAL ... LIMIT 1` (cheapest), matching the decks slice.
5. **Pagination count was wrong.** A separate `COUNT(*)` ignored the join and filters. Now `COUNT(*) OVER ()`.
6. **All errors swallowed** into an empty result set, making a broken query indistinguishable from a
   genuine zero-result search. Real failures are 500s now.
7. **Autocomplete's `DISTINCT`** was over the whole row, so a card printed in 12 sets could fill the
   entire 10-row suggestion list. Now `DISTINCT ON (LOWER(name))`.

### Notes

- `try_jsonb()` (migration 0004) is the reason a single malformed JSON row cannot 500 a whole search.
  `scryfall_cards.colors` / `legalities` / etc. are TEXT columns holding JSON, an inline `::jsonb` cast
  aborts the entire query on one bad row, and Postgres may evaluate that cast before the WHERE clause
  that would have excluded it. A test seeds a deliberately corrupted row to hold this behaviour.
- The `pg_trgm` index is created inside an exception-handling `DO` block: `CREATE EXTENSION` needs
  privileges the production app role may not have, and search must degrade to a sequential scan rather
  than fail the migration.
- **Not ported:** `applyFollowedArtistPreferences` / followed-artist re-ranking, `/api/cards/versions`,
  `/api/cards/rulings`, `/api/cards/swipes`, `/api/cards/recommendations`, `/api/cards/details-batch`.
  These are separate feature slices, not part of the search port.
- **Separate latent bug, not fixed here:** `scryfallService.js` writes a `scryfall_id` column into
  `scryfall_cards` on the Postgres branch (line ~157). That column does not exist in the baseline
  schema, so the Postgres bulk sync cannot ever have succeeded. Worth its own fix.

## Checkpoint 3 — collections slice (`apps/api/src/routes/collections.ts`)

Eight routes (`GET/POST /api/collections`, `PUT/DELETE /api/collections/:id`,
`GET/POST/PUT/DELETE /api/collections/:id/cards`) plus migration `0005_collections_ids_and_columns.sql`.
17 new route tests + 2 migration tests; api suite 34 -> 51, db suite 4 -> 6.

### The id/column bugs — the schema was wrong, not just the queries

`packages/shared/src/contracts/collections.ts` had already written these down from the contract side.
Checked against the baseline schema and the legacy handlers, the damage is larger than "an id mismatch":
**the collections feature cannot have worked at all since the Postgres cutover.**

1. **`collections.id` is an integer serial; every handler writes a TEXT id** (`col_<ts>_<rand>`).
   `POST /api/collections` fails on Postgres with *invalid input syntax for type integer*, so no
   collection can be created — and therefore none of the other seven routes can be reached either.
2. **`collections.settings` does not exist.** Both the create and the update handler write it.
3. **`collection_cards.condition` / `language` / `is_for_trade` do not exist.** All three are read and
   written by the card handlers.
4. **`collection_cards.is_foil` does not exist** — the column is `foil`. Legacy's INSERT, UPDATE *and*
   DELETE all name `is_foil`, so every card mutation would raise even with a valid text id.
5. **The card upsert's `ON CONFLICT` target had no matching unique index**, so it could not have worked
   even with the columns present.

Migration 0005 converts `collections.id` to TEXT (and `collection_cards.collection_id` with it, in the
same transaction, so the foreign key holds), adds the five missing columns, and creates the unique index
the upsert needs. **The conversion preserves production rows**: an existing integer id becomes its own
decimal string. A test in `packages/db` seeds legacy-shaped integer rows, applies 0005, and asserts the
rows, the foreign key and its `ON DELETE CASCADE` all survive — the fresh-database path in the other
test would not have caught a data-losing conversion.

The unique index uses `LOWER(card_name)` and `COALESCE(scryfall_id, '')`: Postgres treats NULLs as
distinct in a plain unique index, so a card with no printing id could otherwise be inserted twice.

### Other legacy bugs fixed

- **`total_value` double-counted.** The list query LEFT JOINs both `card_price_cache` and
  `scryfall_cards` on card name; each fans out once per cached printing and the `SUM` multiplies
  accordingly. A card with four printings counted four times. Both joins are now `LATERAL ... LIMIT 1`.
- `sc.scryfall_id` was selected from `scryfall_cards`, which has no such column (it is `id`), and the
  join used `sc.card_name` where the populated column is `name`.
- `pc.colors` / `pc.oracle_text` were selected from `card_price_cache`, which has neither column.
- Delete was three unsequenced statements; a failure between them orphaned a collection's cards. The
  archive and the deletes now share one transaction.
- `PUT /:id/cards` overwrote every column with whatever the client sent, so an omitted field was
  silently reset — a PUT without `newQuantity` wrote NULL over the quantity. It now applies a partial
  `changes` patch, and `quantity: 0` means remove.
- A DELETE that matched no card reported success, hiding key mismatches from the UI. Now 404.

### Deliberate differences

- Cards are addressed by an explicit key object (`{ card_name, scryfall_id, foil, condition, language }`)
  rather than loose top-level body fields, matching `CollectionCardKey` in the contracts.
- Ownership is enforced on every route; another player's collection 404s rather than 500s.
- **Not ported:** the wishlist auto-decrement on add. `wishlist_cards` is not in the baseline schema at
  all, so it belongs with the wishlist slice — marked `TODO(wishlist-slice)`.

## Checkpoint 4 — players slice (`apps/api/src/routes/players.ts`)

`GET /api/players/:playerId/profile`, `POST /api/players/profile/update`,
`POST /api/players/account/update`, plus migration `0006_player_profile_columns.sql` and a new
`packages/shared/src/contracts/players.ts`. 17 new tests; api suite 51 -> 68.

### Missing columns again — the profile endpoint raises on Postgres

Same class of divergence as collections. The profile read selects `profile_theme`, `featured_deck_id`,
`discord_handle` and `moxfield_username` from `players`, and joins `seasons` on `player_stats.season_id`.
**None of those five columns exist in the baseline schema**, so `GET /api/players/:playerId/profile`
raises, and the four writable ones are also written by the profile update handler. Migration 0006 adds
them. `player_stats.season_id` is nullable and mirrors `deck_stats.season_id`: `player_stats` is keyed on
`player_id` alone (lifetime totals), so the column records which season the row was last accumulated
under rather than creating a per-season row.

### Two security bugs

1. **Account takeover from a stolen session.** Legacy required the current password only for a *password*
   change. Changing the **username and email required nothing at all** — anyone with a hijacked session
   cookie could move the account to their own email address and lock the owner out. The current password
   is now required for any credential change, and a password change re-issues the session id.
2. **Username case collision.** `players.username` carries a case-*sensitive* UNIQUE constraint, while
   every lookup in the app uses `LOWER(username)`. Legacy's account update compared `username = ?`
   exactly, so "Nick" could be created alongside "nick" and both would answer to the same login — with
   whichever row the lookup happened to return. Usernames are now normalized to lowercase (as the
   `Username` contract already did on register) and checked case-insensitively; 0006 adds the matching
   unique index, guarded so an existing collision cannot block the migration.

### Other legacy bugs fixed

- **A featured private deck leaked.** The featured-deck lookup was a bare `SELECT d.*` by id with no
  visibility check, so featuring a private deck published its contents to every profile visitor.
- `featured_deck_id` had no foreign key: deleting a featured deck left a dangling pointer. 0006 adds
  `ON DELETE SET NULL`, so the pointer clears and the deck delete still succeeds.
- The stats query used an inner `JOIN seasons`, dropping a player's stats entirely when the row had no
  season. Now `LEFT JOIN`.
- Profile updates wrote every column unconditionally, so a client that omitted a field wiped it.
- A taken username returned 400; it is a conflict, so 409.

### Not ported

Profanity filtering (`isProfane`) on nicknames, bios and handles — the decks slice made the same call.
It should land once as a shared moderation utility rather than being reimplemented per slice; marked
`TODO(moderation)` at each site. Also out of scope here: `/api/players/list` and `/api/players/:id/role`
(admin), `/api/players/active-match` (tournaments), and `/api/players/:id/follow` (next chunk, social).

## Checkpoint 5 — social slice (`apps/api/src/routes/social.ts`)

Friends (6 routes), messages (6), notifications (2) and follows (2), plus migration `0007_social.sql`
and `packages/shared/src/contracts/social.ts`. 24 new tests; api suite 68 -> 92.

### Every social route failed on Postgres

Three independent schema divergences, each fatal on its own:

1. **`friend_requests` does not exist.** All six `/api/friends` routes query a table the baseline schema
   never created. 0007 creates it.
2. **`direct_messages` does not exist either.** All six `/api/messages` routes query it.
3. **`follows` is keyed `(follower_id, following_id)`**, but every legacy query names `followed_id`.

And on top of those, **`notifications.type` is NOT NULL with no default while every legacy INSERT omits
it** — so even the notification writes that do not use a text id would raise.

#### Decision: messages use the existing `messages` table, not a new `direct_messages`

The baseline already has a `messages` table with exactly the right shape — `id, sender_id, recipient_id,
subject, body, is_read, created_at`. Creating a second `direct_messages` table to match the legacy
handler's name would leave two tables for one concept. **No data is at risk in making this choice:** with
no `direct_messages` table on Postgres, no message can ever have been stored there. Legacy's
`read_status` column name was the same kind of drift — the column is `is_read`.

`notifications.id` stays the integer serial from the schema; legacy inserted `notif_<ts>_<rand>` text
ids, the same mistake the decks slice found in `deck_comments`.

### Other legacy bugs fixed

- **Friend requests were not symmetric.** The pair had no uniqueness, so two players who requested each
  other simultaneously produced two rows and an ambiguous status. 0007 adds a unique index on the
  unordered pair, `(LEAST(sender, recipient), GREATEST(sender, recipient))`.
- **A declined request was permanent.** Decline wrote `status='declined'`, and the "already exists" guard
  then matched that row forever — the two players could never become friends. Declining now deletes the
  row, and a fresh request works.
- **Accept never checked the current status**, so an already-answered request could be re-accepted,
  re-notifying the sender every time.
- **Sending a message was not atomic** with writing the recipient's notification. Both now share a
  transaction, as do friend request / accept / follow.
- **`follows` had no uniqueness**, so a double-click inserted the row twice and the unfollow toggle then
  needed two clicks to clear it.
- **Notifications were capped at 10** with no way to page and no way to mark all read. `limit` and
  `unreadOnly` are query parameters now, and `{ all: true }` clears the bell.
- Marking a message read reported success even when the id belonged to someone else's message. Now 404.
- Unfriending, and declining a request that was not there, both reported success. Now 404.
- Notification text used `req.session.player.storeNickname`, which goes stale after a profile rename. It
  is read from the database row; a test renames a player mid-flight to hold this.
- Feedback with no admin account in the database 500d; it now returns 503 with a clear message.

## Checkpoint 6 — web data layer (`apps/web/src/lib/apiClient.ts`, `lib/queries.ts`)

A typed client plus a TanStack Query layer, with Login and Decks moved onto them. 19 new tests
(`apps/web` had none before; `pnpm test` was `echo "no tests yet"`). Workspace total 186 -> 205.

### Types come from the contracts, not from hand-written duplicates

`@grimore/shared` is now a dependency of `apps/web`, so request and response types are the same Zod
contracts the API validates against. A route and its caller can no longer drift without a typecheck
failure. The previous hand-maintained `Player` interface was **camelCase** (`storeNickname`, `isAdmin`,
`avatarUrl`) while both servers return snake_case — it never matched anything. It is replaced by
`MePlayer`; `AppShell` was updated to match.

### The "[object Object]" bug

`lib/api.ts` extracted errors with `String(data.error)`. The v2 envelope is
`{ error: { code, message } }` — an **object** — so `String()` on it yields `"[object Object]"`. Every
failure from `apps/api` reached the user as a toast reading "[object Object]". The new client reads
`error.message`, keeps `code` and Zod `details` on the thrown `ApiError`, and still understands the
legacy `{ error: "string" }` shape. `lib/api.ts` now delegates to it, so the pages not yet migrated get
the fix too.

### Two bases, because this is a strangler migration

`apiUrl()` addresses `apps/api`; `legacyUrl()` addresses `server.js`. Routes not ported yet — Moxfield
import, password reset, Google sign-in — are called through `legacyUrl()`, which makes each remaining
migration task visible at its call site instead of silently 404ing. Both default to same-origin, which
is how the deployed app runs behind one reverse proxy. In development the Vite proxy routes `/api` to
`apps/api` (**run it with `PORT=4000`**; `server.js` still owns 3000) and `/legacy-api` to `server.js`.

### Other decisions

- Query keys live in one factory (`queryKeys`), so an invalidation cannot miss a cache entry by
  spelling a key differently at the call site.
- `shouldRetry` never retries a 4xx: the server has already answered, and retrying a 401 only delays
  the login screen.
- `useLogout` calls `queryClient.clear()`, not `invalidateQueries()` — the previous user's decks and
  collections must not stay readable in the cache while refetches are in flight.
- `useLogin` seeds the auth-status cache from the login response so the app does not flash a
  logged-out shell.

### Visible changes on the Decks page

Pointing it at `apps/api` changes two things, both consequences of the v2 contract rather than choices:

- `is_public` is a real boolean in `DeckSummary`, so `deck.is_public === 1` no longer matched. Fixed.
- `GET /api/decks/my-decks` returns `likes_count` and `card_count`, **not** match stats — `total_wins`
  does not exist on the v2 response. The "Most wins" sort became "Most liked", and the card footer
  shows card count and likes. If you want win totals back on this page, `deck_stats` has to be joined
  into the my-decks query; say so and I will add it.
- Sorting by "recently updated" now uses `updated_at` (maintained on every write, from migration 0002)
  rather than `last_checked`, which only moves when prices are refreshed.

---

# Wave 1 — wishlist + recycle bin (`apps/api/src/routes/wishlist.ts`)

`/api/wishlist` (4 routes) and `/api/recovery` (3), plus migration `0008_wishlist.sql` and
`packages/shared/src/contracts/wishlist.ts`. 14 new tests; api suite 92 -> 106, workspace 205 -> 219.
Port status: **53 of 126 legacy routes**.

## Why this first

The wave order was revised before starting — see `claude/decisions-log.md`. Probing the environment
showed `api.moxfield.com` is blocked like Scryfall, and that **`active_roster` and `pods` are not in
the baseline schema** while `reprice-init` queries both for its tournament deck-lock. Decks-completion
would therefore have been mostly TODO-marked shells, so it moved after Events. This wave is entirely
local-data and closes two open loops.

## Wishlist: the table does not exist

All three wishlist routes query `wishlist_cards`, which the baseline schema never created — the fourth
feature found this way, after collections, the player profile and social. Migration 0008 creates it.

Other legacy bugs:

- **`COLLATE NOCASE`** is SQLite-only and raises on Postgres. Every wishlist lookup used it.
- `sc.scryfall_id` and the `sc.card_name` join target do not exist on `scryfall_cards` (they are `id`
  and `name`); `pc.oracle_text` does not exist on `card_price_cache`. Identical to the collections bugs.
- The `ON CONFLICT (player_id, card_name, scryfall_id)` target had no matching unique index — and would
  not have collapsed NULL `scryfall_id` rows even with one.

`TODO(wishlist-slice)` from the collections slice is now closed: adding a card to a collection
decrements the wish for it, in the same transaction as the insert. **The `CHECK (quantity > 0)`
constraint caught a bug in my first version of that decrement** — subtracting an acquisition larger
than the wish drove the quantity negative and took the whole collection-add transaction down. The
delete now runs before the update, so a wish smaller than the acquisition is cleared rather than
driven below zero.

## Recycle bin: nothing could ever read it

The decks and collections slices both archive into `deleted_items`, and until now **nothing read it
back** — a soft delete was indistinguishable from a hard one. Restoring is what makes those archives
worth writing.

- **Restore silently dropped data.** The deck restore wrote eight columns and, for cards, five — so a
  restored deck came back **with no commander** (`is_commander` was dropped), no format, no tags, and
  public regardless of what it had been. The collection restore named `is_foil` and `added_at`, neither
  of which exists (`foil`, `created_at`). Restore now replays every archived column; a test asserts the
  commander, format, tags and visibility all survive.
- **Restore was not atomic.** Metadata, each card, and the `deleted_items` delete were separate
  statements, so a failure part-way left a half-restored item and an archive that might or might not
  still exist. One transaction now — a failed restore leaves the archive intact, which a test holds.
- A restore whose target id already exists was a duplicate-key 500; it is a 409 now.
- `DELETE /api/recovery/deleted-items/:id` is new: legacy had no way to empty the bin at all.

---

# Wave 2 — League / Events (`apps/api/src/routes/league.ts`)

Seasons (4), roster (6), pairings (4) and leaderboards (2) = 16 routes, plus migration
`0009_events.sql` and `packages/shared/src/contracts/league.ts`. 29 new tests; api suite 106 -> 131,
workspace 219 -> 244. Port status: **69 of 126 legacy routes**.

## Two tournament models, and the schema has the wrong one

The baseline schema carries `tournaments` / `tournament_players` / `tournament_rounds` / `matches`,
which **nothing in server.js references** — zero occurrences, verified by grep. The model the
application actually uses, and the one CLAUDE.md documents as the "4P Pods & Swiss Leaderboards"
engine, is `active_roster` / `pods` / `pod_results`, and the baseline creates **none of them**. So
every Events route raises on Postgres. Migration 0009 creates the pods model; the unused
`tournament_*` tables are left in place rather than dropped, since dropping tables is destructive and
they may hold pre-cutover rows.

## The security bug

`POST /api/pairings/report/:podId` had **no authentication of any kind** — no session check, no pod
membership check, no role check. Its only comment was "Can be submitted by players or admin". Anyone
who could reach the server could post arbitrary results for any pod in any season, awarding themselves
unlimited points and rewriting the standings. Reporting now requires a session, and the caller must
either be seated at that pod or hold an organizer role. A test covers the anonymous case and the
"seated at a different pod" case.

## Other legacy bugs fixed

- **`INSERT OR REPLACE` / `INSERT OR IGNORE`** are SQLite-only and raise on Postgres. Used in check-in,
  season creation, season registration and the entire leaderboard rebuild.
- **`seasons.budget_limit` / `banlist` / `max_rares` do not exist** in the baseline, so creating a
  season and editing its rules both raise. 0009 adds them.
- **`player_stats.total_matches` does not exist** — the column is `total_games`; only `deck_stats` has
  `total_matches`. Legacy's rebuild wrote `total_matches` to both, so the player half of every
  leaderboard raised. *(Caught by the test suite, not by reading.)*
- **Standings could not be per-season.** `player_stats` was keyed on `player_id` alone and `deck_stats`
  on `deck_id`, so a second season's numbers overwrote the first. 0009 replaces those primary keys with
  partial unique indexes on `(player_id, season_id)`, keeping the untagged lifetime row that
  pre-existing data occupies — no row is rewritten.
- **Creating a season was not atomic.** `UPDATE seasons SET is_active = 0` then an INSERT, unsequenced:
  a failure between them left the league with no active season at all. One transaction now, and 0009
  adds a unique index so two active seasons cannot coexist even by accident.
- **Pairing generation was not idempotent.** Re-running it for a round inserted a second full set of
  pods, silently doubling the round. `(season_id, round_num, pod_label)` is unique now and the handler
  returns 409.
- **A pod could record an impossible result** — several winners, or a winner and a draw at once. The
  contract rejects both, so the standings cannot be corrupted by a mis-submitted report.
- **The collision-avoidance history was computed and never used.** The engine built a `playCounts` map
  of who had played whom, then sorted purely on points and ignored it. Seating now actually minimises
  repeat pairings.
- Pairing notifications used a text id in an integer column and omitted the NOT NULL `type`, so every
  one of them raised — the same bug the social slice found.
- **`end-round` did nothing at all.** It returned success without touching anything. It now reports
  unreported pods and can clear the roster.
- Check-in accepted any deck id, including another player's deck and one that does not exist.
- `GET /api/seasons/active` returned `undefined` when there was no active season, which serialises to
  an empty body the client cannot read. It returns `null`.
- `GET /api/pairings/round/:n` issued one seat query per pod (N+1); it is one query now.

## Deliberate deviations

- **Contract names.** `packages/shared` already exports `Pod` and `PodSeat` from `realtime/events.ts`
  for multiplayer *lobbies*, a different concept from a league pod (a table at a round). The league
  contracts are `LeaguePod` / `LeagueSeat` in `contracts/league.ts`.
- **`POST /api/seasons/rules` no longer re-validates every deck in the database inline.** Legacy ran
  `validateDeckLegality` over the whole `decks` table inside the request, on an admin click. That
  belongs in a job, not a request handler. Deck legality is re-checked on save.
- `podSizes` is exported and unit-tested independently of the database: for every turnout from 3 to 40
  it must seat everyone at tables of 3-5.

---

# Wave 3 — deck repricing + legality (`apps/api/src/routes/decks.ts`, `lib/legality.ts`)

Five reprice routes plus the deck legality validator, with migration `0010_deck_pricing_legality.sql`.
13 new tests; api suite 131 -> 144, workspace 244 -> 257. Port status: **74 of 126 legacy routes**.

## Five more missing columns

`validateDeckLegality` reads `seasons.allowed_rarities`, `seasons.allowed_colors`,
`seasons.budget_limit`, `seasons.max_rares` and `decks.budget_limit`; reprice-init and reload-cheapest
read `decks.include_basic_lands_in_price`. **None of them existed.** 0009 added the first two of the
season ones; 0010 adds the rest. Because legality is called from reprice-finalize, reload-cheapest and
the season rules editor, all three raised.

`reprice-card` used SQLite's `INSERT OR REPLACE` against `card_price_cache`, which raises on Postgres —
so feeding the shared price cache, the entire purpose of that route, never happened.

## Deliberate deviations

- **One implementation, not five.** Legacy spread pricing across five routes that had grown apart:
  three recomputed the deck total with slightly different rounding, and two called
  `validateDeckLegality` while the others did not, so a deck's stored `is_legal` could disagree with its
  stored price. `settleDeck()` recomputes both together, so they cannot diverge.
- **Repricing is one UPDATE, not a loop.** Legacy issued one UPDATE per card, outside any transaction.
  Note for anyone editing it: an `UPDATE ... FROM ... LEFT JOIN LATERAL` **cannot** reference the update
  target inside the LATERAL — the cheapest-printing lookup has to be a correlated scalar subquery in the
  SET list. That cost a debugging cycle.
- **Legality never fails a deck over a gap in the card cache.** A card the local `scryfall_cards` table
  does not know is treated as unrestricted rather than illegal, and basic lands are exempt from every
  restriction. A test covers both.
- **`reprice-init` returns 503 for a Moxfield-linked deck** rather than silently doing nothing:
  `api.moxfield.com` is blocked here. `TODO(moxfield)` marks the sync path.
- The deck lock during a live round now works — it checks `active_roster` and `pods`, which did not
  exist until migration 0009.

## Still not ported from the decks group

`register` / `import-account` (Moxfield, blocked), `:deckId/share` (Scryfall), `:deckId/autotag` and
`:deckId/suggestions` (the auto-tagging engine in `directives/auto_tagging_engine.md`, its own piece of
work). Four routes.

---

# Wave 4 — cards completion (`apps/api/src/routes/cards.ts`)

`details-batch`, `versions`, `rulings`, `swipes` and art votes = 5 routes. No migration needed — these
are the first tables the baseline schema gets *right*. 13 new tests; api suite 144 -> 157,
workspace 257 -> 270. Port status: **79 of 126 legacy routes**.

## A wave with no schema divergence

`card_swipes`, `card_art_votes` and `preference_events` all exist with correct primary keys and CHECK
constraints — `card_swipes` is even keyed `(player_id, card_key, context_key)`, matching the handler's
`ON CONFLICT` exactly. Worth recording after five consecutive waves that each needed a migration.

## What changed

- **`details-batch` is one query, not N.** Legacy resolved names one at a time, so a 100-card decklist
  meant 100 round trips (and, on a cache miss, 100 Scryfall calls). Misses are now *reported* rather
  than silently dropped, so a caller can distinguish "unknown card" from "no price".
- **`versions` joins its art-vote tallies** instead of making the gallery fetch per printing, and
  returns the viewer's own vote in the same row.
- **`rulings` returns 503, not an empty list.** There is no local rulings table to fall back to —
  rulings exist only on Scryfall. An empty array would render as "this card has no rulings", which is
  a different and wrong claim. `TODO(scryfall-fallback)`.
- The swipe/art-vote split is preserved deliberately: a swipe is taste for the **card** ("would I play
  this?"), an art vote is taste for one **printing** ("do I like this illustration?"). Posting swipe
  traffic to the art endpoint is rejected rather than silently relabelled, which is the bug the split
  exists to prevent.
- Preference-event logging never fails a vote: losing one analytics row matters less than losing the
  swipe that produced it.

## Known gap

`scryfall_cards` has **no `artist` column**, so `versions` can only report an illustrator where an art
vote happened to record one. Filling that in needs either the Scryfall call or an added column plus a
re-sync.

## Not ported from the cards group

`/api/cards/recommendations` — the recommender reads `preference_events` and `card_swipes` and is a
engine in its own right, not a route port. It belongs with the auto-tagging work.
