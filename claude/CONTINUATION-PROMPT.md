# Grimore v2 — continuation prompt

Paste the block below into a fresh Claude Code session to resume the v2 port. It is written to be
self-contained: it assumes no memory of previous sessions, and points at the repo files that carry the
real context.

Keep this file updated as waves complete — it is the handover artifact the original
`claude/grimore-v2-roadmap-2026-09-13.md` was meant to be but was never committed.

---

```
Continue the Grimore v2 strangler port.

CONTEXT — read these first, in this order:
  1. claude/phase1-progress-2026-09-14.md   — what has been ported, every legacy bug found, and why
                                               each deliberate deviation was made. The most important file.
  2. claude/decisions-log.md                — standing decisions that bind new work.
  3. apps/api/src/routes/decks.ts           — the style reference. Read its header comment block:
                                               it documents the porting conventions by example.
  4. docs/API.md                            — the full legacy route map. This is the port checklist.
  5. PRODUCT.md + DESIGN.md                 — product intent and the design system.
  6. CLAUDE.md                              — architecture, optics rules, the 14 legacy test suites.

WHERE WE ARE: <N> of 126 legacy API routes ported into apps/api. See the progress doc's
"Port status" table for the current wave and what remains.

THE CENTRAL FINDING, which every wave has confirmed so far:
  Legacy server.js was written against SQLite and never re-verified after the Postgres cutover.
  Entire features do not merely have bugs — they cannot execute, because the handlers reference
  tables and columns the Postgres schema does not have, and a catch-all swallows the error.
  Confirmed dead on Postgres: card search, all 8 collections routes, the player profile, and all
  16 social routes. Expect the same in every remaining group. ALWAYS diff the legacy handler's
  SQL against packages/db/migrations/0001_baseline.sql BEFORE writing the port; the schema is the
  source of truth and the legacy query is usually the thing that is wrong.
  Known SQLite-isms to grep for: INSERT OR REPLACE, INSTR, SUBSTR, COLLATE NOCASE, LIKE used for
  case-insensitive matching, `?` placeholders, and datetime('now').

HOW TO WORK:
  - One PR per route group, stacked on the previous branch so each diff reviews alone. Base each PR
    on the branch below it. NOTE (see D9): GitHub retargets a stacked PR only when its base branch is
    DELETED, not when the base merges -- and this environment cannot delete branches (403). So when
    landing a stack, either merge the TOP PR (it contains the whole chain) into main after retargeting
    it, or retarget each PR to main before merging. Always verify origin/main actually moved after the
    first merge; the API reports "merged": true even when the work went into a feature branch.
  - Every route group gets: a migration if the schema diverges, contracts in packages/shared, a route
    file in apps/api/src/routes/, and tests against LIVE Postgres + Redis (never mocks).
  - Follow the decks.ts conventions exactly: a header comment block listing legacy bugs fixed and
    deliberate deviations, the { error: { code, message } } envelope, withTransaction for anything
    multi-statement, LATERAL ... LIMIT 1 instead of a fan-out LEFT JOIN, ownership enforced on every
    mutation, and 404 (not 500, not a silent success) for a miss.
  - Verify before every push: node scripts/guards.js, then the full workspace typecheck, then the
    full test suite. A push that turns CI red costs a cycle.
  - Save a progress-doc checkpoint per PR, in the same style as the existing ones: what was ported,
    every legacy bug found with its mechanism, and every deliberate deviation with its reason.

LOCAL ENVIRONMENT — the test suite needs real services:
  redis-server --daemonize yes --save '' --appendonly no
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main -l /tmp/pg.log \
    -o '-c config_file=/etc/postgresql/16/main/postgresql.conf -c listen_addresses=127.0.0.1 -p 5432' start"
  su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\"; psql -c 'CREATE DATABASE grimore_dev'"
  export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/grimore_dev" \
         REDIS_URL="redis://127.0.0.1:6379" SESSION_SECRET="ci-only-secret" NODE_ENV=test
  pnpm install && pnpm -r --filter './packages/*' run build

BLOCKED EXTERNAL SERVICES — build local-first and mark the gap, do not stub or fake:
  - api.scryfall.com is denied by the egress proxy. Affected routes: /api/cards/versions,
    /api/cards/rulings, /api/decks/reprice-finalize, /api/decks/:id/reprice-card-cheapest,
    /api/decks/:id/share. Build against the local scryfall_cards + card_price_cache tables and mark
    each fallback point TODO(scryfall-fallback), as apps/api/src/routes/cards.ts already does.
    To unblock, allowlist: api.scryfall.com, cards.scryfall.io, svgs.scryfall.io.
  - Gemini (/api/sandbox/ai-advisor) needs GEMINI_API_KEY. Port the route shape; mark TODO(gemini).

HARD RULES:
  - Never touch the live VM, DNS, or production data. No deploy-gcp.ps1. Migrations must be
    data-preserving and must have a test that seeds legacy-shaped rows and proves it.
  - No secrets in chat or in any committed file.
  - No emoji in UI (scripts/guards.js enforces this and will fail CI).
  - "Grimore" spelling, always.
  - Affiliate ID xJoE0d on every TCGplayer buy link.
  - Do NOT port /api/dev/git-commit or /api/dev/git-push. Executing git operations from an HTTP
    endpoint is a remote-code-execution surface; they should be deleted from server.js, not carried
    forward. Raise this rather than porting it.
  - Ask only when the decision is genuinely the user's. Everything else: decide, document the
    reasoning in the route header and the progress doc, and keep moving.

Work autonomously through the waves in claude/decisions-log.md, opening one PR per group and saying
when each is ready to merge on green CI.
```
