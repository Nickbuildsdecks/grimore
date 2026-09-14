---
name: mtg-playtest-sandbox
description: Guidelines and standard operating procedures for building full-screen, production-grade MTG playtest sandboxes, AI battle arenas, multi-zone card manipulators, and token spawner engines.
---

# MTG Playtest Sandbox Architecture & Design Guidelines

When building or extending the MTG Playtest Sandbox in Grimore, strictly follow these architectural standards derived from digital card gaming platforms (MTGO, MTG Arena, Untap.in, Cockatrice).

## 1. Full-Screen Page Architecture (No Modals)
- The Playtest Sandbox must occupy its own dedicated, unconstrained full-screen page section (`<section id="sandbox-view">`).
- Never wrap primary gameplay/playtest loops inside small popups or modals. Popups are reserved strictly for auxiliary tasks (Token Spawner search, Library inspector).

## 2. Multi-Zone Card Management
A complete digital MTG sandbox requires 6 explicit interactive zones:
1. **Library**: Stack count, Draw 1/X, Shuffle, Search Library inspector overlay.
2. **Hand**: Floating hover preview, drag-and-drop or 1-click play to battlefield.
3. **Battlefield**: Organized rows for Lands, Artifacts/Enchantments, Creatures, Planeswalkers, Tokens.
4. **Graveyard**: Visible pile stack with view/recur overlay.
5. **Exile**: Visible exile pile stack with view overlay.
6. **Command Zone**: Commander image, Commander tax tracker (+2 per cast), 1-click Cast.

## 3. In-Game Card Manipulations & Counters
Every card on the battlefield must feature a context control menu or quick action bar:
- **Tap/Untap**: 90-degree smooth transform rotation.
- **Counters**: Add/remove +1/+1 counters, Loyalty counters, Charge counters.
- **Cloning/Duplication**: 1-click clone spawning an exact copy token.
- **Zone Movement**: Move card to Hand, Graveyard, Exile, Top/Bottom of Library.

## 4. Token Engine
- Provide a token search & spawner drawer/modal supporting common MTG tokens (*Treasure*, *Food*, *Clue*, *1/1 Goblin*, *2/2 Zombie*, *3/3 Beast*, *4/4 Angel*, *5/5 Dragon*, *X/X Construct*, *1/1 Vampire*) and custom tokens.

## 5. Integrated AI Opponent Battle Mode
- Seamless toggle between Solo Goldfish Mode and AI Opponent Arena.
- Displays AI opponent board state, AI colored mana pool, 7-phase stepper, automated turn execution, and AI tactical reasoning trace.
