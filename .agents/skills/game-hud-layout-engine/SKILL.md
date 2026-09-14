---
name: game-hud-layout-engine
description: Multi-zone responsive gaming HUD layouts, 3-column opponent battlefields, space equity grid systems, collapsible action drawers, and modal overlays for Grimore. Make sure to use this skill whenever engineering battlefield layouts, grid areas, opponent columns, or HUD drawer systems.
---

# Game HUD Layout Engine

Architecture specifications and layout systems for multi-opponent gaming HUD interfaces.

## 📐 4-Player Commander Board Grid Layout

```css
#arena-root {
  display: grid;
  grid-template-rows: 48px 1fr 48px;
  grid-template-columns: 240px 1fr 280px;
  grid-template-areas:
    "topbar topbar topbar"
    "left-cmd board right-advisor"
    "bottom-mana bottom-mana bottom-mana";
  height: 100vh;
  overflow: hidden;
}

#arena-board {
  grid-area: board;
  position: relative;
  display: grid;
  grid-template-rows: 0.30fr 8px 1fr;
  overflow: hidden;
}
```

## ⚔️ 3-Opponent Side-by-Side Battlefield Columns

```html
<div id="opponents-pods-container">
  <div class="opp-mini-pod active" id="opp-pod-p2">...</div>
  <div class="opp-mini-pod" id="opp-pod-p3">...</div>
  <div class="opp-mini-pod" id="opp-pod-p4">...</div>
</div>
```

```css
#opponents-pods-container {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  padding: 8px 12px;
  background: var(--arena-felt-top);
  border-bottom: 1px solid var(--glass-border-md);
  box-sizing: border-box;
  overflow: hidden;
  height: 100%;
}
```

## 🎯 Layout Rules
1. **Space Equity**: Player battlefield receives 76%+ height equity for large readable cards.
2. **Opponent Visibility**: All 3 opponents are visible simultaneously in parallel columns.
3. **No Screen Waste**: Fixed headers and action toolbars do not exceed 48px height.
