---
name: card-frame-visual-effects
description: High-resolution MTG card artwork, foil sheen overlays, holographic rarity effects, floating power/toughness badges, and commander portrait frames for Grimore. Make sure to use this skill whenever rendering cards, foil sheens, power/toughness overlays, or commander frames.
---

# Card Frame Visual Effects & Foil Sheen Renderer

Visual polish guidelines and CSS animation effects for high-definition card rendering and holographic sheens.

## ✨ Holographic Foil Sheen Effect

```css
.arena-card {
  position: relative;
  width: 90px;
  height: 126px;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
}

.arena-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: high-quality;
  image-rendering: crisp-edges;
}

/* Holographic Foil Overlay */
.arena-card.foil::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: linear-gradient(
    115deg,
    transparent 0%,
    rgba(255, 255, 255, 0.15) 30%,
    rgba(245, 200, 66, 0.3) 45%,
    rgba(168, 85, 247, 0.3) 55%,
    rgba(56, 189, 248, 0.3) 70%,
    transparent 100%
  );
  transform: rotate(25deg);
  pointer-events: none;
  mix-blend-mode: color-dodge;
  animation: foilShimmer 4s infinite linear;
}

@keyframes foilShimmer {
  0% { transform: translateY(-30%) rotate(25deg); }
  100% { transform: translateY(30%) rotate(25deg); }
}
```

## ⚔️ Floating Power / Toughness Badge

```html
<div class="card-pt-badge">4 / 4</div>
```

```css
.card-pt-badge {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: radial-gradient(circle, rgba(15, 23, 42, 0.95) 0%, rgba(30, 41, 59, 0.95) 100%);
  border: 1px solid var(--color-gold);
  color: var(--color-gold);
  font-family: 'Outfit', sans-serif;
  font-weight: 800;
  font-size: 0.68rem;
  padding: 1px 6px;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.8), 0 0 10px rgba(245, 200, 66, 0.3);
  z-index: 5;
}
```
