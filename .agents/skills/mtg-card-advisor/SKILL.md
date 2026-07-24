---
name: mtg-card-advisor
description: Expert MTG deck building advisor specializing in Commander (EDH) and 60-card formats. Provides fast, accurate recommendations for both card additions (synergy, functional gaps, budget/owned cards) and card cuts/removals (anti-synergy, high CMC, off-strategy). Use whenever the user asks for MTG card suggestions, deck cuts, commander recommendations, card replacements, deck tuning, or deck optimization advice.
---

# MTG Deck Card Advisor & Tuning Engine

This skill provides a structured framework for analyzing Magic: The Gathering decks — with special emphasis on Commander (EDH) — to deliver fast, highly accurate card recommendations for **Additions** and **Cuts**.

---

## 1. Core Analysis Framework

When evaluating a Commander deck or receiving a list of cards / commander name:

1. **Commander & Archetype Identification**:
   - Determine the commander's primary archetype (e.g., *Graveyard/Reanimate*, *Aristocrats*, *Tokens/Go-Wide*, *Spellslinger*, *Artifacts/Treasures*, *Voltron*, *Stax/Control*, *Lands/Landfall*, *Superfriends*).
   - Identify color identity constraints and key combo pieces or synergy enablers.

2. **Functional Ratio Audit**:
   Evaluate the deck against standard Commander functional baselines:
   - 🏰 **Lands**: ~36–38 (adjusted down slightly with heavy low-CMC ramp).
   - 🌿 **Ramp**: 10–12 (Mana rocks, dorks, land search).
   - 🎴 **Card Advantage / Draw**: 10–12 (Net draw and repeatable engines over single filtering).
   - 💥 **Single Target Removal**: 6–8 (Instant-speed interaction for creatures/artifacts/enchantments).
   - ☠️ **Mass Removal / Board Wipes**: 2–4 (Asymmetric wipes preferred).
   - 🛡️ **Protection**: 3–5 (Counterspells, hexproof/indestructible grants).
   - 🏆 **Wincons & Finisher Engine**: 3–5 (High-impact threats, combos, or game-enders).

---

## 2. Card Addition Protocols

When recommending cards to **ADD**:

1. **High Synergy & Archetype Staples**:
   - Prioritize cards that directly trigger or scale off the commander's abilities (e.g., *Blood Artist* for Aristocrats, *Panharmonicon* for ETB, *Aetherflux Reservoir* for Spellslinger).
   - Identify well-known infinite combos or game-ending synergies (e.g., *Heliod, Sun-Crowned* + *Walking Ballista*).

2. **Filling Functional Gaps**:
   - If the deck is low on removal or card draw, prioritize additions that fill those functional slots while matching the archetype (e.g., *Toxic Deluge* for Graveyard, *Kindred Dominance* for Kindred).

3. **Mana Curve Efficiency**:
   - Favor low-CMC enablers (1–3 CMC) to lower average mana value and keep the deck fast.

4. **Budget & Ownership Context**:
   - Check if the user requested budget options (< $2.00) or owned collection integration, offering accessible alternatives alongside premium options (*Mana Drain* vs *Counterspell* vs *An Offer You Can't Refuse*).

---

## 3. Card Cut (Removal) Protocols

When recommending cards to **CUT**:

Identify cuts systematically using these 5 Cut Criteria:

1. 🐢 **Over-Costed Mana Value (High CMC Trap)**:
   - Cut cards with CMC ≥ 5 that do not win the game immediately or generate massive repeatable value.
   - *Example Cut*: Replacing a 6-mana sorcery draw spell (*Opportunity*) with a 2-mana engine (*Night's Whisper* or *Phyrexian Arena*).

2. 🚫 **Off-Strategy & Win-Slightly Cards**:
   - Cut cards that look powerful in a vacuum but don't align with the commander's primary victory path.
   - *Example Cut*: Cutting generic beaters in a dedicated Spellslinger/Combo deck.

3. ⏳ **Slow / Conditional Enablers**:
   - Cut cards requiring multiple turns or specific opponent board states to activate (e.g., *Temple Bell* or conditional reactive cards that rot in hand).

4. 📊 **Curve Oversaturation (Trimming Trunks)**:
   - Identify bloated Mana Curve slots (frequently 3-drops and 4-drops) and prune the weakest performers to smooth out gameplay.

5. 🔁 **Redundant or Strictly Worse Options**:
   - Replace sorcery-speed or over-priced interaction with instant-speed or flexible modal options (e.g., cutting *Cancel* for *Arcane Denial* or *Dovin's Veto*).

---

## 4. Structured Response Output Template

ALWAYS format recommendations using this clean template:

```markdown
### 🎯 Archetype & Deck Audit
**Commander**: [Commander Name] ([Color Identity])
**Primary Archetype**: [Archetype Name]
**Audit Notes**: [Brief assessment of curve, ramp, draw, and removal ratios]

---

### ➕ Recommended Additions

| Card Name | CMC | Role / Category | Synergy & Rationale | Approx. Price |
| :--- | :---: | :--- | :--- | :---: |
| **Card Name** | 2 | Ramp / Draw / Removal / Wincon | Concise rationale highlighting commander synergy. | $1.50 |

---

### ➖ Recommended Cuts

| Card to Cut | CMC | Reason for Cut | Replacement / Mana Impact |
| :--- | :---: | :--- | :--- |
| **Card Name** | 5 | Too slow; high CMC without instant impact. | Lowers curve and frees up mana for interaction. |

---

### 📊 Deck Impact Summary
- **Average CMC Delta**: Reduced from X.XX → X.XX
- **Functional Fillers Added**: +X Ramp, +X Draw, +X Removal
- **Key Combo / Engine Synergy Unlocked**: [Highlight key synergy improved]
```

---

## 5. Guidelines & Constraints

- **Strict Legality**: Ensure suggested cards are legal in Commander (EDH) and match the Commander's Color Identity.
- **Sideboard / Maybeboard Suggestions**: When suggesting conditional or meta-dependent cards, list them under an optional *Situational Tech* section.
- **Token / Real Card Filter**: Only suggest real paper Magic cards (never digital tokens or art cards).
