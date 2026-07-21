---
name: mtg-functional-classification
description: Comprehensive Magic: The Gathering functional terminology definitions, card classification boundaries, infinite combo detection rules, and auto-tagging SOPs for the Grimore platform. Use whenever analyzing, categorizing, or auto-tagging MTG cards by function.
---

# MTG Functional Classification & Taxonomy SOP

This skill defines the authoritative definitions, precise MTG rules boundaries, classification edge cases, and auto-tagging directives for the Grimore platform.

---

## 📌 Core Rule: Categorization by Function, Never by Type
Cards in Grimore decklists must **NEVER** be categorized by standard card types (e.g. *Creatures*, *Instants*, *Sorceries*). Cards are sorted strictly by their **functional role** in the deck. Multi-functional cards belong under all applicable functional headers simultaneously without inflating physical card totals. Cards with zero matching functional roles belong under `Unique`.

---

## 📖 Comprehensive MTG Functional Terminology Definitions & Boundaries

### 1. Ramp
* **Definition**: Cards or spells that put a player ahead of the natural mana curve (the baseline 1 land play per turn).
* **Includes**:
  - Mana dorks (*Llanowar Elves*, *Birds of Paradise*, *Delighted Halfling*)
  - Mana rocks (*Sol Ring*, *Arcane Signet*, *Mana Crypt*, *Fellwar Stone*, *Talismans*, *Signets*)
  - Land acceleration (*Rampant Growth*, *Three Visits*, *Farseek*, *Nature's Lore*, *Cultivate*)
  - Mana multipliers & rituals (*Dark Ritual*, *Mana Reflection*, *Mirari's Wake*, *Cabal Ritual*, *Carpet of Flowers*)
  - Extra land drop enablers (*Exploration*, *Burgeoning*, *Azusa, Lost but Seeking*)
* **Strict Rule**: Standard lands (basics, duals, shocklands, triomes, utility lands) **NEVER** count as Ramp because lands define your base curve.

### 2. Card Advantage
* **Definition**: Cards or spells that result in a net increase in total accessible cards or resources in your hand or hand-equivalent.
* **Includes**:
  - Net card draw spells (*Harmonize*, *Night's Whisper*, *Read the Bones*, *Syphon Mind*, *Deep Analysis*)
  - Repeatable draw engines (*Phyrexian Arena*, *Rhystic Study*, *Esper Sentinel*, *Ghostly Pilferer*, *Nezahal, Primal Tide*)
  - Multi-resource impulse/grave draws (*Grisly Salvage*, *Ripples of Undeath*)
* **Boundary vs Card Selection**: If a spell draws cards but requires discarding/putting back an equal or greater number of cards without netting extra cards, it belongs in *Card Selection*, not *Card Advantage*.

### 3. Card Selection
* **Definition**: Cards that filter quality, manipulate the top of the library, scry, surveil, or select specific cards without net card quantity growth.
* **Includes**:
  - Topdeck manipulation & filtering (*Sylvan Library*, *Sensei's Divining Top*, *Titan's Nest*)
  - Cantrips & quality filters (*Ponder*, *Preordain*, *Serum Visions*, *Impulse*, *Brainstorm*)
  - Looting / Rummaging without net card gain (*Faithless Looting*, *Frantic Search*, *Cathartic Reunion*)

### 4. Single Target Removal (Spot Removal)
* **Definition**: Spells or abilities that destroy, exile, counter, bounce, or deal lethal damage targeting a single specific permanent or spell.
* **Includes**:
  - Single target removal (*Swords to Plowshares*, *Path to Exile*, *Abrupt Decay*, *Assassin's Trophy*, *Beast Within*, *Generous Gift*, *Volatile Stormdrake*)
  - Single target counterspells (*Counterspell*, *Mana Drain*, *Fierce Guardianship*, *Force of Will*, *Negate*, *Swan Song*)
* **Strict Boundary**: Spells that destroy/exile/shrink ALL permanents or each creature belong in *Mass Removal* ONLY, and MUST NOT appear in Single Target Removal.

### 5. Mass Removal (Board Wipes / Sweepers)
* **Definition**: Spells or abilities that destroy, exile, bounce, or shrink all or multiple creatures/permanents simultaneously.
* **Includes**:
  - Global sweepers & board wipes (*Day of Black Sun*, *Culling Ritual*, *Toxic Deluge*, *Wrath of God*, *Damnation*, *Blasphemous Act*, *Supreme Verdict*, *Cyclonic Rift* (overload), *The Meathook Massacre*, *Vanquish the Horde*)
* **Strict Boundary**: Mass removal spells MUST NOT be categorized as Single Target Removal.

### 6. Protection
* **Definition**: Spells or abilities designed to defend **other** permanents, your commander, your board state, or your player state from removal, combat damage, or targeted spells.
* **Includes**:
  - Full board protection (*Teferi's Protection*, *Heroic Intervention*, *Flawless Maneuver*, *Clever Concealment*)
  - Target / Commander protection (*Lightning Greaves*, *Swiftfoot Boots*, *Tamiyo's Safekeeping*, *Mother of Runes*, *Veil of Summer*, *Deflecting Swat*)
* **Strict Boundary**: Self-indestructible or self-hexproof on big threats (*Koma, Cosmos Serpent*, *Carnage Tyrant*, *Ghalta*) does **NEVER** count as team Protection. Koma belongs under *Wincons / Finishers* only (avoiding Stax vagueness for players).

### 7. Stax
* **Definition**: Permanents or spells that impose resource restrictions, tax spell costs, limit player actions, deny untapping, or lock down opponents.
* **Includes**:
  - Spell tax (*Thalia, Guardian of Thraben*, *Grand Arbiter Augustin IV*, *Rhystic Study* tax)
  - Untap denial & resource lock (*Static Orb*, *Winter Orb*, *Stasis*, *Back to Basics*, *Blood Moon*)
  - Ability / Activation lockdown (*Linvala, Keeper of Silence*, *Koma, Cosmos Serpent* activation lock, *Cursed Totem*, *Drannith Magistrate*, *Rule of Law*)

### 8. Tutors
* **Definition**: Spells or abilities that search the library for a specific card or card type and place it into hand, top of library, or onto the battlefield.
* **Includes**:
  - Generic tutors (*Demonic Tutor*, *Vampiric Tutor*, *Imperial Seal*)
  - Focused tutors (*Worldly Tutor*, *Enlightened Tutor*, *Mystical Tutor*, *Eldritch Evolution*, *Green Sun's Zenith*, *Urza's Saga*)

### 9. Wincons / Finishers
* **Definition**: Cards or spells that directly execute an alternate win condition, grant extra turns, deal massive board damage, or serve as game-ending commanders/threats.
* **Includes**:
  - Alternate wincons (*Thassa's Oracle*, *Laboratory Maniac*, *Aetherflux Reservoir*, *Felidar Sovereign*)
  - Extra turn spells (*Time Warp*, *Expropriate*, *Temporal Manipulation*)
  - Massive finishers (*Craterhoof Behemoth*, *Triumph of the Hordes*, *Torment of Hailfire*, *Villainous Wealth*, *Koma, Cosmos Serpent*)

### 10. Recursion
* **Definition**: Cards or abilities that return cards from the graveyard back to the player's hand or library.
* **Includes**: (*Eternal Witness*, *Seasons Past*, *Regrowth*, *Reclaim*, *Noxious Revival*, *Life from the Loam*)

### 11. Reanimation
* **Definition**: Cards or abilities that return permanent cards directly from a graveyard onto the battlefield.
* **Includes**: (*Reanimate*, *Animate Dead*, *Necromancy*, *Victimize*, *Life // Death*, *Exhume*, *Dance of the Dead*)

### 12. Graveyard Fillers / Self-Mill
* **Definition**: Cards or abilities that mill or transfer cards from library/hand directly into the graveyard to fuel reanimation, recursion, delve, or dredge strategies.
* **Includes**: (*Grisly Salvage*, *Ripples of Undeath*, *Satyr Wayfinder*, *Stitcher's Supplier*, *Hermit Druid*, *Hedron Crab*)

### 13. Sacrifice Outlets
* **Definition**: Permanents or abilities that allow sacrificing creatures or permanents repeatedly or at will for value.
* **Includes**: (*Viscera Seer*, *Carrion Feeder*, *Phyrexian Altar*, *Ashnod's Altar*, *Goblin Bombardment*, *High Market*)

### 14. Utility Lands vs. Lands
* **`Utility Lands`**: Non-basic lands that provide active functional utility other than or in addition to producing mana (*Dakmor Salvage*, *Reliquary Tower*, *Urza's Saga*, *Bojuka Bog*, *Strip Mine*, *Wasteland*, *Maze of Ith*, *Rogue's Passage*, *High Market*).
* **`Lands`**: Mana-producing lands (*Command Tower*, Triomes, Shocklands, Duals, Basics).

### 15. Dynamic Infinite Combo Engine
* **Definition**: Automatically scans the decklist for known multi-card infinite combo pairings. When all pieces are present, creates custom headers grouping the pieces together (e.g., `Combo: Heliod + Walking Ballista`, `Combo: Chain of Smog + Witherbloom Apprentice`, `Combo: Peregrine Drake + Deadeye Navigator`, `Combo: Hazel's Brewmaster + Devoted Druid`).

### 16. Unique
* **Definition**: Applied ONLY if a card matches zero other functional roles or combo tags. If any functional or combo tag is assigned to a card, `Unique` MUST be removed.

---

## 🛡️ Technical Implementation Directives

1. **Token Prevention Guard (`isRealCard`)**:
   - Filter out `layout: "token"`, `layout: "art_series"`, `layout: "double_faced_token"`, `set_type: "token"`, `set_type: "memorabilia"`.
   - Append `+not:token+not:art+not:funny+is:paper` to all Scryfall queries.

2. **Price Coalesce Standard**:
   - Always query `COALESCE(pc.price, sc.price, 0.15)` to pull market price data from `card_price_cache` or `scryfall_cards` to prevent default $0.15 prices.
