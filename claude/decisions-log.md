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

- The shared moderation utility (D7).
- `scryfallService.js` writes a `scryfall_id` column to `scryfall_cards` that does not exist in the
  baseline schema, so the Postgres bulk card sync cannot ever have succeeded. Needs its own fix.
- `reprice-card` uses `INSERT OR REPLACE`, which is SQLite-only syntax and raises on Postgres.
