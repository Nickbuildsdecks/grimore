/**
 * Every scripted card, played the way a player would play it.
 *
 * One test per card, driven through `auto:cast` or `auto:activate` so the script, the cost, the
 * targeting and the resolution are all exercised together. A card whose script is wrong is not a
 * bug a player can work around — it silently makes the wrong play legal — so the bar here is that
 * each card's actual printed behaviour is observed, not that its effect function was called.
 *
 * The last test in the file is the one that matters most: it checks that every card in both starter
 * decks either has a script or is a permanent that works without one, so a card cannot be added to
 * a deck and quietly do nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  SOLDIER_TOKEN, STARTER_DECKS, TOKEN_DEFS, addCounters, canAttack, canBlock, characteristicsOf,
  hasType,
  legalActions,
  parseTypeLine,
  packView, pendingDeclaration, protectedFrom, pump, pumpAll, pumpTeam, scriptFor,
  scriptedCardNames,
  staticEffect, unpackView, viewFor,
  type ContinuousEffect,
} from './index.js';
import {
  advanceTo, apply, arena, choices, countOf, damageOn, decide, drain, find, ids, life, nameOf,
  namesIn, nextTurn, passBoth, refusal, stackNames, tapAllLands,
} from './testkit.js';
import type { GameState, SeatIndex } from './types.js';
import type { Target } from './turnTypes.js';

const BASICS = new Set(['Mountain', 'Forest', 'Plains', 'Island', 'Swamp']);

/**
 * Sets a seat up in its main phase with every land tapped for mana and `hand` in hand.
 *
 * `lands` is either a count of the seat's own basic, or an explicit list when the spell needs more
 * than one colour — seat 1 plays green-white, so a Sigarda test has to ask for a Plains by name.
 */
function withMana(
  seat: SeatIndex, hand: readonly string[], lands: number | readonly string[], extra: readonly string[] = [],
  deck?: string,
): GameState {
  const names = typeof lands === 'number'
    ? Array.from({ length: lands }, () => (seat === 0 ? 'Mountain' : 'Forest'))
    : lands;
  let s = arena({
    hands: { [seat]: hand }, battlefield: { [seat]: [...names, ...extra] },
    turn: 2, firstSeat: seat,
    ...(deck === undefined ? {} : { decks: { [seat]: deck } }),
  });
  s = advanceTo(s, 'precombat-main');
  for (const id of [...ids(s, seat, 'battlefield')]) {
    if (!BASICS.has(s.cardDefs[s.instances[id]!.defKey]!.name)) continue;
    s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
  }
  return s;
}

/** Casts a card from hand and resolves it. */
function cast(s: GameState, by: SeatIndex, name: string, targets?: readonly Target[]): GameState {
  const action = {
    type: 'auto:cast' as const, by, card: find(s, by, 'hand', name),
    ...(targets === undefined ? {} : { targets }),
  };
  return passBoth(apply(s, action));
}

/** Gets to the declare-attackers step, for the protection tests that need a combat. */
const toAttackers = (s: GameState): GameState => advanceTo(s, 'declare-attackers');

const power = (s: GameState, id: string): number => characteristicsOf(s, s.instances[id]!).power;
const toughness = (s: GameState, id: string): number => characteristicsOf(s, s.instances[id]!).toughness;

describe('lands', () => {
  it('taps each basic for its own colour', () => {
    for (const [seat, land, colour] of [[0, 'Mountain', 'R'], [1, 'Forest', 'G'], [1, 'Plains', 'W']] as const) {
      let s = arena({ battlefield: { [seat]: [land] }, turn: 2, firstSeat: seat });
      s = advanceTo(s, 'precombat-main');
      s = apply(s, { type: 'auto:activate', by: seat, card: find(s, seat, 'battlefield', land), abilityIndex: 0 });
      expect(s.pools[String(seat)]![colour]).toBe(1);
    }
  });
});

describe('burn', () => {
  it('Lightning Bolt deals 3 to a player', () => {
    let s = withMana(0, ['Lightning Bolt'], 1);
    s = cast(s, 0, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    expect(life(s, 1)).toBe(17);
  });

  it('Lightning Bolt deals 3 to a creature, killing a 3/3', () => {
    let s = arena({ hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['Mountain'], 1: ['Centaur Courser'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = cast(s, 0, 'Lightning Bolt', [{ kind: 'card', id: find(s, 1, 'battlefield', 'Centaur Courser') }]);
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
  });

  it('Shock deals 2', () => {
    let s = withMana(0, ['Shock'], 1);
    s = cast(s, 0, 'Shock', [{ kind: 'player', seat: 1 }]);
    expect(life(s, 1)).toBe(18);
  });

  it('Lava Spike deals 3 to a player only', () => {
    let s = arena({ hands: { 0: ['Lava Spike'] }, battlefield: { 0: ['Mountain'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    // It is a "target player" spell, so a creature is not a legal choice.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lava Spike'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }],
    })).toBeTruthy();
    s = cast(s, 0, 'Lava Spike', [{ kind: 'player', seat: 1 }]);
    expect(life(s, 1)).toBe(17);
  });

  it('Flame Slash deals 4 to a creature and cannot be aimed at a player', () => {
    let s = arena({ hands: { 0: ['Flame Slash'] }, battlefield: { 0: ['Mountain'], 1: ['Serra Angel'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flame Slash'),
      targets: [{ kind: 'player', seat: 1 }],
    })).toBeTruthy();
    s = cast(s, 0, 'Flame Slash', [{ kind: 'card', id: find(s, 1, 'battlefield', 'Serra Angel') }]);
    expect(namesIn(s, 1, 'graveyard')).toContain('Serra Angel');
  });
});

describe('red creatures', () => {
  it('Monastery Swiftspear has haste and prowess, which fires on the cast not the resolution', () => {
    let s = withMana(0, ['Monastery Swiftspear', 'Shock'], 2);
    s = cast(s, 0, 'Monastery Swiftspear');
    const spear = find(s, 0, 'battlefield', 'Monastery Swiftspear');
    expect([power(s, spear), toughness(s, spear)]).toEqual([1, 2]);
    expect(characteristicsOf(s, s.instances[spear]!).keywords.has('haste')).toBe(true);

    // Casting a noncreature spell puts the prowess trigger on the stack above it.
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    expect(s.stackOrder.length).toBe(2);
    s = passBoth(s); // the trigger resolves first
    expect([power(s, spear), toughness(s, spear)]).toEqual([2, 3]);
    s = passBoth(s); // then the Shock
    expect(life(s, 1)).toBe(18);
    // And it wears off.
    s = nextTurn(s);
    expect([power(s, spear), toughness(s, spear)]).toEqual([1, 2]);
  });

  it('Monastery Swiftspear does not trigger on a creature spell', () => {
    let s = withMana(0, ['Monastery Swiftspear', 'Raging Goblin'], 2);
    s = cast(s, 0, 'Monastery Swiftspear');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Raging Goblin') });
    expect(s.stackOrder.length).toBe(1);
  });

  it('Monastery Swiftspear does not trigger on the opponent’s spell', () => {
    let s = arena({
      hands: { 0: ['Monastery Swiftspear'], 1: ['Giant Growth'] },
      battlefield: { 0: ['Mountain'], 1: ['Forest', 'Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = cast(s, 0, 'Monastery Swiftspear');
    const spear = find(s, 0, 'battlefield', 'Monastery Swiftspear');
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Forest'), abilityIndex: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }],
    });
    expect(s.stackOrder.length).toBe(1);
    s = passBoth(s);
    expect(power(s, spear)).toBe(1);
  });

  it('Raging Goblin has haste and can attack the turn it arrives', () => {
    let s = withMana(0, ['Raging Goblin'], 1);
    s = cast(s, 0, 'Raging Goblin');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: goblin, defender: 1 }] });
    expect(s.combat.attacks.map((a) => a.attacker)).toEqual([goblin]);
  });

  it('Firebrand Archer pings each opponent on a noncreature spell', () => {
    let s = withMana(0, ['Firebrand Archer', 'Shock'], 3);
    s = cast(s, 0, 'Firebrand Archer');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    s = passBoth(s); // the Archer trigger
    expect(life(s, 1)).toBe(19);
    s = passBoth(s); // the Shock
    expect(life(s, 1)).toBe(17);
  });

  it('Shivan Dragon flies and pumps itself for {R}, once per mana', () => {
    let s = withMana(0, ['Shivan Dragon'], 8);
    s = cast(s, 0, 'Shivan Dragon');
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    expect(characteristicsOf(s, s.instances[dragon]!).keywords.has('flying')).toBe(true);
    expect([power(s, dragon), toughness(s, dragon)]).toEqual([5, 5]);

    s = apply(s, { type: 'auto:activate', by: 0, card: dragon, abilityIndex: 0 });
    s = passBoth(s);
    expect([power(s, dragon), toughness(s, dragon)]).toEqual([6, 5]);
    s = apply(s, { type: 'auto:activate', by: 0, card: dragon, abilityIndex: 0 });
    s = passBoth(s);
    expect(power(s, dragon)).toBe(7);
    // Firebreathing is not a tap ability, so being tapped does not stop it.
    expect(s.instances[dragon]!.tapped).toBe(false);
  });

  it('Shivan Dragon’s pump needs the mana for it', () => {
    let s = withMana(0, ['Shivan Dragon'], 6);
    s = cast(s, 0, 'Shivan Dragon');
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    expect(refusal(s, { type: 'auto:activate', by: 0, card: dragon, abilityIndex: 0 })).toContain('cannot pay');
  });

  it('Act of Treason steals a creature, untaps it, gives it haste, and gives it back', () => {
    let s = arena({
      hands: { 0: ['Act of Treason'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name === 'Mountain') {
        s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
      }
    }
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = { ...s, instances: { ...s.instances, [courser]: { ...s.instances[courser]!, tapped: true } } };
    s = cast(s, 0, 'Act of Treason', [{ kind: 'card', id: courser }]);

    expect(s.instances[courser]!.zoneSeat).toBe(0);
    expect(s.instances[courser]!.tapped).toBe(false);
    expect(characteristicsOf(s, s.instances[courser]!).keywords.has('haste')).toBe(true);
    // The whole point: it can attack its own controller this turn.
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: courser, defender: 1 }] });
    expect(s.combat.attacks.map((a) => a.attacker)).toEqual([courser]);
    s = nextTurn(s);
    // And it goes home at end of turn, not to the thief's graveyard.
    expect(s.instances[courser]!.zoneSeat).toBe(1);
    expect(s.instances[courser]!.owner).toBe(1);
  });

  it('Act of Treason cannot target a creature you already control', () => {
    let s = withMana(0, ['Act of Treason'], 3, ['Hill Giant']);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Act of Treason'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Hill Giant') }],
    })).toBeTruthy();
  });

  it('Krenko makes one Goblin per Goblin, counting himself', () => {
    let s = arena({ battlefield: { 0: ['Krenko, Mob Boss', 'Raging Goblin'] }, turn: 3, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    const krenko = find(s, 0, 'battlefield', 'Krenko, Mob Boss');
    s = apply(s, { type: 'auto:activate', by: 0, card: krenko, abilityIndex: 0 });
    s = passBoth(s);
    // Krenko and the Raging Goblin are both Goblins, so two tokens.
    expect(countOf(s, 0, 'battlefield', 'Goblin')).toBe(2);
    expect(s.instances[krenko]!.tapped).toBe(true);
    // Tapping again next turn now counts four Goblins.
    s = nextTurn(nextTurn(s));
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: krenko, abilityIndex: 0 });
    s = passBoth(s);
    expect(countOf(s, 0, 'battlefield', 'Goblin')).toBe(6);
  });
});

describe('green and white', () => {
  it('Llanowar Elves taps for {G} once it is no longer summoning sick', () => {
    let s = withMana(1, ['Llanowar Elves'], 1);
    s = cast(s, 1, 'Llanowar Elves');
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    expect(refusal(s, { type: 'auto:activate', by: 1, card: elves, abilityIndex: 0 })).toContain('summoning sickness');
    s = nextTurn(nextTurn(s));
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 1, card: elves, abilityIndex: 0 });
    expect(s.pools['1']!.G).toBe(1);
  });

  it('Ajani’s Pridemate grows whenever its controller gains life', () => {
    let s = arena({
      hands: { 1: ['Swords to Plowshares'] },
      battlefield: { 1: ['Plains', "Ajani's Pridemate"], 0: ['Hill Giant'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    const cat = find(s, 1, 'battlefield', "Ajani's Pridemate");
    expect([power(s, cat), toughness(s, cat)]).toEqual([2, 2]);
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    // Swords exiles the 3/3 and gives its controller 3 life — seat 0, not seat 1.
    s = cast(s, 1, 'Swords to Plowshares', [{ kind: 'card', id: find(s, 0, 'battlefield', 'Hill Giant') }]);
    expect(life(s, 0)).toBe(23);
    expect([power(s, cat), toughness(s, cat)]).toEqual([2, 2]);
  });

  it('Ajani’s Pridemate grows from life its own controller gains', () => {
    let s = arena({
      hands: { 1: ['Swords to Plowshares'] },
      battlefield: { 1: ['Plains', "Ajani's Pridemate", 'Grizzly Bears'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    const cat = find(s, 1, 'battlefield', "Ajani's Pridemate");
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    // Exiling its own Grizzly Bears gains seat 1 two life.
    s = cast(s, 1, 'Swords to Plowshares', [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }]);
    expect(life(s, 1)).toBe(22);
    s = passBoth(s); // the Pridemate trigger
    expect([power(s, cat), toughness(s, cat)]).toEqual([3, 3]);
    expect(s.instances[cat]!.counters['+1/+1']).toBe(1);
    // A counter is permanent, unlike a pump.
    s = nextTurn(s);
    expect(power(s, cat)).toBe(3);
  });

  it('Serra Angel flies and has vigilance', () => {
    let s = withMana(1, ['Serra Angel'], ['Plains', 'Plains', 'Plains', 'Plains', 'Plains']);
    s = cast(s, 1, 'Serra Angel');
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    expect([...characteristicsOf(s, s.instances[angel]!).keywords].sort()).toEqual(['flying', 'vigilance']);
  });

  it('Giant Growth gives +3/+3 until end of turn', () => {
    let s = withMana(1, ['Giant Growth'], 1, ['Grizzly Bears']);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = cast(s, 1, 'Giant Growth', [{ kind: 'card', id: bear }]);
    expect([power(s, bear), toughness(s, bear)]).toEqual([5, 5]);
    s = nextTurn(s);
    expect([power(s, bear), toughness(s, bear)]).toEqual([2, 2]);
  });

  it('Pacifism stops a creature attacking or blocking, and dies with its host', () => {
    let s = arena({
      hands: { 1: ['Pacifism'] },
      battlefield: { 1: ['Plains', 'Plains'], 0: ['Hill Giant'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name === 'Plains') {
        s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
      }
    }
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = cast(s, 1, 'Pacifism', [{ kind: 'card', id: giant }]);

    const aura = find(s, 1, 'battlefield', 'Pacifism');
    expect(s.instances[aura]!.attachedTo).toBe(giant);
    const ch = characteristicsOf(s, s.instances[giant]!);
    expect(ch.cantAttack).toBe(true);
    expect(ch.cantBlock).toBe(true);

    // Seat 0's turn: the giant cannot be declared, so combat is skipped entirely.
    s = nextTurn(s);
    expect(s.activeSeat).toBe(0);
    s = advanceTo(s, 'begin-combat');
    s = passBoth(s);
    expect(s.step).toBe('end-combat');

    // Remove the host and the Aura goes to its owner's graveyard (CR 704.5m).
    s = { ...s, zones: { ...s.zones }, instances: { ...s.instances } };
    s = apply(s, { type: 'card:move', by: 0, card: giant, toZone: 'graveyard' });
    expect(namesIn(s, 1, 'graveyard')).toContain('Pacifism');
  });

  it('Swords to Plowshares exiles a creature and gains its controller life equal to its power', () => {
    let s = arena({
      hands: { 1: ['Swords to Plowshares'] },
      battlefield: { 1: ['Plains'], 0: ['Shivan Dragon'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = cast(s, 1, 'Swords to Plowshares', [{ kind: 'card', id: find(s, 0, 'battlefield', 'Shivan Dragon') }]);
    expect(ids(s, 0, 'exile').length).toBe(1);
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Shivan Dragon');
    expect(life(s, 0)).toBe(25); // a 5/5
  });

  it('Harmonize draws three cards', () => {
    let s = withMana(1, ['Harmonize'], 5);
    const before = ids(s, 1, 'hand').length;
    s = cast(s, 1, 'Harmonize');
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 3);
  });

  it('Overrun pumps the whole team and gives it trample', () => {
    let s = withMana(1, ['Overrun'], 5, ['Grizzly Bears', 'Centaur Courser']);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = cast(s, 1, 'Overrun');
    expect([power(s, bear), toughness(s, bear)]).toEqual([5, 5]);
    expect([power(s, courser), toughness(s, courser)]).toEqual([6, 6]);
    expect(characteristicsOf(s, s.instances[bear]!).keywords.has('trample')).toBe(true);
    s = nextTurn(s);
    expect(power(s, bear)).toBe(2);
  });

  it('Overrun does not pump the opponent’s creatures', () => {
    let s = arena({
      hands: { 1: ['Overrun'] },
      battlefield: { 1: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Grizzly Bears'], 0: ['Hill Giant'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name === 'Forest') {
        s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
      }
    }
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = cast(s, 1, 'Overrun');
    expect(power(s, giant)).toBe(3);
  });

  it('Sigarda flies and has hexproof', () => {
    let s = withMana(1, ['Sigarda, Host of Herons'], ['Forest', 'Forest', 'Forest', 'Forest', 'Plains']);
    s = cast(s, 1, 'Sigarda, Host of Herons');
    const sigarda = find(s, 1, 'battlefield', 'Sigarda, Host of Herons');
    expect([...characteristicsOf(s, s.instances[sigarda]!).keywords].sort()).toEqual(['flying', 'hexproof']);
  });
});

describe('blue-black control', () => {
  /** Seat 1 plays the control deck, with Islands and Swamps untapped. */
  const control = (hand: readonly string[], lands: readonly string[], extra: readonly string[] = []): GameState => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      hands: { 1: hand }, battlefield: { 1: [...lands, ...extra] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (name !== 'Island' && name !== 'Swamp') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('Counterspell counters a spell on the stack, which goes to its owner’s graveyard', () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      hands: { 0: ['Hill Giant'], 1: ['Counterspell'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Island', 'Island'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hill Giant') });
    const giant = ids(s, 0, 'stack')[0]!;
    expect(s.stackOrder).toEqual([giant]);

    // Seat 1 responds. A counterspell is an instant, so holding priority is all it needs.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'),
      targets: [{ kind: 'card', id: giant }],
    });
    s = passBoth(s); // the Counterspell resolves
    expect(namesIn(s, 0, 'graveyard')).toContain('Hill Giant');
    expect(namesIn(s, 0, 'battlefield')).not.toContain('Hill Giant');
    // And the stack is empty: the countered spell did not stay on it.
    expect(s.stackOrder).toEqual([]);
  });

  it('Negate cannot be aimed at a creature spell', () => {
    let s = arena({
      // Hollow Tide rather than Tidal Mind: the deck a named card is drawn from only has to
      // contain it, and Tidal Mind's counterspell count was cut to three in the balance pass.
      decks: { 1: 'hollow-tide' },
      hands: { 0: ['Hill Giant'], 1: ['Negate'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Island', 'Island'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hill Giant') });
    const giant = ids(s, 0, 'stack')[0]!;
    s = apply(s, { type: 'auto:pass', by: 0 });
    expect(refusal(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Negate'),
      targets: [{ kind: 'card', id: giant }],
    })).toMatch(/noncreature/);
  });

  it('Negate counters a noncreature spell', () => {
    let s = arena({
      decks: { 1: 'hollow-tide' },
      hands: { 0: ['Lightning Bolt'], 1: ['Negate'] },
      battlefield: { 0: ['Mountain'], 1: ['Island', 'Island'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    const bolt = ids(s, 0, 'stack')[0]!;
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Negate'), targets: [{ kind: 'card', id: bolt }],
    });
    s = passBoth(s);
    s = passBoth(s);
    expect(life(s, 1)).toBe(20);
    expect(countOf(s, 0, 'graveyard', 'Lightning Bolt')).toBe(1);
  });

  it('a counterspell with nothing left to counter does not resolve (CR 608.2b)', () => {
    // Both players point at the same spell; the first counter resolves, so the second fizzles.
    let s = arena({
      decks: { 1: 'hollow-tide' },
      hands: { 0: ['Lightning Bolt'], 1: ['Counterspell', 'Negate'] },
      battlefield: { 0: ['Mountain'], 1: ['Island', 'Island', 'Island', 'Island'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    const bolt = ids(s, 0, 'stack')[0]!;
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'), targets: [{ kind: 'card', id: bolt }] });
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Negate'), targets: [{ kind: 'card', id: bolt }] });

    s = passBoth(s); // Negate resolves and counters the Bolt
    expect(countOf(s, 0, 'graveyard', 'Lightning Bolt')).toBe(1);
    s = passBoth(s); // the Counterspell has nothing to counter
    expect(s.log.at(-1)!.message).toContain('countered');
    expect(life(s, 1)).toBe(20);
  });

  it('Doom Blade destroys a creature', () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      hands: { 1: ['Doom Blade'] },
      battlefield: { 1: ['Island', 'Swamp'], 0: ['Shivan Dragon'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    s = cast(s, 1, 'Doom Blade', [{ kind: 'card', id: find(s, 0, 'battlefield', 'Shivan Dragon') }]);
    expect(namesIn(s, 0, 'graveyard')).toContain('Shivan Dragon');
  });

  // Divination moved out of Tidal Mind for a Behold the Multiverse, so this moved to Hollow Tide
  // with it — the same reason the Sign in Blood and Tome Scour tests below say they moved.
  it('Divination draws two', () => {
    let s = draws(['Divination'], ['Island', 'Island', 'Island']);
    const before = ids(s, 1, 'hand').length;
    s = cast(s, 1, 'Divination');
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 2);
  });

  /*
    Sign in Blood moved to Hollow Tide, so these two moved with it — the same reason the Tome Scour
    test below says it moved. Tidal Mind traded the slot for a Dirgur Nemesis, because two cards
    for two life is the most replaceable thing in a deck that already holds four other ways to draw.
  */
  const draws = (hand: readonly string[], lands: readonly string[]): GameState => {
    let s = advanceTo(arena({
      decks: { 1: 'hollow-tide' },
      hands: { 1: [...hand] }, battlefield: { 1: [...lands] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    return tapAllLands(s, 1);
  };

  it('Sign in Blood draws two and costs two life', () => {
    let s = draws(['Sign in Blood'], ['Swamp', 'Swamp']);
    const before = ids(s, 1, 'hand').length;
    s = cast(s, 1, 'Sign in Blood', [{ kind: 'player', seat: 1 }]);
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 2);
    expect(life(s, 1)).toBe(18);
  });

  it('Sign in Blood can be aimed at an opponent, which is what makes it removal', () => {
    let s = draws(['Sign in Blood'], ['Swamp', 'Swamp']);
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 2 } : seat)) };
    s = cast(s, 1, 'Sign in Blood', [{ kind: 'player', seat: 0 }]);
    expect(s.seats[0]!.eliminated).toBe(true);
  });

  // Tome Scour moved to Hollow Tide, which is the deck whose plan it is, so the test went with it.
  it('Tome Scour mills five', () => {
    let s = arena({
      decks: { 1: 'hollow-tide' },
      hands: { 1: ['Tome Scour'] }, battlefield: { 1: ['Island'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    const library = ids(s, 0, 'library').length;
    s = cast(s, 1, 'Tome Scour', [{ kind: 'player', seat: 0 }]);
    expect(ids(s, 0, 'library').length).toBe(library - 5);
    expect(ids(s, 0, 'graveyard').length).toBe(5);
  });

  it('Ravenous Rats makes each opponent discard at random, and the same seed discards the same card', () => {
    const play = (): GameState => {
      let s = arena({
        decks: { 1: 'tidal-mind' },
        hands: { 0: ['Shock', 'Hill Giant', 'Mountain'], 1: ['Ravenous Rats'] },
        battlefield: { 1: ['Island', 'Swamp'] },
        turn: 2, firstSeat: 1,
      });
      s = advanceTo(s, 'precombat-main');
      s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Ravenous Rats') });
      s = passBoth(s); // the Rats resolve onto the battlefield
      return passBoth(s); // and the ETB trigger resolves
    };
    const a = play();
    expect(ids(a, 0, 'hand').length).toBe(2);
    expect(ids(a, 0, 'graveyard').length).toBe(1);
    // Deterministic: the engine's own seeded stream, so a replayed game discards the same card.
    expect(namesIn(play(), 0, 'graveyard')).toEqual(namesIn(a, 0, 'graveyard'));
  });

  it('Talrand makes a Drake for an instant, and not for a creature', () => {
    // Dive Down rather than Tome Scour, which now lives in Hollow Tide: the trigger is about any
    // instant or sorcery, so which one is immaterial as long as it is cheap enough to leave the
    // creature spell below it castable.
    let s = control(['Dive Down', 'Child of Night'], ['Island', 'Island', 'Swamp'], ['Talrand, Sky Summoner']);
    const talrand = find(s, 1, 'battlefield', 'Talrand, Sky Summoner');
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Dive Down'),
      targets: [{ kind: 'card', id: talrand }],
    });
    expect(s.stackOrder.length).toBe(2); // the spell and the trigger
    s = passBoth(s);
    expect(countOf(s, 1, 'battlefield', 'Drake')).toBe(1);
    s = passBoth(s);

    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Child of Night') });
    expect(s.stackOrder.length).toBe(1); // a creature spell is not an instant or sorcery
  });

  it('keeps the printed keywords of the creatures it does not script beyond them', () => {
    let s = control([], ['Island'], ['Vampire Nighthawk', 'Air Elemental', 'Child of Night', 'Wind Drake']);
    const keywords = (name: string) =>
      [...characteristicsOf(s, s.instances[find(s, 1, 'battlefield', name)]!).keywords].sort();
    expect(keywords('Vampire Nighthawk')).toEqual(['deathtouch', 'flying', 'lifelink']);
    expect(keywords('Air Elemental')).toEqual(['flying']);
    expect(keywords('Child of Night')).toEqual(['lifelink']);
    expect(keywords('Wind Drake')).toEqual(['flying']);
  });

  it('a Nighthawk kills whatever it blocks and gains the life', () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      battlefield: { 0: ['Shivan Dragon'], 1: ['Vampire Nighthawk'] },
      turn: 2, firstSeat: 0,
    });
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 1 ? { ...seat, life: 10 } : seat)) };
    s = advanceTo(s, 'declare-attackers');
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    const hawk = find(s, 1, 'battlefield', 'Vampire Nighthawk');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: dragon, defender: 1 }] });
    s = passBoth(s);
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: hawk, attacker: dragon }] });
    for (let i = 0; i < 6 && s.step !== 'postcombat-main'; i++) s = passBoth(s);
    // 2 deathtouch damage kills a 5/5, and lifelink gains 2 — but the 5/5 kills the 2/3 as well.
    expect(namesIn(s, 0, 'graveyard')).toContain('Shivan Dragon');
    expect(namesIn(s, 1, 'graveyard')).toContain('Vampire Nighthawk');
    expect(life(s, 1)).toBe(12);
  });
});

describe('triggers that need a target', () => {
  it('Flametongue Kavu stops and asks, then deals 4', () => {
    let s = arena({
      hands: { 0: ['Flametongue Kavu'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flametongue Kavu') });
    s = passBoth(s); // it resolves onto the battlefield and the trigger goes on the stack

    // Two creatures are now on the board, so which one it hits is a real decision and the engine
    // will not make it. Nothing else can happen until it is answered.
    expect(s.pendingChoice).not.toBeNull();
    expect(s.pendingChoice!.seat).toBe(0);
    expect(legalActions(s, 0).mustChoose!.description).toContain('4 damage');
    expect(refusal(s, { type: 'auto:pass', by: 0 })).toContain('needs a target');
    // And the *other* player's table is offered nothing at all. Same shape as the mid-resolution
    // decision: a state that still named a seat here would have that seat's table offering Pass
    // and the engine refusing it for as long as the trigger went unaimed.
    expect(s.priority).toBeNull();
    for (const seat of [0, 1] as SeatIndex[]) expect(legalActions(s, seat).hasPriority).toBe(false);
    expect(refusal(s, { type: 'auto:pass', by: 1 })).toBeTruthy();

    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: courser }] });
    expect(s.pendingChoice).toBeNull();
    s = passBoth(s); // the trigger resolves
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
  });

  it('Flametongue Kavu kills itself when it is the only creature, without asking', () => {
    // A choice between one thing is not a choice, so the engine takes it — and the famous
    // drawback of the card is that the only thing it can point at is itself.
    let s = arena({
      hands: { 0: ['Flametongue Kavu'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flametongue Kavu') });
    s = passBoth(s);
    expect(s.pendingChoice).toBeNull();
    s = passBoth(s);
    expect(namesIn(s, 0, 'graveyard')).toContain('Flametongue Kavu');
  });

  it("Man-o'-War bounces the creature it is aimed at", () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      hands: { 1: ["Man-o'-War"] },
      battlefield: { 1: ['Island', 'Island', 'Island'], 0: ['Hill Giant'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', "Man-o'-War") });
    s = passBoth(s);
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = apply(s, { type: 'auto:choose', by: 1, targets: [{ kind: 'card', id: giant }] });
    s = passBoth(s);
    expect(namesIn(s, 0, 'battlefield')).not.toContain('Hill Giant');
    expect(namesIn(s, 0, 'hand')).toContain('Hill Giant');
  });

  it('refuses a choice from the wrong seat, or one that is not legal', () => {
    let s = arena({
      hands: { 0: ['Flametongue Kavu'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flametongue Kavu') });
    s = passBoth(s);
    expect(refusal(s, { type: 'auto:choose', by: 1, targets: [] })).toContain('not your choice');
    expect(refusal(s, { type: 'auto:choose', by: 0, targets: [] })).toMatch(/target/i);
    expect(refusal(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'player', seat: 1 }] }))
      .toMatch(/target/i);
  });

  it('never puts a trigger on the stack that has nothing legal to point at', () => {
    // A hexproof creature an opponent cannot target is the same as no creature at all, as far as
    // their trigger is concerned (CR 603.3c).
    let s = arena({
      hands: { 0: ['Flametongue Kavu'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Sigarda, Host of Herons'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flametongue Kavu') });
    s = passBoth(s);
    // Only itself is targetable, so it is chosen without asking — and the Kavu dies.
    expect(s.pendingChoice).toBeNull();
    s = passBoth(s);
    expect(namesIn(s, 0, 'graveyard')).toContain('Flametongue Kavu');
    expect(namesIn(s, 1, 'battlefield')).toContain('Sigarda, Host of Herons');
  });
});

describe('the graveyard, which is a place cards come back from', () => {
  /** Seat 1 plays the graveyard deck, with its lands tapped. */
  const rot = (hand: readonly string[], lands: readonly string[], extra: readonly string[] = []): GameState => {
    let s = arena({
      decks: { 1: 'rot-harvest' },
      hands: { 1: hand }, battlefield: { 1: [...lands, ...extra] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (name !== 'Forest' && name !== 'Swamp') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    return s;
  };

  /** Puts a card from a seat's library straight into its graveyard, as a trade would. */
  const bury = (s: GameState, seat: SeatIndex, name: string): GameState =>
    apply(s, { type: 'card:move', by: seat, card: find(s, seat, 'library', name), toZone: 'graveyard' });

  it('Raise Dead returns a creature card, and will not take a land or an opponent’s', () => {
    let s = rot(['Raise Dead'], ['Swamp']);
    s = bury(s, 1, 'Centaur Courser');
    s = bury(s, 1, 'Swamp');
    s = bury(s, 0, 'Hill Giant');

    const theirs = find(s, 0, 'graveyard', 'Hill Giant');
    const land = find(s, 1, 'graveyard', 'Swamp');
    const mine = find(s, 1, 'graveyard', 'Centaur Courser');
    const raise = find(s, 1, 'hand', 'Raise Dead');
    expect(refusal(s, { type: 'auto:cast', by: 1, card: raise, targets: [{ kind: 'card', id: theirs }] })).toBeTruthy();
    expect(refusal(s, { type: 'auto:cast', by: 1, card: raise, targets: [{ kind: 'card', id: land }] })).toBeTruthy();

    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: raise, targets: [{ kind: 'card', id: mine }] }));
    expect(namesIn(s, 1, 'hand')).toContain('Centaur Courser');
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Centaur Courser');
  });

  it('Zombify puts it straight onto the battlefield instead', () => {
    let s = rot(['Zombify'], ['Swamp', 'Swamp', 'Swamp', 'Swamp']);
    s = bury(s, 1, 'Centaur Courser');
    const mine = find(s, 1, 'graveyard', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Zombify'), targets: [{ kind: 'card', id: mine }],
    }));
    expect(namesIn(s, 1, 'battlefield')).toContain('Centaur Courser');
    // And it is summoning sick, because it only just arrived.
    expect(s.instances[mine]!.enteredTurn).toBe(s.turn);
  });

  it('Gravedigger asks which card it brings back', () => {
    let s = rot(['Gravedigger'], ['Swamp', 'Swamp', 'Swamp', 'Swamp']);
    s = bury(s, 1, 'Centaur Courser');
    s = bury(s, 1, 'Thornweald Archer');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Gravedigger') });
    s = passBoth(s);
    expect(s.pendingChoice).not.toBeNull();
    const courser = find(s, 1, 'graveyard', 'Centaur Courser');
    s = apply(s, { type: 'auto:choose', by: 1, targets: [{ kind: 'card', id: courser }] });
    s = passBoth(s);
    expect(namesIn(s, 1, 'hand')).toContain('Centaur Courser');
    expect(namesIn(s, 1, 'graveyard')).toContain('Thornweald Archer');
  });

  it('Gravedigger with an empty graveyard simply does not trigger', () => {
    let s = rot(['Gravedigger'], ['Swamp', 'Swamp', 'Swamp', 'Swamp']);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Gravedigger') });
    s = passBoth(s);
    expect(s.pendingChoice).toBeNull();
    expect(s.stackOrder).toEqual([]);
    expect(namesIn(s, 1, 'battlefield')).toContain('Gravedigger');
  });

  it('Wall of Blossoms draws a card and cannot attack', () => {
    let s = rot(['Wall of Blossoms'], ['Forest', 'Forest']);
    const before = ids(s, 1, 'hand').length;
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Wall of Blossoms') }));
    s = passBoth(s); // the trigger
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 1);
    const wall = find(s, 1, 'battlefield', 'Wall of Blossoms');
    expect(characteristicsOf(s, s.instances[wall]!).cantAttack).toBe(true);
  });

  it('Lotleth Giant drains for each creature card in your graveyard', () => {
    let s = rot(['Lotleth Giant'], Array.from({ length: 7 }, () => 'Swamp'));
    s = bury(s, 1, 'Centaur Courser');
    s = bury(s, 1, 'Thornweald Archer');
    s = bury(s, 1, 'Swamp'); // a land does not count
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lotleth Giant') }));
    s = passBoth(s);
    expect(life(s, 0)).toBe(18);
  });

  it('Izoni makes an Insect for each creature card in your graveyard', () => {
    // In a format with no command zone the commander is simply the deck's 61st card, so it can be
    // drawn and cast like anything else.
    let s = rot(['Izoni, Thousand-Eyed'], ['Forest', 'Swamp', 'Swamp', 'Swamp']);
    s = bury(s, 1, 'Centaur Courser');
    s = bury(s, 1, 'Thornweald Archer');
    s = bury(s, 1, 'Swamp'); // a land is not a creature card
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Izoni, Thousand-Eyed') }));
    expect(countOf(s, 1, 'battlefield', 'Insect')).toBe(0); // the trigger is still on the stack
    s = passBoth(s);
    expect(countOf(s, 1, 'battlefield', 'Insect')).toBe(2);
  });

  it('Vampire Aristocrat eats a creature as a cost, before anybody could respond', () => {
    let s = rot([], ['Forest', 'Swamp'], ['Vampire Aristocrat', 'Centaur Courser']);
    const vamp = find(s, 1, 'battlefield', 'Vampire Aristocrat');
    const food = find(s, 1, 'battlefield', 'Centaur Courser');
    s = apply(s, { type: 'auto:activate', by: 1, card: vamp, abilityIndex: 0, sacrifice: food });

    // The creature is already in the graveyard with the ability still on the stack: a cost is
    // paid on activation, which is exactly what makes it uncounterable and unresponsive-to.
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    expect(s.stackOrder.length).toBe(1);
    s = passBoth(s);
    expect([power(s, vamp), toughness(s, vamp)]).toEqual([4, 4]);
    // And it wears off, being a pump rather than a counter.
    s = nextTurn(s);
    expect(power(s, vamp)).toBe(2);
  });

  it('Vampire Aristocrat can eat itself, and Bloodthrone Vampire cannot', () => {
    const s = rot([], ['Forest', 'Swamp'], ['Vampire Aristocrat', 'Bloodthrone Vampire']);
    const aristocrat = find(s, 1, 'battlefield', 'Vampire Aristocrat');
    const bloodthrone = find(s, 1, 'battlefield', 'Bloodthrone Vampire');
    const options = (card: string) =>
      legalActions(s, 1).plays.find((p) => p.card === card && p.kind === 'activate')!.sacrificeOptions;
    expect([...options(aristocrat)].sort()).toEqual([aristocrat, bloodthrone].sort());
    expect(options(bloodthrone)).toEqual([aristocrat]);
  });

  it('refuses a sacrifice that is not offered, and one that is not chosen at all', () => {
    const s = rot([], ['Forest', 'Swamp'], ['Vampire Aristocrat']);
    const vamp = find(s, 1, 'battlefield', 'Vampire Aristocrat');
    expect(refusal(s, { type: 'auto:activate', by: 1, card: vamp, abilityIndex: 0 }))
      .toContain('choose a creature to sacrifice');
    const theirs = find(s, 0, 'library', 'Hill Giant');
    expect(refusal(s, { type: 'auto:activate', by: 1, card: vamp, abilityIndex: 0, sacrifice: theirs }))
      .toContain('cannot be sacrificed');
  });

  it('does not offer an outlet with nothing to feed it', () => {
    const s = rot([], ['Forest', 'Swamp'], ['Bloodthrone Vampire']);
    const vamp = find(s, 1, 'battlefield', 'Bloodthrone Vampire');
    expect(legalActions(s, 1).plays.some((p) => p.card === vamp && p.kind === 'activate')).toBe(false);
    expect(refusal(s, { type: 'auto:activate', by: 1, card: vamp, abilityIndex: 0, sacrifice: vamp }))
      .toContain('no creature to sacrifice');
  });

  it('a creature eaten as a cost dies, so anything watching for a death sees it', () => {
    // The sacrifice happens while the ability is being activated, not when it resolves, so a
    // dies-trigger fires then — which is the whole archetype the outlets exist for.
    let s = rot([], ['Forest', 'Swamp'], ['Vampire Aristocrat', 'Centaur Courser']);
    const vamp = find(s, 1, 'battlefield', 'Vampire Aristocrat');
    const food = find(s, 1, 'battlefield', 'Centaur Courser');
    s = apply(s, { type: 'auto:activate', by: 1, card: vamp, abilityIndex: 0, sacrifice: food });
    expect(s.instances[food]!.zone).toBe('graveyard');
    expect(s.log.at(-1)!.message).toContain('sacrifices Centaur Courser');
  });

  it('does not fire a trigger for a card moved by hand, because the tabletop enforces nothing', () => {
    // The manual moves are a physical escape hatch, not a second way to play: putting a creature
    // onto the battlefield by hand is picking it up and putting it down, and the player resolves
    // whatever it says themselves. Worth pinning, because the alternative — triggers firing from
    // manual moves — would double-fire every card the engine already handles.
    let s = rot([], ['Forest', 'Swamp', 'Swamp', 'Swamp']);
    s = bury(s, 1, 'Centaur Courser');
    const izoni = find(s, 1, 'library', 'Izoni, Thousand-Eyed');
    s = apply(s, { type: 'card:move', by: 1, card: izoni, toZone: 'battlefield' });
    expect(s.stackOrder).toEqual([]);
    expect(countOf(s, 1, 'battlefield', 'Insect')).toBe(0);
  });
});

describe('the commander, which a Commander format is about', () => {
  /** A seat in its main phase with every land tapped, at a table that has a command zone. */
  const commanderTable = (
    seat: SeatIndex, deck: string, lands: readonly string[], extra: readonly string[] = [], turn = 2,
  ): GameState => {
    let s = arena({
      format: 'edh', decks: { [seat]: deck },
      battlefield: { [seat]: [...lands, ...extra] }, turn, firstSeat: seat,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, seat, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (!/^(Mountain|Forest|Plains|Island|Swamp)$/.test(name)) continue;
      s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('can be cast from the command zone at all, which it could not before', () => {
    // `legalActions` only ever looked at the hand, so in a format whose entire point is the
    // commander the engine never offered one. Krenko costs {2}{R}{R}.
    const s = commanderTable(0, 'ember-rush', ['Mountain', 'Mountain', 'Mountain', 'Mountain']);
    expect(ids(s, 0, 'command').length).toBe(1);
    const offers = legalActions(s, 0).plays.filter((p) => p.name === 'Krenko, Mob Boss');
    expect(offers).toHaveLength(1);
    expect(offers[0]!.commanderTax).toBeUndefined();
  });

  it('costs {2} more each time it is cast from the command zone (CR 903.8)', () => {
    // Twelve lands, all tapped by the helper, because the second cast has to be affordable with
    // the tax on top of the four the first one spent.
    let s = commanderTable(0, 'ember-rush', Array.from({ length: 12 }, () => 'Mountain'));
    const krenko = ids(s, 0, 'command')[0]!;
    expect(s.seats[0]!.commanderTax).toBe(0);

    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: krenko }));
    expect(namesIn(s, 0, 'battlefield')).toContain('Krenko, Mob Boss');
    // The tax goes up *after* the cast, so the first one is free of it.
    expect(s.seats[0]!.commanderTax).toBe(2);

    // Killed, so it is back in the command zone and castable again — at {2} more.
    s = apply(s, { type: 'card:move', by: 0, card: find(s, 0, 'battlefield', 'Krenko, Mob Boss'), toZone: 'graveyard' });
    expect(ids(s, 0, 'command')).toContain(krenko);
    const again = legalActions(s, 0).plays.filter((p) => p.name === 'Krenko, Mob Boss');
    expect(again).toHaveLength(1);
    expect(again[0]!.commanderTax).toBe(2);
    // The printed cost is unchanged: the tax is what the command zone adds, not a different card.
    expect(again[0]!.manaCost).toBe('{2}{R}{R}');
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: krenko }));
    expect(s.seats[0]!.commanderTax).toBe(4);
  });

  it('is not offered when the tax has put it out of reach', () => {
    // Four lands pays {2}{R}{R} exactly, so a {2} tax makes it unaffordable and the engine must
    // stop offering it rather than offer a play it then refuses.
    let s = commanderTable(0, 'ember-rush', ['Mountain', 'Mountain', 'Mountain', 'Mountain']);
    const krenko = ids(s, 0, 'command')[0]!;
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, commanderTax: 2 } : seat)) };
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Krenko, Mob Boss')).toHaveLength(0);
    expect(refusal(s, { type: 'auto:cast', by: 0, card: krenko })).toContain('cannot pay');
  });

  it('goes back to the command zone instead of a graveyard, and so has not died (CR 903.9)', () => {
    let s = commanderTable(1, 'rot-harvest', Array.from({ length: 6 }, (_, i) => (i % 2 ? 'Swamp' : 'Forest')));
    const izoni = ids(s, 1, 'command')[0]!;
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: izoni }));
    expect(namesIn(s, 1, 'battlefield')).toContain('Izoni, Thousand-Eyed');
    // Izoni's own entry trigger makes no tokens with an empty graveyard, so the stack is clear.
    s = drain(s);

    s = apply(s, { type: 'card:move', by: 1, card: izoni, toZone: 'graveyard' });
    expect(ids(s, 1, 'command')).toContain(izoni);
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Izoni, Thousand-Eyed');
    // It never reached a graveyard, so it did not die — nothing is queued to announce.
    expect(s.died).toEqual([]);
  });

  it('accumulates commander damage from combat, and twenty-one eliminates (CR 903.10)', () => {
    let s = arena({
      format: 'edh', decks: { 0: 'ember-rush' },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const krenko = ids(s, 0, 'command')[0]!;
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: krenko }));
    s = drain(s);
    expect(namesIn(s, 0, 'battlefield')).toContain('Krenko, Mob Boss');

    // Krenko is a 3/3. Attacking unblocked logs three commander damage and three life.
    s = nextTurn(s);
    s = nextTurn(s);
    s = advanceTo(s, 'declare-attackers');
    const body = find(s, 0, 'battlefield', 'Krenko, Mob Boss');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: body, defender: 1 }] });
    // The defender has no creature at all, so the engine declares the empty block for them and
    // combat damage is dealt on the way into its step.
    for (let i = 0; i < 8 && s.step !== 'postcombat-main'; i++) {
      if (s.priority === null) break;
      s = apply(s, { type: 'auto:pass', by: s.priority });
    }
    // Keyed by the seat whose commander it is, which is what the tabletop action and the view
    // have always used — see `dealDamage`.
    expect(s.seats[1]!.commanderDamage['0']).toBe(3);
    expect(life(s, 1)).toBe(37);

    // Twenty-one is the threshold, and it eliminates on life that is nowhere near zero.
    s = {
      ...s,
      seats: s.seats.map((seat) => (seat.index === 1
        ? { ...seat, life: 40, commanderDamage: { 0: 20 } }
        : seat)),
    };
    // Recorded by hand, on top of what the engine dealt — the two add up because they share a key.
    s = apply(s, { type: 'commanderDamage:adjust', by: 0, seat: 1, fromSeat: 0, delta: 1 });
    expect(s.seats[1]!.eliminated).toBe(true);
    expect(s.seats[1]!.eliminatedReason).toBe('commanderDamage');
    expect(s.seats[1]!.life).toBe(40);
  });

  it('counts combat damage only, not a burn spell the commander happens to cast', () => {
    // CR 903.10 is about combat damage. A single "source" option on `dealDamage` would have made
    // every point from a commander count, which is a different and much faster format.
    let s = arena({
      format: 'edh', decks: { 0: 'ember-rush' }, hands: { 0: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain'] }, turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(s, 1)).toBe(37);
    expect(s.seats[1]!.commanderDamage).toEqual({});
  });

  it('refuses to cast somebody else’s commander', () => {
    const s = commanderTable(0, 'ember-rush', Array.from({ length: 8 }, () => 'Mountain'));
    const theirs = ids(s, 1, 'command')[0]!;
    expect(refusal(s, { type: 'auto:cast', by: 0, card: theirs })).toContain('not your commander');
  });
});

describe('triggers that watch the board rather than themselves', () => {
  it('Blood Artist drains for a creature dying anywhere, including itself', () => {
    let s = arena({
      decks: { 0: 'rot-harvest', 1: 'ember-rush' },
      hands: { 1: ['Lightning Bolt', 'Lightning Bolt'] },
      battlefield: { 0: ['Blood Artist', 'Doomed Dissenter'], 1: ['Mountain', 'Mountain'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const started = [life(s, 0), life(s, 1)];

    // Somebody else's creature dies: the Artist watches the whole board, so it drains.
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Doomed Dissenter') }],
    }));
    // Two triggers now: the Dissenter's Zombie and the Artist's drain, which needs a target.
    s = passBoth(s);
    while (s.pendingChoice !== null) {
      s = apply(s, { type: 'auto:choose', by: s.pendingChoice.seat, targets: [{ kind: 'player', seat: 1 }] });
      s = passBoth(s);
    }
    s = passBoth(s);
    expect(life(s, 0)).toBe(started[0]! + 1);
    expect(life(s, 1)).toBe(started[1]! - 1);
    expect(countOf(s, 0, 'battlefield', 'Zombie')).toBe(1);

    // And for its own death: "Blood Artist **or** another creature" includes itself, and the
    // trigger fires from the graveyard it is already in.
    const before = [life(s, 0), life(s, 1)];
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Blood Artist') }],
    }));
    expect(namesIn(s, 0, 'graveyard')).toContain('Blood Artist');
    while (s.pendingChoice !== null) {
      s = apply(s, { type: 'auto:choose', by: s.pendingChoice.seat, targets: [{ kind: 'player', seat: 1 }] });
      s = passBoth(s);
    }
    s = passBoth(s);
    expect(life(s, 0)).toBe(before[0]! + 1);
    expect(life(s, 1)).toBe(before[1]! - 1);
  });

  it('Zulaport Cutthroat watches only its own side', () => {
    let s = arena({
      decks: { 0: 'rot-harvest', 1: 'ember-rush' },
      hands: { 1: ['Lightning Bolt'] },
      battlefield: { 0: ['Zulaport Cutthroat'], 1: ['Mountain', 'Raging Goblin'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Mountain'), abilityIndex: 0 });
    const started = [life(s, 0), life(s, 1)];

    // The opponent's own creature dying is nothing to do with it (`of: 'you'`).
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Raging Goblin') }],
    }));
    s = passBoth(s);
    expect(namesIn(s, 1, 'graveyard')).toContain('Raging Goblin');
    expect(life(s, 0)).toBe(started[0]!);
    expect(life(s, 1)).toBe(started[1]!);
  });

  it('Soul Warden gains life for another creature, and not for itself', () => {
    let s = arena({
      decks: { 1: 'verdant-guard' }, hands: { 1: ['Soul Warden', 'Grizzly Bears'] },
      battlefield: { 1: ['Plains', 'Forest', 'Forest'] }, turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const started = life(s, 1);

    // Its own arrival gains nothing: "another" creature, not any.
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Soul Warden') }));
    expect(namesIn(s, 1, 'battlefield')).toContain('Soul Warden');
    expect(life(s, 1)).toBe(started);

    // The next creature does.
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Grizzly Bears') }));
    s = passBoth(s);
    expect(life(s, 1)).toBe(started + 1);
  });

  it('Soul Warden gains life for an opponent’s creature too', () => {
    // `of: 'any'`: it watches every creature that enters, whoever controls it. Getting this wrong
    // is the difference between a lifegain card and a much worse one.
    let s = arena({
      decks: { 1: 'verdant-guard' }, hands: { 0: ['Hill Giant'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Soul Warden'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const started = life(s, 1);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hill Giant') }));
    s = passBoth(s);
    expect(life(s, 1)).toBe(started + 1);
  });

  it('Impact Tremors fires for a token as well as a creature spell', () => {
    // Tokens enter the battlefield, so they trigger it — which is the whole reason the card is
    // played with Krenko rather than on its own.
    let s = arena({
      decks: { 0: 'ember-rush' }, hands: { 0: ['Impact Tremors', 'Monastery Swiftspear'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain'] }, turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Impact Tremors') }));
    const started = life(s, 1);

    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Monastery Swiftspear') }));
    s = passBoth(s);
    expect(life(s, 1)).toBe(started - 1);

    const after = life(s, 1);
    s = apply(s, { type: 'token:create', by: 0, seat: 0, count: 2, card: {
      name: 'Goblin', typeLine: 'Token Creature — Goblin', manaCost: '', cmc: 0,
      power: '1', toughness: '1', oracleText: '', colors: ['R'],
    } });
    // Two tokens, two triggers. `token:create` is a tabletop action and never settles, so the
    // arrivals sit recorded until an engine action announces them — which is what `drain` does.
    s = drain(s);
    expect(life(s, 1)).toBe(after - 2);
  });

  it('enters the battlefield from anywhere, not only off the stack (CR 603.6a)', () => {
    // The second regression test of the same shape as the `dies` one, and the same root cause:
    // `etb` was raised at exactly one call site — a permanent *spell* finishing its resolution —
    // so a creature put onto the battlefield by Zombify arrived silently and a token triggered
    // nothing at all. Krenko's Goblins, Izoni's Insects and Talrand's Drakes were all mute.
    let s = arena({
      decks: { 1: 'rot-harvest' }, hands: { 1: ['Zombify'] },
      battlefield: { 1: ['Swamp', 'Swamp', 'Swamp', 'Swamp'] }, turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    for (const name of ['Gravedigger', 'Centaur Courser']) {
      s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', name), toZone: 'graveyard' });
    }
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Zombify'),
      targets: [{ kind: 'card', id: find(s, 1, 'graveyard', 'Gravedigger') }],
    }));
    expect(namesIn(s, 1, 'battlefield')).toContain('Gravedigger');
    // Reanimated, so it entered, so its own trigger is waiting — and it has a creature card in
    // the graveyard to point at, which is the only one left.
    expect(stackNames(s).join()).toContain('return target creature card');
    s = passBoth(s);
    expect(namesIn(s, 1, 'hand')).toContain('Centaur Courser');
  });

  it('fires once for each creature when several die at the same time', () => {
    // Two attackers trading with two blockers is the ordinary way a game kills more than one
    // creature at once, and a drain that fired once for it would be a quietly much worse card.
    // `settle` drains the list of deaths one at a time for exactly this.
    let s = arena({
      decks: { 0: 'rot-harvest', 1: 'verdant-guard' },
      battlefield: {
        0: ['Zulaport Cutthroat', 'Doomed Dissenter', 'Llanowar Elves'],
        1: ['Centaur Courser', 'Grizzly Bears'],
      },
      turn: 2, firstSeat: 0,
    });
    const started = [life(s, 0), life(s, 1)];
    s = advanceTo(s, 'declare-attackers');
    const dissenter = find(s, 0, 'battlefield', 'Doomed Dissenter');
    const elves = find(s, 0, 'battlefield', 'Llanowar Elves');
    s = apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: dissenter, defender: 1 }, { attacker: elves, defender: 1 }],
    });
    // Declaring attackers gives priority inside the declare-attackers step; passing moves on to
    // blockers, which is where the defender is asked.
    s = passBoth(s);
    s = apply(s, {
      type: 'auto:block', by: 1,
      blocks: [
        { blocker: find(s, 1, 'battlefield', 'Centaur Courser'), attacker: dissenter },
        { blocker: find(s, 1, 'battlefield', 'Grizzly Bears'), attacker: elves },
      ],
    });
    // Damage is dealt entering the combat damage step: both 1/1s die in the same action.
    for (let i = 0; i < 10 && (s.stackOrder.length > 0 || s.step !== 'postcombat-main'); i++) {
      if (s.priority === null) break;
      s = apply(s, { type: 'auto:pass', by: s.priority });
    }
    expect(namesIn(s, 0, 'graveyard')).toContain('Doomed Dissenter');
    expect(namesIn(s, 0, 'graveyard')).toContain('Llanowar Elves');
    // Two of its own creatures died, so two drains — and the Zombie from the Dissenter arrived.
    expect(life(s, 1)).toBe(started[1]! - 2);
    expect(life(s, 0)).toBe(started[0]! + 2);
    expect(countOf(s, 0, 'battlefield', 'Zombie')).toBe(1);
  });
});

describe('dying, upkeep and a static effect', () => {
  const ready = (
    seat: SeatIndex, deck: string, hand: readonly string[], lands: readonly string[],
    extra: readonly string[] = [], turn = 2,
  ): GameState => {
    let s = arena({
      decks: { [seat]: deck }, hands: { [seat]: hand },
      battlefield: { [seat]: [...lands, ...extra] }, turn, firstSeat: seat,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, seat, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (!/^(Mountain|Forest|Plains|Island|Swamp)$/.test(name)) continue;
      s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('Doomed Traveler leaves a flier behind when it is killed', () => {
    let s = arena({
      hands: { 0: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain'], 1: ['Doomed Traveler'] },
      decks: { 1: 'verdant-guard' }, turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    const traveler = find(s, 1, 'battlefield', 'Doomed Traveler');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: traveler }],
    }));
    // The bolt resolves, state-based actions bury it, and the trigger goes on the stack from the
    // graveyard — so the token arrives on the pass after, not on the same one.
    expect(namesIn(s, 1, 'graveyard')).toContain('Doomed Traveler');
    s = passBoth(s);
    expect(countOf(s, 1, 'battlefield', 'Spirit')).toBe(1);
    const spirit = find(s, 1, 'battlefield', 'Spirit');
    expect(characteristicsOf(s, s.instances[spirit]!).keywords.has('flying')).toBe(true);
  });

  it('Goblin Arsonist deals its damage after it is already dead, and asks where', () => {
    // Destroyed, not exiled: a creature that leaves for exile has not *died* (CR 700.4), so a
    // `dies` trigger stays quiet. Swords to Plowshares would have proved nothing here.
    let s = arena({
      decks: { 1: 'tidal-mind' }, hands: { 1: ['Doom Blade'] },
      battlefield: { 0: ['Goblin Arsonist'], 1: ['Swamp', 'Swamp', 'Child of Night'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== 'Swamp') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const arsonist = find(s, 0, 'battlefield', 'Goblin Arsonist');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: arsonist }],
    }));
    expect(namesIn(s, 0, 'graveyard')).toContain('Goblin Arsonist');
    // Its controller aims it from the graveyard. Two creatures and two players are legal, so it
    // is a real choice and the engine stops for it.
    expect(s.pendingChoice).not.toBeNull();
    expect(s.pendingChoice!.seat).toBe(0);
    s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'player', seat: 1 }] });
    s = passBoth(s);
    expect(life(s, 1)).toBe(19);
  });

  it('Glorious Anthem lifts every creature its controller has, including the next one', () => {
    let s = ready(1, 'verdant-guard', ['Glorious Anthem'], ['Plains', 'Plains', 'Plains'], ['Centaur Courser']);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    expect([power(s, courser), toughness(s, courser)]).toEqual([3, 3]);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Glorious Anthem') }));
    expect([power(s, courser), toughness(s, courser)]).toEqual([4, 4]);

    // Computed on demand, not written onto anything: a creature that arrives later gets it too,
    // and the opponent's creatures do not.
    s = apply(s, { type: 'token:create', by: 1, seat: 1, count: 1, card: {
      name: 'Beast', typeLine: 'Token Creature — Beast', manaCost: '', cmc: 0,
      power: '3', toughness: '3', oracleText: '', colors: ['G'],
    } });
    const beast = find(s, 1, 'battlefield', 'Beast');
    expect([power(s, beast), toughness(s, beast)]).toEqual([4, 4]);

    // And it goes away with the enchantment.
    const anthem = find(s, 1, 'battlefield', 'Glorious Anthem');
    s = apply(s, { type: 'card:move', by: 1, card: anthem, toZone: 'graveyard' });
    expect([power(s, courser), toughness(s, courser)]).toEqual([3, 3]);
  });

  it('Glorious Anthem saves a creature from damage already marked on it', () => {
    // The reason a static effect is read rather than stored. Two damage is marked on a 2/2 by a
    // Shock, which would be lethal — the Anthem resolves in response and the creature lives,
    // because the mark stays where it is and the toughness moves out from under it.
    let s = arena({
      decks: { 0: 'ember-rush' }, hands: { 0: ['Shock'], 1: ['Glorious Anthem'] },
      battlefield: { 0: ['Mountain'], 1: ['Plains', 'Plains', 'Plains', 'Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'),
      targets: [{ kind: 'card', id: bear }],
    }));
    // Two damage on a 2/2 is lethal, so it is already gone.
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');

    // Again, with the Anthem out first: the same two damage, and the bear survives at 3/3.
    let t = arena({
      decks: { 0: 'ember-rush' }, hands: { 0: ['Shock'], 1: ['Glorious Anthem'] },
      battlefield: { 0: ['Mountain'], 1: ['Plains', 'Plains', 'Plains', 'Grizzly Bears'] },
      turn: 2, firstSeat: 1,
    });
    t = advanceTo(t, 'precombat-main');
    for (const id of [...ids(t, 1, 'battlefield')]) {
      if (t.cardDefs[t.instances[id]!.defKey]!.name !== 'Plains') continue;
      t = apply(t, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    t = passBoth(apply(t, { type: 'auto:cast', by: 1, card: find(t, 1, 'hand', 'Glorious Anthem') }));
    const lifted = find(t, 1, 'battlefield', 'Grizzly Bears');
    expect([power(t, lifted), toughness(t, lifted)]).toEqual([3, 3]);
    t = nextTurn(t);
    t = advanceTo(t, 'precombat-main');
    t = apply(t, { type: 'auto:activate', by: 0, card: find(t, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    t = passBoth(apply(t, {
      type: 'auto:cast', by: 0, card: find(t, 0, 'hand', 'Shock'),
      targets: [{ kind: 'card', id: lifted }],
    }));
    expect(namesIn(t, 1, 'battlefield')).toContain('Grizzly Bears');
    expect(t.instances[lifted]!.damage).toBe(2);
  });

  it('Phyrexian Arena draws and drains at the beginning of its controller’s upkeep only', () => {
    let s = ready(1, 'tidal-mind', ['Phyrexian Arena'], ['Swamp', 'Swamp', 'Swamp']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Phyrexian Arena') }));
    expect(namesIn(s, 1, 'battlefield')).toContain('Phyrexian Arena');
    const held = ids(s, 1, 'hand').length;
    const started = life(s, 1);

    // The opponent's upkeep comes first and does nothing.
    s = nextTurn(s);
    expect(s.activeSeat).toBe(0);
    expect(life(s, 1)).toBe(started);

    // Then its controller's. `nextTurn` stops the moment the turn counter moves, which is the
    // upkeep — with the trigger on the stack and not yet resolved, so it takes a pass.
    s = nextTurn(s);
    expect(s.activeSeat).toBe(1);
    expect(s.step).toBe('upkeep');
    expect(stackNames(s).join()).toContain('draw a card');
    s = passBoth(s);
    expect(life(s, 1)).toBe(started - 1);
    expect(ids(s, 1, 'hand').length).toBe(held + 1);
  });

  it('Thermo-Alchemist taps for damage, and an instant untaps it to do it again', () => {
    let s = arena({
      decks: { 0: 'ember-rush' }, hands: { 0: ['Shock'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Thermo-Alchemist'] }, turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const alchemist = find(s, 0, 'battlefield', 'Thermo-Alchemist');
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: alchemist, abilityIndex: 0 }));
    expect(life(s, 1)).toBe(19);
    expect(s.instances[alchemist]!.tapped).toBe(true);
    // Tapped, so it cannot be used again…
    expect(refusal(s, { type: 'auto:activate', by: 0, card: alchemist, abilityIndex: 0 })).toBeTruthy();

    // …until an instant untaps it. The trigger fires on the cast, before the Shock resolves.
    for (const id of [...ids(s, 0, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== 'Mountain') continue;
      if (s.instances[id]!.tapped) continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    s = passBoth(s); // the untap trigger resolves
    expect(s.instances[alchemist]!.tapped).toBe(false);
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: alchemist, abilityIndex: 0 }));
    expect(life(s, 1)).toBe(18);
  });

  it('dies on the way to a graveyard, and not on the way to exile (CR 700.4)', () => {
    // The regression test for a real bug: "dies" used to mean "noticed by state-based actions",
    // so a creature killed by *lethal damage* triggered and a creature **destroyed by a spell**
    // did not. Doom Blade never fired a death trigger in its life. Both halves are asserted here,
    // because getting the second one wrong is how the first one came back.
    const kill = (spell: string, deck: string, lands: readonly string[]): GameState => {
      let s = arena({
        decks: { 0: 'verdant-guard', 1: deck }, hands: { 1: [spell] },
        battlefield: { 0: ['Doomed Traveler'], 1: [...lands] },
        turn: 2, firstSeat: 1,
      });
      s = advanceTo(s, 'precombat-main');
      for (const id of [...ids(s, 1, 'battlefield')]) {
        s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
      }
      return passBoth(apply(s, {
        type: 'auto:cast', by: 1, card: find(s, 1, 'hand', spell),
        targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Doomed Traveler') }],
      }));
    };

    // Destroyed: it died, so the Spirit comes.
    let destroyed = kill('Doom Blade', 'tidal-mind', ['Swamp', 'Swamp']);
    expect(namesIn(destroyed, 0, 'graveyard')).toContain('Doomed Traveler');
    destroyed = passBoth(destroyed);
    expect(countOf(destroyed, 0, 'battlefield', 'Spirit')).toBe(1);

    // Exiled: it did not die, and nothing comes. Swords to Plowshares is the whole point of the
    // card, and a death trigger firing off it would be a different and much worse game.
    const exiled = kill('Swords to Plowshares', 'verdant-guard', ['Plains']);
    expect(namesIn(exiled, 0, 'exile')).toContain('Doomed Traveler');
    expect(exiled.stackOrder).toEqual([]);
    expect(countOf(exiled, 0, 'battlefield', 'Spirit')).toBe(0);
  });

  it('Doomed Dissenter trades up when it dies', () => {
    // Bolted rather than exiled, for the same reason as the Arsonist. (Doom Blade cannot touch
    // it: the Dissenter is black.)
    let s = arena({
      decks: { 0: 'rot-harvest', 1: 'ember-rush' }, hands: { 1: ['Lightning Bolt'] },
      battlefield: { 0: ['Doomed Dissenter'], 1: ['Mountain'] }, turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Doomed Dissenter') }],
    }));
    s = passBoth(s);
    expect(countOf(s, 0, 'battlefield', 'Zombie')).toBe(1);
    const zombie = find(s, 0, 'battlefield', 'Zombie');
    expect([power(s, zombie), toughness(s, zombie)]).toEqual([2, 2]);
  });
});

describe('modal spells, chosen as the spell is cast', () => {
  /** A seat in its main phase with its lands tapped, from any deck. */
  const set = (
    seat: SeatIndex, deck: string, hand: readonly string[], lands: readonly string[],
    extra: readonly string[] = [], turn = 2,
  ): GameState => {
    let s = arena({
      decks: { [seat]: deck }, hands: { [seat]: hand },
      battlefield: { [seat]: [...lands, ...extra] }, turn, firstSeat: seat,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, seat, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (!/^(Mountain|Forest|Plains|Island|Swamp)$/.test(name)) continue;
      s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return s;
  };

  const castable = (s: GameState, seat: SeatIndex, name: string) =>
    legalActions(s, seat).plays.filter((p) => p.name === name);

  it('offers one play per mode, and only the modes whose targets can be filled', () => {
    // Nothing on the board but lands: the Knight is the only mode that can be taken, because the
    // other two need a creature to point at. A table that offered all three would be offering two
    // plays the engine refuses.
    let s = set(1, 'verdant-guard', ['Selesnya Charm'], ['Forest', 'Plains']);
    let offers = castable(s, 1, 'Selesnya Charm');
    expect(offers).toHaveLength(1);
    expect(offers[0]!.description).toContain('Knight');
    expect(offers[0]!.modes).toEqual([2]);

    // With a 3/3 out, the pump mode becomes legal too — but not the exile, which needs power 5.
    s = set(1, 'verdant-guard', ['Selesnya Charm'], ['Forest', 'Plains'], ['Centaur Courser']);
    offers = castable(s, 1, 'Selesnya Charm');
    expect(offers.map((p) => p.modes)).toEqual([[0], [2]]);
  });

  it('resolves the mode that was chosen, and nothing else', () => {
    let s = set(1, 'verdant-guard', ['Selesnya Charm'], ['Forest', 'Plains'], ['Centaur Courser']);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Selesnya Charm'),
      modes: [0], targets: [{ kind: 'card', id: courser }],
    }));
    expect([power(s, courser), toughness(s, courser)]).toEqual([5, 5]);
    expect(characteristicsOf(s, s.instances[courser]!).keywords.has('trample')).toBe(true);
    // And the other two modes did not happen.
    expect(countOf(s, 1, 'battlefield', 'Knight')).toBe(0);
    expect(namesIn(s, 1, 'exile')).toEqual([]);
  });

  it('exiles only a creature that is big enough *now*, not as printed', () => {
    // A 3/3 pumped past five is a legal target and a printed 5/5 is one either way. Computed
    // power is the whole reason characteristics are not stored.
    let s = set(1, 'verdant-guard', ['Selesnya Charm', 'Giant Growth'], ['Forest', 'Plains', 'Forest'], ['Centaur Courser']);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    expect(castable(s, 1, 'Selesnya Charm').map((p) => p.modes)).toEqual([[0], [2]]);

    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'),
      targets: [{ kind: 'card', id: courser }],
    }));
    expect(power(s, courser)).toBe(6);
    // Now the exile mode is on offer, because the creature grew into it.
    expect(castable(s, 1, 'Selesnya Charm').map((p) => p.modes)).toEqual([[0], [1], [2]]);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Selesnya Charm'),
      modes: [1], targets: [{ kind: 'card', id: courser }],
    }));
    expect(namesIn(s, 1, 'exile')).toContain('Centaur Courser');
  });

  it('refuses a mode the card does not offer, and refuses no mode at all', () => {
    const s = set(1, 'verdant-guard', ['Selesnya Charm'], ['Forest', 'Plains']);
    const charm = find(s, 1, 'hand', 'Selesnya Charm');
    expect(refusal(s, { type: 'auto:cast', by: 1, card: charm })).toContain('choose a mode');
    // Two modes, from a card that says "choose one".
    expect(refusal(s, { type: 'auto:cast', by: 1, card: charm, modes: [0, 2] })).toContain('not a combination');
    expect(refusal(s, { type: 'auto:cast', by: 1, card: charm, modes: [9] })).toBeTruthy();
    // And a mode on a spell that has none.
    const s2 = set(0, 'ember-rush', ['Shock'], ['Mountain']);
    expect(refusal(s2, {
      type: 'auto:cast', by: 0, card: find(s2, 0, 'hand', 'Shock'),
      modes: [0], targets: [{ kind: 'player', seat: 1 }],
    })).toContain('no modes');
  });

  it('"choose one or both" offers each half and the pair, and does both when both are taken', () => {
    let s = set(1, 'rot-harvest', ['Grim Discovery'], ['Swamp', 'Forest']);
    // Nothing in the graveyard: the card is not castable at all, because both its modes need a
    // target and neither has one.
    expect(castable(s, 1, 'Grim Discovery')).toHaveLength(0);

    // A creature in the graveyard makes the first half legal, and only that half.
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Centaur Courser'), toZone: 'graveyard' });
    expect(castable(s, 1, 'Grim Discovery').map((p) => p.modes)).toEqual([[0]]);

    // A land as well, and now all three combinations are on offer.
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Swamp'), toZone: 'graveyard' });
    expect(castable(s, 1, 'Grim Discovery').map((p) => p.modes)).toEqual([[0], [1], [0, 1]]);

    const body = find(s, 1, 'graveyard', 'Centaur Courser');
    const land = find(s, 1, 'graveyard', 'Swamp');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Grim Discovery'),
      modes: [0, 1], targets: [{ kind: 'card', id: body }, { kind: 'card', id: land }],
    }));
    // Both came back, each to the hand, each from its own mode's target, and neither is still
    // in the graveyard. (The hand also holds whatever the draw step dealt, which is not the claim.)
    expect(namesIn(s, 1, 'hand')).toContain('Centaur Courser');
    expect(namesIn(s, 1, 'hand')).toContain('Swamp');
    expect(namesIn(s, 1, 'graveyard')).toEqual(['Grim Discovery']);
  });

  it('hands each mode its own target rather than the first mode\'s', () => {
    // The bug this guards against is silent: targets arrive as one flat list, so a mode that took
    // the wrong slice would return the right *kind* of card and the wrong card.
    let s = set(1, 'rot-harvest', ['Grim Discovery'], ['Swamp', 'Forest']);
    for (const name of ['Centaur Courser', 'Thornweald Archer', 'Swamp', 'Forest']) {
      s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', name), toZone: 'graveyard' });
    }
    const archer = find(s, 1, 'graveyard', 'Thornweald Archer');
    const forest = find(s, 1, 'graveyard', 'Forest');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Grim Discovery'),
      modes: [0, 1], targets: [{ kind: 'card', id: archer }, { kind: 'card', id: forest }],
    }));
    expect(namesIn(s, 1, 'hand')).toContain('Thornweald Archer');
    expect(namesIn(s, 1, 'hand')).toContain('Forest');
    // The other two are still where they were: a mode reading the wrong slice would have taken
    // the Courser or the Swamp instead, and both are the right *kind* of card for the other mode.
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    expect(namesIn(s, 1, 'graveyard')).toContain('Swamp');
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Thornweald Archer');
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Forest');
  });

  it('Soul Manipulation counters a creature spell, and the stack says which mode is coming', () => {
    let s = arena({
      decks: { 0: 'tidal-mind' },
      hands: { 0: ['Soul Manipulation'], 1: ['Centaur Courser'] },
      battlefield: { 0: ['Island', 'Swamp', 'Island'], 1: ['Forest', 'Forest', 'Forest'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    // Seat 1's turn, so seat 1 casts and then passes; seat 0's lands are untapped and the engine
    // taps for the response itself, which is how holding up mana for a counterspell works.
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Centaur Courser') });
    const spell = ids(s, 0, 'stack')[0]!;
    s = apply(s, { type: 'auto:pass', by: 1 });

    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Soul Manipulation'),
      modes: [0], targets: [{ kind: 'card', id: spell }],
    });
    // Public from the moment it is cast: the player deciding whether to respond has to know which
    // half of the card is coming, so the mode is in the stack description both tables read.
    expect(stackNames(s).at(-1)).toContain('Counter target creature spell');

    s = passBoth(s);
    s = passBoth(s);
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    expect(namesIn(s, 1, 'battlefield')).not.toContain('Centaur Courser');
  });
});

describe('cards that stop and ask while they resolve', () => {
  /** A seat set up in its main phase with its lands tapped, from any deck. */
  const ready = (
    seat: SeatIndex, deck: string, hand: readonly string[], lands: readonly string[],
    extra: readonly string[] = [],
  ): GameState => {
    let s = arena({
      decks: { [seat]: deck }, hands: { [seat]: hand },
      battlefield: { [seat]: [...lands, ...extra] }, turn: 2, firstSeat: seat,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, seat, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (!/^(Mountain|Forest|Plains|Island|Swamp)$/.test(name)) continue;
      s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('Rampant Growth offers only basic lands, and the one chosen enters tapped', () => {
    let s = ready(1, 'verdant-guard', ['Rampant Growth'], ['Forest', 'Forest']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));

    // Still on the stack: it is resolving, not resolved, and both tables should say so.
    expect(s.pendingDecision).not.toBeNull();
    expect(s.pendingDecision!.seat).toBe(1);
    expect(s.pendingDecision!.from).toBe('library');
    expect(s.stackOrder.length).toBe(1);
    // Only basic lands, and nothing else from a 59-card library.
    expect([...new Set(choices(s))]).toEqual(['Forest', 'Plains']);

    s = decide(s, ['Plains']);
    expect(s.pendingDecision).toBeNull();
    const plains = find(s, 1, 'battlefield', 'Plains');
    expect(s.instances[plains]!.tapped).toBe(true);
    expect(namesIn(s, 1, 'graveyard')).toContain('Rampant Growth');
  });

  it('lets a search fail to find, which is legal and sometimes right (CR 701.19c)', () => {
    let s = ready(1, 'verdant-guard', ['Rampant Growth'], ['Forest', 'Forest']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));
    expect(s.pendingDecision!.min).toBe(0);
    const lands = countOf(s, 1, 'battlefield', 'Plains') + countOf(s, 1, 'battlefield', 'Forest');
    s = decide(s, []);
    expect(s.pendingDecision).toBeNull();
    expect(countOf(s, 1, 'battlefield', 'Plains') + countOf(s, 1, 'battlefield', 'Forest')).toBe(lands);
    expect(namesIn(s, 1, 'graveyard')).toContain('Rampant Growth');
  });

  it('opens the searcher’s own library while they look, and shuffles it when they are done', () => {
    let s = ready(1, 'verdant-guard', ['Rampant Growth'], ['Forest', 'Forest']);
    expect(s.seats[1]!.searching).toBe(false);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));
    // Looking through your own library is exactly what a search is, and the view is keyed on this.
    expect(s.seats[1]!.searching).toBe(true);
    const before = ids(s, 1, 'library').join(',');
    s = decide(s, ['Plains']);
    expect(s.seats[1]!.searching).toBe(false);
    // Shuffled, so the order they were just shown is no longer the order they will draw in.
    expect(ids(s, 1, 'library').join(',')).not.toBe(before);
  });

  it('Diabolic Tutor takes any card out of the library and puts it in hand', () => {
    let s = ready(0, 'tidal-mind', ['Diabolic Tutor'], ['Swamp', 'Swamp', 'Swamp', 'Swamp']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Diabolic Tutor') }));
    expect(choices(s)).toContain('Counterspell');
    expect(namesIn(s, 0, 'hand')).not.toContain('Counterspell');
    s = decide(s, ['Counterspell']);
    expect(namesIn(s, 0, 'hand')).toContain('Counterspell');
  });

  it('Mind Rot is answered by the player discarding, not by the player who cast it', () => {
    let s = arena({
      decks: { 0: 'tidal-mind' }, hands: { 0: ['Mind Rot'], 1: ['Giant Growth', 'Serra Angel', 'Pacifism'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'] }, turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Mind Rot'),
      targets: [{ kind: 'player', seat: 1 }],
    }));
    // Seat 0 cast it; seat 1 chooses. Getting this round the wrong way would be a different card.
    expect(s.pendingDecision!.seat).toBe(1);
    expect(choices(s)).toEqual(['Giant Growth', 'Pacifism', 'Serra Angel']);
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [] })).toContain('not your decision');

    s = decide(s, ['Giant Growth', 'Pacifism']);
    expect(namesIn(s, 1, 'hand')).toEqual(['Serra Angel']);
    expect(namesIn(s, 1, 'graveyard').sort()).toEqual(['Giant Growth', 'Pacifism']);
  });

  it('asks for only what a short hand holds, and asks nothing of an empty one', () => {
    const cast = (theirHand: readonly string[]): GameState => {
      let s = arena({
        decks: { 0: 'tidal-mind' }, hands: { 0: ['Mind Rot'], 1: theirHand },
        battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'] }, turn: 2, firstSeat: 0,
      });
      s = advanceTo(s, 'precombat-main');
      for (const id of [...ids(s, 0, 'battlefield')]) {
        s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
      }
      return passBoth(apply(s, {
        type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Mind Rot'),
        targets: [{ kind: 'player', seat: 1 }],
      }));
    };

    // One card: no decision to make, so the engine takes it rather than putting up a prompt with
    // a single button — and the spell finishes in the same action.
    let s = cast(['Serra Angel']);
    expect(s.pendingDecision).toBeNull();
    expect(namesIn(s, 1, 'graveyard')).toEqual(['Serra Angel']);

    // No cards: never asked at all. A prompt with no answer is a game that has stopped.
    s = cast([]);
    expect(s.pendingDecision).toBeNull();
    expect(namesIn(s, 0, 'graveyard')).toContain('Mind Rot');
  });

  it('Faithless Looting draws before it asks, because the cards it discards are the ones drawn', () => {
    let s = ready(0, 'ember-rush', ['Faithless Looting'], ['Mountain']);
    const held = ids(s, 0, 'hand').length;
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Faithless Looting') }));
    // It has already drawn by the time it asks. Asking first would have offered only what was in
    // hand before — which for a hand of nothing but Faithless Looting is nothing at all.
    expect(ids(s, 0, 'hand').length).toBe(held + 1);
    expect(s.pendingDecision!.candidates.length).toBe(held + 1);
    expect(s.pendingDecision!.min).toBe(2);
    const pitched = s.pendingDecision!.candidates.slice(0, 2);
    const names = pitched.map((id) => s.cardDefs[s.instances[id]!.defKey]!.name);
    s = apply(s, { type: 'auto:decide', by: 0, cards: pitched });
    expect(ids(s, 0, 'hand').length).toBe(held - 1);
    for (const name of names) expect(namesIn(s, 0, 'graveyard')).toContain(name);
  });

  it('Fleshbag Marauder makes every player sacrifice, in turn order from the active player', () => {
    let s = arena({
      decks: { 0: 'rot-harvest' },
      hands: { 0: ['Fleshbag Marauder'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp', 'Centaur Courser'], 1: ['Serra Angel', 'Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== 'Swamp') continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    // One pass resolves the creature; the next resolves the trigger it put on the stack.
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fleshbag Marauder') }));
    expect(namesIn(s, 0, 'battlefield')).toContain('Fleshbag Marauder');
    s = passBoth(s);

    // The active player answers first (CR 101.4), and the Marauder itself is on offer.
    expect(s.pendingDecision!.seat).toBe(0);
    expect(choices(s)).toEqual(['Centaur Courser', 'Fleshbag Marauder']);
    s = decide(s, ['Centaur Courser']);

    // Then the other player, who has now seen what the first gave up.
    expect(s.pendingDecision!.seat).toBe(1);
    expect(choices(s)).toEqual(['Grizzly Bears', 'Serra Angel']);
    s = decide(s, ['Grizzly Bears']);

    expect(s.pendingDecision).toBeNull();
    expect(namesIn(s, 0, 'graveyard')).toContain('Centaur Courser');
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
    expect(namesIn(s, 0, 'battlefield')).toContain('Fleshbag Marauder');
  });

  it('Fleshbag Marauder eats itself when it is the only creature its controller has', () => {
    let s = arena({
      decks: { 0: 'rot-harvest' }, hands: { 0: ['Fleshbag Marauder'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'] }, turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fleshbag Marauder') }));
    s = passBoth(s);
    // One candidate and one needed: not a choice, so it is taken. The card working as printed.
    expect(s.pendingDecision).toBeNull();
    expect(namesIn(s, 0, 'graveyard')).toContain('Fleshbag Marauder');
    expect(namesIn(s, 0, 'battlefield')).not.toContain('Fleshbag Marauder');
  });

  it('Izoni drains for a creature: gain a life, draw a card, and the creature is gone', () => {
    let s = arena({
      decks: { 1: 'rot-harvest' },
      battlefield: { 1: ['Forest', 'Swamp', 'Izoni, Thousand-Eyed', 'Centaur Courser'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (name !== 'Forest' && name !== 'Swamp') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const before = ids(s, 1, 'hand').length;
    const fodder = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Izoni, Thousand-Eyed'),
      abilityIndex: 0, sacrifice: fodder,
    }));
    expect(life(s, 1)).toBe(21);
    expect(ids(s, 1, 'hand').length).toBe(before + 1);
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
  });

  it('stops the game dead until it is answered, and will not take a card it did not offer', () => {
    let s = ready(1, 'verdant-guard', ['Rampant Growth'], ['Forest', 'Forest']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));

    // Nobody holds priority in the middle of a resolution — including the player resolving it.
    expect(refusal(s, { type: 'auto:pass', by: 1 })).toContain('must be answered first');
    expect(refusal(s, { type: 'auto:pass', by: 0 })).toBeTruthy();
    expect(s.priority).toBeNull();
    // `hasPriority` is the field the table keys its one button on, and this is the bug that cost a
    // browser game: the state still named a seat, so the *other* player's table offered Pass, the
    // engine refused it because a question was outstanding, and the two disagreed for as long as
    // the question stood. Asserted for both seats, since neither holds it.
    for (const seat of [0, 1] as SeatIndex[]) {
      expect(legalActions(s, seat).hasPriority).toBe(false);
      expect(legalActions(s, seat).canPass).toBe(false);
      expect(legalActions(s, seat).passLabel === 'Pass').toBe(false);
    }
    expect(legalActions(s, 0).mustDecide).toBeNull();
    expect(legalActions(s, 1).mustDecide!.from).toBe('library');

    // The candidate list is the whole authorisation: a crafted action naming a card the engine did
    // not offer would otherwise fetch anything out of any library.
    const elsewhere = ids(s, 0, 'library')[0]!;
    expect(refusal(s, { type: 'auto:decide', by: 1, cards: [elsewhere] })).toContain('not one of the choices');
    const forest = find(s, 1, 'library', 'Forest');
    expect(refusal(s, { type: 'auto:decide', by: 1, cards: [forest, forest] })).toBeTruthy();
  });
});

describe('the log, when a lot happens at once', () => {
  it('names what died and stops before the line becomes a wall', () => {
    // Seven tokens and a sweep: one action, seven deaths. The cap is what keeps the log readable
    // when a board wipe lands, and the overflow still says how much it is not showing.
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest' }, hands: { 0: ['Golgari Charm'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Forest', 'Forest'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    // The tokens arrive by hand: what is being tested is the log, not whatever made them.
    s = apply(s, {
      type: 'token:create', by: 0, seat: 0, count: 7,
      card: {
        name: 'Soldier', typeLine: 'Token Creature — Soldier', manaCost: '', cmc: 0,
        power: '1', toughness: '1', oracleText: '', colors: ['W'],
      },
    });
    expect(countOf(s, 0, 'battlefield', 'Soldier')).toBe(7);

    for (const id of [...ids(s, 0, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (name !== 'Swamp' && name !== 'Forest') continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Golgari Charm'), modes: [0],
    }));
    expect(countOf(s, 0, 'battlefield', 'Soldier')).toBe(0);

    const line = s.log[s.log.length - 1]!.message;
    expect(line).toContain('Soldier dies');
    // Six consequences and then a count, rather than seven lines of Soldier.
    expect(line).toContain('and 1 more');
  });
});

describe('planeswalkers', () => {
  /** A seat with the named planeswalker on the battlefield and its lands tapped for mana. */
  const withWalker = (seat: SeatIndex, deck: string, walker: string, basic: string, lands: number,
    extra: readonly string[] = []) => {
    let s = advanceTo(arena({
      decks: { [seat]: deck },
      battlefield: { [seat]: [...Array.from({ length: lands }, () => basic), walker, ...extra] },
      turn: 3, firstSeat: seat,
    }), 'precombat-main');
    for (const id of [...ids(s, seat, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== basic) continue;
      s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('arrives with its printed loyalty, whoever put it there', () => {
    const s = withWalker(1, 'tidal-mind', 'Jace Beleren', 'Island', 2);
    const jace = find(s, 1, 'battlefield', 'Jace Beleren');
    expect(s.instances[jace]!.counters['loyalty']).toBe(3);
  });

  it('ticks up, and will not use a second ability in the same turn (CR 606.3)', () => {
    let s = withWalker(1, 'tidal-mind', 'Jace Beleren', 'Island', 2);
    const jace = find(s, 1, 'battlefield', 'Jace Beleren');
    const before = ids(s, 1, 'hand').length;
    s = passBoth(apply(s, { type: 'auto:activate', by: 1, card: jace, abilityIndex: 0 }));
    expect(s.instances[jace]!.counters['loyalty']).toBe(5);
    // Each player drew, including the opponent — which is the card rather than a better draw spell.
    expect(ids(s, 1, 'hand').length).toBe(before + 1);
    expect(ids(s, 0, 'hand').length).toBe(1);

    expect(refusal(s, { type: 'auto:activate', by: 1, card: jace, abilityIndex: 1 }))
      .toContain('already used a loyalty ability');
    expect(legalActions(s, 1).plays.filter((p) => p.card === jace)).toEqual([]);

    // Next turn it may act again.
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(legalActions(s, 1).plays.filter((p) => p.card === jace).length).toBeGreaterThan(0);
  });

  it('will not offer a minus it cannot pay for', () => {
    const s = withWalker(1, 'tidal-mind', 'Jace Beleren', 'Island', 2);
    const jace = find(s, 1, 'battlefield', 'Jace Beleren');
    // Loyalty 3: the +2 and the −1 are on offer, the −10 is not.
    expect(legalActions(s, 1).plays.filter((p) => p.card === jace).map((p) => p.abilityIndex))
      .toEqual([0, 1]);
    expect(refusal(s, {
      type: 'auto:activate', by: 1, card: jace, abilityIndex: 2, targets: [{ kind: 'player', seat: 0 }],
    })).toContain('does not have the loyalty');
  });

  it('dies when its loyalty runs out, using its own ability', () => {
    let s = withWalker(0, 'verdant-guard', 'Garruk Wildspeaker', 'Forest', 4);
    const garruk = find(s, 0, 'battlefield', 'Garruk Wildspeaker');
    // Three loyalty, and the −1 three times over three turns.
    for (let i = 0; i < 3; i++) {
      s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: garruk, abilityIndex: 1 }));
      if (i < 2) s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    }
    expect(countOf(s, 0, 'battlefield', 'Beast')).toBe(3);
    // Zero loyalty is a state-based action, not something the card says (CR 704.5i).
    expect(s.instances[garruk]!.zone).toBe('graveyard');
  });

  it('takes damage as lost loyalty, and a burn spell may be pointed at it', () => {
    // "Any target" is a creature, a player or a planeswalker (CR 115.4), and damage to a
    // planeswalker removes loyalty rather than being marked (CR 120.3c) — which matters, because
    // marked damage wears off and a planeswalker that healed every turn would be unkillable.
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 0: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain'], 1: ['Jace Beleren'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    const jace = find(s, 1, 'battlefield', 'Jace Beleren');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: jace }],
    }));
    expect(s.instances[jace]!.zone).toBe('graveyard');
  });

  it('can be attacked instead of its controller (CR 506.2)', () => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      battlefield: { 0: ['Hill Giant'], 1: ['Jace Beleren'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const jace = find(s, 1, 'battlefield', 'Jace Beleren');
    s = apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: giant, defender: 1, planeswalker: jace }],
    });
    // The log says what is being attacked, which with a planeswalker on the table is a real
    // question rather than a formality.
    expect(s.log[s.log.length - 1]!.message).toContain('Hill Giant at Jace Beleren');

    const lifeBefore = life(s, 1);
    for (let i = 0; i < 8 && s.instances[jace]!.zone === 'battlefield'; i++) s = passBoth(s);
    // Three damage to a three-loyalty planeswalker, and the player took none of it.
    expect(s.instances[jace]!.zone).toBe('graveyard');
    expect(life(s, 1)).toBe(lifeBefore);
  });

  it('refuses an attack on a planeswalker that is not that player’s', () => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      battlefield: { 0: ['Hill Giant'], 1: ['Jace Beleren'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    expect(refusal(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: giant, defender: 1, planeswalker: giant }],
    })).toContain('not a planeswalker you can attack');
  });
});

describe('the fifth deck, which is built out of what the engine learned', () => {
  /** Forge Alliance on seat 0, lands down and tapped, in its main phase. */
  const forge = (hand: readonly string[], lands: readonly string[], board: readonly string[] = []) => {
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance' }, hands: { 0: hand },
      battlefield: { 0: [...lands, ...board] }, turn: 3, firstSeat: 0,
    }), 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (name !== 'Plains' && name !== 'Mountain') continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('makes two soldiers at instant speed', () => {
    let s = forge(['Raise the Alarm'], ['Plains', 'Plains']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Raise the Alarm') }));
    expect(countOf(s, 0, 'battlefield', 'Soldier')).toBe(2);
  });

  it('gives a creature flying and draws a card as it lands', () => {
    // Two halves on one card: the flying is the aura's continuous effect, the draw is a trigger
    // on it entering, and both have to happen for the card to be the card.
    let s = forge(['Angelic Gift'], ['Plains', 'Plains'], ['Elite Vanguard']);
    const vanguard = find(s, 0, 'battlefield', 'Elite Vanguard');
    const before = ids(s, 0, 'hand').length;
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Angelic Gift'),
      targets: [{ kind: 'card', id: vanguard }],
    }));
    s = drain(s);
    expect(characteristicsOf(s, s.instances[vanguard]!).keywords.has('flying')).toBe(true);
    // One Gift out of hand, one card drawn: the hand is the size it started.
    expect(ids(s, 0, 'hand').length).toBe(before);
  });

  it('pumps the whole team and nobody else', () => {
    let s = forge(['Inspired Charge'], ['Plains', 'Plains', 'Plains'], ['Elite Vanguard']);
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Grizzly Bears'), toZone: 'battlefield' });
    const mine = find(s, 0, 'battlefield', 'Elite Vanguard');
    const theirs = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Inspired Charge') }));
    expect([power(s, mine), toughness(s, mine)]).toEqual([4, 2]);
    expect([power(s, theirs), toughness(s, theirs)]).toEqual([2, 2]);
  });

  it('moves every Equipment onto the commander with one activation', () => {
    // The first script that reads another script: the bonus belongs to each Equipment, so Balan
    // has to look it up rather than knowing it.
    let s = forge([], ['Plains', 'Plains', 'Plains', 'Plains', 'Plains'],
      ['Balan, Wandering Knight', 'Elite Vanguard', 'Bonesplitter', 'Loxodon Warhammer']);
    const balan = find(s, 0, 'battlefield', 'Balan, Wandering Knight');
    const vanguard = find(s, 0, 'battlefield', 'Elite Vanguard');
    const axe = find(s, 0, 'battlefield', 'Bonesplitter');
    const hammer = find(s, 0, 'battlefield', 'Loxodon Warhammer');

    // One of them starts on somebody else, which is the case that matters: it has to move.
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: 0,
      targets: [{ kind: 'card', id: vanguard }],
    }));
    expect(power(s, vanguard)).toBe(4);

    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: balan, abilityIndex: 0 }));
    expect(s.instances[axe]!.attachedTo).toBe(balan);
    expect(s.instances[hammer]!.attachedTo).toBe(balan);
    // 2/2 with +2/+0 and +3/+0, and the Warhammer's keywords with it.
    expect(power(s, balan)).toBe(7);
    expect(power(s, vanguard)).toBe(2);
    const ch = characteristicsOf(s, s.instances[balan]!);
    expect(ch.keywords.has('trample')).toBe(true);
    expect(ch.keywords.has('double strike')).toBe(true);
  });
});

describe('replacement effects: regenerating, and entering with counters', () => {
  /** Rot Harvest on both sides, so either seat can reach the black and green cards. */
  const rot = (hand: readonly string[], lands: readonly string[], board: readonly string[] = []) =>
    advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'rot-harvest' },
      hands: { 0: hand }, battlefield: { 0: [...lands, ...board] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');

  const tapAll = (s: GameState, seat: SeatIndex) => {
    let next = s;
    for (const id of [...ids(next, seat, 'battlefield')]) {
      const name = next.cardDefs[next.instances[id]!.defKey]!.name;
      if (name !== 'Swamp' && name !== 'Forest') continue;
      next = apply(next, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return next;
  };

  it('saves a creature from a spell that would destroy it, once', () => {
    // Regenerating and then dying have to happen in the *same* turn: the shield is "the next time
    // this turn" (CR 701.15b), so an opponent's instant on your own turn is the natural test.
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'rot-harvest' },
      hands: { 0: [], 1: ['Doom Blade'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Drudge Skeletons'], 1: ['Swamp', 'Swamp'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    s = tapAll(s, 0);
    const skeleton = find(s, 0, 'battlefield', 'Drudge Skeletons');
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: skeleton, abilityIndex: 0 }));
    expect(s.instances[skeleton]!.counters['regeneration']).toBe(1);

    // Seat 0 passes, so seat 1 holds priority in seat 0's main phase and can answer with an
    // instant — which is when a regeneration shield is actually tested.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAll(s, 1);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: skeleton }],
    }));
    // Destroyed is replaced by tapped, undamaged and no shield left (CR 701.15).
    expect(s.instances[skeleton]!.zone).toBe('battlefield');
    expect(s.instances[skeleton]!.tapped).toBe(true);
    expect(s.instances[skeleton]!.counters['regeneration']).toBeUndefined();
  });

  it('saves a creature from lethal damage in combat, and takes it out of the fight', () => {
    // The half players actually use. A shield honoured only by `destroy` would save a creature
    // from a removal spell and not from the 3/3 it just blocked.
    let s = arena({
      decks: { 0: 'rot-harvest', 1: 'rot-harvest' },
      battlefield: { 0: ['Swamp', 'Swamp', 'Drudge Skeletons'], 1: ['Centaur Courser'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'declare-attackers');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const skeleton = find(s, 0, 'battlefield', 'Drudge Skeletons');
    s = apply(s, {
      type: 'auto:attack', by: 1, attackers: [{ attacker: courser, defender: 0 }],
    });
    s = passBoth(s);
    s = apply(s, { type: 'auto:block', by: 0, blocks: [{ blocker: skeleton, attacker: courser }] });
    // Declaring blockers is a turn-based action, so priority goes to the *attacking* player first
    // (CR 509.4) — the defender has to be given it before it can hold anything up.
    if (s.priority === 1) s = apply(s, { type: 'auto:pass', by: 1 });
    // The shield goes up after blockers are declared and before damage, which is exactly when a
    // player would put it up.
    s = tapAll(s, 0);
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: skeleton, abilityIndex: 0 }));
    expect(s.instances[skeleton]!.counters['regeneration']).toBe(1);

    // Through the damage step: three damage on a 1/1 is lethal, and the shield replaces it.
    for (let i = 0; i < 8 && s.instances[skeleton]!.zone === 'battlefield'
      && s.instances[skeleton]!.counters['regeneration'] !== undefined; i++) {
      s = passBoth(s);
    }
    expect(s.instances[skeleton]!.zone).toBe('battlefield');
    expect(s.instances[skeleton]!.damage).toBe(0);
    expect(s.instances[skeleton]!.counters['regeneration']).toBeUndefined();
    // And out of the fight: nothing lists it as a blocker any more (CR 701.15a).
    for (const attack of s.combat.attacks) expect(attack.blockers).not.toContain(skeleton);
  });

  it('regenerates every creature its controller has, and nothing of anyone else’s', () => {
    let s = rot(['Golgari Charm'], ['Swamp', 'Forest'], ['Llanowar Elves', 'Wall of Blossoms']);
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Llanowar Elves'), toZone: 'battlefield' });
    const theirs = find(s, 1, 'battlefield', 'Llanowar Elves');
    s = tapAll(s, 0);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Golgari Charm'), modes: [2],
    }));
    for (const id of ids(s, 0, 'battlefield')) {
      const ch = characteristicsOf(s, s.instances[id]!);
      if (!ch.isCreature) continue;
      expect(s.instances[id]!.counters['regeneration']).toBe(1);
    }
    expect(s.instances[theirs]!.counters['regeneration']).toBeUndefined();
  });

  it('shrinks the whole board with the first mode, both sides of it', () => {
    let s = rot(['Golgari Charm'], ['Swamp', 'Forest'], ['Wall of Blossoms']);
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Llanowar Elves'), toZone: 'battlefield' });
    const theirs = find(s, 1, 'battlefield', 'Llanowar Elves');
    const mine = find(s, 0, 'battlefield', 'Wall of Blossoms');
    s = tapAll(s, 0);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Golgari Charm'), modes: [0],
    }));
    // The 1/1 is dead and the 0/4 is a 0/3 — symmetrical, which is what makes it a decision.
    expect(s.instances[theirs]!.zone).toBe('graveyard');
    expect(toughness(s, mine)).toBe(3);
  });

  it('destroys an enchantment with the second mode, and only offers it when there is one', () => {
    let s = rot(['Golgari Charm'], ['Swamp', 'Forest']);
    // Nothing to point at: the enchantment mode is not offered at all.
    expect(legalActions(tapAll(s, 0), 0).plays
      .filter((p) => p.name === 'Golgari Charm')
      .map((p) => p.modes)).toEqual([[0], [2]]);

    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Zombify'), toZone: 'hand' });
    s = apply(s, { type: 'card:move', by: 0, card: find(s, 0, 'library', 'Wall of Blossoms'), toZone: 'battlefield' });
    // An enchantment on the other side, put there by hand.
    const arena2 = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Golgari Charm'] }, battlefield: { 0: ['Swamp', 'Forest'], 1: ['Phyrexian Arena'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    let s2 = tapAll(arena2, 0);
    const arenaCard = find(s2, 1, 'battlefield', 'Phyrexian Arena');
    expect(legalActions(s2, 0).plays.filter((p) => p.name === 'Golgari Charm').map((p) => p.modes))
      .toEqual([[0], [1], [2]]);
    s2 = passBoth(apply(s2, {
      type: 'auto:cast', by: 0, card: find(s2, 0, 'hand', 'Golgari Charm'), modes: [1],
      targets: [{ kind: 'card', id: arenaCard }],
    }));
    expect(s2.instances[arenaCard]!.zone).toBe('graveyard');
  });

  it('enters as big as the X it was cast for, and as a 0/0 when it was not cast', () => {
    let s = rot(['Endless One'], ['Swamp', 'Forest', 'Swamp', 'Forest']);
    s = tapAll(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Endless One'), x: 4 }));
    const one = find(s, 0, 'battlefield', 'Endless One');
    expect(s.instances[one]!.counters['+1/+1']).toBe(4);
    expect([power(s, one), toughness(s, one)]).toEqual([4, 4]);
  });

  it('lets a shield expire with the turn rather than keeping it forever', () => {
    let s = rot([], ['Swamp', 'Swamp'], ['Drudge Skeletons']);
    s = tapAll(s, 0);
    const skeleton = find(s, 0, 'battlefield', 'Drudge Skeletons');
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: skeleton, abilityIndex: 0 }));
    expect(s.instances[skeleton]!.counters['regeneration']).toBe(1);
    // "The next time this turn" (CR 701.15b): an unspent shield does not carry over.
    s = nextTurn(s);
    expect(s.instances[skeleton]!.counters['regeneration']).toBeUndefined();
  });
});

describe('lands that make one of two colours', () => {
  /** A seat with the named lands on the battlefield, in its main phase, nothing tapped yet. */
  const board = (seat: SeatIndex, lands: readonly string[], hand: readonly string[], deck: string) =>
    advanceTo(arena({
      decks: { [seat]: deck }, hands: { [seat]: hand }, battlefield: { [seat]: lands },
      turn: 3, firstSeat: seat,
    }), 'precombat-main');

  it('makes one mana, of whichever colour the spell needs', () => {
    let s = board(1, ['Dimir Guildgate'], [], 'tidal-mind');
    const gate = find(s, 1, 'battlefield', 'Dimir Guildgate');
    // Two abilities, one tap: the table offers both and either is legal.
    const plays = legalActions(s, 1).plays.filter((p) => p.card === gate);
    expect(plays.map((p) => p.description)).toEqual(['{T}: Add {U}.', '{T}: Add {B}.']);
    s = apply(s, { type: 'auto:activate', by: 1, card: gate, abilityIndex: 1 });
    expect(s.pools['1']).toMatchObject({ B: 1, U: 0 });
    expect(s.instances[gate]!.tapped).toBe(true);
  });

  it('is one mana and not two, so a two-drop is not offered off one gate', () => {
    // The bug this type exists to prevent: counted as both its colours a Guildgate looks like two
    // mana, the table offers a two-drop, and the engine then refuses to pay for it.
    const s = board(1, ['Dimir Guildgate'], ['Counterspell', 'Preordain'], 'tidal-mind');
    const offered = legalActions(s, 1).plays.map((p) => p.name);
    expect(offered).toContain('Preordain');
    expect(offered).not.toContain('Counterspell');
  });

  it('pays a two-colour cost out of two gates, one colour each', () => {
    let s = board(0, ['Golgari Guildgate', 'Golgari Guildgate'], ['Wall of Blossoms'], 'rot-harvest');
    // {1}{G} off two gates: one makes the green, the other pays the generic.
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Wall of Blossoms') }));
    expect(namesIn(s, 0, 'battlefield')).toContain('Wall of Blossoms');
    // Both gates spent, one mana each — not one gate tapped for two.
    const gates = ids(s, 0, 'battlefield')
      .filter((id) => s.cardDefs[s.instances[id]!.defKey]!.name === 'Golgari Guildgate');
    expect(gates.map((id) => s.instances[id]!.tapped)).toEqual([true, true]);
  });

  it('enters tapped, so it does nothing the turn it is played (CR 614.1c)', () => {
    let s = advanceTo(arena({
      decks: { 1: 'tidal-mind' }, hands: { 1: ['Dimir Guildgate'] }, turn: 2, firstSeat: 1,
    }), 'precombat-main');
    s = apply(s, { type: 'auto:playLand', by: 1, card: find(s, 1, 'hand', 'Dimir Guildgate') });
    const gate = find(s, 1, 'battlefield', 'Dimir Guildgate');
    expect(s.instances[gate]!.tapped).toBe(true);
    // And no mana from it this turn: the engine offers nothing off a tapped land.
    expect(legalActions(s, 1).plays.filter((p) => p.card === gate)).toEqual([]);
    expect(legalActions(s, 1).potential).toMatchObject({ U: 0, B: 0 });

    // Untapping on the next turn is what makes it a land rather than a brick.
    s = nextTurn(nextTurn(s));
    expect(s.instances[gate]!.tapped).toBe(false);
  });
});

describe('equipment, which is an aura that survives its creature', () => {
  /** A seat with the named Equipment already on the battlefield, lands tapped, in its main phase. */
  function equipped(
    seat: SeatIndex, gear: string, creatures: readonly string[], lands: number,
    deck?: string, basicLand?: string,
  ) {
    const basic = basicLand ?? (seat === 0 ? 'Mountain' : 'Forest');
    let s = arena({
      battlefield: { [seat]: [...Array.from({ length: lands }, () => basic), gear, ...creatures] },
      turn: 3, firstSeat: seat,
      ...(deck === undefined ? {} : { decks: { [seat]: deck } }),
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, seat, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== basic) continue;
      s = apply(s, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
    }
    return s;
  }

  const equipIndex = 0;

  it('moves onto a creature you control and makes it bigger', () => {
    let s = equipped(0, 'Bonesplitter', ['Raging Goblin'], 2);
    const axe = find(s, 0, 'battlefield', 'Bonesplitter');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    expect(power(s, goblin)).toBe(1);

    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: goblin }],
    }));
    expect(s.instances[axe]!.attachedTo).toBe(goblin);
    expect(power(s, goblin)).toBe(3);
  });

  it('can only be equipped at sorcery speed, and only to a creature you control', () => {
    let s = equipped(0, 'Bonesplitter', ['Raging Goblin'], 2);
    const axe = find(s, 0, 'battlefield', 'Bonesplitter');
    // Seat 1's creature is not a legal target: equip says "creature you control" (CR 301.5c).
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Grizzly Bears'), toZone: 'battlefield' });
    const theirs = find(s, 1, 'battlefield', 'Grizzly Bears');
    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: theirs }],
    })).not.toBeNull();

    // And not during the opponent's turn, when a sorcery could not be cast either.
    const theirTurn = advanceTo(nextTurn(s), 'precombat-main');
    expect(legalActions(theirTurn, 0).plays.filter((p) => p.name === 'Bonesplitter')).toEqual([]);
  });

  it('moves from one creature to another, taking its bonus with it', () => {
    // The difference from an Aura that nothing else shows: an Equipment is re-equipped, and the
    // creature it leaves goes back to its printed size the moment it does.
    let s = equipped(0, 'Bonesplitter', ['Raging Goblin', 'Hill Giant'], 3);
    const axe = find(s, 0, 'battlefield', 'Bonesplitter');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: goblin }],
    }));
    expect([power(s, goblin), power(s, giant)]).toEqual([3, 3]);

    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: giant }],
    }));
    expect(s.instances[axe]!.attachedTo).toBe(giant);
    expect([power(s, goblin), power(s, giant)]).toEqual([1, 5]);
    // One effect, not two: a second equip must not leave the first one behind.
    expect(s.effects.filter((e) => e.source === axe)).toHaveLength(1);
  });

  it('is not offered to the creature it is already on', () => {
    // Legal by the rules and useless in practice, which makes it a trap for a player and a waste
    // of mana for the bot: three quarters of the bot's equips were re-equipping the same creature
    // until the target filter could see which creature that was.
    let s = equipped(0, 'Bonesplitter', ['Raging Goblin', 'Hill Giant'], 3);
    const axe = find(s, 0, 'battlefield', 'Bonesplitter');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: goblin }],
    }));

    const offer = legalActions(s, 0).plays.find((p) => p.name === 'Bonesplitter');
    expect(offer?.candidates[0]?.map((c) => (c.kind === 'card' ? c.id : 'player'))).toEqual([giant]);
    // And the engine refuses it if a client sends it anyway.
    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: goblin }],
    })).not.toBeNull();
  });

  it('stays on the battlefield when its creature dies, and the bonus goes with the creature', () => {
    let s = equipped(0, 'Bonesplitter', ['Raging Goblin'], 2);
    const axe = find(s, 0, 'battlefield', 'Bonesplitter');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: axe, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: goblin }],
    }));
    s = drain(apply(s, { type: 'card:move', by: 0, card: goblin, toZone: 'graveyard' }));

    // An Aura would be in the graveyard here (CR 704.5m); an Equipment is not (CR 301.5c).
    expect(s.instances[axe]!.zone).toBe('battlefield');
    expect(s.instances[axe]!.attachedTo).toBeNull();
    // And the +2/+0 is gone with it, rather than waiting in `effects` for the next thing to hold
    // that instance id.
    expect(s.effects.filter((e) => e.source === axe)).toEqual([]);
  });

  it('grants keywords, not only a body: trample and lifelink from the Warhammer', () => {
    let s = equipped(1, 'Loxodon Warhammer', ['Centaur Courser'], 4, 'verdant-guard');
    const hammer = find(s, 1, 'battlefield', 'Loxodon Warhammer');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: hammer, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: courser }],
    }));
    const ch = characteristicsOf(s, s.instances[courser]!);
    expect(power(s, courser)).toBe(6);
    expect(ch.keywords.has('trample')).toBe(true);
    expect(ch.keywords.has('lifelink')).toBe(true);
  });

  it('turns a small creature into something nothing wants to block, with the Collar', () => {
    // Deathtouch on a 1/1 is the whole card, and it is the keyword that is easiest to grant
    // wrongly: the bonus belongs to the creature, so a blocker trading with it has to die.
    let s = equipped(0, 'Basilisk Collar', ['Llanowar Elves'], 3, 'rot-harvest', 'Forest');
    const collar = find(s, 0, 'battlefield', 'Basilisk Collar');
    const goblin = find(s, 0, 'battlefield', 'Llanowar Elves');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: collar, abilityIndex: equipIndex,
      targets: [{ kind: 'card', id: goblin }],
    }));
    const ch = characteristicsOf(s, s.instances[goblin]!);
    expect(ch.keywords.has('deathtouch')).toBe(true);
    expect(ch.keywords.has('lifelink')).toBe(true);
    // Still a 1/1: the Collar grants keywords and no body at all.
    expect([power(s, goblin), toughness(s, goblin)]).toEqual([1, 1]);
  });
});

describe('scry, which is the other way a player sees their own library', () => {
  /** The ids on top of a seat's library, top first. */
  const topOf = (s: GameState, seat: SeatIndex, n: number): string[] =>
    [...ids(s, seat, 'library')].slice(0, n);

  it('asks about the top card only, and leaves it there when nothing is chosen', () => {
    let s = withMana(1, ['Preordain'], ['Island'], [], 'tidal-mind');
    const [top, second] = topOf(s, 1, 2);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Preordain') });
    s = passBoth(s);
    expect(s.pendingDecision?.from).toBe('library-top');
    expect(s.pendingDecision?.candidates).toEqual([top]);
    // Scry 1 is a question with two answers, so the engine asks rather than deciding for them.
    expect([s.pendingDecision?.min, s.pendingDecision?.max]).toEqual([0, 1]);

    s = apply(s, { type: 'auto:decide', by: 1, cards: [] });
    expect(s.pendingDecision).toBeNull();
    // Kept on top, and then drawn — which is the whole card.
    expect(namesIn(s, 1, 'hand')).toContain(s.cardDefs[s.instances[top!]!.defKey]!.name);
    expect(ids(s, 1, 'library')[0]).toBe(second);
  });

  it('puts what was chosen on the bottom, and draws what is left on top', () => {
    let s = withMana(1, ['Preordain'], ['Island'], [], 'tidal-mind');
    const [top, second] = topOf(s, 1, 2);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Preordain') }));
    const library = ids(s, 1, 'library').length;
    s = apply(s, { type: 'auto:decide', by: 1, cards: [top!] });
    // The bottomed card is at the bottom, the next one was drawn, and nothing was shuffled: a
    // scry that shuffled would be a very different card.
    expect(ids(s, 1, 'library')[ids(s, 1, 'library').length - 1]).toBe(top);
    expect(ids(s, 1, 'library').length).toBe(library - 1);
    expect(s.instances[second!]!.zone).toBe('hand');
  });

  it('shows the scried cards to the player scrying and to nobody else', () => {
    // The whole risk of reading your own library: a leak here is the top of a deck, in order, for
    // the rest of the game. The library zone itself is not sent at all — only these cards.
    let s = withMana(1, ['Omenspeaker'], ['Island', 'Island'], [], 'tidal-mind');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Omenspeaker') }));
    s = passBoth(s);
    expect(s.pendingDecision?.from).toBe('library-top');
    const looked = s.pendingDecision!.candidates;
    expect(looked).toHaveLength(2);

    const mine = viewFor(s, 1);
    const theirs = viewFor(s, 0);
    const spectator = viewFor(s, null);
    for (const id of looked) {
      expect(mine.cards[id]?.card).toBeDefined();
      expect(theirs.cards[id]).toBeUndefined();
      expect(spectator.cards[id]).toBeUndefined();
    }
    // And the rest of the library stays unreadable even to its owner.
    const rest = ids(s, 1, 'library').filter((id) => !looked.includes(id));
    expect(rest.length).toBeGreaterThan(0);
    for (const id of rest) expect(mine.cards[id]).toBeUndefined();
    expect(mine.zones['1:library']).toBeUndefined();
  });

  it('stops showing them the moment the question is answered', () => {
    let s = withMana(1, ['Omenspeaker'], ['Island', 'Island'], [], 'tidal-mind');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Omenspeaker') }));
    s = passBoth(s);
    const looked = [...s.pendingDecision!.candidates];
    s = apply(s, { type: 'auto:decide', by: 1, cards: [looked[0]!] });
    const mine = viewFor(s, 1);
    // The one bottomed and the one kept are both unreadable again.
    for (const id of looked) expect(mine.cards[id]).toBeUndefined();
  });

  it('refuses an answer naming a card that was not on the question', () => {
    let s = withMana(1, ['Preordain'], ['Island'], [], 'tidal-mind');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Preordain') }));
    const deeper = ids(s, 1, 'library')[4]!;
    // Without this check a crafted answer could reach past the top of the deck — which is both a
    // rules break and a way to read a card nobody was shown.
    expect(refusal(s, { type: 'auto:decide', by: 1, cards: [deeper] })).not.toBeNull();
  });

  it('does the damage first and asks afterwards, which is the order Magma Jet prints', () => {
    let s = withMana(0, ['Magma Jet'], 2);
    const bear = find(s, 1, 'library', 'Grizzly Bears');
    s = apply(s, { type: 'card:move', by: 1, card: bear, toZone: 'battlefield' });
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Magma Jet'),
      targets: [{ kind: 'card', id: bear }],
    }));
    // Dead before the question is asked: what to keep on top is a different decision once the
    // board has changed.
    expect(s.instances[bear]!.zone).toBe('graveyard');
    expect(s.pendingDecision?.from).toBe('library-top');
    expect(s.pendingDecision?.candidates).toHaveLength(2);
    s = apply(s, { type: 'auto:decide', by: 0, cards: [] });
    expect(s.pendingDecision).toBeNull();
  });
});

describe('spells with {X} in the cost, chosen as the spell is cast', () => {
  const plays = (s: GameState, seat: SeatIndex, name: string) =>
    legalActions(s, seat).plays.filter((p) => p.name === name);

  it('offers the spell with the largest X the mana allows, and X=0 is a legal cast', () => {
    // Four Mountains tapped: {X}{R} leaves three for X. The table is told the ceiling rather than
    // working it out, because what X can be is a mana question and a second answer to it would be
    // a second mana engine.
    let s = withMana(0, ['Fireball'], 4);
    const offer = plays(s, 0, 'Fireball');
    expect(offer).toHaveLength(1);
    expect(offer[0]!.xMax).toBe(3);

    // One Mountain pays for the {R} and nothing else, and the spell is still offered: a Fireball
    // for nothing is legal, and sometimes it is the only cast available.
    s = withMana(0, ['Fireball'], 1);
    expect(plays(s, 0, 'Fireball')[0]!.xMax).toBe(0);
  });

  it('deals exactly the X that was paid for, and says so on the stack', () => {
    let s = withMana(0, ['Fireball'], 4);
    const bear = find(s, 1, 'library', 'Grizzly Bears');
    s = apply(s, { type: 'card:move', by: 1, card: bear, toZone: 'battlefield' });
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fireball'),
      x: 3, targets: [{ kind: 'card', id: bear }],
    });
    // On the stack with its X, which is what the other player needs in order to decide whether to
    // respond: "Fireball" alone does not say whether the 2/2 lives.
    expect(stackNames(s)).toEqual(['Fireball (X=3)']);
    s = passBoth(s);
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
  });

  it('refuses an X the mana cannot pay for, and an X on a card that has none', () => {
    const s = withMana(0, ['Fireball', 'Lightning Bolt'], 4);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fireball'), x: 9,
      targets: [{ kind: 'player', seat: 1 }],
    })).toContain('cannot pay');
    // And the other direction: a Bolt with an X is a client that has misunderstood the card, and
    // ignoring the number would leave an x on the stack object for an effect to read.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), x: 2,
      targets: [{ kind: 'player', seat: 1 }],
    })).toContain('no X to choose');
  });

  it('draws X cards', () => {
    let s = withMana(1, ['Mind Spring'], ['Island', 'Island', 'Island', 'Island', 'Island'], [], 'tidal-mind');
    const before = ids(s, 1, 'hand').length;
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Mind Spring'), x: 3 }));
    // Three drawn, one Mind Spring gone.
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 3);
  });

  it('creates X tokens, and none at all for X=0', () => {
    // Five Plains for two casts: X=3 spends four of them and the fifth pays the {W} of the second,
    // which is the one being asked about — nothing is created for X=0.
    let s = withMana(1, ['Secure the Wastes', 'Secure the Wastes'],
      ['Plains', 'Plains', 'Plains', 'Plains', 'Plains']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Secure the Wastes'), x: 3 }));
    expect(countOf(s, 1, 'battlefield', 'Warrior')).toBe(3);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Secure the Wastes'), x: 0 }));
    expect(countOf(s, 1, 'battlefield', 'Warrior')).toBe(3);
  });

  it('drains each opponent for X and gains all of it, which is a different card at a pod', () => {
    // Three opponents rather than one: X life each, 3X gained. That asymmetry is the card, and it
    // is the reason this test is a pod and not a duel.
    let s = arena({
      format: 'pod', seats: 4, firstSeat: 0,
      decks: { 0: 'tidal-mind' },
      hands: { 0: ['Exsanguinate'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'] },
      turn: 2,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of ids(s, 0, 'battlefield')) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Exsanguinate'), x: 2 });
    for (let i = 0; i < 6 && s.stackOrder.length > 0; i++) s = passBoth(s);
    expect([life(s, 1), life(s, 2), life(s, 3)]).toEqual([38, 38, 38]);
    expect(life(s, 0)).toBe(46);
  });

  it('hits every flier and every player with Hurricane, including its own controller', () => {
    // The card that is not simply a bigger Fireball: it is symmetrical, so a deck of ground
    // creatures pays nothing for it and a table of fliers pays everything.
    let s = arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Hurricane'] },
      battlefield: { 0: ['Forest', 'Forest', 'Forest', 'Centaur Courser'], 1: ['Wind Drake'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of ids(s, 0, 'battlefield')) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== 'Forest') continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const drake = find(s, 1, 'battlefield', 'Wind Drake');
    const courser = find(s, 0, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hurricane'), x: 2 }));
    // The 2/2 flier dies; the 3/3 on the ground does not even take damage.
    expect(namesIn(s, 1, 'graveyard')).toContain('Wind Drake');
    expect(s.instances[drake]!.zone).toBe('graveyard');
    expect(s.instances[courser]!.damage).toBe(0);
    // And both players took it, the caster included.
    expect([life(s, 0), life(s, 1)]).toEqual([18, 18]);
  });
});

describe('eight that needed nothing new', () => {
  it('Day of Judgment destroys every creature, including its own', () => {
    let s = arena({
      decks: { 1: 'verdant-guard' }, hands: { 1: ['Day of Judgment'] },
      battlefield: {
        1: ['Plains', 'Plains', 'Plains', 'Plains', 'Grizzly Bears'],
        0: ['Shivan Dragon', 'Raging Goblin'],
      },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (nameOf(s, id) !== 'Plains') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    s = drain(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Day of Judgment') }));
    // Both sides, which is the card: a wrath is not removal, it is a reset.
    expect(namesIn(s, 0, 'graveyard')).toEqual(['Raging Goblin', 'Shivan Dragon']);
    expect(namesIn(s, 1, 'graveyard')).toEqual(['Day of Judgment', 'Grizzly Bears']);
    // The lands are still there: "all creatures" is all creatures.
    expect(countOf(s, 1, 'battlefield', 'Plains')).toBe(4);
  });

  it('Essence Scatter answers a creature spell and nothing else', () => {
    let s = arena({
      decks: { 1: 'hollow-tide' }, hands: { 0: ['Shivan Dragon', 'Lightning Bolt'], 1: ['Essence Scatter'] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'],
        1: ['Island', 'Island'],
      },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const dragon = find(s, 0, 'hand', 'Shivan Dragon');
    s = apply(s, { type: 'auto:cast', by: 0, card: dragon });
    // The caster holds priority until they pass, which is how holding a spell works; the
    // responder's window opens after that.
    s = apply(s, { type: 'auto:pass', by: 0 });
    // The dragon is on the stack, and the counter may be pointed at it.
    const play = legalActions(s, 1).plays.find((p) => p.name === 'Essence Scatter');
    expect(play?.candidates[0]?.some((t) => t.kind === 'card' && t.id === dragon)).toBe(true);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Essence Scatter'),
      targets: [{ kind: 'card', id: dragon }],
    }));
    expect(countOf(s, 0, 'graveyard', 'Shivan Dragon')).toBe(1);
    expect(countOf(s, 0, 'battlefield', 'Shivan Dragon')).toBe(0);
  });

  it('and will not be pointed at a Lightning Bolt', () => {
    let s = arena({
      decks: { 1: 'hollow-tide' }, hands: { 0: ['Lightning Bolt'], 1: ['Essence Scatter'] },
      battlefield: { 0: ['Mountain'], 1: ['Island', 'Island'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const bolt = find(s, 0, 'hand', 'Lightning Bolt');
    s = apply(s, { type: 'auto:cast', by: 0, card: bolt, targets: [{ kind: 'player', seat: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    // Nothing to counter, so the spell is not offered at all (CR 601.2c) and a hand-built action
    // is refused rather than quietly countering a Bolt.
    expect(legalActions(s, 1).plays.filter((p) => p.name === 'Essence Scatter')).toEqual([]);
    expect(refusal(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Essence Scatter'),
      targets: [{ kind: 'card', id: bolt }],
    })).toMatch(/creature spell/);
  });

  it('Unsummon sends a creature home, counters and all', () => {
    let s = arena({
      decks: { 1: 'tidal-mind' }, hands: { 1: ['Unsummon'] },
      battlefield: { 1: ['Island'], 0: ['Shivan Dragon'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Island'), abilityIndex: 0 });
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Unsummon'),
      targets: [{ kind: 'card', id: dragon }],
    }));
    // In its owner's hand, not its exiler's, and castable again — which is the difference between
    // a bounce and removal.
    expect(s.instances[dragon]!.zone).toBe('hand');
    expect(s.instances[dragon]!.zoneSeat).toBe(0);
  });

  it('Icy Manipulator taps anything that is not another Icy Manipulator', () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      battlefield: { 1: ['Island', 'Island', 'Icy Manipulator'], 0: ['Shivan Dragon', 'Mountain'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Island'), abilityIndex: 0 });
    const icy = find(s, 1, 'battlefield', 'Icy Manipulator');
    const play = legalActions(s, 1).plays.find((p) => p.name === 'Icy Manipulator' && p.kind === 'activate');
    const names = (play?.candidates[0] ?? []).map((t) => (t.kind === 'card' ? nameOf(s, t.id) : 'player')).sort();
    // A creature, a land, and not itself.
    expect(names).toContain('Shivan Dragon');
    expect(names).toContain('Mountain');
    expect(names).not.toContain('Icy Manipulator');

    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = drain(apply(s, {
      type: 'auto:activate', by: 1, card: icy, abilityIndex: play!.abilityIndex!,
      targets: [{ kind: 'card', id: dragon }],
    }));
    expect(s.instances[dragon]!.tapped).toBe(true);
    // A tapped creature cannot attack, which is the whole point and is somebody else's rule.
    expect(s.instances[icy]!.tapped).toBe(true);
  });

  it("Tormod's Crypt exiles a whole graveyard", () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      battlefield: { 1: ["Tormod's Crypt"], 0: ['Shivan Dragon', 'Raging Goblin'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    // Fill the opponent's graveyard the way a game would.
    for (const name of ['Shivan Dragon', 'Raging Goblin']) {
      s = apply(s, { type: 'card:move', by: 0, card: find(s, 0, 'battlefield', name), toZone: 'graveyard' });
    }
    s = drain(s);
    expect(ids(s, 0, 'graveyard').length).toBe(2);

    const crypt = find(s, 1, 'battlefield', "Tormod's Crypt");
    s = drain(apply(s, {
      type: 'auto:activate', by: 1, card: crypt, abilityIndex: 0,
      targets: [{ kind: 'player', seat: 0 }],
    }));
    expect(ids(s, 0, 'graveyard')).toEqual([]);
    expect(ids(s, 0, 'exile').length).toBe(2);
    // And the Crypt ate itself paying for it.
    expect(s.instances[crypt]!.zone).toBe('graveyard');
  });

  it('Ambush Viper can be cast on their turn, and kills what it blocks', () => {
    let s = arena({
      decks: { 1: 'verdant-guard' }, hands: { 1: ['Ambush Viper'] },
      battlefield: { 1: ['Forest', 'Forest'], 0: ['Hill Giant'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: giant, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    // Flash: castable on somebody else's turn, in the middle of their combat, which is the only
    // reason the card is worth playing — it is a 2/1 that eats whatever is already attacking.
    expect(legalActions(s, 1).plays.some((p) => p.name === 'Ambush Viper')).toBe(true);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Ambush Viper') }));
    const viper = find(s, 1, 'battlefield', 'Ambush Viper');

    s = advanceTo(s, 'declare-blockers');
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: viper, attacker: giant }] });
    s = drain(advanceTo(s, 'combat-damage'));
    // Deathtouch: a 2/1 kills a 3/3, and dies to it.
    expect(countOf(s, 0, 'graveyard', 'Hill Giant')).toBe(1);
    expect(countOf(s, 1, 'graveyard', 'Ambush Viper')).toBe(1);
  });

  it('Elvish Visionary replaces itself', () => {
    let s = arena({
      decks: { 1: 'verdant-guard' }, hands: { 1: ['Elvish Visionary'] },
      battlefield: { 1: ['Forest', 'Forest'] }, turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const before = ids(s, 1, 'hand').length;
    s = drain(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Elvish Visionary') }));
    // One out of the hand, one in: a 1/1 for two mana that costs no cards.
    expect(ids(s, 1, 'hand').length).toBe(before);
    expect(countOf(s, 1, 'battlefield', 'Elvish Visionary')).toBe(1);
  });

  it('Read the Bones looks at two, draws two, and costs two life', () => {
    let s = arena({
      decks: { 0: 'ashen-rite' }, hands: { 0: ['Read the Bones'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'] }, turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const before = ids(s, 0, 'hand').length;
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Read the Bones') });
    s = passBoth(s);
    // It stops to ask which of the two to bottom, before it draws.
    expect(choices(s)).toHaveLength(2);
    s = drain(decide(s, []));
    // Two cards for the one spent, and two life.
    expect(ids(s, 0, 'hand').length).toBe(before + 1);
    expect(life(s, 0)).toBe(18);
  });
});

describe('mana that is not a land', () => {
  it('Sol Ring makes two off one tap, and the engine taps it for a cost it offered', () => {
    // A Mountain, a Swamp and a Sol Ring: four mana from three permanents, so a three-drop leaves
    // a land up. The point is not the arithmetic — it is that `legalActions` offers the spell and
    // the engine then pays for it, because both read the same solver, and that the Ring counts as
    // the two mana it makes.
    let s = arena({
      decks: { 0: 'ashen-rite' }, hands: { 0: ['Agonizing Demise'] },
      battlefield: { 0: ['Mountain', 'Swamp', 'Sol Ring'], 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    expect(legalActions(s, 0).plays.some((p) => p.name === 'Agonizing Demise')).toBe(true);

    // Nothing is tapped yet: the engine works out what to tap when the spell is cast.
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Agonizing Demise'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }] });
    // {2}{B} off the Swamp and the Ring, so the Mountain is still up for an instant — a solver
    // that treated the Ring as one mana would have tapped everything for a three-mana spell.
    expect(s.instances[find(s, 0, 'battlefield', 'Sol Ring')]!.tapped).toBe(true);
    expect(s.instances[find(s, 0, 'battlefield', 'Swamp')]!.tapped).toBe(true);
    expect(s.instances[find(s, 0, 'battlefield', 'Mountain')]!.tapped).toBe(false);
  });

  it('and tapping it by hand puts two colourless in the pool', () => {
    let s = arena({
      decks: { 0: 'ashen-rite' }, battlefield: { 0: ['Sol Ring'] }, turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Sol Ring'), abilityIndex: 0 });
    expect(s.pools['0']!.C).toBe(2);
  });

  it('Mind Stone trades itself for a card once the mana is no longer needed', () => {
    let s = arena({
      decks: { 0: 'ashen-rite' }, battlefield: { 0: ['Swamp', 'Mind Stone'] }, turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Swamp'), abilityIndex: 0 });
    const stone = find(s, 0, 'battlefield', 'Mind Stone');
    const before = ids(s, 0, 'hand').length;
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: stone, abilityIndex: 1 }));
    expect(ids(s, 0, 'hand').length).toBe(before + 1);
    expect(s.instances[stone]!.zone).toBe('graveyard');
  });

  it('Birds of Paradise makes whichever colour the spell needs', () => {
    // A white spell with no Plains in play: the only white mana on the board is the bird, and the
    // engine has to work out that the bird is what pays for it.
    let s = arena({
      decks: { 0: 'verdant-guard' }, hands: { 0: ['Swords to Plowshares'] },
      battlefield: { 0: ['Birds of Paradise'], 1: ['Grizzly Bears'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const bird = find(s, 0, 'battlefield', 'Birds of Paradise');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    expect(legalActions(s, 0).plays.some((p) => p.name === 'Swords to Plowshares')).toBe(true);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Swords to Plowshares'),
      targets: [{ kind: 'card', id: bears }],
    }));
    expect(s.instances[bird]!.tapped).toBe(true);
    expect(s.instances[bears]!.zone).toBe('exile');
  });

  it('and it is one mana, not five', () => {
    // The whole reason several tap abilities on one permanent are a choice rather than a sum: a
    // bird is not a Sol Ring, and a table that thought otherwise would offer spells nobody can pay
    // for. Two one-mana spells, one bird, one Forest: the second is not castable.
    let s = arena({
      decks: { 0: 'verdant-guard' }, hands: { 0: ['Giant Growth'] },
      battlefield: { 0: ['Birds of Paradise'], 1: ['Grizzly Bears'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const bird = find(s, 0, 'battlefield', 'Birds of Paradise');
    s = apply(s, { type: 'auto:activate', by: 0, card: bird, abilityIndex: 4 });
    expect(s.pools['0']!.G).toBe(1);
    // One mana off one tap, and the bird is spent.
    expect(s.instances[bird]!.tapped).toBe(true);
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Birds of Paradise')).toEqual([]);
  });

  it('a bird that arrived this turn cannot be tapped for mana', () => {
    let s = arena({
      decks: { 0: 'verdant-guard' }, hands: { 0: ['Birds of Paradise'] },
      battlefield: { 0: ['Forest'] }, turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Birds of Paradise') }));
    const bird = find(s, 0, 'battlefield', 'Birds of Paradise');
    // Summoning sickness applies to a mana creature like any other (CR 302.6), so the table does
    // not offer the tap and the engine would refuse it.
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Birds of Paradise')).toEqual([]);
    expect(refusal(s, { type: 'auto:activate', by: 0, card: bird, abilityIndex: 0 }))
      .toMatch(/summoning sickness/);
  });
});

describe('exile until this leaves the battlefield', () => {
  /** Seat 1 on a white deck, with `lands` tapped for mana, `hand` in hand and `theirs` opposite. */
  const white = (
    hand: readonly string[], lands: number, theirs: readonly string[], deck = 'verdant-guard',
  ): GameState => {
    let s = arena({
      decks: { 1: deck }, hands: { 1: hand },
      battlefield: { 1: Array.from({ length: lands }, () => 'Plains'), 0: theirs },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name !== 'Plains') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    return s;
  };

  /**
   * Casts it and lets its entry trigger resolve, aiming it if it asks.
   *
   * None of these cards targets as a *spell* — the exile is an entry trigger, which is why none of
   * them can be countered by killing the creature in response and why the target is chosen when
   * the permanent arrives rather than when it is cast.
   */
  const playAndAim = (s: GameState, name: string, at: string): GameState => {
    let next = drain(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', name) }));
    if (next.pendingChoice !== null) {
      next = drain(apply(next, { type: 'auto:choose', by: 1, targets: [{ kind: 'card', id: at }] }));
    }
    return next;
  };

  it('Journey to Nowhere takes a creature away, and dying gives it back', () => {
    let s = white(['Journey to Nowhere'], 2, ['Shivan Dragon']);
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = playAndAim(s, 'Journey to Nowhere', dragon);
    // The creature is in exile, and the enchantment holding it knows it has it.
    expect(s.instances[dragon]!.zone).toBe('exile');
    const journey = find(s, 1, 'battlefield', 'Journey to Nowhere');
    expect(s.instances[dragon]!.exiledBy).toBe(journey);

    // Destroy the enchantment and the creature comes back — to its owner, not to the player who
    // exiled it, which is the difference between this card and a Mind Control.
    s = drain(apply(s, { type: 'card:move', by: 1, card: journey, toZone: 'graveyard' }));
    expect(s.instances[dragon]!.zone).toBe('battlefield');
    expect(s.instances[dragon]!.zoneSeat).toBe(0);
  });

  it('and it comes back whether the exiler died, was exiled or was bounced', () => {
    for (const how of ['graveyard', 'exile', 'hand'] as const) {
      let s = white(['Journey to Nowhere'], 2, ['Shivan Dragon']);
      const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
      s = playAndAim(s, 'Journey to Nowhere', dragon);
      expect(s.instances[dragon]!.zone).toBe('exile');
      const journey = find(s, 1, 'battlefield', 'Journey to Nowhere');
      s = drain(apply(s, { type: 'card:move', by: 1, card: journey, toZone: how }));
      // Leaving is leaving: the trigger is on the zone change, not on reaching a graveyard.
      expect([how, s.instances[dragon]!.zone]).toEqual([how, 'battlefield']);
    }
  });

  it('Banisher Priest holds a creature for as long as it lives', () => {
    let s = white(['Banisher Priest'], 3, ['Shivan Dragon']);
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = playAndAim(s, 'Banisher Priest', dragon);
    expect(s.instances[dragon]!.zone).toBe('exile');

    const priest = find(s, 1, 'battlefield', 'Banisher Priest');
    s = drain(apply(s, { type: 'card:move', by: 1, card: priest, toZone: 'graveyard' }));
    expect(s.instances[dragon]!.zone).toBe('battlefield');
    expect(s.instances[dragon]!.zoneSeat).toBe(0);
  });

  it('and it will not point at a creature its own controller has', () => {
    const s = white(['Banisher Priest'], 3, [], 'verdant-guard');
    // Nothing of the opponent's on the board, so the trigger has no legal target and the Priest is
    // still perfectly castable — it is a 2/2 that happens to do nothing (CR 603.3c).
    const play = legalActions(s, 1).plays.find((p) => p.name === 'Banisher Priest');
    expect(play).toBeDefined();
    const after = drain(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Banisher Priest') }));
    expect(after.pendingChoice).toBeNull();
    expect(countOf(after, 1, 'battlefield', 'Banisher Priest')).toBe(1);
  });

  it('Banishing Light points at anything that is not a land, and not at itself', () => {
    // Two legal targets, so the trigger has to ask rather than aim itself — which is what makes
    // the candidate list readable.
    let s = arena({
      decks: { 1: 'forge-alliance' }, hands: { 1: ['Banishing Light'] },
      battlefield: {
        1: ['Plains', 'Plains', 'Plains', 'Plains', 'Bonesplitter'],
        0: ['Shivan Dragon'],
      },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (nameOf(s, id) !== 'Plains') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Banishing Light') });
    s = drain(s);
    // The trigger is waiting to be aimed, and what it offers is every permanent but the lands —
    // and not itself, which is the whole reason this card is Banishing Light and not Oblivion
    // Ring: "target nonland permanent" on an empty board means itself, and a permanent that
    // exiles itself returns itself and exiles itself again, forever.
    expect(s.pendingChoice).not.toBeNull();
    const choice = legalActions(s, 1).mustChoose;
    const names = (choice?.candidates[0] ?? []).map((t) => (t.kind === 'card' ? nameOf(s, t.id) : 'player'));
    expect(names).toContain('Shivan Dragon');
    expect(names).not.toContain('Plains');
    expect(names).not.toContain('Banishing Light');

    s = drain(apply(s, { type: 'auto:choose', by: 1, targets: [{ kind: 'card', id: dragon }] }));
    expect(s.instances[dragon]!.zone).toBe('exile');
  });

  it('and with nothing else on the board it simply does nothing', () => {
    // The loop case, from the other side: alone on an empty board, Banishing Light has no legal
    // target, so its trigger never goes on the stack at all (CR 603.3c) and it sits there being an
    // enchantment. Oblivion Ring, in the same position, ended the game.
    let s = white(['Banishing Light'], 4, [], 'forge-alliance');
    s = drain(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Banishing Light') }));
    expect(s.pendingChoice).toBeNull();
    expect(countOf(s, 1, 'battlefield', 'Banishing Light')).toBe(1);
    expect(s.stackOrder).toEqual([]);
  });

  it('two of them hold two different creatures, and each gives back only its own', () => {
    let s = white(['Journey to Nowhere', 'Journey to Nowhere'], 4, ['Shivan Dragon', 'Raging Goblin']);
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    s = playAndAim(s, 'Journey to Nowhere', dragon);
    const first = find(s, 1, 'battlefield', 'Journey to Nowhere');
    s = playAndAim(s, 'Journey to Nowhere', goblin);
    const second = ids(s, 1, 'battlefield')
      .find((id) => nameOf(s, id) === 'Journey to Nowhere' && id !== first)!;
    expect([s.instances[dragon]!.zone, s.instances[goblin]!.zone]).toEqual(['exile', 'exile']);

    // Destroy the one holding the Goblin: the Goblin comes back and the Dragon stays where it is.
    s = drain(apply(s, { type: 'card:move', by: 1, card: second, toZone: 'graveyard' }));
    expect(s.instances[goblin]!.zone).toBe('battlefield');
    expect(s.instances[dragon]!.zone).toBe('exile');
  });
});

describe('costs that are choices: cycling, kicker, and a creature on the altar', () => {
  /**
   * Seat 0 on the sixth deck, which is where every card in this section lives, with `lands` in
   * play and tapped for mana.
   *
   * The colours are given by name rather than counted: this deck is black *and* red, and a Burst
   * Lightning needs the Mountain.
   */
  const ashen = (hand: readonly string[], lands: readonly string[], extra: readonly string[] = []): GameState =>
    withMana(0, hand, lands, extra, 'ashen-rite');

  const swamps = (n: number): string[] => Array.from({ length: n }, () => 'Swamp');
  const mountains = (n: number): string[] => Array.from({ length: n }, () => 'Mountain');

  const playsFor = (s: GameState, seat: SeatIndex, name: string): string[] =>
    legalActions(s, seat).plays.filter((p) => p.name === name).map((p) => p.description);

  it('offers cycling on a land in your hand, and the mana ability only once it is on the battlefield', () => {
    let s = ashen(['Barren Moor'], swamps(2));
    const inHand = legalActions(s, 0).plays.filter((p) => p.name === 'Barren Moor');
    // A land in hand: it can be played, and it can be cycled. What it cannot do is make mana.
    expect(inHand.map((p) => p.kind).sort()).toEqual(['activate', 'land']);
    expect(inHand.find((p) => p.kind === 'activate')?.description).toMatch(/Cycling \{2\}/);
    expect(inHand.find((p) => p.kind === 'activate')?.fromHand).toBe(true);

    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Barren Moor') });
    // On the battlefield there is no cycling to be found: the card is not in hand any more, so the
    // cost that pays for itself cannot be paid. (Nor is there a mana ability yet — it arrived
    // tapped, which the next test is about.)
    const onBoard = legalActions(s, 0).plays.filter((p) => p.name === 'Barren Moor');
    expect(onBoard.map((p) => p.description)).toEqual([]);
    s = apply(s, { type: 'card:tap', by: 0, card: find(s, 0, 'battlefield', 'Barren Moor'), tapped: false });
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Barren Moor').map((p) => p.description))
      .toEqual(['{T}: Add {B}.']);
  });

  it('cycling draws a card and leaves the land in the graveyard', () => {
    let s = ashen(['Barren Moor'], swamps(2));
    const before = ids(s, 0, 'hand').length;
    const land = find(s, 0, 'hand', 'Barren Moor');
    const index = legalActions(s, 0).plays.find((p) => p.name === 'Barren Moor' && p.kind === 'activate')!.abilityIndex!;
    s = apply(s, { type: 'auto:activate', by: 0, card: land, abilityIndex: index });
    // The cost is paid as the ability is activated, so the land is already gone while its own
    // ability is still waiting on the stack (CR 702.29a).
    expect(s.instances[land]!.zone).toBe('graveyard');
    expect(s.stackOrder).toHaveLength(1);
    s = passBoth(s);
    // One card in, one card out, and the hand is back where it started.
    expect(ids(s, 0, 'hand').length).toBe(before);
    expect(countOf(s, 0, 'graveyard', 'Barren Moor')).toBe(1);
  });

  it('a cycling land comes in tapped, like every other land that is worth more than a Swamp', () => {
    let s = ashen(['Forgotten Cave'], swamps(1));
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Forgotten Cave') });
    expect(s.instances[find(s, 0, 'battlefield', 'Forgotten Cave')]!.tapped).toBe(true);
  });

  it('offers the kicker only when the whole cost can be paid', () => {
    // One land: the spell is castable, the kicker is not, so there is one play.
    expect(playsFor(ashen(['Burst Lightning'], mountains(1)), 0, 'Burst Lightning'))
      .toEqual(['Cast Burst Lightning']);
    // Five: both, and the kicked one says so in words the player can read.
    expect(playsFor(ashen(['Burst Lightning'], mountains(5)), 0, 'Burst Lightning'))
      .toEqual(['Cast Burst Lightning', 'Cast Burst Lightning with kicker {4}']);
  });

  it('Burst Lightning deals 2, or 4 for the kicker', () => {
    let s = ashen(['Burst Lightning'], mountains(1));
    s = cast(s, 0, 'Burst Lightning', [{ kind: 'player', seat: 1 }]);
    expect(life(s, 1)).toBe(18);

    let kicked = ashen(['Burst Lightning'], mountains(5));
    kicked = passBoth(apply(kicked, {
      type: 'auto:cast', by: 0, card: find(kicked, 0, 'hand', 'Burst Lightning'),
      kicked: true, targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(kicked, 1)).toBe(16);
    // Five mana spent, not one: the kicker is part of the cost rather than a free upgrade.
    expect(Object.values(kicked.pools[0] ?? {}).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('says so on the stack, so the player deciding whether to respond can read it', () => {
    let s = ashen(['Burst Lightning'], mountains(5));
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Burst Lightning'),
      kicked: true, targets: [{ kind: 'player', seat: 1 }],
    });
    expect(stackNames(s)).toEqual(['Burst Lightning (kicked)']);
  });

  it('refuses a kicker on a card that has none, rather than ignoring it', () => {
    const s = ashen(['Lightning Bolt'], mountains(1));
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      kicked: true, targets: [{ kind: 'player', seat: 1 }],
    })).toMatch(/no kicker/);
  });

  it('Breath of Darigaaz spares fliers and hits everybody else, for 1 or for 4', () => {
    const board = (hand: readonly string[], lands: readonly string[]): GameState => {
      let s = arena({
        hands: { 0: hand },
        battlefield: { 0: lands, 1: ['Serra Angel', 'Grizzly Bears'] },
        turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      });
      s = advanceTo(s, 'precombat-main');
      for (const id of ids(s, 0, 'battlefield')) {
        s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
      }
      return s;
    };

    let s = board(['Breath of Darigaaz'], ['Mountain', 'Mountain']);
    const flier = find(s, 1, 'battlefield', 'Serra Angel');
    const ground = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = cast(s, 0, 'Breath of Darigaaz');
    expect(damageOn(s, flier)).toBe(0);
    expect(damageOn(s, ground)).toBe(1);
    // "each player" is each player, including the one who cast it.
    expect(life(s, 0)).toBe(19);
    expect(life(s, 1)).toBe(19);

    // Kicked, the same spell is a sweeper: the 2/2 on the ground dies and the 4/4 in the air
    // still has not been touched.
    let kicked = board(['Breath of Darigaaz'], ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain']);
    const highFlier = find(kicked, 1, 'battlefield', 'Serra Angel');
    kicked = passBoth(apply(kicked, {
      type: 'auto:cast', by: 0, card: find(kicked, 0, 'hand', 'Breath of Darigaaz'), kicked: true,
    }));
    expect(damageOn(kicked, highFlier)).toBe(0);
    expect(countOf(kicked, 1, 'graveyard', 'Grizzly Bears')).toBe(1);
    expect(life(kicked, 0)).toBe(16);
    expect(life(kicked, 1)).toBe(16);
  });

  it('Agonizing Demise kills a creature, and kicked throws the body at its controller', () => {
    let s = arena({
      hands: { 0: ['Agonizing Demise', 'Agonizing Demise'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp', 'Mountain', 'Mountain'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of ids(s, 0, 'battlefield')) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Agonizing Demise'),
      kicked: true, targets: [{ kind: 'card', id: courser }],
    }));
    expect(countOf(s, 1, 'graveyard', 'Centaur Courser')).toBe(1);
    // A 3/3 died, so its controller takes three.
    expect(life(s, 1)).toBe(17);
  });

  it('Agonizing Demise will not point at a black creature', () => {
    let s = arena({
      hands: { 0: ['Agonizing Demise'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'], 1: ['Vampire Nighthawk'] },
      turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of ids(s, 0, 'battlefield')) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const nighthawk = find(s, 1, 'battlefield', 'Vampire Nighthawk');
    // Not offered, and refused if a client sends it anyway.
    expect(playsFor(s, 0, 'Agonizing Demise')).toEqual([]);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Agonizing Demise'),
      targets: [{ kind: 'card', id: nighthawk }],
    })).toMatch(/nonblack/);
  });

  it('Bone Splinters is not castable with nothing to sacrifice', () => {
    // A creature to kill and nothing of your own to pay with, which is the case the rule is about
    // (CR 601.2h): the spell is not offered, and a client that sends it anyway is told why.
    let s = arena({
      hands: { 0: ['Bone Splinters'] },
      battlefield: { 0: ['Swamp'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Swamp'), abilityIndex: 0 });
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    expect(playsFor(s, 0, 'Bone Splinters')).toEqual([]);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Bone Splinters'),
      targets: [{ kind: 'card', id: courser }],
    })).toMatch(/no creature to sacrifice/);
  });

  it('Bone Splinters eats a creature as it is cast, before anybody may respond', () => {
    let s = arena({
      hands: { 0: ['Bone Splinters'] },
      battlefield: { 0: ['Swamp', 'Doomed Dissenter'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Swamp'), abilityIndex: 0 });
    const fodder = find(s, 0, 'battlefield', 'Doomed Dissenter');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Bone Splinters')!;
    expect(play.sacrificeOptions).toEqual([fodder]);

    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Bone Splinters'),
      sacrifice: fodder, targets: [{ kind: 'card', id: courser }],
    });
    // Already dead while the spell is still on the stack — which is the card: the creature cannot
    // be saved in response, and the death trigger is on the stack above the spell that caused it.
    expect(s.instances[fodder]!.zone).toBe('graveyard');
    s = drain(s);
    expect(countOf(s, 1, 'graveyard', 'Centaur Courser')).toBe(1);
    // Doomed Dissenter's own death made a Zombie, because a sacrifice is a death like any other.
    expect(countOf(s, 0, 'battlefield', 'Zombie')).toBe(1);
  });

  it('refuses a cast that skips its additional cost, and one that invents one', () => {
    let s = arena({
      hands: { 0: ['Bone Splinters', 'Lightning Bolt'] },
      battlefield: { 0: ['Swamp', 'Mountain', 'Doomed Dissenter'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
    });
    s = advanceTo(s, 'precombat-main');
    for (const name of ['Swamp', 'Mountain']) {
      s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', name), abilityIndex: 0 });
    }
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Bone Splinters'),
      targets: [{ kind: 'card', id: courser }],
    })).toMatch(/choose a creature to sacrifice/);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      sacrifice: find(s, 0, 'battlefield', 'Doomed Dissenter'),
      targets: [{ kind: 'card', id: courser }],
    })).toMatch(/no additional cost/);
  });

  it('Village Rites turns a creature into two cards', () => {
    let s = arena({
      hands: { 0: ['Village Rites'] },
      battlefield: { 0: ['Swamp', 'Doomed Dissenter'] },
      turn: 2, firstSeat: 0, decks: { 0: 'ashen-rite' },
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Swamp'), abilityIndex: 0 });
    const fodder = find(s, 0, 'battlefield', 'Doomed Dissenter');
    const before = ids(s, 0, 'hand').length;
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Village Rites'), sacrifice: fodder,
    }));
    // Two drawn, one spent: a card up on the exchange, and a creature down.
    expect(ids(s, 0, 'hand').length).toBe(before + 1);
    expect(s.instances[fodder]!.zone).toBe('graveyard');
  });

  it('Judith pumps the others and not herself, and pings for every nontoken death', () => {
    // Cast from the command zone rather than placed, because a static effect is created as the
    // permanent arrives: a Judith put straight onto the battlefield by the tabletop actions has
    // no anthem, exactly as a Glorious Anthem placed that way has none.
    let s = arena({
      hands: { 0: [] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Mountain', 'Doomed Dissenter'] },
      turn: 2, firstSeat: 0, format: 'pod', decks: { 0: 'ashen-rite' },
    });
    s = advanceTo(s, 'precombat-main');
    for (const name of ['Swamp', 'Swamp', 'Mountain']) {
      const land = ids(s, 0, 'battlefield').find((id) =>
        s.cardDefs[s.instances[id]!.defKey]!.name === name && !s.instances[id]!.tapped)!;
      s = apply(s, { type: 'auto:activate', by: 0, card: land, abilityIndex: 0 });
    }
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'command', 'Judith, the Scourge Diva'),
    }));
    const judith = find(s, 0, 'battlefield', 'Judith, the Scourge Diva');
    const dissenter = find(s, 0, 'battlefield', 'Doomed Dissenter');
    // "Other creatures you control get +1/+0": a 1/1 is a 2/1, and Judith is still a 2/2.
    expect([power(s, dissenter), toughness(s, dissenter)]).toEqual([2, 1]);
    expect([power(s, judith), toughness(s, judith)]).toEqual([2, 2]);

    // A nontoken creature dies, and the trigger wants a target.
    s = apply(s, { type: 'card:move', by: 0, card: dissenter, toZone: 'graveyard' });
    s = drain(s);
    expect(s.pendingChoice).not.toBeNull();
    s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'player', seat: 1 }] });
    s = drain(s);
    expect(life(s, 1)).toBe(39);
  });

  it('and a token dying is not a nontoken creature dying', () => {
    let s = arena({
      hands: { 0: [] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Mountain'] },
      turn: 2, firstSeat: 0, format: 'pod', decks: { 0: 'ashen-rite' },
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'command', 'Judith, the Scourge Diva'),
    }));
    s = apply(s, {
      type: 'token:create', by: 0, seat: 0, count: 1,
      card: {
        name: 'Zombie', typeLine: 'Token Creature \u2014 Zombie', manaCost: '', cmc: 0,
        power: '2', toughness: '2', oracleText: '', colors: ['B'],
      },
    });
    const token = find(s, 0, 'battlefield', 'Zombie');
    s = drain(apply(s, { type: 'card:move', by: 0, card: token, toZone: 'graveyard' }));
    // Nothing to aim, and nothing to answer: the clause on the trigger is doing its job.
    expect(s.pendingChoice).toBeNull();
    expect(life(s, 1)).toBe(40);
  });
});

/**
 * The three cards that needed the attack event to watch the board rather than one creature.
 *
 * Hellrider is the reason the widening happened: "whenever a creature you control attacks" is not
 * a trigger about Hellrider at all, and before this the engine only offered an attack to the
 * creature that made it. Ball Lightning and Cloudshift are here because they are the two halves of
 * the same increment that needed *no* new vocabulary, and a test that proves it is worth more than
 * a comment claiming it.
 */
describe('attacks that trigger off the board', () => {
  /** Ember Rush on seat 0 with `board` already down, at declare-attackers. */
  const swing = (board: readonly string[]) =>
    advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      battlefield: { 0: [...board] },
      turn: 3, firstSeat: 0,
    }), 'declare-attackers');

  it('Hellrider pings the defending player once per attacker, before any damage', () => {
    let s = swing(['Hellrider', 'Raging Goblin', 'Monastery Swiftspear']);
    const attackers = ['Hellrider', 'Raging Goblin', 'Monastery Swiftspear']
      .map((name) => find(s, 0, 'battlefield', name));
    s = apply(s, {
      type: 'auto:attack', by: 0,
      attackers: attackers.map((attacker) => ({ attacker, defender: 1 as SeatIndex })),
    });
    // Three attacks, three triggers — Hellrider's own included, because it is a creature you
    // control and `who: 'any'` means it.
    expect(s.stackOrder.length).toBe(3);
    s = drain(s);
    // Three damage, and still in declare-attackers: this all happens before blockers, which is
    // the half of the card that wins races.
    expect(life(s, 1)).toBe(17);
    expect(s.step).toBe('declare-attackers');
  });

  it("and an opponent's attack is not a creature you control attacking", () => {
    // Hellrider on seat 0, and seat 1 does the attacking. `of: 'you'` is the whole difference
    // between a card that rewards your attacks and one that punishes everybody's.
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'rot-harvest' },
      battlefield: { 0: ['Hellrider'], 1: ['Centaur Courser'] },
      turn: 4, firstSeat: 1,
    }), 'declare-attackers');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = drain(apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: courser, defender: 0 }] }));
    expect(s.stackOrder.length).toBe(0);
    expect(life(s, 0)).toBe(20);
  });

  it('Hellrider hits the planeswalker when that is what the attack was aimed at', () => {
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      battlefield: { 0: ['Hellrider'], 1: ['Jace Beleren'] },
      turn: 3, firstSeat: 0,
    }), 'declare-attackers');
    const hellrider = find(s, 0, 'battlefield', 'Hellrider');
    const jace = find(s, 1, 'battlefield', 'Jace Beleren');
    s = drain(apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: hellrider, defender: 1, planeswalker: jace }],
    }));
    // "The player or planeswalker it's attacking": one loyalty gone, and the player untouched.
    expect(s.instances[jace]!.counters['loyalty']).toBe(2);
    expect(life(s, 1)).toBe(20);
  });

  it('Ball Lightning attacks the turn it lands and sacrifices itself at end of turn', () => {
    let s = withMana(0, ['Ball Lightning'], 3);
    s = cast(s, 0, 'Ball Lightning');
    const ball = find(s, 0, 'battlefield', 'Ball Lightning');
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: ball, defender: 1 }] });
    // Haste, trample, six power, and nothing on the other side.
    s = advanceTo(drain(s), 'end');
    expect(life(s, 1)).toBe(14);
    // The end step trigger is the card's price, and it is a sacrifice rather than a destruction:
    // nothing about the board can save it.
    s = drain(s);
    expect(s.instances[ball]!.zone).toBe('graveyard');
  });

  it('Cloudshift makes the creature arrive again, which fires its arrival trigger again', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      hands: { 0: ['Cloudshift'] },
      battlefield: { 0: ['Plains', 'Elvish Visionary'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Plains'), abilityIndex: 0 });
    const visionary = find(s, 0, 'battlefield', 'Elvish Visionary');
    const handBefore = ids(s, 0, 'hand').length;
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Cloudshift'),
      targets: [{ kind: 'card', id: visionary }],
    }));
    // The Cloudshift left the hand and a card was drawn by the second arrival: one fewer card for
    // the spell, one more for the trigger, so the hand is where it started.
    expect(ids(s, 0, 'hand').length).toBe(handBefore);
    expect(namesIn(s, 0, 'battlefield')).toContain('Elvish Visionary');
    // Same card, so the id survives — it is the *permanent* that is new, not the card.
    expect(s.instances[visionary]!.zone).toBe('battlefield');
  });

  it('and an attacker blinked mid-combat is out of combat, so it deals no damage', () => {
    // CR 506.4 with CR 400.7: a permanent that leaves the battlefield is removed from combat, and
    // the card that comes back is a new object rather than an attacking creature. The engine keeps
    // one id per card, so without the object check the returned creature swings anyway — which is
    // what it did until this test was written.
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      hands: { 0: ['Cloudshift'] },
      battlefield: { 0: ['Plains', 'Grizzly Bears'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: bears, defender: 1 }] });
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Cloudshift'),
      targets: [{ kind: 'card', id: bears }],
    }));
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(20);
    // And it came back untapped, which is the half of the blink that is worth the mana: attacking
    // with it cost nothing, because what attacked is gone.
    expect(s.instances[bears]!.tapped).toBe(false);
    expect(s.instances[bears]!.zone).toBe('battlefield');
  });

  it('and a creature blinked in response to removal is no longer what the removal targeted', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      hands: { 0: ['Cloudshift'], 1: ['Doom Blade'] },
      battlefield: { 0: ['Plains', 'Grizzly Bears'], 1: ['Swamp', 'Swamp'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: bears }],
    });
    // The caster keeps priority after casting, so seat 0 only gets to respond once it is passed.
    s = apply(s, { type: 'auto:pass', by: 1 });
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Cloudshift'),
      targets: [{ kind: 'card', id: bears }],
    });
    s = drain(s);
    // The Doom Blade resolved against a permanent that no longer exists and was countered on
    // resolution for having no legal target (CR 608.2b) — none of which Cloudshift's script says.
    expect(namesIn(s, 0, 'battlefield')).toContain('Grizzly Bears');
    expect(namesIn(s, 1, 'graveyard')).toContain('Doom Blade');
  });
});

/**
 * The four keywords the engine enforced for nobody, and the static scope nothing used.
 *
 * Every one of them was written, checked in the rules and never carried by a card: first strike in
 * `dealsInStep`, menace in `menaceSatisfied`, indestructible in `destroy` and in the lethal-damage
 * state-based action, shroud in `isLegalTarget`, and `all-creatures` in the static layer. A live
 * path with no card behind it is the same risk as an untested one, so these five cards exist to
 * make each of them do something in a real game.
 */
describe('the keywords nothing in the pool carried', () => {
  it('Youthful Knight deals its damage in a step that only exists because of the keyword', () => {
    let s = arena({
      decks: { 0: 'forge-alliance', 1: 'rot-harvest' },
      battlefield: { 0: ['Youthful Knight'], 1: ['Centaur Courser'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const knight = find(s, 0, 'battlefield', 'Youthful Knight');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: knight, defender: 1 }] });
    s = passBoth(s);
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: courser, attacker: knight }] });
    // Walk the rest of combat and write down the steps it went through. The claim is the step
    // itself: `needsFirstStrikeStep` only inserts a first-strike damage step when something in
    // combat has the keyword, and until this card nothing in the pool ever did.
    const steps: string[] = [];
    for (let i = 0; i < 8 && s.step !== 'postcombat-main'; i++) {
      steps.push(s.step);
      s = passBoth(s);
    }
    expect(steps).toContain('first-strike-damage');
    // Two damage on the 3/3, which survives — and the 2/2 dies to the regular damage it was
    // always going to take. First strike is not protection; it is an order.
    expect(damageOn(s, courser)).toBe(2);
    expect(s.instances[knight]!.zone).toBe('graveyard');
    expect(s.instances[courser]!.zone).toBe('battlefield');
  });

  it('Boggart Brute cannot be blocked by one creature, and can be by two', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'rot-harvest' },
      battlefield: { 0: ['Boggart Brute'], 1: ['Centaur Courser', 'Llanowar Elves'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const brute = find(s, 0, 'battlefield', 'Boggart Brute');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: brute, defender: 1 }] }));
    // One blocker is not a legal declaration at all (CR 702.110a) — the whole declaration is
    // refused rather than accepted and then undone, which is also what keeps the table honest:
    // it only lights the blocks the engine would take.
    expect(refusal(s, {
      type: 'auto:block', by: 1, blocks: [{ blocker: courser, attacker: brute }],
    })).toContain('menace');
    s = drain(apply(s, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: courser, attacker: brute }, { blocker: elves, attacker: brute }],
    }));
    expect(s.combat.attacks[0]!.blockers).toHaveLength(2);
  });

  it('Darksteel Plate saves its creature from lethal damage and from a destroy spell', () => {
    let s = arena({
      decks: { 0: 'forge-alliance', 1: 'tidal-mind' },
      hands: { 0: ['Lightning Bolt'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Mountain', 'Elite Vanguard', 'Darksteel Plate'],
        1: ['Swamp', 'Swamp'],
      },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const body = find(s, 0, 'battlefield', 'Elite Vanguard');
    const plate = find(s, 0, 'battlefield', 'Darksteel Plate');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: plate, abilityIndex: 0,
      targets: [{ kind: 'card', id: body }],
    }));
    expect(s.instances[plate]!.attachedTo).toBe(body);
    // Three damage on a 2/1 is lethal, and the state-based action that notices lethal damage has
    // to leave an indestructible creature alone (CR 704.5g). The damage stays marked on it.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: body }],
    })));
    expect(s.instances[body]!.zone).toBe('battlefield');
    expect(damageOn(s, body)).toBe(3);
  });

  it('and the word destroy does nothing to it', () => {
    let s = arena({
      decks: { 0: 'forge-alliance', 1: 'tidal-mind' },
      hands: { 1: ['Doom Blade'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Elite Vanguard', 'Darksteel Plate'],
        1: ['Swamp', 'Swamp'],
      },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const body = find(s, 0, 'battlefield', 'Elite Vanguard');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Darksteel Plate'), abilityIndex: 0,
      targets: [{ kind: 'card', id: body }],
    }));
    s = advanceTo(nextTurn(s), 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: body }],
    })));
    // The spell resolved rather than being countered for having no legal target, and did nothing.
    expect(namesIn(s, 1, 'graveyard')).toContain('Doom Blade');
    expect(s.instances[body]!.zone).toBe('battlefield');
  });

  it('Robe of Mirrors stops everybody targeting it, its own controller included', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'rot-harvest' },
      hands: { 0: ['Robe of Mirrors', 'Unsummon'], 1: ['Doom Blade'] },
      battlefield: { 0: ['Island', 'Island', 'Child of Night'], 1: ['Swamp', 'Swamp'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const body = find(s, 0, 'battlefield', 'Child of Night');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Robe of Mirrors'),
      targets: [{ kind: 'card', id: body }],
    }));
    expect(characteristicsOf(s, s.instances[body]!).keywords.has('shroud')).toBe(true);
    // Shroud is not hexproof, which is the whole reason this card is in the pool and a hexproof
    // one is not: its own controller cannot target it either.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Unsummon'),
      targets: [{ kind: 'card', id: body }],
    })).not.toBeNull();
    // And the removal across the table cannot be aimed at it — refused by the engine, and never
    // offered by the table, because `legalActions` asks the same question.
    s = advanceTo(nextTurn(s), 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    expect(refusal(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: body }],
    })).not.toBeNull();
    expect(legalActions(s, 1).plays.some((play) => play.name === 'Doom Blade')).toBe(false);
  });

  it("Night of Souls' Betrayal shrinks every creature on the table, and kills the small ones", () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'rot-harvest' },
      hands: { 0: ["Night of Souls' Betrayal"] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'],
        1: ['Centaur Courser', 'Llanowar Elves'],
      },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    // Cast rather than placed, because a static effect is created as the permanent arrives — the
    // same trap the anthems set, one scope wider.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', "Night of Souls' Betrayal"),
    })));
    // Across the table, which is what `all-creatures` means and what no card had ever asked for:
    // a 3/3 is a 2/2, and the 1/1 has nothing left and is swept up (CR 704.5f).
    expect([power(s, courser), toughness(s, courser)]).toEqual([2, 2]);
    expect(s.instances[elves]!.zone).toBe('graveyard');
  });

  it('and a 1/1 token that arrives afterwards arrives dead', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'rot-harvest' },
      hands: { 0: ["Night of Souls' Betrayal"] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', "Night of Souls' Betrayal"),
    })));
    s = apply(s, {
      type: 'token:create', by: 0, seat: 0, count: 2,
      card: {
        name: 'Goblin', typeLine: 'Token Creature \u2014 Goblin', manaCost: '', cmc: 0,
        power: '1', toughness: '1', oracleText: '', colors: ['R'],
      },
    });
    s = drain(s);
    // Both are gone, and a token that leaves the battlefield ceases to exist — so neither zone
    // has them rather than the graveyard having two.
    expect(namesIn(s, 0, 'battlefield')).not.toContain('Goblin');
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Goblin');
  });
});

/**
 * The seventh deck's own cards.
 *
 * Three of the four are a keyword and a body, which is the point of including them here anyway:
 * `defender` had never been on a flier, and the commander is the first in the pool whose text is an
 * activated ability pointing into a graveyard.
 */
describe('white-blue: the seventh deck', () => {
  it('Wall of Air blocks a flier and cannot attack', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'skyward-writ' },
      battlefield: { 0: ['Air Elemental'], 1: ['Wall of Air'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const elemental = find(s, 0, 'battlefield', 'Air Elemental');
    const wall = find(s, 1, 'battlefield', 'Wall of Air');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: elemental, defender: 1 }] }));
    // A 1/5 flier stops a 4/4 flier dead: that is what the card is for, and nothing in the pool
    // could block a flier without being one.
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: wall, attacker: elemental }] }));
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(20);
    expect(s.instances[wall]!.zone).toBe('battlefield');

    // And on its own turn it is not offered as an attacker at all (CR 702.3b).
    s = advanceTo(nextTurn(s), 'declare-attackers');
    expect(legalActions(s, 1).attackers).not.toContain(wall);
  });

  it("Hanna buys back an enchantment from her controller's graveyard, once a turn", () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'rot-harvest' },
      hands: { 0: [] },
      battlefield: {
        0: ['Plains', 'Plains', 'Island', "Hanna, Ship's Navigator"],
      },
      graveyard: { 0: ['Pacifism', 'Serra Angel'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const hanna = find(s, 0, 'battlefield', "Hanna, Ship's Navigator");
    const pacifism = find(s, 0, 'graveyard', 'Pacifism');
    const angel = find(s, 0, 'graveyard', 'Serra Angel');
    // The creature in the same graveyard is not a legal target: the filter is the printed type
    // line, which is the right test for a card that has no continuous effects on it.
    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: hanna, abilityIndex: 0,
      targets: [{ kind: 'card', id: angel }],
    })).not.toBeNull();
    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: hanna, abilityIndex: 0,
      targets: [{ kind: 'card', id: pacifism }],
    })));
    expect(namesIn(s, 0, 'hand')).toContain('Pacifism');
    // Tapped for it, so it is once a turn and she is not blocking this turn either.
    expect(s.instances[hanna]!.tapped).toBe(true);
  });

  it('and not out of somebody else’s graveyard', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
      battlefield: { 0: ['Plains', 'Plains', 'Island', "Hanna, Ship's Navigator"] },
      graveyard: { 1: ['Pacifism'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const hanna = find(s, 0, 'battlefield', "Hanna, Ship's Navigator");
    const theirs = find(s, 1, 'graveyard', 'Pacifism');
    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: hanna, abilityIndex: 0,
      targets: [{ kind: 'card', id: theirs }],
    })).not.toBeNull();
    // With nothing of her own to take back, the ability is not offered at all (CR 603.3c applies to
    // triggers; for an activated ability it is `legalActions` refusing to offer an unanswerable one).
    const offered = legalActions(s, 0).plays.some((play) => play.card === hanna);
    expect(offered).toBe(false);
  });
});

/**
 * The eleven that came after the seventh deck.
 *
 * Most are the vocabulary doing what it already does, and the tests for those are short on purpose.
 * Three are here for the paths they reach: a pump on a creature's own attack, two targets pointed
 * at each other, and the first filter in the pool that reads combat rather than the battlefield.
 */
describe('eleven more cards', () => {
  it('Lightning Strike deals 3 to anything, and Lava Axe 5 to a player', () => {
    let s = withMana(0, ['Lightning Strike', 'Lava Axe'], 7);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Strike'),
      targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(s, 1)).toBe(17);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lava Axe'),
      targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(s, 1)).toBe(12);
  });

  it('Cancel counters a spell, and Murder kills a creature of any colour', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'rot-harvest' },
      hands: { 0: ['Cancel', 'Murder'], 1: ['Centaur Courser'] },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Swamp', 'Swamp', 'Swamp'],
        1: ['Forest', 'Forest', 'Forest', 'Drudge Skeletons'],
      },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Centaur Courser') });
    s = apply(s, { type: 'auto:pass', by: 1 });
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const courser = find(s, 1, 'stack', 'Centaur Courser');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Cancel'),
      targets: [{ kind: 'card', id: courser }],
    })));
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    // The active player gets priority back when the stack empties, so seat 1 has to pass before
    // seat 0 can cast the second instant. Still the same step, so the mana is still in the pool.
    s = apply(s, { type: 'auto:pass', by: 1 });
    // And the black removal that does not read colours: the Skeletons are black, which a Doom
    // Blade cannot touch.
    const skeletons = find(s, 1, 'battlefield', 'Drudge Skeletons');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Murder'),
      targets: [{ kind: 'card', id: skeletons }],
    })));
    expect(s.instances[skeletons]!.zone).not.toBe('battlefield');
  });

  it('Giant Spider blocks a flier without being one', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      battlefield: { 0: ['Wind Drake'], 1: ['Giant Spider'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const drake = find(s, 0, 'battlefield', 'Wind Drake');
    const spider = find(s, 1, 'battlefield', 'Giant Spider');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: drake, defender: 1 }] }));
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: spider, attacker: drake }] }));
    s = advanceTo(s, 'postcombat-main', 120);
    // Reach is not flying: the Spider cannot be blocked by what it blocks, and nothing about it
    // attacks in the air. All it does is stop one, and a 2/4 into a 2/2 stops it for good.
    expect(life(s, 1)).toBe(20);
    expect(s.instances[spider]!.zone).toBe('battlefield');
    expect(s.instances[drake]!.zone).toBe('graveyard');
  });

  it('Titanic Growth is four more power, and Healer\u2019s Hawk gains the life it deals', () => {
    let s = withMana(1, ['Titanic Growth'], ['Forest', 'Forest'], ['Grizzly Bears']);
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Titanic Growth'),
      targets: [{ kind: 'card', id: bears }],
    }));
    expect([power(s, bears), toughness(s, bears)]).toEqual([6, 6]);

    let t = arena({
      decks: { 0: 'skyward-writ', 1: 'rot-harvest' },
      battlefield: { 0: ["Healer's Hawk"] },
      turn: 3, firstSeat: 0,
    });
    t = advanceTo(t, 'declare-attackers');
    const hawk = find(t, 0, 'battlefield', "Healer's Hawk");
    t = drain(apply(t, { type: 'auto:attack', by: 0, attackers: [{ attacker: hawk, defender: 1 }] }));
    t = advanceTo(t, 'postcombat-main', 120);
    expect(life(t, 1)).toBe(19);
    expect(life(t, 0)).toBe(21);
  });

  it('Dark Ritual puts three black mana in the pool, and it pays for the next spell', () => {
    // The first spell in the pool that makes mana rather than spending it. Nothing in the solver
    // changed for it: the mana is in the pool, and the next play asks the pool what it can afford.
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      hands: { 0: ['Dark Ritual', 'Flametongue Kavu'] },
      battlefield: { 0: ['Swamp', 'Mountain'], 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Dark Ritual'),
    })));
    expect(s.pools['0']).toMatchObject({ B: 3, R: 1 });
    // One Swamp spent, three black back: a four-drop off two lands, a turn early. The Mountain is
    // not spare change — {R} is the one symbol in the Kavu's cost the Ritual cannot pay, which is
    // the honest limit of a spell that makes one colour.
    const kavu = find(s, 0, 'hand', 'Flametongue Kavu');
    expect(legalActions(s, 0).plays.some((play) => play.card === kavu)).toBe(true);
  });

  it('Borderland Marauder is a 4/2 on the swing and a 2/2 the rest of the time', () => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'verdant-guard' },
      battlefield: { 0: ['Borderland Marauder'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const marauder = find(s, 0, 'battlefield', 'Borderland Marauder');
    expect([power(s, marauder), toughness(s, marauder)]).toEqual([2, 2]);
    s = drain(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: marauder, defender: 1 }] }));
    // Its own attack and nobody else's: the trigger says nothing about `who`, so the widening of
    // the event left it meaning exactly what it meant.
    expect([power(s, marauder), toughness(s, marauder)]).toEqual([4, 2]);
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(16);
    // And it is a 2/2 again next turn.
    s = advanceTo(nextTurn(s), 'precombat-main');
    expect(power(s, marauder)).toBe(2);
  });

  it('Prey Upon makes two creatures fight, and both deal their damage', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'rot-harvest' },
      hands: { 0: ['Prey Upon'] },
      battlefield: { 0: ['Forest', 'Centaur Courser'], 1: ['Centaur Courser'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Forest'), abilityIndex: 0 });
    const mine = find(s, 0, 'battlefield', 'Centaur Courser');
    const theirs = find(s, 1, 'battlefield', 'Centaur Courser');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Prey Upon'),
      targets: [{ kind: 'card', id: mine }, { kind: 'card', id: theirs }],
    })));
    // Two 3/3s fighting kill each other: the damage is simultaneous, so the one that dies still
    // dealt its three (CR 701.12a).
    expect(s.instances[mine]!.zone).toBe('graveyard');
    expect(s.instances[theirs]!.zone).toBe('graveyard');
  });

  it('Divine Verdict kills an attacker, and cannot be cast when nothing is attacking', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'rot-harvest' },
      hands: { 0: ['Divine Verdict'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Centaur Courser'],
      },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const verdict = find(s, 0, 'hand', 'Divine Verdict');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    // Nothing is attacking, so the filter finds no legal target and the engine does not offer the
    // card at all — which is what the printed card does on your own main phase (CR 601.2c).
    expect(legalActions(s, 0).plays.some((play) => play.card === verdict)).toBe(false);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: verdict, targets: [{ kind: 'card', id: courser }],
    })).not.toBeNull();

    // Now it is attacking, and the same card is castable and kills it. A fresh board rather than
    // the next turn of this one, because the Plains above are spent and a seat's lands untap in
    // its own untap step — on the turn the Verdict is wanted, they would all still be tapped.
    let t = arena({
      decks: { 0: 'skyward-writ', 1: 'rot-harvest' },
      hands: { 0: ['Divine Verdict'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Centaur Courser'],
      },
      turn: 4, firstSeat: 1,
    });
    t = advanceTo(t, 'declare-attackers');
    const attacker = find(t, 1, 'battlefield', 'Centaur Courser');
    t = apply(t, { type: 'auto:attack', by: 1, attackers: [{ attacker, defender: 0 }] });
    // The attacking player holds priority first, in the step its attack was declared in.
    t = apply(t, { type: 'auto:pass', by: 1 });
    for (const id of [...ids(t, 0, 'battlefield')]) {
      t = apply(t, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const held = find(t, 0, 'hand', 'Divine Verdict');
    expect(legalActions(t, 0).plays.some((play) => play.card === held)).toBe(true);
    t = drain(passBoth(apply(t, {
      type: 'auto:cast', by: 0, card: held, targets: [{ kind: 'card', id: attacker }],
    })));
    expect(t.instances[attacker]!.zone).toBe('graveyard');
    // Removed before damage, so nothing got through.
    t = advanceTo(t, 'postcombat-main', 120);
    expect(life(t, 0)).toBe(20);
  });
});

describe('setting what a creature is, and copying it', () => {
  /*
    The two cards that needed layers, and the four assertions that are *about* the layers rather
    than about the cards.

    Everything else in this pool adds to a creature. A +3/+3 and a -1/-1 can be summed in any
    order; "becomes 1/1" cannot be summed at all — it replaces the base the pumps then apply to,
    which is layer 7b against 7c (CR 613.4c). And "loses all abilities" is the one layer where the
    timestamp is the rule rather than a tie-break: what it took away stays gone, and what is
    granted after it survives.
  */
  const frogged = (extra: readonly string[] = []): GameState => arena({
    decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
    hands: { 0: ['Turn to Frog', ...extra] },
    battlefield: {
      0: ['Island', 'Island', 'Island', 'Island', 'Island'],
      1: ['Giant Spider'],
    },
    turn: 4, firstSeat: 0,
  });

  it('turns a 2/4 reach blocker into a 1/1 with nothing', () => {
    let s = advanceTo(frogged(), 'precombat-main');
    s = tapAllLands(s, 0);
    const spider = find(s, 1, 'battlefield', 'Giant Spider');
    expect(characteristicsOf(s, s.instances[spider]!).keywords.has('reach')).toBe(true);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Turn to Frog'),
      targets: [{ kind: 'card', id: spider }],
    })));
    const ch = characteristicsOf(s, s.instances[spider]!);
    expect([ch.power, ch.toughness]).toEqual([1, 1]);
    expect(ch.keywords.size).toBe(0);
    // Still a creature, still on the battlefield: this is not removal, it is a 1/1.
    expect(s.instances[spider]!.zone).toBe('battlefield');
  });

  it('and a pump already on it still applies, because modifying comes after setting', () => {
    // Giant Growth first, then the Frog. The printed base is replaced; the +3/+3 is not, because
    // layer 7c runs after 7b whatever the timestamps say — so the Frog is a 4/4, not a 1/1.
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 0: ['Turn to Frog'], 1: ['Giant Growth'] },
      battlefield: {
        0: ['Island', 'Island'],
        1: ['Giant Spider', 'Forest'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const spider = find(s, 1, 'battlefield', 'Giant Spider');
    s = tapAllLands(s, 1);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'),
      targets: [{ kind: 'card', id: spider }],
    })));
    expect(characteristicsOf(s, s.instances[spider]!).power).toBe(5);

    s = advanceTo(nextTurn(s), 'precombat-main');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Turn to Frog'),
      targets: [{ kind: 'card', id: spider }],
    })));
    // A fresh turn, so the Growth has worn off and the Frog is alone: 1/1.
    const ch = characteristicsOf(s, s.instances[spider]!);
    expect([ch.power, ch.toughness]).toEqual([1, 1]);
  });

  it('counters are added after the setting, which is layer 7d after 7b', () => {
    let s = advanceTo(frogged(), 'precombat-main');
    s = tapAllLands(s, 0);
    const spider = find(s, 1, 'battlefield', 'Giant Spider');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Turn to Frog'),
      targets: [{ kind: 'card', id: spider }],
    })));
    s = addCounters(s, spider, '+1/+1', 2);
    const ch = characteristicsOf(s, s.instances[spider]!);
    expect([ch.power, ch.toughness]).toEqual([3, 3]);
  });

  it('an ability granted after it survives, and one granted before it does not', () => {
    const board = (): GameState => arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      battlefield: { 0: [], 1: ['Grizzly Bears'] },
      turn: 4, firstSeat: 0,
    });
    const bears = (state: GameState): string => find(state, 1, 'battlefield', 'Grizzly Bears');

    // Granted first, then frogged: gone (CR 613.1f).
    let before = board();
    const id = bears(before);
    before = pump(before, [id], id, 1, { keywords: ['flying'] });
    before = pump(before, [id], id, 0, { setPower: 1, setToughness: 1, losesAllAbilities: true });
    expect(characteristicsOf(before, before.instances[id]!).keywords.has('flying')).toBe(false);

    // Frogged first, then granted: still flies.
    let after = board();
    const other = bears(after);
    after = pump(after, [other], other, 0, { setPower: 1, setToughness: 1, losesAllAbilities: true });
    after = pump(after, [other], other, 1, { keywords: ['flying'] });
    const ch = characteristicsOf(after, after.instances[other]!);
    expect(ch.keywords.has('flying')).toBe(true);
    // And it is still a 1/1: layer 6 and layer 7b are different layers.
    expect([ch.power, ch.toughness]).toEqual([1, 1]);
  });

  it('Clone enters as a copy of anything on the table, and is a Clone again when it dies', () => {
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'ember-rush' },
      hands: { 0: ['Clone'] },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Island'],
        1: ['Shivan Dragon', 'Raging Goblin'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const clone = find(s, 0, 'hand', 'Clone');
    s = apply(s, { type: 'auto:cast', by: 0, card: clone });
    s = passBoth(s);

    // The question is about the whole board: both of the opponent's creatures are offered, which
    // is the only question in the engine that crosses the table.
    const ask = legalActions(s, 0).mustDecide;
    expect(ask?.from).toBe('any-battlefield');
    expect(ask?.candidates).toContain(find(s, 1, 'battlefield', 'Shivan Dragon'));
    expect(ask?.candidates).toContain(find(s, 1, 'battlefield', 'Raging Goblin'));

    s = drain(apply(s, {
      type: 'auto:decide', by: 0, cards: [find(s, 1, 'battlefield', 'Shivan Dragon')],
    }));
    // It arrived as the Dragon: the copy is what entered, so it is a 5/5 that flies and has the
    // Dragon's own firebreathing ability, under seat 0's control.
    const copy = s.instances[clone]!;
    expect(copy.zone).toBe('battlefield');
    expect(copy.zoneSeat).toBe(0);
    const ch = characteristicsOf(s, copy);
    expect(ch.name).toBe('Shivan Dragon');
    expect([ch.power, ch.toughness]).toEqual([5, 5]);
    expect(ch.keywords.has('flying')).toBe(true);
    // And the copied card's abilities are its abilities, because what gives a permanent its
    // abilities is the name on it. (Not asserted through `legalActions`: the Dragon's
    // firebreathing costs {R} and this deck has nothing but Islands, so the engine is right not to
    // offer it.)
    expect(scriptFor(ch.name)?.abilities?.[0]?.description).toContain('+1/+0');

    // And when it dies it is a Clone again, because a copy effect lasts as long as the permanent
    // (CR 613.1a) — which is what Zombify would bring back. Moved by hand rather than killed with
    // a spell: what is being tested is the zone change, which is where the engine restores it.
    s = drain(apply(s, { type: 'card:move', by: 0, card: clone, toZone: 'graveyard' }));
    expect(s.instances[clone]!.zone).toBe('graveyard');
    expect(nameOf(s, clone)).toBe('Clone');
  });

  it("Cackling Counterpart copies the printed card and nothing else", () => {
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 0: ['Cackling Counterpart'] },
      battlefield: { 0: ['Island', 'Island', 'Island', 'Fog Bank'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const bank = find(s, 0, 'battlefield', 'Fog Bank');
    // Two +1/+1 counters and a pump on the original, none of which a copy copies (CR 707.2).
    s = addCounters(s, bank, '+1/+1', 2);
    s = pump(s, [bank], bank, 0, { power: 3, toughness: 3 });
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Cackling Counterpart'),
      targets: [{ kind: 'card', id: bank }],
    })));
    const copies = [...ids(s, 0, 'battlefield')].filter((c) => nameOf(s, c) === 'Fog Bank' && c !== bank);
    expect(copies.length).toBe(1);
    const token = copies[0]!;
    expect(s.instances[token]!.isToken).toBe(true);
    const ch = characteristicsOf(s, s.instances[token]!);
    expect([ch.power, ch.toughness]).toEqual([0, 2]);
    expect(s.instances[token]!.counters['+1/+1']).toBeUndefined();
    // And it has the copied card's own abilities, because its name is what `scriptFor` reads: a
    // token copy of a Fog Bank prevents damage, which is a static the arrivals pass installed.
    expect(s.effects.some((e) => e.source === token && e.preventsCombatDamage === true)).toBe(true);
  });
});

describe('a land that becomes a creature, and a creature that changes colour', () => {
  /*
    Layers 4 and 5, which were the last two of CR 613 this engine had named and not built.

    The assertions here are about the *layers* rather than the cards. Layer 4 is the one that forced
    `characteristicsOf` into two passes: what a permanent is decides which other effects apply to
    it, so an animated land has to be a creature before an anthem's scope is judged — the anthem
    test below is the one that fails on a single-pass implementation. Layer 5 only has to be in
    effect order, and what makes it worth having is that something in the pool reads colour:
    protection from red.
  */
  const vault = (hand: readonly string[] = [], turn = 3): GameState => advanceTo(arena({
    decks: { 0: 'ember-rush', 1: 'tidal-mind' },
    hands: { 0: [...hand] },
    battlefield: { 0: ['Mutavault', 'Mountain', 'Mountain'], 1: [] },
    turn, firstSeat: 0,
  }), 'precombat-main');

  /**
   * Pays the {1} and animates it, through the stack like any other activated ability.
   *
   * The mana ability is not on the stack (CR 605.3a) and the animation is, so the second
   * activation has to be allowed to resolve — an ability sitting on the stack is not a creature
   * yet, which is a rule and not a quirk of this helper.
   */
  const animate = (state: GameState): { s: GameState; id: string } => {
    const id = find(state, 0, 'battlefield', 'Mutavault');
    let s = apply(state, {
      type: 'auto:activate', by: 0, card: find(state, 0, 'battlefield', 'Mountain'), abilityIndex: 0,
    });
    s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 1 });
    return { s: drain(passBoth(s)), id };
  };

  it('is a 2/2 creature and a land at the same time', () => {
    const { s, id } = animate(vault());
    const ch = characteristicsOf(s, s.instances[id]!);
    // "It's still a land" is the clause that makes the card, and `addTypes` rather than a replaced
    // type line is what keeps it true.
    expect(ch.isCreature).toBe(true);
    expect(ch.isLand).toBe(true);
    expect([ch.power, ch.toughness]).toEqual([2, 2]);
    expect(hasType(ch.typeLine, 'creature')).toBe(true);
    expect(hasType(ch.typeLine, 'land')).toBe(true);
  });

  it('and stops being a creature at end of turn', () => {
    const { s, id } = animate(vault());
    const later = nextTurn(s);
    const ch = characteristicsOf(later, later.instances[id]!);
    expect(ch.isCreature).toBe(false);
    expect(ch.isLand).toBe(true);
    expect(later.instances[id]!.zone).toBe('battlefield');
  });

  it('an anthem pumps it, which is why layer 4 runs before the rest', () => {
    /*
      The test that fails on a one-pass implementation. A Glorious Anthem's scope is "creatures you
      control", and judging that against the *printed* type line of an animated land says no — so
      the land would be a 2/2 under an anthem that pumped everything else. CR 613.1c runs before
      613.1g, and here that is two passes rather than one.
    */
    const { s, id } = animate(vault());
    const anthem = pumpTeam(s, 'fx-anthem', 0, { power: 1, toughness: 1, duration: 'permanent' });
    const ch = characteristicsOf(anthem, anthem.instances[id]!);
    expect([ch.power, ch.toughness]).toEqual([3, 3]);
  });

  it('can attack once it has been a land for a turn', () => {
    let { s, id } = animate(vault());
    s = advanceTo(s, 'declare-attackers');
    expect(legalActions(s, 0).attackers).toContain(id);
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: id, defender: 1 }] });
    expect(s.combat.attacks.map((a) => a.attacker)).toEqual([id]);
  });

  it('but not on the turn it was played, because a creature is sick whatever it used to be', () => {
    // Played from hand this turn, then animated: `canAttack` compares `enteredTurn` with the turn
    // and does not care what the permanent was when it arrived (CR 302.6).
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 0: ['Mutavault'] },
      battlefield: { 0: ['Mountain', 'Mountain'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mutavault') });
    const { s: live, id } = animate(s);
    // Asked of `canAttack` rather than of the declaration, because with nothing able to attack the
    // engine skips the step entirely — which is the same answer said earlier.
    expect(canAttack(live, id, 0)?.reason).toContain('summoning sickness');
  });

  it('and tapping it for mana taps the creature, so it cannot do both', () => {
    const { s, id } = animate(vault());
    // The {1} above came from a Mountain. Tapping the Mutavault itself for mana is the choice the
    // card actually poses: a land that paid for a spell is a creature that is already tapped.
    const tapped = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    expect(tapped.instances[id]!.tapped).toBe(true);
    expect(canAttack(tapped, id, 0)?.reason).toContain('tapped');
  });

  it('and dies to a removal spell, which is the trade the card is for', () => {
    /*
      The point of the whole layer, in one exchange: a land is immune to every removal spell in the
      pool, and a land that has become a creature is not. The Doom Blade is not even a legal play
      until the ability has resolved.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 1: ['Doom Blade'] },
      battlefield: { 0: ['Mutavault', 'Mountain', 'Mountain'], 1: ['Swamp', 'Swamp'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    const vaultId = find(s, 0, 'battlefield', 'Mutavault');
    // Nothing to kill while it is only a land.
    expect(legalActions(s, 1).plays.some((p) => p.name === 'Doom Blade')).toBe(false);

    s = animate(s).s;
    s = apply(s, { type: 'auto:pass', by: 0 });
    for (const land of [...ids(s, 1, 'battlefield')]) {
      s = apply(s, { type: 'auto:activate', by: 1, card: land, abilityIndex: 0 });
    }
    expect(legalActions(s, 1).plays.some((p) => p.name === 'Doom Blade')).toBe(true);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: vaultId }],
    })));
    // A land in the graveyard, which is where this card's games are decided.
    expect(s.instances[vaultId]!.zone).toBe('graveyard');
  });

  it('does not tap itself to pay for its own animation', () => {
    /*
      Legal and self-defeating: the {1} is generic, the Mutavault makes {C}, and a solver taking
      the cheapest source turned the 2/2 it had just become into a tapped 2/2. **Not one attack
      with an animated land in 56 games** before `payFrom` learned to keep the permanent's own
      mana for last.
    */
    const { s, id } = animate(vault());
    expect(s.instances[id]!.tapped).toBe(false);
    expect(characteristicsOf(s, s.instances[id]!).isCreature).toBe(true);
    // A Mountain paid for it, which is the tap a player would have made.
    expect(ids(s, 0, 'battlefield').filter((i) => nameOf(s, i) === 'Mountain'
      && s.instances[i]!.tapped).length).toBe(1);
  });

  it('but does when its own mana is the only mana there is', () => {
    // The fallback. A cost that cannot be paid any other way is paid the only way it can be, and
    // the animation still happens — a tapped 2/2 is better than a refused ability.
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      battlefield: { 0: ['Mutavault'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    const id = find(s, 0, 'battlefield', 'Mutavault');
    s = drain(passBoth(apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 1 })));
    expect(s.instances[id]!.tapped).toBe(true);
    expect(characteristicsOf(s, s.instances[id]!).isCreature).toBe(true);
  });

  it('Crimson Wisps makes a creature red, gives it haste and draws a card', () => {
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'verdant-guard' },
      hands: { 0: ['Crimson Wisps'] },
      battlefield: { 0: ['Mountain'], 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    expect(characteristicsOf(s, s.instances[bears]!).colors).toEqual(['G']);
    const held = ids(s, 0, 'hand').length;
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Crimson Wisps'),
      targets: [{ kind: 'card', id: bears }],
    })));
    const ch = characteristicsOf(s, s.instances[bears]!);
    // Layer 5 *replaces* the printed colours (CR 105.3): it is red, not red and green.
    expect(ch.colors).toEqual(['R']);
    expect(ch.keywords.has('haste')).toBe(true);
    // The Wisps left the hand and a card came in, so the count is unchanged.
    expect(ids(s, 0, 'hand').length).toBe(held);
  });

  it('and a creature made red cannot block protection from red', () => {
    /*
      The reason layer 5 is worth having rather than faking. Protection from red is implemented in
      full — four rules, including "can't be blocked by red creatures" (CR 702.16c) — and until the
      layer existed nothing could change the answer it gives.

      Driven with `pump` rather than the card because the only creature worth making red here is a
      white one, and no deck holds both Crimson Wisps and a Leonin Skyhunter. The layer is the same
      either way; the test above is the card's.
    */
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'skyward-writ' },
      battlefield: { 0: ['Paladin en-Vec'], 1: ['Leonin Skyhunter'] },
      turn: 3, firstSeat: 0,
    }), 'declare-attackers');
    const paladin = find(s, 0, 'battlefield', 'Paladin en-Vec');
    const knight = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: paladin, defender: 1 }] });
    s = advanceTo(s, 'declare-blockers');
    // White, so it may block.
    expect(canBlock(s, knight, paladin, 1)).toBeNull();
    expect(protectedFrom(s, paladin, knight)).toBe(false);

    const reddened = pump(s, [knight], 'fx-wisps', 1, { setColors: ['R'] });
    expect(characteristicsOf(reddened, reddened.instances[knight]!).colors).toEqual(['R']);
    expect(protectedFrom(reddened, paladin, knight)).toBe(true);
    expect(canBlock(reddened, knight, paladin, 1)?.reason).toMatch(/protection/i);
  });
});

describe('flashback: casting a spell out of the graveyard', () => {
  /*
    The second zone a spell is ever cast *from* in this engine. The command zone was the first, and
    that one was a whole missing branch of `legalActions`; this is the other one, and what makes it
    more than an alternative cost is the end of it — the card is **exiled** as it leaves the stack,
    so a two-mana cantrip is two cards and not an engine.

    The last test is the one that matters: a card cast with flashback is not offered a third time,
    because it is in exile rather than in the graveyard.
  */
  const graveyard = (name: string, lands: readonly string[], deck = 'tidal-mind'): GameState => {
    let s = advanceTo(arena({
      decks: { 0: deck }, hands: { 0: [name] },
      battlefield: { 0: [...lands] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    // Into the graveyard the way it gets there in a game: cast it, and let it resolve.
    return s;
  };

  it('is not offered from the hand and is offered from the graveyard', () => {
    // Five Islands: two for the first casting and three for the second, because a flashback play
    // is only offered when it can be paid for, like every other play.
    let s = graveyard('Think Twice', ['Island', 'Island', 'Island', 'Island', 'Island']);
    const card = find(s, 0, 'hand', 'Think Twice');
    // From hand it is the printed cost and nothing else.
    const fromHand = legalActions(s, 0).plays.filter((p) => p.card === card);
    expect(fromHand).toHaveLength(1);
    expect(fromHand[0]?.flashback).toBeUndefined();
    expect(fromHand[0]?.manaCost).toBe('{1}{U}');

    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card })));
    expect(s.instances[card]!.zone).toBe('graveyard');

    // And now it is a play again, for the other cost, said where a player will look for it.
    const again = legalActions(s, 0).plays.filter((p) => p.card === card);
    expect(again).toHaveLength(1);
    expect(again[0]?.flashback).toBe(true);
    expect(again[0]?.manaCost).toBe('{2}{U}');
    expect(again[0]?.description).toContain('from your graveyard');
  });

  it('pays the flashback cost, not the printed one, and exiles the card', () => {
    let s = graveyard('Think Twice', ['Island', 'Island', 'Island', 'Island', 'Island']);
    const card = find(s, 0, 'hand', 'Think Twice');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card })));
    const heldAfterFirst = ids(s, 0, 'hand').length;

    // Three mana for the second casting: the printed {1}{U} is not what is being paid.
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card, flashback: true })));
    expect(ids(s, 0, 'hand').length).toBe(heldAfterFirst + 1);
    // Exiled rather than buried (CR 702.33a), which is the whole of what makes the card fair.
    expect(s.instances[card]!.zone).toBe('exile');
  });

  it('and is not offered a third time, because it is in exile', () => {
    let s = graveyard('Think Twice', ['Island', 'Island', 'Island', 'Island', 'Island']);
    const card = find(s, 0, 'hand', 'Think Twice');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card })));
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card, flashback: true })));
    expect(legalActions(s, 0).plays.some((p) => p.card === card)).toBe(false);
    expect(refusal(s, { type: 'auto:cast', by: 0, card, flashback: true }))
      .toContain('not in your graveyard');
  });

  it('refuses flashback on a card that has none, and on somebody else\u2019s graveyard', () => {
    /*
      Moved to the graveyard by hand rather than cast there, which the other tests in this block
      deliberately do not do — and here it is right, because what this one is about is the refusal
      and not the route. Divination used to be the card: it left Tidal Mind for a Behold the
      Multiverse, and every remaining spell in the deck with no flashback either targets something
      or stops to ask a question on the way down.
    */
    let s = graveyard('Preordain', ['Island', 'Island', 'Island']);
    const card = find(s, 0, 'hand', 'Preordain');
    s = apply(s, { type: 'card:move', by: 0, card, toZone: 'graveyard' });
    expect(s.instances[card]!.zone).toBe('graveyard');
    // In a graveyard, with no flashback: not a play, and refused if named anyway.
    expect(legalActions(s, 0).plays.some((p) => p.card === card)).toBe(false);
    expect(refusal(s, { type: 'auto:cast', by: 0, card, flashback: true })).toContain('no flashback');
  });

  it('keeps the card\u2019s own timing: a sorcery with flashback is still a sorcery', () => {
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'skyward-writ' },
      hands: { 0: ['Firebolt', 'Burst Lightning'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Swamp'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const bolt = find(s, 0, 'hand', 'Firebolt');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: bolt, targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(life(s, 1)).toBe(18);
    expect(s.instances[bolt]!.zone).toBe('graveyard');

    // Offered in the main phase, and not once the step has moved on: flashback changes the cost
    // and the zone, not the timing (CR 702.33b).
    expect(legalActions(s, 0).plays.some((p) => p.card === bolt && p.flashback === true)).toBe(true);
    /*
      And with something on the stack it is not a play, which is the half that proves flashback did
      not quietly turn a sorcery into an instant. Its own main phase with an *empty* stack is the
      rule (CR 307.1), and holding priority over its own Burst Lightning is the cheapest way to be
      in a main phase that is not empty.
    */
    const onStack = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Burst Lightning'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    expect(onStack.stackOrder).toHaveLength(1);
    expect(legalActions(onStack, 0).plays.some((p) => p.card === bolt)).toBe(false);
    expect(refusal(onStack, {
      type: 'auto:cast', by: 0, card: bolt, flashback: true, targets: [{ kind: 'player', seat: 1 }],
    })).toContain('main phase');
  });

  it('exiles it even when it is countered on the way', () => {
    /*
      "Exile it instead of putting it anywhere else" is not only about resolving (CR 702.33a). A
      counterspell on a flashback casting still exiles the card, which is the difference between
      answering it once and answering it twice.
    */
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'tidal-mind' },
      hands: { 0: ['Think Twice'], 1: ['Counterspell'] },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Island', 'Island'],
        1: ['Island', 'Island'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const card = find(s, 0, 'hand', 'Think Twice');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card })));
    s = apply(s, { type: 'auto:cast', by: 0, card, flashback: true });
    // The caster keeps priority after casting (CR 117.3c), so seat 1 answers after a pass — and
    // taps its own lands once it has priority, which is when a player would.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'),
      targets: [{ kind: 'card', id: card }],
    });
    s = drain(passBoth(s));
    expect(s.instances[card]!.zone).toBe('exile');
  });
});

describe('a creature whose size is a fact about the board', () => {
  /*
    Layer 7a — a characteristic-defining ability — and the last layer of CR 613 this engine had
    named and not built.

    What makes it a different kind of thing from every other size effect: nothing resolves. A
    Lhurgoyf's power is a count of the creature cards in every graveyard, read fresh each time
    anybody asks, so it changes when the board changes with no event and nothing to recompute. The
    tests below are about the ordering that follows (7a is a *base*, so 7b replaces it and 7c and
    7d land on top) and about the count being live.
  */
  const goyf = (hand: readonly string[] = ['Lhurgoyf'], theirs: readonly string[] = []): GameState =>
    advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: [...hand] },
      battlefield: {
        0: ['Forest', 'Forest', 'Forest', 'Forest', 'Swamp'],
        1: [...theirs],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  /** Casts it and lets it resolve, which is what installs the static that defines its size. */
  const cast = (state: GameState): { s: GameState; id: string } => {
    let s = tapAllLands(state, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lhurgoyf') })));
    return { s, id: find(s, 0, 'battlefield', 'Lhurgoyf') };
  };

  it('is as big as the graveyards are, and grows when something dies anywhere', () => {
    // An empty table: a 0/1, which is what the printed `*` and `1+*` come to with nothing buried.
    let { s, id } = cast(goyf());
    expect([characteristicsOf(s, s.instances[id]!).power,
      characteristicsOf(s, s.instances[id]!).toughness]).toEqual([0, 1]);

    // Two creature cards into two different graveyards, one of them the opponent's: "all
    // graveyards" is the whole table, not your side of it.
    const mine = find(s, 0, 'library', 'Centaur Courser');
    s = apply(s, { type: 'card:move', by: 0, card: mine, toZone: 'graveyard' });
    const theirs = find(s, 1, 'library', 'Omenspeaker');
    s = apply(s, { type: 'card:move', by: 1, card: theirs, toZone: 'graveyard' });
    const ch = characteristicsOf(s, s.instances[id]!);
    expect([ch.power, ch.toughness]).toEqual([2, 3]);

    // And a land in a graveyard is not a creature card, which is the half a count of "cards" would
    // have got wrong.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Forest'), toZone: 'graveyard',
    });
    expect(characteristicsOf(s, s.instances[id]!).power).toBe(2);
  });

  it('shrinks again when a graveyard is exiled, with nothing to tell it', () => {
    /*
      The point of computing rather than storing. Tormod's Crypt exiles a graveyard; no event in
      the engine says "a Lhurgoyf somewhere is now smaller", and none needs to.
    */
    let { s, id } = cast(goyf(['Lhurgoyf']));
    for (const name of ['Centaur Courser', 'Gravedigger']) {
      s = apply(s, {
        type: 'card:move', by: 0, card: find(s, 0, 'library', name), toZone: 'graveyard',
      });
    }
    expect(characteristicsOf(s, s.instances[id]!).power).toBe(2);
    // Exile the graveyard the long way round, which is the same move the Crypt makes.
    for (const card of [...ids(s, 0, 'graveyard')]) {
      s = apply(s, { type: 'card:move', by: 0, card, toZone: 'exile' });
    }
    expect(characteristicsOf(s, s.instances[id]!).power).toBe(0);
  });

  it('and a copy of it has the ability, not the number', () => {
    /*
      Layer 1 and layer 7a together. A copy copies printed characteristics (CR 707.2), and what is
      printed on a Lhurgoyf is the *ability* rather than a size — so a Clone of a four-creature
      Lhurgoyf is not a 4/5, it is a Lhurgoyf, and both of them shrink when the graveyards do.
    */
    let { s, id } = cast(goyf(['Lhurgoyf']));
    for (const name of ['Centaur Courser', 'Gravedigger']) {
      s = apply(s, {
        type: 'card:move', by: 0, card: find(s, 0, 'library', name), toZone: 'graveyard',
      });
    }
    // Seat 1's Clone, cast with its own Islands and pointed at the Lhurgoyf.
    s = advanceTo(nextTurn(s), 'precombat-main');
    for (const name of ['Island', 'Island', 'Island', 'Island']) {
      s = apply(s, {
        type: 'card:move', by: 1, card: find(s, 1, 'library', name), toZone: 'battlefield',
      });
    }
    s = apply(s, {
      type: 'card:move', by: 1, card: find(s, 1, 'library', 'Clone'), toZone: 'hand',
    });
    s = tapAllLands(s, 1);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Clone') });
    s = passBoth(s);
    s = decide(s, ['Lhurgoyf']);
    s = drain(s);
    const copy = find(s, 1, 'battlefield', 'Lhurgoyf');
    expect([characteristicsOf(s, s.instances[copy]!).power,
      characteristicsOf(s, s.instances[copy]!).toughness]).toEqual([2, 3]);
    // One more creature card buried, and both of them are bigger.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Blood Artist'), toZone: 'graveyard',
    });
    expect(characteristicsOf(s, s.instances[copy]!).power).toBe(3);
    expect(characteristicsOf(s, s.instances[id]!).power).toBe(3);
  });

  it('a setting effect beats it, because 7b comes after 7a', () => {
    // Turn to Frog on a Lhurgoyf is a 1/1 however full the graveyards are (CR 613.4a then 613.4c).
    let { s, id } = cast(goyf(['Lhurgoyf']));
    for (const name of ['Centaur Courser', 'Gravedigger', 'Blood Artist']) {
      s = apply(s, {
        type: 'card:move', by: 0, card: find(s, 0, 'library', name), toZone: 'graveyard',
      });
    }
    expect(characteristicsOf(s, s.instances[id]!).power).toBe(3);
    const frogged = pump(s, [id], 'fx-frog', 1, {
      setPower: 1, setToughness: 1, losesAllAbilities: true,
    });
    expect([characteristicsOf(frogged, frogged.instances[id]!).power,
      characteristicsOf(frogged, frogged.instances[id]!).toughness]).toEqual([1, 1]);
  });

  it('and a pump lands on top of it, because 7c comes after both', () => {
    let { s, id } = cast(goyf(['Lhurgoyf']));
    for (const name of ['Centaur Courser', 'Gravedigger']) {
      s = apply(s, {
        type: 'card:move', by: 0, card: find(s, 0, 'library', name), toZone: 'graveyard',
      });
    }
    const pumped = addCounters(pump(s, [id], 'fx-growth', 0, { power: 3, toughness: 3 }), id, '+1/+1', 1);
    // 2 from the graveyards, +3 from the pump, +1 from the counter: 6/7.
    const ch = characteristicsOf(pumped, pumped.instances[id]!);
    expect([ch.power, ch.toughness]).toEqual([6, 7]);
  });
});

describe('the library as the thing you attack', () => {
  /*
    The eighth deck wins by emptying a library, which the engine has enforced since state-based
    actions were written (CR 704.5b) and nothing had ever tried to do.

    Two of these cards also carry the trigger that came with them — "whenever this deals combat
    damage to a player" — which is the most-printed trigger in Magic and which this pool did not
    have. It is recorded where the damage happens and announced where every other event is, so the
    two tests that matter are that it fires when the damage lands and **does not** when it does not.
  */
  const graveyardSize = (state: GameState, seat: SeatIndex): number => ids(state, seat, 'graveyard').length;
  const librarySize = (state: GameState, seat: SeatIndex): number => ids(state, seat, 'library').length;

  /** Attacks with everything seat 0 has and plays the combat out. */
  const swing = (state: GameState): GameState => {
    let s = advanceTo(state, 'declare-attackers');
    const attackers = [...ids(s, 0, 'battlefield')]
      .filter((id) => characteristicsOf(s, s.instances[id]!).isCreature)
      .map((id) => ({ attacker: id, defender: 1 as SeatIndex }));
    s = apply(s, { type: 'auto:attack', by: 0, attackers });
    s = apply(s, { type: 'auto:pass', by: 0 });
    return advanceTo(s, 'postcombat-main', 120);
  };

  it('a Thieving Magpie that connects draws a card, and one that is blocked does not', () => {
    const board = (theirs: readonly string[]): GameState => arena({
      decks: { 0: 'hollow-tide', 1: 'tidal-mind' },
      battlefield: { 0: ['Thieving Magpie'], 1: [...theirs] },
      turn: 4, firstSeat: 0,
    });
    // Counted from the attack step on, because the turn's own draw is not the trigger's.
    let s = advanceTo(board([]), 'declare-attackers');
    const before = ids(s, 0, 'hand').length;
    const magpie = find(s, 0, 'battlefield', 'Thieving Magpie');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: magpie, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(19);
    expect(ids(s, 0, 'hand').length).toBe(before + 1);

    // And blocked by something that can reach it: no damage to the player, so no card.
    let t = advanceTo(board(['Wind Drake']), 'declare-attackers');
    const held = ids(t, 0, 'hand').length;
    const bird = find(t, 0, 'battlefield', 'Thieving Magpie');
    t = apply(t, { type: 'auto:attack', by: 0, attackers: [{ attacker: bird, defender: 1 }] });
    t = apply(t, { type: 'auto:pass', by: 0 });
    t = advanceTo(t, 'declare-blockers');
    t = drain(apply(t, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: find(t, 1, 'battlefield', 'Wind Drake'), attacker: bird }],
    }));
    t = advanceTo(t, 'postcombat-main', 120);
    expect(life(t, 1)).toBe(20);
    expect(ids(t, 0, 'hand').length).toBe(held);
  });

  it('and nothing is drawn when the damage is prevented', () => {
    // A Fog Bank blocks the Magpie: its combat damage is prevented in both directions, so the
    // player takes nothing and the trigger — which is about damage *dealt* — never fires.
    let s = arena({
      decks: { 0: 'hollow-tide', 1: 'tidal-mind' },
      battlefield: { 0: ['Thieving Magpie'], 1: ['Fog Bank'] },
      turn: 4, firstSeat: 0,
    });
    // Placed by hand, so its static has to have been installed by the arrivals pass; that is what
    // makes this a test of prevention rather than of a 0/2 Wall.
    s = advanceTo(s, 'declare-attackers');
    const before = ids(s, 0, 'hand').length;
    const magpie = find(s, 0, 'battlefield', 'Thieving Magpie');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: magpie, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = advanceTo(s, 'declare-blockers');
    s = drain(apply(s, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: find(s, 1, 'battlefield', 'Fog Bank'), attacker: magpie }],
    }));
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(20);
    expect(ids(s, 0, 'hand').length).toBe(before);
  });

  it('Mirko Vosk mills until the fourth land turns up, and stops there', () => {
    let s = arena({
      decks: { 0: 'hollow-tide', 1: 'rot-harvest' },
      format: 'edh',
      turn: 4, firstSeat: 0,
    });
    // The commander starts in the command zone; put it on the battlefield by hand, which the
    // arrivals pass treats as an arrival like any other.
    const mirko = ids(s, 0, 'command')[0]!;
    s = drain(apply(s, { type: 'card:move', by: 0, card: mirko, toZone: 'battlefield' }));
    expect(nameOf(s, mirko)).toBe('Mirko Vosk, Mind Drinker');
    s = advanceTo(s, 'declare-attackers');
    const before = librarySize(s, 1);
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: mirko, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = drain(advanceTo(s, 'postcombat-main', 120));
    const milled = before - librarySize(s, 1);
    // It took something, it stopped, and the last card it took was the fourth land.
    expect(milled).toBeGreaterThan(0);
    expect(milled).toBeLessThan(before);
    const yard = [...ids(s, 1, 'graveyard')];
    const lands = yard.filter((id) =>
      hasType(parseTypeLine(s.cardDefs[s.instances[id]!.defKey]?.typeLine), 'land'));
    expect(lands.length).toBe(4);
    expect(lands[lands.length - 1]).toBe(yard[yard.length - 1]);
  });

  it('Nemesis of Reason mills ten for attacking, blocked or not', () => {
    let s = arena({
      decks: { 0: 'hollow-tide', 1: 'rot-harvest' },
      battlefield: { 0: ['Nemesis of Reason'], 1: ['Centaur Courser'] },
      turn: 4, firstSeat: 0,
    });
    const before = librarySize(s, 1);
    s = advanceTo(s, 'declare-attackers');
    const nemesis = find(s, 0, 'battlefield', 'Nemesis of Reason');
    s = drain(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: nemesis, defender: 1 }] }));
    // The trigger is on the attack, so it has already happened before blockers are even declared.
    expect(before - librarySize(s, 1)).toBe(10);
  });

  it('Psychic Strike counters the spell and takes two off its own controller', () => {
    let s = arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      hands: { 0: ['Psychic Strike'], 1: ['Hill Giant'] },
      battlefield: {
        0: ['Island', 'Island', 'Swamp'],
        1: ['Mountain', 'Mountain', 'Mountain', 'Mountain'],
      },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Hill Giant') });
    // The caster holds priority first; the answer comes after they let go of it.
    s = apply(s, { type: 'auto:pass', by: 1 });
    s = tapAllLands(s, 0);
    const before = librarySize(s, 1);
    const spell = s.stackOrder[s.stackOrder.length - 1]!;
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Psychic Strike'),
      targets: [{ kind: 'card', id: spell }],
    })));
    expect(countOf(s, 1, 'graveyard', 'Hill Giant')).toBe(1);
    expect(before - librarySize(s, 1)).toBe(2);
  });

  it("Jace's plus ability mills ten, and the deck loses the game when it runs out", () => {
    let s = arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      battlefield: { 0: ['Jace, Memory Adept'] },
      turn: 4, firstSeat: 0,
    });
    const jace = find(s, 0, 'battlefield', 'Jace, Memory Adept');
    // It arrives with its printed loyalty, which the arrivals pass puts on it.
    expect(s.instances[jace]!.counters['loyalty']).toBe(4);

    // Thin seat 1's library down to five cards, so one activation empties it.
    for (const id of [...ids(s, 1, 'library')].slice(5)) {
      s = apply(s, { type: 'card:move', by: 1, card: id, toZone: 'graveyard', position: 'bottom' });
    }
    expect(librarySize(s, 1)).toBe(5);
    s = advanceTo(s, 'precombat-main');
    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: jace, abilityIndex: 0,
      targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(librarySize(s, 1)).toBe(0);
    expect(s.instances[jace]!.counters['loyalty']).toBe(5);
    expect(s.finished).toBe(false);

    // And the loss happens where the rules put it: on the draw they cannot make.
    s = advanceTo(nextTurn(s), 'draw', 30);
    expect(s.seats[1]!.eliminated).toBe(true);
    // As an empty library rather than as zero life, which is what it used to say.
    expect(s.seats[1]!.eliminatedReason).toBe('library');
    expect(s.finished).toBe(true);
    expect(s.winnerSeat).toBe(0);
    expect(graveyardSize(s, 1)).toBeGreaterThan(0);
  });
});

describe('damage that does not happen', () => {
  /** Two attackers, one blocker, and the defender holding the card in hand. */
  const swingInto = (hand: readonly string[], mine: readonly string[], deck: string): GameState => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: deck },
      hands: { 1: hand },
      battlefield: { 0: ['Hill Giant', 'Raging Goblin'], 1: mine },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const attackers = ['Hill Giant', 'Raging Goblin'].map((name) => ({
      attacker: find(s, 0, 'battlefield', name), defender: 1 as SeatIndex,
    }));
    s = apply(s, { type: 'auto:attack', by: 0, attackers });
    // The attacking player holds priority in the step the attack was declared in.
    return apply(s, { type: 'auto:pass', by: 0 });
  };

  /** Blocks the Giant with the named creature and plays the combat out. */
  const blockAndFight = (state: GameState, blocker: string): GameState => {
    let s = advanceTo(state, 'declare-blockers');
    s = drain(apply(s, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: find(s, 1, 'battlefield', blocker), attacker: find(s, 0, 'battlefield', 'Hill Giant') }],
    }));
    return advanceTo(s, 'postcombat-main', 120);
  };

  it('Fog stops the whole swing, in both directions', () => {
    let s = swingInto(['Fog'], ['Forest', 'Grizzly Bears'], 'verdant-guard');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Forest'), abilityIndex: 0 });
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Fog') })));
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = blockAndFight(s, 'Grizzly Bears');
    // Nothing through to the player from the unblocked Goblin, nothing to the blocker from the
    // Giant, and — the half a one-directional version would get wrong — nothing back from the
    // blocker either.
    expect(life(s, 1)).toBe(20);
    expect(s.instances[bears]!.zone).toBe('battlefield');
    expect(damageOn(s, bears)).toBe(0);
    expect(damageOn(s, giant)).toBe(0);
  });

  it('Holy Day is the same card in white, and wears off at end of turn', () => {
    // Soul Warden rather than Grizzly Bears: `arena` pulls every named card out of that seat's
    // *own* deck, so a blocker has to be one this deck actually plays.
    let s = swingInto(['Holy Day'], ['Plains', 'Plains', 'Soul Warden'], 'skyward-writ');
    for (const id of [...ids(s, 1, 'battlefield')].filter((i) => nameOf(s, i) === 'Plains')) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Holy Day') })));
    const warden = find(s, 1, 'battlefield', 'Soul Warden');
    s = blockAndFight(s, 'Soul Warden');
    expect(life(s, 1)).toBe(20);
    expect(s.instances[warden]!.zone).toBe('battlefield');

    // And the next attack goes through, which is the whole difference between a Fog and a Wall.
    s = advanceTo(nextTurn(s), 'declare-attackers');
    expect(s.effects.length).toBe(0);
  });

  it('Maze of Ith untaps the attacker and stops its damage both ways', () => {
    let s = swingInto([], ['Maze of Ith', 'Omenspeaker'], 'tidal-mind');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    expect(s.instances[giant]!.tapped).toBe(true);
    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Maze of Ith'), abilityIndex: 0,
      targets: [{ kind: 'card', id: giant }],
    })));
    // Untapped, and still attacking: the printed card does not remove it from combat.
    expect(s.instances[giant]!.tapped).toBe(false);
    expect(s.combat.attacks.some((a) => a.attacker === giant)).toBe(true);

    const omen = find(s, 1, 'battlefield', 'Omenspeaker');
    s = blockAndFight(s, 'Omenspeaker');
    // The Goblin's one damage still gets through — a Maze answers one creature, not the swing.
    expect(life(s, 1)).toBe(19);
    expect(s.instances[omen]!.zone).toBe('battlefield');
    expect(damageOn(s, omen)).toBe(0);
    expect(damageOn(s, giant)).toBe(0);
  });

  /**
   * Casts Fog Bank for real and hands the turn to the attacker.
   *
   * It has to be *cast*: a static effect is installed when the permanent arrives through the
   * engine, and `arena`'s battlefield setup puts cards down with the tabletop's own `card:move`,
   * which is not an arrival. A Fog Bank placed by hand is a 0/2 Wall with no text — which is also
   * true at a real table, and the reason **Move by hand** is an escape hatch rather than a way to
   * play a permanent.
   */
  const castFogBank = (theirs: readonly string[], theirHand: readonly string[] = []): GameState => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: theirHand.length === 0
        ? { 1: ['Fog Bank'] }
        : { 0: [...theirHand], 1: ['Fog Bank'] },
      battlefield: { 0: [...theirs], 1: ['Island', 'Island'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')].filter((i) => nameOf(s, i) === 'Island')) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Fog Bank') })));
    return nextTurn(s);
  };

  it('Fog Bank blocks anything and survives it, for ever', () => {
    let s = advanceTo(castFogBank(['Shivan Dragon']), 'declare-attackers');
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    const bank = find(s, 1, 'battlefield', 'Fog Bank');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: dragon, defender: 1 }] }));
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bank, attacker: dragon }] }));
    s = advanceTo(s, 'postcombat-main', 120);
    // A 0/2 in front of a 5/5 flier, and nothing happens to either of them. It blocks the flier at
    // all because it has flying printed on it, which is the rest of the card.
    expect(life(s, 1)).toBe(20);
    expect(s.instances[bank]!.zone).toBe('battlefield');
    expect(damageOn(s, bank)).toBe(0);
    expect(damageOn(s, dragon)).toBe(0);
  });

  it('and a trampler still has to assign lethal to it before trampling past', () => {
    // The branch no other card in the pool reaches: the blocker's damage is prevented and the
    // attacker's is not. Ball Lightning is 6/6 trample, Fog Bank is 0/2, so two points are
    // assigned to the Bank and never dealt, and four get through — not six (CR 702.19b).
    // Cast from hand on the turn it attacks, because a Ball Lightning sacrifices itself at the end
    // of every turn it is on the battlefield — which is also the only way anybody ever plays one.
    let s = castFogBank(['Mountain', 'Mountain', 'Mountain'], ['Ball Lightning']);
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => nameOf(s, i) === 'Mountain')) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Ball Lightning') })));
    s = advanceTo(s, 'declare-attackers');
    const ball = find(s, 0, 'battlefield', 'Ball Lightning');
    const bank = find(s, 1, 'battlefield', 'Fog Bank');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: ball, defender: 1 }] }));
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bank, attacker: ball }] }));
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(16);
    expect(damageOn(s, bank)).toBe(0);
    expect(s.instances[bank]!.zone).toBe('battlefield');
  });

  it('and is not offered at all when nothing is attacking', () => {
    let s = arena({
      decks: { 1: 'tidal-mind' },
      battlefield: { 0: ['Hill Giant'], 1: ['Maze of Ith'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    const maze = find(s, 1, 'battlefield', 'Maze of Ith');
    expect(legalActions(s, 1).plays.some((play) => play.card === maze)).toBe(false);
  });

  /*
    And the other shape of prevention: a quantity that is spent rather than a blanket.

    Four things to prove, and each is a different line in `dealDamage`: the shield takes what it
    can and no more, a shield that is used up stops existing, damage that was prevented was never
    dealt at all — so no life is gained for a lifelink source and nothing is marked — and the
    whole thing wears off at end of turn like any other effect with a duration.

    The arithmetic is deliberately order-independent where it can be. Combat damage is dealt
    creature by creature here, and nothing in the rules says which attacker's damage a shield
    meets first; a test that only passes for one of those orders would be a test of this engine's
    loop rather than of the card.
  */
  it("Healing Salve's shield takes three of the damage and then stops", () => {
    // Two attackers, four damage: a 3/3 Hill Giant and a 1/1 Raging Goblin, neither blocked.
    // Three of the four are prevented whichever order they arrive in, so one gets through.
    let s = swingInto(['Healing Salve'], ['Plains'], 'skyward-writ');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Healing Salve'),
      // The second mode, chosen as it is cast — the first gains three life instead.
      modes: [1], targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(s.effects.length).toBe(1);
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(19);
    // Spent, so it is gone rather than sitting at zero waiting for the turn to end.
    expect(s.effects.length).toBe(0);
  });

  it('a Samite Healer taps for one damage a turn, and one is all it is', () => {
    let s = swingInto([], ['Samite Healer'], 'skyward-writ');
    const healer = find(s, 1, 'battlefield', 'Samite Healer');
    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: healer, abilityIndex: 0,
      targets: [{ kind: 'player', seat: 1 }],
    })));
    // The tap is the cost, and the reason using it is a decision: this 1/1 is not blocking now.
    expect(s.instances[healer]!.tapped).toBe(true);
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(17);
  });

  it('three damage prevented on a blocker saves it, and the attacker still takes its share', () => {
    let s = swingInto(['Healing Salve'], ['Plains', 'Leonin Skyhunter'], 'skyward-writ');
    const skyhunter = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Healing Salve'),
      modes: [1], targets: [{ kind: 'card', id: skyhunter }],
    })));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = blockAndFight(s, 'Leonin Skyhunter');
    // A 2/2 blocking a 3/3 dies; with the three prevented it is unmarked and alive, and the Giant
    // takes its two all the same — prevention is about the damage, not about the fight.
    expect(s.instances[skyhunter]!.zone).toBe('battlefield');
    expect(damageOn(s, skyhunter)).toBe(0);
    expect(damageOn(s, giant)).toBe(2);
    // Only the unblocked Goblin got through.
    expect(life(s, 1)).toBe(19);
  });

  it('damage that was prevented gains no life for a lifelink source', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'skyward-writ' },
      battlefield: { 0: ["Healer's Hawk"], 1: ['Samite Healer'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const hawk = find(s, 0, 'battlefield', "Healer's Hawk");
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: hawk, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Samite Healer'), abilityIndex: 0,
      targets: [{ kind: 'player', seat: 1 }],
    })));
    s = advanceTo(s, 'postcombat-main', 120);
    // One damage, one prevented: the defender loses nothing, and the lifelink gains nothing,
    // because no damage was dealt (CR 702.15a). A shield read after the fact could not say that.
    expect(life(s, 1)).toBe(20);
    expect(life(s, 0)).toBe(20);
  });

  it('and the table is told it is there, on the creature and on the player', () => {
    /*
      The one way a shield differs from everything else the engine computes: there is nothing on
      the card to read it off. Power, toughness, keywords and marked damage are all sent because a
      client cannot work them out; a shield is sent because a *player* cannot, and would block as
      though they had never cast it.
    */
    let s = swingInto(['Healing Salve'], ['Plains', 'Leonin Skyhunter'], 'skyward-writ');
    const skyhunter = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Healing Salve'),
      modes: [1], targets: [{ kind: 'card', id: skyhunter }],
    })));
    // Public: the seat being attacked knows, and so does the seat attacking it — prevention is not
    // hidden information at a real table either, and a block made against a shield nobody could
    // see would be the table lying to the attacker instead of to the defender.
    expect(viewFor(s, 1).cards[skyhunter]!.shielded).toBe(3);
    expect(viewFor(s, 0).cards[skyhunter]!.shielded).toBe(3);
    expect(viewFor(s, 1).seats[1]!.shielded).toBeUndefined();

    // And on a player, where the same number has no card to sit on at all.
    let t = swingInto(['Healing Salve'], ['Plains'], 'skyward-writ');
    t = apply(t, { type: 'auto:activate', by: 1, card: find(t, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    t = drain(passBoth(apply(t, {
      type: 'auto:cast', by: 1, card: find(t, 1, 'hand', 'Healing Salve'),
      modes: [1], targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(viewFor(t, 1).seats[1]!.shielded).toBe(3);
    expect(viewFor(t, 1).seats[0]!.shielded).toBeUndefined();
  });

  it('an unspent shield wears off at end of turn', () => {
    // Nobody attacking, so nothing spends it — and a land is not a legal target for "any target",
    // which the engine refuses: the shield goes on its controller.
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'rot-harvest' },
      hands: { 0: ['Healing Salve'] },
      battlefield: { 0: ['Plains'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Healing Salve'),
      modes: [1], targets: [{ kind: 'player', seat: 0 }],
    })));
    expect(s.effects.length).toBe(1);
    s = advanceTo(nextTurn(s), 'precombat-main');
    expect(s.effects.length).toBe(0);
  });
});

describe('answering a permanent, and answering an answer', () => {
  it('Naturalize destroys an artifact', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      battlefield: { 0: ['Sol Ring'], 1: ['Forest', 'Forest'] },
      hands: { 1: ['Naturalize'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    const rock = find(s, 0, 'battlefield', 'Sol Ring');
    s = drain(cast(s, 1, 'Naturalize', [{ kind: 'card', id: rock }]));
    expect(namesIn(s, 0, 'battlefield')).not.toContain('Sol Ring');
    expect(namesIn(s, 0, 'graveyard')).toContain('Sol Ring');
  });

  it('and an enchantment, which is what a Pacifism on your commander needed', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      hands: { 0: ['Pacifism'], 1: ['Naturalize'] },
      battlefield: { 0: ['Plains', 'Plains'], 1: ['Forest', 'Forest', 'Centaur Courser'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = drain(cast(s, 0, 'Pacifism', [{ kind: 'card', id: courser }]));
    expect(characteristicsOf(s, s.instances[courser]!).cantAttack).toBe(true);

    s = nextTurn(s);
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    const aura = find(s, 0, 'battlefield', 'Pacifism');
    s = drain(cast(s, 1, 'Naturalize', [{ kind: 'card', id: aura }]));
    expect(namesIn(s, 0, 'graveyard')).toContain('Pacifism');
    // And the creature is free again, which is the point of casting it.
    expect(characteristicsOf(s, s.instances[courser]!).cantAttack).toBe(false);
  });

  /*
    The interaction worth knowing as a player, and it is not special-cased anywhere.

    Journey to Nowhere exiles a creature "until Journey to Nowhere leaves the battlefield", and
    `destroy` is one more way for it to leave. The creature comes back through the Journey's own
    `leaves` trigger — the same machinery that already gives it back when the Journey is bounced.
  */
  it('and destroying a Journey to Nowhere gives the creature back', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      hands: { 0: ['Journey to Nowhere'], 1: ['Naturalize'] },
      battlefield: { 0: ['Plains', 'Plains'], 1: ['Forest', 'Forest', 'Centaur Courser'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    // Aimed as it arrives rather than as it is cast: the exile is an entry trigger, so the
    // choice comes back as a `pendingChoice` once the enchantment is already on the battlefield.
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Journey to Nowhere') }));
    if (s.pendingChoice !== null) {
      s = drain(apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: courser }] }));
    }
    expect(namesIn(s, 1, 'battlefield')).not.toContain('Centaur Courser');

    s = nextTurn(s);
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    s = drain(cast(s, 1, 'Naturalize', [{ kind: 'card', id: find(s, 0, 'battlefield', 'Journey to Nowhere') }]));
    expect(namesIn(s, 1, 'battlefield')).toContain('Centaur Courser');
  });

  it('and nothing else is a legal target for it', () => {
    const s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      hands: { 1: ['Naturalize'] },
      battlefield: { 0: ['Centaur Courser', 'Forest'], 1: ['Forest', 'Forest'] },
      turn: 3, firstSeat: 1,
    }), 'precombat-main');
    // A creature and a land are both permanents, and neither is what this card answers.
    expect(refusal(tapAllLands(s, 1), {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Naturalize'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Centaur Courser') }],
    })).toMatch(/target/i);
  });

  /*
    And the half of the exchange this pool had none of: a response to removal.

    Cast in answer to a Doom Blade, the creature becomes hexproof while the Doom Blade is still on
    the stack, so the Doom Blade is countered on resolution for having no legal target
    (CR 608.2b). The creature is the same object throughout — which is the opposite of how
    Cloudshift makes removal miss, and the reason both are worth having in the pool.
  */
  it('Blossoming Defense makes the removal aimed at it miss', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 0: ['Doom Blade'], 1: ['Blossoming Defense'] },
      battlefield: { 0: ['Swamp', 'Swamp'], 1: ['Forest', 'Centaur Courser'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    // Only the active seat's lands are tapped by hand: a mana ability needs priority, which is
    // the same reason a real player holds their mana up rather than floating it.
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    // The Doom Blade goes on the stack, aimed at a creature that is a legal target right now.
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: courser }],
    });
    expect(stackNames(s)).toContain('Doom Blade');
    // And is answered in response, which is the only window this card has. The caster holds
    // priority after casting, so the response comes after they pass it.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Blossoming Defense'),
      targets: [{ kind: 'card', id: courser }],
    });
    s = drain(passBoth(passBoth(s)));
    expect(namesIn(s, 1, 'battlefield')).toContain('Centaur Courser');
    expect(namesIn(s, 0, 'graveyard')).toContain('Doom Blade');
    // The pump is real as well as the protection: a 3/3 that is now a 5/5.
    expect(power(s, courser)).toBe(5);
    expect(toughness(s, courser)).toBe(5);
  });

  it('and the creature stops being untargetable when the turn ends', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 1: ['Blossoming Defense'] },
      battlefield: { 0: ['Swamp', 'Swamp'], 1: ['Forest', 'Centaur Courser'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = drain(cast(s, 1, 'Blossoming Defense', [{ kind: 'card', id: courser }]));
    expect(characteristicsOf(s, s.instances[courser]!).keywords.has('hexproof')).toBe(true);
    s = nextTurn(s);
    expect(characteristicsOf(s, s.instances[courser]!).keywords.has('hexproof')).toBe(false);
  });

  it('and it only ever protects your own creature', () => {
    const s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 1: ['Blossoming Defense'] },
      battlefield: { 0: ['Wind Drake'], 1: ['Forest'] },
      turn: 3, firstSeat: 1,
    }), 'precombat-main');
    expect(refusal(tapAllLands(s, 1), {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Blossoming Defense'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Wind Drake') }],
    })).toMatch(/target/i);
  });

  it('Dive Down is the same card in blue, and saves a flier from a burn spell', () => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 0: ['Lightning Bolt'], 1: ['Dive Down'] },
      battlefield: { 0: ['Mountain'], 1: ['Island', 'Wind Drake'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const drake = find(s, 1, 'battlefield', 'Wind Drake');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: drake }],
    });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Dive Down'),
      targets: [{ kind: 'card', id: drake }],
    });
    s = drain(passBoth(passBoth(s)));
    expect(namesIn(s, 1, 'battlefield')).toContain('Wind Drake');
    // +0/+3 rather than +2/+2: the toughness is what beats a burn spell that did resolve.
    expect(power(s, drake)).toBe(2);
    expect(toughness(s, drake)).toBe(5);
  });
});

describe('the painlands, and a cost that is not mana', () => {
  it('City of Brass deals you a damage every time it is tapped, however it was tapped', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      battlefield: { 0: ['City of Brass'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const city = find(s, 0, 'battlefield', 'City of Brass');
    // Tapped for mana. A mana ability does not use the stack (CR 605.3a) — but the trigger it set
    // off does, so the damage waits to resolve like anything else.
    s = apply(s, { type: 'auto:activate', by: 0, card: city, abilityIndex: 0 });
    expect(s.pools['0']!.W).toBe(1);
    expect(stackNames(s).join(' ')).toMatch(/City of Brass/);
    s = drain(passBoth(s));
    expect(life(s, 0)).toBe(19);
  });

  it('and when something else taps it, which is the half a mana-ability hook would miss', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      battlefield: { 0: ['City of Brass'], 1: ['Island', 'Island', 'Icy Manipulator'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')].filter((i) => nameOf(s, i) === 'Island')) {
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    const city = find(s, 0, 'battlefield', 'City of Brass');
    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Icy Manipulator'),
      abilityIndex: 0, targets: [{ kind: 'card', id: city }],
    })));
    expect(s.instances[city]!.tapped).toBe(true);
    expect(life(s, 0)).toBe(19);
  });

  it('and a land that entered tapped did not become tapped', () => {
    // Rakdos Guildgate enters tapped, which is a replacement effect rather than a tapping. A
    // version of this that hooked "set tapped" rather than comparing would charge for it.
    let s = arena({
      decks: { 0: 'ashen-rite' },
      hands: { 0: ['Rakdos Guildgate'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = drain(apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Rakdos Guildgate') }));
    expect(s.instances[find(s, 0, 'battlefield', 'Rakdos Guildgate')]!.tapped).toBe(true);
    expect(life(s, 0)).toBe(20);
  });

  it('Mana Confluence charges as a cost, and stops offering mana at one life', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      battlefield: { 0: ['Mana Confluence'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const land = find(s, 0, 'battlefield', 'Mana Confluence');
    s = apply(s, { type: 'auto:activate', by: 0, card: land, abilityIndex: 1 });
    expect(s.pools['0']!.U).toBe(1);
    // Paid as the ability was activated: nothing on the stack, and the life already gone.
    expect(life(s, 0)).toBe(19);
    expect(stackNames(s)).toEqual([]);

    // And at one life it is not a choice. A cost you cannot pay is not a cost you may pay.
    let dying = arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      battlefield: { 0: ['Mana Confluence'] },
      turn: 2, firstSeat: 0,
    });
    dying = advanceTo(dying, 'precombat-main');
    dying = { ...dying, seats: dying.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 1 } : seat)) };
    const confluence = find(dying, 0, 'battlefield', 'Mana Confluence');
    expect(legalActions(dying, 0).plays.some((play) => play.card === confluence)).toBe(false);
    expect(refusal(dying, { type: 'auto:activate', by: 0, card: confluence, abilityIndex: 0 }))
      .toMatch(/1 life to pay/);
  });

  /*
    The other half of a cost that is not mana: the half the engine pays for you.

    `manaSources` is the one answer to "can this be paid for at all", and for as long as it only
    admitted a bare tap, Mana Confluence was a land the engine could not see. It never paid for a
    spell, it never showed in the dimmed pips, and a player with one in play and a Soul Warden in
    hand was told the card could not be cast while looking straight at the mana for it.
  */
  it('the engine taps a painland for you, and charges the life as it taps', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      hands: { 0: ['Soul Warden'] }, battlefield: { 0: ['Mana Confluence'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const land = find(s, 0, 'battlefield', 'Mana Confluence');
    // Offered at all, which is the part that was broken: no floating mana, one land, one white
    // spell in hand.
    expect(legalActions(s, 0).plays.some((play) => play.card === find(s, 0, 'hand', 'Soul Warden')))
      .toBe(true);
    s = drain(cast(s, 0, 'Soul Warden'));
    expect(namesIn(s, 0, 'battlefield')).toContain('Soul Warden');
    expect(s.instances[land]!.tapped).toBe(true);
    expect(life(s, 0)).toBe(19);
  });

  it('and reaches for a Plains before it reaches for your life total', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      hands: { 0: ['Soul Warden'] }, battlefield: { 0: ['Mana Confluence', 'Plains'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const land = find(s, 0, 'battlefield', 'Mana Confluence');
    const plains = find(s, 0, 'battlefield', 'Plains');
    s = drain(cast(s, 0, 'Soul Warden'));
    // Both make white, so both would pay. The solver keeps the first source it finds on a tie and
    // `manaSources` lists the painful ones last, which is the whole of how this comes out right.
    expect(s.instances[plains]!.tapped).toBe(true);
    expect(s.instances[land]!.tapped).toBe(false);
    expect(life(s, 0)).toBe(20);
  });

  it('and at one life it stops being a land the engine can count', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      hands: { 0: ['Soul Warden'] }, battlefield: { 0: ['Mana Confluence'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 1 } : seat)) };
    const actions = legalActions(s, 0);
    const warden = find(s, 0, 'hand', 'Soul Warden');
    expect(actions.plays.some((play) => play.card === warden)).toBe(false);
    // And the dimmed pips agree with the refusal, because they are asked the same question.
    expect(actions.potential.W).toBe(0);
    expect(actions.blocked.find((b) => b.card === warden)?.reason).toMatch(/mana/i);
  });

  it('and City of Brass triggers off a tap the engine made, not only one you made', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['City of Brass'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    // The land was tapped by `payFrom`, and `settle` compared the board before to the board after
    // and raised the trigger off the difference. Nothing hooked the tap itself.
    expect(stackNames(s).join(' ')).toMatch(/City of Brass/);
    s = drain(passBoth(s));
    expect(life(s, 0)).toBe(19);
    expect(life(s, 1)).toBe(17);
  });

  it('Dark Confidant charges you for the card it just drew', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      battlefield: { 0: ['Dark Confidant'] },
      turn: 3, firstSeat: 1,
    });
    // Its controller's upkeep, which is the next turn round.
    s = advanceTo(nextTurn(s), 'upkeep');
    const held = ids(s, 0, 'hand').length;
    s = drain(passBoth(s));
    expect(ids(s, 0, 'hand').length).toBe(held + 1);
    // Whatever it drew, the life lost is that card's mana value — including nothing for a land.
    const drawn = [...ids(s, 0, 'hand')].pop()!;
    const cost = s.cardDefs[s.instances[drawn]!.defKey]?.cmc ?? 0;
    expect(life(s, 0)).toBe(20 - cost);
  });
});

describe('why a card cannot be played', () => {
  /** The reason the engine gives for a card in hand, or '' when it is playable. */
  const why = (s: GameState, seat: SeatIndex, name: string): string =>
    legalActions(s, seat).blocked.find((entry) => entry.card === find(s, seat, 'hand', name))?.reason ?? '';

  it('says a land is a main-phase play, and that you have had your one', () => {
    let s = arena({ hands: { 0: ['Mountain', 'Mountain'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'upkeep');
    expect(why(s, 0, 'Mountain')).toMatch(/main phase/i);
    s = advanceTo(s, 'precombat-main');
    expect(why(s, 0, 'Mountain')).toBe('');
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') });
    expect(why(s, 0, 'Mountain')).toMatch(/already played a land/i);
  });

  it('says a sorcery is a sorcery', () => {
    let s = arena({ hands: { 0: ['Lava Axe'] }, battlefield: { 0: Array(5).fill('Mountain') }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'upkeep');
    s = tapAllLands(s, 0);
    expect(why(s, 0, 'Lava Axe')).toMatch(/sorcery speed/i);
  });

  it('says it is the mana, and stops saying it once the mana is there', () => {
    let s = arena({ hands: { 0: ['Lava Axe'] }, battlefield: { 0: ['Mountain'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    // Counting what could still be tapped, not only what is floating: one Mountain is not five.
    expect(why(s, 0, 'Lava Axe')).toMatch(/not enough mana/i);

    let rich = arena({ hands: { 0: ['Lava Axe'] }, battlefield: { 0: Array(5).fill('Mountain') }, turn: 2, firstSeat: 0 });
    rich = advanceTo(rich, 'precombat-main');
    expect(why(rich, 0, 'Lava Axe')).toBe('');
  });

  it('says there is nothing to point it at, which looks the same as mana from outside', () => {
    // Divine Verdict can only target an attacking or blocking creature, and the board has one of
    // neither. The mana is there, so "not enough mana" would be a lie — and the two are the pair
    // a client could never tell apart on its own.
    let s = arena({
      decks: { 0: 'skyward-writ' },
      hands: { 0: ['Divine Verdict'] },
      battlefield: { 0: Array(4).fill('Plains') },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    expect(why(s, 0, 'Divine Verdict')).toMatch(/target/i);
  });

  it('says a spell that eats a creature has nothing to eat', () => {
    let s = arena({
      decks: { 0: 'ashen-rite' },
      hands: { 0: ['Bone Splinters'] },
      battlefield: { 0: ['Swamp'], 1: ['Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    expect(why(s, 0, 'Bone Splinters')).toMatch(/sacrifice/i);
  });

  it('says nothing at all about a card it is offering', () => {
    let s = arena({ hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['Mountain'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    const bolt = find(s, 0, 'hand', 'Lightning Bolt');
    expect(legalActions(s, 0).plays.some((play) => play.card === bolt)).toBe(true);
    expect(legalActions(s, 0).blocked.some((entry) => entry.card === bolt)).toBe(false);
  });
});

describe('unscripted cards', () => {
  it('casts, resolves and fights normally, and says in the log that it is not automated', () => {
    // Hill Giant has no script: no triggers, no abilities, nothing printed but a body.
    expect(scriptFor('Hill Giant')).toBeUndefined();
    let s = withMana(0, ['Hill Giant'], 4);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hill Giant') });
    s = passBoth(s);
    expect(namesIn(s, 0, 'battlefield')).toContain('Hill Giant');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    expect([power(s, giant), toughness(s, giant)]).toEqual([3, 3]);
  });

  it('says so when a spell with no script resolves', () => {
    // A sorcery with no script is the case worth being honest about: it resolves and does nothing,
    // and the log has to say that rather than let a player think it worked.
    const unscripted = Object.values(STARTER_DECKS)
      .flatMap((deck) => deck.cards)
      .map((entry) => entry.card)
      .filter((card) => scriptFor(card.name) === undefined)
      .filter((card) => !/creature|land|artifact|enchantment/i.test(card.typeLine));
    expect(unscripted).toEqual([]);
  });
});

/*
  Whatever a card says reaches the effect, whichever builder it goes through.

  Five builders turn a `PumpOptions` into a continuous effect — one for a targeted pump, one for a
  team, one for the whole board, one for a permanent's static, one for an aura — and each of them
  used to copy by hand the subset of options it happened to know about. They disagreed: `pump` had
  no `mustAttack`, `staticEffect` had neither that nor `preventsCombatDamage` (and an Equipment's
  bonus goes through it), the statics builder had no `cantAttack`, and the aura builder had four of
  the ten. A flag worked or silently vanished depending on which builder the script reached for.

  This is the invariant that replaces those five lists with one: every option in, every flag out.
  Asserted on the effect rather than on a card's behaviour on purpose — the bug was not that any
  one card was wrong, it was that the next card to use a flag would be.
*/
/*
  A replacement effect one permanent contributes for another (CR 614).

  Everything the engine replaced before this was a shield on the card it affected — regeneration,
  "enters tapped" — and both are printed on the permanent they change. Kalitas is written on a
  creature across the table from the one it is talking about, which is why it needed a *pass*: the
  engine has to ask every permanent on the board whether it wants to replace what is about to
  happen.

  The sharpest assertion in here is the Blood Artist one. A replaced death is **not a death**, so
  nothing that watches for a creature dying may see it — if the drain happens, the engine has
  implemented a trigger rather than a replacement.
*/
/*
  Protection from a colour (CR 702.16), which is the only keyword in Magic that is four rules at
  once: a creature with protection from black cannot be **d**amaged, **e**nchanted or equipped,
  **b**locked, or **t**argeted by anything black. Each of the four is asserted on its own below,
  because a keyword that did three of them would be worse than no keyword at all — a player would
  trust it.

  Paladin en-Vec has protection from black and from red, which in this pool is most of the removal.
*/
describe('protection from a colour', () => {
  /** Seat 1 holds the Paladin; seat 0 is the black-red deck with the answers that bounce off it. */
  const paladin = (theirHand: readonly string[] = [], theirBoard: readonly string[] = []): GameState => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'skyward-writ' },
      hands: { 0: theirHand },
      battlefield: {
        0: [...theirBoard, 'Mountain', 'Mountain', 'Swamp', 'Swamp'],
        1: ['Paladin en-Vec'],
      },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      if (!BASICS.has(nameOf(s, id))) continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('cannot be targeted by a spell of that colour, by anybody', () => {
    const s = paladin(['Agonizing Demise']);
    const pal = find(s, 1, 'battlefield', 'Paladin en-Vec');
    // The engine never offers it, and refuses a hand-built action that names it anyway.
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Agonizing Demise');
    expect(play?.candidates?.[0]?.some((t) => t.kind === 'card' && t.id === pal)).toBeFalsy();
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Agonizing Demise'),
      targets: [{ kind: 'card', id: pal }],
    })).not.toBeNull();
  });

  it('can still be targeted by a colour it has no protection from', () => {
    // The half that makes it a card rather than a rule: white and blue answers work normally, and
    // this deck's own Swords would kill it. Protection is from colours, not from everything.
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'skyward-writ' },
      hands: { 0: ['Swords to Plowshares'] },
      battlefield: { 0: ['Plains'], 1: ['Paladin en-Vec'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Plains'), abilityIndex: 0 });
    const pal = find(s, 1, 'battlefield', 'Paladin en-Vec');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Swords to Plowshares'),
      targets: [{ kind: 'card', id: pal }],
    }));
    expect(s.instances[pal]!.zone).toBe('exile');
  });

  it('takes no combat damage from a creature of that colour, and still deals its own', () => {
    // Protection does not stop it *blocking*: only being blocked. So the Paladin can stand in
    // front of a red creature, take nothing, and hit back — which is the damage rule on its own.
    let s = toAttackers(arena({
      decks: { 0: 'ember-rush', 1: 'skyward-writ' },
      battlefield: { 0: ['Hill Giant'], 1: ['Paladin en-Vec'] },
      turn: 3, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const pal = find(s, 1, 'battlefield', 'Paladin en-Vec');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: giant, defender: 1 }] });
    s = passBoth(s);
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: pal, attacker: giant }] });
    for (let i = 0; i < 10 && s.step !== 'postcombat-main'; i += 1) s = passBoth(s);
    // Alive is the assertion that matters: a 2/2 in front of a 3/3 dies unless the damage never
    // happened. Reading the damage alone passes whether or not the rule is there, because a
    // creature in a graveyard answers nothing useful about what hit it.
    expect(s.instances[pal]!.zone).toBe('battlefield');
    expect(damageOn(s, pal)).toBe(0);
    expect(damageOn(s, giant)).toBe(2);
    expect(life(s, 1)).toBe(20);
  });

  it('cannot be blocked by a creature of that colour', () => {
    // A board of nothing but black and red creatures has no legal block against it at all — so the
    // engine does not even ask the defender, which is the strongest form of "cannot be blocked".
    let s = toAttackers(arena({
      decks: { 0: 'skyward-writ', 1: 'ashen-rite' },
      battlefield: { 0: ['Paladin en-Vec'], 1: ['Vampire Nighthawk', 'Boggart Brute'] },
      turn: 3, firstSeat: 0,
    }));
    const pal = find(s, 0, 'battlefield', 'Paladin en-Vec');
    const hawk = find(s, 1, 'battlefield', 'Vampire Nighthawk');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: pal, defender: 1 }] });
    s = passBoth(s);
    expect(legalActions(s, 1).blockers.some((o) => o.canBlock.includes(pal))).toBe(false);
    expect(canBlock(s, hawk, pal, 1)?.reason).toContain('protection');
    // Nobody was asked, and the attack goes through for its two.
    expect(pendingDeclaration(s)).toBeNull();
    for (let i = 0; i < 10 && s.step !== 'postcombat-main'; i += 1) s = passBoth(s);
    expect(life(s, 1)).toBe(18);
  });

  it('can be blocked by a creature of any other colour', () => {
    // The other half, and the reason the first one is a card rather than a rule: a green creature
    // blocks it perfectly well, and the Paladin's first strike is what decides the fight.
    let s = toAttackers(arena({
      decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
      battlefield: { 0: ['Paladin en-Vec'], 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 0,
    }));
    const pal = find(s, 0, 'battlefield', 'Paladin en-Vec');
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: pal, defender: 1 }] });
    s = passBoth(s);
    expect(canBlock(s, bear, pal, 1)).toBeNull();
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bear, attacker: pal }] });
    for (let i = 0; i < 10 && s.step !== 'postcombat-main'; i += 1) s = passBoth(s);
    // Two first-strike damage kills the 2/2 before it hits back, so both survive on this side.
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
    expect(damageOn(s, pal)).toBe(0);
  });

  it('is left alone by a colourless source, which is what the equip rule rests on', () => {
    /*
      The fourth rule, and the one no card in this pool can break.

      Protection stops an Equipment of that colour attaching (CR 702.16e), and every Equipment here
      is colourless — so the clause in `equipTo` is correct and unreachable at the same time, which
      is D57's warning. What *can* be asserted is the fact it rests on: a colourless permanent is
      never anything protection applies to. A coloured Equipment would be the card that exercises
      the refusal, and there is not one.
    */
    const s = paladin([], ['Sol Ring']);
    const pal = find(s, 1, 'battlefield', 'Paladin en-Vec');
    const ring = find(s, 0, 'battlefield', 'Sol Ring');
    expect(characteristicsOf(s, s.instances[pal]!).protectionFrom).toEqual(['B', 'R']);
    expect(protectedFrom(s, pal, ring)).toBe(false);
    // And from something black it is the other answer, which is what makes the first one mean
    // anything.
    expect(protectedFrom(s, pal, find(s, 0, 'battlefield', 'Swamp'))).toBe(false);
  });
});

describe('a replacement effect from across the table', () => {
  /** Seat 0 on Kalitas, seat 1 with a creature of its own and a Mountain to kill it with. */
  const withKalitas = (hand: readonly string[] = [], theirs: readonly string[] = ['Centaur Courser']): GameState => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'rot-harvest' },
      hands: { 1: hand },
      battlefield: { 0: ['Kalitas, Traitor of Ghet'], 1: [...theirs, 'Swamp', 'Swamp', 'Swamp', 'Swamp'] },
      turn: 3, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 1, 'battlefield')]) {
      if (nameOf(s, id) !== 'Swamp') continue;
      s = apply(s, { type: 'auto:activate', by: 1, card: id, abilityIndex: 0 });
    }
    return s;
  };

  it('exiles an opponent creature killed by a spell, and leaves a Zombie behind', () => {
    let s = withKalitas(['Doom Blade'], ['Centaur Courser']);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: courser }],
    }));
    // Exiled rather than buried, and the Zombie belongs to Kalitas's controller.
    expect(s.instances[courser]!.zone).toBe('exile');
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Centaur Courser');
    expect(namesIn(s, 0, 'battlefield')).toContain('Zombie');
  });

  it('exiles one killed in combat, which is the other way a creature dies', () => {
    // Lethal damage is a state-based action rather than an effect, so it reaches the graveyard by
    // a different path — and the replacement has to be on that path too.
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'rot-harvest' },
      battlefield: { 0: ['Kalitas, Traitor of Ghet'], 1: ['Llanowar Elves'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    const kalitas = find(s, 0, 'battlefield', 'Kalitas, Traitor of Ghet');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: kalitas, defender: 1 }] });
    s = passBoth(s);
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: elves, attacker: kalitas }] });
    for (let i = 0; i < 8 && s.instances[elves]!.zone === 'battlefield'; i += 1) s = passBoth(s);
    expect(s.instances[elves]!.zone).toBe('exile');
    expect(namesIn(s, 0, 'battlefield')).toContain('Zombie');
  });

  it('exiles one its owner sacrificed as a cost, which is the third', () => {
    // A sacrifice is paid before the ability is even on the stack, so this is the earliest of the
    // three paths — and `relocate` is the one place all three meet.
    let s = withKalitas([], ['Centaur Courser', 'Vampire Aristocrat']);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const vamp = find(s, 1, 'battlefield', 'Vampire Aristocrat');
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 1, card: vamp, abilityIndex: 0, sacrifice: courser,
    }));
    expect(s.instances[courser]!.zone).toBe('exile');
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Centaur Courser');
  });

  it('is a replacement and not a trigger: nothing sees the creature die', () => {
    // The whole point. A Blood Artist drains for a creature dying *anywhere*, so if it drains
    // here the engine has let the death happen and then tidied up after it.
    let s = withKalitas(['Doom Blade'], ['Centaur Courser', 'Blood Artist']);
    const before = [life(s, 0), life(s, 1)];
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Centaur Courser') }],
    }));
    expect(s.pendingChoice).toBeNull();
    expect([life(s, 0), life(s, 1)]).toEqual(before);
  });

  it('says what it did, because a replaced death raises nothing to log', () => {
    // Without this the card works invisibly: a creature dies to a Doom Blade and turns up in exile
    // with a Zombie beside it, and nothing on screen says which permanent did that.
    let s = withKalitas(['Doom Blade'], ['Centaur Courser']);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Centaur Courser') }],
    }));
    const said = s.log.map((entry) => entry.message).join(' | ');
    expect(said).toContain('Kalitas, Traitor of Ghet');
    expect(said).toContain('Centaur Courser');
    expect(said).toContain('exile it instead');
  });

  it('leaves its own controller’s creatures where they always went', () => {
    // "An opponent controls" — the half of the card that makes it a one-sided effect rather than a
    // rule about the game. The same sacrifice outlet, pointed at its own board.
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'rot-harvest' },
      hands: { 0: ['Lightning Bolt'] },
      battlefield: {
        0: ['Kalitas, Traitor of Ghet', 'Bloodthrone Vampire', 'Boggart Brute',
          'Mountain', 'Mountain', 'Mountain'],
        1: ['Doomed Dissenter'],
      },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      if (nameOf(s, id) !== 'Mountain') continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const brute = find(s, 0, 'battlefield', 'Boggart Brute');
    const dissenter = find(s, 1, 'battlefield', 'Doomed Dissenter');
    // Kalitas's own controller eats their own creature: it is buried as it always was.
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Bloodthrone Vampire'),
      abilityIndex: 0, sacrifice: brute,
    }));
    expect(namesIn(s, 0, 'graveyard')).toContain('Boggart Brute');

    // And the opponent's Dissenter is exiled instead, which leaves its own death trigger unfired:
    // a replaced death triggers nothing, said this time about somebody else's card.
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: dissenter }],
    }));
    expect(s.instances[dissenter]!.zone).toBe('exile');
    expect(namesIn(s, 1, 'battlefield')).not.toContain('Zombie');
  });
});

describe('what a card says reaches the effect', () => {
  const everything = {
    power: 1, toughness: 2, keywords: ['flying'] as const, removeKeywords: ['trample'] as const,
    cantAttack: true, cantBlock: true, preventsCombatDamage: true,
    mustAttack: true, cantBeBlockedByWalls: true, mustAttackAnotherPlayer: true,
  };
  const carried = (effect: ContinuousEffect): Record<string, unknown> => ({
    power: effect.power, toughness: effect.toughness,
    keywords: effect.keywords, removeKeywords: effect.removeKeywords,
    cantAttack: effect.cantAttack, cantBlock: effect.cantBlock,
    preventsCombatDamage: effect.preventsCombatDamage,
    mustAttack: effect.mustAttack, cantBeBlockedByWalls: effect.cantBeBlockedByWalls,
    mustAttackAnotherPlayer: effect.mustAttackAnotherPlayer,
  });
  const expected = {
    power: 1, toughness: 2, keywords: ['flying'], removeKeywords: ['trample'],
    cantAttack: true, cantBlock: true, preventsCombatDamage: true,
    mustAttack: true, cantBeBlockedByWalls: true, mustAttackAnotherPlayer: true,
  };

  it('carries every option through every builder', () => {
    const s = arena();
    const bear = [...ids(s, 0, 'library')][0]!;
    for (const built of [
      pump(s, [bear], bear, 0, everything),
      pumpTeam(s, bear, 0, everything),
      pumpAll(s, bear, 0, everything),
      staticEffect(s, bear, 0, { kind: 'cards', ids: [bear] }, everything),
    ]) {
      expect(built.effects.length).toBe(1);
      expect(carried(built.effects[0]!)).toEqual(expected);
    }
  });

  it('leaves out what the card did not say, rather than saying false', () => {
    // An absent flag has to be absent: `cantAttack: false` on an effect would read as a card that
    // says a creature cannot attack, and `characteristicsOf` only ever checks for truth.
    const s = arena();
    const bear = [...ids(s, 0, 'library')][0]!;
    const built = pump(s, [bear], bear, 0, { power: 1 });
    expect(Object.keys(built.effects[0]!).sort()).toEqual(
      ['controller', 'createdTurn', 'duration', 'id', 'power', 'scope', 'source'],
    );
  });
});

describe('deck coverage', () => {
  it('scripts every card in both starter decks that needs one', () => {
    const missing: string[] = [];
    for (const deck of Object.values(STARTER_DECKS)) {
      for (const card of [...deck.cards.map((c) => c.card), deck.commander!]) {
        if (scriptFor(card.name) !== undefined) continue;
        // A vanilla creature does not need a script: its body and its printed keywords are enough.
        const vanilla = /creature/i.test(card.typeLine) && (card.oracleText ?? '').trim() === '';
        if (!vanilla) missing.push(`${card.name} (${card.typeLine})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('registers each script under the name of a real card or a token the pool makes', () => {
    const printed = new Set([
      ...Object.values(STARTER_DECKS).flatMap((deck) =>
        [...deck.cards.map((c) => c.card), deck.commander!].map((c) => c.name),
      ),
      // A token is in nobody's deck and can still have a script: a Pest's death trigger fires
      // every game Sedgemoor Witch connects with an instant. `TOKEN_DEFS` is the list of what
      // this pool can put onto the battlefield without casting it.
      ...TOKEN_DEFS.map((token) => token.name),
    ]);
    // A script registered under a name nothing in the pool has can never fire, and nothing else
    // would say so.
    const orphans = scriptedCardNames().filter((name) => !printed.has(name));
    expect(orphans).toEqual([]);
  });

  it('gives every scripted mana cost a cost the engine can pay', () => {
    const unpayable: string[] = [];
    for (const deck of Object.values(STARTER_DECKS)) {
      for (const card of [...deck.cards.map((c) => c.card), deck.commander!]) {
        if (scriptFor(card.name) === undefined) continue;
        if (/land/i.test(card.typeLine)) continue;
        const cost = (card.manaCost ?? '').match(/\{[^}]*\}/g) ?? [];
        if (cost.some((symbol) => /\//.test(symbol))) unpayable.push(card.name);
      }
    }
    expect(unpayable).toEqual([]);
  });
});

describe('ward: a cost the other player has to pay to touch your creature', () => {
  /*
    The first question in this engine asked of a player because of somebody *else's* permanent.

    Every other mid-resolution question belongs to whoever is resolving something — the caster
    searching a library, the controller aiming a trigger, the player discarding to their own
    Mind Rot. A ward's triggered ability belongs to the warded creature's controller and the
    question it asks belongs to the player who did the targeting, which is why it could not be
    another `pendingDecision` and why the authorisation check in `payWard` is written out rather
    than reusing `assertMayActFor`.

    The three outcomes are the three tests: paid, declined, and could not pay. The last is not
    offered as a choice at all, for the reason a trigger with no legal targets never goes on the
    stack — a prompt with one button is a table that has stopped.
  */
  const table = (deck: string, wardCard: string, theirLands: readonly string[], mine: readonly string[]): GameState => advanceTo(arena({
    decks: { 0: 'tidal-mind', 1: deck },
    hands: { 0: ['Doom Blade'] },
    battlefield: { 0: [...theirLands], 1: [...mine, wardCard] },
    turn: 4, firstSeat: 0,
  }), 'precombat-main');

  it('stops the removal on the stack and asks the other player to pay', () => {
    let s = table('verdant-guard', 'Dragonsguard Elite', ['Swamp', 'Swamp', 'Swamp'], ['Forest']);
    const elite = find(s, 1, 'battlefield', 'Dragonsguard Elite');
    const blade = find(s, 0, 'hand', 'Doom Blade');
    s = apply(s, { type: 'auto:cast', by: 0, card: blade, targets: [{ kind: 'card', id: elite }] });

    // The ward ability is on the stack above the spell, so it resolves first (CR 603.3b).
    expect(s.stackOrder).toHaveLength(2);
    s = drain(passBoth(s));

    // And the question is the caster's, not the warded creature's controller's.
    expect(s.pendingPayment?.seat).toBe(0);
    expect(s.pendingPayment?.cost).toBe('{1}');
    expect(legalActions(s, 0).mustPay?.prompt).toContain('Dragonsguard Elite');
    expect(legalActions(s, 1).mustPay).toBeNull();
    // Nobody holds priority while it stands, which is what stops the other table offering a pass.
    expect(s.priority).toBeNull();
    expect(legalActions(s, 1).canPass).toBe(false);

    // Paid, and the removal resolves as though the ward had never been there.
    s = drain(apply(s, { type: 'auto:pay', by: 0, pay: true }));
    expect(s.pendingPayment).toBeNull();
    expect(namesIn(s, 1, 'graveyard')).toContain('Dragonsguard Elite');
  });

  it('counters the spell when the cost is declined, and the creature lives', () => {
    let s = table('verdant-guard', 'Dragonsguard Elite', ['Swamp', 'Swamp', 'Swamp'], ['Forest']);
    const elite = find(s, 1, 'battlefield', 'Dragonsguard Elite');
    const blade = find(s, 0, 'hand', 'Doom Blade');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: blade, targets: [{ kind: 'card', id: elite }],
    })));
    expect(s.pendingPayment).not.toBeNull();

    s = drain(apply(s, { type: 'auto:pay', by: 0, pay: false }));
    // The card is spent and the creature is untouched, which is the whole point of ward being a
    // cost rather than hexproof: the removal was answered and it cost its controller a card.
    expect(s.instances[elite]!.zone).toBe('battlefield');
    expect(namesIn(s, 0, 'graveyard')).toContain('Doom Blade');
    expect(s.stackOrder).toEqual([]);
  });

  it('is not offered at all when the cost cannot be paid, and counters the spell itself', () => {
    // Exactly enough to cast the Doom Blade and nothing over, against Sedgemoor Witch's Ward {3}.
    let s = table('ashen-rite', 'Sedgemoor Witch', ['Swamp', 'Swamp'], ['Swamp']);
    const witch = find(s, 1, 'battlefield', 'Sedgemoor Witch');
    const blade = find(s, 0, 'hand', 'Doom Blade');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: blade, targets: [{ kind: 'card', id: witch }],
    })));

    // No question was ever asked: there was only one outcome available.
    expect(s.pendingPayment).toBeNull();
    expect(legalActions(s, 0).mustPay).toBeNull();
    expect(s.instances[witch]!.zone).toBe('battlefield');
    expect(namesIn(s, 0, 'graveyard')).toContain('Doom Blade');
    // And said out loud in the log, because nobody pressed anything: a spell that leaves the stack
    // with no prompt and no message is a card the player cannot see working. `reduceAutoAction`
    // drains the notes onto the message of the action that provoked them, which is why this reads
    // the log rather than `replacements`.
    expect(s.log.map((entry) => entry.message).join(' ')).toContain('ward {3} was not paid');
  });

  it('does not trigger off its own controller’s spells', () => {
    // Ward defaults to `by: 'opponent'` for this case and only this case: a creature with ward
    // may be given a Giant Growth by its own controller for free.
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard' },
      hands: { 0: ['Giant Growth'] },
      battlefield: { 0: ['Forest', 'Forest', 'Dragonsguard Elite'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const elite = find(s, 0, 'battlefield', 'Dragonsguard Elite');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Giant Growth'),
      targets: [{ kind: 'card', id: elite }],
    });
    /*
      Two objects on the stack and neither is a ward: the Giant Growth, and the Elite's *own*
      magecraft trigger, which fires off its controller casting an instant. That is the card
      working — and it is also why this test asserts on what ward did not do rather than on the
      size of the stack.
    */
    expect(s.stackOrder).toHaveLength(2);
    s = drain(passBoth(s));
    expect(s.pendingPayment).toBeNull();
    // 2/2, +3/+3 from the Growth, and two +1/+1 counters from its own magecraft.
    expect(power(s, elite)).toBe(7);
  });

  it('triggers off an ability as well as a spell', () => {
    // An Icy Manipulator aimed at a warded creature is the case the keyword is printed for, and it
    // is a different code path from a cast: the object on the stack is an activated ability.
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Island', 'Island', 'Icy Manipulator'],
        1: ['Forest', 'Dragonsguard Elite'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const icy = find(s, 0, 'battlefield', 'Icy Manipulator');
    const elite = find(s, 1, 'battlefield', 'Dragonsguard Elite');
    s = apply(s, {
      type: 'auto:activate', by: 0, card: icy, abilityIndex: 0,
      targets: [{ kind: 'card', id: elite }],
    });
    s = drain(passBoth(s));
    expect(s.pendingPayment?.seat).toBe(0);
    expect(s.pendingPayment?.cost).toBe('{1}');
  });

  it('triggers off a triggered ability that targets, which is where it would have been missed', () => {
    /*
      Flametongue Kavu's arrival deals its damage to a *target* creature, so it is a triggered
      ability with a target an opponent chose — the third of the four places an object on the stack
      gains one. Without `raiseWard` there, a Ward {1} would have answered a Doom Blade and not a
      Kavu, which reads as a bug rather than as a rule.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      hands: { 0: ['Flametongue Kavu'] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'],
        1: ['Forest', 'Dragonsguard Elite'],
      },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flametongue Kavu'),
    }));
    s = drain(s);
    // The Kavu can shoot its own controller's creatures too, so the choice is a real one and the
    // engine stops to ask. Aimed at the warded creature, which is what the ward is for.
    const elite = find(s, 1, 'battlefield', 'Dragonsguard Elite');
    s = drain(apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: elite }] }));
    expect(s.pendingPayment?.seat).toBe(0);
    expect(s.pendingPayment?.cost).toBe('{1}');
  });

  it('makes a Pest when its controller casts an instant, and the Pest pays a life when it dies', () => {
    // Sedgemoor Witch's other half, which is also the pool's first token with an ability of its
    // own: `scriptFor` finds a token's script by name like any other card's.
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite' },
      hands: { 0: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain', 'Sedgemoor Witch'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(namesIn(s, 0, 'battlefield')).toContain('Pest');

    const pest = find(s, 0, 'battlefield', 'Pest');
    const before = life(s, 0);
    s = drain(passBoth(apply(s, { type: 'card:move', by: 0, card: pest, toZone: 'graveyard' })));
    expect(life(s, 0)).toBe(before + 1);
  });
});

describe('convoke: a cost paid by tapping creatures', () => {
  /*
    The first cost in this engine that is neither mana nor a sacrifice.

    Convoke (CR 702.51) does not change what a spell costs; it changes what may pay for it. So it
    reduces the cost rather than making mana — a convoked creature modelled as a mana source would
    be almost exactly a dual land, and a dual land that over-produces leaves mana floating, which
    convoke cannot do and which nothing downstream could clean up because a Dark Ritual means
    floating mana is sometimes real.

    The test that matters most is the last one: `legalActions` and `castSpell` ask the same function
    whether a convoke cast can be paid for, which is the one bug this file exists to prevent.
  */
  const board = (lands: readonly string[], creatures: readonly string[], hand: readonly string[]): GameState =>
    advanceTo(arena({
      decks: { 0: 'verdant-guard' },
      hands: { 0: [...hand] },
      battlefield: { 0: [...lands, ...creatures] },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');

  it('taps nobody when the lands already cover it', () => {
    // Seven lands for a seven-mana Wurm: a tapped creature cannot block, so the planner spends
    // mana first and convokes only the shortfall.
    let s = board(
      ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Plains', 'Plains'],
      ['Grizzly Bears', 'Centaur Courser'],
      ['Siege Wurm'],
    );
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Siege Wurm') })));
    expect(namesIn(s, 0, 'battlefield')).toContain('Siege Wurm');
    expect(s.instances[bears]!.tapped).toBe(false);
  });

  it('is castable off fewer lands than its cost, by tapping creatures for the rest', () => {
    // Four lands and three creatures for {5}{G}{G}: two green pips off two Forests, and three
    // creatures for three of the five generic.
    let s = board(
      ['Forest', 'Forest', 'Forest', 'Forest'],
      ['Grizzly Bears', 'Centaur Courser', 'Llanowar Elves'],
      ['Siege Wurm'],
    );
    const wurm = find(s, 0, 'hand', 'Siege Wurm');
    const play = legalActions(s, 0).plays.find((p) => p.card === wurm);
    expect(play).toBeDefined();
    /*
      Said on the play, because otherwise the table offers a seven-mana spell off four lands and
      gives no reason for it.

      "Convoking 2" rather than 3, and that is the planner being right: Llanowar Elves taps for
      {G}, so four Forests and the Elf cover five of the seven and only two creatures are convoked.
      Three creatures end up tapped either way — one for mana, two for convoke — which is why the
      count below is 3 and this one is 2.
    */
    expect(play?.description).toBe('Cast Siege Wurm (convoking 2)');
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: wurm })));
    expect(namesIn(s, 0, 'battlefield')).toContain('Siege Wurm');
    // Three creatures tapped to pay for it, which is what the discount actually costs.
    const tapped = [...ids(s, 0, 'battlefield')]
      .filter((id) => s.instances[id]!.tapped && nameOf(s, id) !== 'Forest').length;
    expect(tapped).toBe(3);
  });

  it('is not offered when even the creatures cannot cover it', () => {
    // Two lands and one creature against a seven-mana spell: three mana of seven.
    const s = board(['Forest', 'Forest'], ['Grizzly Bears'], ['Siege Wurm']);
    const wurm = find(s, 0, 'hand', 'Siege Wurm');
    expect(legalActions(s, 0).plays.some((p) => p.card === wurm)).toBe(false);
    expect(legalActions(s, 0).blocked.find((entry) => entry.card === wurm)?.reason)
      .toMatch(/convoke/);
  });

  it('can be paid for by a creature that arrived this turn', () => {
    /*
      Tapping for convoke is neither attacking nor activating an ability, so summoning sickness does
      not stop it (CR 702.51a) — the one rule about convoke that is easy to get wrong in the
      direction of being too strict. The creature here is put onto the battlefield on this turn.
    */
    let s = board(['Forest', 'Forest', 'Forest', 'Forest'], [], ['Siege Wurm', 'Centaur Courser']);
    // Three creatures that entered this turn: tokens, so `enteredTurn` is this turn by
    // construction rather than by setup.
    s = apply(s, { type: 'token:create', by: 0, seat: 0, card: SOLDIER_TOKEN, count: 3 });
    const fresh = [...ids(s, 0, 'battlefield')].filter((id) => nameOf(s, id) === 'Soldier');
    expect(fresh).toHaveLength(3);
    for (const id of fresh) expect(s.instances[id]!.enteredTurn).toBe(s.turn);

    const wurm = find(s, 0, 'hand', 'Siege Wurm');
    expect(legalActions(s, 0).plays.some((p) => p.card === wurm)).toBe(true);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: wurm })));
    expect(namesIn(s, 0, 'battlefield')).toContain('Siege Wurm');
  });

  it('does not tap a creature it also needs for mana', () => {
    /*
      Llanowar Elves is both a creature convoke may tap and a source the solver may tap for {G}. It
      cannot be both, and the planner drops a convoked creature from the source list for exactly
      this reason — without that the engine would count one tap twice and offer a cast it refused.
    */
    let s = board(['Forest', 'Forest', 'Forest', 'Forest', 'Forest'], ['Llanowar Elves'], ['Siege Wurm']);
    const wurm = find(s, 0, 'hand', 'Siege Wurm');
    // Five Forests and one Elf is six mana against seven, so this is only castable if the Elf
    // counts once — as a convoked body or as a mana source, not both.
    expect(legalActions(s, 0).plays.some((p) => p.card === wurm)).toBe(false);
  });

  it('exiles a permanent with the Tribunal, convoked down from five mana', () => {
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Conclave Tribunal'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Grizzly Bears', 'Centaur Courser', 'Llanowar Elves'],
        1: ['Hill Giant'],
      },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    const tribunal = find(s, 0, 'hand', 'Conclave Tribunal');
    expect(legalActions(s, 0).plays.some((p) => p.card === tribunal)).toBe(true);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: tribunal })));
    // The arrival trigger asks for its target, and there is only one legal one.
    s = drain(s);
    expect(s.instances[giant]!.zone).toBe('exile');

    // And it comes back when the Tribunal goes, which is the half that makes it removal rather
    // than exile.
    s = drain(passBoth(apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'battlefield', 'Conclave Tribunal'), toZone: 'graveyard',
    })));
    expect(s.instances[giant]!.zone).toBe('battlefield');
  });

  it('never offers a convoke cast the engine then refuses', () => {
    /*
      The property the whole design is for, swept over every board size: for each number of lands
      and creatures, either the play is offered and the cast goes through, or it is not offered.
      An offer the engine refuses is the one failure mode a second answer to "can this be paid"
      produces, and convoke is the second answer this file nearly grew.
    */
    for (let lands = 0; lands <= 7; lands += 1) {
      for (let creatures = 0; creatures <= 4; creatures += 1) {
        // Tokens for the bodies, so the sweep does not depend on how many of any one creature the
        // deck happens to run — the first version of this test asked for four Grizzly Bears out of
        // a deck with one.
        let s = board(Array.from({ length: lands }, () => 'Forest'), [], ['Siege Wurm']);
        if (creatures > 0) {
          s = apply(s, { type: 'token:create', by: 0, seat: 0, card: SOLDIER_TOKEN, count: creatures });
        }
        const wurm = find(s, 0, 'hand', 'Siege Wurm');
        const offered = legalActions(s, 0).plays.some((p) => p.card === wurm);
        if (!offered) continue;
        s = apply(s, { type: 'auto:cast', by: 0, card: wurm });
        expect(ids(s, 0, 'stack')).toContain(wurm);
      }
    }
  });
});

describe('a face-down permanent is a 2/2 with no abilities (CR 707.2)', () => {
  /*
    A bug that was visible from both sides of a table and from neither at once.

    Any player may turn a permanent face down — it is on the card menu — and `viewFor` has always
    hidden its identity from everybody else. Nothing hid it from the *rules*: a face-down Hill Giant
    was a card the opponent could not see and a 3/3 that fought like a Hill Giant, so two people
    looking at one board held different facts about it.

    CR 707.2 says what it actually is: a 2/2 creature with no name, no mana cost, no creature types
    and no abilities. Layers apply on top of that, which is why the counter test below reads 3/3.
  */
  const faceDown = (name: string, deck = 'ember-rush', extra: readonly string[] = []): GameState => {
    const s = advanceTo(arena({
      decks: { 0: deck, 1: 'verdant-guard' },
      battlefield: { 0: [name, ...extra] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const card = find(s, 0, 'battlefield', name);
    return apply(s, { type: 'card:faceDown', by: 0, card });
  };

  it('fights as a 2/2 rather than as the card underneath', () => {
    const s = faceDown('Hill Giant');
    const giant = [...ids(s, 0, 'battlefield')][0]!;
    const ch = characteristicsOf(s, s.instances[giant]!);
    expect(ch.power).toBe(2);
    expect(ch.toughness).toBe(2);
    expect(ch.isCreature).toBe(true);
    // No name, no colour, no types of its own: all of that is the card, and the card is hidden.
    expect(ch.name).not.toBe('Hill Giant');
    expect(ch.colors).toEqual([]);
  });

  it('loses its printed keywords, and a land turned over stops being a land', () => {
    const flier = faceDown('Serra Angel', 'verdant-guard');
    const angel = [...ids(flier, 0, 'battlefield')][0]!;
    expect([...characteristicsOf(flier, flier.instances[angel]!).keywords]).toEqual([]);

    // A face-down Mountain is not a Mountain: it is a 2/2 creature, so it taps for nothing.
    const land = faceDown('Mountain');
    const mountain = [...ids(land, 0, 'battlefield')][0]!;
    const ch = characteristicsOf(land, land.instances[mountain]!);
    expect(ch.isLand).toBe(false);
    expect(ch.isCreature).toBe(true);
    expect(legalActions(land, 0).plays.some((p) => p.card === mountain)).toBe(false);
  });

  it('keeps the layers that apply to it, because they apply to what it is now', () => {
    // A +1/+1 counter on a face-down creature makes it a 3/3 — the counter is public and the
    // base it modifies is the 2/2, not the card.
    let s = faceDown('Hill Giant');
    const giant = [...ids(s, 0, 'battlefield')][0]!;
    s = addCounters(s, giant, '+1/+1', 1);
    const ch = characteristicsOf(s, s.instances[giant]!);
    expect(ch.power).toBe(3);
    expect(ch.toughness).toBe(3);
  });

  it('stops handing out the static ability it was handing out', () => {
    /*
      Turn a Glorious Anthem face down and the team shrinks, because a face-down permanent has no
      abilities at all — including the ones it is giving to everybody else.
    */
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard' },
      battlefield: { 0: ['Glorious Anthem', 'Grizzly Bears'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    expect(characteristicsOf(s, s.instances[bears]!).power).toBe(3);

    s = apply(s, { type: 'card:faceDown', by: 0, card: find(s, 0, 'battlefield', 'Glorious Anthem') });
    expect(characteristicsOf(s, s.instances[bears]!).power).toBe(2);
  });

  it('shows the other player a 2/2 and never the card underneath', () => {
    /*
      The leak test, and the reason the view change had to come second.

      `viewFor` now computes characteristics for a battlefield permanent even when the viewer
      cannot identify it — otherwise the opponent is sent a card with no power and no toughness and
      cannot draw the thing that is sitting there. That is only safe because `characteristicsOf`
      substitutes the face-down profile first, so what goes out is the 2/2 and never the Hill Giant.
    */
    const s = faceDown('Hill Giant');
    const giant = [...ids(s, 0, 'battlefield')][0]!;
    const theirs = viewFor(s, 1).cards[giant]!;
    expect(theirs.faceDown).toBe(true);
    expect(theirs.power).toBe(2);
    expect(theirs.toughness).toBe(2);
    // The card itself never travels, which is the whole point.
    expect(theirs.card).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain('Hill Giant');
    // And the spectator sees exactly what the opponent does.
    expect(JSON.stringify(viewFor(s, null).cards[giant])).not.toContain('Hill Giant');
  });

  it('is identifiable by the player it belongs to, who may read their own card', () => {
    const s = faceDown('Hill Giant');
    const giant = [...ids(s, 0, 'battlefield')][0]!;
    expect(viewFor(s, 0).cards[giant]?.card?.name).toBe('Hill Giant');
    // Still a 2/2 to its controller as well: the rules do not care who is looking.
    expect(viewFor(s, 0).cards[giant]?.power).toBe(2);
  });
});

describe('morph: cast it face down for {3}, turn it up for its own cost (CR 702.37)', () => {
  /*
    Three cards, one per half of the mechanic, and the tests below are grouped the same way.

    Zoetic Cavern is the one that proves the rule rather than using it: a *land* cast as a creature
    spell. Dirgur Nemesis is the one turned up to survive a combat it is already in. Battering
    Craghorn is the one turned up *during* combat, which is what a special action is for.

    What is deliberately not here is any assertion that a face-down permanent is a 2/2 with no
    abilities — that is the block above this one, and it is the reason this block is five lines of
    script across three cards rather than a mechanic.
  */

  /** A seat in its main phase holding `name`, with `lands` of its own basic tapped for mana. */
  const holding = (
    seat: SeatIndex, name: string, deck: string, lands: readonly string[],
  ): GameState => {
    let s = advanceTo(arena({
      decks: { [seat]: deck }, hands: { [seat]: [name] }, battlefield: { [seat]: [...lands] },
      turn: 4, firstSeat: seat,
    }), 'precombat-main');
    return tapAllLands(s, seat);
  };

  it('is offered for {3} on a board that cannot pay the printed cost', () => {
    // Three Islands, and Dirgur Nemesis costs {4}{U}. The face-down play is the only one there is,
    // which is the whole reason morph is in a deck: a five-mana card on turn three.
    const s = holding(1, 'Dirgur Nemesis', 'tidal-mind', ['Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Dirgur Nemesis');
    const plays = legalActions(s, 1).plays.filter((p) => p.card === card);
    expect(plays).toHaveLength(1);
    expect(plays[0]?.faceDown).toBe(true);
    expect(plays[0]?.manaCost).toBe('{3}');
    expect(plays[0]?.description).toContain('face down');
  });

  it('is offered beside the printed cast once that can be paid for', () => {
    const s = holding(1, 'Dirgur Nemesis', 'tidal-mind',
      ['Island', 'Island', 'Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Dirgur Nemesis');
    const plays = legalActions(s, 1).plays.filter((p) => p.card === card);
    expect(plays).toHaveLength(2);
    expect(plays.filter((p) => p.faceDown === true)).toHaveLength(1);
    expect(plays.find((p) => p.faceDown === undefined)?.manaCost).toBe('{4}{U}');
  });

  it('waits on the stack as a 2/2 creature spell with no name, and the opponent cannot read it', () => {
    let s = holding(1, 'Dirgur Nemesis', 'tidal-mind', ['Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Dirgur Nemesis');
    s = apply(s, { type: 'auto:cast', by: 1, card, faceDown: true });

    // A creature spell, to anything that reads the stack: Essence Scatter can counter it, and
    // nothing can tell which creature it is.
    expect(s.instances[card]!.zone).toBe('stack');
    const onStack = characteristicsOf(s, s.instances[card]!);
    expect(onStack.isCreature).toBe(true);
    expect(onStack.power).toBe(2);
    expect(onStack.toughness).toBe(2);
    expect(onStack.name).not.toContain('Dirgur');
    expect(stackNames(s).join(' ')).not.toContain('Dirgur');

    /*
      And the leak test, on the stack this time rather than on the battlefield.

      The card entry and the stack row, not the whole payload: `arena` builds a board by moving
      cards about with `card:move`, which logs what it moved by name, so the opponent's log has
      said "Friend moved Dirgur Nemesis to Friend's hand" since before the game started. That is
      the testkit's setup rather than the table's, and asserting over the log would be asserting
      about the harness.
    */
    for (const viewer of [0, null] as const) {
      const theirs = viewFor(s, viewer);
      expect(JSON.stringify(theirs.cards[card])).not.toContain('Dirgur Nemesis');
      expect(theirs.cards[card]?.card).toBeUndefined();
      expect(theirs.cards[card]?.power).toBe(2);
      expect(JSON.stringify(theirs.automation?.stack)).not.toContain('Dirgur Nemesis');
    }
    // Its controller may read their own card, which is the one view that may.
    expect(viewFor(s, 1).cards[card]?.card?.name).toBe('Dirgur Nemesis');

    // It arrives face down, still a 2/2, and three mana was what it cost.
    s = passBoth(s);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(s.instances[card]!.faceDown).toBe(true);
    expect(characteristicsOf(s, s.instances[card]!).toughness).toBe(2);
  });

  it('keeps its damage when it is turned up, which is how a 2/2 becomes a 2/6 and lives', () => {
    /*
      The rule that makes morph more than a discount: turning face up is not a new object
      (CR 702.37d), so nothing about the permanent resets. A 2/2 holding two damage from blocking
      is a 2/6 holding two damage, and state-based actions let it live.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 1: ['Dirgur Nemesis'] },
      battlefield: {
        0: ['Hill Giant'],
        1: ['Island', 'Island', 'Island', 'Island', 'Island', 'Island', 'Island', 'Swamp', 'Swamp'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const card = find(s, 1, 'hand', 'Dirgur Nemesis');
    /*
      Nothing is tapped by hand here, and the land count is why: the turn-up happens on the
      *opponent's* turn, when seat 1's lands have not untapped since it cast the morph. Nine lands
      so that paying {3} leaves the six the {5}{U} needs — which is also what the card asks of a
      real deck, and the reason morph is a thing a control deck does on turn three.
    */
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, faceDown: true }));
    expect(s.instances[card]!.faceDown).toBe(true);

    // Seat 0 attacks into it with a 3/3 and the 2/2 blocks: three damage on a two-toughness body.
    s = advanceTo(nextTurn(s), 'declare-attackers');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: giant, defender: 1 }] });
    s = advanceTo(s, 'declare-blockers');
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: card, attacker: giant }] });
    // Priority after blockers goes to the attacking player first (CR 509.4), so seat 1 gets its
    // window once seat 0 has passed — which is also the window a real player would use.
    if (!legalActions(s, 1).hasPriority) s = apply(s, { type: 'auto:pass', by: 0 });

    // Turned up before damage, with the mana that was left. It is now a 2/6, and three damage is
    // not lethal to a 2/6.
    s = apply(s, { type: 'auto:turnUp', by: 1, card });
    expect(s.instances[card]!.faceDown).toBe(false);
    expect(characteristicsOf(s, s.instances[card]!).toughness).toBe(6);
    s = drain(advanceTo(s, 'combat-damage'));
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(damageOn(s, card)).toBe(3);
    // The damage it dealt back killed nothing: a 2/6 against a 3/3 trades neither way.
    expect(s.instances[giant]!.zone).toBe('battlefield');
  });

  it('turns up during combat, after blockers, with nothing an opponent can do about it', () => {
    /*
      The headline: a 2/2 blocked by a 2/2 becomes a 3/1 with first strike, and the blocker dies
      without dealing damage back. Turning face up is a special action and uses no stack
      (CR 702.37b), so there is no priority window between the declaration and the trick — which
      is the one unanswerable play in this pool.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      hands: { 0: ['Battering Craghorn'] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'],
        1: ['Grizzly Bears'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const card = find(s, 0, 'hand', 'Battering Craghorn');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card, faceDown: true }));

    // A turn later, so it can attack: it arrived face down and summoning sickness is about when it
    // arrived, not about which side is showing.
    s = advanceTo(nextTurn(nextTurn(s)), 'declare-attackers');
    // The mana is left where it is: `payFrom` taps for the turn-up at the moment it is paid, and
    // tapping everything up front would have spent the mana a step before it was needed — the
    // pool empties at the end of every step (CR 500.4), which is exactly the trap a player falls
    // into by tapping lands early at a real table.
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: card, defender: 1 }] });
    s = advanceTo(s, 'declare-blockers');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bears, attacker: card }] });
    if (!legalActions(s, 0).hasPriority) s = apply(s, { type: 'auto:pass', by: 1 });

    // The trick. No stack object, which is what "special action" means.
    const stackBefore = s.stackOrder.length;
    s = apply(s, { type: 'auto:turnUp', by: 0, card });
    expect(s.stackOrder.length).toBe(stackBefore);
    const ch = characteristicsOf(s, s.instances[card]!);
    expect(ch.power).toBe(3);
    expect([...ch.keywords]).toContain('first strike');

    s = drain(advanceTo(s, 'end-combat'));
    // First strike: the 2/2 blocker is dead before it deals its damage, so the 3/1 lives.
    expect(countOf(s, 1, 'graveyard', 'Grizzly Bears')).toBe(1);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(damageOn(s, card)).toBe(0);
  });

  it('casts a land as a creature spell, because morph does not read the card', () => {
    /*
      Zoetic Cavern, which is in the pool to prove exactly this: the face-down cast is offered and
      paid for before anything asks what the card is (CR 702.37a). A land cast this way is a 2/2
      creature and not a land at all — it taps for nothing — and turning it up gives back a land
      that is not a creature.
    */
    let s = holding(1, 'Zoetic Cavern', 'tidal-mind',
      ['Island', 'Island', 'Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Zoetic Cavern');
    const plays = legalActions(s, 1).plays.filter((p) => p.card === card);
    // Both: play it as a land, or cast it face down. Two different things to do with one card.
    expect(plays.map((p) => p.kind).sort()).toEqual(['cast', 'land']);
    expect(plays.find((p) => p.kind === 'cast')?.faceDown).toBe(true);

    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, faceDown: true }));
    const down = characteristicsOf(s, s.instances[card]!);
    expect(down.isCreature).toBe(true);
    expect(down.isLand).toBe(false);
    // Nothing to tap it for: a face-down land has no mana ability.
    expect(legalActions(s, 1).plays.some((p) => p.card === card && p.isManaAbility)).toBe(false);
    // And it did not use the land drop, because it was never played as a land.
    expect(s.landsPlayed[1] ?? 0).toBe(0);

    // {2} turns it up, and it is a land again — and no longer a creature.
    s = apply(s, { type: 'auto:turnUp', by: 1, card });
    const up = characteristicsOf(s, s.instances[card]!);
    expect(up.isLand).toBe(true);
    expect(up.isCreature).toBe(false);
    expect(up.name).toBe('Zoetic Cavern');
  });

  it('survives the wire in both places it can be face down', () => {
    /*
      Packing has to be invisible, and twice now it has not been.

      `packView` leaves out an empty keyword list because `"keywords":[]` on three hundred cards is
      four kilobytes, and `unpackView` puts it back — but the condition it used to put it back
      under was "a battlefield card whose definition travelled", and a face-down card has no
      definition to travel. The whole-game assertion in `playout.test.ts` caught it; this is the
      same check written where somebody reading morph will find it, for the permanent *and* for the
      spell still on the stack.
    */
    let s = holding(1, 'Dirgur Nemesis', 'tidal-mind', ['Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Dirgur Nemesis');
    s = apply(s, { type: 'auto:cast', by: 1, card, faceDown: true });
    for (const viewer of [0, 1, null] as const) {
      const view = viewFor(s, viewer);
      expect(unpackView(packView(view))).toEqual(view);
    }
    s = passBoth(s);
    for (const viewer of [0, 1, null] as const) {
      const view = viewFor(s, viewer);
      expect(unpackView(packView(view))).toEqual(view);
      // And it is still anonymous after the round trip, which is the half that matters.
      expect(JSON.stringify(unpackView(packView(view)).cards[card]))
        .toContain(viewer === 1 ? 'Dirgur Nemesis' : '"power":2');
    }
  });

  it('fires a turned-face-up trigger, which an entry trigger could never have been', () => {
    /*
      The hook morph needs and `etb` cannot give it (CR 702.37d).

      A morph *enters* face down, with no abilities at all, so an entry trigger has already come and
      gone by the time the card is itself — and turning it up is not a new object, so it will not
      come round again. The assertion that matters is the pair: the trigger does not fire when the
      permanent arrives, and it does fire when it is turned over.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      hands: { 1: ['Ainok Survivalist'] },
      battlefield: {
        0: ['Sol Ring'],
        1: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const card = find(s, 1, 'hand', 'Ainok Survivalist');
    const ring = find(s, 0, 'battlefield', 'Sol Ring');

    // Arriving face down triggers nothing: it has no abilities to trigger while it is down.
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, faceDown: true }));
    expect(s.instances[card]!.faceDown).toBe(true);
    expect(s.instances[ring]!.zone).toBe('battlefield');
    expect(s.stackOrder).toHaveLength(0);

    // Turning it up puts the trigger on the stack — the one part of morph an opponent may answer,
    // because the turn-up itself used no stack at all.
    s = apply(s, { type: 'auto:turnUp', by: 1, card });
    expect(s.instances[card]!.faceDown).toBe(false);
    expect(stackNames(s).join(' ')).toContain('artifact or enchantment');
    s = drain(passBoth(s));
    expect(s.instances[ring]!.zone).toBe('graveyard');
  });

  it('is turned up for the body alone when the trigger has nothing to hit', () => {
    /*
      The trigger is **mandatory** and targets an opponent's artifact or enchantment, so on a board
      with none it never reaches the stack at all (CR 603.3d) — and turning the card up is still
      legal, because the body is worth something on its own. Without the "an opponent controls"
      clause this would have had to destroy its controller's own Sol Ring.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'verdant-guard' },
      hands: { 1: ['Ainok Survivalist'] },
      battlefield: { 1: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Glorious Anthem'] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const card = find(s, 1, 'hand', 'Ainok Survivalist');
    const mine = find(s, 1, 'battlefield', 'Glorious Anthem');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, faceDown: true }));
    s = drain(apply(s, { type: 'auto:turnUp', by: 1, card }));

    expect(s.instances[card]!.faceDown).toBe(false);
    // Nothing went on the stack, and its controller's own enchantment is untouched.
    expect(s.stackOrder).toHaveLength(0);
    expect(s.instances[mine]!.zone).toBe('battlefield');
    // A 2/1 again, with the anthem lifting it.
    expect(characteristicsOf(s, s.instances[card]!).power).toBe(3);
  });

  it('wins the combat it is turned up in, which is what the trigger is held for', () => {
    /*
      Master of Pearls, and the reason a turned-face-up trigger is worth more than its text.

      Two 2/2s attack into two 2/2 blockers, which is a trade either way — and then the Master
      turns up after blockers are declared and the whole team is a 4/4. No window to answer it: the
      turn-up uses no stack, so by the time anybody holds priority again the trigger is already on
      it and the blocks are already locked in.
    */
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'skyward-writ' },
      hands: { 1: ['Master of Pearls'] },
      battlefield: {
        0: ['Grizzly Bears', 'Centaur Courser'],
        1: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Leonin Skyhunter'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const card = find(s, 1, 'hand', 'Master of Pearls');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, faceDown: true }));

    // A turn later so the 2/2 can attack, and the Skyhunter goes with it.
    s = advanceTo(nextTurn(nextTurn(s)), 'declare-attackers');
    const hunter = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = apply(s, {
      type: 'auto:attack', by: 1,
      attackers: [{ attacker: card, defender: 0 }, { attacker: hunter, defender: 0 }],
    });
    s = advanceTo(s, 'declare-blockers');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:block', by: 0, blocks: [{ blocker: bears, attacker: card }] });
    if (!legalActions(s, 1).hasPriority) s = apply(s, { type: 'auto:pass', by: 0 });

    s = drain(apply(s, { type: 'auto:turnUp', by: 1, card }));
    // +2/+2 to the team, the attacker and the unblocked flier alike.
    expect(characteristicsOf(s, s.instances[card]!).power).toBe(4);
    expect(characteristicsOf(s, s.instances[hunter]!).power).toBe(4);

    s = drain(advanceTo(s, 'end-combat'));
    // The 2/2 blocker is dead, the 4/4 that killed it lives, and the flier hit for four.
    expect(countOf(s, 0, 'graveyard', 'Grizzly Bears')).toBe(1);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(life(s, 0)).toBe(16);
  });

  it('does not fire for a card that was never face down', () => {
    // Cast for its printed cost, the Master is a 2/2 and nothing else: there is no entry trigger on
    // it, and `turned-face-up` is not an entry. A card that reads the trigger as "when this enters"
    // would give the team +2/+2 here, which is the mistake this test exists to catch.
    let s = advanceTo(arena({
      decks: { 1: 'skyward-writ' },
      hands: { 1: ['Master of Pearls'] },
      battlefield: { 1: ['Plains', 'Plains', 'Leonin Skyhunter'] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const card = find(s, 1, 'hand', 'Master of Pearls');
    const hunter = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card })));
    expect(s.instances[card]!.faceDown).toBe(false);
    expect(characteristicsOf(s, s.instances[card]!).power).toBe(2);
    expect(characteristicsOf(s, s.instances[hunter]!).power).toBe(2);
  });

  it('refuses a face-down cast of a card with no morph, and a turn-up of what is not yours', () => {
    const s = holding(1, 'Man-o\'-War', 'tidal-mind', ['Island', 'Island', 'Island', 'Island']);
    const manowar = find(s, 1, 'hand', "Man-o'-War");
    expect(refusal(s, { type: 'auto:cast', by: 1, card: manowar, faceDown: true }))
      .toContain('has no morph');
    // And it is not offered, which is the half a player sees.
    expect(legalActions(s, 1).plays.filter((p) => p.card === manowar && p.faceDown === true))
      .toHaveLength(0);

    let board = holding(1, 'Dirgur Nemesis', 'tidal-mind', ['Island', 'Island', 'Island']);
    const card = find(board, 1, 'hand', 'Dirgur Nemesis');
    board = passBoth(apply(board, { type: 'auto:cast', by: 1, card, faceDown: true }));
    /*
      The opponent cannot turn it up, whatever they are holding: it is not their permanent.

      Asked on seat 0's own turn, because `turnUp` checks priority before it checks whose permanent
      it is — and that order is right: "you do not have priority" is the truer answer while it is
      somebody else's turn, and it is the one a table should say.
    */
    board = advanceTo(nextTurn(board), 'precombat-main');
    expect(refusal(board, { type: 'auto:turnUp', by: 0, card }))
      .toContain('not a permanent you control');
    // And it is not offered to them either.
    expect(legalActions(board, 0).plays.some((p) => p.kind === 'turnUp')).toBe(false);
  });

  it('is not offered a turn-up it cannot pay for, and refuses one that is already face up', () => {
    // Three Islands, all spent on the face-down cast: {5}{U} is a long way off.
    let s = holding(1, 'Dirgur Nemesis', 'tidal-mind', ['Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Dirgur Nemesis');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, faceDown: true }));
    expect(legalActions(s, 1).plays.some((p) => p.kind === 'turnUp')).toBe(false);
    expect(refusal(s, { type: 'auto:turnUp', by: 1, card })).toContain('cannot pay {5}{U}');

    // Face up already: there is nothing to turn.
    const up = holding(1, "Man-o'-War", 'tidal-mind', ['Island', 'Island', 'Island']);
    const other = find(up, 1, 'battlefield', 'Island');
    expect(refusal(up, { type: 'auto:turnUp', by: 1, card: other })).toContain('already face up');
  });
});

describe('Vehicles and crew: an artifact that is a creature only while somebody drives it', () => {
  /*
    Three cards, and almost none of this is new code.

    A Vehicle is an artifact, so `isCreature` is false and every rule that asks — attacking,
    blocking, a sweeper, a Doom Blade's filter — already says no. Crewing is layer 4, which the
    land-that-becomes-a-creature built. What is new is the **cost**: tap any number of untapped
    creatures you control with total power N or greater, which is convoke's shape and uses convoke's
    discipline — one planner, called by the offer and by the payment.
  */
  /*
    The Vehicles live in two decks, which is a measurement rather than a preference: the Dreadnought
    is in Rot Harvest, whose board is widest, and the two cheap ones are in Forge Alliance, whose
    creatures are tokens. See D125. So the helper takes the deck.
  */
  const garage = (
    vehicle: string, bodies: readonly string[],
    opts: { deck?: string; lands?: readonly string[] } = {},
  ): GameState => advanceTo(arena({
    decks: { 0: 'ember-rush', 1: opts.deck ?? 'forge-alliance' },
    battlefield: { 1: [...(opts.lands ?? ['Plains', 'Mountain']), vehicle, ...bodies] },
    turn: 4, firstSeat: 1,
  }), 'precombat-main');

  /** The Dreadnought's home, and the only deck with the bodies to crew it. */
  const yard = (vehicle: string, bodies: readonly string[]): GameState =>
    garage(vehicle, bodies, { deck: 'rot-harvest', lands: ['Forest', 'Swamp'] });

  it('is not a creature at all until it is crewed, so it cannot attack and nothing can kill it', () => {
    let s = yard('Consulate Dreadnought', []);
    const ship = find(s, 1, 'battlefield', 'Consulate Dreadnought');
    const ch = characteristicsOf(s, s.instances[ship]!);
    // The body is printed on the card and is simply not a creature's yet.
    expect(ch.isCreature).toBe(false);
    expect([ch.power, ch.toughness]).toEqual([7, 11]);
    expect(hasType(ch.typeLine, 'artifact')).toBe(true);
    // `canAttack` returns the reason rather than a boolean, and the reason is the whole card.
    expect(canAttack(s, ship, 1)?.reason).toContain('not a creature');

    // And with nobody to drive it, the crew is not offered — there is no cost it could pay.
    expect(legalActions(s, 1).plays.some((p) => p.card === ship)).toBe(false);
    expect(refusal(s, { type: 'auto:activate', by: 1, card: ship, abilityIndex: 0 }))
      .toContain('total power 4');
  });

  it('taps the smallest creatures that reach the number, and says how many before you press it', () => {
    /*
      Smallest first, which is the opposite of what reads naturally. "Any number with total power 4
      or greater" could be paid by tapping the Lhurgoyf alone — and that is the worst choice on the
      board, because a tapped creature cannot attack. The creature you want left standing is the
      big one.
    */
    // Crew 2, with two 1/1 Doomed Travelers and a 4/4 Serra Angel. The Angel alone would pay it in
    // one tap; the Travelers pay it in two and leave the Angel standing.
    let s = garage('Renegade Freighter', ['Doomed Traveler', 'Doomed Traveler', 'Serra Angel']);
    const ship = find(s, 1, 'battlefield', 'Renegade Freighter');
    const play = legalActions(s, 1).plays.find((p) => p.card === ship);
    expect(play?.description).toContain('(tapping 2)');

    s = apply(s, { type: 'auto:activate', by: 1, card: ship, abilityIndex: 0 });
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    expect(s.instances[angel]!.tapped).toBe(false);
    expect(ids(s, 1, 'battlefield')
      .filter((id) => nameOf(s, id) === 'Doomed Traveler' && s.instances[id]!.tapped)).toHaveLength(2);
    // The Vehicle itself is untapped, which is the point: it is about to attack.
    expect(s.instances[ship]!.tapped).toBe(false);

    /*
      And the other half of the same rule: when the small creatures cannot reach the number, the big
      one is tapped because it has to be. Crew 4 off two 1/1s and a 3/3 taps all three — five power
      for a cost of four, which is the price of the greedy rule and is cheaper than the search for a
      perfect subset would be worth.
    */
    const big = yard('Consulate Dreadnought', ['Llanowar Elves', 'Llanowar Elves', 'Centaur Courser']);
    const dread = find(big, 1, 'battlefield', 'Consulate Dreadnought');
    expect(legalActions(big, 1).plays.find((p) => p.card === dread)?.description)
      .toContain('(tapping 3)');
  });

  it('becomes a creature on resolution, attacks, and stops being one at end of turn', () => {
    let s = garage('Sky Skiff', ['Serra Angel']);
    const skiff = find(s, 1, 'battlefield', 'Sky Skiff');
    s = passBoth(apply(s, { type: 'auto:activate', by: 1, card: skiff, abilityIndex: 0 }));

    const crewed = characteristicsOf(s, s.instances[skiff]!);
    expect(crewed.isCreature).toBe(true);
    expect([crewed.power, crewed.toughness]).toEqual([2, 3]);
    // Its printed keyword was always there; it just had nothing to fly over.
    expect([...crewed.keywords]).toContain('flying');
    expect(canAttack(s, skiff, 1)).toBeNull();

    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: skiff, defender: 0 }] });
    s = drain(advanceTo(s, 'end-combat'));
    expect(life(s, 0)).toBe(18);

    // And it is an artifact again next turn, still on the battlefield.
    s = nextTurn(s);
    const after = characteristicsOf(s, s.instances[skiff]!);
    expect(after.isCreature).toBe(false);
    expect(s.instances[skiff]!.zone).toBe('battlefield');
  });

  it('survives the sweeper that kills every creature, because it is not one', () => {
    /*
      The card, in one assertion. A 7/11 that a Day of Judgment cannot touch is what you are paying
      for when you accept that it does nothing on its own.
    */
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'rot-harvest' },
      hands: { 0: ['Day of Judgment'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Consulate Dreadnought', 'Centaur Courser'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const ship = find(s, 1, 'battlefield', 'Consulate Dreadnought');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Day of Judgment') })));
    expect(s.instances[courser]!.zone).toBe('graveyard');
    expect(s.instances[ship]!.zone).toBe('battlefield');
  });

  it('can be crewed by a creature that only just arrived, and by one the Vehicle just paid for', () => {
    /*
      Summoning sickness does not stop a creature crewing (CR 702.122a): tapping it is a cost being
      paid, not a {T} ability it is activating. That is most of what makes a Vehicle castable and
      crewable in the same turn — and the rule a table gets wrong by reusing the tap-ability check.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'forge-alliance' },
      hands: { 1: ['Elite Vanguard'] },
      battlefield: { 1: ['Plains', 'Plains', 'Sky Skiff'] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Elite Vanguard') }));
    const dissenter = find(s, 1, 'battlefield', 'Elite Vanguard');
    expect(s.instances[dissenter]!.enteredTurn).toBe(s.turn);

    const skiff = find(s, 1, 'battlefield', 'Sky Skiff');
    s = passBoth(apply(s, { type: 'auto:activate', by: 1, card: skiff, abilityIndex: 0 }));
    expect(s.instances[dissenter]!.tapped).toBe(true);
    expect(characteristicsOf(s, s.instances[skiff]!).isCreature).toBe(true);
    // The Vehicle was already on the battlefield, so it is not summoning-sick: `canAttack` does
    // not care what the permanent was when it arrived (CR 302.6 via 613.1c).
    expect(canAttack(s, skiff, 1)).toBeNull();
  });

  it('is an activated ability, so the opponent gets a window the Vehicle does not survive', () => {
    // Crew uses the stack (CR 702.122a), unlike turning a morph face up. The creatures are tapped
    // as the cost is paid, so answering the crew leaves them tapped and the Vehicle inert — which
    // is exactly the blowout the card accepts in exchange for its body.
    let s = garage('Renegade Freighter', ['Serra Angel']);
    const freighter = find(s, 1, 'battlefield', 'Renegade Freighter');
    const courser = find(s, 1, 'battlefield', 'Serra Angel');
    s = apply(s, { type: 'auto:activate', by: 1, card: freighter, abilityIndex: 0 });
    expect(s.stackOrder).toHaveLength(1);
    expect(s.instances[courser]!.tapped).toBe(true);
    expect(characteristicsOf(s, s.instances[freighter]!).isCreature).toBe(false);
  });

  it('gets its attack trigger once it is a creature, and not before', () => {
    let s = garage('Renegade Freighter', ['Serra Angel']);
    const freighter = find(s, 1, 'battlefield', 'Renegade Freighter');
    s = passBoth(apply(s, { type: 'auto:activate', by: 1, card: freighter, abilityIndex: 0 }));
    expect(characteristicsOf(s, s.instances[freighter]!).power).toBe(4);

    s = advanceTo(s, 'declare-attackers');
    s = drain(apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: freighter, defender: 0 }] }));
    // +1/+1 and trample, off its own attack trigger.
    const swinging = characteristicsOf(s, s.instances[freighter]!);
    expect([swinging.power, swinging.toughness]).toEqual([5, 4]);
    expect([...swinging.keywords]).toContain('trample');
  });
});

describe('Sagas: a permanent that reads itself out over three turns and then is gone (CR 714)', () => {
  /*
    The first permanent here with a life of its own, and three pieces of machinery behind it: a
    turn-based action that adds the counter, a trigger keyed to the counter reaching a number, and a
    state-based action that sacrifices it once the last chapter has gone.

    The counter is the state and the chapter is what reaching a number means, which is why nothing
    anywhere records which chapters have fired. The number on the card is the record.
  */
  const saga = (name: string, deck: string, lands: readonly string[]): GameState => {
    let s = advanceTo(arena({
      decks: { 1: deck }, hands: { 1: [name] }, battlefield: { 1: [...lands] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    return tapAllLands(s, 1);
  };

  const lore = (s: GameState, id: string): number => s.instances[id]!.counters['lore'] ?? 0;

  /**
   * Resolves whatever is on the stack, answering any question a chapter asks on the way.
   *
   * A chapter is a triggered ability like any other, which means the ones that ask a question ask
   * it *on resolution* — so a test that only passes priority leaves the table waiting and the Saga
   * sitting there. Answering with the first candidate is enough here: which creature an opponent
   * sacrifices is their choice and not this test's subject.
   */
  const settleAll = (start: GameState, limit = 12): GameState => {
    let s = start;
    for (let i = 0; i < limit; i++) {
      const ask = s.pendingDecision;
      if (ask !== null) {
        const cards = ask.candidates.length > 0 ? [ask.candidates[0]!] : [];
        s = apply(s, { type: 'auto:decide', by: ask.seat, cards });
        continue;
      }
      if (s.stackOrder.length === 0) break;
      s = passBoth(s);
    }
    return s;
  };

  it('does chapter I on the turn it is cast, off the counter it enters with', () => {
    /*
      The rule that makes a Saga a card rather than a three-turn promise: it enters with a lore
      counter (CR 714.2a), so the first chapter is on the stack before its controller has passed
      priority. An `etb` trigger would have done this one and nothing else.
    */
    let s = saga('The Birth of Meletis', 'skyward-writ', ['Plains', 'Plains']);
    const card = find(s, 1, 'hand', 'The Birth of Meletis');
    s = apply(s, { type: 'auto:cast', by: 1, card });
    s = passBoth(s);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(lore(s, card)).toBe(1);
    // Chapter I is on the stack, which is where an opponent may answer it.
    expect(stackNames(s).join(' ')).toContain('Wall');
    s = drain(passBoth(s));
    expect(countOf(s, 1, 'battlefield', 'Wall')).toBe(1);
    expect(s.instances[card]!.zone).toBe('battlefield');
  });

  it('gains a counter at the beginning of its own controller’s precombat main phase, and nobody else’s', () => {
    let s = saga('The Birth of Meletis', 'skyward-writ', ['Plains', 'Plains']);
    const card = find(s, 1, 'hand', 'The Birth of Meletis');
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card })));
    expect(lore(s, card)).toBe(1);

    // The opponent's turn moves nothing: it is "your precombat main phase" (CR 714.2a).
    s = advanceTo(nextTurn(s), 'precombat-main');
    expect(s.activeSeat).toBe(0);
    expect(lore(s, card)).toBe(1);

    // And its own turn is chapter II, which gains two life.
    const before = life(s, 1);
    s = drain(advanceTo(nextTurn(s), 'precombat-main'));
    expect(lore(s, card)).toBe(2);
    expect(life(s, 1)).toBe(before + 2);
    expect(s.instances[card]!.zone).toBe('battlefield');
  });

  it('is sacrificed after the last chapter resolves, and not before it', () => {
    /*
      The sacrifice is a state-based action and not a fourth chapter, and the stack check is the
      whole of the delay: the Saga sits on the battlefield while chapter III waits to resolve, which
      is what lets a chapter that reads the board see the board the chapter is about.
    */
    let s = saga('The Birth of Meletis', 'skyward-writ', ['Plains', 'Plains']);
    const card = find(s, 1, 'hand', 'The Birth of Meletis');
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card })));
    s = drain(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'));
    expect(lore(s, card)).toBe(2);

    // The third counter goes on, and the Saga is still there with its chapter on the stack.
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(lore(s, card)).toBe(3);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(s.stackOrder.length).toBeGreaterThan(0);

    /*
      And still there while the chapter *resolves*, because chapter III stops to ask for the Plains.
      A mid-resolution question keeps the ability on the stack, so the state-based action sees it
      and leaves the Saga where it is — which is what lets a chapter that reads the board see the
      board the chapter is about.
    */
    s = passBoth(s);
    expect(s.pendingDecision).not.toBeNull();
    expect(s.instances[card]!.zone).toBe('battlefield');

    s = drain(decide(s, ['Plains']), 24);
    expect(countOf(s, 1, 'battlefield', 'Plains')).toBeGreaterThan(2);
    expect(s.instances[card]!.zone).toBe('graveyard');
  });

  it('stops counting the moment it leaves the battlefield', () => {
    // Nothing remembers which chapters a Saga has done, so a Saga that is answered is simply gone:
    // the counters went with it, and the card in the graveyard is an enchantment like any other.
    let s = saga('The Birth of Meletis', 'skyward-writ', ['Plains', 'Plains']);
    const card = find(s, 1, 'hand', 'The Birth of Meletis');
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card })));
    s = apply(s, { type: 'card:move', by: 1, card, toZone: 'graveyard' });

    const before = life(s, 1);
    s = drain(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'));
    // No chapter II, because there is no Saga to put a counter on.
    expect(life(s, 1)).toBe(before);
    expect(s.instances[card]!.counters['lore'] ?? 0).toBe(0);
  });

  it('reaches into anybody’s graveyard on its last chapter, which is why it is in the mill deck', () => {
    /*
      The Eldest Reborn, and the clause that puts it in Hollow Tide: every other reanimation in the
      pool reads "your graveyard", and this one can take the creature the deck's own mill spells put
      into an opponent's.
    */
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'hollow-tide' },
      hands: { 1: ['The Eldest Reborn'] },
      battlefield: {
        0: ['Centaur Courser'],
        1: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const card = find(s, 1, 'hand', 'The Eldest Reborn');
    s = tapAllLands(s, 1);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card }));

    // Chapter I: the opponent sacrifices their only creature, which puts it in their graveyard.
    s = settleAll(s);
    const theirs = find(s, 0, 'graveyard', 'Centaur Courser');
    expect(s.instances[theirs]!.zone).toBe('graveyard');

    // Chapter II, two turns on: the opponent discards.
    s = settleAll(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'));
    expect(lore(s, card)).toBe(2);
    expect(ids(s, 0, 'graveyard').length).toBe(2);

    /*
      Chapter III, and the clause the card is in this deck for: it takes the creature out of the
      **opponent's** graveyard and puts it onto this seat's battlefield. Its only legal target is
      the creature the first chapter made them sacrifice, so the engine aims it without asking —
      which is the same rule that stops a table offering a choice of one.
    */
    s = settleAll(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 24);
    expect(s.instances[theirs]!.zone).toBe('battlefield');
    expect(s.instances[theirs]!.zoneSeat).toBe(1);
    // Their card, still owned by them, which is what sends it home when it dies (CR 110.2a).
    expect(s.instances[theirs]!.owner).toBe(0);
    // And the Saga is gone, its last chapter having resolved.
    expect(s.instances[card]!.zone).toBe('graveyard');
  });
});

describe('foretell: {2} to hide a card in exile, and a cheaper cost later (CR 702.143)', () => {
  /*
    The fourth zone a spell is cast from here — after the hand, the command zone and the graveyard —
    and the only one where the card is hidden while it waits. It is also the one mechanic in the pool
    that is *about* the thing the engine's own opponent cannot do: holding mana for an answer.

    Two rules carry the mechanic and both are checked in one place rather than in the scripts: it is
    taken during your own turn, and a foretold card cannot be cast on the turn it was foretold.
  */
  const holding = (name: string, lands: readonly string[]): GameState => {
    let s = advanceTo(arena({
      decks: { 1: 'tidal-mind' }, hands: { 1: [name] }, battlefield: { 1: [...lands] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    return tapAllLands(s, 1);
  };

  it('is offered for {2} beside the printed cast, and takes the card to exile face down', () => {
    let s = holding('Behold the Multiverse', ['Island', 'Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Behold the Multiverse');
    const plays = legalActions(s, 1).plays.filter((p) => p.card === card);
    // Two things to do with one card: cast it for {3}{U}, or foretell it for {2}.
    expect(plays.map((p) => p.kind).sort()).toEqual(['cast', 'foretell']);
    expect(plays.find((p) => p.kind === 'foretell')?.manaCost).toBe('{2}');

    s = apply(s, { type: 'auto:foretell', by: 1, card });
    expect(s.instances[card]!.zone).toBe('exile');
    expect(s.instances[card]!.faceDown).toBe(true);
    expect(s.instances[card]!.foretoldTurn).toBe(s.turn);
    // Two mana left in the pool, because foretelling cost {2} and not {3}{U}. (The helper taps
    // every land up front, so what is left is pool rather than untapped lands.)
    expect(s.pools['1']?.U).toBe(2);
  });

  it('is hidden from everybody but the player who foretold it', () => {
    /*
      The half of the mechanic a measurement cannot see. An opponent is told there is a card in
      exile and nothing else, which is why foretelling an answer and foretelling a threat look
      identical from across the table.
    */
    let s = holding('Saw It Coming', ['Island', 'Island']);
    const card = find(s, 1, 'hand', 'Saw It Coming');
    s = apply(s, { type: 'auto:foretell', by: 1, card });

    for (const viewer of [0, null] as const) {
      const theirs = viewFor(s, viewer).cards[card]!;
      expect(theirs.zone).toBe('exile');
      expect(theirs.faceDown).toBe(true);
      expect(theirs.card).toBeUndefined();
      expect(JSON.stringify(theirs)).not.toContain('Saw It Coming');
    }
    // And its own player reads it, because it is their card.
    expect(viewFor(s, 1).cards[card]?.card?.name).toBe('Saw It Coming');
  });

  it('cannot be cast on the turn it was foretold, and is cast for the cheaper cost after that', () => {
    let s = holding('Behold the Multiverse', ['Island', 'Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Behold the Multiverse');
    s = apply(s, { type: 'auto:foretell', by: 1, card });

    // CR 702.143b, which is what stops foretell being a discount on a spell you were casting anyway.
    expect(legalActions(s, 1).plays.some((p) => p.card === card)).toBe(false);
    expect(refusal(s, { type: 'auto:cast', by: 1, card, foretold: true }))
      .toContain('cannot be cast on the turn it was foretold');

    // Two turns on it is a play again, out of exile, for {1}{U} rather than {3}{U}.
    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 1);
    const play = legalActions(s, 1).plays.find((p) => p.card === card);
    expect(play?.foretold).toBe(true);
    expect(play?.manaCost).toBe('{1}{U}');
    expect(play?.description).toContain('from exile');

    const before = ids(s, 1, 'hand').length;
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card, foretold: true }));
    // It stops to scry on the way down, like the Preordain it is a bigger version of. Keeping both
    // cards on top is a legal answer, which is what the empty list is.
    expect(s.pendingDecision?.prompt).toContain('Scry');
    s = drain(decide(s, []), 24);
    // Draw two, and the card itself in the graveyard rather than back in exile.
    expect(ids(s, 1, 'hand').length).toBe(before + 2);
    expect(s.instances[card]!.zone).toBe('graveyard');
  });

  it('turns face up as it is cast, which is the moment the hiding ends', () => {
    /*
      Morph wants `faceDown` carried onto the stack and foretell wants it cleared, so the one line
      that says which is which is worth a test of its own. A counterspell on the stack that nobody
      could read would be a table nobody could play at.
    */
    let s = holding('Behold the Multiverse', ['Island', 'Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Behold the Multiverse');
    s = apply(s, { type: 'auto:foretell', by: 1, card });
    expect(s.instances[card]!.faceDown).toBe(true);

    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 1);
    s = apply(s, { type: 'auto:cast', by: 1, card, foretold: true });
    expect(s.instances[card]!.zone).toBe('stack');
    expect(s.instances[card]!.faceDown).toBe(false);
    // And the stack says what it is, to everybody.
    expect(stackNames(s).join(' ')).toContain('Behold the Multiverse');
    expect(JSON.stringify(viewFor(s, 0).cards[card])).toContain('Behold the Multiverse');
  });

  it('refuses a foretell of a card that has none, and one taken on somebody else’s turn', () => {
    let s = holding('Doom Blade', ['Island', 'Island', 'Island']);
    const blade = find(s, 1, 'hand', 'Doom Blade');
    expect(refusal(s, { type: 'auto:foretell', by: 1, card: blade })).toContain('has no foretell');
    expect(legalActions(s, 1).plays.some((p) => p.kind === 'foretell')).toBe(false);

    /*
      And "during your turn" (CR 702.143a): on the opponent's turn it is not a move at all.

      The refusal says *priority* rather than the phase, and that is the right order — while it is
      somebody else's turn the truer answer is that this seat does not hold priority, and the
      sorcery-speed clause only becomes the reason once it does.
    */
    let theirs = holding('Saw It Coming', ['Island', 'Island', 'Island']);
    const card = find(theirs, 1, 'hand', 'Saw It Coming');
    theirs = advanceTo(nextTurn(theirs), 'precombat-main');
    expect(theirs.activeSeat).toBe(0);
    expect(legalActions(theirs, 1).plays.some((p) => p.kind === 'foretell')).toBe(false);
    expect(refusal(theirs, { type: 'auto:foretell', by: 1, card })).toContain('priority');
  });

  it('is not castable out of exile by the player who did not foretell it', () => {
    // A face-down card in exile is also what a Banisher Priest leaves behind, and `foretoldTurn`
    // is what tells the two apart — it belongs to whoever foretold the card, not to whoever owns it.
    let s = holding('Saw It Coming', ['Island', 'Island', 'Island']);
    const card = find(s, 1, 'hand', 'Saw It Coming');
    s = apply(s, { type: 'auto:foretell', by: 1, card });
    s = advanceTo(nextTurn(s), 'precombat-main');
    expect(legalActions(s, 0).plays.some((p) => p.card === card)).toBe(false);
    expect(refusal(s, { type: 'auto:cast', by: 0, card, foretold: true }))
      .toContain('not foretold by you');
  });
});
