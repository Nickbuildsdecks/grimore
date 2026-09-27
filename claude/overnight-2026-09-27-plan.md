# Overnight session plan — 2026-09-27

Nick is asleep. Standing brief: work autonomously, set my own priorities, push everything, leave a
morning report. No VM access, no production data, no secrets in chat, no emojis in UI, "Grimore"
spelling, affiliate id `xJoE0d`.

## How "8 hours" actually works

A session runs in turns and stops when a turn ends. Continuity comes from scheduling a wake-up at
the end of each working turn, so the night is a chain of long turns rather than one unbroken run.
Everything is pushed as it lands; if the container is reclaimed the chain breaks but no work is
lost.

**Re-read this file at the start of every wake.** It is the master prompt.

## What the opening survey changed

Two assumptions I had been carrying were wrong, and they reshape the order:

1. **The `apps/web` cutover is essentially finished.** `legacyUrl()` has three remaining callers —
   `forgot-password`, `reset-password`, `decks/register` — and all three are blocked on an email
   provider or on Moxfield being reachable. Wave 7's "done when `legacyUrl()` has no callers" (D4)
   cannot be closed from here. It is not the big remaining piece.
2. **`packages/shared`'s `ApiErrorCode` enum is dead contract.** `apps/api` emits 23 uppercase codes
   typed as a bare `string`; `apps/web` has its own `ApiError` class that also takes a loose string.
   Neither validates against the enum, so there is no runtime bug — but a typo in a route
   (`'VALIDATON'`) compiles today, and the contract claims a relationship that does not exist.

## Priorities, highest first

Chosen for: real value, small blast radius, reviewable in the morning, and testable without the VM.

### P1 — Typed error codes across the workspace
Make the shared contract describe reality: one union of the codes actually emitted, `apps/api`'s
`ApiError.code` typed to it, `apps/web` importing the same union. Turns a typo from a silent
runtime string into a compile error. ~10 route files, mechanical, fully covered by the existing
suite.

### P2 — Legacy bugs that reach real users
`server.js` is what production actually runs, so these are the only fixes with live impact. Each is
small and lands as its own commit:

- `scryfallService.js` `fetchJson` parses a non-JSON error body without a guard (seen in the boot
  log on 2026-09-26).
- `GET /api/decks/:deckId/suggestions` references an undefined `playerId`, so the cache-hit path
  throws `ReferenceError` — the 6-hour cache has never served a request.
- The draft engine rotates packs and then checks the wrong pack for emptiness.
- `/api/search/semantic` has hard-coded phrase branches.

Verify each still exists on `main` before touching it; some may have been fixed since I found them.

### P3 — Make `apps/api` deployable, without deploying it
`docker-compose.yml` has no `api` service, so nothing built in `apps/api` can ever reach production
and migrations 0004-0012 have never run there. That makes the whole v2 effort shelfware until
fixed.

**Behind a compose profile so `docker compose up -d` is unchanged.** Starting it runs migrations
against production data, which is Nick's call and not something to enable while he is asleep.
Deliverable: the service definition, a documented cutover path, and an explicit note that enabling
it is a one-way door needing a backup first.

### P4 — Hunt the unidentified legacy flake
One of 35 legacy tests failed once on 2026-09-26 and never reproduced in 36 runs. Unresolved, not
fixed. Worth a proper hunt with many runs under varied load, capturing the failure when it comes.

### P5 — Coverage and quality
Whatever the above leaves time for. Real gaps only; no coverage theatre.

## Rules for the night

- One concern per PR, CI green before merge, verify `origin/main` actually moved (D9).
- Never widen a change because I am mid-flight and it is convenient.
- If something needs Nick's judgement, stop that item, write it down, move to the next — do not
  guess and do not do it anyway.
- Re-verify every legacy bug before fixing; my notes are up to two weeks old.
- Keep a running morning report at `claude/overnight-2026-09-27-report.md`, updated each phase, so
  it survives if the chain breaks.
