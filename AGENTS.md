# Agent Instructions
> This file is mirrored across CLAUDE.md, AGENTS.md, and GEMINI.md so the same instructions load in any AI environment.

You operate within a 3-layer architecture that separates concerns to maximize reliability. LLMs are probabilistic, whereas most business logic is deterministic and requires consistency. This system fixes that mismatch.

## The 3-Layer Architecture

**Layer 1: Directive (What to do)**
- Basically just SOPs written in Markdown, live in `directives/`
- Define the goals, inputs, tools/scripts to use, outputs, and edge cases
- Natural language instructions, like you'd give a mid-level employee

**Layer 2: Orchestration (Decision making)**
- This is you. Your job: intelligent routing.
- Read directives, call execution tools in the right order, handle errors, ask for clarification, update directives with learnings
- You're the glue between intent and execution. E.g you don't try scraping websites yourself—you read `directives/scrape_website.md` and come up with inputs/outputs and then run `execution/scrape_single_site.py`

**Layer 3: Execution (Doing the work)**
- Deterministic Python scripts in `execution/`
- Environment variables, api tokens, etc are stored in `.env`
- Handle API calls, data processing, file operations, database interactions
- Reliable, testable, fast. Use scripts instead of manual work. Commented well.

**Why this works:** if you do everything yourself, errors compound. 90% accuracy per step = 59% success over 5 steps. The solution is push complexity into deterministic code. That way you just focus on decision-making.

## Operating Principles

**1. Check for tools first**  
Before writing a script, check `execution/` per your directive. Only create new scripts if none exist.

**2. Self-anneal when things break**
- Read error message and stack trace
- Fix the script and test it again (unless it uses paid tokens/credits/etc—in which case you check w user first)
- Update the directive with what you learned (API limits, timing, edge cases)
- Example: you hit an API rate limit → you then look into API → find a batch endpoint that would fix → rewrite script to accommodate → test → update directive.

**3. Update directives as you learn**  
Directives are living documents. When you discover API constraints, better approaches, common errors, or timing expectations—update the directive. But don't create or overwrite directives without asking unless explicitly told to. Directives are your instruction set and must be preserved (and improved upon over time, not extemporaneously used and then discarded).

**4. Local Verification & Deployment Confirmation**
- **Test Locally First**: Always implement, run, and verify changes on the local development instance (`http://localhost:3000`) first.
- **Obtain User Approval**: Once changes are verified locally, ask for permission before pushing to live unless explicitly instructed.
- **Comprehensive Live Deployment**: When pushing to live, ALWAYS update all applicable target areas together:
  1. Commit all modified files and untracked assets to Git (`git add .`, `git commit -m "..."`).
  2. Push to GitHub repository (`git push origin main`).
  3. Execute the live GCP deployment script (`powershell -ExecutionPolicy Bypass -File .\deploy-gcp.ps1`).

## Self-annealing loop
Errors are learning opportunities. When something breaks:
1. Fix it
2. Update the tool
3. Test tool, make sure it works
4. Update directive to include new flow
5. System is now stronger

## File Organization

**Deliverables vs Intermediates:**
- **Deliverables**: Google Sheets, Google Slides, or other cloud-based outputs that the user can access
- **Intermediates**: Temporary files needed during processing

**Directory structure:**
- `.tmp/` - All intermediate files (dossiers, scraped data, temp exports). Never commit, always regenerated.
- `execution/` - Python scripts (the deterministic tools)
- `directives/` - SOPs in Markdown (the instruction set)
- `.env` - Environment variables and API keys
- `credentials.json`, `token.json` - Google OAuth credentials (required files, in `.gitignore`)

**Key principle:** Local files are only for processing. Deliverables live in cloud services (Google Sheets, Slides, etc.) where the user can access them. Everything in `.tmp/` can be deleted and regenerated.

## Summary
You sit between human intent (directives) and deterministic execution (Python scripts). Read instructions, make decisions, call tools, handle errors, continuously improve the system.
Be pragmatic. Be reliable. Self-anneal.


## Grimore Project Context & Status Summary

> [!NOTE]
> This section transfers the context of the Grimore project from the previous conversation (which had 36,990 steps and is too large to load) to any new conversation.

### 📋 Overview
- **Project Name**: Grimore (formerly Libram / Rostra / Grimoire)
- **Description**: Premium All-Encompassing MTG Suite Web Server
- **Core Technology Stack**: Node.js, Express, SQLite3, Vanilla CSS, HTML
- **Primary Database**: `grimore.db` (main data store), with fallbacks `aetherpair.db`, `grimoire.db`, `libram.db`, `rostra.db`.

