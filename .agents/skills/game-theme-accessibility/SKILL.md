---
name: game-theme-accessibility
description: WCAG 2.1 AAA high-contrast accessibility standards, colorblind mode filters (Protanopia, Deuteranopia, Tritanopia), font scaling, and accessible gaming UI patterns for Grimore. Make sure to use this skill whenever building colorblind modes, high-contrast themes, font scaling, or accessibility controls.
---

# Game UI Theme & Accessibility Engine

Guidelines and CSS filter matrix rules for accessible gaming interfaces and colorblind options.

## 👁️ Colorblind Filter Matrices

```css
/* Protanopia (Red-Blind) Filter */
body.cb-protanopia {
  filter: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><filter id="protanopia"><feColorMatrix type="matrix" values="0.56667, 0.43333, 0.00000, 0, 0  0.55833, 0.44167, 0.00000, 0, 0  0.00000, 0.24167, 0.75833, 0, 0  0, 0, 0, 1, 0"/></filter></svg>#protanopia');
}

/* Deuteranopia (Green-Blind) Filter */
body.cb-deuteranopia {
  filter: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><filter id="deuteranopia"><feColorMatrix type="matrix" values="0.625, 0.375, 0.000, 0, 0  0.700, 0.300, 0.000, 0, 0  0.000, 0.300, 0.700, 0, 0  0, 0, 0, 1, 0"/></filter></svg>#deuteranopia');
}
```

## 🎯 Contrast Ratios & Legibility
1. **Minimum Contrast**: Ensure body text against dark obsidian background exceeds 7:1 contrast ratio (`#ffffff` or `#f8fafc` on `#080c16`).
2. **Text Outline & Shadows**: Apply `text-shadow: 0 1px 3px rgba(0,0,0,0.9)` on all floating HUD labels.
