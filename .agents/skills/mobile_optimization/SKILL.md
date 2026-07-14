---
name: Mobile Device Optimization
description: Guidelines and instructions for optimizing the Grimore platform for mobile devices and responsive views.
---

# Mobile Device Optimization Skill

This skill provides guidelines and patterns for making the Grimore platform responsive, tactile, and highly optimized for mobile devices (phones and tablets).

## 1. Responsive Layout Patterns

### Media Query Breakpoints
Use standard breakpoints to scale layouts:
- **Mobile (Phones)**: `@media (max-width: 480px)`
- **Tablet / Small Screen**: `@media (max-width: 768px)`

### Flexible and Grid Layouts
- Enforce grid layouts using relative track columns like `repeat(auto-fill, minmax(130px, 1fr))` rather than static pixel widths.
- Implement flex-wrap styles on control rows (`flex-wrap: wrap; gap: 0.5rem;`) so that buttons and dropdowns wrap naturally on narrow screens instead of overflowing horizontally.
- In mobile views, convert multi-column grid layouts (like the 3-panel deck inspector) into a stacked single-column layout using `@media (max-width: 768px) { grid-template-columns: 1fr !important; }`.

## 2. Touch Interactions & Tactility

### Minimum Tap Targets
- Ensure all buttons, links, and dropdowns have a minimum interactive tap target size of **44px x 44px** on mobile screens, or adequate padding to prevent accidental mis-clicks.
- Style controls with larger margins and touch-friendly paddings (`padding: 10px 16px;`) under mobile media queries.

### Gestures & Drawer Menus
- On mobile, collapse sidebars and navigation panels into a slide-out drawer menu, toggled by a top-bar hamburger button or the Grimore logo.
- Disable heavy hover effects (like scale transformations or absolute translate effects) under media queries if they interfere with touch scrolling or tap gestures.

## 3. Responsive Card Grids

### Card Spoilers
- Grid columns should adjust dynamically:
  - Desktop: 10 columns (`repeat(10, minmax(0, 1fr))`)
  - Zoomed Desktop: 5 columns
  - Tablet: 4 or 5 columns
  - Mobile (max-width: 480px): 2 or 3 columns (e.g. `repeat(2, minmax(0, 1fr))` or `repeat(3, minmax(0, 1fr))`) to keep cards legible without overflowing.
- Adjust gap sizes proportionally on smaller screens (`gap: 0.25rem;` on mobile, `gap: 0.5rem;` on desktop).

## 4. Typography & Spacing
- Use relative font sizes (`rem`, `em`, `vw`) for headers to prevent text wrapping into illegible layouts.
- Reduce margins and section paddings (e.g. change dashboard padding from `1.5rem` to `0.5rem` on mobile) to prioritize content space on small screens.
