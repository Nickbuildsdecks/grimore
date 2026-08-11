---
name: gaming-typography-icons
description: Modern video game typography, Google Fonts integration (Outfit, Rajdhani, Cinzel, Inter), SVG mana symbols, vector game badges, and crisp UI icon suites for Grimore. Make sure to use this skill whenever designing game headings, icon buttons, typography hierarchies, or MTG mana badges.
---

# Gaming Typography & Vector Icon Suite

Standards for embedding modern game typography, SVG mana symbol renderers, and video game-grade UI badges.

## 🔤 Google Fonts Integration

```html
<!-- AAA Video Game Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;800;900&family=Outfit:wght@500;700;800;900&family=Rajdhani:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

```css
/* Typography Scale */
h1.game-title {
  font-family: 'Cinzel', serif;
  font-size: 2.2rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  background: linear-gradient(135deg, #ffffff 0%, #f5c842 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  text-shadow: 0 4px 20px rgba(245, 200, 66, 0.3);
}

.hud-section-header {
  font-family: 'Rajdhani', sans-serif;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #f1f5f9;
}
```

## 🔮 Mana Symbol & Game Badge Renderer

```html
<div class="mana-badge-row">
  <span class="mana-pip mana-w" title="White Mana">W</span>
  <span class="mana-pip mana-u" title="Blue Mana">U</span>
  <span class="mana-pip mana-b" title="Black Mana">B</span>
  <span class="mana-pip mana-r" title="Red Mana">R</span>
  <span class="mana-pip mana-g" title="Green Mana">G</span>
</div>
```

```css
.mana-pip {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: 'Outfit', sans-serif;
  font-weight: 800;
  font-size: 0.72rem;
  box-shadow: inset 0 1px 3px rgba(255,255,255,0.4), 0 2px 6px rgba(0,0,0,0.6);
  border: 1px solid rgba(255,255,255,0.2);
}
.mana-w { background: radial-gradient(circle, #fef08a 0%, #ca8a04 100%); color: #451a03; }
.mana-u { background: radial-gradient(circle, #38bdf8 0%, #0369a1 100%); color: #082f49; }
.mana-b { background: radial-gradient(circle, #c084fc 0%, #581c87 100%); color: #1e1b4b; }
.mana-r { background: radial-gradient(circle, #f87171 0%, #b91c1c 100%); color: #450a0a; }
.mana-g { background: radial-gradient(circle, #4ade80 0%, #15803d 100%); color: #052e16; }
```
