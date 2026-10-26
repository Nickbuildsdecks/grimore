/**
 * A deck somebody pasted in, turned into cards this table can deal.
 *
 * `parseDecklist` in `@grimore/shared` reads the text into counts and names and knows nothing about
 * cards; this is the other half, and it is here because the *pool* lives here. Every name is looked
 * up in the eleven starter decks: a hit is the real card, with its script, its mana cost and its
 * type line, and plays exactly as it does in the deck it came from. A miss is **cardboard** — a
 * card with a name and nothing else, which is what a kitchen table is: you move it by hand and you
 * read it off the card in your hand.
 *
 * Both halves of that matter. A list that happens to be built out of the pool is fully automated,
 * which is the good case and the one worth having. A list that is not can still be played, on the
 * tabletop, which is how two people play Magic with their own decks — and `auto:start` refuses such
 * a table rather than dealing an Arena game full of blank cards. See `deckIsAutomatable`.
 */
import type { CardDef, DeckSpec } from './cards.js';
import { STARTER_DECKS } from './starterDecks.js';

/** One line of a pasted list. Mirrors `DecklistEntry` in `@grimore/shared` without importing it. */
export interface CustomDeckEntry {
  readonly name: string;
  readonly count: number;
}

export interface CustomDeckInput {
  /** The id the table loads it by. */
  readonly id: string;
  readonly name: string;
  readonly entries: readonly CustomDeckEntry[];
  /** A name to put in the command zone, when the list named one. */
  readonly commander?: string;
}

export interface CustomDeckResult {
  readonly deck: DeckSpec;
  /** The names the pool does not have, in the spelling the list used, for the table to say so. */
  readonly unknown: readonly string[];
}

/**
 * Every card in the pool, by lower-cased name.
 *
 * Built once from `STARTER_DECKS` — which is where every card in this engine already lives, decks
 * and commanders both — rather than kept as a second list. A registry maintained by hand would be
 * two hundred and twenty-five names to keep in step with the first, and the thing it would buy is
 * exactly this lookup.
 */
let index: Map<string, CardDef> | null = null;

function poolIndex(): Map<string, CardDef> {
  if (index !== null) return index;
  const built = new Map<string, CardDef>();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) built.set(entry.card.name.trim().toLowerCase(), entry.card);
    if (deck.commander) built.set(deck.commander.name.trim().toLowerCase(), deck.commander);
  }
  index = built;
  return built;
}

/** The card the pool has under that name, or undefined. Case and surrounding space do not matter. */
export function poolCardNamed(name: string): CardDef | undefined {
  return poolIndex().get(name.trim().toLowerCase());
}

/**
 * A card with a name and nothing else: what a pasted name the pool does not have becomes.
 *
 * The empty type line is the marker, and it is read by `deckIsAutomatable`. It is empty rather than
 * "Card" on purpose: a type line the engine invented would make this card look like something it
 * can reason about, and the whole point is that it cannot.
 */
function cardboard(name: string): CardDef {
  return {
    name,
    typeLine: '',
    manaCost: '',
    cmc: 0,
    oracleText: 'This card is not in the engine’s pool. Move it by hand.',
    colors: [],
  };
}

/** Builds a deck out of a pasted list, and says which of its names the pool did not have. */
export function customDeck(input: CustomDeckInput): CustomDeckResult {
  const unknown: string[] = [];
  const cards = input.entries.map((entry) => {
    const found = poolCardNamed(entry.name);
    if (found === undefined) unknown.push(entry.name);
    return { card: found ?? cardboard(entry.name), count: entry.count };
  });
  const commanderCard = input.commander === undefined ? undefined : poolCardNamed(input.commander);
  if (input.commander !== undefined && commanderCard === undefined) unknown.push(input.commander);
  return {
    deck: {
      id: input.id,
      name: input.name,
      description: 'A list somebody pasted in.',
      ...(input.commander === undefined
        ? {}
        : { commander: commanderCard ?? cardboard(input.commander) }),
      cards,
    },
    unknown,
  };
}

/**
 * Whether every card in a deck is one the engine can actually play.
 *
 * The question the Arena table has to ask before it deals: a card with no type line is not a land,
 * not a creature and not a spell, so an automated game containing one is a game with a card nobody
 * — engine or player — can do anything with. The tabletop has no such problem, which is why this is
 * a check at the point the engine is started rather than at the point the deck is loaded.
 */
export function deckIsAutomatable(deck: DeckSpec): boolean {
  if (deck.commander !== undefined && deck.commander.typeLine.trim().length === 0) return false;
  return deck.cards.every((entry) => entry.card.typeLine.trim().length > 0);
}
