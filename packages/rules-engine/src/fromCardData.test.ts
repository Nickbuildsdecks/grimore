/**
 * The classifier in `fromCardData.ts`, and a game played with a deck it built.
 *
 * Two halves, and the second is the one that matters. A classifier can be unit-tested into looking
 * right while the cards it approves are unplayable — which is exactly the state the engine was in
 * before this module existed: an unscripted land printed `{T}: Add {G}.` and made no mana at all,
 * so a deck of "simple" cards could not cast anything. So the last tests here deal a board out of
 * derived cards and play with it.
 */
import { describe, it, expect } from 'vitest';
import { cardFromData, tallyDerivations, type CardDataRow } from './fromCardData.js';
import { scriptForCard, scriptFor } from './scripts.js';
import { arena, apply, find, ids, nameOf, advanceTo, passBoth, drain, tapAllLands } from './testkit.js';
import { legalActions, manaSources, potentialMana } from './legalActions.js';
import { characteristicsOf } from './characteristics.js';
import type { CardDef, DeckSpec } from './cards.js';

/** A row with the fields every card has; each test overrides what it is about. */
const row = (over: Partial<CardDataRow>): CardDataRow => ({
  name: 'Test Card', type_line: 'Creature — Bear', oracle_text: '', mana_cost: '{1}{G}',
  cmc: 2, colors: ['G'], layout: 'normal', power: '2', toughness: '2', ...over,
});

const built = (over: Partial<CardDataRow>) => {
  const result = cardFromData(row(over));
  if (!result.ok) throw new Error(`expected a card, got: ${result.why}`);
  return result;
};
const why = (over: Partial<CardDataRow>): string => {
  const result = cardFromData(row(over));
  if (result.ok) throw new Error(`expected a refusal, got a ${result.kind}`);
  return result.why;
};

