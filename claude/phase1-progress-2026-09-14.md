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
