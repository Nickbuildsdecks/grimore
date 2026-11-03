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
import { cardFromData, type CardDataRow } from './fromCardData.js';
import { scriptForCard, scriptFor } from './scripts.js';
import { STARTER_DECKS } from './starterDecks.js';
import { arena, apply, find, ids, nameOf, advanceTo, passBoth, drain, tapAllLands, nextTurn } from './testkit.js';
import { legalActions, manaSources, potentialMana } from './legalActions.js';
import { characteristicsOf, printedKeywords } from './characteristics.js';
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

    it('reads a cycling land: the mana, the tapped clause and the cantrip', () => {
      /*
        Five of the eleven lands this pool refuses were cycling lands, which is why this is worth
        having at all — see D338. The text is the hand-written helper's own, reminder text included,
        because that is what a real card prints.
      */
      const thicket = built({
        name: 'Tranquil Thicket', type_line: 'Land — Forest', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['G'],
        oracle_text: 'Tranquil Thicket enters the battlefield tapped.\n{T}: Add {G}.'
          + '\nCycling {2} ({2}, Discard this card: Draw a card.)',
      });
      expect(thicket.kind).toBe('mana-source');
      expect(thicket.script?.entersTapped).toBe(true);
      const abilities = thicket.script?.abilities ?? [];
      // Mana first, cycling after, so the script reads like its hand-written twin.
      expect(abilities).toHaveLength(2);
      expect(abilities[0]?.produces).toEqual(['G']);
      expect(abilities[1]?.cost).toEqual({ mana: '{2}', discardSelf: true });
      expect(abilities[1]?.produces).toBeUndefined();
      expect(abilities[1]?.effect).toBeTypeOf('function');
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

    it('reads a keyword that carries a cost into the field the engine already has', () => {
      /*
        Morph, megamorph and echo are implemented mechanics whose only card-specific parameter is a
        cost, which makes them the same shape of derivation as a mana ability: the engine knows what
        the mechanic does, the data supplies the number, and nothing is inferred. `printedKeywords`
        cannot see them because it reads a keyword as a bare word, so `Morph {1}{G}` had been
        reading as a line with rules in it.
      */
      const morph = built({ name: 'Test Morpher', oracle_text: 'Morph {1}{G}' });
      expect(morph.kind).toBe('costed-keyword-creature');
      expect(morph.script?.morph).toEqual({ cost: { mana: '{1}{G}' } });

      const mega = built({ name: 'Test Megamorpher', oracle_text: 'Flying\nMegamorph {2}{W}' });
      // One flag is the whole difference between the two keywords, and the flying still reads.
      expect(mega.script?.morph).toEqual({ cost: { mana: '{2}{W}' }, mega: true });

      const echo = built({ name: 'Test Echoer', oracle_text: 'Echo {2}{G}' });
      expect(echo.script?.echo).toEqual({ cost: '{2}{G}' });
    });

    it('strips the reminder text a printed echo line carries', () => {
      // The pool's own wording: `Echo {1}{R} (At the beginning of your upkeep, ...)`. The bracket
      // is a reminder and would otherwise make the line unparseable.
      const echo = built({
        name: 'Test Echoer',
        oracle_text: 'Echo {1}{R} (At the beginning of your upkeep, if this came under your'
          + ' control since your last upkeep, sacrifice it unless you pay its echo cost.)',
      });
      expect(echo.script?.echo).toEqual({ cost: '{1}{R}' });
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

    it('refuses a token for being a token, not for having faces it does not have', () => {
      /*
        These used to fall through to the multi-face check and come back as "layout token has more
        than one face", which is simply false — a token has one. Found by running the `--file` arm
        of `derivable.mjs` for the first time, against a fixture with a token in it; on a real
        `oracle_cards` file, which lists tokens as their own entries, the false message would have
        been printed thousands of times and sent the next reader hunting a bug that is not there.
      */
      for (const layout of ['token', 'double_faced_token', 'emblem', 'art_series', 'memorabilia']) {
        const refusal = why({ layout });
        expect(refusal).toContain('is not a card');
        expect(refusal).not.toContain('more than one face');
      }
    });

    it('refuses a mana ability that mixes a sum with a choice', () => {
      /*
        `Add {G}{G} or {W}` — two green or one white. Nothing in this pool prints it, and the shape
        is rare enough in Magic that the merge rule it needs at the call site would be written once
        and read by nobody. A sum has to be the only mana the permanent makes.
      */
      expect(why({
        name: 'Awkward Rock', type_line: 'Artifact', oracle_text: '{T}: Add {G}{G} or {W}.',
        mana_cost: '{2}', cmc: 2, colors: [], power: null, toughness: null,
        produced_mana: ['G', 'W'],
      })).toContain('cannot read the line');
    });

    it('refuses a sum alongside a second mana ability', () => {
      expect(why({
        name: 'Two Rocks In One', type_line: 'Artifact', mana_cost: '{3}', cmc: 3, colors: [],
        power: null, toughness: null, produced_mana: ['C', 'G'],
        oracle_text: '{T}: Add {C}{C}.\n{T}: Add {G}.',
      })).toContain('adds several mana and also adds mana some other way');
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

    it('refuses a morph cost that is not mana, rather than guessing at it', () => {
      /*
        `Morph — Pay 3 life.` is in this pool. The script field takes an `AbilityCost` precisely
        because a morph cost is not always mana — but a cost this reader cannot parse is a cost it
        must not invent, and a turn-up priced wrong is a turn-up the player cannot plan around.
      */
      expect(why({ name: 'Test Cutthroat', oracle_text: 'Morph \u2014 Pay 3 life.' }))
        .toContain('cannot read the line');
    });

    it('refuses a card printing the same costed keyword twice', () => {
      // Not a card that exists; refused rather than silently keeping one of the two.
      expect(why({ name: 'Test Twice', oracle_text: 'Morph {1}{G}\nMorph {2}{G}' }))
        .toContain('cannot read the line "Morph {2}{G}"');
    });

    it('still refuses a morph creature that also has a trigger, which most of them do', () => {
      /*
        The measured limit of the increment above, stated as a test. Six of the pool's morph
        creatures have text *besides* the morph line — a turned-face-up trigger is the whole reason
        most morph cards are printed — so teaching the reader the cost bought **two** cards here,
        not six. On cards printed as a body plus a morph line it buys more, which is a claim this
        pool cannot check and so is not made anywhere as a number.
      */
      expect(why({
        name: 'Test Ainok',
        oracle_text: 'Morph {1}{G}\nWhen Test Ainok is turned face up, destroy target artifact.',
      })).toContain('When Test Ainok is turned face up');
    });

    it('refuses typed cycling, which searches a library rather than drawing', () => {
      /*
        Landcycling and its relatives — "Swampcycling {2}", "Basic landcycling {1}{G}" — are a
        different ability with a different prompt: they search a library, where plain cycling draws.
        CR 702.29a defines only the typeless version as "Discard this card: Draw a card", so the
        typed ones are refused rather than treated as cantrips.
      */
      expect(why({
        name: 'Test Cycler', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        power: null, toughness: null, produced_mana: ['B'],
        oracle_text: '{T}: Add {B}.\nSwampcycling {2}',
      })).toContain('cannot read the line "Swampcycling {2}"');
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
});

/**
 * Mana that is not a land, checked against the pool's own hand-written cards.
 *
 * These three are the strongest verification available to this module, and they are strong for a
 * reason that has nothing to do with me: **somebody built each of them by hand, from the printed
 * card, before this module existed.** So the assertion is not "the derivation matches what I think
 * a Sol Ring does" — which is the assertion a test I wrote about a parser I wrote would otherwise
 * be making, and it is worth nothing. It is "the derivation matches the card that has been in
 * thirteen decks and several thousand games".
 *
 * Each row is built from the pool's own `CardDef` — its real printed type line, mana cost and
 * oracle text — and the derived script is compared against `scriptFor(name)`, the hand-written one.
 */
describe('a mana source that is not a land, against its hand-written twin', () => {
  const poolDef = (name: string): CardDef => {
    for (const deck of Object.values(STARTER_DECKS)) {
      for (const entry of deck.cards) if (entry.card.name === name) return entry.card;
      if (deck.commander?.name === name) return deck.commander;
    }
    throw new Error(`${name} is not in the pool`);
  };

  /** A data row as the importer would write it, from the printed fields the pool already holds. */
  const rowFor = (name: string, producedMana: string[]): CardDataRow => {
    const def = poolDef(name);
    return {
      name: def.name, type_line: def.typeLine, oracle_text: def.oracleText,
      mana_cost: def.manaCost, cmc: def.cmc, colors: [...def.colors], layout: 'normal',
      power: def.power ?? null, toughness: def.toughness ?? null, produced_mana: producedMana,
    };
  };

  const derivedAbilities = (name: string, producedMana: string[]) => {
    const result = cardFromData(rowFor(name, producedMana));
    if (!result.ok) throw new Error(`${name}: expected a card, got: ${result.why}`);
    return result;
  };

  it('derives a Sol Ring that taps for two, matching the hand-written one', () => {
    /*
      The card that was cardboard until now, and the one the module's own header used as the reason
      for refusing every sum. The header's argument is against reading `produced_mana` — which says
      `["C"]` and nothing about quantity — and this parse does not read it for quantity. The text
      says two.
    */
    const result = derivedAbilities('Sol Ring', ['C']);
    expect(result.kind).toBe('mana-source');
    expect(result.script?.abilities).toEqual(scriptFor('Sol Ring')?.abilities);
    // Stated outright, so this is not only "the same as the other thing": one ability, two mana.
    expect(result.script?.abilities).toHaveLength(1);
    expect(result.script?.abilities?.[0]?.produces).toEqual(['C', 'C']);
  });

  it('derives Birds of Paradise as five abilities, and keeps its flying', () => {
    // `Add one mana of any color` is a choice of five, which is five abilities — `manaSources`
    // collapses them into one source that makes one of them. One ability producing WUBRG would be
    // five mana off a 0/1.
    const result = derivedAbilities('Birds of Paradise', ['W', 'U', 'B', 'R', 'G']);
    expect(result.kind).toBe('mana-creature');
    expect(result.script?.abilities).toEqual(scriptFor('Birds of Paradise')?.abilities);
    expect(result.script?.abilities).toHaveLength(5);
    // The keyword is not in the derived script: `printedKeywords` reads `Flying` off the card's own
    // text, which is why the hand-written script's `keywords` field has no derived counterpart.
    expect(printedKeywords(result.def.oracleText)).toContain('flying');
  });

  it('derives Llanowar Elves, the plainest mana dork there is', () => {
    const result = derivedAbilities('Llanowar Elves', ['G']);
    expect(result.kind).toBe('mana-creature');
    expect(result.script?.abilities).toEqual(scriptFor('Llanowar Elves')?.abilities);
    expect(result.def.power).toBe('1');
  });

  it('still refuses Mind Stone, whose second ability is half the card', () => {
    /*
      The negative that keeps the positives honest. Mind Stone prints the same first line as a
      derivable rock and then `{1}, {T}, Sacrifice Mind Stone: Draw a card.` — a different cost, a
      different effect, and the reason anybody plays it late. A derivation that shipped the mana
      half and dropped the draw would be a card that silently does less than it reads, which is the
      failure this module is built to avoid.
    */
    const result = cardFromData(rowFor('Mind Stone', ['C']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain('Sacrifice Mind Stone');
  });

  it('still refuses Mana Confluence, whose mana costs a life', () => {
    const result = cardFromData(rowFor('Mana Confluence', ['W', 'U', 'B', 'R', 'G']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain('Pay 1 life');
  });

  it('refuses a rock whose colours disagree with the data', () => {
    // The cross-check, on the branch that just gained it. A rock whose text reads as colourless
    // while the data says it makes green is a rock this module has misread.
    const result = cardFromData(rowFor('Sol Ring', ['G']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain('the data says it makes [G]');
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
  const DORK = defOf({
    name: 'Derived Druid', type_line: 'Creature — Elf Druid', mana_cost: '{G}', cmc: 1,
    colors: ['G'], power: '1', toughness: '1', oracle_text: '{T}: Add {G}.', produced_mana: ['G'],
  });
  const ROCK = defOf({
    name: 'Derived Ring', type_line: 'Artifact', mana_cost: '{1}', cmc: 1, colors: [],
    power: null, toughness: null, oracle_text: '{T}: Add {C}{C}.', produced_mana: ['C'],
  });
  const BEAST = defOf({
    name: 'Derived Beast', type_line: 'Creature — Beast', mana_cost: '{3}', cmc: 3, colors: [],
    power: '3', toughness: '3', oracle_text: '',
  });

  const DECK: DeckSpec = {
    id: 'derived', name: 'Derived', description: 'every card built from its data',
    cards: [
      { card: BEAR, count: 8 }, { card: HAWK, count: 8 }, { card: BEAST, count: 4 },
      { card: DORK, count: 4 }, { card: ROCK, count: 4 },
      { card: FOREST, count: 24 }, { card: GATE, count: 8 },
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

  it('taps a derived rock for two mana, which is the whole of the Sol Ring argument', () => {
    /*
      The discriminating assertion for the sum. A derivation that read `produced_mana` — `["C"]` —
      would put one colourless in the pool here, and so would a parse that read `{T}: Add {C}{C}.`
      as a choice. Two is the only reading the card supports, and it is the number this checks.
    */
    const s = advanceTo(table({ battlefield: { 0: ['Derived Ring'] }, turn: 3 }), 'precombat-main');
    expect(manaSources(s, 0)).toHaveLength(1);
    expect(potentialMana(s, 0).C).toBe(2);
  });

  it('casts a three-drop off two derived rocks with no land on the board', () => {
    /*
      A board with no lands at all, which is the version of this that cannot be passed by accident:
      every mana paying for the Beast comes from a derived artifact's derived ability. Before this
      change the rocks were cardboard and this board could cast nothing.
    */
    let s = advanceTo(table({
      hands: { 0: ['Derived Beast'] },
      battlefield: { 0: ['Derived Ring', 'Derived Ring'] }, turn: 3,
    }), 'precombat-main');
    expect(potentialMana(s, 0).C).toBe(4);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Derived Beast') });
    s = drain(passBoth(s));
    const beast = find(s, 0, 'battlefield', 'Derived Beast');
    expect(characteristicsOf(s, s.instances[beast]!).power).toBe(3);
  });

  it('taps a derived dork for mana, but not the turn it arrives (CR 302.6)', () => {
    let s = advanceTo(table({
      hands: { 0: ['Derived Druid'] },
      battlefield: { 0: ['Derived Forest'] }, turn: 3,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Derived Druid') });
    s = drain(passBoth(s));
    const dork = find(s, 0, 'battlefield', 'Derived Druid');

    /*
      Summoning sickness, which is the one way a dork differs from a land and is the engine's own
      rule rather than anything this module does. The assertion is here because it is the thing a
      player would notice if it were wrong: a bird that taps the turn it lands is a bird that casts
      a spell it should not be able to cast.
    */
    expect(manaSources(s, 0).some((src) => src.key === dork)).toBe(false);

    /*
      Two turns on it is one, and the count says which. The forest paid for the druid and is tapped,
      so green on the arrival turn is 0; after an untap step the board is a forest and a druid, and
      two is the only reading in which the druid is being counted.
    */
    expect(potentialMana(s, 0).G).toBe(0);
    const later = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(manaSources(later, 0).some((src) => src.key === dork)).toBe(true);
    expect(potentialMana(later, 0).G).toBe(2);
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

  it('cycles a derived land from the hand, drawing a card and leaving it in the graveyard', () => {
    /*
      The end of the path for the one derived ability that **runs code** rather than stating a
      cost. Everything before this is a cost or a keyword the engine already reads; a cycling
      ability carries an `effect`, is offered from the **hand** rather than the battlefield because
      of `discardSelf`, and has to actually draw. So it is driven rather than inspected.
    */
    const THICKET = defOf({
      name: 'Derived Thicket', type_line: 'Land — Forest', mana_cost: '', cmc: 0, colors: [],
      power: null, toughness: null, produced_mana: ['G'],
      oracle_text: 'Derived Thicket enters the battlefield tapped.\n{T}: Add {G}.'
        + '\nCycling {2} ({2}, Discard this card: Draw a card.)',
    });
    const CYCLE_DECK: DeckSpec = {
      id: 'cycle', name: 'Cycling', description: 'a derived cycling land',
      cards: [{ card: THICKET, count: 12 }, { card: FOREST, count: 48 }],
    };
    let s = advanceTo(arena({
      deckSpecs: { cycle: CYCLE_DECK }, decks: { 0: 'cycle', 1: 'cycle' },
      hands: { 0: ['Derived Thicket'] },
      battlefield: { 0: ['Derived Forest', 'Derived Forest'] }, turn: 3,
    }), 'precombat-main');

    const held = find(s, 0, 'hand', 'Derived Thicket');
    const cycle = legalActions(s, 0).plays
      .find((p) => p.kind === 'activate' && p.card === held);
    expect(cycle, 'cycling is offered on the card in hand').toBeDefined();

    const handBefore = ids(s, 0, 'hand').length;
    s = tapAllLands(s, 0);
    s = apply(s, {
      type: 'auto:activate', by: 0, card: held, abilityIndex: cycle!.abilityIndex ?? 0,
    });
    s = drain(passBoth(s));

    /*
      The card is in the graveyard and a replacement is in hand. Checked by **instance id**, not by
      name: the deck is twelve of these, so the card drawn is quite often another Derived Thicket,
      and the first draft of this assertion read the hand by name and failed for that reason. The
      claim is "this card left and a card arrived", which only ids can say.
    */
    expect([...ids(s, 0, 'graveyard')]).toContain(held);
    expect([...ids(s, 0, 'hand')]).not.toContain(held);
    expect(ids(s, 0, 'hand').length, 'the cantrip replaced the card it discarded')
      .toBe(handBefore);
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
