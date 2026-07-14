---
name: mtg-platform-dev
description: Specialized guidelines, rules, and scripts for Magic: The Gathering deck validation, Scryfall/Moxfield API lookups, and visual layout constraints for Grimore.
---

# Magic: The Gathering Platform Developer Skill

This skill contains the structural rules, API constraints, and database patterns to build, maintain, and verify features on the Grimore MTG tournament and deck building platform.

## 1. Scryfall API Integration & Rate Limiting
* **Global Sequential Queue**: All HTTP calls to the Scryfall API must be placed in the global server promise queue (`scryfallQueue` in `server.js`) with a strict minimum `130ms` spacing delay. This guarantees the server's IP address will never be rate-limited (HTTP 429).
* **Exact Name Queries**: When querying Scryfall for printings of a card name, use the stand-alone exclamation mark query:
  `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints`
  *Do not append trailing search filters (like `+is:paper` or `+not:funny`) to exact name queries, as Scryfall's parser will throw a 400 Bad Request error. Perform all format legality, digital-only, and joke set checks in JavaScript after receiving the prints array.*

## 2. Card Pricing & Falsy Values Logic
* **Minimum Printing Price**: When repricing cards to their cheapest tournament-legal print, parse and compare the normal price (`usd`), foil price (`usd_foil`), and etched price (`usd_etched`), and take the absolute minimum value:
  ```javascript
  let pVal = Infinity;
  if (usd && usd < pVal) pVal = usd;
  if (usdFoil && usdFoil < pVal) pVal = usdFoil;
  if (usdEtched && usdEtched < pVal) pVal = usdEtched;
  ```
* **Strict Price Checking**: Never use falsy checking (like `c.price || det.price`) to resolve price displays. Basic lands are priced at `$0.00` by default, which resolves as falsy and triggers unwanted oracle fallbacks. Use strict null/undefined comparisons:
  ```javascript
  const price = (c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) 
    ? c.cheapest_card_price 
    : (det.price || 0.10);
  ```

## 3. Deckbuilder & Viewer Visual Layouts
* **Two-Column Grid Layout**: The deckbuilder must be structured as a clean two-column grid (`grid-template-columns: 135px 1fr`) to maximize screen space for the card grid. Column 3 (the right panel) is completely removed.
* **Vertical Sidebar Stack**:
  - The left sidebar is exactly 135px wide, containing a centered glowing Grimore Logo back button (`logo.svg`, width `32px`) at the very top.
  - Below the back button, it stacks the Command Zone container, the Total Price stats block, the sparkline Mana Curve chart, and color abbreviation dots.
  - The Command Zone is 135px wide (slightly wider than the 125px commander card image), stacking commanders vertically at their full sizes.
* **Control Bar Elements**:
  - The deck-level settings (Deck Name, Format, Public, and Reload) and list-level settings (Card Count, Search, Price check, View, Group, and Sort) are combined into a single, unified, ultra-thin control bar (`height: 26px` for all elements) at the top of the Column 2 decklist panel to minimize vertical space.
* **Card Image Sizing**:
  - The size of each card in the card image grid of the deck builder must default to 75% of their original size (`135px` minimum width in `visual-spoiler` grid layout).
* **Moxfield-Style Text View**:
  - In `text` view mode, cards must be grouped inside individual vertically scrolling column panels (`width: 280px`, `flex-shrink: 0`, `height: 100%`) representing each category group.
  - The main container (`builder-zone-mainboard`) should layout columns horizontally (`display: flex; flex-direction: row; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;`) to scale outward to the right with a horizontal scrollbar.
  - Each column panel holds its header and renders its cards list in a container (`overflow-y: auto`, `flex-grow: 1`) allowing vertical scrolling inside the box.
* **Global Background Animation**:
  - The main dashboard content viewport (`.main-content`) and fullscreen views active states (`#playtest-view`, `#deckbuilder-view`, `#deck-view-view`) must have transparent backgrounds (`background-color: transparent;`).
  - This ensures that the fixed background canvas (`#app-bg-canvas`) renders the spinning arcane circles, floating runes, and drifting smoke wisps animation natively across all functions on the platform.
