# Directive: Grimore Functional Auto-Tagging & Infinite Combo Engine SOP

This document defines the exact rules, categorization logic, combo signatures, token prevention guidelines, and pricing algorithms for Grimore's deck builder Auto-Tagging feature.

---

## 🎯 Primary Purpose
Sort decklists strictly by card **function** rather than card type (Creature, Instant, Sorcery). Cards appear under all matching functional role headers without inflating physical card totals. Cards with zero matching functional roles belong under `Unique`.

---

## 🏷️ Functional Category Order & Rules

1. **Infinite Combos & Dynamic Combo Signatures**:
   - Signature pairing database automatically checks the decklist. If all pieces of a combo exist in the deck, each piece is tagged with `Combo: Card A + Card B` (e.g., `Combo: Chain of Smog + Witherbloom Apprentice`, `Combo: Peregrine Drake + Deadeye Navigator`, `Combo: Hazel's Brewmaster + Devoted Druid`, `Combo: Heliod + Walking Ballista`, `Combo: Thassa's Oracle + Demonic Consultation`).
   - Cards in a combo are placed under their custom `Combo: ...` header.

2. **Wincons / Finishers**:
   - Spells that directly end the game or grant extra turns (`you win the game`, `loses the game`, `take an extra turn`).

3. **Tutors**:
   - Cards that search the library (`search your library`). Note: Lands like *Urza's Saga* that tutor also count under *Tutors* & *Utility Lands*.

4. **Stax**:
   - Taxing, lock, or hatebear effects (`spells cost`, `opponents can't cast`, `can't untap`).

5. **Mass Removal vs. Single Target Removal**:
   - `Mass Removal`: Board wipes and sweepers (`destroy all`, `exile all`, `each creature gets -`, *Day of Black Sun*, *Culling Ritual*, *Toxic Deluge*, *Wrath of God*, *Damnation*, *Blasphemous Act*).
   - `Single Target Removal`: Spot removal ONLY (`destroy target`, `exile target`, `counter target spell`). **Never** tag a Mass Removal spell as Single Target Removal.

6. **Protection**:
   - Defensive effects that protect **other** cards, your board state, your commander, or your player (*Teferi's Protection*, *Heroic Intervention*, *Swiftfoot Boots*, *Lightning Greaves*, *Flawless Maneuver*, *Tamiyo's Safekeeping*, *Mother of Runes*). Self-indestructible or self-hexproof on big threats (*Koma, Cosmos Serpent*, *Carnage Tyrant*) **never** counts as team `Protection` (Koma belongs under *Wincons / Finishers* only).

7. **Ramp**:
   - Cards that accelerate mana ahead of the mana curve (Mana dorks, mana rocks, rituals, extra land drops). **Lands NEVER count as Ramp** (they are your mana curve).

8. **Card Advantage vs. Card Selection**:
   - `Card Advantage`: Net hand size expansion or replacing itself with extra resources (*Grisly Salvage*, *Phyrexian Arena*, *Harmonize*, *Rhystic Study*, *Ghostly Pilferer*, *Syphon Mind*, *Nezahal*).
   - `Card Selection`: Filtering, scrying, surveilling, looting/rummaging without net hand growth (*Titan's Nest*, *Ponder*, *Brainstorm*, *Preordain*, *Sylvan Library*, *Impulse*).

9. **Recursion**:
   - Returning cards from graveyard to hand (*Eternal Witness*, *Seasons Past*, *Regrowth*, *Reclaim*).

10. **Reanimation**:
    - Returning cards from graveyard directly to the battlefield (*Reanimate*, *Animate Dead*, *Victimize*, *Life // Death*).

11. **Graveyard Fillers**:
    - Milling or dumping cards into graveyard (*Grisly Salvage*, *Ripples of Undeath*, *Satyr Wayfinder*, *Stitcher's Supplier*).

12. **Sacrifice Outlets**:
    - Sacrificing permanents for value (*Viscera Seer*, *Phyrexian Altar*, *Ashnod's Altar*, *Goblin Bombardment*).

13. **Utility Lands vs. Lands**:
    - `Utility Lands`: Strictly reserved for non-basic lands performing non-mana functions (*Dakmor Salvage*, *Reliquary Tower*, *Urza's Saga*, *Bojuka Bog*, *Strip Mine*, *Maze of Ith*, *Rogue's Passage*, *High Market*).
    - `Lands`: Mana-producing lands (*Command Tower*, Triomes, Shocklands, Duals, Basics).

14. **Unique**:
    - Applied ONLY if a card has zero other functional roles or combo tags. If any functional or combo tag is assigned, `Unique` MUST be stripped.

---

## 🚫 Token Prevention & Scryfall Image Resolution
- **Rule**: Cards must NEVER resolve to token, emblem, art series, or memorabilia versions.
- **Implementation**:
  - Scryfall searches append `+not:token+not:art+not:funny+is:paper`.
  - Scryfall objects are validated with `isRealCard(p)` (rejecting `layout: token`, `set_type: token`, `type_line: Token...`).
  - Hover tooltips use card specific `scryfallId` to ensure the exact printing artwork is displayed.

---

## 💵 Price Coalesce Standard
- Card prices query `COALESCE(pc.price, sc.price, 0.15)` to pull from `card_price_cache` or `scryfall_cards` to prevent default $0.15 fallbacks.
