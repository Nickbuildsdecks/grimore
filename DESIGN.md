# Design

Identity: **the mythic grimoire.** Obsidian darkness, electric violet and magenta magic, with cyber-gold sparks and restrained cobalt accents. Card art supplies additional saturation while the chrome preserves the original Grimore identity.

## Theme

Dark only. Scene: a Commander player at a dim table surrounded by animated arcane runes, with violet magic and gold interaction cues framing real card art.

## Color palette

Neutrals:

- `--bg-dark: #050508` — page base
- `--bg-card: rgba(8, 8, 12, 0.85)` — card/panel base
- `--bg-surface: rgba(18, 19, 30, 0.7)` — slate glass
- `--bg-surface-hover: rgba(30, 31, 48, 0.9)`
- `--text-pure: #ffffff`; `--text-high: #f8fafc`; `--text-medium: #c084fc`; `--text-muted: #a9b2c3`

Electric violet (primary — actions, selection, arcane identity):

- `--color-primary: #a855f7`
- Magenta endpoint: `#ec4899`
- Glows: `rgba(168, 85, 247, 0.2–0.45)`

Cyber gold (secondary — highlights, values, sparks):

- `--color-secondary: #f59e0b`; deep `#d97706`; bright `#fbbf24`
- Cobalt `#2563eb` is reserved for tertiary information accents.

Semantic: win `#10b981`, loss `#ef4444` (existing, keep). Never color-only.

Borders: `rgba(255, 255, 255, 0.10)` structural; `rgba(168, 85, 247, 0.30)` emphasis; `rgba(245, 158, 11, 0.45)` gold emphasis.

## Typography

- **Display**: Fraunces (600–700, tight tracking) for page titles and cinematic headlines only. Replaces Cinzel. Never in buttons, labels, or data.
- **UI/body**: Outfit (400–800), the workhorse everywhere.
- **Mono**: Fira Code for syntax hints and prices where tabular.
- Scale ratio ~1.2 in work surfaces; hero display sizes allowed on shell surfaces (home, discover, login).

## Components

- Buttons: violet solid (primary), gold or slate secondary, ghost tertiary. Radius 12px. All states: hover, violet focus-visible ring, active press, and a clear disabled state.
- Icons: inline SVG only (24px grid, 1.75px stroke). Emoji glyphs in UI are banned.
- Inputs: dark glass field, neutral border, violet focus ring; 52px height in command bars, 44px minimum on mobile.
- Cards (MTG): the one place for spectacle — hover tilt/glow desktop, press-scale mobile.

## Layout

- Desktop: icon rail (expands on hover) + full-bleed content stage.
- Mobile: bottom tab bar (5 tabs: Decks, Search, Events, Life, Collections), safe-area aware, 64px tall + inset; page chrome collapses to a compact top bar.
- Density: shell surfaces get cinematic whitespace; search/builder run dense.

## Motion

- 150–250ms, ease-out (cubic-bezier(0.22, 1, 0.36, 1)) for state feedback.
- Longer (400–600ms) choreography only for true moments: opening a deck, life-tracker events.
- `prefers-reduced-motion`: kill parallax/ambient drift, keep instant state changes.
