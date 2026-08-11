---
name: mtg-arena-conquest-suite
description: Standard Operating Procedure for building MTG Arena-quality web playtest sandboxes, YouTube match replay engines, rules enforcement loops, State-Based Actions (CR 704), and AI opponent battle arenas. Make sure to use this skill whenever building sandbox features, replay engines, rules enforcement, or MTG playtester interfaces.
---

# MTG Arena Conquest Suite SOP

Complete standard operating procedure for designing, building, testing, and maintaining MTG Arena-level web playtesting tools and replay engines.

## 🏆 Core Capabilities Architecture

1. **Replay Harness Engine (`/api/sandbox/replays`)**:
   - Turn-by-turn action step manifests for famous recorded matches (*Game Knights #40*, *cEDH Championship Final*).
   - Replay control bar with `Auto Play`, `Step Next`, `Step Back`, and step log progress indicators.

2. **State-Based Actions Engine (`checkStateBasedActions()`)**:
   - **CR 704.5a**: Checks for players at 0 or less life.
   - **CR 704.5c**: Checks for 10+ poison counter loss threshold.
   - **CR 704.5f**: Detects creatures reduced to 0 or less toughness.
   - **CR 903.10**: Enforces 21+ Commander Damage loss.

3. **High-Res Scryfall CDN Integration**:
   - Fetch uncompressed retina-quality images using `https://cards.scryfall.io/large/front/...`.
   - Dynamic token image fallback handling for tokens like Treasure, Food, Clue, Goblin, Zombie.

4. **Multi-Player Pod Architecture**:
   - 3 parallel side-by-side opponent battlefield columns.
   - 1-click active focus toggle with gold glow border.
   - Live MTG Stack overlay floating above center battlefield.
