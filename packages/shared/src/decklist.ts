/**
 * Reading a decklist somebody pasted in.
 *
 * Players keep their decks as text — four lines of "4 Lightning Bolt" from Arena, a Moxfield export
 * with a Commander section, a sideboard nobody asked for — and the Play Realm's one real gap is
 * that it only ever dealt the built-in decks. This turns that text into counts and names; what the
 * table then does with the names is the engine's business (see `customDeck`), and the split matters:
 * **this file knows nothing about cards**, which is what lets the browser preview a list before the
 * server has seen it and the server validate one without trusting the browser.
 *
 * It is deliberately forgiving about format and strict about size. Forgiving, because a player
 * pasting their deck should not have to learn a syntax: counts may be `4`, `4x` or absent, set
 * codes and collector numbers are thrown away, section headers are understood, and a sideboard is
 * dropped with a word about it rather than silently mixed in. Strict, because the text arrives from
 * a client and ends up as one instance per card in a game state that lives in Redis.
 */

/**
 * The deck id a pasted list is loaded under: `custom:0` for the list in seat zero.
 *
 * One naming shared by the page that offers the list, the server that stores it and the engine
 * that deals it, because all three have to agree on what `deck:load` with this id means. It lives
 * here rather than in any of them for the same reason the parser does: it belongs to the protocol.
 *
 * It carries the seat because a rematch reloads **every** seat's deck by the id that seat already
 * has (see `rematch` in the engine). One shared `custom` is enough while each action only ever
 * resolves its own sender's list — and then "play again" at a table where the guest pasted a deck
 * asks for a `custom` the host's action cannot see, and the rematch is refused. Per seat, every
 * list is nameable, and which of them an action may actually reach stays the server's decision.
 */
export const CUSTOM_DECK_PREFIX = 'custom';

/** The id for the list in a seat. */
export function customDeckIdFor(seat: number): string {
  return `${CUSTOM_DECK_PREFIX}:${seat}`;
}

/** Whether a deck id names a pasted list rather than one of the built-in decks. */
export function isCustomDeckId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(`${CUSTOM_DECK_PREFIX}:`);
}

/** One line of a list: how many, and of what. */
export interface DecklistEntry {
  readonly name: string;
  readonly count: number;
}

export interface ParsedDecklist {
  /** The main deck, in the order it was written, with duplicate names merged. */
  readonly entries: readonly DecklistEntry[];
  /** The first card under a `Commander` header, when the list has one. */
  readonly commander?: string;
  /** Total cards in `entries`, which is what a player means by "how big is my deck". */
  readonly total: number;
  /** How many cards were dropped with the sideboard, so the UI can say so rather than lie. */
  readonly sideboard: number;
  /**
   * What is wrong with it, in sentences a player can act on. A list with errors is not loaded:
   * a deck that silently lost half its cards is worse than a deck that was refused.
   */
  readonly errors: readonly string[];
}

/** The limits. Generous for a real deck, small enough that a pasted list cannot be an attack. */
export const DECKLIST_LIMITS = {
  /** Cards in the main deck. A Commander deck is 99 plus the commander; this leaves room to spare. */
  maxCards: 250,
  /** Distinct names, which is what decides how many card definitions a game state carries. */
  maxDistinct: 150,
  /** Per line, because "999 Forest" is a typo at best. */
  maxPerLine: 40,
  /** Lines of text, counted before anything is parsed. */
  maxLines: 400,
  /** A card name, which is longer than any real one (the longest printed card is 59 characters). */
  maxNameLength: 80,
} as const;

/** Section headers a real export writes, and what each one means for the main deck. */
const SECTIONS: Readonly<Record<string, 'main' | 'commander' | 'drop'>> = {
  deck: 'main',
  decklist: 'main',
  main: 'main',
  maindeck: 'main',
  creatures: 'main',
  spells: 'main',
  lands: 'main',
  commander: 'commander',
  commanders: 'commander',
  sideboard: 'drop',
  companion: 'drop',
  maybeboard: 'drop',
  considering: 'drop',
};

