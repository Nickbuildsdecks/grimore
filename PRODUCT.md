# Product

## Register

product

## Users

Magic: The Gathering Commander players. They use Grimore at home on a laptop while brewing decks, and on a phone at the kitchen table or game store between games: checking prices, tuning lists, tracking life totals mid-game, and registering for league events. Ambient light is usually low (evening play sessions), attention is split between the app and physical cards.

## Product Purpose

Grimore is a premium all-in-one MTG suite: deck building, card search, collection tracking, community deck discovery, tournament/league events, and a tabletop life tracker. It competes with Moxfield/Archidekt on function but wins on feel: it should feel like a AAA game client, not a database frontend. Success = players prefer opening Grimore to any other deck tool, on both desktop and phone.

## Brand Personality

Arcane, premium, tactile. The original Grimore identity pairs obsidian darkness with electric violet and magenta magic, cyber-gold sparks, animated runes, and card-forward game-client immersion. Work surfaces such as search and builder stay fast and dense underneath the atmosphere.

## Anti-references

- Generic blue SaaS dashboards or fantasy parchment themes that dilute the violet-and-gold Grimore identity.
- Generic SaaS dashboards: white cards, blue buttons, hero-metric tiles.
- Moxfield's utilitarian spreadsheet feel: functional but atmosphere-free.
- Fantasy kitsch: parchment textures, illuminated-manuscript pastiche, Cinzel-style Roman small caps everywhere.

## Design Principles

1. **Casual Commander First (Initial Optics)**. The vast majority of the MTG playerbase plays casual Commander. Initial optics, deck cards, card search, community feeds, and visual deck building are kept clean, approachable, and welcoming—never overwhelming users with dense numbers or intimidating data screens.
2. **Deep Customizability ("The Goodies")**. High-power features (Scryfall query builders, custom category rules, batch repricing, tournament pairing engines, collection trade tools) live inside clean sub-menus, drawers, and settings modals—rewarding serious players who love clicking in to find the goodies.
3. **Card art is the hero.** The UI is a dark stage; Magic's art provides the color. Chrome recedes, art glows.
4. **Cinematic shell, instrument core.** Home, discover, and life tracker can be theatrical; search and the builder are precision tools with dense, calm chrome.
5. **One vocabulary everywhere.** Same buttons, same inputs, same icons (SVG, never emoji) across all surfaces and breakpoints.
6. **The phone is a first-class table companion.** Bottom-thumb navigation, 44px+ targets, safe areas, and mid-game glanceability. Mobile is not a shrunken desktop.
7. **Motion conveys state.** 150–250ms ease-out for feedback; longer choreography reserved for true moments (opening a deck, joining an event).

## Accessibility & Inclusion

- WCAG AA contrast on all text over the dark base; never rely on color alone for win/loss or mana identity.
- Full keyboard access on desktop (search, builder actions); visible focus rings.
- `prefers-reduced-motion` respected: atmosphere and parallax degrade to static.
- Touch targets ≥ 44px on mobile; life tracker usable with the phone flat on a table (mirrored controls for opponents).
