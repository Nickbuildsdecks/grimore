/**
 * A deck somebody pasted in: what the pool gives it, and what it does with a name the pool lacks.
 *
 * The split these tests hold in place is the point of the feature. A name the engine knows becomes
 * the real card — the same script, cost and type line it has in the deck it came from — and a name
 * it does not becomes cardboard, playable on the tabletop and refused by Arena mode. Either half
 * failing quietly would be worse than the feature not existing: a list that lost half its cards, or
 * an automated game dealt with a card nobody can do anything with.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  applyAction, createGame, customDeck, deckIsAutomatable, poolCardNamed, STARTER_DECKS,
} from './index.js';
import { PLAYERS } from './testkit.js';
import type { Action, ActionContext, GameState } from './types.js';

describe('looking a pasted name up in the pool', () => {
  it('finds the card, whatever case and spacing the list was written in', () => {
    const bolt = poolCardNamed('Lightning Bolt');
    expect(bolt?.name).toBe('Lightning Bolt');
    expect(poolCardNamed('  lightning bolt  ')).toBe(bolt);
    expect(poolCardNamed('LIGHTNING BOLT')).toBe(bolt);
  });

  it('finds a commander, which is in the pool but in no deck list', () => {
    // Commanders live on `deck.commander`, not in `deck.cards`, so a pool built only from the
    // lists would quietly refuse every Commander deck anybody pasted.
    expect(poolCardNamed('Tatyova, Benthic Druid')?.typeLine).toContain('Legendary');
  });

  it('has nothing for a card the engine has never scripted', () => {
    expect(poolCardNamed('Black Lotus')).toBeUndefined();
    expect(poolCardNamed('Rhystic Study')).toBeUndefined();
  });
});

describe('building a deck out of a pasted list', () => {
  const list = (entries: readonly { name: string; count: number }[], commander?: string) =>
    customDeck({
      id: 'custom:0', name: 'Nick’s list', entries,
      ...(commander === undefined ? {} : { commander }),
    });

  it('uses the pool’s card, with its script and its cost, for a name it knows', () => {
    const { deck, unknown } = list([{ name: 'lightning bolt', count: 4 }]);
    expect(unknown).toEqual([]);
    expect(deck.cards[0]!.count).toBe(4);
    expect(deck.cards[0]!.card).toBe(poolCardNamed('Lightning Bolt'));
  });

  it('makes cardboard for a name it does not, and says which names those were', () => {
    const { deck, unknown } = list([
      { name: 'Lightning Bolt', count: 4 },
      { name: 'Black Lotus', count: 1 },
      { name: 'Mana Crypt', count: 1 },
    ]);
    // In the spelling the list used, because the player has to find those lines in their own text.
    expect(unknown).toEqual(['Black Lotus', 'Mana Crypt']);
    const ring = deck.cards.find((e) => e.card.name === 'Black Lotus')!.card;
    // The empty type line is the marker the engine reads. A type line it invented would make this
    // card look like something it can reason about, which is exactly what it is not.
    expect(ring.typeLine).toBe('');
    expect(ring.oracleText).toContain('by hand');
  });

  it('keeps the list’s order and its counts', () => {
    const { deck } = list([
      { name: 'Mountain', count: 24 },
      { name: 'Shock', count: 2 },
    ]);
    expect(deck.cards.map((e) => [e.card.name, e.count])).toEqual([['Mountain', 24], ['Shock', 2]]);
  });

  it('puts a commander it knows in the command zone', () => {
    const { deck, unknown } = list([{ name: 'Forest', count: 1 }], 'Tatyova, Benthic Druid');
    expect(unknown).toEqual([]);
    expect(deck.commander?.name).toBe('Tatyova, Benthic Druid');
  });

  it('reports a commander it does not know, and still seats it as cardboard', () => {
    const { deck, unknown } = list([{ name: 'Forest', count: 1 }], 'Atraxa, Praetors’ Voice');
    expect(unknown).toEqual(['Atraxa, Praetors’ Voice']);
    expect(deck.commander?.typeLine).toBe('');
  });

  it('leaves the command zone empty when the list named no commander', () => {
    expect(list([{ name: 'Forest', count: 1 }]).deck.commander).toBeUndefined();
  });
});

describe('whether the engine can play the list', () => {
  it('says yes to a list built entirely out of the pool', () => {
    const { deck } = customDeck({
      id: 'custom:0', name: 'All pool',
      entries: [{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 20 }],
      commander: 'Tatyova, Benthic Druid',
    });
    expect(deckIsAutomatable(deck)).toBe(true);
  });

  it('says no to one card of cardboard', () => {
    const { deck } = customDeck({
      id: 'custom:0', name: 'Nearly',
      entries: [{ name: 'Mountain', count: 59 }, { name: 'Black Lotus', count: 1 }],
    });
    expect(deckIsAutomatable(deck)).toBe(false);
  });

  it('says no to a commander of cardboard, even when every other card is real', () => {
    const { deck } = customDeck({
      id: 'custom:0', name: 'Blank general',
      entries: [{ name: 'Forest', count: 60 }],
      commander: 'Atraxa, Praetors’ Voice',
    });
    expect(deckIsAutomatable(deck)).toBe(false);
  });

  it('says yes to every built-in deck, which is the pool it is asking about', () => {
    for (const deck of Object.values(STARTER_DECKS)) expect(deckIsAutomatable(deck)).toBe(true);
  });
});

describe('dealing a pasted list at a table', () => {
  const ctxFor = (entries: readonly { name: string; count: number }[]): ActionContext => ({
    isHost: true,
    // `custom:0` is the id the server gives seat zero's list; the engine takes whatever key it
    // is handed, and this is the one it is handed in practice.
    decks: { 'custom:0': customDeck({ id: 'custom:0', name: 'A list', entries }).deck },
  });
  const deal = (entries: readonly { name: string; count: number }[]): GameState => {
    const ctx = ctxFor(entries);
    let s = createGame({ id: 'g-custom', format: 'modern', players: PLAYERS, seed: 77 });
    for (const action of [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'custom:0' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'ember-rush' },
      { type: 'game:start', by: 0, firstSeat: 0 },
    ] as readonly Action[]) s = applyAction(s, action, ctx);
    return s;
  };
  const refusalOf = (s: GameState, action: Action): string | null => {
    try {
      applyAction(s, action, { isHost: true });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it('deals the pasted list like any other deck', () => {
    const s = deal([{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 56 }]);
    expect(s.started).toBe(true);
    const mine = Object.values(s.instances).filter((i) => i.owner === 0);
    expect(mine).toHaveLength(60);
    expect(s.seats[0]!.deckId).toBe('custom:0');
  });

  it('runs the engine on it when every card is one the engine knows', () => {
    const s = deal([{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 56 }]);
    expect(refusalOf(s, { type: 'auto:start', by: 0 })).toBeNull();
  });

  it('refuses Arena mode when one card is cardboard, and names it', () => {
    // The tabletop is the honest answer here, so the refusal has to say which card and why rather
    // than failing somewhere in the first upkeep.
    const s = deal([{ name: 'Black Lotus', count: 1 }, { name: 'Mountain', count: 59 }]);
    const why = refusalOf(s, { type: 'auto:start', by: 0 });
    expect(why).toContain('Black Lotus');
    // And the tabletop still plays it, which is the point of refusing rather than dropping the card.
    expect(refusalOf(s, { type: 'zone:draw', by: 0, seat: 0, count: 1 })).toBeNull();
  });
});

/**
 * The lists the browser suites paste, checked here because nothing else checks them at all.
 *
 * `scripts/e2e-solo.mjs` carries twenty hand-written sixty-card lists — one per mechanic it drives
 * through a real browser under `LIST=cascade`, `LIST=soulbond` and the rest. Every name in them is
 * a string, and the pool they are looked up in is **the union of the starter decks** (see
 * `poolIndex`), so the two move independently: a balance pass that takes the last copy of a card
 * out of the last deck that held it removes that card from the pool, and every list naming it
 * quietly becomes a tabletop deck. `auto:start` then refuses the table, and the suite times out on
 * a screen that looks like a broken pregame and is not — which is exactly the failure the comment
 * at the top of `e2e-table.mjs` records happening once already, to a check that named a one-of.
 *
 * What makes it worth a test rather than a note is **where those suites run, which is nowhere**:
 * `.github/workflows/ci.yml` has no browser job, and `pnpm v2:test` filters to `./packages/*` and
 * `./apps/*`, so `scripts/` is outside it. Four suites, 24 to 73 checks each, run when somebody
 * remembers. A list broken by a deck edit would stay broken until then.
 *
 * So the one half of that risk that a test *can* hold is held here: not that the browser suite
 * passes, which needs a browser, but that the pool still has every card those suites ask it for.
 * It is the same shape as `scripts/guards.js`'s granted-trigger pairing — a static tripwire on the
 * PR that breaks the invariant, rather than a reproduction of the thing it protects.
 *
 * The parse is deliberately narrow: the e2e lists are written in one canonical `'<count> <name>'`
 * form, so this reads that form and nothing else. `parseDecklist`'s forgiveness about `4x`, set
 * codes and section headers is `@grimore/shared`'s business and is tested in its own suite — and
 * rules-engine does not depend on shared, which is why `customDeck` mirrors `DecklistEntry`
 * instead of importing it.
 */
