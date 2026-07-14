---
name: mtg-deck-legality
description: How to validate Magic: The Gathering decklists for format legality (Commander/EDH, Brawl, Standard). Handles deck size limits, card copy limits (singles vs basic lands), color identity checking based on commander, and banned list filters. Use whenever the user asks about checking deck legality, validating decklists, importing cards, or analyzing format compliance.
---

# Magic: The Gathering Deck Legality Validator

This skill defines the rules and logic for validating Magic: The Gathering decklists across various formats, with a primary focus on Commander (EDH).

## 1. Commander Format Rules (EDH)

When validating a deck for the Commander format, enforce the following constraints:

### Deck Size
- **Total Cards**: A Commander deck must contain exactly 100 cards.
- **Command Zone**: Can contain 1 Commander, or exactly 2 Commanders if they both have the `Partner` ability.
- **Mainboard**: Must contain 99 cards (if 1 Commander) or 98 cards (if 2 Partner Commanders).

### Card Limits
- **Singleton Rule**: A deck can only contain at most 1 copy of any card by English name, except for cards with the supertype `Basic` (e.g. Plains, Island, Swamp, Mountain, Forest, Wastes) or cards that explicitly state they bypass this limit (e.g. *Relentless Rats*, *Shadowborn Apostle*, *Persistent Petitioners*).

### Color Identity
- Every card in the deck (including the mainboard and any partner commanders) must have a color identity that is a subset of the combined color identity of the commander(s).
- **Color Identity Rules**:
  - The color identity of a card is determined by its mana cost symbols PLUS any mana symbols appearing in its rules text (excluding reminder text like *Extort*).
  - Cards with no mana symbols have a colorless identity.
  - Double-faced cards check both faces for color symbols.

### Commander Validity
- The designated commander(s) must be legendary creatures (or planeswalkers that explicitly state "this card can be your commander").

---

## 2. Standard and Other Formats

### Standard
- **Deck Size**: Minimum of 60 cards in the mainboard. Optional sideboard of up to 15 cards.
- **Card Limits**: Maximum of 4 copies of any card by name (except basic lands).
- **Card Pool**: Check card release sets against currently active Standard-legal expansion sets.

---

## 3. Banlists & Legality Resolution

When checking legality:
1. Parse the card names and quantities from the decklist.
2. Query database or Scryfall API to fetch the card data (color identity, types, and format legalities).
3. Verify that the card's `legalities.commander` or `legalities.standard` is marked as `'legal'` or `'restricted'`.
4. If a card is banned, flag it with the specific ban reason (e.g. *Banned in Commander*).

---

## 4. Implementation Example (JavaScript)

Use this logic structure when coding client-side or server-side decklist validators:

```javascript
function validateCommanderDeck(commanderCards, mainboardCards) {
  const errors = [];
  const warnings = [];
  
  const totalCards = commanderCards.reduce((a, b) => a + b.qty, 0) + mainboardCards.reduce((a, b) => a + b.qty, 0);
  if (totalCards !== 100) {
    errors.push(`Deck must contain exactly 100 cards. Current count: ${totalCards}`);
  }
  
  const cmdCount = commanderCards.reduce((a, b) => a + b.qty, 0);
  if (cmdCount < 1 || cmdCount > 2) {
    errors.push(`Must have exactly 1 or 2 commanders. Current count: ${cmdCount}`);
  }
  
  // Collect commander color identity
  const commanderColors = new Set();
  commanderCards.forEach(c => {
    if (c.colors) c.colors.forEach(col => commanderColors.add(col));
  });
  
  // Check mainboard cards
  mainboardCards.forEach(c => {
    // Singleton check
    const lowerName = c.name.toLowerCase();
    const isBasic = ["plains", "island", "swamp", "mountain", "forest", "wastes"].includes(lowerName);
    if (!isBasic && c.qty > 1) {
      errors.push(`Invalid singleton: ${c.name} has quantity ${c.qty}`);
    }
    
    // Color identity check
    if (c.colors) {
      const invalidColors = c.colors.filter(col => !commanderColors.has(col));
      if (invalidColors.length > 0) {
        errors.push(`Color identity mismatch: ${c.name} contains colors [${invalidColors.join(', ')}] not in Commander's identity.`);
      }
    }
  });
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
```
