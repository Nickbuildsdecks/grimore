---
name: visual-combat-stack-engine
description: Live visual MTG stack overlay, targeted spell beam animations, spell resolution particle bursts, combat damage floating numbers, and phase indicators for Grimore. Make sure to use this skill whenever building spell stack overlays, combat damage numbers, spell target lines, or phase indicators.
---

# Visual Combat & Stack Overlay Engine

Implementation patterns for rendering live MTG stack overlays, targeted spell beams, and floating combat damage numbers.

## ⚡ Floating Combat Damage FX

```javascript
function triggerFloatingDamageNumber(targetElement, damageAmount, isGain = false) {
  const rect = targetElement.getBoundingClientRect();
  const floatEl = document.createElement('div');
  floatEl.className = `floating-number ${isGain ? 'gain' : 'damage'}`;
  floatEl.textContent = `${isGain ? '+' : '-'}${damageAmount}`;
  floatEl.style.left = `${rect.left + rect.width / 2}px`;
  floatEl.style.top = `${rect.top}px`;

  document.body.appendChild(floatEl);

  setTimeout(() => floatEl.remove(), 1000);
}
```

```css
.floating-number {
  position: fixed;
  font-family: 'Outfit', sans-serif;
  font-weight: 900;
  font-size: 1.6rem;
  pointer-events: none;
  z-index: 1000;
  animation: floatAndFade 1s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.floating-number.damage {
  color: #ef4444;
  text-shadow: 0 0 12px rgba(239, 68, 68, 0.8), 0 2px 4px #000;
}
.floating-number.gain {
  color: #22c55e;
  text-shadow: 0 0 12px rgba(34, 197, 94, 0.8), 0 2px 4px #000;
}

@keyframes floatAndFade {
  0% { opacity: 1; transform: translateY(0) scale(1); }
  50% { transform: translateY(-30px) scale(1.3); }
  100% { opacity: 0; transform: translateY(-50px) scale(0.9); }
}
```

## 🔮 Live MTG Stack Overlay

```html
<div id="arena-stack-overlay">
  <div class="stack-title-badge">⚡ MTG Stack (<span id="stack-count">0</span> Spells)</div>
  <div class="stack-cards-container" id="stack-cards-container">
    <!-- Rendered dynamically -->
  </div>
  <button class="arena-btn arena-btn-magical" onclick="Arena.resolveTopOfStack()">Resolve Top Spell</button>
</div>
```
