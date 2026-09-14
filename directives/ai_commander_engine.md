# Directive: AI Commander Opponent Decision Engine & Combat Heuristics

This SOP defines the deterministic decision tree, turn phase state machine, and combat heuristics for the automated **AI Commander Opponent Simulator** in Grimore.

---

## 🧠 Decision Engine Pipeline

### Phase 1: Untap & Upkeep
1. Untap all AI permanents on battlefield (`tapped = false`).
2. Trigger Upkeep effects (e.g. *Koma* Serpent generation, *Phyrexian Arena* draw card).

### Phase 2: Draw Phase
1. Draw 1 card from AI library deck.
2. Increment AI hand count.

### Phase 3: Main Phase 1 (Land & Ramp Priority)
1. **Land Placement**: If AI has a land in hand and has not played a land this turn:
   - Play 1 land onto AI battlefield.
2. **Mana Calculation**: Calculate total available mana across untapped lands and artifacts (`W`, `U`, `B`, `R`, `G`, `C`).
3. **Casting Priority Algorithm**:
   - **Priority 1: Urgent Control / Removal**: If opponent (player) controls a permanent with power $\ge 6$ or lethal board threats:
     - Search AI hand for removal spells (*Swords to Plowshares*, *Toxic Deluge*, *Counterspell*).
     - Tap required mana and cast removal.
   - **Priority 2: Ramp & Mana Acceleration**: On Turns 1–3, if AI hand contains Ramp (*Sol Ring*, *Arcane Signet*, *Cultivate*):
     - Tap required mana and cast Ramp spell onto AI battlefield.
   - **Priority 3: Commander Cast**: If AI Commander is in Command Zone and AI has required mana & color identity:
     - Cast AI Commander onto AI battlefield.
   - **Priority 4: Synergy Threats & Engine Cards**: Cast highest CMC threat in hand that AI can afford.

### Phase 4: Combat Phase
1. **Threat Evaluation**: Calculate total attack power of untapped AI creatures vs opponent (player) blockers.
2. **Attack Declaration**:
   - If AI board power $\ge$ player's life total or if AI creatures have evasion (Flying/Trample):
     - Declare attack against player!
     - Tap attacking AI creatures (`tapped = true`).
   - Calculate combat damage: Reduce player life total by unblocked attacker power.

### Phase 5: Main Phase 2 & End Step
1. **Proliferate & End Step Triggers**:
   - *Atraxa*: Proliferate +1/+1 counters on all AI creatures.
   - *Krenko*: Activate Krenko to double Goblin tokens if Krenko is untapped.
   - *Muldrotha*: Recur 1 permanent from AI graveyard.
2. Pass turn to player.
