---
name: game-ui-design-system
description: Design tokens, obsidian glassmorphism panels, glowing neon badges, radial gauges, and modern AAA video game UI/UX standards for Grimore. Make sure to use this skill whenever building or refining gaming user interfaces, HUD panels, color palettes, or visual design systems.
---

# AAA Game UI Design System

This skill provides comprehensive design standards, CSS custom properties, and UI components for building AAA video game-grade user interfaces (MTG Arena, Hearthstone, Valorant, Genshin Impact level polish).

## 🎨 Color Palette & Design Tokens

```css
:root {
  /* Obsidian Core & Glass Surfaces */
  --bg-dark-obsidian: #080c16;
  --bg-panel-dark: rgba(15, 23, 42, 0.85);
  --bg-card-surface: rgba(30, 41, 59, 0.7);
  --glass-border-light: rgba(255, 255, 255, 0.12);
  --glass-border-glow: rgba(168, 85, 247, 0.4);

  /* Mana & Gaming Neon Accents */
  --color-gold: #f5c842;
  --color-gold-glow: rgba(245, 200, 66, 0.35);
  --color-mana-white: #fef08a;
  --color-mana-blue: #38bdf8;
  --color-mana-black: #c084fc;
  --color-mana-red: #f87171;
  --color-mana-green: #4ade80;

  /* Typography Fonts */
  --font-display: 'Rajdhani', 'Outfit', sans-serif;
  --font-body: 'Inter', system-ui, -apple-system, sans-serif;

  /* Elevation Shadows & Glows */
  --shadow-hud: 0 10px 30px rgba(0, 0, 0, 0.7);
  --glow-gold-lg: 0 0 25px rgba(245, 200, 66, 0.4);
  --glow-purple-lg: 0 0 25px rgba(168, 85, 247, 0.4);
}
```

## 🛡️ Glassmorphism Panel Component Pattern

```html
<div class="game-hud-panel">
  <div class="game-hud-panel-header">
    <span class="hud-title">COMMAND ZONE</span>
    <span class="hud-badge">TAX: +0</span>
  </div>
  <div class="game-hud-panel-body">
    <!-- Panel Content -->
  </div>
</div>
```

```css
.game-hud-panel {
  background: var(--bg-panel-dark);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border-light);
  border-radius: 12px;
  box-shadow: var(--shadow-hud);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.game-hud-panel:hover {
  border-color: var(--glass-border-glow);
  box-shadow: 0 0 20px rgba(168, 85, 247, 0.2);
}
```

## ⚡ Principles for Video Game-Grade Polish

1. **High Contrast Readability**: Dark obsidian background with vivid high-contrast text (`#f8fafc`) and neon accent badges.
2. **Tactile Hover Micro-Interactions**: Hovering buttons/cards applies `translateY(-2px)` elevation, glowing borders, and smooth 0.2s cubic-bezier transitions.
3. **No Unnecessary Clutter**: Keep primary gameplay controls prominent while organizing detailed stats into clean sub-panels and popovers.
