/**
 * A deck somebody pasted in, turned into cards this table can deal.
 *
 * `parseDecklist` in `@grimore/shared` reads the text into counts and names and knows nothing about
 * cards; this is the other half, and it is here because the *pool* lives here. Every name is looked
 * up in the starter decks: a hit is the real card, with its script, its mana cost and its
 * type line, and plays exactly as it does in the deck it came from. A miss is **cardboard** — a
 * card with a name and nothing else, which is what a kitchen table is: you move it by hand and you
 * read it off the card in your hand.
 *
 * Both halves of that matter. A list that happens to be built out of the pool is fully automated,
 * which is the good case and the one worth having. A list that is not can still be played, on the
 * tabletop, which is how two people play Magic with their own decks — and `auto:start` refuses such
 * a table rather than dealing an Arena game full of blank cards. See `deckIsAutomatable`.
 *
 * ## The middle case: a card nobody scripted whose data is its rules
 *
 * There is now a third answer between those two, and `data` is how a caller supplies it. A Grizzly
 * Bears needs no code — it is a 2/2 — and a Forest needs only the mana ability its subtype grants
 * it (CR 305.6). `fromCardData.ts` decides which cards qualify, conservatively and with a reason
 * for every refusal; this file decides the **order**, which is the only judgement it adds:
 *
 *   1. the pool, by name — a hand-written script is always the best answer available;
 *   2. the data, if the caller passed any — for the cards whose rules their data already is;
 *   3. cardboard — unchanged, and still the right answer for a card whose text is a paragraph.
 *
 * `data` is optional and defaults to nothing, so every existing caller behaves exactly as before.
 * It is passed in rather than looked up because this module is pure and the card table is not: the
 * three callers in `apps/realtime` run inside a synchronous compare-and-set write where no query
 * can happen, so the rows have to arrive as data or not at all.
 */
import type { CardDef, DeckSpec } from './cards.js';
import { STARTER_DECKS } from './starterDecks.js';
import { type CardDataRow } from './fromCardData.js';
import { compileCard } from './compile.js';

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
  /**
   * A second commander (D640), when the list named two under its commander header. Kept only if the
   * pair is legal (`partnersLegally`); otherwise it joins the deck, as every second name under that
   * header did before, and `partnerRefused` says why.
   */
  readonly partner?: string;
  /**
   * Card rows for names the pool does not have, from whatever holds the card table.
   *
   * Matched by name, case- and space-insensitively, the same way the pool is. A row the derivation
   * refuses is as good as a row that was never supplied: that card is cardboard, which is what it
   * would have been anyway.
   */
  readonly data?: readonly CardDataRow[];
}

