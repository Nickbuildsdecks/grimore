/**
 * Grimore functional auto-tagging engine.
 *
 * Implements `directives/auto_tagging_engine.md`: sort a decklist by what each card DOES, not by its
 * card type. Pure functions over `{ name, typeLine, oracleText }` — no database, no network — so the
 * whole rule set is unit-testable, which is what the legacy implementation (166 lines inline in
 * server.js, reachable only through an HTTP route against a live deck) was not.
 *
 * ## Precedence
 *
 * Core functional roles always outrank secondary archetypes. Several pairs are mutually exclusive by
 * directive, and those exclusions are applied AFTER matching rather than being baked into each rule:
 *
 *  - Mass Removal wins over Single Target Removal — a board wipe is never spot removal.
 *  - Reanimation wins over Blink & ETB — returning from the graveyard is not blinking.
 *  - Fetch lands are Lands only, never Utility Lands and never Tutors.
 *  - Lands are never Ramp; ramp is acceleration ahead of the curve.
 *  - `Unique` survives only when nothing else matched.
 *
 * `Counters & Triggers` and `Artifact Engine` are deliberately absent: CLAUDE.md removed them, and
 * the directive's mention of them predates that.
 */
import { INFINITE_COMBOS } from './combos.js';
import {
  BASIC_LANDS, CARD_SELECTION, FETCH_LANDS, MASS_REMOVAL, norm, REANIMATION,
  SELF_PROTECTING_THREATS, UTILITY_LANDS,
} from './cards.js';

export * from './combos.js';
export { norm } from './cards.js';

