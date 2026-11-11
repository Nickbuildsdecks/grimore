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
 * The whole of a split card, whose two halves are each checked under their own names. Until D591
 * the corpus carried front faces only, and the back of a split card, the Adventure half of an
 * adventurer and the back face of a transforming or modal card were listed here as unverified;
 * the corpus now carries every face, all nine have rows, and checking them found five of the
 * pool's facts wrong (Venture Deeper's cost, Shield's Might's size, two lands' older wording).
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
