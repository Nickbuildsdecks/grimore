# Overnight session — 2026-09-27

Nick asleep, working autonomously with priority-setting authority. Plan at
`claude/overnight-2026-09-27-plan.md`.

**Nothing in this session touched the VM, production data, or `deploy-gcp.ps1`.** The five items in
`claude/vm-runbook-2026-09-26.md` are all still waiting.

## Read these two first

They change what is worth doing next, and both are about the app currently serving users rather
than about v2.

### 1. Registration is broken on production Postgres (#29)

Whenever any season is active, `POST /api/auth/register` returns **500** — and it fails *after* the
`players` row is written. The account exists, has a usable password hash, has no stats row, never
got its welcome notification, and the user is told "Internal server error" and cannot register that
username again.

Three stacked causes, each only visible once the one above it was fixed: `INSERT OR IGNORE` is a
syntax error on Postgres; `player_stats` has no `season_id` column there; and every notification
insert in the app fails because `notifications.id` is `SERIAL` on Postgres and TEXT on SQLite.

Proven by booting `server.js` against a Postgres database built from the baseline schema, not by
reading. Before: 500, one orphaned row, no stats. After: 200, login 200, all three rows present.

### 2. Nine tables and twelve columns the app writes do not exist on Postgres (#30, #32)

Not degraded — `relation "..." does not exist`. League check-in, pods, results and standings,
wishlist, friend requests, deleted-item recovery, the Movers & Shakers ticker, direct messaging,
password reset.

**Seven of the nine are already created by migrations that have never run.** The control is the
argument:

```
against baseline + initDb   ->  9 tables missing
against all migrations      ->  2 tables missing
```

and the two left are exactly the ones nothing creates anywhere.

So the v2 migrations are not only groundwork for `apps/api`. Right now they are the fix for seven
broken features in the live app — which is a much stronger reason to do the deployment work in
`claude/v2-deploy-notes.md` than "the new API needs them".

Caveat worth keeping: creating the table is the *first* error, not the only one. `server.js` still
writes SQLite-only syntax at nine sites, `active_roster` and the standings updates among them.

**And a table can exist while still being the wrong shape.** `db.js` builds a different table per
dialect under the same name, so `follows` has `following_id` on Postgres where the app writes
`followed_id`, and `collection_cards` has `foil` where the app writes `is_foil`. Following a player
and adding a card to a collection both fail, and **five of these column mismatches survive even a
full migration cutover** — they are not schema problems, `server.js` simply writes the wrong name.

Where it all lands:

| | tables missing | columns missing |
| --- | --- | --- |
| **Today** — baseline + `initDb` | 9 | 12 across 7 tables |
| **After a cutover** — baseline + `initDb` + migrations | 2 | 5 across 4 tables |

Audit it yourself against the VM, read-only:
`node scripts/audit-postgres-schema-gap.js "$POSTGRES_URL"`

## Everything that landed

`main` at `8e8ef98`. Nine PRs, all merged, CI green on each.

| PR | What | Tests |
| --- | --- | --- |
| #24 | Error-code contract made real and typed | 429 → 436 |
| #25 | Three legacy bugs with live user impact | legacy 35 → 38 |
| #26 | `apps/api` buildable and deployable, behind a compose profile | — |
| #27 | Legacy flake identified; next occurrence self-diagnosing | — |
| #28 | This report | — |
| #29 | Registration fixed on Postgres, three bugs deep | — |
| #30 | Schema-gap audit (tables) | — |
| #31 | Report brought up to date | — |
| #32 | Schema-gap audit extended to columns | — |

Also worth knowing from #25: the suggestion cache has never served a request — a temporal-dead-zone
read of `playerId` meant every cache *hit* threw. And four routes were registered twice, the
shadowed draft using an incompatible session shape, so any reordering would have swapped in an
implementation the client cannot talk to.

And from #26: `apps/api` could not be built at all — no Dockerfile, no compose service. It is now a
real, exercised image (12 migrations, auth, deck save, moderation and typed error codes all verified
inside the running container), gated behind the `v2` compose profile so `docker compose up -d` is
unchanged.

## Corrections to my own work

Four, because each of them would otherwise stand as a false claim in the record.

- **The draft-engine pack-rotation bug does not exist.** My earlier note said the engine rotated
  packs then checked the wrong one. `aiBotPickCard` does splice, the rotation snapshots correctly,
  and checking the newly-received pack is the right test. No change made — better a corrected note
  than a fix manufactured to match it.
- **The `socketToPod` clear is hazard removal, not a flake fix.** A real leak of the same class as
  the rate-limiter one, but no evidence it causes the flake, and the commit says so.
- **The SQLite ratchet's first version was wrong.** It treated a statement as guarded if
  `db.isPostgres` appeared within three lines, so an unrelated nearby mention excused new
  violations. Found by injecting one and watching the guard pass.
- **The schema audit was wrong twice.** First it reported `the` and `your` as missing tables.
  Then tightening it *silently lost* `password_resets` and `deleted_items` — a false negative in a
  check whose entire job is noticing absence, which is worse than the noise it replaced.

The last two share a lesson worth keeping: a check that passes when it should fail is more
dangerous than no check, because it is trusted.

## Deliberately not done

- **`deploy-gcp.ps1` still does not ship `apps/api`, `packages/` or the lockfile.** Extending it is
  the first step of any v2 cutover, but it is PowerShell that cannot be run or tested from here.
- **The nine remaining SQLite-only statements.** Each needs a unique constraint the production
  schema does not have — a schema decision, not a mechanical rewrite. Ratcheted so no new ones
  appear.
- **Schemas for `direct_messages` and `password_resets`.** Inventing one by reading INSERT
  statements is guesswork, and password reset wants real decisions about token lifetime, single use
  and cleanup.
- **The five surviving column mismatches.** Each is a one-line dialect-aware change, but each wants
  its route exercised end to end the way registration was in #29. Changing five write paths on
  inspection alone is how this divergence accumulated in the first place.
- **The sandbox room-code exposure (D11).** Unchanged; needs a decision, not a command.

## Where to pick up

1. The VM runbook — still five items, still yours. `TCGPLAYER_AFFILIATE_ID` and the `guest` row are
   the two that are wrong *right now*.
2. **Deploy.** #25 and #29 fix things live users hit today; #19's card-sync fix is also waiting.
   This is the highest-value action available and needs no decision beyond scheduling it.
3. Decide on the v2 migration cutover. It is worth more than it looked yesterday — see finding 2.
4. Play Realm off the unauthenticated sandbox routes onto `apps/realtime`. Still the largest
   remaining piece, still needs scoping rather than starting.
