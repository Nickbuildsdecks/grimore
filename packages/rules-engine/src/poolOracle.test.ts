/**
 * Every built-in card, against its Oracle row (D571).
 *
 * The pool was typed in by hand, a few cards at a time, across many sessions — and for most of that
 * time nothing compared what was typed with what the card says. The first comparison found 122
 * wrong mana costs, type lines and sizes and 95 rules texts that differed in substance: a Doom Blade
 * that could kill a black creature, a Preordain that scried one, a Walking Ballista that grew for
 * {1}. Every measurement taken on those decks was taken on those cards.
 *
 * So this is a standing check rather than a one-off pass. `poolOracle.fixture.json` holds the Oracle
 * row for each pool card (`scripts/measure/pool-oracle.mjs` writes it from a corpus file), and each
 * printed fact of each card has to equal its row. A fact that is deliberately different is listed
 * in `KNOWN_DIFFERENT` with the reason, and the list fails in **both** directions: an unlisted
 * difference fails, and so does a listed one that no longer differs — a table of excuses that can
 * only grow is how the pool got here.
 *
 * ## What is compared, and how
 *
 * Mana cost, mana value, type line, colours, power, toughness and loyalty: exactly.
 *
 * Rules text: with **reminder text removed** from both sides and whitespace collapsed, and nothing
 * else forgiven. Whether a card carries its reminder text is an editorial choice the pool makes
 * card by card; what the card *does* is not. A text that is reminder text and nothing else (a basic
 * land's) is compared by what is inside the brackets.
 *
 * ## What is not compared
 *
 * The corpus carries the front face of a two-faced card only. The back of a split card, the
 * Adventure half of an adventurer and the back face of a transforming or modal card have no row,
 * and `NO_ORACLE_ROW` names each one — unverified is a fact about the card, and it is said here
 * rather than left to look like a pass.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CardDef } from './cards.js';
import { STARTER_DECKS } from './starterDecks.js';

interface OracleRow {
  readonly manaCost: string;
  readonly cmc: number;
  readonly typeLine: string;
  readonly oracleText: string;
  readonly colors: readonly string[];
  readonly power?: string;
  readonly toughness?: string;
  readonly loyalty?: string;
}

const ORACLE: Readonly<Record<string, OracleRow>> = JSON.parse(
  readFileSync(new URL('./poolOracle.fixture.json', import.meta.url), 'utf8'),
);

/** Every definition a deck can put on the table: its cards, its commander, and each nested face. */
function poolDefs(): Map<string, CardDef> {
  const defs = new Map<string, CardDef>();
  const add = (def: CardDef): void => {
    defs.set(def.name, def);
    for (const face of def.faces?.cards ?? []) add(face);
  };
  for (const deck of Object.values(STARTER_DECKS)) {
    if (deck.commander) add(deck.commander);
    for (const entry of deck.cards) add(entry.card);
  }
  return defs;
}

/**
 * Rules text with its reminder text gone, one ability to a line.
 *
 * Two typographic pairs are folded as well, because the corpus this fixture was built from writes
 * the plain one and the pool writes the printed one: the minus sign of a loyalty cost (U+2212 for
 * `-`) and the curly apostrophe. Neither is a word.
 */
export function withoutReminderText(text: string): string {
  const plain = text.replace(/\u2212/g, '-').replace(/\u2019/g, "'");
  const whole = /^\(([^()]*)\)$/.exec(plain.trim());
  if (whole) return whole[1]!.trim();
  return plain
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/ ([.,;])/g, '$1').trim())
    .filter((line) => line !== '')
    .join('\n');
}

type Fact = 'manaCost' | 'cmc' | 'typeLine' | 'colors' | 'power' | 'toughness' | 'loyalty' | 'oracleText';

function factsOf(def: CardDef | OracleRow): Record<Fact, string> {
  return {
    manaCost: def.manaCost,
    cmc: String(def.cmc),
    typeLine: def.typeLine,
    colors: [...def.colors].sort().join(''),
    power: def.power ?? '',
    toughness: def.toughness ?? '',
    loyalty: def.loyalty ?? '',
    oracleText: withoutReminderText(def.oracleText),
  };
}

/**
 * Definitions with no row to be checked against, and why. Fails if one of them gains a row.
 */
const NO_ORACLE_ROW: Readonly<Record<string, string>> = {
  'Fire // Ice': 'the whole split card; its front half is checked as Fire',
  'Wax // Wane': 'the whole split card; its front half is checked as Wax',
  'Assault // Battery': 'the whole split card; its front half is checked as Assault',
  Ice: 'back half of a split card: the corpus carries front faces only',
  Wane: 'back half of a split card: the corpus carries front faces only',
  Battery: 'back half of a split card: the corpus carries front faces only',
  'Venture Deeper': 'Adventure half: the corpus carries front faces only',
  "Shield's Might": 'Adventure half: the corpus carries front faces only',
  'Awoken Horror': 'back face of a transforming card: the corpus carries front faces only',
  'Insectile Aberration': 'back face of a transforming card: the corpus carries front faces only',
  'Hagra Broodpit': 'back face of a modal double-faced card: the corpus carries front faces only',
  'Vastwood Thicket': 'back face of a modal double-faced card: the corpus carries front faces only',
};

