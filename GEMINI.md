# Agent Instructions — Grimore (http://localhost:3000)

> This file is mirrored across CLAUDE.md, AGENTS.md, and GEMINI.md so the same instructions load in any AI environment.

You operate within a 3-layer architecture that separates concerns to maximize reliability. LLMs are probabilistic, whereas most business logic is deterministic and requires consistency. This system fixes that mismatch.

## The 3-Layer Architecture

**Layer 1: Directive (What to do)**
- SOPs written in Markdown, live in `directives/`
- Define goals, inputs, execution tools, outputs, and edge cases. E.g. `directives/auto_tagging_engine.md`.

**Layer 2: Orchestration (Decision making)**
- This is you. Intelligent routing, reading directives, running execution tools, handling errors, updating directives with learnings.

**Layer 3: Execution (Doing the work)**
- Deterministic Python/Node scripts in `execution/`
- Environment variables in `.env`
- Reliable, testable, fast.

---

## Project Context & Architecture Summary

### Overview
- **Project Name**: Grimore (formerly Libram / Rostra / Grimoire)
- **Description**: Premium All-Encompassing MTG Suite & Arena Gameplay Web Server
- **Core Stack**: Node.js, Express, Socket.IO, Vanilla CSS/HTML5/Web Audio/Canvas frontend, plus an optional React SPA at `/react` (built from `web/`).
- **Database (dual-mode via `db.js`)**: SQLite (`better-sqlite3`, WAL) locally; Postgres + Redis in Docker for production (when `POSTGRES_URL` is set). `grimore.db` is the LOCAL dev store only.
- **Primary Database**: `grimore.db` (main data store in workspace root)
- **Server Startup Command**: `node --max-old-space-size=768 server.js` (runs on `http://localhost:3000`)

---

## Product Philosophy & Optics Rules

1. **Casual Commander First Optics**:
   - Initial optics, home/discover feeds, card search, visual deck building, and suggestions must be ultra-clean, inviting, approachable, and uncluttered.
   - Advanced tools (Scryfall query builders, custom category rules, proxy print specs, batch repricing, collection trade tools, and tournament pairing engines) are cleanly organized inside intuitive sub-menus, drawers, and settings modals.

2. **No-Emoji UI Rule**:
   - Do NOT default to emojis in user interfaces, buttons, toolbar pills, or category headers.
   - Use clean typography, badge pills, or custom SVG icons.

3. **Direct Page Transitions**:
   - All feature links, navbar buttons, and primary app destinations MUST navigate directly within the same browser tab (`window.location.href = '/path'` or direct `<a>` link).
   - `target="_blank"` is strictly reserved for external third-party links (e.g. TCGplayer cart export, Patreon).

4. **TCGplayer Affiliate Attribution**:
   - All card purchase links and cart exports MUST be attributed to affiliate ID `xJoE0d` (`https://partner.tcgplayer.com/xJoE0d?u=...`).

---

## Auto-Tagging & MTG Classification Specification (`directives/auto_tagging_engine.md`)

