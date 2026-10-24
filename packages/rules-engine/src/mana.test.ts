/**
 * Mana costs and pools, and what a permanent currently is.
 *
 * These two modules are pure functions under everything else in the engine, so they are tested
 * directly rather than through a game. If `payCost` picks the wrong mana or `characteristicsOf`
 * adds a pump twice, every test above here fails in a way that points somewhere else.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_POOL,
  addMana,
  canPay,
  characteristicsOf,
  costColors,
  costValue,
  maxX,
  parseManaCost,
  parseTypeLine,
  payCost,
  poolToString,
  poolTotal,
  printedKeywords,
  shortColors,
  solveTap,
  withAdditionalGeneric,
  type ManaPool,
} from './index.js';
import { arena, find } from './testkit.js';

const pool = (p: Partial<ManaPool>): ManaPool => ({ ...EMPTY_POOL, ...p });

describe('parseManaCost', () => {
  it('reads generic, coloured and colourless symbols', () => {
    const cost = parseManaCost('{4}{R}{R}');
    expect(cost.generic).toBe(4);
    expect(cost.colors.R).toBe(2);
    expect(cost.x).toBe(false);
    expect(costValue(cost)).toBe(6);
    expect(costColors(cost)).toEqual(['R']);
  });

  it('treats a free or absent cost as {0}', () => {
    for (const text of ['', null, undefined, '{}']) {
      expect(costValue(parseManaCost(text))).toBe(0);
    }
  });

  it('adds up repeated generic symbols rather than keeping the last', () => {
    expect(parseManaCost('{2}{1}').generic).toBe(3);
  });

  it('notes {X} without counting it towards the cost', () => {
    const cost = parseManaCost('{X}{R}');
    expect(cost.x).toBe(true);
    expect(costValue(cost)).toBe(1);
  });

  it('refuses a hybrid or phyrexian cost instead of mis-reading it as generic', () => {
    // Reading {R/G} as generic would offer the player a spell they cannot actually cast, which is
    // worse than refusing a card no deck currently contains.
    expect(parseManaCost('{R/G}').unsupported).toBe('R/G');
    expect(parseManaCost('{R/P}').unsupported).toBe('R/P');
    expect(parseManaCost('{2}{S}').unsupported).toBe('S');
    expect(canPay(pool({ R: 9, G: 9, C: 9 }), parseManaCost('{R/G}'))).toBe(false);
  });

  it('reports the first unsupported symbol it meets, not the last', () => {
    expect(parseManaCost('{R/G}{W/U}').unsupported).toBe('R/G');
  });

  it('adds commander tax as generic', () => {
    expect(withAdditionalGeneric(parseManaCost('{2}{R}{R}'), 4).generic).toBe(6);
  });
});

describe('payCost', () => {
  it('takes coloured requirements from the matching colour', () => {
    const result = payCost(pool({ R: 2, G: 1 }), parseManaCost('{R}{R}'));
    expect(result.paid).toBe(true);
    expect(result.pool).toEqual(pool({ G: 1 }));
  });

  it('refuses when a colour is missing, and says which', () => {
    const result = payCost(pool({ G: 5 }), parseManaCost('{R}'));
    expect(result.paid).toBe(false);
    expect(result.shortfall).toContain('{R}');
    expect(result.pool).toEqual(pool({ G: 5 }));
  });

  it('spends colourless before colour for the generic part', () => {
    const result = payCost(pool({ C: 2, R: 2 }), parseManaCost('{2}'));
    expect(result.pool).toEqual(pool({ R: 2 }));
  });

  it('spends the most plentiful colour first, so a scarce colour is not stranded', () => {
    // Paying {1} out of the single G would strand a green spell while two R sat unused.
    const result = payCost(pool({ R: 2, G: 1 }), parseManaCost('{1}'));
    expect(result.pool).toEqual(pool({ R: 1, G: 1 }));
  });

  it('pays the coloured part before the generic, even when the generic could have eaten it', () => {
    // {1}{R} out of exactly one R and one G has only one solution; a generic-first payment would
    // spend the R on the {1} and then fail.
    const result = payCost(pool({ R: 1, G: 1 }), parseManaCost('{1}{R}'));
    expect(result.paid).toBe(true);
    expect(result.pool).toEqual(EMPTY_POOL);
  });

  it('counts X towards the generic part', () => {
    expect(canPay(pool({ R: 1, G: 3 }), parseManaCost('{X}{R}'), 3)).toBe(true);
    expect(canPay(pool({ R: 1, G: 2 }), parseManaCost('{X}{R}'), 3)).toBe(false);
  });

  it('reports how much more mana is needed', () => {
    expect(payCost(pool({ R: 1 }), parseManaCost('{4}{R}')).shortfall).toBe('4 more mana needed');
  });

  it('leaves the pool untouched when payment fails', () => {
    const start = pool({ R: 1 });
    expect(payCost(start, parseManaCost('{9}')).pool).toBe(start);
  });
});

describe('maxX', () => {
  it('is the largest X the pool can afford', () => {
    expect(maxX(pool({ R: 1, G: 4 }), parseManaCost('{X}{R}'))).toBe(4);
    expect(maxX(pool({ R: 1 }), parseManaCost('{X}{R}'))).toBe(0);
  });

  it('is zero for a cost with no X at all', () => {
    expect(maxX(pool({ R: 9 }), parseManaCost('{R}'))).toBe(0);
  });
});

describe('solveTap', () => {
  const land = (key: string, type: 'W' | 'U' | 'B' | 'R' | 'G') => ({ key, produces: [type] as const });
  /** The plan as keys, for the assertions that are about which sources were tapped. */
  const keys = (plan: ReturnType<typeof solveTap>): string[] | null =>
    plan === null ? null : plan.map((pick) => pick.key);

  it('taps nothing when the pool already covers the cost', () => {
    expect(solveTap(pool({ R: 1 }), parseManaCost('{R}'), [land('m1', 'R')])).toEqual([]);
  });

  it('taps exactly one source for a one-mana spell', () => {
    expect(keys(solveTap(EMPTY_POOL, parseManaCost('{R}'), [land('m1', 'R'), land('m2', 'R')])))
      .toEqual(['m1']);
  });

  it('taps as many as the generic part needs', () => {
    const sources = [land('m1', 'R'), land('m2', 'R'), land('m3', 'R'), land('m4', 'R')];
    expect(solveTap(EMPTY_POOL, parseManaCost('{3}{R}'), sources)).toHaveLength(4);
  });

  it('taps the fewest permanents it can for the generic part', () => {
    // A source that makes two mana is what a Sol Ring is, and taking the list in order meant
    // tapping a land for one, finding the cost still short, and tapping the Ring as well — three
    // permanents for a cost two could pay, and a land left face down for nothing.
    const ring = { key: 'ring', produces: ['C', 'C'] as const };
    const sources = [land('s1', 'B'), land('m1', 'R'), ring];
    expect(keys(solveTap(EMPTY_POOL, parseManaCost('{2}{B}'), sources))).toEqual(['s1', 'ring']);
  });

  it('and takes a smaller source when the big one would overshoot', () => {
    // One generic left and a choice between a land and a two-mana rock: the land, because the
    // rock's second mana would be floating and the rock might be wanted later.
    const ring = { key: 'ring', produces: ['C', 'C'] as const };
    expect(keys(solveTap(EMPTY_POOL, parseManaCost('{1}{B}'), [land('s1', 'B'), ring, land('m1', 'R')])))
      .toEqual(['s1', 'm1']);
  });

  it('gives up rather than tapping lands that cannot make the colour', () => {
    // Five Forests do not cast a white spell, and tapping them all first would be worse than
    // refusing: the player loses their mana for nothing.
    const forests = ['f1', 'f2', 'f3', 'f4', 'f5'].map((k) => land(k, 'G'));
    expect(solveTap(EMPTY_POOL, parseManaCost('{3}{W}{W}'), forests)).toBeNull();
  });

  it('finds the only solution to a two-colour cost', () => {
    const sources = [land('f1', 'G'), land('f2', 'G'), land('f3', 'G'), land('f4', 'G'), land('p1', 'W')];
    const plan = solveTap(EMPTY_POOL, parseManaCost('{3}{G}{W}'), sources);
    expect(plan).not.toBeNull();
    expect(plan).toHaveLength(5);
    expect(keys(plan)).toContain('p1');
  });

  it('saves a dual land for the colour only it can make', () => {
    // The greedy choice is the least flexible source that makes a short colour, so the Plains pays
    // for the {W} and the dual is left for the {U} nothing else can produce.
    const sources = [
      { key: 'plains', produces: ['W'] as const },
      { key: 'dual', produces: ['U'] as const },
      { key: 'island', produces: ['U'] as const },
    ];
    const plan = solveTap(EMPTY_POOL, parseManaCost('{W}{U}'), sources);
    expect(plan).toHaveLength(2);
    expect(keys(plan)).toContain('plains');
  });

  it('counts a source that makes two mana as two', () => {
    const plan = solveTap(EMPTY_POOL, parseManaCost('{G}{G}'), [{ key: 'tree', produces: ['G', 'G'] }]);
    expect(plan).toEqual([{ key: 'tree', types: ['G', 'G'] }]);
  });

  it('taps a dual for one colour, not for both', () => {
    // The distinction the whole type exists for. Without `choose`, a Guildgate listing ['U','B']
    // reads as two mana and the engine offers a two-drop off one land.
    const gate = { key: 'gate', produces: ['U', 'B'] as const, choose: true };
    expect(solveTap(EMPTY_POOL, parseManaCost('{U}'), [gate]))
      .toEqual([{ key: 'gate', types: ['U'] }]);
    expect(solveTap(EMPTY_POOL, parseManaCost('{B}'), [gate]))
      .toEqual([{ key: 'gate', types: ['B'] }]);
    // One mana, so a two-mana spell is out of reach however many colours it could have made.
    expect(solveTap(EMPTY_POOL, parseManaCost('{U}{B}'), [gate])).toBeNull();
    expect(solveTap(EMPTY_POOL, parseManaCost('{1}{U}'), [gate])).toBeNull();
  });

  it('pays a two-colour cost from two duals, one colour each', () => {
    const gates = [
      { key: 'g1', produces: ['U', 'B'] as const, choose: true },
      { key: 'g2', produces: ['U', 'B'] as const, choose: true },
    ];
    const plan = solveTap(EMPTY_POOL, parseManaCost('{U}{B}'), gates);
    expect(plan).not.toBeNull();
    expect(plan!.flatMap((pick) => pick.types).sort()).toEqual(['B', 'U']);
  });

  it('refuses a cost it cannot read rather than tapping hopefully', () => {
    expect(solveTap(EMPTY_POOL, parseManaCost('{R/G}'), [land('m1', 'R')])).toBeNull();
  });

  it('pays for X out of the sources available', () => {
    const sources = ['m1', 'm2', 'm3', 'm4'].map((k) => land(k, 'R'));
    expect(solveTap(EMPTY_POOL, parseManaCost('{X}{R}'), sources, 3)).toHaveLength(4);
    expect(solveTap(EMPTY_POOL, parseManaCost('{X}{R}'), sources, 9)).toBeNull();
  });

  it('reports which colours a pool is short of', () => {
    expect(shortColors(pool({ R: 1 }), parseManaCost('{R}{R}{W}'))).toEqual(['W', 'R']);
    expect(shortColors(pool({ R: 2, W: 1 }), parseManaCost('{R}{R}{W}'))).toEqual([]);
  });
});