/** Ordered by display precedence: the first tag a card earns is the header it files under. */
export const CATEGORIES = [
  'Wincons / Finishers',
  'Tutors',
  'Stax',
  'Mass Removal',
  'Single Target Removal',
  'Protection',
  'Ramp',
  'Card Advantage',
  'Card Selection',
  'Recursion',
  'Reanimation',
  'Graveyard Fillers',
  'Sacrifice Outlets',
  'Blink & ETB',
  'Utility Lands',
  'Lands',
  'Unique',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CardInput {
  name: string;
  typeLine?: string | null;
  oracleText?: string | null;
}

const has = (text: string, ...needles: string[]): boolean => needles.some((n) => text.includes(n));
/**
 * Oracle text varies the same effect across person and number -- "each player can't cast" vs
 * "players can't cast", "draw cards" vs "draws cards". Matching fixed substrings misses half of
 * them, so the rules that care use patterns.
 */
const matches = (text: string, ...patterns: RegExp[]): boolean => patterns.some((p) => p.test(text));

/**
 * The functional role(s) of one card, ignoring combos.
 *
 * `oracleText` is frequently missing — the local card table has gaps — so every rule that can be
 * decided from the name or type line alone is checked first. A card with no text and no name match
 * lands in `Unique` rather than being guessed at.
 */
export function classifyCard(card: CardInput): Category[] {
  const key = norm(card.name);
  const type = (card.typeLine ?? '').toLowerCase();
  const text = (card.oracleText ?? '').toLowerCase();
  const tags = new Set<Category>();

  const isLand = type.includes('land') || BASIC_LANDS.has(key) || FETCH_LANDS.has(key);

  // ── Lands first: their text would otherwise misfile them ───────────────────────────────────────
  if (isLand) {
    // A fetch land says "search your library", which would make it a Tutor. The directive says
    // fetch lands are Lands, full stop.
    if (FETCH_LANDS.has(key) || BASIC_LANDS.has(key)) {
      tags.add('Lands');
      return [...tags];
    }
    if (UTILITY_LANDS.has(key)) {
      tags.add('Utility Lands');
      // Urza's Saga tutors as well as being a utility land — the directive names it as both.
      if (has(text, 'search your library')) tags.add('Tutors');
      return [...tags];
    }
    // A non-basic land with a non-mana ability is utility; anything else is just mana.
    const nonManaAbility = has(text, 'draw a card', 'destroy target', 'exile target', 'no maximum hand size',
      "can't be blocked", 'exile all cards from', 'sacrifice a creature', 'prevent all combat damage');
    tags.add(nonManaAbility ? 'Utility Lands' : 'Lands');
    return [...tags];
  }

  // ── Wincons ────────────────────────────────────────────────────────────────────────────────────
  if (has(text, 'you win the game', 'loses the game', 'take an extra turn', 'wins the game')) {
    tags.add('Wincons / Finishers');
  }
  // Self-protecting fatties are Wincons only — never team Protection (directive is explicit).
  if (SELF_PROTECTING_THREATS.has(key)) tags.add('Wincons / Finishers');

  // ── Tutors ─────────────────────────────────────────────────────────────────────────────────────
  if (has(text, 'search your library')) tags.add('Tutors');

  // ── Stax ───────────────────────────────────────────────────────────────────────────────────────
  if (has(text, 'spells cost', "can't untap", 'unless that player pays', 'skip your', 'each opponent sacrifices') ||
      // "each player can't", "players can't", "opponents can't" -- same effect, three spellings.
      matches(text, /\b(each )?(player|players|opponent|opponents) can't\b/, /\bcan't be cast\b/)) {
    tags.add('Stax');
  }

  // ── Removal ────────────────────────────────────────────────────────────────────────────────────
  const massRemoval = MASS_REMOVAL.has(key) ||
    has(text, 'destroy all', 'exile all', 'destroys all', 'each creature gets -', 'all creatures get -',
      'return all', 'sacrifices all');
  if (massRemoval) tags.add('Mass Removal');
  if (has(text, 'destroy target', 'exile target', 'counter target spell', 'target creature gets -',
    "target player sacrifices", 'deals damage to target creature')) {
    tags.add('Single Target Removal');
  }

  // ── Protection ─────────────────────────────────────────────────────────────────────────────────
  if (!SELF_PROTECTING_THREATS.has(key) &&
      has(text, 'hexproof', 'indestructible', 'protection from', 'shroud', 'phase out', 'prevent all damage')) {
    // "Target creature you control gains ..." protects the board; "this creature has ..." protects itself.
    const protectsOthers = has(text, 'creatures you control', 'target creature you control', 'you control gain',
      'permanents you control', 'you gain protection', 'other creatures');
    const selfOnly = /^(this|~|[a-z' ,-]+) (has|gains) (hexproof|indestructible|shroud)/.test(text);
    if (protectsOthers || !selfOnly) tags.add('Protection');
  }

  // ── Ramp ───────────────────────────────────────────────────────────────────────────────────────
  // Lands already returned above, so nothing here can tag a land as Ramp.
  if (has(text, 'add {', 'adds {', 'search your library for a basic land', 'put a land card',
    'play an additional land', 'additional land')) {
    tags.add('Ramp');
  }

  // ── Card advantage vs selection ────────────────────────────────────────────────────────────────
  if (CARD_SELECTION.has(key) || has(text, 'scry', 'surveil', 'look at the top', 'discard a card, then draw',
    'draw a card, then discard')) {
    tags.add('Card Selection');
  }
  if (!CARD_SELECTION.has(key) &&
      // "draw a card", "draws two cards", "draw cards" -- one pattern instead of six substrings.
      (matches(text, /\bdraws? (a card|cards|\w+ cards?)\b/) || has(text, 'each opponent discards'))) {
    tags.add('Card Advantage');
  }

  // ── Graveyard ──────────────────────────────────────────────────────────────────────────────────
  if (REANIMATION.has(key) ||
      has(text, 'return target creature card from your graveyard to the battlefield',
        'return target creature card from a graveyard to the battlefield',
        'put target creature card from a graveyard onto the battlefield')) {
    tags.add('Reanimation');
  }
  if (has(text, 'return target card from your graveyard to your hand',
    'return target creature card from your graveyard to your hand',
    'return up to', 'from your graveyard to your hand')) {
    tags.add('Recursion');
  }
  if (has(text, 'mill', 'put the top', 'into your graveyard')) tags.add('Graveyard Fillers');

  // ── Sacrifice outlets ──────────────────────────────────────────────────────────────────────────
  if (has(text, 'sacrifice a creature:', 'sacrifice another creature', 'sacrifice a permanent:',
    ', sacrifice')) {
    tags.add('Sacrifice Outlets');
  }

  // ── Blink ──────────────────────────────────────────────────────────────────────────────────────
  if (has(text, 'exile target creature you control, then return', 'exile it, then return',
    'exile them, then return', 'flicker')) {
    tags.add('Blink & ETB');
  }

  return applyExclusions(tags);
}

/**
 * Mutually exclusive pairs, resolved after matching. Doing this here rather than inside each rule
 * keeps the rules readable and makes the directive's precedence claims checkable in one place.
 */
function applyExclusions(tags: Set<Category>): Category[] {
  // A board wipe is never spot removal.
  if (tags.has('Mass Removal')) tags.delete('Single Target Removal');
  // Returning from the graveyard is not blinking.
  if (tags.has('Reanimation')) tags.delete('Blink & ETB');
  // A card that nets cards is Card Advantage even if it also filters.
  if (tags.has('Card Advantage') && tags.has('Card Selection')) tags.delete('Card Selection');

  const ordered = CATEGORIES.filter((c) => tags.has(c));
  // `Unique` applies only when nothing else did.
  return ordered.length ? ordered : ['Unique'];
}

/**
 * Which combo headers each card in the list belongs to. A combo contributes nothing unless EVERY
 * one of its pieces is present, so half a combo produces no header.
 */
export function detectCombos(deckCardNames: readonly string[]): Map<string, string[]> {
  const present = new Set(deckCardNames.map(norm));
  const byCard = new Map<string, string[]>();
  for (const combo of INFINITE_COMBOS) {
    if (!combo.cards.every((c) => present.has(norm(c)))) continue;
    for (const piece of combo.cards) {
      const key = norm(piece);
      const list = byCard.get(key) ?? [];
      if (!list.includes(combo.name)) list.push(combo.name);
      byCard.set(key, list);
    }
  }
  return byCard;
}

export interface TaggedCard {
  name: string;
  tags: string[];
}

/**
 * Tags a whole decklist. Combo headers lead, because a card that is half of an infinite combo should
 * file under the combo rather than under "Ramp".
 */
export function tagDeck(cards: readonly CardInput[]): TaggedCard[] {
  const combos = detectCombos(cards.map((c) => c.name));
  return cards.map((card) => {
    const comboTags = combos.get(norm(card.name)) ?? [];
    const functional = classifyCard(card);
    // `Unique` means "nothing matched"; a combo piece has matched something.
    const roles = comboTags.length && functional.length === 1 && functional[0] === 'Unique' ? [] : functional;
    return { name: card.name, tags: [...comboTags, ...roles] };
  });
}
