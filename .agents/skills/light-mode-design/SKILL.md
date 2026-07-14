---
name: light-mode-design
description: Guidelines and best practices for developing premium light mode interfaces, color palettes, and contrast ratios in web applications.
---

# Light Mode Design & Development Skill

This skill provides guidelines and color system requirements for designing premium, high-contrast, yet visually comfortable light mode interfaces.

## 1. Core Principles
- **Lighter, Not Glaring**: Avoid blinding white backgrounds (`#ffffff` everywhere). Instead, use soft warm/cool greys or subtle tans/almond tones (`#f1f5f9`, `#f5f5f4`, `#eae6f3`) for the main canvas.
- **Card Starkness**: Use clean, crisp, near-white panels (`rgba(255, 255, 255, 0.92)` or `#fbfbfb`) to create clear depth and separation from the base canvas.
- **Vibrant Purple Accents**: Use saturated purple/violet hues (`#7c3aed` for solid buttons, `#8b5cf6` for hover states, `#a78bfa` for borders) to maintain the platform's brand identity.
- **Deep Contrast Typography**: Text must be extremely dark and readable (e.g., `#0f172a`, `#1e1b4b`). Never use light grey text on light backgrounds.
- **Border Definition**: Utilize crisp violet-tinted borders (`rgba(124, 58, 237, 0.15)` or `rgba(168, 85, 247, 0.2)`) to outline cards and inputs.

## 2. Color System Variable Mappings
Implement these color tokens or their HSL equivalents in CSS variables when `.light-theme` is active:

| Token Name | Suggested Value | Purpose |
|------------|-----------------|---------|
| `--bg-base` | `#eae6f3` or `#f3f1f7` | Lighter base background (grey-purple tan) |
| `--bg-panel` | `rgba(255, 255, 255, 0.88)` | Starker card panel background |
| `--border-light` | `rgba(124, 58, 237, 0.18)` | Crisp purple accent border |
| `--text-high` | `#0f172a` (Very dark grey) | Main high-contrast readable text |
| `--text-muted` | `#475569` (Medium slate) | Less prominent descriptive text |
| `--color-primary` | `#7c3aed` | Brand primary color (purple/violet) |

## 3. Interactive Element States
- **Buttons (Primary)**: Solid primary color (`#7c3aed`) with white text.
- **Buttons (Secondary)**: Semi-translucent light violet (`rgba(124, 58, 237, 0.08)`) with purple text and clear borders.
- **Hover Transitions**: Apply smooth transition delays (`all 0.2s ease`) with scale changes (`scale(1.02)`) or subtle shadow changes (`box-shadow: 0 4px 12px rgba(124, 58, 237, 0.15)`).