export interface CustomDeckResult {
  readonly deck: DeckSpec;
  /** Why a named second commander was put in the deck instead (D640), when it was. */
  readonly partnerRefused?: string;
  /**
   * The names that ended up as cardboard, in the spelling the list used, for the table to say so.
   *
   * **Not "the names the pool does not have"** any more, which is what it used to be and what its
   * old comment said. With `data` supplied, a name the pool lacks may still be playable, and a
   * table told otherwise would refuse to deal an Arena game it could have dealt. This is the list
   * of names nothing could make playable, which is the question every reader was actually asking.
   */
  readonly unknown: readonly string[];
  /**
   * Names the pool did not have and the data did: what the card table bought this list.
   *
   * Reported separately because the two numbers answer different questions. `unknown` is "can this
   * table be played by the rules engine"; this is "how much of that is the import rather than the
   * 348 hand-written cards", which is the only way to tell a card sync that worked from one that
   * silently wrote nothing.
   */
  readonly fromData: readonly string[];
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
    if (deck.partner) built.set(deck.partner.name.trim().toLowerCase(), deck.partner);
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

/** Builds a deck out of a pasted list, and says which of its names nothing could make playable. */
export function customDeck(input: CustomDeckInput): CustomDeckResult {
  const unknown: string[] = [];
  const fromData: string[] = [];

  /*
    The supplied rows, by lower-cased name, built once rather than scanned per entry: a 100-card
    list against a few hundred rows is the shape a caller handing over a whole collection would
    produce, and that is 30,000 string comparisons for no reason.
  */
  const rows = new Map<string, CardDataRow>();
  for (const row of input.data ?? []) {
    const key = (row.name ?? '').trim().toLowerCase();
    if (key !== '') rows.set(key, row);
    /*
      And under its front face, for a two-faced card (D591): Scryfall names it "Akoum Warrior //
      Akoum Teeth" and a list says "Akoum Warrior". The full name keeps its own entry, so a list
      that writes both faces finds it too; a name already taken by a card of its own is not
      overwritten.
    */
    const front = key.split(' // ')[0]!.trim();
    if (front !== key && front !== '' && !rows.has(front)) rows.set(front, row);
  }

  /**
   * The best card available under that name: the pool, then the data, then cardboard.
   *
   * ## The data step asks `compileCard`, not `cardFromData` (D430)
   *
   * It used to ask `cardFromData`, which is the **whole-card** derivation: all-or-nothing by
   * design, because its job is to decide whether a card's data *is* its rules. A card it refuses
   * became cardboard — a blank def with an empty type line and "Move it by hand" for text.
   *
   * That was right when it was written and became wrong the moment the oracle-text compiler
   * existed, and `corpus-decks.mjs` is what said so: of 60 random real cards, **34 were cardboard**
   * — not because nothing could read them, but because nothing asked. The compiler reads 27.2% of
   * all printed lines and 7,126 cards have a script, and an uploaded deck saw none of it, because the
   * card was replaced by a blank *before the engine ever looked at it*. A blank def can never be
   * scripted: `scriptForCard` is handed a card with no name the registry knows, no type line and no
   * text.
   *
   * So this asks `compileCard`, which is the same function `derive.ts` uses at play time, and keeps
   * its `def` — the **printed** card. What happens next is already built and is exactly D362's
   * hybrid automation: `scriptForCard` gives that def the hand-written script if there is one, the
   * whole-card derivation if it reads everything, or the partial script the compiler built; and
   * `unreadLines` names whatever is left so the table can flag it for a human (D363's badge).
   *
   * Cardboard is still the right answer, and still reached, for a row `compileCard` refuses: no type
   * line at all, a layout with more than one face, or — D431 — a creature whose printed size is a
   * `*` that nothing read, which would arrive as a 0/0 and be binned by CR 704.5f before anybody
   * could apply a thing by hand. Those are cards the engine cannot be dealt at all rather than
   * cards it plays imperfectly, and they are 0.3 of a 60-card deck of random real cards.
   *
   * **Why a partial card is strictly better than a blank one.** Cardboard cannot be cast: no cost,
   * no type line, nothing. A printed def with a partial script is cast for its real cost, does the
   * part that was read, and says which line it did not — which is the difference between a deck
   * somebody can play with a few manual steps and a deck of 34 cards nobody can touch.
   */
  const resolve = (name: string): CardDef => {
    const pooled = poolCardNamed(name);
    if (pooled !== undefined) return pooled;
    const row = rows.get(name.trim().toLowerCase());
    if (row !== undefined) {
      const compiled = compileCard(row);
      if (compiled.ok) {
        fromData.push(name);
        return compiled.def;
      }
    }
    unknown.push(name);
    return cardboard(name);
  };

  const cards = input.entries.map((entry) => ({
    card: resolve(entry.name),
    count: entry.count,
  }));
  const commanderCard = input.commander === undefined ? undefined : resolve(input.commander);
  const partnerCard = input.partner === undefined ? undefined : resolve(input.partner);
  const refused = partnerCard === undefined ? null
    : commanderCard === undefined ? 'there is no first commander to partner with'
      : partnersLegally(commanderCard, partnerCard);
  const keptPartner = partnerCard !== undefined && refused === null ? partnerCard : undefined;
  return {
    deck: {
      id: input.id,
      name: input.name,
      description: 'A list somebody pasted in.',
      ...(commanderCard === undefined ? {} : { commander: commanderCard }),
      ...(keptPartner === undefined ? {} : { partner: keptPartner }),
      cards: partnerCard !== undefined && keptPartner === undefined ? [...cards, { card: partnerCard, count: 1 }] : cards,
    },
    ...(partnerCard !== undefined && refused !== null ? { partnerRefused: refused } : {}),
    unknown,
    fromData,
  };
}

/**
 * Whether two cards may be a deck's two commanders (D640, CR 702.124), read off their printed text,
 * or the reason they may not.
 *
 * - Both print **Partner** on its own (CR 702.124c).
 * - **"Partner with X"**, each naming the other (CR 702.124j).
 * - The same **"Partner—<kind>"** on both: Friends forever, Character select, Survivors (CR 702.124f
 *   and the later variants, which pair only with their own kind).
 * - **"Choose a Background"** with a Legendary Enchantment — Background (CR 702.124k).
 * - **"Doctor's companion"** with a Time Lord Doctor (CR 702.124m).
 */
export function partnersLegally(a: CardDef, b: CardDef): string | null {
  const lines = (card: CardDef) => (card.oracleText ?? '').split('\n').map((line) => line.replace(/\s*\(.*\)\s*$/, '').trim());
  const has = (card: CardDef, test: (line: string) => boolean) => lines(card).some(test);
  const bare = (line: string) => /^Partner$/i.test(line);
  if (has(a, bare) && has(b, bare)) return null;
  const withName = (card: CardDef, other: CardDef) => has(card, (line) => line.toLowerCase() === `partner with ${other.name.toLowerCase()}`);
  if (withName(a, b) && withName(b, a)) return null;
  const kind = (card: CardDef) => lines(card).map((line) => /^Partner[—–-]\s*(.+)$/i.exec(line)?.[1]?.toLowerCase()).find((k) => k !== undefined);
  if (kind(a) !== undefined && kind(a) === kind(b)) return null;
  const background = (card: CardDef) => /\bBackground\b/.test(card.typeLine ?? '');
  const chooses = (card: CardDef) => has(card, (line) => /^Choose a Background$/i.test(line));
  if ((chooses(a) && background(b)) || (chooses(b) && background(a))) return null;
  const doctor = (card: CardDef) => /\bTime Lord\b/.test(card.typeLine ?? '') && /\bDoctor\b/.test(card.typeLine ?? '');
  const companion = (card: CardDef) => has(card, (line) => /^Doctor['’]s companion$/i.test(line));
  if ((companion(a) && doctor(b)) || (companion(b) && doctor(a))) return null;
  return `${a.name} and ${b.name} cannot both be commanders: neither partners with the other`;
}

/**
 * Whether **every** card in a deck is one the engine can play.
 *
 * A report now, not a gate. It used to be the question the Arena table asked before it dealt, and
 * `auto:start` refused any deck that failed it. That refusal is gone: the engine runs on a deck
 * with cards it cannot read, and those cards are moved by hand inside the automated game — see
 * `coverage.ts` for why, and `manualCards` for what tells the player which ones.
 *
 * Still worth having, and still true: "is this deck fully automated" is a different and useful
 * question from "which cards are not", and it is the one a lobby wants when it decides whether to
 * say anything at all. Kept as a predicate over a `DeckSpec` rather than over a game, because that
 * is the only form available before a table is dealt.
 */
export function deckIsAutomatable(deck: DeckSpec): boolean {
  if (deck.commander !== undefined && deck.commander.typeLine.trim().length === 0) return false;
  if (deck.partner !== undefined && deck.partner.typeLine.trim().length === 0) return false;
  return deck.cards.every((entry) => entry.card.typeLine.trim().length > 0);
}