- **Main Category Priority**: Core functional roles (*Ramp*, *Card Advantage*, *Single Target Removal*, *Mass Removal*, *Protection*, *Tutors*, *Wincons*, *Recursion*, *Reanimation*, *Stax*, *Utility Lands*, *Lands*) ALWAYS take top priority over secondary archetype categories. `Counters & Triggers` and `Artifact Engine` are completely removed.
- **Fetch Lands Rule**: Fetch lands (*Polluted Delta*, *Misty Rainforest*, *Scalding Tarn*, *Verdant Catacombs*, *Arid Mesa*, *Marsh Flats*, *Bloodstained Mire*, *Flooded Strand*, *Wooded Foothills*, *Windswept Heath*, *Prismatic Vista*, *Fabled Passage*) belong under `Lands` ONLY (never `Utility Lands`).
- **Reanimation vs Blink & ETB Rule**: Reanimation spells (*Reanimate*, *Animate Dead*, *Victimize*, *Necromancy*) belong in `Reanimation` ONLY (never `Blink & ETB`).
- **Removal Rule**: Mass removal (*Day of Black Sun*, *Culling Ritual*, *Toxic Deluge*, *Wrath of God*) belongs ONLY in `Mass Removal` (never `Single Target Removal`).
- **Ramp Rule**: Standard lands NEVER count as `Ramp`.
- **Utility Lands**: Non-mana utility lands ONLY (*Dakmor Salvage*, *Reliquary Tower*, *Urza's Saga*, *Bojuka Bog*, *Strip Mine*, *Wasteland*, *Maze of Ith*, *Rogue's Passage*, *High Market*).
- **Infinite Combo Engine**: Automatically detects combo pairs (*Heliod* + *Walking Ballista*, *Peregrine Drake* + *Deadeye Navigator*, *Thassa's Oracle* + *Demonic Consultation*) and generates `Combo: Card A + Card B` headers.
- **Price Coalesce Standard**: Queries use `COALESCE(pc.price, sc.price, 0.15)` across all endpoints.

---

## A2UI Core Engine & Client Protocol (`public/a2ui.js`, `public/style.css`)

- **Client Renderer**: `window.A2UI.render(payload, container)` parses declarative JSON payloads (`{ type: "a2ui_widget", component: "...", props: {...} }`) into glassmorphic DOM elements with entry transitions (`a2ui-widget-enter`).
- **Component Schemas**:
  - `A2UICard`: Interactive card tile with artwork, action pills, hover 3D tilt, and affiliate link (`xJoE0d`).
  - `A2UIGauge`: Radial/linear gauge for win rates and deck power levels.
  - `A2UIActionPills`: Interactive action pills for quick filters and deck actions.
  - `A2UIRuleBanner`: Rule citation banner rendered in the Play Realm rules advisor drawer for MTG rules citations (CR 704.5k, CR 903.10).

---

## Play Realm & AAA MTG Arena Engine (`public/sandbox.html`, `sandbox.js`, `sandbox.css`)

- **Interactive Canvas Particle Shader**: 60fps WUBRG mana ember floating particles in `#arena-canvas-bg` with magnetic mouse aura attraction physics (160px radius) and pulsing alpha glows.
- **Visual Spell Target Beams & Combat Arrows**: `drawTargetBeam(sourceEl, targetEl, isCombat)` renders glowing animated SVG energy beams (`#combat-arrows-svg`) connecting casting cards to targets with directional arrowheads (`#arrowhead`).
- **3D Card Tilt Physics**: Perspective rotation (`perspective(600px)`), foil sheen specular highlights, and gold glow elevation on mousemove.
- **Web Audio API Sound Engine**: Low-latency synthesized sound cues for `card_draw`, `land_play`, `spell_cast`, `creature_cast`, `combat_hit`, `tap_mana`, `phase_step`, and `game_over`.
- **Rules Enforcement (CR 704 / CR 903.10)**: Automated SBAs (0 life, library loss, 10 poison, creature lethal damage, Legend rule, 21+ Commander damage).

---

## Master Test Suite Execution (14 Passing Test Suites)

Always verify changes by executing the master test orchestrator:
```powershell
python execution/verify_master_suite_orchestrator.py
```
This runs all 14 automated Python test suites in `execution/`:
1. `verify_ai_game_rules_engine.py` (AI Opponents & Rules Engine)
2. `verify_auto_tagging_engine.py` (Auto-Tagging & Infinite Combos)
3. `verify_deck_goodies_and_trade.py` (Proxy Generator & Trade Calculator)
4. `verify_tournament_pods_engine.py` (4P Pods & Swiss Leaderboards)
5. `verify_collection_and_social_engine.py` (Search, Collection & Social)
6. `verify_deck_analytics_engine.py` (Deck Analytics & Price Coalesce)
7. `verify_youtube_replays.py` (YouTube Replays & Web Audio FX)
8. `verify_a2ui_engine.py` (A2UI Schema & Core Client Renderer)
9. `verify_a2ui_chat_and_tuner.py` (A2UI Rule Banners & Deck Tuner)
10. `verify_arena_conquest_suite.py` (Visual Target Beams & 3D Tilt)
11. `verify_canvas_and_hud_engine.py` (Magnetic Canvas Particles & HUD)
12. `simulate_100_mtg_arena_matches.py` (100-Game Match Simulation)
13. `verify_full_ui_button_and_modal_suite.py` (Full-Surface UI & Modal Audit)
14. `verify_master_suite_orchestrator.py` (Master Suite Validation)

---

## Local Verification & Deployment Workflow

1. **Test Locally First**: Always implement, run, and verify changes on local server (`http://localhost:3000`).
2. **Obtain User Approval**: Ask permission before pushing to live deployment unless explicitly instructed.
3. **Comprehensive Live Deployment**:
   1. `git add -A`
   2. `git commit -m "..."`
   3. `git push origin main`
   4. `powershell -ExecutionPolicy Bypass -File .\deploy-gcp.ps1`