describe('pool helpers', () => {
  it('counts and prints what is floating', () => {
    const p = addMana(addMana(EMPTY_POOL, 'R', 2), 'G');
    expect(poolTotal(p)).toBe(3);
    expect(poolToString(p)).toBe('2R 1G');
    expect(poolToString(EMPTY_POOL)).toBe('');
  });

  it('never goes below zero', () => {
    expect(addMana(EMPTY_POOL, 'R', -5).R).toBe(0);
  });
});

describe('parseTypeLine', () => {
  it('splits supertypes, types and subtypes', () => {
    const line = parseTypeLine('Legendary Creature — Goblin Warrior');
    expect(line.supertypes).toEqual(['Legendary']);
    expect(line.types).toEqual(['Creature']);
    expect(line.subtypes).toEqual(['Goblin', 'Warrior']);
  });

  it('handles a line with no subtypes and an empty line', () => {
    expect(parseTypeLine('Instant')).toEqual({ supertypes: [], types: ['Instant'], subtypes: [] });
    expect(parseTypeLine('')).toEqual({ supertypes: [], types: [], subtypes: [] });
  });

  it('reads a token type line, which is how a created token knows it is a creature', () => {
    const line = parseTypeLine('Token Creature — Goblin');
    expect(line.supertypes).toEqual(['Token']);
    expect(line.types).toEqual(['Creature']);
  });
});