describe('every deck the browser suites paste', () => {
  const scriptsDir = join(__dirname, '..', '..', '..', 'scripts');
  const files = readdirSync(scriptsDir).filter((f) => /^e2e-.*\.mjs$/.test(f)).sort();

  /** Every `const NAME_LIST = [ '4 Card', ... ].join('\n')` in the e2e scripts. */
  const lists = files.flatMap((file) => {
    const src = readFileSync(join(scriptsDir, file), 'utf8');
    return [...src.matchAll(/const (\w*LIST\w*) = \[([\s\S]*?)\]\.join\('\\n'\)/g)].map((m) => ({
      file,
      name: m[1]!,
      // `(?:[^'\\]|\\.)*` rather than `[^']*`: five of the twenty name a card with an apostrophe
      // in it (Tormod's Crypt, Man-o'-War, Healer's Hawk), written `'4 Tormod\'s Crypt'`. A naive
      // parse stops at the backslash and asks the pool for "Tormod\", which it does not have —
      // and the first draft of this check reported four misses that were its own regex.
      entries: [...m[2]!.matchAll(/'(\d+)\s+((?:[^'\\]|\\.)*)'/g)].map((row) => ({
        count: Number(row[1]),
        name: row[2]!.replace(/\\(.)/g, '$1'),
      })),
    }));
  });

  /*
    The control. This check's clean result is an empty list of misses, and a regex that matched
    nothing produces the same empty list — the way `checkPlayerDocCoversEveryMechanic` asserts it
    can still see "flying" before believing its own zero. Twenty lists and a hundred and fifty
    named slots are what is there today; the floor is below both so a new list does not fail it,
    and far enough above zero that a broken extraction cannot pass.
  */
  it('is actually being read, rather than matching nothing', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(lists.length).toBeGreaterThanOrEqual(15);
    expect(lists.reduce((n, l) => n + l.entries.length, 0)).toBeGreaterThanOrEqual(150);
    // And one known list by name, so a rename of the extraction target is not a silent pass.
    expect(lists.some((l) => l.name === 'CASCADE_LIST')).toBe(true);
  });

  it.each(lists.map((l) => [`${l.file} ${l.name}`, l] as const))(
    'names only cards the pool still has: %s',
    (_label, list) => {
      const missing = list.entries.filter((e) => poolCardNamed(e.name) === undefined);
      // The names rather than a count, because the fix is to put the card back in a deck or to
      // change the list, and both need to know which card.
      expect(missing.map((e) => e.name)).toEqual([]);
    },
  );

  it.each(lists.map((l) => [`${l.file} ${l.name}`, l] as const))(
    'is a sixty-card deck the engine will run Arena mode on: %s',
    (_label, list) => {
      const total = list.entries.reduce((n, e) => n + e.count, 0);
      /*
        Sixty is the suites' own convention, not a rule the code enforces — worth being exact
        about, because the first draft of this comment said `parseDecklist` refuses anything else
        and that is false: `DECKLIST_LIMITS` has a 250 maximum and no minimum, and nothing in the
        engine, the server or the web app checks for sixty. All twenty lists are sixty today
        because each was written as a deck for the format, and a list that has drifted off it is
        far more likely an edit that dropped a line than a deliberate fifty-nine. If a suite ever
        wants a different size on purpose, change this number rather than route around it.
      */
      expect(total).toBe(60);
      const { deck, unknown } = customDeck({
        id: 'custom:0', name: list.name, entries: list.entries,
      });
      expect(unknown).toEqual([]);
      expect(deckIsAutomatable(deck)).toBe(true);
    },
  );
});