/**
 * Strips the parts of a line that name a *printing* rather than a card.
 *
 * Arena writes `4 Lightning Bolt (M10) 146` and Moxfield writes `4 Lightning Bolt [M10]`. Neither
 * says anything this table can use — there are no images and no sets here — and a name with a set
 * code glued to it matches nothing in the pool, so a Lightning Bolt would arrive as cardboard.
 */
function stripPrinting(name: string): string {
  return name
    .replace(/\s*\((?:[A-Za-z0-9]{2,6})\)\s*\d*\s*$/u, '')
    .replace(/\s*\[[^\]]*\]\s*$/u, '')
    .replace(/\s*#\s*\d+\s*$/u, '')
    .trim();
}

/** Whether a line is a header rather than a card, and which section it opens. */
function sectionOf(line: string): 'main' | 'commander' | 'drop' | null {
  const word = line.replace(/[:\s]+$/u, '').trim().toLowerCase();
  if (word.length === 0 || word.includes(' ')) return SECTIONS[word] ?? null;
  return SECTIONS[word] ?? null;
}

/**
 * Parses pasted text into a deck.
 *
 * Never throws: a list this cannot read comes back with `errors`, because the caller is a text box
 * somebody is still typing in.
 */
export function parseDecklist(text: string): ParsedDecklist {
  const errors: string[] = [];
  const lines = (text ?? '').split(/\r?\n/u);
  if (lines.length > DECKLIST_LIMITS.maxLines) {
    return {
      entries: [], total: 0, sideboard: 0,
      errors: [`that is more than ${DECKLIST_LIMITS.maxLines} lines; paste one deck at a time`],
    };
  }

  const merged = new Map<string, number>();
  const order: string[] = [];
  let commander: string | undefined;
  let section: 'main' | 'commander' | 'drop' = 'main';
  let sideboard = 0;
  let total = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // A comment, which Moxfield and a human both write with a hash.
    if (line.startsWith('#') || line.startsWith('//')) continue;

    const header = sectionOf(line);
    if (header !== null) {
      section = header;
      continue;
    }

    const match = /^(?:(\d{1,3})\s*[xX]?\s+)?(.*\S)$/u.exec(line);
    if (match === null) continue;
    const count = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
    const name = stripPrinting(match[2] ?? '');
    if (name.length === 0) continue;
    if (name.length > DECKLIST_LIMITS.maxNameLength) {
      errors.push(`"${name.slice(0, 30)}…" is too long to be a card name`);
      continue;
    }
    if (count < 1 || count > DECKLIST_LIMITS.maxPerLine) {
      errors.push(`${count} copies of ${name} is more than a deck can hold`);
      continue;
    }

    if (section === 'drop') {
      sideboard += count;
      continue;
    }
    if (section === 'commander') {
      // The first card under the header is the commander; anything else there joins the deck,
      // because a list with two legends under one header is a list this cannot adjudicate.
      if (commander === undefined) {
        commander = name;
        continue;
      }
    }

    const key = name.toLowerCase();
    if (!merged.has(key)) {
      if (merged.size >= DECKLIST_LIMITS.maxDistinct) {
        errors.push(`more than ${DECKLIST_LIMITS.maxDistinct} different cards is more than a deck`);
        break;
      }
      order.push(key);
    }
    merged.set(key, (merged.get(key) ?? 0) + count);
    total += count;
    if (total > DECKLIST_LIMITS.maxCards) {
      errors.push(`more than ${DECKLIST_LIMITS.maxCards} cards is more than a deck`);
      break;
    }
  }

  // The name as first written, rather than lower-cased: it is what the table shows on the card.
  const firstSpelling = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.trim();
    const match = /^(?:\d{1,3}\s*[xX]?\s+)?(.*\S)$/u.exec(line);
    const name = match === null ? '' : stripPrinting(match[1] ?? '');
    const key = name.toLowerCase();
    if (name.length > 0 && !firstSpelling.has(key)) firstSpelling.set(key, name);
  }

  const entries = order.map((key) => ({
    name: firstSpelling.get(key) ?? key,
    count: merged.get(key) ?? 0,
  }));

  if (entries.length === 0 && errors.length === 0) {
    errors.push('no cards in that: a line is "4 Lightning Bolt", or just the card name');
  }

  return {
    entries,
    ...(commander === undefined ? {} : { commander }),
    total,
    sideboard,
    errors,
  };
}