### 📂 Architecture & Key Files
- **[server.js](file:///C:/Users/772wa/.gemini/antigravity/scratch/mtg-tournament-platform/server.js)**: Main Express web server. Sets up sessions, routes, MTGJSON/Scryfall integrations, and tournament/deck APIs.
- **[db.js](file:///C:/Users/772wa/.gemini/antigravity/scratch/mtg-tournament-platform/db.js)**: Database client manager. Handles sqlite3 connections and schemas.
- **[package.json](file:///C:/Users/772wa/.gemini/antigravity/scratch/mtg-tournament-platform/package.json)**: Scripts and dependencies (`bcryptjs`, `express`, `express-session`, `sqlite3`). Runs with `--max-old-space-size=768` memory limit.
- **`public/`**: Frontend files (`index.html`, `app.js`).

### 🚀 Rebranding Status
- The project has been rebranded from **Libram** to **Grimore**. 
- Database file references in `server.js`, `db.js`, and public assets have been updated to point to `grimore.db`.
- The desktop shortcut **Grimore.url** has been created pointing to `http://localhost:3000`.

### 🛠️ Execution Context
- To start the server: `npm start` (runs `node --max-old-space-size=768 server.js`).
- Port: `3000`
- API keys/endpoints should be checked inside the `.env` configuration file in this workspace root.

### 🎯 Product Philosophy & Optics Rule
- **Casual Commander First (Initial Optics)**: Grimore targets the vast majority of the MTG playerbase: casual Commander players. Initial optics, home/discover feeds, card search, visual deck building, and suggestions must be ultra-clean, approachable, inviting, and uncluttered—never overwhelming users with dense numbers, intimidating data screens, or unnecessary tournament jargon.
- **Deep Customizability ("The Goodies")**: High-power, advanced tools (Scryfall query builders, custom category rules, proxy print specs, batch repricing, collection trade tools, and tournament pairing engines) are cleanly organized inside intuitive sub-menus, drawers, and settings modals—rewarding serious players who love clicking in to discover the goodies.

### 🏷️ Auto-Tagging & MTG Classification Specification
- **Core Directive**: SOP defined in `directives/auto_tagging_engine.md`.
- **No-Emoji UI Rule**: Do NOT default to emojis in user interfaces, buttons, toolbar pills, or category headers. Emojis look AI-generated and clutter the interface. Use clean typography, badge pills, or custom SVG icons.
- **Main Category Priority Rule**: Core functional roles (*Ramp*, *Card Advantage*, *Single Target Removal*, *Mass Removal*, *Protection*, *Tutors*, *Wincons/Finishers*, *Recursion*, *Reanimation*, *Stax*, *Graveyard Fillers*, *Sacrifice Outlets*, *Lands*) ALWAYS take top priority over secondary archetype categories (*Enchantments*, *Spellslinger*, etc.). Cards are assigned to their primary functional roles first. `Counters & Triggers` and `Artifact Engine` are completely removed.
- **Fetch Lands Rule**: Fetch lands (*Polluted Delta*, *Misty Rainforest*, *Scalding Tarn*, *Verdant Catacombs*, *Arid Mesa*, *Marsh Flats*, *Bloodstained Mire*, *Flooded Strand*, *Wooded Foothills*, *Windswept Heath*, *Prismatic Vista*, *Fabled Passage*) belong under `Lands` ONLY. They are NEVER tagged as `Utility Lands`.
- **Reanimation vs Blink & ETB Rule**: Reanimation spells (*Reanimate*, *Animate Dead*, *Victimize*, *Life // Death*, *Necromancy*, *Persist*) belong in `Reanimation` ONLY, and must NEVER be tagged as `Blink & ETB`. `Blink & ETB` is strictly battlefield exile and return (*Ephemerate*, *Flickerwisp*, *Soulherder*, *Teleportation Circle*).
- **EDHREC Integration Rule**: EDHREC is used solely as a raw reference card pool source. EDHREC category names and synergy metrics are ignored completely in favor of Grimore's functional auto-tagging engine.
- **Removal Rule**: Mass removal (*Day of Black Sun*, *Culling Ritual*, *Toxic Deluge*, *Wrath of God*) belongs ONLY in `Mass Removal` (never `Single Target Removal`).
- **Ramp Rule**: Standard lands NEVER count as `Ramp`.
- **Card Advantage vs Selection**: `Card Advantage` is net draw; `Card Selection` is filtering (*Titan's Nest*, *Ponder*).
- **Utility Lands**: Non-mana utility lands ONLY (*Dakmor Salvage*, *Reliquary Tower*, *Urza's Saga*, *Bojuka Bog*, *Strip Mine*, *Wasteland*, *Maze of Ith*, *Rogue's Passage*, *High Market*).
- **Infinite Combo Engine**: Automatically detects combo pairs (*Heliod* + *Walking Ballista*, *Chain of Smog* + *Witherbloom Apprentice*, *Peregrine Drake* + *Deadeye Navigator*, *Hazel's Brewmaster* + *Devoted Druid*) and generates `Combo: Card A + Card B` headers.
- **Token Prevention**: All Scryfall queries filter `+not:token+not:art+not:funny+is:paper` and validate using `isRealCard(p)`. Hover tooltips prioritize exact `scryfallId`.
- **Price Coalesce**: Queries use `COALESCE(pc.price, sc.price, 0.15)` to avoid default $0.15 prices.