/**
 * `"Card name | fact"` → why the pool's value is not the Oracle row's.
 *
 * Two kinds of entry, and only two. A **convention** is the pool saying the same thing in a
 * different place (an adventurer's front face quotes its Adventure, which Oracle prints on the
 * other face). A **queued** entry is a card that is still wrong: its text changes together with
 * its script and its tests, never ahead of them, because a card whose text is right and whose
 * script is not is a card that lies to the player holding it.
 */
const KNOWN_DIFFERENT: Readonly<Record<string, string>> = {
  "Merfolk Secretkeeper | oracleText": "convention: the front face quotes its Adventure, which Oracle prints on the other face",
  "Garenbrig Carver | oracleText": "convention: the front face quotes its Adventure, which Oracle prints on the other face",
  "Mutavault | oracleText": "queued: becomes a 2/2 creature, without \"with all creature types\"",
  "Fireball | oracleText": "queued: X damage to one target; printed divides it among any number, {1} more for each beyond the first",
  "Faithless Looting | oracleText": "queued: no flashback {2}{R}",
  "Dragonsguard Elite | oracleText": "queued: ward {1} and two counters; printed one counter, no ward, and {4}{G}{G}: double them",
  "Turn to Frog | oracleText": "queued: does not make the creature blue or a Frog",
  "Cackling Counterpart | oracleText": "queued: no flashback {5}{U}{U}",
  "Ophidian | oracleText": "queued: removed from combat; printed assigns no combat damage this turn",
  "Mystic Remora | oracleText": "queued: draws two cards; printed a card unless that player pays {4}",
  "Sedgemoor Witch | oracleText": "queued: ward {3} and a black Pest; printed ward\u2014pay 3 life and a black and green Pest",
  "Balan, Wandering Knight | oracleText": "queued: double strike always; printed first strike, and double strike with two or more Equipment",
  "Darksteel Plate | oracleText": "queued: the Plate itself is not indestructible",
  "Kalitas, Traitor of Ghet | oracleText": "queued: no {2}{B}, sacrifice another Vampire or Zombie ability",
  "Hagra Mauling | oracleText": "queued: no {1} less when an opponent controls no basic lands",
  "Woe Strider | oracleText": "queued: escape {4}{B}, exile three; printed {3}{B}{B}, exile four, and two +1/+1 counters",
  "The Birth of Meletis | oracleText": "queued: chapters reordered and changed; printed I a basic Plains to hand, II a colorless artifact Wall, III 2 life",
  "Ajani, Caller of the Pride | oracleText": "queued: +1 lacks \"up to one\"; the ultimate makes five Cats, printed X where X is your life total",
  "Jace, Memory Adept | oracleText": "queued: +1 mills ten and 0 draws; printed +1 draw and mill one, 0 mill ten, -7 twenty cards",
  "Toxic Deluge | oracleText": "queued: the life is paid as the spell resolves; printed as an additional cost to cast it",
  "The Eldest Reborn | oracleText": "queued: creatures only; printed creature or planeswalker in chapters I and III",
  "Pyromatics | oracleText": "queued: divides its damage between one or two targets; printed 1 damage to any target",
  "Phoenix of Ash | oracleText": "queued: {1}: +1/+0; printed {2}{R}: +2/+0, and it escapes with a +1/+1 counter",
  "Sunscourge Champion | oracleText": "queued: gains 2; printed life equal to its power, and eternalize\u2014{2}{W}{W}, discard a card",
};

describe('every built-in card against its Oracle row (D571)', () => {
  const defs = poolDefs();

  it('has a row for every definition, or says why it has none', () => {
    const missing = [...defs.keys()].filter((name) => ORACLE[name] === undefined).sort();
    expect(missing).toEqual(Object.keys(NO_ORACLE_ROW).sort());
  });

  it('agrees with the row on every printed fact, except where it says why not', () => {
    const differing: string[] = [];
    const detail: string[] = [];
    for (const [name, def] of defs) {
      const row = ORACLE[name];
      if (row === undefined) continue;
      const pool = factsOf(def);
      const oracle = factsOf(row);
      for (const fact of Object.keys(pool) as Fact[]) {
        if (pool[fact] === oracle[fact]) continue;
        differing.push(`${name} | ${fact}`);
        detail.push(`${name} | ${fact}: pool ${JSON.stringify(pool[fact])}, Oracle ${JSON.stringify(oracle[fact])}`);
      }
    }
    // POOL_ORACLE_DUMP=/some/path writes every difference, listed or not: the work queue, whole.
    const dump = process.env['POOL_ORACLE_DUMP'];
    if (dump) writeFileSync(dump, detail.join('\n') + '\n');
    const listed = Object.keys(KNOWN_DIFFERENT).sort();
    const unlisted = differing.filter((key) => !listed.includes(key));
    const stale = listed.filter((key) => !differing.includes(key));
    // The detail is what a failure should print: the two values side by side, not just the key.
    expect(detail.filter((line) => unlisted.some((key) => line.startsWith(`${key}:`)))).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('strips reminder text and nothing else', () => {
    expect(withoutReminderText('Flying (This creature can’t be blocked except by fliers.)\nHaste')).toBe('Flying\nHaste');
    expect(withoutReminderText('({T}: Add {R}.)')).toBe('{T}: Add {R}.');
    expect(withoutReminderText('Destroy target nonblack creature.')).toBe('Destroy target nonblack creature.');
    // A cost in braces is not reminder text, and a difference of one word survives.
    expect(withoutReminderText('{4}: Put a +1/+1 counter on this creature.')).not.toBe(
      withoutReminderText('{1}: Put a +1/+1 counter on this creature.'),
    );
  });
});