describe('building a card from its printed data', () => {
  describe('the cards it reads', () => {
    it('gives a basic land the mana ability nothing prints on it (CR 305.6)', () => {
      /*
        A Forest's oracle text is `({T}: Add {G}.)` — in brackets, because it is reminder text. The
        ability is intrinsic to the subtype, so the derivation has to come from the type line; a
        reader that took the text literally would also accept a card whose only green mana is in a
        reminder for something else.
      */
      const forest = built({
        name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '({T}: Add {G}.)',
        mana_cost: '', cmc: 0, colors: [], power: null, toughness: null, produced_mana: ['G'],
      });
      expect(forest.kind).toBe('basic-land');
      expect(forest.script?.abilities).toEqual([
        { cost: { tap: true }, description: '{T}: Add {G}.', produces: ['G'] },
      ]);
      expect(forest.script?.entersTapped).toBeUndefined();
    });

    it('reads a dual land as two abilities, not one making two colours', () => {
      /*
        The same shape the hand-written Guildgates use, for the same reason: `manaSources` collapses
        several free tap-for-mana abilities on one permanent into one source making *one of* its
        colours. A single ability listing both would be two mana off one land, and the engine would
        start offering two-drops that cannot be paid for.
      */
      const gate = built({
        name: 'Selesnya Guildgate', type_line: 'Land — Gate', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['G', 'W'],
        oracle_text: 'Selesnya Guildgate enters the battlefield tapped.\n{T}: Add {G} or {W}.',
      });
      expect(gate.kind).toBe('mana-source');
      expect(gate.script?.entersTapped).toBe(true);
      expect(gate.script?.abilities?.map((a) => a.produces)).toEqual([['G'], ['W']]);
    });

    it('reads the newer "enters tapped" wording too', () => {
      const land = built({
        name: 'Test Vista', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['U'],
        oracle_text: 'Test Vista enters tapped.\n{T}: Add {U}.',
      });
      expect(land.script?.entersTapped).toBe(true);
    });

    it('reads a five-colour tap line as five abilities', () => {
      const tower = built({
        name: 'Test Tower', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['W', 'U', 'B', 'R', 'G'],
        oracle_text: '{T}: Add {W}, {U}, {B}, {R}, or {G}.',
      });
      expect(tower.script?.abilities).toHaveLength(5);
    });

    it('builds a vanilla creature with no script at all', () => {
      const bear = built({ name: 'Grizzly Bears', oracle_text: '' });
      expect(bear.kind).toBe('vanilla-creature');
      // No script, and that is the finding rather than an omission: a body needs nothing.
      expect(bear.script).toBeUndefined();
      expect(bear.def.power).toBe('2');
      expect(bear.def.toughness).toBe('2');
    });

    it('builds a creature whose whole text is keywords', () => {
      const hawk = built({ name: 'Test Hawk', oracle_text: 'Flying, vigilance' });
      expect(hawk.kind).toBe('keyword-creature');
      expect(hawk.script).toBeUndefined();
    });

    it('builds a blank artifact, but not a blank Aura', () => {
      expect(built({
        name: 'Test Rock', type_line: 'Artifact', oracle_text: '', mana_cost: '{2}',
        cmc: 2, colors: [], power: null, toughness: null,
      }).kind).toBe('blank-permanent');
      expect(why({
        name: 'Test Aura', type_line: 'Enchantment — Aura', oracle_text: '', mana_cost: '{2}',
        cmc: 2, colors: [], power: null, toughness: null,
      })).toContain('has to say what it enchants');
    });
  });

  describe('the cards it refuses, and what it says about them', () => {
    it('refuses a size that comes from an ability rather than a number', () => {
      /*
        The probe that preceded this module settled what shipping one would do: a `*`/`*` creature
        cast with no script went straight to the graveyard, correctly, because its size comes from
        a characteristic-defining ability nobody read and it is therefore a 0/0 (CR 704.5f). A card
        that dies on arrival every time is strictly worse than a card you move by hand.
      */
      expect(why({ power: '*', toughness: '*' })).toContain('comes from an ability, not a number');
      expect(why({ power: '1+*', toughness: '2' })).toContain('not a number');
      expect(why({ power: '2', toughness: '?' })).toContain('not a number');
    });

    it('refuses a card with more than one face', () => {
      for (const layout of ['split', 'adventure', 'modal_dfc', 'transform', 'flip']) {
        expect(why({ layout })).toContain('more than one face');
      }
    });

    it('refuses a mana ability that makes two mana, rather than guessing one', () => {
      /*
        The Sol Ring case, and the reason `produced_mana` is a cross-check rather than the source.
        That field says *which* colours a permanent makes — `["C"]` — and says nothing about how
        many. A derivation that read the field and ignored the text would ship a Sol Ring that taps
        for one, which is wrong in the direction that loses games.
      */
      expect(why({
        name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', mana_cost: '{1}',
        cmc: 1, colors: [], power: null, toughness: null, produced_mana: ['C'],
      })).toContain('cannot read the line "{T}: Add {C}{C}."');
    });

    it('refuses a mana ability with a cost beyond tapping', () => {
      expect(why({
        name: 'City of Brass', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['W', 'U', 'B', 'R', 'G'],
        oracle_text: 'Whenever City of Brass becomes tapped, it deals 1 damage to you.'
          + '\n{T}: Add one mana of any color.',
      })).toContain('cannot read the line');
    });

    it('refuses a land whose text it cannot account for in full', () => {
      // The leftover line is quoted, so an unhandled shape is a finding and not an approximation.
      const refusal = why({
        name: 'Test Bog', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['B'],
        oracle_text: 'Test Bog enters tapped.\n{T}: Add {B}.'
          + '\nWhen Test Bog enters, exile target player’s graveyard.',
      });
      expect(refusal).toContain('When Test Bog enters, exile target player');
    });

    it('refuses a land when its text and its data disagree about the mana', () => {
      /*
        Both directions. A colour Scryfall claims and the text does not mention means there is an
        ability this module did not parse; a colour the parse produced and Scryfall does not claim
        means the parse invented mana. Either way this module has misread the card, and a misread
        mana base is a deck that cannot cast its own spells.
      */
      const missing = why({
        name: 'Test Delta', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['U', 'B'], oracle_text: '{T}: Add {U}.',
      });
      expect(missing).toContain('the data says it makes [BU]');
      expect(missing).toContain('its text reads as [U]');

      const extra = why({
        name: 'Test Mesa', type_line: 'Basic Land — Mountain', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['W'],
      });
      expect(extra).toContain('reads as [R]');
    });

    it('refuses a land whose data never says what mana it makes', () => {
      expect(why({
        name: 'Test Waste', type_line: 'Land', oracle_text: '', mana_cost: '', cmc: 0,
        colors: [], power: null, toughness: null,
      })).toContain('nothing in its data says what mana it makes');
    });

    it('refuses the card shapes that are nothing but their text', () => {
      expect(why({
        name: 'Lightning Bolt', type_line: 'Instant', mana_cost: '{R}', cmc: 1, colors: ['R'],
        power: null, toughness: null, oracle_text: 'Lightning Bolt deals 3 damage to any target.',
      })).toContain('nothing but what its text does');
      expect(why({
        name: 'Test Walker', type_line: 'Legendary Planeswalker — Test', mana_cost: '{3}{G}',
        cmc: 4, colors: ['G'], power: null, toughness: null, loyalty: '3',
        oracle_text: '+1: Draw a card.',
      })).toContain("loyalty abilities are its text");
    });

    it('refuses a creature whose text has rules in it', () => {
      expect(why({ oracle_text: 'When Test Card enters, draw a card.' }))
        .toContain('cannot read the line "When Test Card enters, draw a card."');
      // And a keyword line beside a rules line is still a refusal: it is not "mostly readable".
      expect(why({ oracle_text: 'Flying\nWhenever Test Card attacks, you gain 1 life.' }))
        .toContain('Whenever Test Card attacks');
    });

    it('refuses a row with nothing to go on', () => {
      expect(cardFromData({})).toEqual({ ok: false, why: 'the row has no name' });
      expect(cardFromData({ name: 'Nameless Type' }))
        .toEqual({ ok: false, why: 'Nameless Type: the row has no type line' });
    });
  });

  describe('reading the columns as the database holds them', () => {
    it('takes a JSON string where a list is expected, because that is what TEXT columns give', () => {
      // `scryfall_cards` stores these as TEXT (migration 0015). A caller reading straight from
      // Postgres should not have to normalise first, because one that must will forget.
      const forest = built({
        name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '', mana_cost: '', cmc: 0,
        colors: '[]', power: null, toughness: null, produced_mana: '["G"]',
      });
      expect(forest.script?.abilities?.[0]?.produces).toEqual(['G']);
    });

    it('survives a malformed JSON column rather than throwing', () => {
      const forest = built({
        name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '', mana_cost: '', cmc: 0,
        colors: '{not json', power: null, toughness: null, produced_mana: 'also not json',
      });
      // No cross-check is possible, so the intrinsic subtype ability stands on its own.
      expect(forest.script?.abilities?.[0]?.produces).toEqual(['G']);
      expect(forest.def.colors).toEqual([]);
    });
  });

  describe('tallying a batch', () => {
    it('counts what it built by kind and keeps every refusal reason', () => {
      const tally = tallyDerivations([
        row({ name: 'Bear A', oracle_text: '' }),
        row({ name: 'Bear B', oracle_text: 'Flying' }),
        row({ name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '', mana_cost: '', cmc: 0, colors: [], power: null, toughness: null }),
        row({ name: 'Starry', power: '*', toughness: '*' }),
        row({ name: 'Bolt', type_line: 'Instant', power: null, toughness: null, oracle_text: 'Deals 3 damage.' }),
      ]);
      expect(tally.built).toBe(3);
      expect(tally.byKind['vanilla-creature']).toBe(1);
      expect(tally.byKind['keyword-creature']).toBe(1);
      expect(tally.byKind['basic-land']).toBe(1);
      // The reasons, not just the count: a count says nothing about what to script next.
      expect(tally.refused).toHaveLength(2);
      expect(tally.refused[0]).toContain('Starry');
      expect(tally.refused[1]).toContain('Bolt');
    });
  });
});