describe('printedKeywords', () => {
  it('reads a keyword line so an unscripted creature still flies', () => {
    expect(printedKeywords('Flying, vigilance').sort()).toEqual(['flying', 'vigilance']);
  });

  it('ignores reminder text in brackets', () => {
    expect(printedKeywords('Prowess (Whenever you cast a noncreature spell, this gets +1/+1.)')).toEqual(['prowess']);
  });

  it('does not grant a keyword mentioned inside a sentence', () => {
    // The difference between "this creature has flying" and "creatures with flying can't block".
    expect(printedKeywords("Creatures with flying can't block this turn.")).toEqual([]);
    expect(printedKeywords('Target creature gains trample until end of turn.')).toEqual([]);
  });

  it('reads keywords from more than one line', () => {
    expect(printedKeywords('Flying\nHaste').sort()).toEqual(['flying', 'haste']);
  });
});

describe('characteristicsOf', () => {
  it('reads printed power, toughness and keywords off the card', () => {
    const s = arena({ battlefield: { 1: ['Serra Angel'] } });
    const ch = characteristicsOf(s, s.instances[find(s, 1, 'battlefield', 'Serra Angel')]!);
    expect([ch.power, ch.toughness]).toEqual([4, 4]);
    expect([...ch.keywords].sort()).toEqual(['flying', 'vigilance']);
    expect(ch.isCreature).toBe(true);
    expect(ch.isLand).toBe(false);
  });

  it('adds +1/+1 counters to the printed values', () => {
    let s = arena({ battlefield: { 1: ['Grizzly Bears'] } });
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = { ...s, instances: { ...s.instances, [bear]: { ...s.instances[bear]!, counters: { '+1/+1': 2 } } } };
    const ch = characteristicsOf(s, s.instances[bear]!);
    expect([ch.power, ch.toughness]).toEqual([4, 4]);
  });

  it('nets +1/+1 against -1/-1 counters', () => {
    let s = arena({ battlefield: { 1: ['Grizzly Bears'] } });
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = {
      ...s,
      instances: { ...s.instances, [bear]: { ...s.instances[bear]!, counters: { '+1/+1': 3, '-1/-1': 1 } } },
    };
    const ch = characteristicsOf(s, s.instances[bear]!);
    expect([ch.power, ch.toughness]).toEqual([4, 4]);
  });

  it('applies a continuous effect only to the cards in its scope', () => {
    let s = arena({ battlefield: { 1: ['Grizzly Bears', 'Centaur Courser'] } });
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = {
      ...s,
      effects: [{
        id: 'fx1', source: bear, controller: 1, scope: { kind: 'cards', ids: [bear] },
        power: 3, toughness: 3, duration: 'end-of-turn', createdTurn: 1,
      }],
    };
    expect(characteristicsOf(s, s.instances[bear]!).power).toBe(5);
    expect(characteristicsOf(s, s.instances[courser]!).power).toBe(3);
  });

  it('grants and removes keywords through effects', () => {
    let s = arena({ battlefield: { 1: ['Serra Angel'] } });
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    s = {
      ...s,
      effects: [{
        id: 'fx1', source: angel, controller: 1, scope: { kind: 'all-creatures' },
        keywords: ['trample'], removeKeywords: ['flying'], duration: 'end-of-turn', createdTurn: 1,
      }],
    };
    const ch = characteristicsOf(s, s.instances[angel]!);
    expect(ch.keywords.has('trample')).toBe(true);
    expect(ch.keywords.has('flying')).toBe(false);
  });

  it('is computed fresh every time, so a wearing-off pump leaves nothing behind', () => {
    const s = arena({ battlefield: { 1: ['Grizzly Bears'] } });
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    const pumped = {
      ...s,
      effects: [{
        id: 'fx1', source: bear, controller: 1 as const, scope: { kind: 'cards' as const, ids: [bear] },
        power: 3, toughness: 3, duration: 'end-of-turn' as const, createdTurn: 1,
      }],
    };
    expect(characteristicsOf(pumped, pumped.instances[bear]!).power).toBe(5);
    // The same instance, with the effect gone: back to 2/2 with no stored total to unwind.
    expect(characteristicsOf(s, s.instances[bear]!).power).toBe(2);
  });

  it('reports a land as a land and not a creature', () => {
    const s = arena({ battlefield: { 0: ['Mountain'] } });
    const ch = characteristicsOf(s, s.instances[find(s, 0, 'battlefield', 'Mountain')]!);
    expect(ch.isLand).toBe(true);
    expect(ch.isCreature).toBe(false);
  });
});
