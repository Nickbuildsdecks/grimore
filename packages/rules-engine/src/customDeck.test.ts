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
  applyAction, characteristicsOf, createGame, customDeck, deckIsAutomatable, legalActions,
  poolCardNamed, STARTER_DECKS, unreadLines, viewFor,
} from './index.js';
import { arena, find, PLAYERS } from './testkit.js';
import type { Action, ActionContext, GameState, SeatIndex } from './types.js';

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

  it('runs the engine on it when every card is one the engine knows, and says nothing', () => {
    const s = deal([{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 56 }]);
    expect(refusalOf(s, { type: 'auto:start', by: 0 })).toBeNull();
    /*
      The negative half of the hybrid contract below, and it is what stops the badge crying wolf.
      A `manual` list that is non-empty on an ordinary game would put a "move this by hand" flag on
      every card in the product, which is worse than the refusal it replaced: a warning that is
      always on is a warning nobody reads.
    */
    const started = applyAction(s, { type: 'auto:start', by: 0 }, { isHost: true });
    expect(viewFor(started, 0).manual).toEqual([]);
    expect(started.log[started.log.length - 1]?.message).not.toContain('by hand');
  });

  /*
    Hybrid automation: a card the engine cannot read no longer costs the table its engine.

    This used to be a refusal test — `auto:start` threw and named the card, and the deck played on
    the tabletop instead. That was right for a 348-card hand-scripted pool and wrong for a pool
    drawn from every card ever printed, where one unreadable card in a hundred would cost the other
    ninety-nine their turn structure, priority and combat. See `coverage.ts`.

    So these four checks are the contract the old refusal is replaced by, and the fourth is the one
    that makes the other three worth anything: it is not enough that the engine *starts*, it has to
    actually be playing the rest of the deck.
  */
  describe('a deck with a card the engine cannot read', () => {
    const withCardboard = () =>
      deal([{ name: 'Black Lotus', count: 1 }, { name: 'Mountain', count: 59 }]);

    it('starts the rules engine anyway', () => {
      expect(refusalOf(withCardboard(), { type: 'auto:start', by: 0 })).toBeNull();
    });

    it('names the card in the log, on the same line that says the engine took over', () => {
      // The same line, not a second entry: "the engine takes over" and "except for this card" are
      // one fact, and a player who scrolls past the second has been misled by the first.
      const started = applyAction(withCardboard(), { type: 'auto:start', by: 0 }, { isHost: true });
      const last = started.log[started.log.length - 1];
      expect(last?.message).toContain('rules engine takes over');
      expect(last?.message).toContain('Black Lotus');
      expect(last?.message).toContain('by hand');
    });

    it('carries the card and the reason in every seat\u2019s view', () => {
      const started = applyAction(withCardboard(), { type: 'auto:start', by: 0 }, { isHost: true });
      for (const seat of [0, 1] as const) {
        const manual = viewFor(started, seat).manual;
        expect(manual.map((m) => m.name)).toEqual(['Black Lotus']);
        expect(manual[0]?.reason).toBe('no-printed-data');
      }
      // And not on a tabletop table, where "not automated" is every card and a badge is noise.
      expect(viewFor(withCardboard(), 0).manual).toEqual([]);
    });

    it('and the engine really is running the rest: the Mountains are playable lands', () => {
      /*
        The check that stops the three above from being a green light on a broken game. A table that
        starts automation and then cannot play a land is not hybrid mode, it is a worse tabletop —
        and every assertion above would pass on one.
      */
      let s = applyAction(withCardboard(), { type: 'auto:start', by: 0 }, { isHost: true });
      s = applyAction(s, { type: 'auto:keep', by: 0 }, { isHost: true });
      s = applyAction(s, { type: 'auto:keep', by: 1 }, { isHost: true });
      /*
        Through `legalActions` rather than by reaching for an instance id, and that is the stronger
        half of this check: it asserts the engine is **offering** the land drop, not merely that it
        would accept one if told. A table that offers no plays is the failure this is looking for.
      */
      const land = legalActions(s, 0).plays.find((play) => play.kind === 'land');
      expect(land, 'the engine offered seat 0 no land to play after keeping its opening hand')
        .toBeDefined();
      const after = applyAction(s, { type: 'auto:playLand', by: 0, card: land!.card }, { isHost: true });
      expect(after.instances[land!.card]?.zone).toBe('battlefield');
    });

    it('still lets that card be moved by hand, which is what makes it playable at all', () => {
      const started = applyAction(withCardboard(), { type: 'auto:start', by: 0 }, { isHost: true });
      expect(refusalOf(started, { type: 'zone:draw', by: 0, seat: 0, count: 1 })).toBeNull();
    });
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

/**
 * A list resolved against card data as well as the pool.
 *
 * The third answer between "the pool has it" and "cardboard": a card nobody wrote a script for
 * whose rules its own data already is. `fromCardData.ts` decides which cards qualify; what is
 * asserted here is the **order** — pool, then data, then cardboard — and that a list the data
 * covers becomes a table the rules engine will actually deal.
 */
describe('a pasted list resolved against card data', () => {
  /** A row as the card table holds one. Only the fields a derivation reads. */
  const bear = (name: string) => ({
    name, type_line: 'Creature — Bear', oracle_text: '', mana_cost: '{1}{G}',
    cmc: 2, colors: ['G'], layout: 'normal', power: '2', toughness: '2',
  });
  const woods = (name: string) => ({
    name, type_line: 'Basic Land — Forest', oracle_text: '({T}: Add {G}.)', mana_cost: '',
    cmc: 0, colors: [], layout: 'normal', produced_mana: ['G'],
  });
  const paragraph = (name: string) => ({
    name, type_line: 'Creature — Human Wizard', mana_cost: '{2}{U}', cmc: 3, colors: ['U'],
    layout: 'normal', power: '1', toughness: '3',
    oracle_text: 'Whenever you cast a noncreature spell, put a +1/+1 counter on this creature.',
  });

  it('builds a playable card from data for a name the pool does not have', () => {
    const { deck, unknown, fromData } = customDeck({
      id: 'custom:0', name: 'Mine',
      entries: [{ name: 'Datawood Bear', count: 4 }, { name: 'Datawood', count: 20 }],
      data: [bear('Datawood Bear'), woods('Datawood')],
    });
    expect(unknown).toEqual([]);
    expect(fromData).toEqual(['Datawood Bear', 'Datawood']);
    // The point of the whole exercise: a list the pool has none of is now an Arena table.
    expect(deckIsAutomatable(deck)).toBe(true);
    expect(deck.cards[0]!.card.power).toBe('2');
    expect(deck.cards[1]!.card.typeLine).toContain('Forest');
  });

  it('prefers the pool over the data, even when the data disagrees', () => {
    /*
      A hand-written script is always the best answer available, so a row carrying a pool card's
      name must not displace it. Asserted with a row that is *wrong on purpose* — a Forest typed as
      an Island — because a test whose row agreed with the pool would pass either way.
    */
    const { deck, fromData } = customDeck({
      id: 'custom:0', name: 'Mine', entries: [{ name: 'Forest', count: 1 }],
      data: [{
        name: 'Forest', type_line: 'Basic Land — Island', oracle_text: '', mana_cost: '',
        cmc: 0, colors: [], layout: 'normal', produced_mana: ['U'],
      }],
    });
    expect(deck.cards[0]!.card.typeLine).toBe('Basic Land — Forest');
    expect(fromData).toEqual([]);
  });

  /*
    A row nothing can be dealt from at all, which is where the cardboard line moved to (D430).

    These two tests used to assert that a card whose *text* the whole-card derivation refused became
    cardboard, and that was the behaviour until the oracle-text compiler existed. `corpus-decks.mjs`
    is what made it untenable: of 60 random real cards, **34** were cardboard — not because nothing
    could read them, but because `customDeck` asked `cardFromData`, which is all-or-nothing, and
    never asked `compileCard`, which reads 27% of all printed lines.

    So the boundary is now about what `printedDef` can make a card from, not about how much of the
    text reads: an empty type line, or a layout with more than one face. Everything else is dealt as
    its printed self, and whatever the compiler could not read is **flagged** rather than deleted
    (D362).
  */
  const typeless = (name: string) => ({
    name, type_line: '', mana_cost: '{1}', cmc: 1, colors: [], layout: 'normal',
    oracle_text: 'Draw a card.',
  });
  const twoFaced = (name: string) => ({
    name, type_line: 'Instant', mana_cost: '{R}', cmc: 1, colors: ['R'], layout: 'split',
    oracle_text: 'Datawood Split deals 2 damage to any target.',
  });

  it('deals a card the whole-card derivation refuses, with its unread line flagged', () => {
    /*
      The case this change is for. "Whenever you cast a noncreature spell, put a +1/+1 counter on
      this creature" is a paragraph `cardFromData` will not take — and `compileCard` reads it, so
      the card is a real 1/3 with a real cost and a real trigger instead of a blank.
    */
    const { deck, unknown, fromData } = customDeck({
      id: 'custom:0', name: 'Mine',
      entries: [{ name: 'Datawood Bear', count: 1 }, { name: 'Prowess Person', count: 1 }],
      data: [bear('Datawood Bear'), paragraph('Prowess Person')],
    });
    expect(unknown).toEqual([]);
    expect(fromData).toEqual(['Datawood Bear', 'Prowess Person']);
    const person = deck.cards[1]!.card;
    expect(person.typeLine).toBe('Creature — Human Wizard');
    expect([person.power, person.toughness]).toEqual(['1', '3']);
    expect(person.manaCost).toBe('{2}{U}');
    // Playable, which is the whole point: a blank card has no cost and can never be cast.
    expect(deckIsAutomatable(deck)).toBe(true);
  });

  it('still leaves a row nothing can be dealt from as cardboard, and names it', () => {
    const { deck, unknown, fromData } = customDeck({
      id: 'custom:0', name: 'Mine',
      entries: [
        { name: 'Datawood Bear', count: 1 },
        { name: 'Datawood Nothing', count: 1 },
        { name: 'Datawood Split', count: 1 },
      ],
      data: [bear('Datawood Bear'), typeless('Datawood Nothing'), twoFaced('Datawood Split')],
    });
    // No type line is cardboard's own marker, and a split card is two spells on one piece of
    // cardboard — `printedDef` refuses both by name rather than guessing.
    expect(unknown).toEqual(['Datawood Nothing', 'Datawood Split']);
    expect(fromData).toEqual(['Datawood Bear']);
    expect(deck.cards[1]!.card.typeLine).toBe('');
    expect(deck.cards[2]!.card.typeLine).toBe('');
    expect(deckIsAutomatable(deck)).toBe(false);
  });

  /*
    ── The size the card prints, which is what nearly broke this (D431) ─────────────────────────

    `printedDef` built its `CardDef` without `power` or `toughness`, and nothing noticed for as long
    as the only caller was `cardFromData` — which adds the size itself in its creature branch. The
    compiler reads the same function and does not, so the moment `customDeck` started dealing
    compiled cards, all 18,603 creatures in the corpus arrived with no printed size.
    `characteristicsOf` reads a missing size as zero, so each one was a 0/0 that CR 704.5f binned on
    arrival: the deck stopped being 34 blanks and became 34 corpses.
  */
  it('deals a creature at its printed size, which the engine then reads off the board', () => {
    /*
      Read from the battlefield rather than off the `CardDef`, because the field being populated is
      not the claim — the claim is that the creature *survives arrival*, and a size that reached the
      def but not `characteristicsOf` would still be a 1/3 on paper and a dead 0/0 at the table.
    */
    const list = Array.from({ length: 56 }, () => ({ name: 'Mountain', count: 1 }));
    const built = customDeck({
      id: 'mine', name: 'Mine',
      entries: [{ name: 'Prowess Person', count: 4 }, ...list],
      data: [paragraph('Prowess Person')],
    });
    expect(built.unknown).toEqual([]);
    const s = arena({
      decks: { 0: 'mine' },
      deckSpecs: { mine: built.deck },
      battlefield: { 0: ['Prowess Person'] },
      turn: 3,
    });
    const id = find(s, 0 as SeatIndex, 'battlefield', 'Prowess Person');
    const live = characteristicsOf(s, s.instances[id]!);
    expect([live.power, live.toughness]).toEqual([1, 3]);
    // Still there, which is the half a populated field cannot assert: a 0/0 is gone by now.
    expect(s.instances[id]!.zone).toBe('battlefield');
  });

  it('keeps a creature whose size is a count it cannot read as cardboard, and names it', () => {
    /*
      The other side of the same rule, and the reason the refusal lives in the compiler rather than
      here: a `*`/`*` creature has no printed size at all, so "deal it and flag the line" (D362) is
      not available — the card would be a 0/0 and die before anybody could apply anything by hand.
      233 of the corpus's 18,603 creatures print a size like this. Cardboard is what the player can
      actually use, so cardboard is what they get, with the name reported.
    */
    const starred = {
      name: 'Datawood Goyf', type_line: 'Creature — Lhurgoyf', mana_cost: '{2}{G}', cmc: 3,
      colors: ['G'], layout: 'normal', power: '*', toughness: '*',
      oracle_text: 'Datawood Goyf\u2019s power is equal to the number of cards in your hand.',
    };
    const { deck, unknown, fromData } = customDeck({
      id: 'custom:0', name: 'Mine',
      entries: [{ name: 'Datawood Bear', count: 1 }, { name: 'Datawood Goyf', count: 1 }],
      data: [bear('Datawood Bear'), starred],
    });
    expect(unknown).toEqual(['Datawood Goyf']);
    expect(fromData).toEqual(['Datawood Bear']);
    expect(deck.cards[1]!.card.typeLine).toBe('');
  });

  it('flags the line it could not read rather than deleting the card (D362)', () => {
    /*
      Hybrid automation, which is what makes dealing a partly-read card the right answer rather
      than a reckless one. "At the beginning of each opponent's upkeep" has no prologue — `of` on a
      step trigger is `'you' | 'any'` and this needs a third value — so the line is **reported**,
      and the table shows the card with that line flagged for a human to apply.
    */
    const unreadable = {
      name: 'Datawood Watcher', type_line: 'Creature — Human Scout', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], layout: 'normal', power: '2', toughness: '2',
      oracle_text: "At the beginning of each opponent's upkeep, draw a card.",
    };
    const { deck, unknown } = customDeck({
      id: 'custom:0', name: 'Mine',
      entries: [{ name: 'Datawood Watcher', count: 1 }],
      data: [unreadable],
    });
    expect(unknown).toEqual([]);
    const card = deck.cards[0]!.card;
    expect(card.typeLine).toBe('Creature — Human Scout');
    expect(unreadLines(card).map((entry) => entry.line))
      .toEqual(["At the beginning of each opponent's upkeep, draw a card."]);
  });

  it('matches a row by name the same way the pool is matched', () => {
    const { unknown, fromData } = customDeck({
      id: 'custom:0', name: 'Mine', entries: [{ name: '  dATAwood bEAR ', count: 1 }],
      data: [bear('Datawood Bear')],
    });
    expect(unknown).toEqual([]);
    expect(fromData).toHaveLength(1);
  });

  it('resolves a commander out of the data too', () => {
    const { deck, unknown } = customDeck({
      id: 'custom:0', name: 'Mine', entries: [{ name: 'Datawood', count: 99 }],
      commander: 'Datawood Bear', data: [bear('Datawood Bear'), woods('Datawood')],
    });
    expect(unknown).toEqual([]);
    expect(deck.commander?.power).toBe('2');
    expect(deckIsAutomatable(deck)).toBe(true);
  });

  it('behaves exactly as before when no data is passed', () => {
    // Every existing caller passes nothing, so this is the guard on all of them.
    const { deck, unknown, fromData } = customDeck({
      id: 'custom:0', name: 'Mine', entries: [{ name: 'Datawood Bear', count: 1 }],
    });
    expect(unknown).toEqual(['Datawood Bear']);
    expect(fromData).toEqual([]);
    expect(deckIsAutomatable(deck)).toBe(false);
  });

  it('counts a name nothing could make playable, not a name the pool lacks', () => {
    /*
      The rename that came with this change, and the reason for it. `unknown` used to mean "the
      pool does not have it" and now means "nothing could make it playable" — because a table told
      the first number would refuse to deal an Arena game it could have dealt. All three readers
      of this field in `apps/realtime` report it to players as the cannot-read count, which is the
      second question and always was.
    */
    const { unknown } = customDeck({
      id: 'custom:0', name: 'Mine',
      entries: [{ name: 'Datawood Bear', count: 1 }, { name: 'Datawood Nothing', count: 1 }],
      data: [bear('Datawood Bear'), typeless('Datawood Nothing')],
    });
    expect(unknown).toHaveLength(1);
  });
});