describe('a derived card at a real table', () => {
  const defOf = (over: Partial<CardDataRow>): CardDef => built(over).def;

  const FOREST = defOf({
    name: 'Derived Forest', type_line: 'Basic Land — Forest', oracle_text: '({T}: Add {G}.)',
    mana_cost: '', cmc: 0, colors: [], power: null, toughness: null, produced_mana: ['G'],
  });
  const GATE = defOf({
    name: 'Derived Gate', type_line: 'Land — Gate', mana_cost: '', cmc: 0, colors: [],
    power: null, toughness: null, produced_mana: ['G'],
    oracle_text: 'Derived Gate enters the battlefield tapped.\n{T}: Add {G}.',
  });
  const BEAR = defOf({ name: 'Derived Bear', oracle_text: '' });
  const HAWK = defOf({ name: 'Derived Hawk', oracle_text: 'Flying, vigilance', power: '1', toughness: '2' });

  const DECK: DeckSpec = {
    id: 'derived', name: 'Derived', description: 'every card built from its data',
    cards: [
      { card: BEAR, count: 8 }, { card: HAWK, count: 8 },
      { card: FOREST, count: 36 }, { card: GATE, count: 8 },
    ],
  };

  const table = (over: Parameters<typeof arena>[0] = {}) => arena({
    deckSpecs: { derived: DECK }, decks: { 0: 'derived', 1: 'derived' }, ...over,
  });

  it('taps a derived land for mana, which an unscripted land never did', () => {
    /*
      The whole reason this module exists. Before it, `manaSources` on a board of three lands with
      `{T}: Add {G}.` printed on them returned `[]` and the potential pool was all zeros — the
      engine reads mana abilities off the script and nowhere else, so a deck of data-derived cards
      could not cast a single spell.
    */
    const s = advanceTo(table({
      battlefield: { 0: ['Derived Forest', 'Derived Forest', 'Derived Forest'] }, turn: 3,
    }), 'precombat-main');
    expect(manaSources(s, 0)).toHaveLength(3);
    expect(potentialMana(s, 0).G).toBe(3);
    expect(legalActions(s, 0).plays.filter((p) => p.kind === 'activate')).toHaveLength(3);
  });

  it('arrives tapped when its one line of text says so', () => {
    let s = advanceTo(table({ hands: { 0: ['Derived Gate'] }, turn: 3 }), 'precombat-main');
    const gate = find(s, 0, 'hand', 'Derived Gate');
    s = apply(s, { type: 'auto:playLand', by: 0, card: gate });
    expect(s.instances[gate]!.tapped).toBe(true);
    // And a land with no such line does not, which is what makes the assertion above mean anything.
    let t = advanceTo(table({ hands: { 0: ['Derived Forest'] }, turn: 3 }), 'precombat-main');
    const forest = find(t, 0, 'hand', 'Derived Forest');
    t = apply(t, { type: 'auto:playLand', by: 0, card: forest });
    expect(t.instances[forest]!.tapped).toBe(false);
  });

  it('casts a derived creature off derived mana, and it is the body its data printed', () => {
    let s = advanceTo(table({
      hands: { 0: ['Derived Bear'] },
      battlefield: { 0: ['Derived Forest', 'Derived Forest'] }, turn: 3,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Derived Bear') });
    s = drain(passBoth(s));
    const bear = find(s, 0, 'battlefield', 'Derived Bear');
    const ch = characteristicsOf(s, s.instances[bear]!);
    expect(ch.power).toBe(2);
    expect(ch.toughness).toBe(2);
    expect(ch.isCreature).toBe(true);
  });

  it('gives a derived creature the keywords its text prints, with no script', () => {
    let s = advanceTo(table({
      hands: { 0: ['Derived Hawk'] },
      battlefield: { 0: ['Derived Forest', 'Derived Forest'] }, turn: 3,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Derived Hawk') });
    s = drain(passBoth(s));
    const hawk = find(s, 0, 'battlefield', 'Derived Hawk');
    const ch = characteristicsOf(s, s.instances[hawk]!);
    expect([...ch.keywords].sort()).toEqual(['flying', 'vigilance']);
    expect(scriptForCard(s.cardDefs[s.instances[hawk]!.defKey])).toBeUndefined();
  });

  it('attacks with a derived creature, which is the end of the path', () => {
    let s = advanceTo(table({
      battlefield: { 0: ['Derived Bear', 'Derived Forest'] }, turn: 3,
    }), 'declare-attackers');
    const bear = find(s, 0, 'battlefield', 'Derived Bear');
    expect(legalActions(s, 0).attackers).toContain(bear);
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: bear, defender: 1 }] });
    s = drain(advanceTo(s, 'postcombat-main'));
    expect(s.seats[1]!.life).toBe(18);
  });

  it('plays an opening hand out over several turns without stalling', () => {
    /*
      A deck whose every card is derived, played by the engine's own auto-pass from a real opening
      hand rather than from a board placed card by card. The assertion is deliberately coarse —
      lands came down, creatures got cast, nobody is stuck — because the specific thing that used
      to happen here is that the mana base did nothing and the game went nowhere at all.
    */
    let s = table({ turn: 1, autoPass: true });
    for (let i = 0; i < 40 && s.turn <= 8 && s.winnerSeat === null; i++) {
      // `priority` is nullable — nobody is on the clock while the engine is settling — and a loop
      // that read it as a seat would be the shape #302 was about.
      const seat = s.priority;
      if (seat === null) { s = drain(s); continue; }
      const acts = legalActions(s, seat);
      const land = acts.plays.find((p) => p.kind === 'land');
      const cast = acts.plays.find((p) => p.kind === 'cast');
      if (land !== undefined) s = apply(s, { type: 'auto:playLand', by: seat, card: land.card });
      else if (cast !== undefined) {
        s = tapAllLands(s, seat);
        const after = legalActions(s, seat).plays.find((p) => p.kind === 'cast');
        s = after === undefined ? apply(s, { type: 'auto:pass', by: seat })
          : apply(s, { type: 'auto:cast', by: seat, card: after.card });
      } else s = apply(s, { type: 'auto:pass', by: seat });
      s = drain(s);
    }
    const onBoard = [...ids(s, 0, 'battlefield')].map((id) => nameOf(s, id));
    expect(onBoard.filter((n) => n.includes('Forest') || n.includes('Gate')).length)
      .toBeGreaterThan(0);
    expect(s.turn).toBeGreaterThan(1);
  });

  it('never overrides a hand-written script, which is what keeps the pool unchanged', () => {
    /*
      The guard on everything above. `scriptForCard` consults `scriptFor` first, so all 348 cards in
      the pool read exactly as they did before this module existed and derivation only ever reaches
      a card nobody has written. A definition carrying a pool card's name with *different* data must
      still play as the pool card.
    */
    const impostor: CardDef = {
      name: 'Forest', typeLine: 'Basic Land — Island', manaCost: '', cmc: 0,
      oracleText: '{T}: Add {U}.', colors: [],
    };
    const script = scriptForCard(impostor);
    expect(script).toBe(scriptFor('Forest'));
    expect(script?.abilities?.[0]?.produces).toEqual(['G']);
  });

  it('leaves cardboard as cardboard', () => {
    // A card with no type line is what a pasted name the pool does not have becomes, and the first
    // check in `cardFromData` refuses it. Nothing here makes it playable by accident.
    const cardboard: CardDef = {
      name: 'Some Card Nobody Has', typeLine: '', manaCost: '', cmc: 0,
      oracleText: 'This card is not in the engine’s pool. Move it by hand.', colors: [],
    };
    expect(scriptForCard(cardboard)).toBeUndefined();
  });
});
