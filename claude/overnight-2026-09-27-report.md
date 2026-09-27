# Overnight session — 2026-09-27

Nick asleep, working autonomously with priority-setting authority. Plan at
`claude/overnight-2026-09-27-plan.md`.

**Nothing in this session touched the VM, production data, or `deploy-gcp.ps1`.** The five items in
`claude/vm-runbook-2026-09-26.md` are all still waiting — none of tonight's work changes them, and
`TCGPLAYER_AFFILIATE_ID` and the `guest` row are still the two that are wrong right now rather than
wrong-in-waiting.

## What landed

All four merged; `main` at `f0c9c68`.

| PR | What | Tests |
| --- | --- | --- |
| #24 | Error-code contract made real and typed | 429 → 436 |
| #25 | Three legacy bugs with live user impact | legacy 35 → 38 |
| #26 | `apps/api` buildable and deployable, behind a compose profile | unchanged |
| #27 | Legacy flake identified; next occurrence self-diagnosing | unchanged |

## The three findings that matter

### The suggestion cache has never served a request

`GET /api/decks/:deckId/suggestions` reads `playerId` inside its cache-hit branch, but
`const playerId` was declared *below* that branch — same function scope, so the read lands in the
temporal dead zone and throws `Cannot access 'playerId' before initialization`.

Not a cold path. EDHREC is reachable from the VM, so the cache populates, and then every repeat
request inside the 6-hour window 500s. Confirmed with a minimal repro rather than inferred from
reading.

### `apps/api` could not be built at all

There was no Dockerfile, no compose service, and `deploy-gcp.ps1` ships none of the v2 sources. So
99 ported routes, migrations 0002-0012 and the whole typed contract layer were **shelfware** —
unable to reach production even in principle.

Docker turned out to be usable in this container, so the image was built and exercised for real
rather than written and hoped for: all 12 migrations apply to a fresh database, `/readyz` reports
db and redis ok, register → login → deck save works, and both the moderation filter and the typed
error codes behave correctly inside the running container.

It is **gated behind the `v2` compose profile**. `docker compose up -d` on the VM is byte-for-byte
unchanged in behaviour, and the Caddyfile is untouched. Starting it runs migrations against
whatever database it is given, which is Nick's decision and wants a backup first — see
`claude/v2-deploy-notes.md` for the cutover order.

### The flake is identified but not fixed

`test/multiplayer-engine.test.js:103` — "in-game state relay broadcasts to the room excluding the
sender", expecting 1 broadcast and getting 0. Roughly **1 in 380**: caught once in 120 full-suite
runs, then zero failures across 260 more.

No fix shipped, because there is no evidence for one. Instrumenting every early return in the
handler across another 120 rounds produced only the 7200 rate-limit drops the deliberate flood test
is designed to cause — 60 per run, exactly — and never a missing pod or a wrong status.

What shipped instead is diagnostics: the assertion now prints the socket, the pod mapping, whether
the pod exists, its status, its players and every broadcast that happened, so the next occurrence
explains itself instead of starting a third hunt.

## Two corrections to my own earlier work

**The draft-engine bug I recorded does not exist.** An earlier note claimed the engine rotated
packs and then checked the wrong pack for emptiness. Re-reading it: `aiBotPickCard` does splice the
picked card out, the rotation snapshots all packs before reassigning, and checking the
newly-received pack is the correct round-end test. No change made — I would rather leave the note
wrong-and-corrected than manufacture a fix to match it.

**The `socketToPod` clear is hazard removal, not a flake fix.** It is a real leak of the same class
as the rate-limiter one fixed earlier — a third module-level Map the suite never reset — but I have
no evidence it causes the flake, and the commit says so.

## Things found and deliberately not acted on

- **`deploy-gcp.ps1` does not ship `apps/api`, `packages/` or the lockfile.** Extending it is the
  first step of the cutover, but it is PowerShell that cannot be run or tested from here, and a
  broken deploy script is worse than a missing one.
- **Four routes were registered twice**, the second copy of each unreachable — removed in #25, but
  worth knowing the shadowed draft used an *incompatible session shape*, so any reordering of
  routes would have swapped in an implementation the client cannot talk to.
- **The sandbox room-code exposure (D11) is still live.** Unchanged from yesterday; it needs a
  decision, not a command.

## Where to pick up

1. The VM runbook — still five items, still yours.
2. Decide whether to deploy. Four PRs merged yesterday plus four tonight; of these, only #25's
   legacy fixes and #19's card-sync fix change what the live app does.
3. If v2 deployment is wanted: extend the deploy bundle, back up, then
   `docker compose --profile v2 up -d api`. Order and rationale in `claude/v2-deploy-notes.md`.
4. Play Realm off the unauthenticated sandbox routes onto `apps/realtime` — the largest remaining
   piece of real work, and it needs scoping rather than starting.
