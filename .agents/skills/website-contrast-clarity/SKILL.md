---
name: website-contrast-clarity
description: Guidelines for ensuring high contrast, website clarity, readability, and accessible button/text styling across all user interfaces.
---

# Website Contrast & Clarity Guidelines

This skill provides comprehensive instructions on design standards to maximize readability, visual contrast, and interface clarity. It ensures that text, buttons, alerts, and interactive elements stand out clearly on dark and light backgrounds alike, meeting accessibility standards (WCAG 2.1 AA/AAA).

## 1. Color Contrast Standards
To guarantee text is easily readable for all users, enforce the following contrast rules against its background container:
* **Normal Body Text (<18px / 14pt bold)**: Minimum contrast ratio of **4.5:1** (WCAG AA). For premium high-clarity, aim for **7:1** (WCAG AAA).
* **Large Text (>=18px or >=14px bold)**: Minimum contrast ratio of **3:1** (WCAG AA). For premium contrast, aim for **4.5:1** (WCAG AAA).
* **Interactive Elements / UI States**: All buttons, links, search fields, and checkboxes must maintain a minimum contrast of **3:1** against adjacent background colors.
* **Prohibited Contrast Combinations**:
  * Low-contrast grey text on a dark background (e.g., `#666` or `#777` on a `#111` panel).
  * Low-contrast purple text on a dark violet background.
  * Direct red/green background overlays without a high-contrast borders or bright font weights.

## 2. Button Design & Readability
Buttons must look like interactive elements and be instantly legible.
* **Clear Labels**: Button text must use high-contrast color values. For example, on a dark primary button (`var(--color-primary)` / purple), use pure white (`#ffffff`) or gold (`var(--color-gold)`) text, never mid-tone greys.
* **Semantic Colors with High Contrast**:
  * **Success Actions**: Dark green backgrounds must use bright white text, or light green borders must enclose high-contrast green text.
  * **Danger/Delete Actions**: Bright red or crimson text/borders with solid high-contrast borders.
  * **Warning Actions**: Amber/Gold backgrounds with black or dark grey text, or gold borders with gold text.
* **Visual States**:
  * **Hover state**: Transition button background color or scale slightly, maintaining contrast.
  * **Focus/Active state**: Apply a glowing ring border (e.g., `outline: 2px solid var(--color-primary); outline-offset: 2px`).
  * **Disabled state**: Shift button opacity to `0.5` or `0.6` and change cursor to `not-allowed`.
* **Tap Targets**: Buttons must have a minimum size of `44px x 44px` on mobile (tap area), with inner button heights of at least `28px` on compact screens and `36px` on desktop.

## 3. Typography & Hierarchy
* **Font Weight & Styling**: Use clean sans-serif families (like `Outfit`, `Inter`, `system-ui`) with solid font weights (`600` or `700`) for navigation elements and button labels.
* **Line Height**: Maintain a line-height of `1.4` to `1.6` for text blocks to prevent overlapping lines.
* **Letter Spacing**: Use slightly wider letter-spacing (`0.02em` to `0.05em`) on uppercase buttons and subheadings to improve legibility.

## 4. Spacing, Borders, and Glassmorphism
* **Safety Buffers**: Place critical buttons (like "Delete") at a safe distance from frequently tapped buttons (like "+") to prevent accidental triggers.
* **Borders & Dividers**: When using dark cards/panels, separate sections with a subtle but visible border (e.g., `1px solid rgba(255, 255, 255, 0.08)` or `rgba(168, 85, 247, 0.15)`).
* **Glassmorphic Backdrops**: If using `backdrop-filter: blur()`, ensure the container background opacity is at least `0.8` to `0.9` if text is positioned over a busy canvas or dynamic background animation.
