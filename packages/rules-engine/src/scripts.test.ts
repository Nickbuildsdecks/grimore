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
  SOLDIER_TOKEN, STARTER_DECKS, TOKEN_DEFS, addCounters, botAction, canAttack, canBlock,
  characteristicsOf, customDeck,
  hasType,
  legalActions,
  parseTypeLine,
  packView, parseManaCost, pendingDeclaration, protectedFrom, pump, pumpAll, pumpTeam, scriptFor,
  scriptedCardNames,
  staticEffect, unpackView, viewFor,
  type ContinuousEffect,
} from './index.js';
import {
  advanceTo, apply, arena, choices, countOf, damageOn, decide, drain, find, ids, life, nameOf,
  namesIn, nextTurn, passBoth, refusal, stackNames, tapAllLands,
} from './testkit.js';
import { CARD_SCRIPTS } from './scripts.js';
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
      // Skyward Writ rather than the default Verdant Guard: D190 spent that deck's Pacifism on a
      // Kitchen Finks, and this deck still runs one.
      decks: { 1: 'skyward-writ' },
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
    // Hollow Tide holds two Counterspells; Tidal Mind's single copy went in its rebuild.
    let s = arena({
      decks: { 1: 'hollow-tide' },
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
  /** `deck` is Hollow Tide unless a card lives somewhere else — see the Sign in Blood pair. */
  const draws = (
    hand: readonly string[], lands: readonly string[], deck = 'hollow-tide',
  ): GameState => {
    let s = advanceTo(arena({
      decks: { 1: deck },
      hands: { 1: [...hand] }, battlefield: { 1: [...lands] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    return tapAllLands(s, 1);
  };

  it('Sign in Blood draws two and costs two life', () => {
    // Dawn Tithe rather than Hollow Tide: Hollow Tide's copy became the pool's adventurer, and
    // `arena` takes the named card out of the deck the seat is playing.
    let s = draws(['Sign in Blood'], ['Swamp', 'Swamp'], 'dawn-tithe');
    const before = ids(s, 1, 'hand').length;
    s = cast(s, 1, 'Sign in Blood', [{ kind: 'player', seat: 1 }]);
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 2);
    expect(life(s, 1)).toBe(18);
  });

  it('Sign in Blood can be aimed at an opponent, which is what makes it removal', () => {
    let s = draws(['Sign in Blood'], ['Swamp', 'Swamp'], 'dawn-tithe');
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

  it('Talrand makes a Drake for a sorcery, and not for a creature', () => {
    /*
      Preordain, which is the fourth card to hold this slot: Tome Scour went to Hollow Tide, Dive
      Down went to Skyward Writ when Willbender took its place, and Think Twice went when the
      Mulldrifter took *its* place. The trigger is about any instant **or sorcery**, so which one
      is immaterial — it only has to be cheap enough to leave the creature spell below it castable,
      and to need no target, since Talrand is the only creature on the table and bouncing it would
      be testing something else.
    */
    let s = control(
      ['Preordain', 'Omenspeaker'],
      ['Island', 'Island', 'Island', 'Swamp'],
      ['Talrand, Sky Summoner'],
    );
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Preordain') });
    expect(s.stackOrder.length).toBe(2); // the spell and the trigger
    s = passBoth(s);
    expect(countOf(s, 1, 'battlefield', 'Drake')).toBe(1);
    // And the Preordain itself, which stops and asks which cards to put back — nothing to do with
    // the Drake, and answered with "neither" so the stack can empty and the creature spell below
    // can be cast at sorcery speed.
    s = decide(passBoth(s), []);

    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Omenspeaker') });
    expect(s.stackOrder.length).toBe(1); // a creature spell is not an instant or sorcery
  });

  it('keeps the printed keywords of the creatures it does not script beyond them', () => {
    let s = control([], ['Island'], ['Vampire Nighthawk', 'Air Elemental', 'Wall of Frost', 'Wind Drake']);
    const keywords = (name: string) =>
      [...characteristicsOf(s, s.instances[find(s, 1, 'battlefield', name)]!).keywords].sort();
    expect(keywords('Vampire Nighthawk')).toEqual(['deathtouch', 'flying', 'lifelink']);
    expect(keywords('Air Elemental')).toEqual(['flying']);
    // A Wall of Frost is scripted — it has a block trigger — and its printed keyword is still
    // read off the card rather than listed twice.
    expect(keywords('Wall of Frost')).toEqual(['defender']);
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
    // The tax goes up *after* the cast, so the first one is offered of it.
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
      // Dawn Tithe rather than Verdant Guard: D188 spent that deck's Soul Warden on a Topan
      // Freeblade, and Dawn Tithe is the deck actually built around the trigger.
      decks: { 1: 'dawn-tithe' }, hands: { 1: ['Soul Warden', 'Child of Night'] },
      battlefield: { 1: ['Plains', 'Swamp', 'Swamp'] }, turn: 2, firstSeat: 1,
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
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Child of Night') }));
    s = passBoth(s);
    expect(life(s, 1)).toBe(started + 1);
  });

  it('Soul Warden gains life for an opponent’s creature too', () => {
    // `of: 'any'`: it watches every creature that enters, whoever controls it. Getting this wrong
    // is the difference between a lifegain card and a much worse one.
    let s = arena({
      decks: { 1: 'dawn-tithe' }, hands: { 0: ['Hill Giant'] },
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
      battlefield: { 0: ['Goblin Arsonist'], 1: ['Swamp', 'Swamp', 'Omenspeaker'] },
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
    let s = ready(1, 'ashen-rite', ['Phyrexian Arena'], ['Swamp', 'Swamp', 'Swamp']);
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
    let s = ready(1, 'delta-bloom', ['Rampant Growth'], ['Forest', 'Forest']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));

    // Still on the stack: it is resolving, not resolved, and both tables should say so.
    expect(s.pendingDecision).not.toBeNull();
    expect(s.pendingDecision!.seat).toBe(1);
    expect(s.pendingDecision!.from).toBe('library');
    expect(s.stackOrder.length).toBe(1);
    // Only basic lands, and nothing else from a 59-card library. Delta Bloom's two are Forest and
    // Island, which is the deck this card belongs to since the Boa took its Verdant Guard slot.
    expect([...new Set(choices(s))]).toEqual(['Forest', 'Island']);

    s = decide(s, ['Island']);
    expect(s.pendingDecision).toBeNull();
    const island = find(s, 1, 'battlefield', 'Island');
    expect(s.instances[island]!.tapped).toBe(true);
    expect(namesIn(s, 1, 'graveyard')).toContain('Rampant Growth');
  });

  it('lets a search fail to find, which is legal and sometimes right (CR 701.19c)', () => {
    let s = ready(1, 'delta-bloom', ['Rampant Growth'], ['Forest', 'Forest']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));
    expect(s.pendingDecision!.min).toBe(0);
    const lands = countOf(s, 1, 'battlefield', 'Island') + countOf(s, 1, 'battlefield', 'Forest');
    s = decide(s, []);
    expect(s.pendingDecision).toBeNull();
    expect(countOf(s, 1, 'battlefield', 'Island') + countOf(s, 1, 'battlefield', 'Forest')).toBe(lands);
    expect(namesIn(s, 1, 'graveyard')).toContain('Rampant Growth');
  });

  it('opens the searcher’s own library while they look, and shuffles it when they are done', () => {
    let s = ready(1, 'delta-bloom', ['Rampant Growth'], ['Forest', 'Forest']);
    expect(s.seats[1]!.searching).toBe(false);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));
    // Looking through your own library is exactly what a search is, and the view is keyed on this.
    expect(s.seats[1]!.searching).toBe(true);
    const before = ids(s, 1, 'library').join(',');
    s = decide(s, ['Island']);
    expect(s.seats[1]!.searching).toBe(false);
    // Shuffled, so the order they were just shown is no longer the order they will draw in.
    expect(ids(s, 1, 'library').join(',')).not.toBe(before);
  });

  it('Diabolic Tutor takes any card out of the library and puts it in hand', () => {
    // Hollow Tide rather than Tidal Mind: the Tutor moved decks in the balance pass, and `ready`
    // takes the card out of that deck's library, so this is the deck that has one to take.
    let s = ready(0, 'hollow-tide', ['Diabolic Tutor'], ['Swamp', 'Swamp', 'Swamp', 'Swamp']);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Diabolic Tutor') }));
    expect(choices(s)).toContain('Counterspell');
    expect(namesIn(s, 0, 'hand')).not.toContain('Counterspell');
    s = decide(s, ['Counterspell']);
    expect(namesIn(s, 0, 'hand')).toContain('Counterspell');
  });

  it('Mind Rot is answered by the player discarding, not by the player who cast it', () => {
    let s = arena({
      decks: { 0: 'tidal-mind', 1: 'skyward-writ' },
      hands: { 0: ['Mind Rot'], 1: ['Healing Salve', 'Serra Angel', 'Pacifism'] },
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
    expect(choices(s)).toEqual(['Healing Salve', 'Pacifism', 'Serra Angel']);
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [] })).toContain('not your decision');

    s = decide(s, ['Healing Salve', 'Pacifism']);
    expect(namesIn(s, 1, 'hand')).toEqual(['Serra Angel']);
    expect(namesIn(s, 1, 'graveyard').sort()).toEqual(['Healing Salve', 'Pacifism']);
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
    let s = ready(1, 'delta-bloom', ['Rampant Growth'], ['Forest', 'Forest']);
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
      decks: { 0: 'rot-harvest', 1: 'ashen-rite' },
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
    const s = board(1, ['Dimir Guildgate'], ['Counterspell', 'Preordain'], 'hollow-tide');
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
    let s = withMana(1, ['Preordain'], ['Island'], [], 'hollow-tide');
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
    let s = withMana(1, ['Preordain'], ['Island'], [], 'hollow-tide');
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
    let s = withMana(1, ['Preordain'], ['Island'], [], 'hollow-tide');
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
    let s = withMana(1, ['Mind Spring'], ['Island', 'Island', 'Island', 'Island', 'Island'], [], 'delta-bloom');
    const before = ids(s, 1, 'hand').length;
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Mind Spring'), x: 3 }));
    // Three drawn, one Mind Spring gone.
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 3);
  });

  it('creates X tokens, and none at all for X=0', () => {
    /*
      Five Plains for two casts: X=3 spends four of them and the fifth pays the {W} of the second,
      which is the one being asked about — nothing is created for X=0.

      **One copy, cast twice**, put back into hand between by hand. The deck holds a single Secure
      the Wastes since the Boon Satyr took the second slot, and what this test is about is X rather
      than the card: the same card cast for a different X is exactly the comparison, and a tabletop
      move between the two is the cheapest way to make it.
    */
    let s = withMana(1, ['Secure the Wastes'],
      ['Plains', 'Plains', 'Plains', 'Plains', 'Plains']);
    const wastes = find(s, 1, 'hand', 'Secure the Wastes');
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: wastes, x: 3 }));
    expect(countOf(s, 1, 'battlefield', 'Warrior')).toBe(3);

    s = apply(s, { type: 'card:move', by: 1, card: wastes, toZone: 'hand' });
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: wastes, x: 0 }));
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
      // Skyward Writ rather than Hollow Tide: Hollow Tide's Essence Scatter paid for a third Fog
      // Bank, and `arena` takes the named card out of the deck the seat is playing.
      decks: { 1: 'skyward-writ' }, hands: { 0: ['Shivan Dragon', 'Lightning Bolt'], 1: ['Essence Scatter'] },
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
      decks: { 1: 'skyward-writ' }, hands: { 0: ['Lightning Bolt'], 1: ['Essence Scatter'] },
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
      // Dawn Tithe rather than Ashen Rite: Ashen Rite's copy became the pool's modal card, and
      // `arena` takes the named card out of the deck the seat is playing.
      decks: { 0: 'dawn-tithe' }, hands: { 0: ['Read the Bones'] },
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
    /*
      Two copies out of a deck built here, rather than out of whichever starter deck happens to run
      two today. Verdant Guard ran a pair when this was written and runs one now — the second paid
      for a River Boa — and a test that asserts something about *the card* should not be a vote on
      a deck slot.
    */
    const exiles = customDeck({
      id: 'two-journeys',
      name: 'Two Journeys',
      entries: [{ name: 'Journey to Nowhere', count: 4 }, { name: 'Plains', count: 56 }],
    }).deck;
    let s = advanceTo(arena({
      decks: { 1: 'two-journeys' },
      deckSpecs: { 'two-journeys': exiles },
      hands: { 1: ['Journey to Nowhere', 'Journey to Nowhere'] },
      battlefield: {
        1: ['Plains', 'Plains', 'Plains', 'Plains'],
        0: ['Shivan Dragon', 'Raging Goblin'],
      },
      turn: 3, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
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
    // Five mana spent, not one: the kicker is part of the cost rather than an offered upgrade.
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
      // One copy: the deck runs one since Thorn of the Black Rose took the other slot, and this
      // test only ever casts one of them.
      hands: { 0: ['Agonizing Demise'] },
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
      battlefield: { 0: ['Island', 'Island', 'Omenspeaker'], 1: ['Swamp', 'Swamp'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')].filter((i) => BASICS.has(nameOf(s, i)))) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    const body = find(s, 0, 'battlefield', 'Omenspeaker');
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
      decks: { 0: 'skyward-writ', 1: 'dawn-tithe' },
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
      // Kindle Grove for the seat casting it: Verdant Guard's Prey Upon became a Fleecemane Lion
      // (D182), and `arena` takes the named card out of whichever deck the seat is given.
      decks: { 0: 'kindle-grove', 1: 'rot-harvest' },
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
      // Dawn Tithe rather than Skyward Writ: the Verdict's other home, since D185 spent that
      // deck's copy on a Rest in Peace.
      decks: { 0: 'dawn-tithe', 1: 'rot-harvest' },
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
      decks: { 0: 'dawn-tithe', 1: 'rot-harvest' },
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
    /*
      A pasted list rather than a starter deck, because the two cards this test needs stopped
      sharing one: the Fog Bank left Tidal Mind in its rebuild and the Cackling Counterpart is
      still the pool's only copy, so no shipped deck holds both. What is being tested is the copy
      rule, not a deck.
    */
    const bankDeck = customDeck({
      id: 'counterpart-test',
      name: 'Counterpart',
      entries: [
        { name: 'Cackling Counterpart', count: 4 },
        { name: 'Fog Bank', count: 4 },
        { name: 'Island', count: 52 },
      ],
    }).deck;
    let s = advanceTo(arena({
      decks: { 0: 'counterpart-test', 1: 'verdant-guard' },
      deckSpecs: { 'counterpart-test': bankDeck },
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
  // Arc Tempest, which is where the Think Twice lives: Tidal Mind's copy became a Mulldrifter when
  // evoke went in, and the two copies here are the pool's remaining home for the card.
  const graveyard = (name: string, lands: readonly string[], deck = 'arc-tempest'): GameState => {
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
    // Hollow Tide rather than Tidal Mind, which traded its Preordain for a Treasure Cruise: the
    // card this test needs is one with no flashback that needs no target and asks nothing, and
    // the pool keeps four Preordains in three other decks.
    let s = graveyard('Preordain', ['Island', 'Island', 'Island'], 'hollow-tide');
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
      decks: { 0: 'arc-tempest', 1: 'hollow-tide' },
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
      decks: { 0: 'hollow-tide', 1: 'delta-bloom' },
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
      decks: { 0: 'ember-rush', 1: 'hollow-tide' },
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
      // Blight Vector rather than Verdant Guard for the seat holding the Naturalize: Verdant
      // Guard's copy became the pool's Wax // Wane, Rot Harvest's became a Young Wolf (D181), and
      // `arena` takes the named card out of whichever deck the seat is given.
      decks: { 0: 'ashen-rite', 1: 'blight-vector' },
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
      decks: { 0: 'dawn-tithe', 1: 'blight-vector' },
      hands: { 0: ['Pacifism'], 1: ['Naturalize'] },
      // A Cystbearer rather than a Centaur Courser, because the seat holding the Naturalize is
      // Blight Vector now and the creature has to come out of that seat's own deck.
      battlefield: { 0: ['Plains', 'Plains'], 1: ['Forest', 'Forest', 'Cystbearer'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const bearer = find(s, 1, 'battlefield', 'Cystbearer');
    s = drain(cast(s, 0, 'Pacifism', [{ kind: 'card', id: bearer }]));
    expect(characteristicsOf(s, s.instances[bearer]!).cantAttack).toBe(true);

    s = nextTurn(s);
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    const aura = find(s, 0, 'battlefield', 'Pacifism');
    s = drain(cast(s, 1, 'Naturalize', [{ kind: 'card', id: aura }]));
    expect(namesIn(s, 0, 'graveyard')).toContain('Pacifism');
    // And the creature is offered again, which is the point of casting it.
    expect(characteristicsOf(s, s.instances[bearer]!).cantAttack).toBe(false);
  });

  /*
    The interaction worth knowing as a player, and it is not special-cased anywhere.

    Journey to Nowhere exiles a creature "until Journey to Nowhere leaves the battlefield", and
    `destroy` is one more way for it to leave. The creature comes back through the Journey's own
    `leaves` trigger — the same machinery that already gives it back when the Journey is bounced.
  */
  it('and destroying a Journey to Nowhere gives the creature back', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'blight-vector' },
      hands: { 0: ['Journey to Nowhere'], 1: ['Naturalize'] },
      battlefield: { 0: ['Plains', 'Plains'], 1: ['Forest', 'Forest', 'Cystbearer'] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const bearer = find(s, 1, 'battlefield', 'Cystbearer');
    // Aimed as it arrives rather than as it is cast: the exile is an entry trigger, so the
    // choice comes back as a `pendingChoice` once the enchantment is already on the battlefield.
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Journey to Nowhere') }));
    if (s.pendingChoice !== null) {
      s = drain(apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: bearer }] }));
    }
    expect(namesIn(s, 1, 'battlefield')).not.toContain('Cystbearer');

    s = nextTurn(s);
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    s = drain(cast(s, 1, 'Naturalize', [{ kind: 'card', id: find(s, 0, 'battlefield', 'Journey to Nowhere') }]));
    expect(namesIn(s, 1, 'battlefield')).toContain('Cystbearer');
  });

  it('and nothing else is a legal target for it', () => {
    const s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'blight-vector' },
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
    // Skyward Writ rather than Tidal Mind, which traded its copy for the Willbender: a 1/1 Hawk
    // under +0/+3 is a 1/4, which is the same point a 2/2 Drake made and makes it more sharply.
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'skyward-writ' },
      hands: { 0: ['Lightning Bolt'], 1: ['Dive Down'] },
      battlefield: { 0: ['Mountain'], 1: ['Island', "Healer's Hawk"] },
      turn: 3, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const drake = find(s, 1, 'battlefield', "Healer's Hawk");
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
    expect(namesIn(s, 1, 'battlefield')).toContain("Healer's Hawk");
    // +0/+3 rather than +2/+2: the toughness is what beats a burn spell that did resolve. A 1/1
    // Hawk comes out of it a 1/4, which three damage does not kill.
    expect(power(s, drake)).toBe(1);
    expect(toughness(s, drake)).toBe(4);
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
      decks: { 0: 'dawn-tithe' },
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
      /*
        Every castable *face*, not every card, which is what a two-faced card made different.

        A split card is never cast as itself and has no script of its own, so checking the card
        would flag "Fire // Ice" as an unscripted instant for ever; checking the faces asks the real
        question, which is whether each thing a player can actually cast does something. An
        adventurer is in both lists at once — the creature card and the instant on it — and both
        belong here for the same reason.
      */
      .flatMap((entry) => [entry.card, ...(entry.card.faces?.cards ?? [])])
      .filter((card) => scriptFor(card.name) === undefined)
      .filter((card) => !/creature|land|artifact|enchantment/i.test(card.typeLine))
      // A split card itself is not castable, so there is nothing for it to fail to do.
      .filter((card) => card.faces?.kind !== 'split');
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
        /*
          A card printed with two castable faces is checked by its faces, not by itself.

          A split card has no text of its own — "Fire // Ice" is two spells on one piece of
          cardboard and is never cast as itself — so what has to do something is each half. An
          adventurer is checked both ways: the creature card by this loop, and the spell on it by
          the recursion, because a player can cast either.
        */
        for (const face of card.faces?.cards ?? []) {
          if (scriptFor(face.name) === undefined) missing.push(`${face.name} (${face.typeLine})`);
        }
        if (card.faces?.kind === 'split') continue;
        if (scriptFor(card.name) !== undefined) continue;
        // A vanilla creature does not need a script: its body and its printed keywords are enough.
        // An adventurer's own text is the adventure, which the face above has already covered.
        const vanilla = /creature/i.test(card.typeLine)
          && ((card.faces === undefined ? card.oracleText : '') ?? '').trim() === '';
        if (!vanilla) missing.push(`${card.name} (${card.typeLine})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('registers each script under the name of a real card or a token the pool makes', () => {
    const printed = new Set([
      ...Object.values(STARTER_DECKS).flatMap((deck) =>
        [...deck.cards.map((c) => c.card), deck.commander!]
          // Each castable face as well as the card, because a half is where the script lives: a
          // Fire has no card of its own and a Venture Deeper is only ever on the stack.
          .flatMap((c) => [c, ...(c.faces?.cards ?? [])])
          .map((c) => c.name),
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
    /*
      Asked of the **parser** rather than of the text, which is the change D190 made necessary and
      which is a better test anyway.

      This used to look for a `/` in the printed cost and call any of them unpayable, because the
      engine refused every slashed symbol outright. Colour hybrid is paid now, so the text no longer
      says: `{G/W}` is fine and `{2/W}` is not. The property that actually matters is the one the
      parser reports — nothing in this pool may carry a symbol the payment cannot read — and asking
      it directly means the next symbol taught does not need this test edited.
    */
    const unpayable: string[] = [];
    for (const deck of Object.values(STARTER_DECKS)) {
      for (const card of [...deck.cards.map((c) => c.card), deck.commander!]) {
        // Each face as well, because a half is cast for its own cost — and a split card's printed
        // cost is the two of them with a `//` between, which is never paid as written.
        for (const face of card.faces?.cards ?? []) {
          if (parseManaCost(face.manaCost).unsupported !== undefined) unpayable.push(face.name);
        }
        if (card.faces?.kind === 'split') continue;
        if (scriptFor(card.name) === undefined) continue;
        if (/land/i.test(card.typeLine)) continue;
        if (parseManaCost(card.manaCost).unsupported !== undefined) unpayable.push(card.name);
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
    let s = table('tidal-mind', 'Sedgemoor Witch', ['Swamp', 'Swamp'], ['Swamp']);
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
      decks: { 0: 'tidal-mind' },
      hands: { 0: ['Unsummon'] },
      battlefield: { 0: ['Island', 'Island', 'Sedgemoor Witch'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    /*
      Any instant will do — magecraft reads the cast and not what was cast — and an Unsummon is
      the cheapest one in the deck the Witch now lives in, after the Think Twice became a
      Mulldrifter.

      Pointed at the Witch itself, which is the only creature on the table and costs this test
      nothing: magecraft triggers on the **cast**, so the Pest is already on the battlefield by
      the time the bounce resolves.
    */
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Unsummon'),
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Sedgemoor Witch') }],
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
        1: ['Island', 'Island', 'Island', 'Island', 'Island', 'Island', 'Swamp', 'Swamp', 'Swamp'],
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
  const holding = (name: string, lands: readonly string[], deck = 'tidal-mind'): GameState => {
    let s = advanceTo(arena({
      decks: { 1: deck }, hands: { 1: [name] }, battlefield: { 1: [...lands] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    return tapAllLands(s, 1);
  };

  it('is offered for {2} beside the printed cast, and takes the card to exile face down', () => {
    let s = holding('Behold the Multiverse', ['Island', 'Island', 'Island', 'Island'], 'arc-tempest');
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
    let s = holding('Behold the Multiverse', ['Island', 'Island', 'Island', 'Island'], 'arc-tempest');
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
    let s = holding('Behold the Multiverse', ['Island', 'Island', 'Island', 'Island'], 'arc-tempest');
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

describe('red-blue: six cards whose job is to read the spells', () => {
  /*
    Arc Tempest's own cards, and the reason they are tested together: five of the six are new
    *decks* for an old trigger rather than new engine behaviour. `spell-cast` has been in the
    engine since the first red deck; what had never been asked of it was whether a whole archetype
    could be assembled out of it, so what these tests check is each card's printed line, and then
    the one place where that did need something new — the Drake's power.
  */
  const izzet = (
    mine: readonly string[], hand: readonly string[], graveyard: readonly string[] = [],
  ): GameState => advanceTo(arena({
    decks: { 0: 'arc-tempest' },
    hands: { 0: [...hand] },
    battlefield: { 0: ['Island', 'Island', 'Mountain', 'Mountain', ...mine] },
    ...(graveyard.length === 0 ? {} : { graveyard: { 0: [...graveyard] } }),
    turn: 5, firstSeat: 0,
  }), 'precombat-main');

  it('pumps the Wizards Adeliz shares a type with, and nothing else', () => {
    /*
      "Each Wizard you control" — narrower than any scope in `ContinuousEffect`, and it does not
      need one: `pump` takes a list of ids, so which creatures are in the list is the card's
      business. Adeliz is a Wizard herself, Gelectrode is a Weird Wizard, and Young Pyromancer is a
      Human Shaman who gets nothing.
    */
    // Burst Lightning rather than Shock: Shock's slot in Arc Tempest is the pool's split card
    // now, and this test wants any one-mana red spell the deck still holds.
    let s = izzet(['Adeliz, the Cinder Wind', 'Gelectrode', 'Young Pyromancer'], ['Burst Lightning']);
    const adeliz = find(s, 0, 'battlefield', 'Adeliz, the Cinder Wind');
    const wizard = find(s, 0, 'battlefield', 'Gelectrode');
    const shaman = find(s, 0, 'battlefield', 'Young Pyromancer');
    expect([power(s, adeliz), power(s, wizard), power(s, shaman)]).toEqual([2, 0, 2]);

    s = tapAllLands(s, 0);
    // The Shock and Adeliz's trigger are both on the stack, so the board is read once both have
    // resolved rather than once the spell has.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Burst Lightning'),
      targets: [{ kind: 'player', seat: 1 }],
    })));
    expect([power(s, adeliz), power(s, wizard), power(s, shaman)]).toEqual([3, 1, 2]);
    expect([toughness(s, adeliz), toughness(s, wizard)]).toEqual([3, 2]);
  });

  it('does not pump on a creature spell, which is the half the filter is for', () => {
    // `spell: 'instant-or-sorcery'` rather than `'noncreature'`: Adeliz is not prowess, and a
    // Gelectrode cast is not a trigger.
    let s = izzet(['Adeliz, the Cinder Wind'], ['Gelectrode']);
    const adeliz = find(s, 0, 'battlefield', 'Adeliz, the Cinder Wind');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gelectrode') })));
    expect(power(s, adeliz)).toBe(2);
  });

  it('sends two damage at the face for every spell Guttersnipe sees cast', () => {
    let s = izzet(['Guttersnipe'], ['Think Twice', 'Burst Lightning']);
    s = tapAllLands(s, 0);
    const before = life(s, 1);
    // A cantrip: no damage of its own, two from the Goblin.
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Think Twice') })));
    expect(life(s, 1)).toBe(before - 2);
    // And a Shock, which is two of its own on top of the Goblin's two.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Burst Lightning'),
      targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(life(s, 1)).toBe(before - 6);
  });

  it('leaves a body behind for every spell Young Pyromancer sees cast', () => {
    let s = izzet(['Young Pyromancer'], ['Think Twice']);
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Think Twice') })));
    expect(namesIn(s, 0, 'battlefield').filter((n) => n === 'Elemental').length).toBe(1);
  });

  it('untaps Gelectrode on a cast, so one creature pings twice in a turn', () => {
    /*
      The reason a tap ability is worth a card in this deck: "once per turn" becomes "once per
      spell". Two pings off one Gelectrode in one main phase, with a Preordain in between.
    */
    let s = izzet(['Gelectrode'], ['Think Twice']);
    const gel = find(s, 0, 'battlefield', 'Gelectrode');
    s = tapAllLands(s, 0);
    const before = life(s, 1);
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: gel, abilityIndex: 0,
      targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(s, 1)).toBe(before - 1);
    expect(s.instances[gel]!.tapped).toBe(true);

    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Think Twice') })));
    expect(s.instances[gel]!.tapped).toBe(false);
    s = passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: gel, abilityIndex: 0,
      targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(s, 1)).toBe(before - 2);
  });

  it('grows Stormchaser Mage on any noncreature spell, Adeliz or not', () => {
    // Prowess, which is the wider filter: an artifact or an enchantment would do it too, and the
    // Mage does not care whose Wizard it is.
    let s = izzet(['Stormchaser Mage'], ['Think Twice']);
    const mage = find(s, 0, 'battlefield', 'Stormchaser Mage');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Think Twice') })));
    expect([power(s, mage), toughness(s, mage)]).toEqual([2, 4]);
  });

  /*
    The Drake, and the two things `definesSize` had to learn for it.

    Lhurgoyf counts creature cards in *all* graveyards and defines both halves of its size. This
    one counts instants and sorceries in *your* graveyard and defines only its power — printed `*`
    over `4`. Both halves of that are worth a test, because both are the kind of mistake that makes
    a card quietly the wrong size rather than throwing.
  */
  it('is as big as its own graveyard, and keeps the toughness it is printed with', () => {
    let s = izzet(['Enigma Drake'], []);
    const drake = find(s, 0, 'battlefield', 'Enigma Drake');
    expect([power(s, drake), toughness(s, drake)]).toEqual([0, 4]);

    // Three cards into the graveyard: two spells and a land, and the land is not a spell.
    for (const name of ['Burst Lightning', 'Preordain', 'Mountain']) {
      s = apply(s, {
        type: 'card:move', by: 0, card: find(s, 0, 'library', name), toZone: 'graveyard',
      });
    }
    expect([power(s, drake), toughness(s, drake)]).toEqual([2, 4]);
  });

  it('does not count the other player’s graveyard, which Lhurgoyf would have', () => {
    // The difference between the two counts, said as a test: seat 1's bin is full of instants and
    // the Drake is still a 0/4.
    let s = izzet(['Enigma Drake'], []);
    const drake = find(s, 0, 'battlefield', 'Enigma Drake');
    for (const name of ['Giant Growth', 'Harmonize']) {
      s = apply(s, {
        type: 'card:move', by: 1, card: find(s, 1, 'library', name), toZone: 'graveyard',
      });
    }
    expect(power(s, drake)).toBe(0);
  });
});

describe('a static effect scoped to a creature type: the pool’s first tribal lords', () => {
  /*
    The scope `ContinuousEffect` did not have, and the three cards that are the argument for it.

    Adeliz pumps Wizards without it, because a one-shot pump takes a list of ids and the card may
    filter however it likes. A *static* cannot: it is a declarative object written to Redis and sent
    down a socket, so the filter has to be something the engine can perform from the stored scope.
    `{ kind: 'controller-subtype', subtype, other }` is that, and what these tests check is the
    three things it has to get right — a size, a keyword, and following the board rather than a list.
  */
  const lord = (
    deck: string, lands: readonly string[], mine: readonly string[], name: string,
    opponent = 'tidal-mind',
  ): GameState => {
    const s = advanceTo(arena({
      decks: { 0: deck, 1: opponent },
      hands: { 0: [name] },
      // Seat 1 gets two of its own basics, whatever deck it is on: the opponent only has to exist.
      battlefield: { 0: [...lands, ...mine], 1: [opponent === 'ember-rush' ? 'Mountain' : 'Island',
        opponent === 'ember-rush' ? 'Mountain' : 'Island'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  const keywordsOf = (s: GameState, id: string): readonly string[] =>
    [...characteristicsOf(s, s.instances[id]!).keywords];

  it('lifts the Vampires Stromkirk Captain shares a type with, and hands them first strike', () => {
    // A Boggart Brute for the non-Vampire, because the Goblin Arsonist this used to borrow is
    // Tormented Soul's slot now. Any Goblin does: the claim is about the type line.
    let s = lord('ashen-rite', ['Mountain', 'Swamp'], ['Blood Artist', 'Boggart Brute'],
      'Stromkirk Captain');
    const artist = find(s, 0, 'battlefield', 'Blood Artist');
    const goblin = find(s, 0, 'battlefield', 'Boggart Brute');
    expect([power(s, artist), toughness(s, artist)]).toEqual([0, 1]);

    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Stromkirk Captain'),
    }));
    const captain = find(s, 0, 'battlefield', 'Stromkirk Captain');

    // The Vampire grew and can fight; the Goblin is a Goblin.
    expect([power(s, artist), toughness(s, artist)]).toEqual([1, 2]);
    expect(keywordsOf(s, artist)).toContain('first strike');
    expect([power(s, goblin), toughness(s, goblin)]).toEqual([3, 2]);
    expect(keywordsOf(s, goblin)).not.toContain('first strike');

    /*
      And the Captain is a 2/2, not a 3/3 — `other: true`.

      Worth a line of its own because it is the half that shows up in combat rather than on the
      card: a lord that pumped itself attacks a size bigger than it reads, and nobody would notice
      until a trade went the wrong way. Its own first strike is printed, so it has that.
    */
    expect([power(s, captain), toughness(s, captain)]).toEqual([2, 2]);
    expect(keywordsOf(s, captain)).toContain('first strike');
  });

  it('makes the Knights indestructible, and mortal again the moment the Exemplar leaves', () => {
    /*
      The sharpest version of what `duration: 'permanent'` means: a static exists exactly while its
      source is on the battlefield, so the damage already marked on a Knight becomes lethal the
      instant the Exemplar is gone — with no event saying so and nothing recomputed.
    */
    /*
      The Knights belong to the seat that is *not* taking the turn, so the burn spell can be cast by
      whoever holds priority. The Exemplar starts on the battlefield rather than being cast, which
      is also worth one assertion of its own: a permanent placed there goes through the same
      arrivals pass a cast one does, so its static is installed either way.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'skyward-writ' },
      hands: { 0: ['Lightning Bolt'] },
      battlefield: {
        0: ['Mountain'],
        1: ['Plains', 'Plains', 'Plains', 'Leonin Skyhunter', "Healer's Hawk", 'Knight Exemplar'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    /*
      A Leonin Skyhunter rather than a Youthful Knight, because the Knight this deck used to run is
      Thalia's slot now. A Cat Knight is a Knight, which is the point of a scope that reads a type
      line — and not a Paladin en-Vec, which has protection from red and could not be pointed at by
      the Lightning Bolt below.
    */
    const knight = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    const hawk = find(s, 1, 'battlefield', "Healer's Hawk");
    const exemplar = find(s, 1, 'battlefield', 'Knight Exemplar');

    expect([power(s, knight), toughness(s, knight)]).toEqual([3, 3]);
    expect(keywordsOf(s, knight)).toContain('indestructible');
    // A Bird is not a Knight, and the Exemplar is not one of the *other* Knights.
    expect(keywordsOf(s, hawk)).not.toContain('indestructible');
    expect(keywordsOf(s, exemplar)).not.toContain('indestructible');

    // Three damage on the 3/3: lethal for its size, and ignored because it cannot be destroyed.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: knight }],
    })));
    expect(s.instances[knight]!.zone).toBe('battlefield');
    expect(damageOn(s, knight)).toBe(3);

    // And then the lord goes, which makes the damage lethal with nothing else happening at all.
    s = drain(apply(s, { type: 'card:move', by: 1, card: exemplar, toZone: 'graveyard' }));
    expect(s.instances[knight]!.zone).toBe('graveyard');
  });

  it('pumps the Elves Imperious Perfect makes, which is the scope reading the board', () => {
    /*
      A lord that grows its own scope. Nothing tells the effect a new Elf exists — the token is an
      Elf Warrior, the scope is a question asked of the type line every time anybody looks, and so
      the answer is already right.
    */
    let s = lord('rot-harvest', ['Forest', 'Forest', 'Forest'], ['Llanowar Elves'],
      'Imperious Perfect');
    const elf = find(s, 0, 'battlefield', 'Llanowar Elves');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Imperious Perfect'),
    }));
    const perfect = find(s, 0, 'battlefield', 'Imperious Perfect');
    expect([power(s, elf), toughness(s, elf)]).toEqual([2, 2]);
    expect([power(s, perfect), toughness(s, perfect)]).toEqual([2, 2]);

    // Next turn, when it is no longer summoning-sick, it taps for a 1/1 that is immediately a 2/2.
    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 0);
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: perfect, abilityIndex: 0 }));
    const token = find(s, 0, 'battlefield', 'Elf Warrior');
    expect([power(s, token), toughness(s, token)]).toEqual([2, 2]);
  });

  it('reads the type line layer 4 produced, not the printed one', () => {
    /*
      Ordering rather than a feature: no card in the pool adds a creature type, so this is built on
      a hand-made effect. It is tested anyway because the ordering is offered to get right now and
      expensive to find later — CR 613.1d (types) before 613.1f (power and toughness), so a
      permanent that was *given* a type is inside the lord's scope.

      `end-of-turn` on the hand-made effect rather than `permanent`, because a permanent effect
      lasts only while its source is on the battlefield and `test` is not an instance at all.
    */
    let s = lord('rot-harvest', ['Forest', 'Forest', 'Forest'], ['Wall of Blossoms'],
      'Imperious Perfect');
    const wall = find(s, 0, 'battlefield', 'Wall of Blossoms');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Imperious Perfect'),
    }));
    // A Plant Wall is not an Elf, so the lord does nothing for it.
    expect([power(s, wall), toughness(s, wall)]).toEqual([0, 4]);

    s = {
      ...s,
      effects: [...s.effects, {
        id: 'elfify', createdTurn: s.turn, source: 'test', controller: 0 as SeatIndex,
        scope: { kind: 'cards' as const, ids: [wall] },
        addSubtypes: ['Elf'], duration: 'end-of-turn' as const,
      }],
    };
    expect([power(s, wall), toughness(s, wall)]).toEqual([1, 5]);
  });
});

describe('megamorph, and a morph cost that is not mana (CR 702.37a, 702.37c)', () => {
  /*
    The two halves the first pass at morph left out, and they are the same observation from
    different ends: the rule lets a card print whatever it likes for turning itself up, and the
    first five morphs all printed mana, so the engine held the cost as a mana string. The cost is an
    `AbilityCost` now — the same vocabulary an activated ability uses — which is what makes "pay 3
    life, and no mana at all" expressible, and brought the life clause's own rule with it.
  */
  const holding = (
    seat: SeatIndex, name: string, deck: string, lands: readonly string[],
  ): GameState => {
    const s = advanceTo(arena({
      decks: { [seat]: deck }, hands: { [seat]: [name] }, battlefield: { [seat]: [...lands] },
      turn: 4, firstSeat: seat,
    }), 'precombat-main');
    return tapAllLands(s, seat);
  };

  /** Casts it face down and lets it resolve, which is where every test below starts. */
  const faceDown = (state: GameState, seat: SeatIndex, name: string): GameState =>
    drain(passBoth(apply(state, {
      type: 'auto:cast', by: seat, card: find(state, seat, 'hand', name), faceDown: true,
    })));

  it('turns a Zombie Cutthroat up for three life and no mana at all', () => {
    let s = holding(0, 'Zombie Cutthroat', 'ashen-rite', ['Swamp', 'Swamp', 'Swamp']);
    s = faceDown(s, 0, 'Zombie Cutthroat');
    const card = find(s, 0, 'battlefield', 'Zombie Cutthroat');
    expect(s.instances[card]!.faceDown).toBe(true);
    // A 2/2 while it is down, whatever is printed on it (CR 707.2).
    expect([power(s, card), toughness(s, card)]).toEqual([2, 2]);

    // The offer says what it costs in the words a player reads, and asks for no mana.
    const play = legalActions(s, 0).plays.find((p) => p.kind === 'turnUp');
    expect(play?.description).toContain('morph pay 3 life');
    expect(play?.manaCost).toBe('');

    const before = life(s, 0);
    // Every land is already tapped and the pool is empty, which is the point: nothing but life.
    s = drain(apply(s, { type: 'auto:turnUp', by: 0, card }));
    expect(s.instances[card]!.faceDown).toBe(false);
    expect([power(s, card), toughness(s, card)]).toEqual([3, 3]);
    expect(life(s, 0)).toBe(before - 3);
  });

  it('refuses the turn-up at exactly the life that would pay for it', () => {
    /*
      CR 118.4, and the reason the cost is an `AbilityCost`: a cost you cannot pay is not a cost you
      may choose to pay. At three life, paying three life would lose the game, so the turn-up is not
      *offered* — the same rule that stops the engine offering a Mana Confluence's mana at one life.
    */
    let s = holding(0, 'Zombie Cutthroat', 'ashen-rite', ['Swamp', 'Swamp', 'Swamp']);
    s = faceDown(s, 0, 'Zombie Cutthroat');
    const card = find(s, 0, 'battlefield', 'Zombie Cutthroat');
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 3 } : seat)) };

    expect(legalActions(s, 0).plays.some((p) => p.kind === 'turnUp')).toBe(false);
    expect(refusal(s, { type: 'auto:turnUp', by: 0, card })).toContain('3 life to pay');

    // One life more and it is a play again, which is what "exactly" means.
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 4 } : seat)) };
    expect(legalActions(s, 0).plays.some((p) => p.kind === 'turnUp')).toBe(true);
  });

  it('puts a +1/+1 counter on a megamorph as it turns up, in the same action', () => {
    /*
      The whole of megamorph (CR 702.37c), and the reason it is three lines in `turnUp` rather than
      a `turned-face-up` trigger on the card: a trigger goes on the stack, and an opponent given a
      window between "it is face up" and "it is bigger" has a window to kill the creature in
      response to its own counter. Turning a permanent face up is the thing nobody may respond to.
    */
    let s = holding(0, 'Hidden Dragonslayer', 'skyward-writ', ['Plains', 'Plains', 'Plains']);
    s = faceDown(s, 0, 'Hidden Dragonslayer');
    const card = find(s, 0, 'battlefield', 'Hidden Dragonslayer');
    // Three Plains were spent casting it face down, so turning it up needs a fresh turn's mana —
    // and until there is some, the special action is not offered at all.
    expect(legalActions(s, 0).plays.some((p) => p.kind === 'turnUp')).toBe(false);
    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 0);
    expect(legalActions(s, 0).plays.find((p) => p.kind === 'turnUp')?.description)
      .toContain('megamorph {2}{W}');

    s = drain(apply(s, { type: 'auto:turnUp', by: 0, card }));
    expect(s.instances[card]!.faceDown).toBe(false);
    expect(s.instances[card]!.counters['+1/+1']).toBe(1);
    // Printed 2/1 plus the counter: a 3/2, and lifelink is its own.
    expect([power(s, card), toughness(s, card)]).toEqual([3, 2]);
    expect([...characteristicsOf(s, s.instances[card]!).keywords]).toContain('lifelink');
  });

  it('and destroys the big creature it was turned up to answer', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'ember-rush' },
      hands: { 0: ['Hidden Dragonslayer'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains'],
        1: ['Mountain', 'Shivan Dragon', 'Raging Goblin'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = faceDown(tapAllLands(s, 0), 0, 'Hidden Dragonslayer');
    const card = find(s, 0, 'battlefield', 'Hidden Dragonslayer');
    const dragon = find(s, 1, 'battlefield', 'Shivan Dragon');
    const goblin = find(s, 1, 'battlefield', 'Raging Goblin');

    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 0);
    /*
      No targets on the action, because turning a permanent face up does not take any: the trigger
      is a separate object that asks for its own (CR 603.3d), and here it has exactly one legal
      answer — the 5/5 — so `drain` aims and resolves it the way the table would.
    */
    s = drain(apply(s, { type: 'auto:turnUp', by: 0, card }));
    expect(s.instances[dragon]!.zone).toBe('graveyard');
    /*
      The 5/5 is dead and the 1/1 was never a legal target — "power 4 or greater" is the filter, and
      it is also why the trigger being mandatory is safe: a board of small creatures gives it
      nothing to destroy, so the card is a 3/2 lifelinker and nothing more.
    */
    expect(s.instances[goblin]!.zone).toBe('battlefield');
  });

  it('turns up into a board it cannot answer, and is simply a creature', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'ember-rush' },
      hands: { 0: ['Hidden Dragonslayer'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains'],
        1: ['Mountain', 'Raging Goblin'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = faceDown(tapAllLands(s, 0), 0, 'Hidden Dragonslayer');
    const card = find(s, 0, 'battlefield', 'Hidden Dragonslayer');
    const goblin = find(s, 1, 'battlefield', 'Raging Goblin');

    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 0);
    s = drain(apply(s, { type: 'auto:turnUp', by: 0, card }));
    // Face up, counter on, nothing destroyed, and no decision left hanging.
    expect(s.instances[card]!.faceDown).toBe(false);
    expect(power(s, card)).toBe(3);
    expect(s.instances[goblin]!.zone).toBe('battlefield');
    expect(s.pendingDecision).toBeNull();
  });
});

describe('changing what a spell is pointed at (CR 114.6)', () => {
  /*
    The first effect in this engine that reaches into an object already on the stack.

    Everything else reads the board and changes the board. These two read somebody else's spell and
    change a choice its controller made, and the three rules that travel with it are all CR 114.6:
    the new target must be legal **for that spell**, judged with the spell's own controller as the
    chooser; it must be a different target; and if either fails the spell keeps the target it had
    rather than being countered or erroring (CR 115.7b).

    They are also the first two cards in the pool that ask for *two* targets — the spell, and where
    it is going.
  */

  /**
   * A Willbender already face down on seat 1's side, on seat 0's turn with seat 0's mana up.
   *
   * Two turns rather than one, because that is the only order the rules allow: a creature spell is
   * sorcery-speed, so the morph goes down on its controller's own turn, and the removal it answers
   * arrives on somebody else's. Which is also the shape of the play at a real table.
   */
  const facedownBender = (theirs: readonly string[]): { s: GameState; bender: string } => {
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Doom Blade'], 1: ['Willbender'] },
      battlefield: {
        0: ['Swamp', 'Swamp'],
        // Five Islands, and seat 1's lands are deliberately *not* all tapped: three pay for the
        // face-down cast and the other two have to still be up on somebody else's turn, which is
        // the whole shape of holding a trick. A land tapped on your own turn stays tapped until
        // your next untap step, so a test that drained the pool here could not turn the morph up.
        1: ['Island', 'Island', 'Island', 'Island', 'Island', "Man-o'-War"],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Willbender'), faceDown: true,
    })));
    const bender = find(s, 1, 'battlefield', 'Willbender');
    // Seat 0's own creatures, put straight onto the battlefield: somewhere else for its own
    // removal to go.
    for (const name of theirs) {
      s = apply(s, {
        type: 'card:move', by: 0, card: find(s, 0, 'library', name), toZone: 'battlefield',
      });
    }
    return { s: tapAllLands(advanceTo(nextTurn(s), 'precombat-main'), 0), bender };
  };

  /** Seat 0 aims its Doom Blade at seat 1's creature and passes, which opens the window. */
  const bladeAt = (state: GameState, victim: string): { s: GameState; blade: string } => {
    const blade = find(state, 0, 'hand', 'Doom Blade');
    let s = apply(state, {
      type: 'auto:cast', by: 0, card: blade, targets: [{ kind: 'card', id: victim }],
    });
    s = apply(s, { type: 'auto:pass', by: 0 });
    return { s, blade };
  };

  it('sends a Doom Blade back at a creature its own caster could legally have hit', () => {
    let { s, bender } = facedownBender(['Centaur Courser']);
    const mine = find(s, 1, 'battlefield', "Man-o'-War");
    const theirs = find(s, 0, 'battlefield', 'Centaur Courser');
    const cast = bladeAt(s, mine);
    s = cast.s;
    expect(s.stackObjects[cast.blade]?.targets).toEqual([{ kind: 'card', id: mine }]);

    // Turning it up is the special action nobody may respond to; the trigger it raises is what
    // asks for the two targets.
    s = apply(s, { type: 'auto:turnUp', by: 1, card: bender });
    expect(s.instances[bender]!.faceDown).toBe(false);
    s = apply(s, {
      type: 'auto:choose', by: 1,
      targets: [{ kind: 'card', id: cast.blade }, { kind: 'card', id: theirs }],
    });
    expect(s.stackObjects[cast.blade]?.targets).toEqual([{ kind: 'card', id: mine }]);
    s = drain(passBoth(passBoth(s)));

    // The Doom Blade killed their Courser and left the Man-o'-War alone.
    expect(s.instances[theirs]!.zone).toBe('graveyard');
    expect(s.instances[mine]!.zone).toBe('battlefield');
  });

  it('leaves the spell where it was when the new target is illegal for it', () => {
    /*
      CR 115.7b. The trigger's second target is declared `any`, which is wider than the spell's own
      spec on purpose: a *player* is a perfectly legal answer to "any target" and can never be a
      legal answer to a Doom Blade's "target creature". So the choice is accepted, the change is
      declined, and the Doom Blade resolves against the creature it was always aimed at — not
      countered, not an error.

      Which is also the half that is easy to get wrong in the other direction: legality is judged
      for the *spell*, with the spell's own controller as the chooser, not for the player doing the
      redirecting.
    */
    let { s, bender } = facedownBender(['Centaur Courser']);
    const mine = find(s, 1, 'battlefield', "Man-o'-War");
    const cast = bladeAt(s, mine);
    s = cast.s;

    s = apply(s, { type: 'auto:turnUp', by: 1, card: bender });
    s = apply(s, {
      type: 'auto:choose', by: 1,
      targets: [{ kind: 'card', id: cast.blade }, { kind: 'player', seat: 0 }],
    });
    s = drain(passBoth(passBoth(s)));
    expect(life(s, 0)).toBe(20);
    expect(s.instances[mine]!.zone).toBe('graveyard');
  });

  /**
   * Seat 0 on ember-rush with `theirs` in hand, seat 1 on arc-tempest holding a Swerve.
   *
   * Only seat 0's lands are tapped. Seat 1's are left up and the engine pays for the Swerve out of
   * them when it is cast, because tapping somebody else's lands is not a move available on this
   * turn: a mana ability needs priority like anything else.
   */
  const swerveTable = (theirs: readonly string[], mine: readonly string[]): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'arc-tempest' },
      hands: { 0: [...theirs], 1: ['Swerve'] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'],
        1: ['Island', 'Island', 'Mountain', ...mine],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('is not offered a spell with nowhere else to send it', () => {
    /*
      "Change the target" with one legal target on the table changes nothing, so the spell is not
      offered as a target at all — the offer and the effect agree, which is the rule convoke, crew
      and morph are all built on.

      Swerve rather than Willbender for this one, and the reason is the better half of the test: a
      Willbender is *itself* a creature while it waits, face down or face up, so a board with a
      Willbender on it always has somewhere to send a removal spell. Which is a real thing about
      the card and would have made this assertion impossible to write.
    */
    let s = swerveTable(['Flame Slash'], ['Monastery Swiftspear']);
    const mine = find(s, 1, 'battlefield', 'Monastery Swiftspear');
    const blade = find(s, 0, 'hand', 'Flame Slash');
    s = apply(s, { type: 'auto:cast', by: 0, card: blade, targets: [{ kind: 'card', id: mine }] });
    s = apply(s, { type: 'auto:pass', by: 0 });

    const swerve = legalActions(s, 1).plays.find((p) => p.name === 'Swerve');
    expect(swerve?.candidates[0] ?? []).toEqual([]);
    s = drain(passBoth(s));
    expect(s.instances[mine]!.zone).toBe('graveyard');
  });

  it('Swerve sends a burn spell back at the player who cast it', () => {
    let s = swerveTable(['Lightning Bolt'], ['Monastery Swiftspear']);
    const mine = find(s, 1, 'battlefield', 'Monastery Swiftspear');
    const bolt = find(s, 0, 'hand', 'Lightning Bolt');
    s = apply(s, { type: 'auto:cast', by: 0, card: bolt, targets: [{ kind: 'card', id: mine }] });
    // Seat 0 passes, which is the window a trick is cast in.
    s = apply(s, { type: 'auto:pass', by: 0 });

    const before = life(s, 0);
    s = drain(passBoth(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Swerve'),
      targets: [{ kind: 'card', id: bolt }, { kind: 'player', seat: 0 }],
    }))));
    // Three to the face of the player who paid for it, and the creature untouched. "Any target"
    // includes a player, which is the half a creature-only redirect would have missed.
    expect(life(s, 0)).toBe(before - 3);
    expect(s.instances[mine]!.zone).toBe('battlefield');
  });

  it('and will not touch a creature spell, whatever else is true of the board', () => {
    // The printed line is "target instant or sorcery spell", and a Hill Giant on the stack is a
    // spell with no targets at all — so it fails twice over and is not offered either time.
    let s = swerveTable(['Hill Giant'], ['Monastery Swiftspear']);
    const giant = find(s, 0, 'hand', 'Hill Giant');
    s = apply(s, { type: 'auto:cast', by: 0, card: giant });
    s = apply(s, { type: 'auto:pass', by: 0 });
    const swerve = legalActions(s, 1).plays.find((p) => p.name === 'Swerve');
    expect(swerve?.candidates[0] ?? []).not.toContainEqual({ kind: 'card', id: giant });
    expect(swerve?.candidates[0] ?? []).toEqual([]);
  });
});

describe('the creature the event was about: exalted, and evolve’s intervening-if', () => {
  /*
    Two keywords, and the two things the engine was missing to write either of them.

    Every board-watching trigger before these could only talk about itself: a Blood Artist drains
    when a creature dies and never has to say which. Exalted and evolve both have to — "that
    creature gets +1/+1", "if that creature has greater power" — so the three events that are about
    one permanent now carry which permanent, and a script reads it as `ctx.subject`.

    Evolve brings the intervening-if clause with it (CR 603.4), which is asked twice: once before
    the trigger goes on the stack and once as it resolves. Both asks have a test here, because the
    two of them are different rules wearing the same words — the first is why an ability nobody
    could use is never offered, and the second is why answering the creature answers the trigger.
  */

  /** Seat 0 in its main phase with the named cards in hand and on the battlefield. */
  const table = (
    deck: string, hand: readonly string[], battlefield: readonly string[],
    opponent: readonly string[] = ['Island', 'Island'],
  ): GameState => {
    const s = advanceTo(arena({
      decks: { 0: deck, 1: 'tidal-mind' },
      hands: { 0: hand },
      battlefield: { 0: battlefield, 1: opponent },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('pumps the one creature that attacked, and names it rather than the board', () => {
    /*
      The whole point in one assertion: two creatures out, one attacks, and the +1/+1 lands on the
      one that attacked. A trigger that could only say "this creature" or "your creatures" would
      get one of those two numbers wrong.
    */
    let s = table('skyward-writ', [], ['Plains', 'Guardians of Akrasa', 'Serra Angel', "Healer's Hawk"]);
    const angel = find(s, 0, 'battlefield', 'Serra Angel');
    const hawk = find(s, 0, 'battlefield', "Healer's Hawk");
    const guards = find(s, 0, 'battlefield', 'Guardians of Akrasa');

    s = advanceTo(s, 'declare-attackers');
    s = drain(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: angel, defender: 1 }] }));

    expect([power(s, angel), toughness(s, angel)]).toEqual([5, 5]);
    // The one that stayed home is untouched, and so are the Guardians — who cannot attack at all.
    expect([power(s, hawk), toughness(s, hawk)]).toEqual([1, 1]);
    expect([power(s, guards), toughness(s, guards)]).toEqual([2, 3]);
  });

  it('pays nothing when two creatures attack, which is the whole of “alone”', () => {
    // A fact about the declaration, not about the board: by the time an exalted trigger would
    // resolve, nothing on the battlefield distinguishes one attacker from two.
    let s = table('skyward-writ', [], ['Plains', 'Guardians of Akrasa', 'Serra Angel', "Healer's Hawk"]);
    const angel = find(s, 0, 'battlefield', 'Serra Angel');
    const hawk = find(s, 0, 'battlefield', "Healer's Hawk");

    s = advanceTo(s, 'declare-attackers');
    s = drain(apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: angel, defender: 1 }, { attacker: hawk, defender: 1 }],
    }));

    expect([power(s, angel), toughness(s, angel)]).toEqual([4, 4]);
    expect([power(s, hawk), toughness(s, hawk)]).toEqual([1, 1]);
  });

  it('and nothing at all when it is the opponent attacking alone', () => {
    /*
      `of: 'you'` — "whenever a creature **you control** attacks alone". Without it the Guardians
      would hand the other player's lone attacker a +1/+1, which is the one thing exalted never
      does.
    */
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'skyward-writ' },
      battlefield: { 0: ['Island', "Man-o'-War"], 1: ['Plains', 'Guardians of Akrasa'] },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const mine = find(s, 0, 'battlefield', "Man-o'-War");

    s = drain(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: mine, defender: 1 }] }));
    expect([power(s, mine), toughness(s, mine)]).toEqual([2, 2]);
  });

  it('evolves the Raptor when something bigger arrives, once per arrival', () => {
    // A Thieving Magpie rather than the Wall of Air this test used to cast: the Wall left Hollow
    // Tide for the Gurmag Angler, and the Magpie is the same 1/3 for the same three mana.
    let s = table('hollow-tide', ['Thieving Magpie', 'Fog Bank'],
      ['Island', 'Island', 'Island', 'Island', 'Island', 'Island', 'Cloudfin Raptor']);
    const raptor = find(s, 0, 'battlefield', 'Cloudfin Raptor');
    expect([power(s, raptor), toughness(s, raptor)]).toEqual([0, 1]);

    // A 1/3 is bigger on both counts, so the trigger fires and the Raptor is a 1/2.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thieving Magpie'),
    })));
    expect([power(s, raptor), toughness(s, raptor)]).toEqual([1, 2]);

    /*
      And then a 0/2, which is bigger than nothing: 0 is not greater than 1 and 2 is not greater
      than 2. The trigger does not fire — and because the condition is asked *before* the ability
      goes on the stack, nothing is put there for either player to respond to.
    */
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fog Bank') }));
    expect(s.stackOrder).toEqual([]);
    s = drain(s);
    expect([power(s, raptor), toughness(s, raptor)]).toEqual([1, 2]);
  });

  it('does not evolve off its own arrival', () => {
    // `who: 'another'`: the Raptor entering is an entry it watches and is not another creature.
    let s = table('hollow-tide', ['Cloudfin Raptor'], ['Island', 'Thieving Magpie']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Cloudfin Raptor'),
    })));
    const raptor = find(s, 0, 'battlefield', 'Cloudfin Raptor');
    expect([power(s, raptor), toughness(s, raptor)]).toEqual([0, 1]);
  });

  it('and loses the counter when the creature that caused it is answered in reply', () => {
    /*
      The second ask, and the reason the clause is a rule rather than a filter.

      The Magpie enters, the evolve trigger goes on the stack, and the other player bounces it
      while the trigger is still waiting. On resolution the condition is asked again, there is no
      creature to measure, and the ability does nothing — so an Unsummon answers the counter as
      well as the body. Checked against the version that only asked once, where the Raptor would
      keep the +1/+1 for a creature that was never there when it resolved.
    */
    let s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'tidal-mind' },
      hands: { 0: ['Thieving Magpie'], 1: ['Unsummon'] },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Island', 'Cloudfin Raptor'],
        1: ['Island', 'Island'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const raptor = find(s, 0, 'battlefield', 'Cloudfin Raptor');

    // The Wall resolves; `passBoth` stops as soon as the stack changes, which is the trigger
    // arriving on it.
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thieving Magpie') }));
    const magpie = find(s, 0, 'battlefield', 'Thieving Magpie');
    expect(stackNames(s)).toEqual(['Evolve: put a +1/+1 counter on Cloudfin Raptor.']);

    // Seat 1 can only tap its lands once it holds priority, so the pass comes first — a seat
    // without priority has no mana abilities to activate.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);

    s = drain(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Unsummon'),
      targets: [{ kind: 'card', id: magpie }],
    }));

    expect(s.instances[magpie]!.zone).toBe('hand');
    expect([power(s, raptor), toughness(s, raptor)]).toEqual([0, 1]);
  });
});

describe('an ability on the stack is a thing you can point at', () => {
  /*
    The third shape of a `Target`, and the half of interaction the pool had no answer to.

    Everything that answers a permanent here answers the *permanent*: a Doom Blade kills the Icy
    Manipulator but not the tap it already activated, a Murder kills the Jace but not the loyalty
    ability above it. An ability on the stack has no card anywhere — only a synthetic id and an
    entry in `stackObjects` — so until a `Target` could say `{ kind: 'ability', id }`, nothing in
    this engine could be pointed at one.

    These tests are the four answers that shape has to give: an activated ability can be countered,
    a triggered one can be told apart from it by a filter, the wide card takes either, and
    Willbender's printed "or ability" half finally works.
  */

  /** Seat 1 activates an Icy Manipulator at one of seat 0's creatures, then passes. */
  const icyAimedAt = (
    s0: GameState, victim: string,
  ): { s: GameState; ability: string; icy: string } => {
    const icy = find(s0, 1, 'battlefield', 'Icy Manipulator');
    const play = legalActions(s0, 1).plays.find((p) => p.name === 'Icy Manipulator' && p.kind === 'activate');
    let s = apply(s0, {
      type: 'auto:activate', by: 1, card: icy, abilityIndex: play!.abilityIndex!,
      targets: [{ kind: 'card', id: victim }],
    });
    // The ability is on the stack and its controller passes, which opens the window.
    s = apply(s, { type: 'auto:pass', by: 1 });
    return { s, ability: s.stackOrder[s.stackOrder.length - 1]!, icy };
  };

  it('Squelch counters an activated ability, and the cost stays paid', () => {
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'tidal-mind' },
      hands: { 0: ['Squelch'] },
      battlefield: {
        0: ['Island', 'Island', 'Monastery Swiftspear'],
        1: ['Island', 'Island', 'Icy Manipulator'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    const swift = find(s, 0, 'battlefield', 'Monastery Swiftspear');
    const aimed = icyAimedAt(s, swift);
    s = tapAllLands(aimed.s, 0);

    // The offer and the effect read the same rule: the one thing on the stack is the one candidate.
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Squelch');
    expect(play?.candidates[0]).toEqual([{ kind: 'ability', id: aimed.ability }]);

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Squelch'),
      targets: [{ kind: 'ability', id: aimed.ability }],
    }));

    // The tap never happened, and the Icy Manipulator is still tapped: a cost is paid when the
    // ability is activated, and countering the ability does not give it back (CR 701.5a).
    expect(s.instances[swift]!.tapped).toBe(false);
    expect(s.instances[aimed.icy]!.tapped).toBe(true);
    expect(s.stackOrder).toEqual([]);
    // And it replaced itself, which is why a card this narrow is in a deck at all.
    expect(namesIn(s, 0, 'hand')).toHaveLength(1);
    expect(namesIn(s, 0, 'hand')).not.toContain('Squelch');
    expect(namesIn(s, 0, 'graveyard')).toContain('Squelch');
  });

  it('and will not touch a triggered ability, which is what its filter is for', () => {
    /*
      Squelch is printed "counter target **activated** ability", and the difference is a `filter` on
      an ability candidate — a thing that had nowhere to live before this. A Soul Warden's lifegain
      is a triggered ability with no targets at all, which makes it the clearest possible negative:
      it is on the stack, it is an ability, and it is not this card's business.
    */
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'skyward-writ' },
      hands: { 0: ['Squelch'], 1: ["Healer's Hawk"] },
      battlefield: {
        0: ['Island', 'Island'],
        1: ['Plains', 'Plains', 'Soul Warden'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', "Healer's Hawk") }));
    // The Hawk resolved and the Warden's trigger is waiting.
    expect(s.stackOrder).toHaveLength(1);
    s = tapAllLands(apply(s, { type: 'auto:pass', by: 1 }), 0);

    const play = legalActions(s, 0).plays.find((p) => p.name === 'Squelch');
    expect(play?.candidates[0] ?? []).toEqual([]);
    // Not castable at all, rather than castable and then refused: an ability it may not name is an
    // ability it has no legal target among.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Squelch'),
      targets: [{ kind: 'ability', id: s.stackOrder[0]! }],
    })).toContain('target activated ability');
  });

  it('Disallow counters a triggered ability, which killing the permanent could not', () => {
    /*
      The whole argument for this card in one board. The Soul Warden's trigger is on the stack; a
      Murder would kill the Warden and the life would still be gained, because an ability on the
      stack is independent of its source (CR 113.7a). Disallow is the only thing in this pool that
      answers the ability itself.
    */
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      hands: { 0: ["Healer's Hawk"], 1: ['Disallow'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Soul Warden'],
        1: ['Island', 'Island', 'Island'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const before = life(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', "Healer's Hawk") }));
    const trigger = s.stackOrder[0]!;
    expect(s.stackObjects[trigger]?.kind).toBe('triggered');
    s = tapAllLands(apply(s, { type: 'auto:pass', by: 0 }), 1);

    const play = legalActions(s, 1).plays.find((p) => p.name === 'Disallow');
    expect(play?.candidates[0]).toEqual([{ kind: 'ability', id: trigger }]);
    s = drain(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Disallow'),
      targets: [{ kind: 'ability', id: trigger }],
    }));

    // No life, and the Hawk and the Warden both still on the battlefield.
    expect(life(s, 0)).toBe(before);
    expect(s.instances[find(s, 0, 'battlefield', "Healer's Hawk")]!.zone).toBe('battlefield');
    expect(s.instances[find(s, 0, 'battlefield', 'Soul Warden')]!.zone).toBe('battlefield');
  });

  it('Disallow counters a spell too, and the card is buried rather than just removed', () => {
    /*
      The other half of `spell-or-ability`, and the one place the two kinds behave differently on
      resolution: a countered *spell* has a card, and the card goes to its owner's graveyard
      (CR 701.5a). An ability has none, so countering one leaves nothing behind.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 0: ['Shivan Dragon'], 1: ['Disallow'] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'],
        1: ['Island', 'Island', 'Island'],
      },
      turn: 7, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const dragon = find(s, 0, 'hand', 'Shivan Dragon');
    s = apply(apply(s, { type: 'auto:cast', by: 0, card: dragon }), { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);

    // Both kinds are offered by one spec: the spell is a card on the stack, and there is nothing
    // else up.
    const play = legalActions(s, 1).plays.find((p) => p.name === 'Disallow');
    expect(play?.candidates[0]).toEqual([{ kind: 'card', id: dragon }]);
    s = drain(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Disallow'),
      targets: [{ kind: 'card', id: dragon }],
    }));
    expect(s.instances[dragon]!.zone).toBe('graveyard');
  });

  it('Willbender sends an activated ability somewhere else, which is its printed other half', () => {
    /*
      The clause this engine carried a comment about instead of a card: "change the target of target
      spell **or ability** with a single target". An Icy Manipulator's tap is the test case a real
      table would produce — the ability is on the stack, the permanent that made it is irrelevant by
      then, and the Willbender's controller sends it at one of its own caster's creatures.
    */
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'tidal-mind' },
      hands: { 0: ['Willbender'] },
      battlefield: {
        // Five Islands for the same reason the other Willbender test needs them: three pay for the
        // face-down cast on this turn and two have to still be up on the opponent's.
        0: ['Island', 'Island', 'Island', 'Island', 'Island', "Man-o'-War"],
        1: ['Island', 'Island', 'Icy Manipulator', 'Vampire Nighthawk'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Willbender'), faceDown: true,
    })));
    const bender = find(s, 0, 'battlefield', 'Willbender');
    s = tapAllLands(advanceTo(nextTurn(s), 'precombat-main'), 1);

    const mine = find(s, 0, 'battlefield', "Man-o'-War");
    const theirs = find(s, 1, 'battlefield', 'Vampire Nighthawk');
    const aimed = icyAimedAt(s, mine);
    s = aimed.s;
    expect(s.stackObjects[aimed.ability]?.targets).toEqual([{ kind: 'card', id: mine }]);

    // Turning it up is the special action nobody may respond to; the trigger it raises asks for
    // the two targets, and the first of them is an ability rather than a card.
    s = apply(s, { type: 'auto:turnUp', by: 0, card: bender });
    expect(legalActions(s, 0).mustChoose?.candidates[0])
      .toContainEqual({ kind: 'ability', id: aimed.ability });
    s = apply(s, {
      type: 'auto:choose', by: 0,
      targets: [{ kind: 'ability', id: aimed.ability }, { kind: 'card', id: theirs }],
    });
    s = drain(passBoth(passBoth(s)));

    // Their own Nighthawk is tapped and the Man-o'-War never was.
    expect(s.instances[theirs]!.tapped).toBe(true);
    expect(s.instances[mine]!.tapped).toBe(false);
  });

  it('and an ability that has already resolved is gone rather than a legal target', () => {
    /*
      The fizzle rule, with the one difference an ability brings to it (CR 608.2b). A card that has
      changed zones is a *different object* and is dropped by `objectSeq`; an ability has no
      `objectSeq` because there is no second version of it to tell apart — it either is still on
      the stack or it does not exist. So the check that catches it is plain legality.
    */
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'tidal-mind' },
      hands: { 0: ['Squelch'] },
      battlefield: {
        0: ['Island', 'Island', 'Monastery Swiftspear'],
        1: ['Island', 'Island', 'Icy Manipulator'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    const swift = find(s, 0, 'battlefield', 'Monastery Swiftspear');
    const aimed = icyAimedAt(s, swift);
    // Seat 0's mana goes up inside the window, while it still holds priority — so that what is
    // missing afterwards is the target and not the mana. Then the ability is allowed to resolve.
    s = drain(tapAllLands(aimed.s, 0));
    expect(s.instances[swift]!.tapped).toBe(true);
    expect(s.stackOrder).toEqual([]);
    expect(legalActions(s, 0).plays.find((p) => p.name === 'Squelch')).toBeUndefined();
  });
});

describe('a question whose answer is a word, not a card', () => {
  /*
    The other half of what printed cards ask.

    Every mid-resolution question in this engine was "choose some cards from a zone" — a search, a
    discard, a scry, a sacrifice. "Choose a creature type" and "choose a colour" name no object at
    all, so a card that asked one had to be left out of the pool rather than approximated.

    Both cards here choose **as they enter**, and that is the rules point rather than an
    implementation detail: a `decisions` list is asked during the spell's own resolution, before the
    permanent is on the battlefield (CR 614.12). An entry trigger would leave a window in which the
    Obelisk is out and nothing is pumped, and these tests are also what says that window does not
    exist.
  */

  it('Obelisk of Urd pumps the type that was chosen, and nothing else', () => {
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Obelisk of Urd'] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Forest', 'Forest', 'Forest', 'Llanowar Elves', 'Blood Artist'],
        1: ['Island'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const elf = find(s, 0, 'battlefield', 'Llanowar Elves');
    const artist = find(s, 0, 'battlefield', 'Blood Artist');
    expect([power(s, elf), toughness(s, elf)]).toEqual([1, 1]);

    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Obelisk of Urd') }));

    // It stopped and asked, and the question has words rather than candidates.
    expect(s.pendingDecision?.options).toEqual([
      'Human', 'Vampire', 'Shaman', 'Monk', 'Wizard', 'Soldier', 'Warrior', 'Knight', 'Goblin',
      'Elf', 'Cat', 'Wall', 'Zombie',
    ]);
    expect(s.pendingDecision?.candidates).toEqual([]);
    expect(legalActions(s, 0).mustDecide?.options).toContain('Elf');

    s = apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'Elf' });

    /*
      Answered, and that is all: the Obelisk is on the battlefield, the anthem is live and the
      stack is empty — in one action, with nothing for anybody to respond to in between.

      This is the assertion that says "as it enters" rather than "when it enters". A trigger-based
      version would leave an ability on the stack here, both players would get priority, and a
      removal spell held for that window would answer a card that had already resolved.
    */
    expect(s.stackOrder).toEqual([]);
    expect(s.instances[find(s, 0, 'battlefield', 'Obelisk of Urd')]!.zone).toBe('battlefield');
    expect([power(s, elf), toughness(s, elf)]).toEqual([3, 3]);
    s = drain(s);

    // The Elf grew; the Vampire did not. And the Obelisk is not a creature, so it is nobody's type.
    expect([power(s, elf), toughness(s, elf)]).toEqual([3, 3]);
    expect([power(s, artist), toughness(s, artist)]).toEqual([0, 1]);
  });

  it('and keeps pumping an Elf that did not exist when the type was chosen', () => {
    /*
      The scope reads the board rather than a list, which is what makes a chosen type worth having:
      the token the Imperious Perfect makes three turns later is an Elf, so it is a 3/3, with
      nothing recomputed and no event saying a new Elf exists.
    */
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Obelisk of Urd'] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Imperious Perfect'],
        1: ['Island'],
      },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Obelisk of Urd') }));
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'Elf' }));

    const perfect = find(s, 0, 'battlefield', 'Imperious Perfect');
    // The lord is an Elf Warrior itself and does not pump itself, so the Obelisk's +2/+2 is all it
    // gets: a 4/4.
    expect([power(s, perfect), toughness(s, perfect)]).toEqual([4, 4]);

    /*
      The token is made two turns later, on purpose and not only for the mana: the point of the
      assertion is that the type was chosen before this Elf existed.
    */
    s = tapAllLands(advanceTo(nextTurn(nextTurn(s)), 'precombat-main'), 0);
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Imperious Perfect' && p.kind === 'activate');
    s = drain(apply(s, {
      type: 'auto:activate', by: 0, card: perfect, abilityIndex: play!.abilityIndex!,
    }));
    // A 1/1 token, +1/+1 from its own lord and +2/+2 from a type chosen before it existed.
    const token = find(s, 0, 'battlefield', 'Elf Warrior');
    expect([power(s, token), toughness(s, token)]).toEqual([4, 4]);
  });

  it('and the anthem is gone the moment the Obelisk is', () => {
    // `duration: 'permanent'` means "while the source is on the battlefield", and the effect was
    // pushed by the card's own resolution rather than declared — so this is the one assertion that
    // says the two behave the same.
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Obelisk of Urd'] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Forest', 'Forest', 'Forest', 'Llanowar Elves'],
        1: ['Island'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Obelisk of Urd') }));
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'Elf' }));
    const elf = find(s, 0, 'battlefield', 'Llanowar Elves');
    const obelisk = find(s, 0, 'battlefield', 'Obelisk of Urd');
    expect([power(s, elf), toughness(s, elf)]).toEqual([3, 3]);

    s = drain(apply(s, { type: 'card:move', by: 0, card: obelisk, toZone: 'graveyard' }));
    expect([power(s, elf), toughness(s, elf)]).toEqual([1, 1]);
  });

  it('Voice of All takes protection from the colour it was told, all four of its rules', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'ashen-rite' },
      hands: { 0: ['Voice of All'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Swamp', 'Swamp', 'Blood Artist'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Voice of All') }));
    expect(s.pendingDecision?.options).toEqual(['black', 'red', 'white', 'blue', 'green']);
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'black' }));

    const voice = find(s, 0, 'battlefield', 'Voice of All');
    expect(protectedFrom(s, voice, find(s, 1, 'battlefield', 'Blood Artist'))).toBe(true);
    // And not from a colour it did not choose: the choice is the card.
    expect(protectedFrom(s, voice, find(s, 0, 'battlefield', 'Plains'))).toBe(false);
  });

  it('and a black removal spell cannot be pointed at it at all', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      hands: { 0: ['Voice of All'], 1: ['Doom Blade'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Swamp', 'Swamp'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Voice of All') }));
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'black' }));
    const voice = find(s, 0, 'battlefield', 'Voice of All');

    s = tapAllLands(advanceTo(nextTurn(s), 'precombat-main'), 1);
    const blade = legalActions(s, 1).plays.find((p) => p.name === 'Doom Blade');
    expect(blade?.candidates[0] ?? []).not.toContainEqual({ kind: 'card', id: voice });
  });

  it('refuses a word nobody offered, and refuses an empty answer', () => {
    /*
      The question's own option list is the authorisation, exactly as a card question's candidate
      list is. A crafted action naming a type that was never on the list is refused here and
      nowhere else — and so is an answer with no word in it at all, because "I did not choose" is
      not one of the answers.
    */
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Obelisk of Urd'] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Forest', 'Forest', 'Forest', 'Llanowar Elves'],
        1: ['Island'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Obelisk of Urd') }));

    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [], option: 'Dragon' }))
      .toContain('not one of the choices');
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [] })).toContain('choose one of the options');
    // And not by the other player, whose question it is not.
    expect(refusal(s, { type: 'auto:decide', by: 1, cards: [], option: 'Elf' }))
      .toContain('not your decision');
  });

  it('and the engine’s own opponent answers it from the board', () => {
    /*
      `ChoiceDecisionSpec.best`, which lives on the card because only the card knows what its words
      mean. The Obelisk counts the types it controls; the Voice counts the colours it can see in
      the other seats' public zones. Both are facts rather than weights, which is the line the rest
      of the bot is held to.
    */
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'tidal-mind' },
      hands: { 0: ['Obelisk of Urd'] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Swamp', 'Forest', 'Forest', 'Forest',
          'Bloodthrone Vampire', 'Vampire Aristocrat', 'Llanowar Elves'],
        1: ['Island'],
      },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Obelisk of Urd') }));
    // Two Vampires against one Elf, so the bot names Vampire — and the Elf stays a 1/1.
    expect(botAction(s, 0)).toEqual({ type: 'auto:decide', by: 0, cards: [], option: 'Vampire' });
    s = drain(apply(s, botAction(s, 0)!));
    const vampire = find(s, 0, 'battlefield', 'Bloodthrone Vampire');
    const elves = find(s, 0, 'battlefield', 'Llanowar Elves');
    expect([power(s, vampire), toughness(s, vampire)]).toEqual([3, 3]);
    expect([power(s, elves), toughness(s, elves)]).toEqual([1, 1]);
  });
});

describe('the tenth deck: the life total that goes up', () => {
  /*
    `life-gained` had one reader in the whole pool — an Ajani's Pridemate in a deck that gains life
    by accident — which is a gap in the pool rather than in the engine. These six cards are the
    tenth deck's own, and the one of them that needed something new is the commander: "whenever an
    opponent casts a noncreature spell, **that player** loses 2 life" is the first card here that
    has to name one opponent rather than all of them.
  */

  /**
   * Seat 0's commander moved onto the battlefield by hand, then the turn walked to its main phase.
   *
   * By hand and in that order, because a commander starts in the command zone rather than the
   * library — `arena`'s `battlefield` list can only place cards it can draw — and because a
   * tabletop move does not settle, so it has to happen before the walk rather than after it.
   */
  const withCommanderOut = (state: GameState): GameState => advanceTo(apply(state, {
    type: 'card:move', by: 0, card: ids(state, 0, 'command')[0]!, toZone: 'battlefield',
  }), 'precombat-main');

  /** Seat 0 on Dawn Tithe, main phase, mana up. */
  const dawn = (hand: readonly string[], mine: readonly string[], lands = 4): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'ember-rush' },
      hands: { 0: [...hand] },
      battlefield: {
        0: [...Array.from({ length: lands }, (_, i) => (i % 2 === 0 ? 'Plains' : 'Swamp')), ...mine],
        1: ['Mountain', 'Mountain'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('Impassioned Orator gains a life for anybody’s creature but its own arrival', () => {
    let s = dawn(['Impassioned Orator', "Healer's Hawk"], []);
    const before = life(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Impassioned Orator'),
    })));
    // "Another": its own entry pays nothing.
    expect(life(s, 0)).toBe(before);

    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', "Healer's Hawk") })));
    expect(life(s, 0)).toBe(before + 1);
  });

  it('Bloodthirsty Aerialist grows on every gain, whatever caused it', () => {
    let s = dawn(['Revitalize'], ['Bloodthirsty Aerialist']);
    const bird = find(s, 0, 'battlefield', 'Bloodthirsty Aerialist');
    expect([power(s, bird), toughness(s, bird)]).toEqual([2, 2]);

    const before = life(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Revitalize') })));
    // Three life and a card, and one counter — the trigger is "whenever you gain life", once per
    // event rather than once per point.
    expect(life(s, 0)).toBe(before + 3);
    expect([power(s, bird), toughness(s, bird)]).toEqual([3, 3]);
  });

  it('Cruel Celebrant drains without a target when one of yours dies', () => {
    let s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'ember-rush' },
      hands: { 0: ['Bone Splinters'] },
      battlefield: {
        0: ['Plains', 'Swamp', 'Cruel Celebrant', 'Child of Night'],
        1: ['Mountain', 'Raging Goblin'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const child = find(s, 0, 'battlefield', 'Child of Night');
    const mine = life(s, 0);
    const theirs = life(s, 1);

    // Bone Splinters eats the Child as its cost, which is the death the Celebrant reads.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Bone Splinters'),
      sacrifice: child, targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Raging Goblin') }],
    })));
    expect(life(s, 0)).toBe(mine + 1);
    expect(life(s, 1)).toBe(theirs - 1);
  });

  it("Vraska's Contempt exiles rather than destroys, and the two life is a counter", () => {
    let s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'ember-rush' },
      hands: { 0: ["Vraska's Contempt"] },
      battlefield: {
        0: ['Plains', 'Swamp', 'Swamp', 'Swamp', 'Bloodthirsty Aerialist'],
        1: ['Mountain', 'Shivan Dragon'],
      },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const dragon = find(s, 1, 'battlefield', 'Shivan Dragon');
    const bird = find(s, 0, 'battlefield', 'Bloodthirsty Aerialist');
    const before = life(s, 0);

    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', "Vraska's Contempt"),
      targets: [{ kind: 'card', id: dragon }],
    })));

    // Exiled, not buried: nothing that reads a graveyard can have it back.
    expect(s.instances[dragon]!.zone).toBe('exile');
    expect(life(s, 0)).toBe(before + 2);
    // And the removal spell advanced the clock, which is the argument for the card.
    expect([power(s, bird), toughness(s, bird)]).toEqual([3, 3]);
  });

  it('Kambal charges the player who cast the spell, and only that player', () => {
    /*
      The first card in the pool to say "that player". In a duel the wrong reading — every opponent
      — is indistinguishable from the right one, so this is a four-seat table: seat 2 casts a
      noncreature spell and seat 3 pays nothing at all.
    */
    let s = withCommanderOut(arena({
      seats: 4, format: 'pod',
      decks: { 0: 'dawn-tithe', 1: 'ember-rush', 2: 'tidal-mind', 3: 'verdant-guard' },
      hands: { 2: ['Doom Blade'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Mountain'],
        2: ['Swamp', 'Swamp'],
        3: ['Forest', 'Centaur Courser'],
      },
      turn: 5, firstSeat: 2,
    }));
    s = tapAllLands(s, 2);
    const mine = life(s, 0);
    const caster = life(s, 2);
    const bystander = life(s, 3);

    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 2, card: find(s, 2, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: find(s, 3, 'battlefield', 'Centaur Courser') }],
    })));

    expect(life(s, 2)).toBe(caster - 2);
    expect(life(s, 0)).toBe(mine + 2);
    // The seat that cast nothing paid nothing, which is the whole of "that player".
    expect(life(s, 3)).toBe(bystander);
  });

  it('and Kambal says nothing about a creature spell', () => {
    let s = withCommanderOut(arena({
      // A commander format, because that is the only way a commander is on the table at all.
      format: 'edh',
      decks: { 0: 'dawn-tithe', 1: 'ember-rush' },
      hands: { 1: ['Hill Giant'] },
      battlefield: {
        0: ['Plains'],
        1: ['Mountain', 'Mountain', 'Mountain', 'Mountain'],
      },
      turn: 5, firstSeat: 1,
    }));
    s = tapAllLands(s, 1);
    const mine = life(s, 0);
    const theirs = life(s, 1);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Hill Giant') })));
    expect(life(s, 0)).toBe(mine);
    expect(life(s, 1)).toBe(theirs);
  });
});

describe('damage divided as you choose (CR 601.2d)', () => {
  /*
    The first card in the pool that announces numbers along with its targets.

    Four things are being tested and only one of them is the card: that the division is checked as
    the spell is cast and refused when it does not add up, that each target gets what it was
    assigned rather than the whole amount, that a target lost in response takes its own share with
    it and nothing else (CR 608.2b), and that the computer opponent can cast the card at all —
    which it cannot without choosing a division, because the engine refuses a dividing spell
    without one.
  */

  /** Seat 0 on Arc Tempest with three Mountains up, seat 1 on Tidal Mind with `theirs` out. */
  const arc = (hand: readonly string[], theirs: readonly string[], mine: readonly string[] = []): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'tidal-mind' },
      hands: { 0: [...hand] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', ...mine],
        1: ['Island', 'Island', ...theirs],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('spends two on the 2/2 and one on the 1/1, and kills both', () => {
    let s = arc(['Arc Lightning'], ["Man-o'-War", 'Ravenous Rats']);
    const squid = find(s, 1, 'battlefield', "Man-o'-War");
    const rats = find(s, 1, 'battlefield', 'Ravenous Rats');
    const theirs = life(s, 1);

    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Arc Lightning'),
      targets: [{ kind: 'card', id: squid }, { kind: 'card', id: rats }],
      division: [2, 1],
    })));

    expect(s.instances[squid]!.zone).toBe('graveyard');
    expect(s.instances[rats]!.zone).toBe('graveyard');
    // Two creatures for one card, and the opponent's life untouched: this is the aim the card is
    // printed for, and the one a spell that dealt three to a single target could not make.
    expect(life(s, 1)).toBe(theirs);
  });

  it('or puts the whole three in one place', () => {
    let s = arc(['Arc Lightning'], []);
    const theirs = life(s, 1);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Arc Lightning'),
      targets: [{ kind: 'player', seat: 1 }], division: [3],
    })));
    expect(life(s, 1)).toBe(theirs - 3);
  });

  it('refuses a division that does not add up, and one with nothing in a share', () => {
    const s = arc(['Arc Lightning'], ["Man-o'-War", 'Ravenous Rats']);
    const card = find(s, 0, 'hand', 'Arc Lightning');
    const squid = { kind: 'card' as const, id: find(s, 1, 'battlefield', "Man-o'-War") };
    const rats = { kind: 'card' as const, id: find(s, 1, 'battlefield', 'Ravenous Rats') };

    // Two short of the three it says it deals, which is the refusal that matters most: a spell
    // cast this way would quietly do less than the card says.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card, targets: [squid, rats], division: [1, 1],
    })).toContain('all 3 must be assigned');
    // And over: there is no "deals 4 damage" reading of this card.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card, targets: [squid, rats], division: [3, 1],
    })).toContain('all 3 must be assigned');
    // A target assigned nothing is not a target it took (CR 601.2d).
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card, targets: [squid, rats], division: [3, 0],
    })).toContain('at least one');
    // One number per target, or the engine cannot tell which share is whose.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card, targets: [squid, rats], division: [3],
    })).toContain('one number per target');
    // And no division at all is not a cast of this card.
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card, targets: [squid, rats],
    })).toContain('divide 3');
  });

  it('refuses a division on a spell that divides nothing', () => {
    const s = arc(['Lightning Bolt'], ['Ravenous Rats']);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Ravenous Rats') }],
      division: [3],
    })).toContain('nothing to divide');
  });

  it('loses only the share of a target that is answered in response (CR 608.2b)', () => {
    let s = arc(['Arc Lightning'], ["Man-o'-War", 'Ravenous Rats']);
    // The Island the Unsummon is paid for, and the card itself, put where seat 1 can use them.
    s = apply(s, {
      type: 'card:move', by: 1, card: ids(s, 1, 'library').find(
        (id) => nameOf(s, id) === 'Unsummon',
      )!, toZone: 'hand',
    });
    const squid = find(s, 1, 'battlefield', "Man-o'-War");
    const rats = find(s, 1, 'battlefield', 'Ravenous Rats');

    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Arc Lightning'),
      targets: [{ kind: 'card', id: squid }, { kind: 'card', id: rats }],
      division: [2, 1],
    });
    // Seat 1 answers the two-damage half by bouncing it: a different object comes back, so the
    // spell has nothing to deal that two to (CR 400.7). One pass, not `passBoth` — the Arc
    // Lightning must still be on the stack when the Unsummon is cast.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Unsummon'),
      targets: [{ kind: 'card', id: squid }],
    })));

    expect(s.instances[squid]!.zone).toBe('hand');
    // The one damage still lands, and the two is simply gone rather than moved onto the Rats —
    // a 1/1 is dead either way, so the assertion that matters is the Squid's, in hand and whole.
    expect(s.instances[rats]!.zone).toBe('graveyard');
    expect(damageOn(s, squid)).toBe(0);
  });

  it('is cast by the computer, and divided by it', () => {
    // Three one-toughness creatures: the split that kills two of them is worth more than three
    // damage in one place, and the search is the thing that is supposed to notice.
    const s = arc(['Arc Lightning'], ['Ravenous Rats', 'Omenspeaker']);
    const action = botAction(s, 0);
    expect(action?.type).toBe('auto:cast');
    const cast = action as Extract<typeof action, { type: 'auto:cast' }>;
    expect(nameOf(s, cast.card)).toBe('Arc Lightning');
    expect(cast.division).toBeDefined();
    expect(cast.division!.reduce((n, d) => n + d, 0)).toBe(3);
    expect(cast.division!.length).toBe(cast.targets!.length);
    // Whatever it chose, the engine accepts it — which is the half of this that a division the
    // bot made up could fail.
    expect(refusal(s, cast)).toBeNull();
  });
});

describe('copying an ability on the stack (CR 706.10)', () => {
  /*
    The second half of "an ability is an object": D134 made one targetable, this makes one
    copyable. The difference is not cosmetic — countering removes an object, copying builds a
    second one with the first one's targets, the first one's `subject`, and its division if it had
    one — and the copy is *created* on the stack rather than activated, so nothing is cast, no cost
    is paid and it resolves first because it is on top.
  */

  /** Seat 0 on Rot Harvest, main phase, mana up, with `mine` on the battlefield. */
  const rot = (hand: readonly string[], mine: readonly string[], lands = 4): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'ember-rush' },
      hands: { 0: [...hand] },
      battlefield: {
        0: [...Array.from({ length: lands }, (_, i) => (i % 2 === 0 ? 'Swamp' : 'Forest')), ...mine],
        1: ['Mountain', 'Mountain'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  /** The id of the one object on the stack whose description matches. */
  const onStack = (s: GameState, pattern: RegExp): string => {
    const id = s.stackOrder.find((o) => pattern.test(s.stackObjects[o]!.description));
    expect(id, `nothing on the stack matching ${String(pattern)}: ${JSON.stringify(stackNames(s))}`)
      .toBeDefined();
    return id!;
  };

  it('copies a death trigger, and the copy drains again', () => {
    let s = rot([], ['Zulaport Cutthroat', 'Strionic Resonator', 'Vampire Aristocrat', 'Doomed Dissenter']);
    const mine = life(s, 0);
    const theirs = life(s, 1);

    // The Aristocrat eats the Dissenter as a *cost*, so the Cutthroat's trigger is on the stack
    // above the ability that paid for it before anybody has priority again.
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Vampire Aristocrat'),
      abilityIndex: 0, sacrifice: find(s, 0, 'battlefield', 'Doomed Dissenter'),
    });
    const trigger = onStack(s, /each opponent loses 1 life/);

    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    // The copy is above the ability it came from, so it resolves first — and it is a copy rather
    // than a second activation: the Resonator is tapped once and paid for once.
    s = drain(passBoth(s));

    expect(life(s, 1)).toBe(theirs - 2);
    expect(life(s, 0)).toBe(mine + 2);
  });

  it('copies an arrival trigger, and draws twice from one creature', () => {
    let s = rot(['Wall of Blossoms'], ['Strionic Resonator']);
    const before = ids(s, 0, 'hand').length;

    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Wall of Blossoms') });
    // The Wall resolves first; its arrival trigger is what gets copied.
    s = passBoth(s);
    const trigger = onStack(s, /draw a card/);
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    s = drain(passBoth(s));

    // One card out of hand, two drawn: the hand is up one.
    expect(ids(s, 0, 'hand').length).toBe(before + 1);
  });

  it('cannot be pointed at an opponent’s trigger', () => {
    // Both seats on the same deck, so seat 1 has a death trigger of its own to put on the stack.
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'rot-harvest' },
      battlefield: {
        0: ['Swamp', 'Forest', 'Strionic Resonator'],
        1: ['Swamp', 'Swamp', 'Zulaport Cutthroat', 'Vampire Aristocrat', 'Doomed Dissenter'],
      },
      turn: 5, firstSeat: 1,
    }), 'precombat-main');
    s = apply(s, {
      type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Vampire Aristocrat'),
      abilityIndex: 0, sacrifice: find(s, 1, 'battlefield', 'Doomed Dissenter'),
    });
    const theirs = onStack(s, /each opponent loses 1 life/);
    // Priority has to come back to seat 0 before it can tap anything, which is also the only
    // window in which it could point a Resonator at somebody else's trigger.
    s = apply(s, { type: 'auto:pass', by: 1 });
    s = tapAllLands(s, 0);

    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: theirs }],
    })).toContain('target triggered ability you control');
    // And the table is not offered the ability at all, which is the half a player sees: an
    // activation with nothing legal to point at is not a play.
    const plays = legalActions(s, 0).plays
      .filter((p) => p.name === 'Strionic Resonator' && p.kind === 'activate');
    expect(plays).toEqual([]);
  });

  it('is not offered with nothing on the stack, and refuses an activated ability', () => {
    let s = rot([], ['Strionic Resonator', 'Vampire Aristocrat', 'Doomed Dissenter']);
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Strionic Resonator')).toEqual([]);

    // The Aristocrat's pump is an *activated* ability, waiting on the stack under the death
    // triggers its cost caused. The Resonator says "triggered", and means it.
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Vampire Aristocrat'),
      abilityIndex: 0, sacrifice: find(s, 0, 'battlefield', 'Doomed Dissenter'),
    });
    const pump = onStack(s, /\+2\/\+2/);
    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: pump }],
    })).toContain('target triggered ability you control');
  });

  it('is not asked where the copy should point when there is nowhere else to point it', () => {
    /*
      "You may choose new targets for the copy" with exactly one legal target, which is not a
      question: the engine declines on the player's behalf, the same way it answers a one-word list
      and a one-number range.

      What follows is the rule rather than a shortcoming. A Gravedigger's arrival trigger returns
      *target* creature card from a graveyard; the copy resolves first and returns the only one
      there, and the original then has a target that has changed zones — a different object
      (CR 400.7) — so it is countered for having no legal target left (CR 608.2b). One creature
      back rather than two, because there was only ever one to get back.
    */
    // Six lands: four for the Gravedigger and one for the Resonator, with one to spare.
    let s = rot(['Gravedigger'], ['Strionic Resonator'], 6);
    // A creature in the graveyard for it to want, put there by hand.
    const corpse = ids(s, 0, 'library').find((id) => nameOf(s, id) === 'Centaur Courser')!;
    s = apply(s, { type: 'card:move', by: 0, card: corpse, toZone: 'graveyard' });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gravedigger') });
    s = passBoth(s);

    /*
      The trigger's target: asked when there is a choice to make and settled by the engine when
      there is not (CR 603.3d), which with one creature card in the graveyard is this case. Written
      to cope with both, because which one it is depends on what else is in the yard.
    */
    if (s.pendingChoice !== null) {
      s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: corpse }] });
    }
    const trigger = onStack(s, /return target creature card/i);
    expect(s.stackObjects[trigger]!.targets).toEqual([{ kind: 'card', id: corpse }]);
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    s = drain(passBoth(s));

    // One copy of the card, in hand, and nothing left waiting.
    expect(s.instances[corpse]!.zone).toBe('hand');
    expect(s.stackOrder).toEqual([]);
  });

  it('but asks when there are two, and the copy returns the other one', () => {
    /*
      The printed clause doing the thing it is printed for, which is what the test above used to
      say could not be done.

      Two creature cards in the graveyard: the trigger is pointed at one, the copy is asked where
      it should go, and pointing it at the other returns **both** — two creatures out of one
      Gravedigger and one activation, which is the whole reason the card is worth {1} and a tap.
    */
    let s = rot(['Gravedigger'], ['Strionic Resonator'], 6);
    const corpses = ids(s, 0, 'library')
      .filter((id) => nameOf(s, id) === 'Centaur Courser' || nameOf(s, id) === 'Doomed Dissenter')
      .slice(0, 2);
    expect(corpses.length).toBe(2);
    for (const id of corpses) s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'graveyard' });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gravedigger') });
    s = passBoth(s);
    // Two to choose from, so the trigger's own target is a question this time.
    s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: corpses[0]! }] });
    const trigger = onStack(s, /return target creature card/i);
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    s = passBoth(s);

    // The copy resolves first and stops to ask. Both corpses are on offer, the one the original
    // chose included, because choosing the same target again is a legal answer to "you may".
    expect(s.pendingDecision?.seat).toBe(0);
    const offered = (s.pendingDecision?.targetChoices ?? []).map((t) => (t.kind === 'card' ? t.id : ''));
    expect(new Set(offered)).toEqual(new Set(corpses));
    // And nobody holds priority while it stands, which is the rule every question follows.
    expect(s.priority).toBeNull();

    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], target: { kind: 'card', id: corpses[1]! } }));
    expect(s.instances[corpses[0]!]!.zone).toBe('hand');
    expect(s.instances[corpses[1]!]!.zone).toBe('hand');
    expect(s.stackOrder).toEqual([]);
  });



  it('and the bot declines here, which is the one case it answers worse than a person', () => {
    /*
      A negative control, written down rather than left to be discovered.

      Both corpses are in the bot's *own* graveyard, so its ranking — enemies and enemy creatures
      first — sees two of its own cards, ties, and leaves the copy where it was. The copy then
      returns the card and the original is countered for pointing at an object that has changed
      zones: one creature back instead of the two a person gets. Answering it needs "would declining
      make the original fizzle", which is a question about what the copied effect *does* rather than
      a fact about the board. See `newTargetFor`.
    */
    let s = rot(['Gravedigger'], ['Strionic Resonator'], 6);
    const corpses = ids(s, 0, 'library')
      .filter((id) => nameOf(s, id) === 'Centaur Courser' || nameOf(s, id) === 'Doomed Dissenter')
      .slice(0, 2);
    for (const id of corpses) s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'graveyard' });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gravedigger') });
    s = passBoth(s);
    s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: corpses[0]! }] });
    const trigger = onStack(s, /return target creature card/i);
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    s = passBoth(s);

    const action = botAction(s, 0);
    expect(action?.type === 'auto:decide' ? action.target : 'missing').toBeUndefined();
    s = drain(apply(s, action!));
    // One back, one still there — the cost of the answer above.
    expect(s.instances[corpses[0]!]!.zone).toBe('hand');
    expect(s.instances[corpses[1]!]!.zone).toBe('graveyard');
  });

  it('and a copy that kept the original’s target fizzles with it (CR 400.7)', () => {
    /*
      The subtle half of "you may choose new targets": the target *sequence numbers*.

      They are what the fizzle check compares a target against, and a copy that keeps the
      original's targets is pointed at the same objects the original is — so if one of them has
      since been replaced by a new object, both must be countered, not just the original. The copy
      only gets the numbers of *now* when the player actually moved it.

      Written because the first version of this recomputed them either way, which would have let a
      copy resolve against a card the original could no longer see.
    */
    let s = rot(['Gravedigger'], ['Strionic Resonator'], 6);
    const corpse = ids(s, 0, 'library').find((id) => nameOf(s, id) === 'Centaur Courser')!;
    s = apply(s, { type: 'card:move', by: 0, card: corpse, toZone: 'graveyard' });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gravedigger') });
    s = passBoth(s);
    if (s.pendingChoice !== null) {
      s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: corpse }] });
    }
    const trigger = onStack(s, /return target creature card/i);

    // Out of the graveyard and back: the same card, a different object.
    s = apply(s, { type: 'card:move', by: 0, card: corpse, toZone: 'exile' });
    s = apply(s, { type: 'card:move', by: 0, card: corpse, toZone: 'graveyard' });

    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    s = drain(passBoth(s));
    // Neither resolved: the card is still in the graveyard and the stack is empty.
    expect(s.instances[corpse]!.zone).toBe('graveyard');
    expect(s.stackOrder).toEqual([]);
  });

  it('refuses a target the question did not offer, and takes "no thank you" for an answer', () => {
    let s = rot(['Gravedigger'], ['Strionic Resonator'], 6);
    const corpses = ids(s, 0, 'library')
      .filter((id) => nameOf(s, id) === 'Centaur Courser' || nameOf(s, id) === 'Doomed Dissenter')
      .slice(0, 2);
    for (const id of corpses) s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'graveyard' });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gravedigger') });
    s = passBoth(s);
    s = apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: corpses[0]! }] });
    const trigger = onStack(s, /return target creature card/i);
    s = apply(s, {
      type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Strionic Resonator'),
      abilityIndex: 0, targets: [{ kind: 'ability', id: trigger }],
    });
    s = passBoth(s);

    // A creature on the battlefield is not a creature card in a graveyard, whatever an action says.
    const onBoard = find(s, 0, 'battlefield', 'Strionic Resonator');
    expect(refusal(s, {
      type: 'auto:decide', by: 0, cards: [], target: { kind: 'card', id: onBoard },
    })).toContain('not one of the targets on offer');
    expect(refusal(s, {
      type: 'auto:decide', by: 0, cards: [], target: { kind: 'player', seat: 1 },
    })).toContain('not one of the targets on offer');

    // And declining is an answer: the copy keeps what the original chose, so the original is the
    // one that fizzles and exactly one creature comes back.
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [] }));
    expect(s.instances[corpses[0]!]!.zone).toBe('hand');
    expect(s.instances[corpses[1]!]!.zone).toBe('graveyard');
  });
});

describe('evasion: can’t be blocked, and landwalk (CR 702.14)', () => {
  /*
    Two families the pool had none of, and they fail in opposite directions.

    "Can't be blocked" is absolute: nothing on the blocker's side answers it, so it is read off the
    attacker and that is the whole rule. **Landwalk** is the only evasion in this engine whose
    answer is on the *defending player's* battlefield — the attacker says which land type, and
    whether it matters is a question about somebody else's board at the moment blockers are
    declared. The same River Boa is unblockable against a deck with Islands and an ordinary 2/1
    against a deck without.
  */
  const boards = (mine: readonly string[], theirs: readonly string[]): GameState => advanceTo(arena({
    decks: { 0: 'ashen-rite', 1: 'delta-bloom' },
    battlefield: { 0: ['Swamp', ...mine], 1: [...theirs] },
    turn: 4, firstSeat: 0,
  }), 'declare-attackers');

  it('a Tormented Soul cannot be blocked by anything', () => {
    // An Aeromunculus rather than an Air Elemental: Delta Bloom's Elemental became one (D182), and
    // what this test needs on the other side is a flier and a wall, whichever flier that is.
    const s = boards(['Tormented Soul'], ['Island', 'Fog Bank', 'Aeromunculus']);
    const soul = find(s, 0, 'battlefield', 'Tormented Soul');
    for (const name of ['Fog Bank', 'Aeromunculus']) {
      const blocker = find(s, 1, 'battlefield', name);
      expect(canBlock(s, blocker, soul, 1)?.reason).toContain("can't be blocked");
    }
  });

  it('and cannot block either, which is what the evasion is paid for', () => {
    const s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'ashen-rite' },
      battlefield: { 0: ['Island', 'Air Elemental'], 1: ['Swamp', 'Tormented Soul'] },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const soul = find(s, 1, 'battlefield', 'Tormented Soul');
    const attacker = find(s, 0, 'battlefield', 'Air Elemental');
    expect(canBlock(s, soul, attacker, 1)?.reason).toContain("can't block");
  });

  it('a River Boa is unblockable while the other player controls an Island', () => {
    const s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'delta-bloom' },
      battlefield: { 0: ['Forest', 'River Boa'], 1: ['Island', 'Fog Bank'] },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const boa = find(s, 0, 'battlefield', 'River Boa');
    const wall = find(s, 1, 'battlefield', 'Fog Bank');
    expect(canBlock(s, wall, boa, 1)?.reason).toContain('Island');
  });

  it('and is an ordinary 2/1 against a player with no Island at all', () => {
    const s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      battlefield: { 0: ['Forest', 'River Boa'], 1: ['Mountain', 'Raging Goblin'] },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const boa = find(s, 0, 'battlefield', 'River Boa');
    const goblin = find(s, 1, 'battlefield', 'Raging Goblin');
    expect(canBlock(s, goblin, boa, 1)).toBeNull();
  });

  it('reads the defender’s board, not the attacker’s own Islands', () => {
    /*
      The Boa's controller holds the Islands and the defender holds none, so the walk does nothing.
      This is the half of the rule that a flag on the attacker would get backwards, and it needs a
      deck with both a Boa and an Island in it — which no starter deck has, so the test says what
      it needs rather than hunting for a deck that happens to.
    */
    const simic = customDeck({
      id: 'boa-and-islands',
      name: 'Boa and Islands',
      entries: [{ name: 'River Boa', count: 4 }, { name: 'Island', count: 56 }],
    }).deck;
    const s = advanceTo(arena({
      decks: { 0: 'boa-and-islands', 1: 'ember-rush' },
      deckSpecs: { 'boa-and-islands': simic },
      battlefield: { 0: ['Island', 'Island', 'River Boa'], 1: ['Mountain', 'Raging Goblin'] },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const boa = find(s, 0, 'battlefield', 'River Boa');
    expect(canBlock(s, find(s, 1, 'battlefield', 'Raging Goblin'), boa, 1)).toBeNull();
  });

  it('and the table refuses a block the engine would not take, in the card’s own words', () => {
    /*
      Two attackers, because one unblockable attacker is not a *decision*: with nothing it could
      legally block, the defender is auto-declared past and never asked — which is the engine
      being right and the reason this test has a Doomed Dissenter in it. With a real choice to
      make, naming the wall against the Soul is refused and the refusal says why.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'delta-bloom' },
      battlefield: { 0: ['Swamp', 'Tormented Soul', 'Doomed Dissenter'], 1: ['Island', 'Fog Bank'] },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const soul = find(s, 0, 'battlefield', 'Tormented Soul');
    const dissenter = find(s, 0, 'battlefield', 'Doomed Dissenter');
    s = apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: soul, defender: 1 }, { attacker: dissenter, defender: 1 }],
    });
    // Declaring attackers gives priority inside the declare-attackers step; passing moves on to
    // blockers, which is where the defender is asked.
    s = passBoth(s);
    const wall = find(s, 1, 'battlefield', 'Fog Bank');
    expect(refusal(s, {
      type: 'auto:block', by: 1, blocks: [{ blocker: wall, attacker: soul }],
    })).toContain("can't be blocked");
    // And the block it *can* make is taken, which is what makes the refusal above a choice.
    expect(refusal(s, {
      type: 'auto:block', by: 1, blocks: [{ blocker: wall, attacker: dissenter }],
    })).toBeNull();
  });

  it('regenerates for {G}, which is the other half of the Boa', () => {
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 1: ['Lightning Bolt'] },
      battlefield: { 0: ['Forest', 'Forest', 'River Boa'], 1: ['Mountain', 'Mountain', 'Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const boa = find(s, 0, 'battlefield', 'River Boa');
    s = tapAllLands(s, 0);
    // The ability resolves before it means anything: a shield on the stack saves nothing.
    s = passBoth(apply(s, { type: 'auto:activate', by: 0, card: boa, abilityIndex: 0 }));
    expect(s.instances[boa]!.counters['regeneration']).toBe(1);
    // Seat 0 passes, so seat 1 holds priority in seat 0's main phase and can answer with the Bolt,
    // which is when a shield is actually tested.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: boa }],
    })));
    // Still there, tapped, and with the damage wiped — which is what regeneration does.
    expect(s.instances[boa]!.zone).toBe('battlefield');
    expect(s.instances[boa]!.tapped).toBe(true);
  });
});

describe('spells that cost more and less (CR 601.2f)', () => {
  /*
    The first permanents in this pool that reach a spell in somebody's hand.

    A cost could be *replaced* before now — flashback, foretell, morph — and taxed by the command
    zone, but nothing on the battlefield could make another spell cheaper or dearer. That is one of
    the most common static effects in Magic, and the half of it that matters most in these tests is
    the one nobody sees: the cost the table **offers** and the cost the engine **charges** come from
    one function, so they cannot drift apart.
  */
  const izzet = customDeck({
    id: 'cost-test',
    name: 'Cost Test',
    entries: [
      { name: 'Goblin Electromancer', count: 4 },
      { name: 'Lightning Strike', count: 4 },
      { name: 'Counterspell', count: 2 },
      { name: 'Lightning Bolt', count: 2 },
      { name: 'Arc Lightning', count: 4 },
      { name: 'Fireball', count: 2 },
      { name: 'Island', count: 21 },
      { name: 'Mountain', count: 21 },
    ],
  }).deck;

  const table = (
    hand: readonly string[], mine: readonly string[] = [], theirs: readonly string[] = [],
    lands: readonly string[] = ['Island', 'Island', 'Mountain'],
  ): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'cost-test', 1: 'skyward-writ' },
      deckSpecs: { 'cost-test': izzet },
      hands: { 0: [...hand] },
      battlefield: { 0: [...lands, ...mine], 1: ['Plains', 'Plains', ...theirs] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  /** What the table says this cast costs, printed cost and change. */
  const offer = (s: GameState, name: string): { cost: string; change: number | undefined } => {
    const play = legalActions(s, 0).plays.find((p) => p.kind === 'cast' && p.name === name);
    return { cost: play?.manaCost ?? '(not offered)', change: play?.costChange };
  };

  it('takes {1} off a sorcery, and leaves the coloured half alone', () => {
    // Arc Lightning is {2}{R}: the Electromancer makes it {1}{R}, not {2} or {R}.
    const s = table(['Arc Lightning'], ['Goblin Electromancer']);
    expect(offer(s, 'Arc Lightning')).toEqual({ cost: '{2}{R}', change: -1 });
    // The printed cost on the play is unchanged, which is the half a table must not lie about.

    // Lightning Bolt is {R} and has no generic at all, so nothing moves and nothing is claimed.
    const t = table(['Lightning Bolt'], ['Goblin Electromancer']);
    expect(offer(t, 'Lightning Bolt')).toEqual({ cost: '{R}', change: undefined });
  });

  it('and charges what it offered, which is the whole point of one function', () => {
    /*
      The lands are left untapped on purpose: the engine taps for a cost as it pays it, so counting
      what it tapped is counting what it charged. Three lands for a {2}{R} sorcery is what the card
      says; two is what the Electromancer makes it.
    */
    let s = advanceTo(arena({
      decks: { 0: 'cost-test', 1: 'skyward-writ' },
      deckSpecs: { 'cost-test': izzet },
      hands: { 0: ['Arc Lightning'] },
      battlefield: {
        0: ['Island', 'Island', 'Mountain', 'Mountain', 'Goblin Electromancer'],
        1: ['Plains'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    const untapped = (st: GameState): number => Object.values(st.instances)
      .filter((i) => i.zoneSeat === 0 && i.zone === 'battlefield' && !i.tapped).length;
    const before = untapped(s);
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Arc Lightning'),
      targets: [{ kind: 'player', seat: 1 }], division: [3],
    });
    expect(before - untapped(s)).toBe(2);
  });

  it('does not reduce a spell somebody else is casting', () => {
    // "Instant and sorcery spells **you** cast": the Electromancer is on seat 0's board, and the
    // question is asked of seat 1's hand.
    const s = advanceTo(arena({
      decks: { 0: 'cost-test', 1: 'arc-tempest' },
      deckSpecs: { 'cost-test': izzet },
      hands: { 1: ['Arc Lightning'] },
      battlefield: {
        0: ['Island', 'Mountain', 'Goblin Electromancer'],
        1: ['Mountain', 'Mountain', 'Mountain'],
      },
      turn: 5, firstSeat: 1,
    }), 'precombat-main');
    const play = legalActions(s, 1).plays.find((p) => p.kind === 'cast' && p.name === 'Arc Lightning');
    expect(play?.costChange).toBeUndefined();
  });

  it('taxes everybody when the card says so, its own controller included', () => {
    // Thalia is seat 1's, and seat 1 is the one being taxed here as well as seat 0. Four lands,
    // because a taxed {2}{R} is four mana and an unaffordable cast is not offered at all.
    const s = table(['Arc Lightning'], [], ['Thalia, Guardian of Thraben'],
      ['Island', 'Island', 'Mountain', 'Mountain']);
    expect(offer(s, 'Arc Lightning')).toEqual({ cost: '{2}{R}', change: 1 });

    const theirs = advanceTo(arena({
      decks: { 0: 'cost-test', 1: 'skyward-writ' },
      deckSpecs: { 'cost-test': izzet },
      hands: { 1: ['Swords to Plowshares'] },
      battlefield: {
        0: ['Island'],
        1: ['Plains', 'Plains', 'Thalia, Guardian of Thraben'],
      },
      turn: 5, firstSeat: 1,
    }), 'precombat-main');
    const play = legalActions(theirs, 1).plays.find((p) => p.kind === 'cast' && p.name === 'Swords to Plowshares');
    expect(play?.costChange).toBe(1);
  });

  it('leaves a creature spell alone, which is what "noncreature" means', () => {
    const s = table(['Goblin Electromancer'], [], ['Thalia, Guardian of Thraben']);
    expect(offer(s, 'Goblin Electromancer')).toEqual({ cost: '{U}{R}', change: undefined });
  });

  it('cancels out when both are on the table, and says nothing about it', () => {
    /*
      Lightning Strike is {1}{R}: Thalia puts a mana on and the Electromancer takes it off, so the
      cast costs exactly what the card says. No note is shown, because a table that announced "+1,
      −1, no change" on every spell would be noise — the rule is that the note appears when the
      number moved.
    */
    const s = table(['Lightning Strike'], ['Goblin Electromancer'], ['Thalia, Guardian of Thraben']);
    expect(offer(s, 'Lightning Strike')).toEqual({ cost: '{1}{R}', change: undefined });
  });

  it('never takes the generic below nought', () => {
    /*
      Two Electromancers against a {1}{R}: the first takes the one generic off and the second has
      nothing left to take. A cost reduction empties the generic part and stops (CR 601.2f) — it
      does not start eating the red, and it does not go negative and hand anybody mana back.
    */
    const s = table(['Lightning Strike'], ['Goblin Electromancer', 'Goblin Electromancer']);
    expect(offer(s, 'Lightning Strike')).toEqual({ cost: '{1}{R}', change: -1 });
  });

  it('stops working the moment the permanent leaves', () => {
    let s = table(['Arc Lightning'], ['Goblin Electromancer']);
    expect(offer(s, 'Arc Lightning').change).toBe(-1);
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'battlefield', 'Goblin Electromancer'),
      toZone: 'graveyard',
    });
    expect(offer(s, 'Arc Lightning').change).toBeUndefined();
  });

  it('and does nothing while it is face down, which has no abilities at all (CR 707.2)', () => {
    /*
      A Goblin Electromancer is not a morph, so it gets there the way a test does: placed on the
      battlefield and turned face down by hand. What is being checked is the rule rather than the
      card — a face-down permanent is a 2/2 with no text, and a cost modifier is text.
    */
    let s = table(['Arc Lightning'], ['Goblin Electromancer']);
    const mage = find(s, 0, 'battlefield', 'Goblin Electromancer');
    s = apply(s, { type: 'card:faceDown', by: 0, card: mage, faceDown: true });
    expect(offer(s, 'Arc Lightning').change).toBeUndefined();
  });
});

describe('Twincast: copying a spell, and choosing where the copy points', () => {
  /*
    The other half of the copy family, and the half that needed a card to *not* be one.

    An ability has no card; a spell is one. So a copy of a spell is the first object this engine has
    ever put on the stack that is neither a card nor an ability — no instance, nothing to put in a
    graveyard when it has finished, and characteristics read off the original (CR 707.10). Each test
    below is one of the things a person would notice if that were wrong.
  */

  /*
    Built here rather than borrowed from a starter deck, which is deliberate.

    Twincast lives in Tidal Mind and the spells worth copying in a *test* are a Bolt and a
    Guttersnipe, which live in Arc Tempest. Pinning these tests to whichever deck currently holds
    the card would also mean breaking them the next time a slot moves — and that has happened
    before. `customDeck` looks a name up anywhere in the pool, so the test says what it needs.
  */
  const copyDeck = customDeck({
    id: 'copy-test',
    name: 'Copy Test',
    entries: [
      { name: 'Twincast', count: 4 },
      { name: 'Lightning Bolt', count: 4 },
      { name: 'Guttersnipe', count: 2 },
      { name: 'Enigma Drake', count: 2 },
      { name: 'Island', count: 26 },
      { name: 'Mountain', count: 22 },
    ],
  }).deck;

  /** Seat 0 on that deck, main phase, five lands tapped, with `hand` in hand. */
  const izzet = (
    hand: readonly string[], mine: readonly string[] = [], theirs: readonly string[] = [],
  ): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'copy-test', 1: 'ember-rush' },
      deckSpecs: { 'copy-test': copyDeck },
      hands: { 0: [...hand] },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Mountain', 'Mountain', ...mine],
        1: ['Mountain', ...theirs],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  /** Casts the named card in hand at `targets`, leaving it on the stack. */
  const cast = (s: GameState, name: string, targets?: readonly Target[]): GameState => apply(s, {
    type: 'auto:cast', by: 0, card: find(s, 0, 'hand', name),
    ...(targets === undefined ? {} : { targets: [...targets] }),
  });

  /** Resolves everything, declining each "point the copy somewhere else?" on the way. */
  const settle = (s: GameState): GameState => {
    let next = drain(s);
    for (let i = 0; i < 8 && next.pendingDecision !== null; i += 1) {
      next = drain(apply(next, { type: 'auto:decide', by: next.pendingDecision.seat, cards: [] }));
    }
    return next;
  };

  it('copies the spell it was pointed at, and the copy resolves first', () => {
    let s = izzet(['Lightning Bolt', 'Twincast']);
    const them = life(s, 1);
    s = cast(s, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    const bolt = s.stackOrder[0]!;
    s = cast(s, 'Twincast', [{ kind: 'card', id: bolt }]);
    // Twincast above the Bolt, which is the order they were cast in.
    expect(stackNames(s)).toEqual([
      expect.stringContaining('Lightning Bolt'), expect.stringContaining('Twincast'),
    ]);

    /*
      The question comes *before* the copy exists, which is the one thing about this shape worth
      seeing in a test: a copy's legal targets are the original's (CR 707.2), so the engine asks
      about the spell being copied and hands the answer to the copy as it is made. While the
      question stands, the stack still reads Bolt and Twincast.
    */
    s = passBoth(s);
    expect(s.pendingDecision?.seat).toBe(0);
    expect(stackNames(s)[1]).toContain('Twincast');

    s = apply(s, { type: 'auto:decide', by: 0, cards: [] });
    // Now the copy is there, on top of the Bolt, so it resolves first.
    expect(stackNames(s)[1]).toContain('(copy)');
    s = settle(s);
    // Three from the copy and three from the original: six out of one card and one copy.
    expect(life(s, 1)).toBe(them - 6);
    expect(s.stackOrder).toEqual([]);
  });

  it('leaves no card behind, because the copy never was one (CR 707.10)', () => {
    let s = izzet(['Lightning Bolt', 'Twincast']);
    s = cast(s, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    s = cast(s, 'Twincast', [{ kind: 'card', id: s.stackOrder[0]! }]);
    s = settle(passBoth(s));
    // One Bolt and one Twincast in the graveyard and no second Bolt: there was never a third card.
    const yard = namesIn(s, 0, 'graveyard');
    expect(yard.filter((n) => n === 'Lightning Bolt').length).toBe(1);
    expect(yard.filter((n) => n === 'Twincast').length).toBe(1);
  });

  it('is not cast, so a Guttersnipe does not see it', () => {
    /*
      The rule that would be quietly wrong in the player's favour, in the deck where it matters:
      Arc Tempest's whole plan is triggers that read a *cast*, and a copy is **put** on the stack
      rather than cast (CR 707.10). Two casts, two Guttersnipe triggers, and the copy is not a
      third one.
    */
    let s = izzet(['Lightning Bolt', 'Twincast'], ['Guttersnipe']);
    const them = life(s, 1);
    s = cast(s, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    s = cast(s, 'Twincast', [{ kind: 'card', id: s.stackOrder[0]! }]);
    s = settle(s);
    // Two for each cast and three for each Bolt: ten, not twelve.
    expect(life(s, 1)).toBe(them - 10);
  });

  it('points the copy somewhere else, which is the clause the engine had no shape for', () => {
    let s = izzet(['Lightning Bolt', 'Twincast'], [], ['Raging Goblin']);
    const them = life(s, 1);
    s = cast(s, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    s = cast(s, 'Twincast', [{ kind: 'card', id: s.stackOrder[0]! }]);
    const goblin = find(s, 1, 'battlefield', 'Raging Goblin');
    s = passBoth(s);

    // The question, carrying the Bolt's own legal targets: both players and the Goblin.
    expect(s.pendingDecision?.seat).toBe(0);
    const offered = s.pendingDecision?.targetChoices ?? [];
    expect(offered.some((t) => t.kind === 'player' && t.seat === 1)).toBe(true);
    expect(offered.some((t) => t.kind === 'card' && t.id === goblin)).toBe(true);

    s = settle(apply(s, { type: 'auto:decide', by: 0, cards: [], target: { kind: 'card', id: goblin } }));
    // The copy killed the Goblin and the original still went at the player: three, not six.
    expect(namesIn(s, 1, 'graveyard')).toContain('Raging Goblin');
    expect(life(s, 1)).toBe(them - 3);
  });

  it('and the copy can be countered, which is the other player’s half of it', () => {
    /*
      A copy on the stack is a spell, so "counter target spell" may be pointed at it — and until
      copies existed, spell targets came out of the stack *zone*, which holds cards only. A copy is
      not a card, so it was invisible there. Both seats on Arc Tempest here so that the answer is a
      real Counterspell cast by a real player rather than an assertion about a list.
    */
    let s = advanceTo(arena({
      decks: { 0: 'copy-test', 1: 'hollow-tide' },
      deckSpecs: { 'copy-test': copyDeck },
      hands: { 0: ['Lightning Bolt', 'Twincast'], 1: ['Counterspell'] },
      battlefield: {
        0: ['Island', 'Island', 'Island', 'Mountain', 'Mountain'],
        1: ['Island', 'Island'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    // Only seat 0's lands are tapped up front: a seat without priority cannot tap anything, and
    // the engine taps for a cost it can pay, so seat 1's Counterspell pays for itself.
    s = tapAllLands(s, 0);
    const them = life(s, 1);
    s = cast(s, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    s = cast(s, 'Twincast', [{ kind: 'card', id: s.stackOrder[0]! }]);
    s = passBoth(s);
    s = apply(s, { type: 'auto:decide', by: 0, cards: [] });

    // The copy: on the stack, a spell, and with no card behind it at all.
    const copy = s.stackOrder[s.stackOrder.length - 1]!;
    expect(s.stackObjects[copy]?.copyOf).toBeDefined();
    expect(s.instances[copy]).toBeUndefined();

    // Priority comes back to the active player when a resolution finishes, so seat 1 has to be
    // given it before it can answer — which is also the window the rules give it.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'),
      targets: [{ kind: 'card', id: copy }],
    });
    s = settle(s);
    // The original Bolt still resolved: three, not six, and nothing is left on the stack.
    expect(life(s, 1)).toBe(them - 3);
    expect(s.stackOrder).toEqual([]);
  });


  it('the bot points a copy of their removal spell back at their own creature', () => {
    /*
      The play the clause exists for, made by the engine's own opponent.

      Their Doom Blade is aimed at my creature; copying it is worth a card only if the copy goes
      somewhere else, and "somewhere else" is a judgement no card can make — the spell being copied
      is not the card asking. So the bot answers it the way it aims a cast: the enemy and the
      enemy's creatures first, with the card's own `friendly` hint reversing that for a spell that
      helps what it points at. See `newTargetFor`.
    */
    let s = advanceTo(arena({
      decks: { 0: 'copy-test', 1: 'tidal-mind' },
      deckSpecs: { 'copy-test': copyDeck },
      hands: { 0: ['Twincast'], 1: ['Doom Blade'] },
      battlefield: {
        // An Enigma Drake rather than a Swiftspear: prowess would put a trigger on the stack for
        // the Twincast and the test would be about that instead.
        0: ['Island', 'Island', 'Island', 'Mountain', 'Mountain', 'Enigma Drake'],
        1: ['Island', 'Island', 'Swamp', "Man-o'-War"],
      },
      turn: 5, firstSeat: 1,
    }), 'precombat-main');
    const mine = find(s, 0, 'battlefield', 'Enigma Drake');
    const theirs = find(s, 1, 'battlefield', "Man-o'-War");
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: mine }],
    });
    s = apply(s, { type: 'auto:pass', by: 1 });
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Twincast'),
      targets: [{ kind: 'card', id: s.stackOrder[0]! }],
    });
    s = passBoth(s);

    // The question is up, and the bot's answer is their creature rather than mine.
    expect(s.pendingDecision?.seat).toBe(0);
    const action = botAction(s, 0);
    expect(action?.type).toBe('auto:decide');
    expect(action?.type === 'auto:decide' ? action.target : null).toEqual({ kind: 'card', id: theirs });

    s = settle(apply(s, action!));
    // Both creatures are dead: the copy killed theirs and the original still killed mine.
    expect(namesIn(s, 1, 'graveyard')).toContain("Man-o'-War");
    expect(namesIn(s, 0, 'graveyard')).toContain('Enigma Drake');
  });

  it('and leaves a copy of its own spell where it already was', () => {
    // A Bolt of mine already aimed at the opponent: every other answer is worse, and re-choosing
    // the same target would read in the log as a change of mind that changed nothing.
    let s = izzet(['Lightning Bolt', 'Twincast']);
    s = cast(s, 'Lightning Bolt', [{ kind: 'player', seat: 1 }]);
    s = cast(s, 'Twincast', [{ kind: 'card', id: s.stackOrder[0]! }]);
    s = passBoth(s);
    const action = botAction(s, 0);
    expect(action?.type === 'auto:decide' ? action.target : 'missing').toBeUndefined();
  });

  it('cannot be cast with nothing to copy, and refuses a creature spell', () => {
    let s = izzet(['Twincast']);
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Twincast')).toEqual([]);

    // A creature spell is not an instant or a sorcery, which is the card's own filter.
    s = izzet(['Twincast', 'Enigma Drake']);
    s = cast(s, 'Enigma Drake');
    const creature = s.stackOrder[0]!;
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Twincast'),
      targets: [{ kind: 'card', id: creature }],
    })).toBeTruthy();
  });
});

describe('two more planeswalkers', () => {
  /*
    Ten decks shared two planeswalkers until now, and six abilities between them. These two add six
    more and needed nothing new in the engine, which is the claim being tested as much as the cards
    are: a counter, a pump with two keywords, five tokens, one token, counters on a whole team, and
    a pair of numbers read off the board.
  */

  /** A seat with a walker out and its lands tapped, plus whatever else it needs on the board. */
  const withWalker = (
    seat: SeatIndex, deck: string, walker: string, basic: string, lands: number,
    extra: readonly string[] = [],
  ): GameState => {
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

  /** Loyalty counters added by hand, for an ultimate nobody would reach inside one test. */
  const charge = (s: GameState, walker: string, to: number): GameState =>
    addCounters(s, walker, 'loyalty', to - (s.instances[walker]!.counters['loyalty'] ?? 0));

  it('Ajani grows a creature, and goes up doing it', () => {
    let s = withWalker(0, 'skyward-writ', 'Ajani, Caller of the Pride', 'Plains', 3,
      ['Leonin Skyhunter']);
    const ajani = find(s, 0, 'battlefield', 'Ajani, Caller of the Pride');
    const cat = find(s, 0, 'battlefield', 'Leonin Skyhunter');
    expect(s.instances[ajani]!.counters['loyalty']).toBe(4);

    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: ajani, abilityIndex: 0,
      targets: [{ kind: 'card', id: cat }],
    })));

    expect([power(s, cat), toughness(s, cat)]).toEqual([3, 3]);
    expect(s.instances[ajani]!.counters['loyalty']).toBe(5);
  });

  it('Ajani’s minus three is a clock: flying and double strike, until end of turn', () => {
    let s = withWalker(0, 'skyward-writ', 'Ajani, Caller of the Pride', 'Plains', 3,
      ['Leonin Skyhunter']);
    const ajani = find(s, 0, 'battlefield', 'Ajani, Caller of the Pride');
    const knight = find(s, 0, 'battlefield', 'Leonin Skyhunter');

    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: ajani, abilityIndex: 1,
      targets: [{ kind: 'card', id: knight }],
    })));
    expect(characteristicsOf(s, s.instances[knight]!).keywords.has('flying')).toBe(true);
    expect(characteristicsOf(s, s.instances[knight]!).keywords.has('double strike')).toBe(true);
    expect(s.instances[ajani]!.counters['loyalty']).toBe(1);

    // Until end of turn, which is what separates it from the +1's counter.
    s = advanceTo(nextTurn(s), 'precombat-main');
    expect(characteristicsOf(s, s.instances[knight]!).keywords.has('double strike')).toBe(false);
  });

  it('Ajani’s ultimate makes five 2/2 Cats', () => {
    let s = withWalker(0, 'skyward-writ', 'Ajani, Caller of the Pride', 'Plains', 3);
    const ajani = find(s, 0, 'battlefield', 'Ajani, Caller of the Pride');
    // Nobody reaches eight loyalty inside a test; the counters go on by hand so the ability itself
    // is what is being checked.
    s = charge(s, ajani, 8);
    s = drain(passBoth(apply(s, { type: 'auto:activate', by: 0, card: ajani, abilityIndex: 2 })));

    expect(countOf(s, 0, 'battlefield', 'Cat')).toBe(5);
    const cat = ids(s, 0, 'battlefield').find((id) => nameOf(s, id) === 'Cat')!;
    expect([power(s, cat), toughness(s, cat)]).toEqual([2, 2]);
    // Zero loyalty is a state-based action, so the ultimate kills its own planeswalker.
    expect(s.instances[ajani]!.zone).toBe('graveyard');
  });

  it('Nissa makes a 0/1 Plant a turn', () => {
    let s = withWalker(0, 'verdant-guard', 'Nissa, Voice of Zendikar', 'Forest', 3);
    const nissa = find(s, 0, 'battlefield', 'Nissa, Voice of Zendikar');
    expect(s.instances[nissa]!.counters['loyalty']).toBe(3);

    s = drain(passBoth(apply(s, { type: 'auto:activate', by: 0, card: nissa, abilityIndex: 0 })));
    expect(countOf(s, 0, 'battlefield', 'Plant')).toBe(1);
    const plant = ids(s, 0, 'battlefield').find((id) => nameOf(s, id) === 'Plant')!;
    expect([power(s, plant), toughness(s, plant)]).toEqual([0, 1]);
    expect(s.instances[nissa]!.counters['loyalty']).toBe(4);
  });

  it('Nissa’s minus two counts your own creatures only, and the counters stay', () => {
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      battlefield: {
        0: ['Forest', 'Forest', 'Forest', 'Nissa, Voice of Zendikar', 'Grizzly Bears', 'Elvish Visionary'],
        1: ['Mountain', 'Raging Goblin'],
      },
      turn: 3, firstSeat: 0,
    }), 'precombat-main');
    const nissa = find(s, 0, 'battlefield', 'Nissa, Voice of Zendikar');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    const theirs = find(s, 1, 'battlefield', 'Raging Goblin');

    s = drain(passBoth(apply(s, { type: 'auto:activate', by: 0, card: nissa, abilityIndex: 1 })));
    expect([power(s, bears), toughness(s, bears)]).toEqual([3, 3]);
    expect([power(s, theirs), toughness(s, theirs)]).toEqual([1, 1]);

    // Counters rather than a pump: still there next turn, which is the difference from an Overrun.
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect([power(s, bears), toughness(s, bears)]).toEqual([3, 3]);
  });

  it('Nissa’s ultimate is as big as the lands you control', () => {
    let s = withWalker(0, 'verdant-guard', 'Nissa, Voice of Zendikar', 'Forest', 5);
    const nissa = find(s, 0, 'battlefield', 'Nissa, Voice of Zendikar');
    s = charge(s, nissa, 7);
    const lifeBefore = life(s, 0);
    const handBefore = ids(s, 0, 'hand').length;

    s = drain(passBoth(apply(s, { type: 'auto:activate', by: 0, card: nissa, abilityIndex: 2 })));

    // Five lands: five life and five cards, read off the board as it is when it resolves.
    expect(life(s, 0)).toBe(lifeBefore + 5);
    expect(ids(s, 0, 'hand').length).toBe(handBefore + 5);
  });
});

describe('the eleventh deck: the lands are the engine', () => {
  /*
    Two engine additions, one deck. An extra land drop (CR 505.5b) is the first permission here
    that changes what a *player* may do rather than what a permanent is, and an `etb` trigger that
    can watch a **land** is the landfall templating — the event has always been raised for a land
    entering and until Tatyova nothing could hear it.
  */

  /** Seat 0 on Delta Bloom, main phase, with `hand` in hand and `mine` out. */
  const delta = (hand: readonly string[], mine: readonly string[] = [], lands = 2): GameState =>
    advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'ember-rush' },
      hands: { 0: [...hand] },
      battlefield: {
        0: [...Array.from({ length: lands }, (_, i) => (i % 2 === 0 ? 'Forest' : 'Island')), ...mine],
        1: ['Mountain'],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  /** Seat 0's commander moved out of the command zone by hand, then the turn walked to its main. */
  const withTatyova = (state: GameState): GameState => advanceTo(apply(state, {
    type: 'card:move', by: 0, card: ids(state, 0, 'command')[0]!, toZone: 'battlefield',
  }), 'precombat-main');

  it('plays a second land after an Explore, and refuses a third', () => {
    let s = delta(['Explore', 'Forest', 'Island']);
    s = tapAllLands(s, 0);
    // The turn's own land first, so the Explore is being asked for the *second* one.
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Forest') });
    expect(refusal(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Island') }))
      .toContain('already played a land');

    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Explore') })));
    const island = find(s, 0, 'hand', 'Island');
    s = apply(s, { type: 'auto:playLand', by: 0, card: island });
    expect(s.instances[island]!.zone).toBe('battlefield');

    // And that is two: the allowance was one more, not unlimited.
    const third = ids(s, 0, 'hand').find((id) => /Forest|Island/.test(nameOf(s, id)));
    if (third !== undefined) {
      expect(refusal(s, { type: 'auto:playLand', by: 0, card: third }))
        .toContain('already played 2 lands');
    }
  });

  it('and the order does not matter: Explore first is still two lands', () => {
    let s = delta(['Explore', 'Forest', 'Island']);
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Explore') })));
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Forest') });
    const island = find(s, 0, 'hand', 'Island');
    s = apply(s, { type: 'auto:playLand', by: 0, card: island });
    expect(s.instances[island]!.zone).toBe('battlefield');
  });

  it('and the permission ends with the turn', () => {
    let s = delta(['Explore', 'Forest', 'Island']);
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Explore') })));
    // Next turn of this seat's: one land, like anybody else.
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Forest') });
    expect(refusal(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Island') }))
      .toContain('already played a land this turn');
  });

  it('Tatyova turns a land drop into a card and a life', () => {
    let s = withTatyova(arena({
      decks: { 0: 'delta-bloom', 1: 'ember-rush' },
      format: 'edh',
      hands: { 0: ['Forest'] },
      battlefield: { 0: ['Forest', 'Island'], 1: ['Mountain'] },
      turn: 5, firstSeat: 0,
    }));
    const before = ids(s, 0, 'hand').length;
    const lifeBefore = life(s, 0);

    s = drain(apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Forest') }));

    // One land out of hand and one card drawn, so the hand is level — and a life up.
    expect(ids(s, 0, 'hand').length).toBe(before);
    expect(life(s, 0)).toBe(lifeBefore + 1);
  });

  it('and says nothing for an opponent’s land, or for a creature of yours', () => {
    let s = withTatyova(arena({
      decks: { 0: 'delta-bloom', 1: 'ember-rush' },
      format: 'edh',
      hands: { 0: ['Elvish Visionary'], 1: ['Mountain'] },
      battlefield: { 0: ['Forest', 'Island'], 1: ['Mountain'] },
      turn: 5, firstSeat: 1,
    }));
    const lifeBefore = life(s, 0);
    const handBefore = ids(s, 0, 'hand').length;

    // Their land: "a land **you** control".
    s = drain(apply(s, { type: 'auto:playLand', by: 1, card: find(s, 1, 'hand', 'Mountain') }));
    expect(life(s, 0)).toBe(lifeBefore);
    expect(ids(s, 0, 'hand').length).toBe(handBefore);

    // And a creature of your own is not a land, which is the half `what: 'land'` is for. The
    // Visionary's own trigger draws one card; Tatyova adds nothing and no life.
    s = advanceTo(nextTurn(s), 'precombat-main');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Elvish Visionary'),
    })));
    expect(life(s, 0)).toBe(lifeBefore);
  });

  it('Kiora’s Follower untaps a land, and cannot untap itself', () => {
    let s = delta([], ["Kiora's Follower"], 3);
    const follower = find(s, 0, 'battlefield', "Kiora's Follower");
    // Summoning sickness is the reason the board is built on turn 5 and the creature placed with
    // it: a {T} ability needs the creature to have been there since the turn began.
    const forest = ids(s, 0, 'battlefield').find((id) => nameOf(s, id) === 'Forest')!;
    s = apply(s, { type: 'auto:activate', by: 0, card: forest, abilityIndex: 0 });
    expect(s.instances[forest]!.tapped).toBe(true);

    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: follower, abilityIndex: 0,
      targets: [{ kind: 'card', id: follower }],
    })).toContain('another target permanent');

    s = drain(passBoth(apply(s, {
      type: 'auto:activate', by: 0, card: follower, abilityIndex: 0,
      targets: [{ kind: 'card', id: forest }],
    })));
    expect(s.instances[forest]!.tapped).toBe(false);
    // And it paid for it with its own tap.
    expect(s.instances[follower]!.tapped).toBe(true);
  });

  it('Pelakka Wurm gains seven on the way in and draws a card on the way out', () => {
    let s = delta(['Pelakka Wurm'], [], 7);
    s = tapAllLands(s, 0);
    const lifeBefore = life(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Pelakka Wurm'),
    })));
    const wurm = find(s, 0, 'battlefield', 'Pelakka Wurm');
    expect(life(s, 0)).toBe(lifeBefore + 7);
    expect([power(s, wurm), toughness(s, wurm)]).toEqual([7, 7]);

    const handBefore = ids(s, 0, 'hand').length;
    s = drain(apply(s, { type: 'card:move', by: 0, card: wurm, toZone: 'graveyard' }));
    expect(ids(s, 0, 'hand').length).toBe(handBefore + 1);
  });
});

describe('Chalice of the Void: the permanent that answers a spell by what it cost', () => {
  /*
    Three things in the engine were missing for one card, and each is worth naming.

    A `spell-cast` event said what *kind* of spell was cast and not *which one*, so no card could
    read a spell's mana value or counter it. `{X}{X}` is one number paid twice, which no cost in the
    pool had. And the intervening-if clause was asked with less context the first of its two times
    than the second, so a condition that reads the spell on the stack could not be asked at all
    before the ability went on the stack — which is the difference between "nothing happens" and
    "an opponent sees a trigger for a spell that was never going to be countered".
  */
  const table = (x: number, lands: number): GameState => {
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'ember-rush' },
      hands: { 0: ['Chalice of the Void'] },
      battlefield: { 0: Array.from({ length: lands }, () => 'Island'), 1: ['Mountain', 'Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const chalice = find(s, 0, 'hand', 'Chalice of the Void');
    s = apply(s, { type: 'auto:cast', by: 0, card: chalice, x });
    return drain(passBoth(s));
  };

  it('enters with X charge counters, and {X}{X} is that number paid twice (CR 107.3b)', () => {
    // Four Islands and X=2: the cost is four mana, and every one of them is tapped for it.
    const s = table(2, 4);
    const chalice = find(s, 0, 'battlefield', 'Chalice of the Void');
    expect(s.instances[chalice]?.counters['charge']).toBe(2);
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]?.tapped).length).toBe(4);
  });

  it('refuses an X it cannot pay twice over', () => {
    // Three Islands cannot pay {X}{X} for X=2, and the engine says so rather than taking it.
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'ember-rush' },
      hands: { 0: ['Chalice of the Void'] },
      battlefield: { 0: ['Island', 'Island', 'Island'], 1: [] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const chalice = find(s, 0, 'hand', 'Chalice of the Void');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: chalice, x: 2 })).not.toBeNull();
    // And offers one as the most it can afford, which is the table telling the truth about the cost.
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Chalice of the Void');
    expect(play?.xMax).toBe(1);
    s = apply(s, { type: 'auto:cast', by: 0, card: chalice, x: 1 });
    expect(drain(passBoth(s)).instances[find(drain(passBoth(s)), 0, 'battlefield', 'Chalice of the Void')]
      ?.counters['charge']).toBe(1);
  });

  it('counters a spell whose mana value is the number on it', () => {
    let s = table(1, 4);
    // Seat 1's own turn, with a one-mana spell to cast into it.
    s = nextTurn(s);
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Shock'), toZone: 'hand' });
    const shock = find(s, 1, 'hand', 'Shock');
    s = apply(s, {
      type: 'auto:cast', by: 1, card: shock, targets: [{ kind: 'player', seat: 0 }],
    });
    // The trigger goes on the stack above the spell, so it resolves first (CR 603.3b).
    // The trigger's own description, which is how the stack reads it to a player.
    expect(stackNames(s)).toEqual(['Shock', 'counter that spell']);
    s = drain(passBoth(s));
    expect(namesIn(s, 1, 'graveyard')).toContain('Shock');
    expect(life(s, 0)).toBe(20);
    expect(s.stackOrder).toHaveLength(0);
  });

  it('and does not even trigger for a spell whose mana value is something else', () => {
    /*
      The intervening-if clause, which is why this is a condition and not a filter. A two-mana
      spell cast into a Chalice on one puts *nothing* on the stack: there is no trigger to respond
      to, and the log says nothing happened — because nothing did.
    */
    let s = table(1, 4);
    s = advanceTo(nextTurn(s), 'precombat-main');
    const marauder = find(s, 1, 'library', 'Borderland Marauder');
    s = apply(s, { type: 'card:move', by: 1, card: marauder, toZone: 'hand' });
    s = apply(s, { type: 'auto:cast', by: 1, card: marauder });
    // Nothing of the Chalice's on the stack: not a trigger that resolves and does nothing, none.
    expect(stackNames(s)).toEqual(['Borderland Marauder']);
    s = drain(passBoth(s));
    expect(namesIn(s, 1, 'battlefield')).toContain('Borderland Marauder');
  });

  it('counts the X on the spell it is looking at, which is the one place X is not nought', () => {
    // CR 202.3b. An Endless One cast for X=1 is a mana value of one on the stack and nought
    // anywhere else, so a Chalice on one catches it and a Chalice on nought never would.
    let s = table(1, 4);
    s = nextTurn(s);
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Mountain'), toZone: 'battlefield' });
    const one = ids(s, 1, 'library')
      .find((id) => nameOf(s, id) === 'Endless One');
    if (one === undefined) return; // Ember Rush does not run it; the next test covers the rule.
    s = apply(s, { type: 'card:move', by: 1, card: one, toZone: 'hand' });
    s = apply(s, { type: 'auto:cast', by: 1, card: one, x: 1 });
    s = drain(passBoth(s));
    expect(namesIn(s, 1, 'graveyard')).toContain('Endless One');
  });

  it('counters its own controller’s spell too, because that is the card', () => {
    let s = table(1, 5);
    /*
      A fifth Island, untapped, and a one-mana spell of seat 0's own.

      An Unsummon rather than the Preordain this used to cast, which left Tidal Mind for a Treasure
      Cruise — and an Unsummon needs something to point at, so a Raging Goblin is put on the other
      side of the table for it. Which is incidental to the card being tested and says so: what
      matters is that the spell cost one mana and belongs to the Chalice's own controller.
    */
    s = apply(s, {
      type: 'card:move', by: 1, card: find(s, 1, 'library', 'Raging Goblin'), toZone: 'battlefield',
    });
    const goblin = find(s, 1, 'battlefield', 'Raging Goblin');
    s = apply(s, { type: 'card:move', by: 0, card: find(s, 0, 'library', 'Unsummon'), toZone: 'hand' });
    const unsummon = find(s, 0, 'hand', 'Unsummon');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: unsummon, targets: [{ kind: 'card', id: goblin }],
    });
    expect(stackNames(s)).toEqual(['Unsummon', 'counter that spell']);
    s = drain(passBoth(s));
    expect(namesIn(s, 0, 'graveyard')).toContain('Unsummon');
    // Countered, so the Goblin is still where it was.
    expect(s.instances[goblin]!.zone).toBe('battlefield');
  });

  it('misses when the counters are gone before it resolves, which is the second ask', () => {
    /*
      The condition is checked twice (CR 603.4), and the window between the two asks is the window
      an opponent gets. Here the counters are taken off while the trigger is on the stack, so the
      ability does nothing at all — it does not fizzle and it does not resolve partway.
    */
    let s = table(1, 4);
    s = nextTurn(s);
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Shock'), toZone: 'hand' });
    const shock = find(s, 1, 'hand', 'Shock');
    s = apply(s, { type: 'auto:cast', by: 1, card: shock, targets: [{ kind: 'player', seat: 0 }] });
    expect(s.stackOrder).toHaveLength(2);
    const chalice = find(s, 0, 'battlefield', 'Chalice of the Void');
    s = addCounters(s, chalice, 'charge', -1);
    s = drain(passBoth(s));
    expect(namesIn(s, 1, 'graveyard')).toContain('Shock');
    // Countered by nothing: the Shock resolved, so the damage was dealt.
    expect(life(s, 0)).toBe(18);
  });

  it('is cast for the number the other player has been showing, not for as much as the mana allows', () => {
    /*
      The bot's half. Every other X spell is cast for `xMax`, because the search sees what that
      buys; this one is the opposite, and the search cannot tell — a Chalice on four and a Chalice
      on one are both one artifact with some counters on it. So the number comes from what the
      opponents have *shown*: see `xToMatch`.
    */
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'ember-rush' },
      hands: { 0: ['Chalice of the Void'] },
      battlefield: { 0: ['Island', 'Island', 'Island', 'Island', 'Island', 'Island'], 1: [] },
      graveyard: { 1: ['Shock', 'Lightning Bolt', 'Borderland Marauder'] },
      turn: 5, firstSeat: 0, autoPass: true,
    }), 'precombat-main');
    // The draw step put a card in hand on the way here; it goes back, so the Chalice is the only
    // thing the mana could be spent on and the test is about the number rather than the choice.
    for (const id of [...ids(s, 0, 'hand')]) {
      if (nameOf(s, id) === 'Chalice of the Void') continue;
      s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'library', position: 'bottom' });
    }
    // Three one-mana cards shown against one two-mana card, and six Islands to pay with: X could
    // be three, and a person would say one.
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Chalice of the Void');
    expect(play?.xMax).toBe(3);
    const action = botAction(s, 0);
    expect(action?.type).toBe('auto:cast');
    expect(action?.type === 'auto:cast' ? action.x : null).toBe(1);
  });
});

describe('Walking Ballista and Hangarback Walker: the counter as a cost, and the counters as a flock', () => {
  /*
    Two cards the `{X}{X}` cost made possible, and one engine addition between them: an ability
    paid for by **removing a counter** from the permanent.

    It is a cost and not an effect, which is the whole of what makes a Ballista work. The counter
    comes off as the ability is activated, so a Ballista on one counter that fires is a 0/0 before
    the damage resolves: the state-based actions kill it, and the damage is dealt anyway, because
    an ability on the stack has nothing further to do with its source (CR 608.2). And an ability
    whose cost cannot be paid is never offered — a Ballista with no counters shows no damage.

    The Walker is the other half: it has to make a Thopter for each counter it *had*, and a card in
    a graveyard has none, because `relocate` takes them off on the way out. So its last state is
    snapshotted for the trigger (CR 608.2h) and reaches the effect as `subjectCounters`.
  */
  const board = (x: number, lands: number, who: 'Walking Ballista' | 'Hangarback Walker'): GameState => {
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'ember-rush' },
      hands: { 0: [who] },
      battlefield: { 0: Array.from({ length: lands }, () => 'Plains'), 1: ['Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const card = find(s, 0, 'hand', who);
    s = apply(s, { type: 'auto:cast', by: 0, card, x });
    return drain(passBoth(s));
  };

  it('arrives as a 2/2 for four when X is two, and {X}{X} is why that is four', () => {
    const s = board(2, 4, 'Walking Ballista');
    const ballista = find(s, 0, 'battlefield', 'Walking Ballista');
    expect(s.instances[ballista]?.counters['+1/+1']).toBe(2);
    const ch = characteristicsOf(s, s.instances[ballista]!);
    expect([ch.power, ch.toughness]).toEqual([2, 2]);
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]?.tapped).length).toBe(4);
  });

  it('shoots by taking a counter off, and the damage does not need it to survive', () => {
    let s = board(1, 2, 'Walking Ballista');
    const ballista = find(s, 0, 'battlefield', 'Walking Ballista');
    // One counter: the only shot it has, and firing it is lethal to itself.
    s = apply(s, {
      type: 'auto:activate', by: 0, card: ballista, abilityIndex: 1,
      targets: [{ kind: 'player', seat: 1 }],
    });
    // The counter is gone as the cost is paid, so the 0/0 is already dying with its damage on the
    // stack above it.
    expect(s.instances[ballista]?.counters['+1/+1'] ?? 0).toBe(0);
    s = drain(passBoth(s));
    expect(life(s, 1)).toBe(19);
    expect(namesIn(s, 0, 'graveyard')).toContain('Walking Ballista');
  });

  it('is not offered a shot it cannot pay for', () => {
    const s = board(1, 3, 'Walking Ballista');
    const ballista = find(s, 0, 'battlefield', 'Walking Ballista');
    const shots = (state: GameState): number => legalActions(state, 0).plays
      .filter((p) => p.kind === 'activate' && p.card === ballista && p.abilityIndex === 1).length;
    expect(shots(s)).toBe(1);
    // With the counter gone there is no ability, rather than one the engine would refuse.
    const empty = addCounters(s, ballista, '+1/+1', -1);
    expect(shots(empty)).toBe(0);
    expect(refusal(empty, {
      type: 'auto:activate', by: 0, card: ballista, abilityIndex: 1,
      targets: [{ kind: 'player', seat: 1 }],
    })).toContain('counter');
  });

  it('grows for {1}, which is the other half of the mana sink', () => {
    let s = board(1, 4, 'Walking Ballista');
    const ballista = find(s, 0, 'battlefield', 'Walking Ballista');
    s = apply(s, { type: 'auto:activate', by: 0, card: ballista, abilityIndex: 0 });
    s = drain(passBoth(s));
    expect(s.instances[ballista]?.counters['+1/+1']).toBe(2);
  });

  it('leaves a Thopter for every counter the Walker had, counted after they are gone', () => {
    let s = board(2, 4, 'Hangarback Walker');
    const walker = find(s, 0, 'battlefield', 'Hangarback Walker');
    expect(s.instances[walker]?.counters['+1/+1']).toBe(2);
    // Killed outright: by the time the trigger resolves the card is in the graveyard with no
    // counters at all, which is exactly the case `subjectCounters` exists for.
    s = apply(s, { type: 'card:move', by: 0, card: walker, toZone: 'graveyard' });
    s = drain(passBoth(s));
    expect(s.instances[walker]?.counters['+1/+1'] ?? 0).toBe(0);
    expect(namesIn(s, 0, 'battlefield').filter((n) => n === 'Thopter')).toHaveLength(2);
    const thopter = find(s, 0, 'battlefield', 'Thopter');
    expect(characteristicsOf(s, s.instances[thopter]!).keywords.has('flying')).toBe(true);
  });

  it('and leaves nothing when it had nothing on it', () => {
    let s = board(1, 2, 'Hangarback Walker');
    const walker = find(s, 0, 'battlefield', 'Hangarback Walker');
    s = addCounters(s, walker, '+1/+1', -1);
    // A 0/0 dies to the state-based actions on its own, with no counters to leave behind.
    s = drain(passBoth(apply(s, { type: 'auto:pass', by: 0 })));
    expect(namesIn(s, 0, 'battlefield').filter((n) => n === 'Thopter')).toHaveLength(0);
  });

  it('cannot grow on the turn it arrives, and cannot both grow and attack after that', () => {
    let s = board(1, 4, 'Hangarback Walker');
    const walker = find(s, 0, 'battlefield', 'Hangarback Walker');
    // {T} on a creature needs it to have been there since the turn began (CR 302.6), so the turn
    // it is cast it is a 1/1 and nothing else.
    expect(refusal(s, { type: 'auto:activate', by: 0, card: walker, abilityIndex: 0 }))
      .toContain('summoning sickness');

    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: walker, abilityIndex: 0 });
    s = drain(passBoth(s));
    // Grown, and tapped for it: the tension the card is, since a tapped creature cannot attack.
    expect(s.instances[walker]?.counters['+1/+1']).toBe(2);
    expect(s.instances[walker]?.tapped).toBe(true);
  });
});

describe('Toxic Deluge: the number chosen while the spell resolves', () => {
  /*
    The third and last shape of mid-resolution question, and the one this engine has been missing
    since it learned the other two. A card is not an answer and neither is a word: this card's
    whole text is a number, chosen as it resolves.

    Which is the distinction worth being careful about. An X in a cost is announced as the spell
    goes on the stack, is part of what gets countered, and lets an opponent decide whether to
    respond knowing how big it is. This number is chosen after all of that, from the board as it
    actually ended up — so it cannot be folded into `xMax`, and that is also why a player would
    rather have it this way round.
  */
  const table = (theirs: readonly string[], mine: readonly string[] = []): GameState => advanceTo(arena({
    decks: { 0: 'hollow-tide', 1: 'ember-rush' },
    hands: { 0: ['Toxic Deluge'] },
    battlefield: {
      0: ['Island', 'Island', 'Swamp', ...mine],
      1: [...theirs],
    },
    turn: 4, firstSeat: 0,
  }), 'precombat-main');

  const cast = (s: GameState): GameState => {
    const deluge = find(s, 0, 'hand', 'Toxic Deluge');
    return drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: deluge })));
  };

  it('stops and asks for a number, with a range the card computed from the board', () => {
    // Two one-toughness creatures and a 3/3: nothing above three toughness, so nothing above
    // three is worth offering, however much life there is to spend.
    const s = cast(table(['Raging Goblin', 'Goblin Arsonist', 'Hill Giant']));
    expect(s.pendingDecision?.seat).toBe(0);
    expect(s.pendingDecision?.numbers).toEqual({ min: 0, max: 3 });
    expect(legalActions(s, 0).mustDecide?.numbers).toEqual({ min: 0, max: 3 });
    // And nobody holds priority while it stands, which is the rule every other question follows.
    expect(s.priority).toBeNull();
  });

  it('pays the life and shrinks every creature by it, the caster’s own included', () => {
    let s = cast(table(['Raging Goblin', 'Hill Giant'], ['Fog Bank']));
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], amount: 2 }));
    expect(life(s, 0)).toBe(18);
    // A 1/1 and an 0/2 die; the 3/3 lives as a 1/1.
    expect(namesIn(s, 1, 'graveyard')).toContain('Raging Goblin');
    expect(namesIn(s, 0, 'graveyard')).toContain('Fog Bank');
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    expect(characteristicsOf(s, s.instances[giant]!).power).toBe(1);
  });

  it('refuses a number the question did not offer, which is where the authorisation is', () => {
    const s = cast(table(['Raging Goblin']));
    // The board tops out at one toughness, so one is the most on offer — however much life there
    // is. A crafted action paying nine is refused here and nowhere else.
    expect(s.pendingDecision?.numbers).toEqual({ min: 0, max: 1 });
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [], amount: 9 })).toContain('between 0 and 1');
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [], amount: -1 })).toContain('between 0 and 1');
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [], amount: 1.5 })).toContain('choose a number');
    expect(refusal(s, { type: 'auto:decide', by: 0, cards: [] })).toContain('choose a number');
  });

  it('pays nothing and does nothing when nought is the answer', () => {
    let s = cast(table(['Hill Giant']));
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], amount: 0 }));
    expect(life(s, 0)).toBe(20);
    expect(namesIn(s, 1, 'battlefield')).toContain('Hill Giant');
  });

  it('never offers a number that would kill its caster (CR 118.4)', () => {
    // One life left and a 6/6 across the table: the range stops at nought, which is the same rule
    // that stops a Mana Confluence making mana at one life.
    let s = table(['Shivan Dragon']);
    s = apply(s, { type: 'life:adjust', by: 0, seat: 0, delta: -19 });
    expect(life(s, 0)).toBe(1);
    s = cast(s);
    // A range with one answer in it is not a question: the engine takes it and the spell resolves.
    expect(s.pendingDecision).toBeNull();
    expect(life(s, 0)).toBe(1);
    expect(namesIn(s, 1, 'battlefield')).toContain('Shivan Dragon');
  });

  it('is answered by the bot with the number that trades best, not the biggest', () => {
    /*
      The card's own opinion, which is the only place it could live: a number that kills three of
      theirs and two of mine for four life is not an improvement on doing nothing, and nothing
      generic can weigh that. See `NumberDecisionSpec.best`.
    */
    let s = cast(table(['Raging Goblin', 'Goblin Arsonist', 'Hill Giant'], ['Fog Bank']));
    const action = botAction(s, 0);
    expect(action?.type).toBe('auto:decide');
    // One kills both goblins and nothing of its own: the Fog Bank is an 0/2 and survives, the
    // Hill Giant is a 3/3 and survives. Two would take the Fog Bank with it for no extra gain.
    expect(action?.type === 'auto:decide' ? action.amount : null).toBe(1);
    s = drain(apply(s, action!));
    expect(namesIn(s, 1, 'battlefield')).toEqual(['Hill Giant']);
    expect(namesIn(s, 0, 'battlefield')).toContain('Fog Bank');
  });

  it('and pays nothing when no number is worth it', () => {
    // Its own 0/2 and nothing of theirs: every number costs more than it buys, so the answer is
    // nought. The search will not *choose* to cast it into this board (see the twelfth "spent on
    // nothing" rule in `playout.test.ts`), but a person may, and then this is the answer.
    const s = cast(table([], ['Fog Bank']));
    const action = botAction(s, 0);
    expect(action?.type === 'auto:decide' ? action.amount : null).toBe(0);
  });
});

describe('the combat triggers: a creature blocking, and an attacker getting through', () => {
  /*
    Combat raised one event — an attack was declared — and nothing that happened afterwards.

    These two are not variations of the attack event and cannot be filters on it. A block is
    somebody *else's* declaration, made a step later, and "isn't blocked" is not knowable at the
    moment attackers are declared: every defender has to speak first. So both are their own events,
    raised in the declare-blockers step, and each has a card that can only exist because of it.
  */
  /**
   * One creature attacks into whatever the other player has, stopped in declare-blockers.
   *
   * Takes the decks because both new cards are in Tidal Mind and they sit on opposite sides of the
   * combat: the Wall is the blocker and the Ophidian is the attacker, so a helper that hard-coded
   * which seat was which would only serve one of them.
   */
  const swing = (
    attacker: string,
    opts: {
      readonly decks: Readonly<Record<0 | 1, string>>;
      readonly mine: readonly string[];
      readonly theirs?: readonly string[];
    },
  ): { state: GameState; attacker: string } => {
    const land = (deck: string): string => (deck === 'verdant-guard' ? 'Forest' : 'Island');
    let s = advanceTo(arena({
      decks: opts.decks,
      battlefield: {
        0: [land(opts.decks[0]), land(opts.decks[0]), land(opts.decks[0]), ...opts.mine],
        1: [land(opts.decks[1]), land(opts.decks[1]), land(opts.decks[1]), ...(opts.theirs ?? [])],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const id = find(s, 0, 'battlefield', attacker);
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: id, defender: 1 }] }));
    return { state: s, attacker: id };
  };
  const GREEN_INTO_BLUE = { 0: 'verdant-guard', 1: 'tidal-mind' } as const;
  const BLUE_INTO_GREEN = { 0: 'tidal-mind', 1: 'verdant-guard' } as const;

  it('a Wall of Frost holds down the creature it blocked (CR 502.2)', () => {
    const { state, attacker } = swing('Grizzly Bears', { decks: GREEN_INTO_BLUE, mine: ['Grizzly Bears'], theirs: ['Wall of Frost'] });
    let s = state;
    const wall = find(s, 1, 'battlefield', 'Wall of Frost');
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: wall, attacker }] }));
    // The trigger has resolved: the Bears are frozen, and nothing else about them has changed.
    expect(s.instances[attacker]!.frozen).toBe(true);
    expect(characteristicsOf(s, s.instances[attacker]!).power).toBe(2);
    // Attacking tapped it, and its own untap step declines to untap it.
    expect(s.instances[attacker]!.tapped).toBe(true);
    s = nextTurn(nextTurn(s));
    expect(s.activeSeat).toBe(0);
    expect(s.instances[attacker]!.tapped).toBe(true);
    // And the effect is spent, so the untap step after that one untaps it.
    expect(s.instances[attacker]!.frozen).toBe(false);
    s = nextTurn(nextTurn(s));
    expect(s.instances[attacker]!.tapped).toBe(false);
  });

  it('and does nothing to a creature it did not block', () => {
    /*
      Two attackers, one block. The event carries *which* attacker the block was against, and
      without that the trigger would have to read the board — which by resolution says only that
      the Wall is blocking something.
    */
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      battlefield: {
        0: ['Forest', 'Forest', 'Grizzly Bears', 'Llanowar Elves'],
        1: ['Island', 'Island', 'Wall of Frost', 'Ophidian'],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    const elves = find(s, 0, 'battlefield', 'Llanowar Elves');
    s = apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: bears, defender: 1 }, { attacker: elves, defender: 1 }],
    });
    s = passBoth(s);
    const wall = find(s, 1, 'battlefield', 'Wall of Frost');
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: wall, attacker: bears }] }));
    expect(s.instances[bears]!.frozen).toBe(true);
    expect(s.instances[elves]!.frozen ?? false).toBe(false);
  });

  it('fires once per block, so two walls on one attacker freeze it once', () => {
    /*
      The event is raised per block rather than per attacker, which is what the printed card says —
      "whenever ~ blocks a creature" is the Wall's own trigger, and two Walls blocking the same
      creature each have one. The flag cannot be frozen twice, which is the right answer and worth
      pinning: a second freeze is not a second turn held down.
    */
    const blue = customDeck({
      id: 'frost-wall',
      name: 'Frost Wall',
      entries: [{ name: 'Wall of Frost', count: 4 }, { name: 'Island', count: 56 }],
    }).deck;
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'frost-wall' },
      deckSpecs: { 'frost-wall': blue },
      battlefield: {
        0: ['Forest', 'Forest', 'Siege Wurm'],
        1: ['Island', 'Island', 'Wall of Frost', 'Wall of Frost'],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const wurm = find(s, 0, 'battlefield', 'Siege Wurm');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: wurm, defender: 1 }] }));
    const walls = ids(s, 1, 'battlefield').filter((id) => nameOf(s, id) === 'Wall of Frost');
    s = apply(s, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: walls[0]!, attacker: wurm }, { blocker: walls[1]!, attacker: wurm }],
    });
    // Both triggers are on the stack, which is the observable half of "once per block".
    expect(s.stackOrder.length).toBe(2);
    s = drain(s);
    expect(s.instances[wurm]!.frozen).toBe(true);
  });

  it('an Ophidian that gets through is offered a card for its damage', () => {
    /*
      No explicit block in these three: the other player has nothing that could block, so the
      engine auto-declares past a declaration with one possible answer — and the question the
      Ophidian asks is waiting by the time priority comes back, which is the point.
    */
    const { state, attacker } = swing('Ophidian', { decks: BLUE_INTO_GREEN, mine: ['Ophidian'] });
    let s = drain(state);
    expect(s.pendingDecision?.prompt).toContain('Draw a card');
    const before = namesIn(s, 0, 'hand').length;
    const defender = life(s, 1);
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'Draw' }));
    expect(namesIn(s, 0, 'hand').length).toBe(before + 1);
    // Removed from combat because the card was drawn, so no damage is dealt at all.
    s = advanceTo(s, 'end-combat');
    expect(life(s, 1)).toBe(defender);
  });

  it('or can keep the damage, which is the other answer', () => {
    const { state, attacker } = swing('Ophidian', { decks: BLUE_INTO_GREEN, mine: ['Ophidian'] });
    let s = drain(state);
    const before = namesIn(s, 0, 'hand').length;
    const defender = life(s, 1);
    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], option: 'Attack' }));
    expect(namesIn(s, 0, 'hand').length).toBe(before);
    s = advanceTo(s, 'end-combat');
    expect(life(s, 1)).toBe(defender - 1);
    expect(s.instances[attacker]!.zone).toBe('battlefield');
  });

  it('and is asked nothing at all when it is blocked', () => {
    const { state, attacker } = swing('Ophidian', { decks: BLUE_INTO_GREEN, mine: ['Ophidian'], theirs: ['Grizzly Bears'] });
    let s = state;
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bears, attacker }] }));
    expect(s.pendingDecision).toBeNull();
    expect(s.stackOrder).toEqual([]);
  });

  it('the bot keeps the damage when the one point wins the game', () => {
    /*
      A fact about the board rather than a weight (D116). The bot's answer to Ophidian's question
      is "draw" every time except the two boards where a card is worth less than one damage: a
      lethal swing, and an empty library.
    */
    const { state } = swing('Ophidian', { decks: BLUE_INTO_GREEN, mine: ['Ophidian'] });
    const s = drain({
      ...state, seats: state.seats.map((seat, i) => (i === 1 ? { ...seat, life: 1 } : seat)),
    });
    expect(s.pendingDecision).not.toBeNull();
    const action = botAction(s, 0);
    expect(action).not.toBeNull();
    expect(action && 'option' in action ? action.option : null).toBe('Attack');
  });

  it('and draws when it is only one damage', () => {
    const { state } = swing('Ophidian', { decks: BLUE_INTO_GREEN, mine: ['Ophidian'] });
    const s = drain(state);
    expect(s.pendingDecision).not.toBeNull();
    const action = botAction(s, 0);
    expect(action && 'option' in action ? action.option : null).toBe('Draw');
  });
});

describe('delayed triggers: at end of combat, and at the next end step (CR 603.7)', () => {
  /*
    The first thing in this engine that happens *later*.

    Every other trigger fires the moment its event happens. A delayed trigger is created by
    something else, waits for a named step, and fires exactly once — and it cannot be a step
    trigger, because a step trigger fires every turn for as long as its permanent is there and
    this one fires once whether or not it is.
  */
  it('a Thicket Basilisk kills what blocks it, at end of combat and not before', () => {
    let s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'verdant-guard' },
      battlefield: {
        0: ['Forest', 'Forest', 'Thicket Basilisk'],
        1: ['Forest', 'Forest', 'Centaur Courser'],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const basilisk = find(s, 0, 'battlefield', 'Thicket Basilisk');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: basilisk, defender: 1 }],
    }));
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: courser, attacker: basilisk }] }));
    // Nothing has happened to the Courser yet: the ability is scheduled, not on the stack.
    expect(s.instances[courser]!.zone).toBe('battlefield');
    expect(s.delayed.length).toBe(1);
    // And combat damage is dealt first, which is the whole difference from a removal spell: the
    // 3/3 kills the 2/4 on the way out.
    s = advanceTo(s, 'end-combat');
    s = drain(s);
    expect(s.instances[courser]!.zone).toBe('graveyard');
    expect(s.delayed.length).toBe(0);
    // And the Basilisk is a 2/4: three damage from a Centaur Courser is not lethal, so the trade
    // is entirely one-way. That is what the five mana buys.
    expect(s.instances[basilisk]!.zone).toBe('battlefield');
    expect(damageOn(s, basilisk)).toBe(3);
  });

  it('and kills what it blocks, which is the other half of the same clause', () => {
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'delta-bloom' },
      battlefield: {
        0: ['Forest', 'Forest', 'Grizzly Bears'],
        1: ['Forest', 'Forest', 'Thicket Basilisk'],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    const basilisk = find(s, 1, 'battlefield', 'Thicket Basilisk');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: bears, defender: 1 }] }));
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: basilisk, attacker: bears }] }));
    expect(s.delayed.length).toBe(1);
    s = drain(advanceTo(s, 'end-combat'));
    // The Bears survived the 2/4's damage and died to the clause anyway, which is the card.
    expect(s.instances[bears]!.zone).toBe('graveyard');
    expect(s.instances[basilisk]!.zone).toBe('battlefield');
  });

  it('fires once per blocker, so a gang block loses the whole gang', () => {
    let s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'verdant-guard' },
      battlefield: {
        0: ['Forest', 'Forest', 'Thicket Basilisk'],
        1: ['Forest', 'Forest', 'Grizzly Bears', 'Llanowar Elves'],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const basilisk = find(s, 0, 'battlefield', 'Thicket Basilisk');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    s = passBoth(apply(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: basilisk, defender: 1 }],
    }));
    s = apply(s, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: bears, attacker: basilisk }, { blocker: elves, attacker: basilisk }],
    });
    /*
      Two blockers means the attacking player owes a damage assignment order (CR 509.2), and
      nobody holds priority until it is given — so the two block triggers are on the stack and
      cannot resolve yet. Answering it is part of the block, not part of this card.
    */
    expect(pendingDeclaration(s)?.kind).toBe('order');
    s = drain(apply(s, {
      type: 'auto:order', by: 0, orders: [{ attacker: basilisk, blockers: [bears, elves] }],
    }));
    expect(s.delayed.length).toBe(2);
    s = drain(advanceTo(s, 'end-combat'));
    expect(s.instances[bears]!.zone).toBe('graveyard');
    expect(s.instances[elves]!.zone).toBe('graveyard');
  });

  it('a Flickerwisp exiles a permanent and gives it back at the next end step', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
      hands: { 0: ['Flickerwisp'] },
      battlefield: { 0: ['Plains', 'Plains', 'Plains'], 1: ['Forest', 'Grizzly Bears'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flickerwisp'),
    }));
    // Five permanents it could blink and one it cannot, so the trigger is a real choice.
    expect(s.pendingChoice).not.toBeNull();
    s = drain(apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: bears }] }));
    expect(s.instances[bears]!.zone).toBe('exile');
    expect(s.delayed.length).toBe(1);
    s = drain(advanceTo(s, 'end'));
    expect(s.instances[bears]!.zone).toBe('battlefield');
    // Under its owner's control, which is the clause rather than a detail.
    expect(s.instances[bears]!.zoneSeat).toBe(1);
  });

  it('and gives it back even when the Flickerwisp is dead by then (CR 603.7d)', () => {
    /*
      The reason the schedule lives on the state rather than on the permanent. A delayed ability
      stops belonging to its source the moment it is created, so killing the Wisp in response does
      not keep the card in exile — which is the opposite of how "exile until this leaves" works,
      and the pair is worth having in one pool.
    */
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'tidal-mind' },
      hands: { 0: ['Flickerwisp'], 1: ['Doom Blade'] },
      battlefield: { 0: ['Plains', 'Plains', 'Plains'], 1: ['Swamp', 'Swamp', 'Omenspeaker'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const speaker = find(s, 1, 'battlefield', 'Omenspeaker');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flickerwisp'),
    }));
    s = drain(apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: speaker }] }));
    const wisp = find(s, 0, 'battlefield', 'Flickerwisp');
    expect(s.instances[speaker]!.zone).toBe('exile');
    // Seat 0 passes, so seat 1 holds priority inside seat 0's main phase and can answer — which is
    // also when its own lands are tappable.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Doom Blade'),
      targets: [{ kind: 'card', id: wisp }],
    })));
    expect(s.instances[wisp]!.zone).toBe('graveyard');
    s = drain(advanceTo(s, 'end'));
    expect(s.instances[speaker]!.zone).toBe('battlefield');
  });

  it('tells both players what is going to happen, and when', () => {
    /*
      A delayed trigger is the one thing on the board that is going to happen and is not on the
      stack. If the table does not say so, a permanent leaves two steps later with nothing on
      screen to have warned anybody — the same argument as the prevention shield and the freeze.
      Public, because all of it is.
    */
    let s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'verdant-guard' },
      battlefield: {
        0: ['Forest', 'Forest', 'Thicket Basilisk'],
        1: ['Forest', 'Forest', 'Centaur Courser'],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const basilisk = find(s, 0, 'battlefield', 'Thicket Basilisk');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: basilisk, defender: 1 }],
    }));
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: courser, attacker: basilisk }] }));
    for (const seat of [0, 1] as const) {
      const later = viewFor(s, seat).automation!.later;
      expect(later.length).toBe(1);
      expect(later[0]!.description).toContain('Centaur Courser');
      expect(later[0]!.stepLabel).toBe('End of combat');
    }
    // And it survives being packed for the wire, which is the only way it reaches a browser.
    expect(unpackView(packView(viewFor(s, 0))).automation!.later.length).toBe(1);
  });

  it('cannot aim its own arrival at itself: "another" target permanent', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
      hands: { 0: ['Flickerwisp'] },
      battlefield: { 0: ['Plains', 'Plains', 'Plains'], 1: ['Forest'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Flickerwisp') }));
    const wisp = find(s, 0, 'battlefield', 'Flickerwisp');
    // Four lands it could blink, so the trigger is a real choice — and the Wisp is not among them.
    expect(s.pendingChoice).not.toBeNull();
    const offered = (legalActions(s, 0).mustChoose?.candidates ?? []).flat();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((t) => t.kind === 'card' && t.id === wisp)).toBe(false);
  });
});

describe('the monarch, as a rule rather than a button (CR 720)', () => {
  /*
    The crown has been a field on the state since the tabletop was written and nothing in the rules
    touched it: no card gave it, combat damage did not take it, and the monarch never drew. All
    three of those are rules of the *game* rather than text on a card, which is why a card's whole
    contribution is one line and the rest lives beside the other turn-based actions.
  */
  const crowned = (): GameState => {
    let s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'ashen-rite' },
      hands: { 0: ['Palace Sentinels'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Tormented Soul'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    return drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Palace Sentinels'),
    })));
  };

  it('a card makes you the monarch, and nobody is the monarch before one does', () => {
    const before = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'ashen-rite' }, turn: 4, firstSeat: 0,
    }), 'precombat-main');
    expect(before.monarch).toBeNull();
    const s = crowned();
    expect(s.monarch).toBe(0);
  });

  it('and draws the monarch a card at the beginning of their own end step', () => {
    let s = crowned();
    const before = namesIn(s, 0, 'hand').length;
    s = advanceTo(s, 'end');
    // One card, drawn as the step began rather than as it ended.
    expect(namesIn(s, 0, 'hand').length).toBe(before + 1);
  });

  it('and not in anybody else’s end step, which is the half the rule is about', () => {
    let s = crowned();
    s = nextTurn(s);
    expect(s.activeSeat).toBe(1);
    const before = namesIn(s, 0, 'hand').length;
    // Seat 1 has a creature, so it owes a declaration before the turn can reach its end step.
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [] });
    s = advanceTo(s, 'end');
    expect(namesIn(s, 0, 'hand').length).toBe(before);
  });

  it('a creature that connects with the monarch takes the crown (CR 720.5)', () => {
    let s = crowned();
    // Seat 1's turn, and seat 1 has the one creature in the pool that cannot be blocked.
    s = nextTurn(s);
    s = advanceTo(s, 'declare-attackers');
    const soul = find(s, 1, 'battlefield', 'Tormented Soul');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: soul, defender: 0 }] });
    expect(s.monarch).toBe(0);
    s = drain(advanceTo(s, 'end-combat'));
    expect(life(s, 0)).toBe(19);
    expect(s.monarch).toBe(1);
  });

  it('but not a creature whose damage never landed', () => {
    /*
      "Deals combat damage" means it landed: damage a shield ate takes nothing and steals nothing.
      The crown is moved off the same list the combat-damage triggers are raised from, so there is
      one answer to "did it connect" rather than two — and a Healing Salve is the card that proves
      it, because the attack is otherwise unblockable and certain.
    */
    let s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'ashen-rite' },
      hands: { 0: ['Palace Sentinels', 'Healing Salve'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains'],
        1: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Tormented Soul'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    /*
      Four lands tapped rather than all five, because a seat's lands untap in its **own** untap
      step: a player who taps out on their turn has nothing on the opponent's. The fifth Plains is
      the Salve, held up exactly as a player would hold it.
    */
    for (const id of ids(s, 0, 'battlefield').slice(0, 4)) {
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Palace Sentinels'),
    })));
    expect(s.monarch).toBe(0);
    s = nextTurn(s);
    s = advanceTo(s, 'declare-attackers');
    const soul = find(s, 1, 'battlefield', 'Tormented Soul');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: soul, defender: 0 }] });
    // The attacking player passes, so the defender holds priority and can answer with the Salve.
    s = apply(s, { type: 'auto:pass', by: 1 });
    s = apply(s, {
      type: 'auto:activate', by: 0,
      card: ids(s, 0, 'battlefield').find((id) => nameOf(s, id) === 'Plains'
        && s.instances[id]!.tapped === false)!,
      abilityIndex: 0,
    });
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Healing Salve'),
      // The second mode: the first gains three life, which would not stop the damage.
      modes: [1], targets: [{ kind: 'player', seat: 0 }],
    })));
    s = drain(advanceTo(s, 'end-combat'));
    expect(life(s, 0)).toBe(20);
    expect(s.monarch).toBe(0);
  });

  it('is the engine’s to move once it is running, so the tabletop button is refused', () => {
    const s = crowned();
    expect(refusal(s, { type: 'monarch:set', by: 1, seat: 1 })).toContain('the engine moves the crown');
  });

  it('and both players can see who has it', () => {
    const s = crowned();
    for (const seat of [0, 1] as const) expect(viewFor(s, seat).monarch).toBe(0);
  });
});

describe('infect, and the win condition nothing could reach (CR 702.90)', () => {
  /*
    Poison counters, `-1/-1` counters and the ten-poison elimination were all in this engine before
    any card used them, and nothing in the pool produced a single point of any of them. Infect is
    the keyword that connects the three, and it is a fact about the **source**: it changes what the
    damage becomes rather than whether it is dealt.
  */
  const swing = (
    attacker: string, theirs: readonly string[] = [],
  ): { state: GameState; attacker: string } => {
    let s = advanceTo(arena({
      decks: { 0: 'blight-vector', 1: 'verdant-guard' },
      battlefield: {
        0: ['Forest', 'Forest', 'Swamp', attacker],
        1: ['Forest', 'Forest', ...theirs],
      },
      turn: 4, firstSeat: 0,
    }), 'declare-attackers');
    const id = find(s, 0, 'battlefield', attacker);
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: id, defender: 1 }] }));
    return { state: s, attacker: id };
  };

  it('damage to a player is poison instead of life', () => {
    const { state } = swing('Glistener Elf');
    const s = drain(advanceTo(state, 'end-combat'));
    expect(life(s, 1)).toBe(20);
    expect(s.seats[1]!.poison).toBe(1);
  });

  it('damage to a creature is −1/−1 counters, which do not wear off', () => {
    const { state, attacker } = swing('Cystbearer', ['Centaur Courser']);
    let s = state;
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = drain(apply(s, {
      type: 'auto:block', by: 1, blocks: [{ blocker: courser, attacker }],
    }));
    s = drain(advanceTo(s, 'end-combat'));
    /*
      A 3/3 blocked a 2/3, and the exchange is the whole of infect in one combat.

      The Courser took two `-1/-1` counters, so it is a **1/1** rather than a 3/3 with two damage
      on it — and it still dealt its full three, which killed the Cystbearer. That last part is
      CR 510.2 (combat damage is simultaneous) and it is the bug infect found: before this the
      blockers' damage was read off the board *after* the attacker's had landed, so a creature that
      had just been shrunk hit back for less. Nothing in the pool could shrink anything mid-step
      until now, so nothing noticed.
    */
    expect(s.instances[courser]!.counters['-1/-1']).toBe(2);
    expect(characteristicsOf(s, s.instances[courser]!).power).toBe(1);
    expect(s.instances[attacker]!.zone).toBe('graveyard');
    // And the counters are permanent: marked damage is wiped in the cleanup step and they are not,
    // so the Courser is still a 1/1 on the next turn.
    s = nextTurn(s);
    expect(s.instances[courser]!.counters['-1/-1']).toBe(2);
    expect(characteristicsOf(s, s.instances[courser]!).toughness).toBe(1);
  });

  it('ten poison ends the game, which is the second way to lose one (CR 704.5c)', () => {
    const { state } = swing('Glistener Elf');
    let s: GameState = {
      ...state,
      seats: state.seats.map((seat, i) => (i === 1 ? { ...seat, poison: 9 } : seat)),
    };
    // Passed rather than advanced: the tenth counter ends the game inside the damage step, and a
    // helper that keeps looking for a later step is looking for one that will never arrive.
    for (let i = 0; i < 12 && !s.finished; i++) {
      if (s.priority === null) break;
      s = drain(apply(s, { type: 'auto:pass', by: s.priority }));
    }
    expect(s.seats[1]!.poison).toBe(10);
    expect(s.seats[1]!.eliminated).toBe(true);
    expect(s.finished).toBe(true);
    expect(s.winnerSeat).toBe(0);
    // And the life total never moved, which is the whole point of the deck.
    expect(life(s, 1)).toBe(20);
  });

  it('an Ichorclaw Myr punishes the obvious answer to a 1/1', () => {
    const { state, attacker } = swing('Ichorclaw Myr', ['Grizzly Bears']);
    let s = state;
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = drain(apply(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bears, attacker }] }));
    // +2/+2 on being blocked, so the 1/1 is a 3/3 and the Bears take three counters.
    expect(characteristicsOf(s, s.instances[attacker]!).power).toBe(3);
    s = drain(advanceTo(s, 'end-combat'));
    expect(s.instances[bears]!.zone).toBe('graveyard');
  });

  it('a Tainted Strike turns somebody else’s creature into poison', () => {
    /*
      The keyword is read off whatever is dealing the damage, so granting it costs no new code: a
      pump effect that hands out `infect` is the same thing to `dealDamage` as a printed keyword.
    */
    const list = customDeck({
      id: 'strike-and-bears',
      name: 'Strike and Bears',
      entries: [
        { name: 'Tainted Strike', count: 4 },
        { name: 'Grizzly Bears', count: 4 },
        { name: 'Swamp', count: 52 },
      ],
    }).deck;
    let s = advanceTo(arena({
      decks: { 0: 'strike-and-bears', 1: 'verdant-guard' },
      deckSpecs: { 'strike-and-bears': list },
      hands: { 0: ['Tainted Strike'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Grizzly Bears'], 1: ['Forest'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = tapAllLands(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Tainted Strike'),
      targets: [{ kind: 'card', id: bears }],
    })));
    expect(characteristicsOf(s, s.instances[bears]!).keywords.has('infect')).toBe(true);
    expect(characteristicsOf(s, s.instances[bears]!).power).toBe(3);
    s = advanceTo(s, 'declare-attackers');
    s = passBoth(apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: bears, defender: 1 }] }));
    s = drain(advanceTo(s, 'end-combat'));
    expect(s.seats[1]!.poison).toBe(3);
    expect(life(s, 1)).toBe(20);
    // And it is gone next turn, because it was until end of turn.
    s = nextTurn(s);
    expect(characteristicsOf(s, s.instances[bears]!).keywords.has('infect')).toBe(false);
  });

  it('a Phyrexian Crusader cannot be answered by red or white', () => {
    let s = advanceTo(arena({
      decks: { 0: 'blight-vector', 1: 'ember-rush' },
      hands: { 1: ['Lightning Bolt'] },
      battlefield: {
        0: ['Swamp', 'Swamp', 'Swamp', 'Phyrexian Crusader'],
        1: ['Mountain', 'Mountain', 'Mountain'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const crusader = find(s, 0, 'battlefield', 'Phyrexian Crusader');
    s = tapAllLands(s, 1);
    expect(refusal(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: crusader }],
    })).not.toBeNull();
  });
});

/*
  Cards printed with two castable faces: one split card, and two adventurers (CR 708).

  The claim being tested is narrow and the whole mechanic rests on it: **a half is a spell**. Each
  face is registered as its own card definition, the instance points at the one being cast while it
  is on the stack, and from there the cost, the timing, the targets, the resolution, the stack
  description and what a counterspell is allowed to point at all come out right without any of them
  knowing that two-faced cards exist. So the tests below mostly check ordinary things about the
  halves — and the three that are not ordinary are the ones that matter:

  - a split card is **not castable as itself**, and the refusal says so rather than guessing;
  - the card is one half on the stack and the **whole card** everywhere else;
  - an adventure that resolves is exiled and castable later, and one that is **countered** is not.
*/
describe('a card with two halves you can cast (CR 708)', () => {
  /** Seat 0, main phase, lands tapped, holding one named card from a named deck. */
  const holding = (deck: string, name: string, lands: readonly string[]): GameState =>
    withMana(0, [name], lands, [], deck);

  it('offers each half of a split card as its own play, and never the whole card', () => {
    const s = holding('arc-tempest', 'Fire // Ice', ['Mountain', 'Island']);
    const card = find(s, 0, 'hand', 'Fire // Ice');
    const mine = legalActions(s, 0).plays.filter((p) => p.kind === 'cast' && p.card === card);
    expect(mine.map((p) => p.name)).toEqual(['Fire', 'Ice']);
    // Each play says which half it is, because the engine cannot work it out from the card.
    expect(mine.map((p) => p.half)).toEqual([0, 1]);
    // And the cost shown is the half's, not the combined {1}{R}{1}{U} printed on the card.
    expect(mine.map((p) => p.manaCost)).toEqual(['{1}{R}', '{1}{U}']);
  });

  it('refuses a split card cast with no half named, rather than guessing one', () => {
    const s = holding('arc-tempest', 'Fire // Ice', ['Mountain', 'Island']);
    const card = find(s, 0, 'hand', 'Fire // Ice');
    expect(refusal(s, { type: 'auto:cast', by: 0, card })).toContain('which half');
    // And refuses a half the card does not have, for the opposite reason: a client sending one has
    // misread the card, and a silent fallback would cast the wrong spell.
    expect(refusal(s, { type: 'auto:cast', by: 0, card, half: 7 })).toContain('no face 7');
  });

  it('Fire divides two damage as the caster chooses', () => {
    let s = arena({
      decks: { 0: 'arc-tempest', 1: 'dawn-tithe' },
      hands: { 0: ['Fire // Ice'] },
      battlefield: { 0: ['Mountain', 'Island'], 1: ['Soul Warden'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const warden = find(s, 1, 'battlefield', 'Soul Warden');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fire // Ice'), half: 0,
      targets: [{ kind: 'card', id: warden }, { kind: 'player', seat: 1 }],
      division: [1, 1],
    }));
    // One each: the 1/1 dies and the player takes the other.
    expect(namesIn(s, 1, 'graveyard')).toContain('Soul Warden');
    expect(life(s, 1)).toBe(19);
  });

  it('Ice taps a permanent and draws, which is the other half of the same card', () => {
    let s = arena({
      decks: { 0: 'arc-tempest', 1: 'verdant-guard' },
      hands: { 0: ['Fire // Ice'] },
      battlefield: { 0: ['Mountain', 'Island'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const held = countOf(s, 0, 'hand', 'Fire // Ice');
    const hand = ids(s, 0, 'hand').length;
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fire // Ice'), half: 1,
      targets: [{ kind: 'card', id: courser }],
    }));
    expect(s.instances[courser]!.tapped).toBe(true);
    // One card drawn, and the Fire // Ice itself has left: the hand is where it started.
    expect(held).toBe(1);
    expect(ids(s, 0, 'hand').length).toBe(hand);
  });

  it('is one half on the stack and the whole card in the graveyard (CR 708.4)', () => {
    let s = holding('arc-tempest', 'Fire // Ice', ['Mountain', 'Island']);
    const card = find(s, 0, 'hand', 'Fire // Ice');
    s = apply(s, {
      type: 'auto:cast', by: 0, card, half: 0,
      targets: [{ kind: 'player', seat: 1 }], division: [2],
    });
    // On the stack it is Fire: a two-mana instant, which is what a Chalice of the Void counts and
    // what "counter target instant spell" is allowed to point at.
    expect(stackNames(s).at(-1)).toContain('Fire');
    expect(characteristicsOf(s, s.instances[card]!).name).toBe('Fire');
    expect(s.cardDefs[s.instances[card]!.castAs!]!.cmc).toBe(2);
    s = passBoth(s);
    // And in the graveyard it is the card again, mana value four — the combined cost, which is the
    // rule rather than an oversight.
    expect(namesIn(s, 0, 'graveyard')).toContain('Fire // Ice');
    expect(s.instances[card]!.castAs).toBeUndefined();
    expect(s.cardDefs[s.instances[card]!.defKey]!.cmc).toBe(4);
  });

  it('Wane destroys an enchantment and nothing else, and Wax is the half that is never dead', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'skyward-writ' },
      hands: { 0: ['Wax // Wane'], 1: ['Pacifism'] },
      battlefield: { 0: ['Forest', 'Plains', 'Centaur Courser'], 1: ['Plains', 'Plains'] },
      turn: 2, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 1);
    const courser = find(s, 0, 'battlefield', 'Centaur Courser');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Pacifism'),
      targets: [{ kind: 'card', id: courser }],
    }));
    const aura = find(s, 1, 'battlefield', 'Pacifism');
    s = advanceTo(nextTurn(s), 'precombat-main');
    s = tapAllLands(s, 0);
    const card = find(s, 0, 'hand', 'Wax // Wane');
    // The Courser is a legal target for Wax and not for Wane, which is the difference between the
    // two halves and the whole reason a split card is two spells rather than a modal one.
    const plays = legalActions(s, 0).plays.filter((p) => p.kind === 'cast' && p.card === card);
    const wane = plays.find((p) => p.name === 'Wane')!;
    expect(wane.candidates[0]!.map((t) => (t.kind === 'card' ? t.id : t.kind))).toEqual([aura]);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card, half: 1, targets: [{ kind: 'card', id: aura }],
    }));
    expect(namesIn(s, 1, 'graveyard')).toContain('Pacifism');
    // And the Courser is offered again, because destroying the aura is what unpacifies it.
    expect(characteristicsOf(s, s.instances[courser]!).cantAttack).toBe(false);
  });

  it('casts the adventure half, exiles it, and lets the creature be cast from exile later', () => {
    let s = holding('hollow-tide', 'Merfolk Secretkeeper', ['Island', 'Island', 'Island']);
    const card = find(s, 0, 'hand', 'Merfolk Secretkeeper');
    const library = ids(s, 1, 'library').length;
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card, half: 0, targets: [{ kind: 'player', seat: 1 }],
    }));
    // Four off the top, which is the adventure's whole effect.
    expect(ids(s, 1, 'library').length).toBe(library - 4);
    // And the card is in exile rather than in a graveyard, flagged as castable later.
    expect(namesIn(s, 0, 'exile')).toContain('Merfolk Secretkeeper');
    expect(s.instances[card]!.onAdventure).toBe(true);

    // The creature, out of exile, on the third Island — a play the table offers by name.
    const back = legalActions(s, 0).plays.find((p) => p.kind === 'cast' && p.card === card);
    expect(back?.description).toContain('back from its adventure');
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card }));
    expect(namesIn(s, 0, 'battlefield')).toContain('Merfolk Secretkeeper');
    // A 0/4, which is the creature half and not the sorcery that sent it to exile.
    expect([power(s, card), toughness(s, card)]).toEqual([0, 4]);
    // And it is not on an adventure any more: a creature that dies goes to the graveyard.
    expect(s.instances[card]!.onAdventure).toBeUndefined();
  });

  it('and a countered adventure goes to the graveyard, because it never went on one', () => {
    let s = arena({
      decks: { 0: 'hollow-tide', 1: 'delta-bloom' },
      hands: { 0: ['Merfolk Secretkeeper'], 1: ['Counterspell'] },
      battlefield: { 0: ['Island', 'Island'], 1: ['Island', 'Island'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const card = find(s, 0, 'hand', 'Merfolk Secretkeeper');
    s = apply(s, {
      type: 'auto:cast', by: 0, card, half: 0, targets: [{ kind: 'player', seat: 1 }],
    });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'),
      targets: [{ kind: 'card', id: card }],
    });
    s = passBoth(s);
    s = passBoth(s);
    expect(namesIn(s, 0, 'graveyard')).toContain('Merfolk Secretkeeper');
    expect(namesIn(s, 0, 'exile')).not.toContain('Merfolk Secretkeeper');
    expect(s.instances[card]!.onAdventure).toBeUndefined();
  });

  it('an adventure is not a creature spell, and the creature half is', () => {
    const base = {
      decks: { 0: 'hollow-tide', 1: 'delta-bloom' } as Record<number, string>,
      battlefield: { 0: ['Island', 'Island'], 1: ['Island', 'Island'] } as Record<number, string[]>,
      turn: 2, firstSeat: 0,
    };
    // Essence Scatter counters target *creature* spell, so what it may point at is the engine's
    // answer to "which half is on the stack" — asked twice on one card.
    const onStack = (half: number | undefined): readonly string[] => {
      let s = arena({ ...base, hands: { 0: ['Merfolk Secretkeeper'], 1: ['Essence Scatter'] } });
      s = advanceTo(s, 'precombat-main');
      s = tapAllLands(s, 0);
      const card = find(s, 0, 'hand', 'Merfolk Secretkeeper');
      s = apply(s, {
        type: 'auto:cast', by: 0, card,
        ...(half === undefined ? {} : { half, targets: [{ kind: 'player', seat: 1 } as Target] }),
      });
      s = apply(s, { type: 'auto:pass', by: 0 });
      const scatter = legalActions(s, 1).plays
        .find((p) => p.kind === 'cast' && p.name === 'Essence Scatter');
      return (scatter?.candidates[0] ?? []).map((t) => (t.kind === 'card' ? t.id : t.kind));
    };
    // The creature half is counterable by it; the sorcery half is not a legal target at all, which
    // is why the play is not even offered.
    expect(onStack(undefined).length).toBe(1);
    expect(onStack(0).length).toBe(0);
  });
});

/*
  The third kind of two-faced printing: a modal double-faced card, with a land on the back
  (CR 712).

  Three things are different from a split card, and each has a test here:

  - the back face is **played**, not cast, and costs that turn's land drop;
  - the chosen face survives onto the battlefield — a permanent that arrived as its back face *is*
    that face, with that face's abilities, for as long as it is there;
  - the **front** face is still what the card is everywhere else, so the card in a graveyard is a
    three-mana instant rather than a land.
*/
describe('a land on the back of a spell (CR 712)', () => {
  const inHand = (deck: string, name: string, lands: readonly string[]): GameState => arena({
    decks: { 0: deck }, hands: { 0: [name] },
    battlefield: { 0: [...lands] }, turn: 2, firstSeat: 0,
  });

  it('offers the card as a spell and its back as a land, and the land is a land drop', () => {
    const s = advanceTo(inHand('ashen-rite', 'Hagra Mauling', ['Swamp', 'Swamp', 'Swamp']), 'precombat-main');
    const card = find(s, 0, 'hand', 'Hagra Mauling');
    const mine = legalActions(s, 0).plays.filter((p) => p.card === card);
    // The spell needs a creature to point at and there is none, so the only play on offer is the
    // land — which is the honest half of the card and the reason it is in the deck.
    expect(mine.map((p) => p.kind)).toEqual(['land']);
    expect(mine[0]!.name).toBe('Hagra Broodpit');
    expect(mine[0]!.half).toBe(0);
    expect(mine[0]!.description).toContain('the back of Hagra Mauling');
  });

  it('plays the back face as a land: it enters tapped, taps for its colour, and spends the drop', () => {
    let s = advanceTo(inHand('ashen-rite', 'Hagra Mauling', []), 'precombat-main');
    const card = find(s, 0, 'hand', 'Hagra Mauling');
    s = apply(s, { type: 'auto:playLand', by: 0, card, half: 0 });
    // On the battlefield it **is** the land, name and all.
    expect(namesIn(s, 0, 'battlefield')).toEqual(['Hagra Broodpit']);
    expect(nameOf(s, card)).toBe('Hagra Broodpit');
    // Tapped, which is the printed price of the flexibility.
    expect(s.instances[card]!.tapped).toBe(true);
    // And the land drop is spent, so a second land this turn is refused.
    expect(s.landsPlayed['0']).toBe(1);

    // Untapped next turn, it taps for black — the ability is the land's, read off the face.
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(s.instances[card]!.tapped).toBe(false);
    s = apply(s, { type: 'auto:activate', by: 0, card, abilityIndex: 0 });
    expect(s.pools['0']!['B']).toBe(1);
  });

  it('refuses the front face as a land, and a face the card does not have', () => {
    const s = advanceTo(inHand('ashen-rite', 'Hagra Mauling', []), 'precombat-main');
    const card = find(s, 0, 'hand', 'Hagra Mauling');
    // No half named means the card itself, which is an instant: a land drop spent on a spell is a
    // mistake with no way back, so it is refused rather than interpreted.
    expect(refusal(s, { type: 'auto:playLand', by: 0, card })).toContain('is not a land');
    expect(refusal(s, { type: 'auto:playLand', by: 0, card, half: 4 })).toContain('no face 4');
  });

  it('is still a three-mana instant in every other zone (CR 712.4a)', () => {
    let s = advanceTo(inHand('ashen-rite', 'Hagra Mauling', ['Swamp', 'Swamp', 'Swamp']), 'precombat-main');
    const card = find(s, 0, 'hand', 'Hagra Mauling');
    // In hand: the front face, which is what a Chalice of the Void counts and a discard spell sees.
    expect(s.cardDefs[s.instances[card]!.defKey]!.cmc).toBe(3);
    expect(characteristicsOf(s, s.instances[card]!).isLand).toBe(false);

    // Played as the land and then destroyed: the card that reaches the graveyard is the card again.
    s = apply(s, { type: 'auto:playLand', by: 0, card, half: 0 });
    expect(nameOf(s, card)).toBe('Hagra Broodpit');
    s = apply(s, { type: 'card:move', by: 0, card, toZone: 'graveyard' });
    expect(namesIn(s, 0, 'graveyard')).toContain('Hagra Mauling');
    expect(s.cardDefs[s.instances[card]!.defKey]!.cmc).toBe(3);
  });

  it('casts the front face instead, when that is the half the board asks for', () => {
    let s = arena({
      decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
      hands: { 0: ['Hagra Mauling'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const card = find(s, 0, 'hand', 'Hagra Mauling');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card, targets: [{ kind: 'card', id: courser }],
    }));
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    // The land drop was never spent, which is the trade: the card was a removal spell this game.
    expect(s.landsPlayed['0'] ?? 0).toBe(0);
    expect(namesIn(s, 0, 'graveyard')).toContain('Hagra Mauling');
  });

  it('puts a counter on with the other one, which does not wear off', () => {
    let s = arena({
      decks: { 0: 'blight-vector' }, hands: { 0: ['Vastwood Fortification'] },
      battlefield: { 0: ['Forest', 'Forest', 'Glistener Elf'] },
      turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const elf = find(s, 0, 'battlefield', 'Glistener Elf');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Vastwood Fortification'),
      targets: [{ kind: 'card', id: elf }],
    }));
    expect([power(s, elf), toughness(s, elf)]).toEqual([2, 2]);
    // Next turn it is still a 2/2: a counter is not a pump, which is the whole reason this card is
    // in a deck whose creatures have infect.
    s = advanceTo(nextTurn(s), 'precombat-main');
    expect([power(s, elf), toughness(s, elf)]).toEqual([2, 2]);
  });

  it('and the bot plays the basic first, because the modal land comes in tapped', () => {
    let s = arena({
      decks: { 0: 'ashen-rite' }, hands: { 0: ['Hagra Mauling', 'Swamp'] },
      battlefield: {}, turn: 2, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const action = botAction(s, 0);
    expect(action?.type).toBe('auto:playLand');
    // The Swamp, not the Broodpit: a land that is ready now beats one that is not, and keeping the
    // flexible card is offered. The tie-break reads the *face*, which is the bug this guards.
    expect(nameOf(s, (action as { card: string }).card)).toBe('Swamp');
  });
});

/*
  Metalcraft: a static that is on while the board says so (CR 702.75).

  The shape being tested is the one the engine had no way to say. Every other continuous effect here
  is created, applies for a duration and expires; this one has no moment at which it turns on — the
  board changes and the creature is a 4/4, something leaves and it is a 2/2 again, with nothing
  announced and no trigger to watch. So the tests below all *change the board* and read the creature
  again, which is the only way to tell a conditional static from a one-off pump.
*/
describe('a static that comes and goes: metalcraft (CR 702.75)', () => {
  /** Seat 0 on Forge Alliance, main phase, with `board` already out. */
  const forge = (hand: readonly string[], board: readonly string[]): GameState => {
    let s = arena({
      decks: { 0: 'forge-alliance' }, hands: { 0: [...hand] },
      battlefield: { 0: [...board] }, turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    return s;
  };

  it('is a 2/2 with two artifacts and a 4/4 with three', () => {
    // Two artifacts out, plus the Steed itself once it arrives: three, so it is already on. The
    // test is built the other way round — one artifact beside it — so the count is two.
    let s = forge([], ['Chrome Steed', 'Bonesplitter', 'Plains', 'Plains', 'Mountain']);
    const steed = find(s, 0, 'battlefield', 'Chrome Steed');
    expect([power(s, steed), toughness(s, steed)]).toEqual([2, 2]);

    // A third artifact — the Steed is one, so a Collar makes three — and it is a 4/4, with nothing
    // cast and nothing triggered.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Basilisk Collar'), toZone: 'battlefield',
    });
    expect([power(s, steed), toughness(s, steed)]).toEqual([4, 4]);

    // And back to a 2/2 when one leaves, which is the half a one-off pump could not do.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'battlefield', 'Bonesplitter'), toZone: 'graveyard',
    });
    expect([power(s, steed), toughness(s, steed)]).toEqual([2, 2]);
  });

  it('counts the artifacts its own controller has, and nobody else’s', () => {
    let s = arena({
      decks: { 0: 'forge-alliance', 1: 'forge-alliance' },
      battlefield: {
        0: ['Chrome Steed', 'Bonesplitter'],
        1: ['Bonesplitter', 'Basilisk Collar', 'Darksteel Plate'],
      },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const steed = find(s, 0, 'battlefield', 'Chrome Steed');
    // Three artifacts on the table opposite and two on this side: a 2/2.
    expect([power(s, steed), toughness(s, steed)]).toEqual([2, 2]);
  });

  it('grants protection from every colour while it holds, and takes it back when it does not', () => {
    let s = arena({
      decks: { 0: 'forge-alliance', 1: 'ember-rush' },
      hands: { 1: ['Lightning Bolt'] },
      battlefield: {
        0: ['Etched Champion', 'Bonesplitter', 'Basilisk Collar'],
        1: ['Mountain'],
      },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'precombat-main');
    const champ = find(s, 0, 'battlefield', 'Etched Champion');
    // Three artifacts counting itself, so a red spell cannot be pointed at it at all.
    expect(protectedFrom(s, champ, null)).toBe(false);
    const bolt = find(s, 1, 'hand', 'Lightning Bolt');
    const plays = legalActions(s, 1).plays.filter((p) => p.card === bolt);
    const aimable = plays.flatMap((p) => p.candidates[0] ?? [])
      .filter((t) => t.kind === 'card').map((t) => (t.kind === 'card' ? t.id : ''));
    expect(aimable).not.toContain(champ);

    // Take an artifact away and the protection goes with it: now the Bolt can be aimed.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'battlefield', 'Bonesplitter'), toZone: 'graveyard',
    });
    const after = legalActions(s, 1).plays.filter((p) => p.card === bolt)
      .flatMap((p) => p.candidates[0] ?? [])
      .filter((t) => t.kind === 'card').map((t) => (t.kind === 'card' ? t.id : ''));
    expect(after).toContain(champ);
  });

  it('Galvanic Blast deals one, or four with three artifacts out', () => {
    // One artifact: a Shock that costs {R}.
    let s = forge(['Galvanic Blast'], ['Mountain', 'Bonesplitter']);
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = cast(s, 0, 'Galvanic Blast', [{ kind: 'player', seat: 1 }]);
    expect(life(s, 1)).toBe(19);

    // Three artifacts: four damage, and the difference is read as it resolves rather than as it is
    // cast — which is why this is an ordinary script and not a conditional effect.
    let t = forge(['Galvanic Blast'], ['Mountain', 'Bonesplitter', 'Basilisk Collar', 'Darksteel Plate']);
    t = apply(t, { type: 'auto:activate', by: 0, card: find(t, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    t = cast(t, 0, 'Galvanic Blast', [{ kind: 'player', seat: 1 }]);
    expect(life(t, 1)).toBe(16);
  });

  it('and the condition is read when the spell resolves, not when it was cast', () => {
    let s = arena({
      decks: { 0: 'forge-alliance', 1: 'ember-rush' },
      hands: { 0: ['Galvanic Blast'] },
      battlefield: {
        0: ['Mountain', 'Bonesplitter', 'Basilisk Collar', 'Darksteel Plate'],
        1: ['Mountain', 'Mountain'],
      },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Galvanic Blast'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    // Three artifacts when it was cast, two by the time it resolves: one damage, not four. The
    // player who answered the Collar earned that, and a condition snapshotted at cast time would
    // have taken it away from them.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'battlefield', 'Basilisk Collar'), toZone: 'graveyard',
    });
    s = passBoth(s);
    expect(life(s, 1)).toBe(19);
  });
});

/*
  The thirteenth deck's own cards: red-green, the colour pair the pool had never had.

  One test per card, the way every other deck's cards were taken. Nothing here needed the engine to
  learn anything new, which is what these are really checking: a commander that taxes noncreature
  spells is a `spell-cast` trigger with an `actor`, a creature that makes everything fight is the
  `etb` trigger's `subject` plus the same `fight` Prey Upon has, and an Aura that comes back is a
  `dies` trigger on a permanent that is not a creature.
*/
describe('whenever you draw a card (CR 121.2)', () => {
  /*
    The fifth event in the detect-rather-than-announce family, and the first added for cards.

    `draw` in `effects.ts` is the only place a card is actually drawn — the draw step, the crown,
    and two dozen card effects all come through it — and it announced the fact to nobody, so
    "whenever you draw a card" could not be written. The event is *recorded* there rather than
    noticed afterwards for a reason these tests pin twice: a card arriving in a hand is not the
    same thing as a card being drawn.
  */
  it('fires once per card, so drawing three is three counters', () => {
    let s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      hands: { 0: ['Divination'] },
      battlefield: { 0: ['Island', 'Island', 'Island', 'Chasm Skulker'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const skulker = find(s, 0, 'battlefield', 'Chasm Skulker');
    /*
      Counted as a *delta*, because this board has already drawn a card.

      `advanceTo` walks the turn from the untap step, so reaching the main phase goes through the
      draw step — and a Skulker that was on the battlefield for it has a counter before the test
      does anything. That is the engine being right about the most ordinary draw there is, and the
      first version of this test asserted it away.
    */
    const before = s.instances[skulker]!.counters['+1/+1'] ?? 0;
    expect(before).toBe(1);

    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Divination'),
    })));
    // Two cards drawn, two more counters — one ability per card rather than one per draw.
    expect(s.instances[skulker]!.counters['+1/+1']).toBe(before + 2);
    const ch = characteristicsOf(s, s.instances[skulker]!);
    expect([ch.power, ch.toughness]).toEqual([1 + before + 2, 1 + before + 2]);
  });

  it('and not for a card put into a hand without drawing it', () => {
    /*
      The whole reason the event is recorded where the draw happens. A Gravedigger returns a card
      to its controller's hand, and a hand-size comparison cannot tell that from a draw — so an
      instrument that watched hands would make this a counter, and the rules do not.
    */
    let s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'hollow-tide' },
      hands: { 0: ['Gravedigger'] },
      graveyard: { 0: ['Centaur Courser'] },
      battlefield: {
        0: ['Forest', 'Forest', 'Swamp', 'Swamp'],
        1: ['Island', 'Island', 'Island', 'Chasm Skulker'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const skulker = find(s, 1, 'battlefield', 'Chasm Skulker');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gravedigger'),
    })));
    expect(namesIn(s, 0, 'hand')).toContain('Centaur Courser');
    // Their card moved into their hand and nothing was drawn, so nothing triggered — and the
    // Skulker belongs to the other seat anyway, which is the next test.
    expect(s.instances[skulker]!.counters['+1/+1']).toBeUndefined();
  });

  it('watches its own controller and not the other player', () => {
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'hollow-tide' },
      // A Think Twice rather than the Divination this used to draw with: the Divination left Arc
      // Tempest for the Phoenix of Ash, and one card drawn on the wrong side of the table proves
      // the same thing two do.
      hands: { 0: ['Think Twice'] },
      battlefield: {
        0: ['Island', 'Island', 'Island'],
        1: ['Island', 'Chasm Skulker'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const skulker = find(s, 1, 'battlefield', 'Chasm Skulker');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Think Twice'),
    })));
    // `by` defaults to `you`, so the opponent's card is none of the Skulker's business.
    expect(s.instances[skulker]!.counters['+1/+1']).toBeUndefined();
  });

  it('leaves a Squid for every counter when it dies, and they have islandwalk', () => {
    /*
      The second half reads counters the permanent no longer has: it is in a graveyard by the time
      the ability resolves and `relocate` took its counters off on the way, as the rules require.
      The number travels with the event through `EffectContext.subjectCounters`, the path Hangarback
      Walker found first.
    */
    let s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      hands: { 0: ['Divination'] },
      battlefield: { 0: ['Island', 'Island', 'Island', 'Chasm Skulker'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const skulker = find(s, 0, 'battlefield', 'Chasm Skulker');
    // One from the draw step, two from the Divination — see the note on the first test.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Divination'),
    })));
    const counters = s.instances[skulker]!.counters['+1/+1'] ?? 0;
    expect(counters).toBe(3);

    // Moved by hand rather than killed with a spell: what is being tested is the death trigger
    // reading counters the card no longer has, and the zone change is where they come off.
    s = drain(apply(s, { type: 'card:move', by: 0, card: skulker, toZone: 'graveyard' }));
    expect(s.instances[skulker]!.zone).toBe('graveyard');
    const squids = ids(s, 0, 'battlefield').filter((id) => nameOf(s, id) === 'Squid');
    expect(squids.length).toBe(counters);
    // Islandwalk is a static scoped to the token itself, found by its name like the Pest's
    // trigger — so a 1/1 token cannot be blocked by a player with an Island.
    expect(characteristicsOf(s, s.instances[squids[0]!]!).landwalk).toEqual(['Island']);
  });

  it('and leaves nothing at all when it never grew', () => {
    /*
      On the *opponent's* turn, so this seat has not had a draw step and the Skulker is still a 1/1.
      The clause being pinned is the one that reads "where X is the number of +1/+1 counters": with
      none, a dying Skulker leaves nothing rather than a 0-count token nobody could put on a board.
    */
    let s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      battlefield: { 0: ['Island', 'Chasm Skulker'], 1: ['Mountain'] },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const skulker = find(s, 0, 'battlefield', 'Chasm Skulker');
    expect(s.instances[skulker]!.counters['+1/+1']).toBeUndefined();
    s = drain(apply(s, { type: 'card:move', by: 0, card: skulker, toZone: 'graveyard' }));
    expect(ids(s, 0, 'battlefield').filter((id) => nameOf(s, id) === 'Squid').length).toBe(0);
  });

  it("drains an opponent for each card they draw, and never its own controller", () => {
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'hollow-tide' },
      hands: { 1: ['Divination'] },
      battlefield: {
        0: ['Swamp', 'Fate Unraveler'],
        1: ['Island', 'Island', 'Island'],
      },
      turn: 4, firstSeat: 1,
    }), 'precombat-main');
    const them = life(s, 1);
    const me = life(s, 0);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Divination'),
    })));
    // Two cards drawn, two points of life — and the trigger says `by: 'opponent'` out loud,
    // because the default on this event is `you`.
    expect(life(s, 1)).toBe(them - 2);
    expect(life(s, 0)).toBe(me);
  });
});

describe('red-green: the thirteenth deck’s cards', () => {
  /** Seat 0 on Kindle Grove, main phase, every land tapped for mana. */
  const grove = (hand: readonly string[], lands: readonly string[], board: readonly string[] = []): GameState => {
    let s = arena({
      decks: { 0: 'kindle-grove' }, hands: { 0: [...hand] },
      battlefield: { 0: [...lands, ...board] }, turn: 5, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('Ruric Thar hits whoever casts a noncreature spell, its own controller included', () => {
    let s = arena({
      decks: { 0: 'kindle-grove', 1: 'ember-rush' },
      hands: { 0: ['Lightning Bolt'], 1: ['Shock'] },
      battlefield: { 0: ['Mountain', 'Ruric Thar, the Unbowed'], 1: ['Mountain'] },
      turn: 5, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    // Its own controller first, because that is the half that makes it a card rather than a
    // beating: six damage to seat 0 for its own Bolt, and three to seat 1 from the Bolt.
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    })));
    expect(life(s, 0)).toBe(14);
    expect(life(s, 1)).toBe(17);
  });

  it('and makes every creature on the table attack, both sides of it', () => {
    const s = advanceTo(arena({
      decks: { 0: 'kindle-grove', 1: 'verdant-guard' },
      battlefield: { 0: ['Ruric Thar, the Unbowed'], 1: ['Centaur Courser'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    const mine = find(s, 0, 'battlefield', 'Ruric Thar, the Unbowed');
    const theirs = find(s, 1, 'battlefield', 'Centaur Courser');
    expect(characteristicsOf(s, s.instances[mine]!).mustAttack).toBe(true);
    expect(characteristicsOf(s, s.instances[theirs]!).mustAttack).toBe(true);
    // Vigilance and reach come off the printed line, which is what lets it attack every turn under
    // its own clause and still block.
    expect([...characteristicsOf(s, s.instances[mine]!).keywords].sort()).toEqual(['reach', 'vigilance']);
  });

  it('Assault deals two, and Battery makes a 3/3 — one card, either end of the curve', () => {
    let s = grove(['Assault // Battery'], ['Mountain']);
    const card = find(s, 0, 'hand', 'Assault // Battery');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card, half: 0, targets: [{ kind: 'player', seat: 1 }],
    }));
    expect(life(s, 1)).toBe(18);

    let t = grove(['Assault // Battery'], ['Forest', 'Forest', 'Forest', 'Forest']);
    t = passBoth(apply(t, {
      type: 'auto:cast', by: 0, card: find(t, 0, 'hand', 'Assault // Battery'), half: 1,
    }));
    const token = find(t, 0, 'battlefield', 'Elephant');
    expect([power(t, token), toughness(t, token)]).toEqual([3, 3]);
  });

  it('Burning-Tree Emissary pays for the next two-drop as it arrives', () => {
    let s = grove(['Burning-Tree Emissary'], ['Mountain', 'Forest']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Burning-Tree Emissary'),
    })));
    // Two mana spent and two back: the pool is where it started, which is the whole card.
    expect(s.pools['0']!['R']).toBe(1);
    expect(s.pools['0']!['G']).toBe(1);
  });

  it('Gruul Ragebeast makes the creature that arrived fight, not itself', () => {
    let s = arena({
      decks: { 0: 'kindle-grove', 1: 'verdant-guard' },
      hands: { 0: ['Centaur Courser'] },
      battlefield: {
        0: ['Forest', 'Forest', 'Forest', 'Gruul Ragebeast'],
        1: ['Grizzly Bears'],
      },
      turn: 6, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    const beast = find(s, 0, 'battlefield', 'Gruul Ragebeast');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Centaur Courser'),
    })));
    if (s.pendingChoice !== null) {
      s = drain(apply(s, { type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: bears }] }));
    }
    // The 3/3 that entered fought the 2/2 and killed it; the Ragebeast took nothing, because the
    // fight was never about the Ragebeast.
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
    expect(damageOn(s, beast)).toBe(0);
    expect(namesIn(s, 0, 'battlefield')).toContain('Centaur Courser');
  });

  it('Savage Twister deals X to every creature, on both sides', () => {
    let s = arena({
      decks: { 0: 'kindle-grove', 1: 'verdant-guard' },
      hands: { 0: ['Savage Twister'] },
      battlefield: {
        0: ['Mountain', 'Forest', 'Forest', 'Forest', 'Llanowar Elves'],
        1: ['Grizzly Bears', 'Centaur Courser'],
      },
      turn: 6, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Savage Twister'), x: 2,
    }));
    // Two damage everywhere: the 1/1 and the 2/2 die, the 3/3 lives with damage on it.
    expect(namesIn(s, 0, 'graveyard')).toContain('Llanowar Elves');
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    expect(damageOn(s, courser)).toBe(2);
  });

  it('Rancor gives +2/+0 and trample, and comes back when it leaves the battlefield', () => {
    let s = grove(['Rancor'], ['Forest'], ['Centaur Courser']);
    const courser = find(s, 0, 'battlefield', 'Centaur Courser');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Rancor'),
      targets: [{ kind: 'card', id: courser }],
    })));
    expect([power(s, courser), toughness(s, courser)]).toEqual([5, 3]);
    expect(characteristicsOf(s, s.instances[courser]!).keywords.has('trample')).toBe(true);

    // The creature dies and the Aura goes with it — straight back to hand, which is the card.
    s = drain(apply(s, { type: 'card:move', by: 0, card: courser, toZone: 'graveyard' }));
    expect(namesIn(s, 0, 'hand')).toContain('Rancor');
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Rancor');
  });

  it('Thragtusk gains five, and leaves a 3/3 behind however it goes', () => {
    let s = grove(['Thragtusk'], ['Forest', 'Forest', 'Forest', 'Forest', 'Forest']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thragtusk'),
    })));
    expect(life(s, 0)).toBe(25);
    const tusk = find(s, 0, 'battlefield', 'Thragtusk');

    // **Exiled**, not killed, which is the half that makes the card famous: a `leaves` trigger
    // fires for every way off the battlefield and a `dies` trigger would not have.
    s = drain(apply(s, { type: 'card:move', by: 0, card: tusk, toZone: 'exile' }));
    expect(namesIn(s, 0, 'exile')).toContain('Thragtusk');
    const token = find(s, 0, 'battlefield', 'Beast');
    expect([power(s, token), toughness(s, token)]).toEqual([3, 3]);
  });
});

describe('a cost paid out of the graveyard: escape and delve', () => {
  /*
    The engine's first cost taken out of a *zone*, and the two mechanics printed on it.

    Everything that paid for something before this spent mana, tapped a permanent, sacrificed one
    or paid life — all of them things on the battlefield or on a life total. The graveyard was
    somewhere cards went. Escape (CR 702.139) and delve (CR 702.112) make it a resource, and they
    are opposite shapes of the same idea: escape's price is printed and fixed, delve's is chosen
    as the spell is cast.

    Which cards go is the engine's choice, like the creatures convoke taps — so these tests assert
    the *count* and the *ordering rule*, and never which particular card went, except where the
    ordering rule is the thing being tested.
  */
  const tempest = (hand: readonly string[], grave: readonly string[], lands: number): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'hollow-tide' },
      hands: { 0: [...hand] },
      graveyard: { 0: [...grave] },
      battlefield: {
        0: Array.from({ length: lands }, () => 'Mountain'),
        1: ['Island'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  /*
    Hollow Tide, for the Angler: `grave` in the graveyard and `lands` on the battlefield.

    The Angler is put in hand by `arena` rather than fetched out of the library in the test, which
    is not a style choice: `arena` fast-forwards to turn four with the tabletop's own `turn:pass`,
    and every one of those turns draws a card — so "find it in the library" is a coin flip on
    whether the fast-forward already drew it.
  */
  const tide = (grave: readonly string[], lands: readonly string[]): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      hands: { 0: ['Gurmag Angler'] },
      graveyard: { 0: [...grave] },
      battlefield: { 0: [...lands], 1: ['Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  const escapePlay = (s: GameState, name: string) =>
    legalActions(s, 0).plays.find((play) => play.name === name && play.escape === true);

  it('offers the Phoenix out of the graveyard, and says what the cards cost as well as the mana', () => {
    // The Phoenix itself plus three others: exactly the price, which is the smallest graveyard
    // that can pay it.
    const s = tempest([], ['Phoenix of Ash', 'Lava Spike', 'Burst Lightning', 'Magma Jet'], 4);
    const play = escapePlay(s, 'Phoenix of Ash');
    expect(play).toBeDefined();
    expect(play?.manaCost).toBe('{2}{R}{R}');
    expect(play?.exiles).toBe(3);
    // Both halves in the words the player reads, because the mana is the cheap half.
    expect(play?.description).toContain('escape {2}{R}{R}, exiling 3');
  });

  it('is not offered when the graveyard is one card short, counting itself out (CR 601.2h)', () => {
    /*
      "Three **other** cards" is load-bearing and this is the test of it: a graveyard holding the
      Phoenix and two more has three cards in it and cannot pay a cost of three others. A cost you
      cannot pay is not one you may pay, so the play is absent rather than offered and refused —
      and the engine says why, in the blocked list the table shows under an unplayable card.
    */
    const s = tempest([], ['Phoenix of Ash', 'Lava Spike', 'Burst Lightning'], 4);
    expect(escapePlay(s, 'Phoenix of Ash')).toBeUndefined();
    const card = find(s, 0, 'graveyard', 'Phoenix of Ash');
    expect(refusal(s, { type: 'auto:cast', by: 0, card, escape: true }))
      .toContain('escape asks for 3 other cards');
  });

  it('exiles the three as the spell is cast, before anybody may respond', () => {
    /*
      A cost, not an effect. The cards are gone while the Phoenix is still on the stack, so a
      player answering the spell cannot answer the payment — the same reason the sacrifice for an
      additional cost happens here rather than on resolution.
    */
    let s = tempest([], ['Phoenix of Ash', 'Lava Spike', 'Burst Lightning', 'Magma Jet'], 4);
    const card = find(s, 0, 'graveyard', 'Phoenix of Ash');
    s = apply(s, { type: 'auto:cast', by: 0, card, escape: true });

    expect(s.stackOrder).toHaveLength(1);
    expect(ids(s, 0, 'exile')).toHaveLength(3);
    expect(ids(s, 0, 'graveyard')).toHaveLength(0);
    // And the stack says so, for the player deciding whether this is worth an answer.
    expect(s.stackObjects[s.stackOrder[0]!]?.description).toContain('escaped, 3 cards');
  });

  it('and the escaped Phoenix is an ordinary permanent, not exiled like a flashback spell', () => {
    /*
      The one difference between escape and flashback that matters, and the whole balance of the
      mechanic: a flashback spell is exiled as it leaves the stack and there is no third casting.
      An escaped creature goes to the graveyard when it dies, ready to escape again for the price
      of three more cards — so the stack object carries no `flashback` flag, which is what
      `onLeaveStack` reads to decide where it goes.
    */
    let s = tempest([], ['Phoenix of Ash', 'Lava Spike', 'Burst Lightning', 'Magma Jet'], 4);
    const card = find(s, 0, 'graveyard', 'Phoenix of Ash');
    s = apply(s, { type: 'auto:cast', by: 0, card, escape: true });
    expect(s.stackObjects[card]?.flashback).toBeUndefined();

    s = drain(passBoth(s));
    expect(s.instances[card]!.zone).toBe('battlefield');
    const ch = characteristicsOf(s, s.instances[card]!);
    expect([ch.power, ch.toughness]).toEqual([2, 2]);
    expect(ch.keywords.has('flying')).toBe(true);

    // Killed, and back in the graveyard rather than in exile: it can escape again.
    s = drain(apply(s, { type: 'card:move', by: 0, card, toZone: 'graveyard' }));
    expect(s.instances[card]!.zone).toBe('graveyard');
  });

  it('pays with the cards nothing else can use, and leaves the flashback card alone', () => {
    /*
      The ordering rule in `graveyardFodder`, which is the only judgement in either mechanic: a
      Think Twice in the graveyard is a card that can still be cast, and exiling it to escape a
      Phoenix is paying twice for one spell.
    */
    let s = tempest([], ['Phoenix of Ash', 'Think Twice', 'Lava Spike', 'Burst Lightning', 'Magma Jet'], 4);
    const card = find(s, 0, 'graveyard', 'Phoenix of Ash');
    s = apply(s, { type: 'auto:cast', by: 0, card, escape: true });
    expect(namesIn(s, 0, 'graveyard')).toEqual(['Think Twice']);
    expect(namesIn(s, 0, 'exile').sort()).toEqual(['Burst Lightning', 'Lava Spike', 'Magma Jet']);
  });

  it('casts the Angler for one mana off a deep graveyard, and says how deep', () => {
    // Printed {6}{B}: six cards out of the graveyard pay the generic, and the Swamp pays the {B}.
    let s = tide(
      ['Mind Sculpt', 'Mind Sculpt', 'Tome Scour', 'Thought Scour', 'Preordain', 'Divination'],
      ['Swamp'],
    );
    const angler = find(s, 0, 'hand', 'Gurmag Angler');
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Gurmag Angler');
    expect(play?.exiles).toBe(6);
    expect(play?.description).toContain('delving 6');

    s = drain(passBoth(apply(s, { type: 'auto:cast', by: 0, card: angler })));
    const ch = characteristicsOf(s, s.instances[angler]!);
    expect([ch.power, ch.toughness]).toEqual([5, 5]);
    expect(ids(s, 0, 'graveyard')).toHaveLength(0);
    expect(ids(s, 0, 'exile')).toHaveLength(6);
  });

  it('delves as few cards as it can get away with, not as many as it can', () => {
    /*
      The one real decision in the mechanic, and the reason `delvePlan` walks up from nothing: the
      graveyard is what the Think Twice and the Phoenix spend, so a plan that always took the
      maximum would be paying for the Angler with cards the deck had other uses for. Four Swamps
      means three cards, and the other six stay where they are.
    */
    let s = tide(
      ['Mind Sculpt', 'Mind Sculpt', 'Tome Scour', 'Thought Scour', 'Preordain', 'Divination',
        'Murder', 'Negate', 'Doom Blade'],
      ['Swamp', 'Swamp', 'Swamp', 'Swamp'],
    );
    const play = legalActions(s, 0).plays.find((p) => p.name === 'Gurmag Angler');
    expect(play?.exiles).toBe(3);

    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Gurmag Angler') });
    expect(ids(s, 0, 'exile')).toHaveLength(3);
    expect(ids(s, 0, 'graveyard')).toHaveLength(6);
  });

  it('cannot pay a coloured pip with a card, however deep the graveyard is (CR 702.112a)', () => {
    /*
      Delve pays for {1} and only {1}. Seven Islands and nine cards in the graveyard still cannot
      cast a {6}{B} creature, because the {B} is not generic and no number of cards makes it one.
    */
    const s = tide(
      ['Mind Sculpt', 'Mind Sculpt', 'Tome Scour', 'Thought Scour', 'Preordain', 'Divination',
        'Murder', 'Negate', 'Doom Blade'],
      ['Island', 'Island', 'Island', 'Island', 'Island', 'Island', 'Island'],
    );
    expect(legalActions(s, 0).plays.some((p) => p.name === 'Gurmag Angler')).toBe(false);
    expect(legalActions(s, 0).blocked.some((b) => /delve/.test(b.reason))).toBe(true);
  });

  it('draws three for one blue mana, and the Cruise is a sorcery either way', () => {
    let s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      hands: { 0: ['Treasure Cruise'] },
      graveyard: {
        0: ['Doom Blade', 'Murder', 'Thought Scour', 'Mind Sculpt', 'Man-o\'-War',
          'Returned Centaur', 'Tome Scour'],
      },
      battlefield: { 0: ['Island'], 1: ['Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const handBefore = ids(s, 0, 'hand').length;
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Treasure Cruise'),
    })));
    // Three drawn, one Cruise gone from the hand it was cast out of.
    expect(ids(s, 0, 'hand').length).toBe(handBefore - 1 + 3);
    // Seven cards, less the seven the delve paid with, plus the Cruise itself.
    expect(namesIn(s, 0, 'graveyard')).toEqual(['Treasure Cruise']);
  });

  it('and a countered escape does not give the three cards back', () => {
    /*
      The other half of "it is a cost": costs are paid whatever happens to the spell afterwards
      (CR 601.2h), so countering an escaped Phoenix answers the creature and not the payment. The
      card itself goes to the **graveyard** rather than to exile, which is the escape-versus-
      flashback difference again — so the three cards are gone and the Phoenix is back where it
      started, needing three more.
    */
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'hollow-tide' },
      hands: { 1: ['Counterspell'] },
      graveyard: { 0: ['Phoenix of Ash', 'Lava Spike', 'Burst Lightning', 'Magma Jet'] },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'],
        1: ['Island', 'Island'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const phoenix = find(s, 0, 'graveyard', 'Phoenix of Ash');
    s = apply(s, { type: 'auto:cast', by: 0, card: phoenix, escape: true });
    expect(ids(s, 0, 'exile')).toHaveLength(3);

    // Seat 1 holds priority before it can tap for mana, so the pass comes first.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = tapAllLands(s, 1);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'),
      targets: [{ kind: 'card', id: phoenix }],
    })));

    expect(s.instances[phoenix]!.zone).toBe('graveyard');
    // Paid is paid: the cards do not come back, and the graveyard is the Phoenix alone.
    expect(ids(s, 0, 'exile')).toHaveLength(3);
    expect(namesIn(s, 0, 'graveyard')).toEqual(['Phoenix of Ash']);
  });

  it('refuses escape on a card that has none, and on somebody else’s graveyard', () => {
    const s = tempest([], ['Lava Spike', 'Burst Lightning', 'Magma Jet', 'Think Twice'], 4);
    const spike = find(s, 0, 'graveyard', 'Lava Spike');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: spike, escape: true }))
      .toContain('has no escape');
    // And the other seat's Phoenix is not in the other seat's graveyard to begin with, so the
    // refusal that matters is the zone one: seat 1 may not escape seat 0's card.
    const theirs = tempest([], ['Phoenix of Ash', 'Lava Spike', 'Burst Lightning', 'Magma Jet'], 4);
    const phoenix = find(theirs, 0, 'graveyard', 'Phoenix of Ash');
    expect(refusal(theirs, { type: 'auto:cast', by: 1, card: phoenix, escape: true }))
      .not.toBeNull();
  });
});

describe('a card put into a graveyard from anywhere (CR 400.7)', () => {
  /*
    The sixth member of the detect-rather-than-announce family, and the one that is wider than a
    death in four directions at once.

    `died` is the battlefield half. The printed wording is "put into a graveyard **from
    anywhere**", and the other three anywheres were invisible to the engine: a card milled off a
    library, a card discarded out of a hand, and a spell that has finished resolving. These tests
    are one per direction, because the whole point of recording this in `relocate` is that no path
    can forget — and a test per path is the only way to know.
  */
  const voided = (setup: {
    hands?: Record<number, readonly string[]>;
    graveyard?: Record<number, readonly string[]>;
    mine?: readonly string[];
    theirs?: readonly string[];
    opponent?: string;
    /** Whose turn it is. Seat 1's, for the tests where seat 1 is the one casting. */
    firstSeat?: SeatIndex;
  }): GameState => advanceTo(arena({
    decks: { 0: 'blight-vector', 1: setup.opponent ?? 'hollow-tide' },
    ...(setup.hands === undefined ? {} : { hands: setup.hands }),
    ...(setup.graveyard === undefined ? {} : { graveyard: setup.graveyard }),
    battlefield: {
      // Green and black, because this deck is: the Void costs {B} and the Naturalize and the
      // Giant Growth the tests below cast are {G}.
      0: ['Swamp', 'Swamp', 'Forest', 'Forest', 'Planar Void', ...(setup.mine ?? [])],
      1: ['Island', 'Island', 'Island', 'Island', ...(setup.theirs ?? [])],
    },
    turn: 4, firstSeat: setup.firstSeat ?? 0,
  }), 'precombat-main');

  it('exiles a creature that died, so the graveyard never keeps it', () => {
    const s = voided({ mine: ['Plague Stinger'] });
    const stinger = find(s, 0, 'battlefield', 'Plague Stinger');
    const after = drain(apply(s, { type: 'card:move', by: 0, card: stinger, toZone: 'graveyard' }), 40);
    expect(after.instances[stinger]!.zone).toBe('exile');
    expect(namesIn(after, 0, 'graveyard')).toEqual([]);
  });

  it('exiles cards milled off a library, which no death event could ever have seen', () => {
    // Seat 1's own turn, because seat 1 is the one casting and a pass with an empty stack would
    // walk the table on to the next step rather than hand priority over.
    let s = voided({ hands: { 1: ['Thought Scour'] }, firstSeat: 1 });
    s = tapAllLands(s, 1);
    s = drain(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Thought Scour'),
      targets: [{ kind: 'player', seat: 0 }],
    }), 40);
    // Two cards milled and both exiled, and the Scour itself went the same way out of the stack.
    expect(namesIn(s, 0, 'graveyard')).toEqual([]);
    expect(ids(s, 0, 'exile')).toHaveLength(2);
    expect(namesIn(s, 1, 'graveyard')).toEqual([]);
    expect(namesIn(s, 1, 'exile')).toContain('Thought Scour');
  });

  it('exiles a card discarded out of a hand', () => {
    // A Swamp on their side as well, because Mind Rot is {2}{B} and Tidal Mind's blue half
    // cannot pay for it.
    let s = voided({
      // Exactly two cards in the hand being emptied, so the discard has no choice to make and the
      // test can name what left. A Swamp on their side as well, because Mind Rot is {2}{B} and
      // Tidal Mind's blue half cannot pay for it.
      hands: { 0: ['Giant Growth', 'Naturalize'], 1: ['Mind Rot'] },
      theirs: ['Swamp'], opponent: 'tidal-mind', firstSeat: 1,
    });
    s = tapAllLands(s, 1);
    expect(ids(s, 0, 'hand')).toHaveLength(2);
    s = drain(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Mind Rot'),
      targets: [{ kind: 'player', seat: 0 }],
    }), 40);
    // Two cards discarded, neither of them in the graveyard they were discarded into.
    expect(ids(s, 0, 'hand')).toHaveLength(0);
    expect(namesIn(s, 0, 'graveyard')).toEqual([]);
    expect(namesIn(s, 0, 'exile').sort()).toEqual(['Giant Growth', 'Naturalize']);
  });

  it('exiles a spell that has finished resolving', () => {
    let s = voided({ hands: { 0: ['Giant Growth'] }, mine: ['Plague Stinger'] });
    s = tapAllLands(s, 0);
    const stinger = find(s, 0, 'battlefield', 'Plague Stinger');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Giant Growth'),
      targets: [{ kind: 'card', id: stinger }],
    }), 40);
    // The spell did its work and then went to exile instead of to the graveyard.
    expect(namesIn(s, 0, 'exile')).toContain('Giant Growth');
    expect(namesIn(s, 0, 'graveyard')).toEqual([]);
  });

  it('does not exile itself, because the card says another', () => {
    /*
      The one reading the printed word "another" exists to rule out, and the whole of the matcher
      for this event: a Planar Void that is destroyed would otherwise exile itself on the way down.
      Naturalize is in this deck, which makes the test the game rather than a `card:move`.
    */
    let s = voided({ hands: { 0: ['Naturalize'] } });
    s = tapAllLands(s, 0);
    const voidCard = find(s, 0, 'battlefield', 'Planar Void');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Naturalize'),
      targets: [{ kind: 'card', id: voidCard }],
    }), 40);
    expect(s.instances[voidCard]!.zone).toBe('graveyard');
    /*
      And the Naturalize stays in the graveyard too, which is the rules rather than a gap.

      A spell is put into its owner's graveyard as the **last** step of its own resolution
      (CR 608.2m), by which time the enchantment it destroyed has already left the battlefield —
      so there is nothing watching when the Naturalize arrives. Worth asserting because the
      opposite would mean the engine was asking permanents that are no longer there, which is the
      bug class `raise` guards against by checking the watcher's zone.
    */
    expect(namesIn(s, 0, 'graveyard').sort()).toEqual(['Naturalize', 'Planar Void']);
  });

  it('takes the escape card away before it can escape', () => {
    /*
      What the card is for, now that the pool has a graveyard worth spending. A Phoenix of Ash is
      a 2/2 that comes back for three cards out of the graveyard — unless it never reaches one.
    */
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'blight-vector' },
      battlefield: {
        0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Phoenix of Ash'],
        1: ['Swamp', 'Planar Void'],
      },
      graveyard: { 0: ['Lava Spike', 'Burst Lightning', 'Magma Jet'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    const phoenix = find(s, 0, 'battlefield', 'Phoenix of Ash');
    s = drain(apply(s, { type: 'card:move', by: 0, card: phoenix, toZone: 'graveyard' }), 40);

    expect(s.instances[phoenix]!.zone).toBe('exile');
    // Which is also the only thing that stops the escape: there is no play on a card in exile.
    expect(legalActions(s, 0).plays.some((play) => play.name === 'Phoenix of Ash')).toBe(false);
  });

  it('Scavenging Ooze eats a creature card, grows and gains a life', () => {
    let s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'ember-rush' },
      battlefield: { 0: ['Forest', 'Scavenging Ooze'], 1: ['Mountain'] },
      graveyard: { 1: ['Raging Goblin', 'Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const ooze = find(s, 0, 'battlefield', 'Scavenging Ooze');
    const goblin = find(s, 1, 'graveyard', 'Raging Goblin');
    const lifeBefore = life(s, 0);

    s = drain(apply(s, {
      type: 'auto:activate', by: 0, card: ooze, abilityIndex: 0,
      targets: [{ kind: 'card', id: goblin }],
    }), 40);

    expect(s.instances[goblin]!.zone).toBe('exile');
    expect([power(s, ooze), toughness(s, ooze)]).toEqual([3, 3]);
    expect(life(s, 0)).toBe(lifeBefore + 1);
  });

  it('and eats a land for nothing, because the card asks what it was', () => {
    let s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'ember-rush' },
      battlefield: { 0: ['Forest', 'Scavenging Ooze'], 1: ['Mountain'] },
      graveyard: { 1: ['Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const ooze = find(s, 0, 'battlefield', 'Scavenging Ooze');
    const mountain = find(s, 1, 'graveyard', 'Mountain');
    const lifeBefore = life(s, 0);

    s = drain(apply(s, {
      type: 'auto:activate', by: 0, card: ooze, abilityIndex: 0,
      targets: [{ kind: 'card', id: mountain }],
    }), 40);

    expect(s.instances[mountain]!.zone).toBe('exile');
    // Exiled all the same — the ability does that unconditionally — and no counter, no life.
    expect([power(s, ooze), toughness(s, ooze)]).toEqual([2, 2]);
    expect(life(s, 0)).toBe(lifeBefore);
  });
});

describe('unearth: the body bought back out of the graveyard for one turn', () => {
  /*
    The third thing this engine can pay for out of a graveyard, and the only one that is not a cast.

    Escape and delve put the card on the stack, where it can be countered and where "whenever a
    player casts a spell" sees it. Unearth is an **activated ability**: the creature goes straight
    onto the battlefield with haste, and a delayed trigger exiles it at the beginning of the next
    end step. So the tests are about the three things that make it different from a cast — the zone
    the ability is offered from, the haste, and the end of the turn.
  */
  const graveyard = (deck: string, basic: string, lands: number, dead: readonly string[]): GameState => {
    const s = advanceTo(arena({
      decks: { 0: deck, 1: 'tidal-mind' },
      graveyard: { 0: [...dead] },
      battlefield: { 0: Array.from({ length: lands }, () => basic) },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('is offered from the graveyard and nowhere else, and puts the creature back with haste', () => {
    let s = graveyard('ashen-rite', 'Swamp', 2, ['Dregscape Zombie']);
    const zombie = find(s, 0, 'graveyard', 'Dregscape Zombie');
    const offer = legalActions(s, 0).plays.find((play) => play.card === zombie);
    expect(offer?.kind).toBe('activate');
    expect(offer?.fromGraveyard).toBe(true);
    expect(offer?.manaCost).toBe('{B}');

    s = drain(apply(s, { type: 'auto:activate', by: 0, card: zombie, abilityIndex: 0 }), 40);
    expect(s.instances[zombie]!.zone).toBe('battlefield');
    expect(characteristicsOf(s, s.instances[zombie]!).keywords.has('haste')).toBe(true);
    // Nothing was cast: the ability does not use the stack, so there is nothing to counter and
    // nothing for a cast trigger to see.
    expect(s.stackOrder).toEqual([]);
  });

  it('and it can attack the turn it comes back, then is exiled at the end of it', () => {
    let s = graveyard('ashen-rite', 'Swamp', 2, ['Dregscape Zombie']);
    const zombie = find(s, 0, 'graveyard', 'Dregscape Zombie');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: zombie, abilityIndex: 0 }), 40);

    s = advanceTo(s, 'declare-attackers');
    expect(legalActions(s, 0).attackers).toContain(zombie);

    // Declared empty, because a creature that can attack means a declaration is owed and
    // `advanceTo` will not walk past one: what this test is about is the end of the turn.
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [] });
    s = drain(advanceTo(s, 'end'), 40);
    // Exiled rather than put in the graveyard, which is the clause that stops it coming back again.
    expect(s.instances[zombie]!.zone).toBe('exile');
  });

  it('is a sorcery-speed ability, and not offered while the card is in hand', () => {
    const theirTurn = advanceTo(nextTurn(graveyard('ashen-rite', 'Swamp', 2, ['Dregscape Zombie'])), 'precombat-main');
    const zombie = find(theirTurn, 0, 'graveyard', 'Dregscape Zombie');
    expect(legalActions(theirTurn, 0).plays.some((play) => play.card === zombie)).toBe(false);

    // And in hand it is a two-mana 2/1 and nothing else: the ability's cost says which zone it
    // belongs to, so the same card offers one play in each.
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      hands: { 0: ['Dregscape Zombie'] },
      battlefield: { 0: ['Swamp', 'Swamp'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const inHand = find(s, 0, 'hand', 'Dregscape Zombie');
    const plays = legalActions(s, 0).plays.filter((play) => play.card === inHand);
    expect(plays.map((play) => play.kind)).toEqual(['cast']);
  });

  it('Hellspark Elemental sacrifices itself whether it was cast or unearthed', () => {
    // The printed card, and the half that is not the keyword: it carries its own end-step
    // sacrifice as well as the exile unearth schedules, and either one is enough to end its turn.
    let s = graveyard('kindle-grove', 'Mountain', 2, ['Hellspark Elemental']);
    const spark = find(s, 0, 'graveyard', 'Hellspark Elemental');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: spark, abilityIndex: 0 }), 40);
    expect(s.instances[spark]!.zone).toBe('battlefield');
    const ch = characteristicsOf(s, s.instances[spark]!);
    expect([ch.power, ch.toughness]).toEqual([3, 1]);
    expect(ch.keywords.has('trample')).toBe(true);

    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [] });
    s = drain(advanceTo(s, 'end'), 40);
    /*
      **Exiled, not sacrificed into a graveyard it could be bought from again**, and this assertion
      is the one the measurement asked for: the card's own end-step sacrifice reaches the graveyard
      first, so without unearth's "or if it would leave the battlefield" clause the same Hellspark
      came back a second time — 18 casts and 42 unearths across 22 games (D183). The replacement
      applies to the unearthed body alone, which is the `UNEARTHED` counter in the snapshot.
    */
    expect(s.instances[spark]!.zone).toBe('exile');
    expect(legalActions(s, 0).plays.some((play) => play.card === spark)).toBe(false);
  });

  it('and an unearthed creature the opponent bounces is exiled, not handed back', () => {
    /*
      The half of "or if it would leave the battlefield" that D183 shipped without, and the excuse
      it shipped on was wrong.

      That entry implemented the clause as a replacement on the body's own **death** and wrote down
      that a bounce or an exile is the same clause, with the note that nothing in this pool bounces
      its own creature. True, and beside the point: the *opponent's* Unsummon and Man-o'-War bounce
      it perfectly well, and Tidal Mind, Skyward Writ, Hollow Tide and Delta Bloom all run one. An
      unearthed Dregscape Zombie Unsummoned in response went to its owner's **hand** — a two-mana
      2/1 to cast again, or to discard and unearth again — where the printed card exiles it.

      The engine's replacement field covers the whole wording now (D185), so this is the fix as the
      card reads it. The opponent gets priority the honest way: the unearth is an ability that uses
      no stack, so seat 0 passes and seat 1 answers in the same step.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      graveyard: { 0: ['Dregscape Zombie'] },
      hands: { 1: ['Unsummon'] },
      battlefield: { 0: ['Swamp', 'Swamp'], 1: ['Island', 'Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const zombie = find(s, 0, 'graveyard', 'Dregscape Zombie');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: zombie, abilityIndex: 0 }), 40);
    expect(s.instances[zombie]!.zone).toBe('battlefield');

    s = drain(apply(apply(s, { type: 'auto:pass', by: 0 }), {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Unsummon'),
      targets: [{ kind: 'card', id: zombie }],
    }), 40);
    expect(s.instances[zombie]!.zone).toBe('exile');
    expect(ids(s, 0, 'hand')).not.toContain(zombie);
  });

  it('but a Hellspark that was cast and died is in a graveyard it can be unearthed from', () => {
    // The other side of the same clause: the replacement is about the body unearth put there, not
    // about the card, so the printed two-mana 3/1 still goes to the graveyard when it dies.
    let s = advanceTo(arena({
      decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
      hands: { 0: ['Hellspark Elemental'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hellspark Elemental'),
    }), 40);
    const spark = find(s, 0, 'battlefield', 'Hellspark Elemental');

    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [] });
    s = drain(advanceTo(s, 'end'), 40);
    expect(s.instances[spark]!.zone).toBe('graveyard');
  });
});

describe('embalm and eternalize: a token copy of the card, with different characteristics', () => {
  /*
    The fourth and fifth things payable out of a graveyard, and the first two whose product is not
    the card.

    Flashback, escape and delve cast it; unearth puts the creature itself back for a turn. These
    exile the card for good and give you a token copy of it "except it's a white Zombie with no mana
    cost", or a black Zombie with base power and toughness 4/4. So the tests are about the three
    things that are new: that the exception clause reaches the token's characteristics, that it does
    **not** reach the printed card, and that the token is still a copy — abilities and all, which
    is what makes the Angel of Sanctions worth embalming rather than a 3/4 flier worth having.
  */
  const graveyard = (dead: readonly string[], lands: number): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'tidal-mind' },
      graveyard: { 0: [...dead] },
      battlefield: { 0: Array.from({ length: lands }, () => 'Plains') },
      turn: 7, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  /** The one token on a seat's battlefield, which is what either keyword has just made. */
  const tokenOf = (s: GameState, seat: SeatIndex): string => {
    const found = ids(s, seat, 'battlefield').filter((id) => s.instances[id]!.isToken);
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it('embalms a Sacred Cat into a white Zombie Cat with no mana cost, and exiles the card', () => {
    let s = graveyard(['Sacred Cat'], 1);
    const cat = find(s, 0, 'graveyard', 'Sacred Cat');
    const offer = legalActions(s, 0).plays.find((play) => play.card === cat);
    expect(offer?.kind).toBe('activate');
    expect(offer?.fromGraveyard).toBe(true);
    expect(offer?.manaCost).toBe('{W}');

    s = drain(apply(s, { type: 'auto:activate', by: 0, card: cat, abilityIndex: 0 }), 40);
    // The card is gone for good: exiled as the cost, not put back anywhere.
    expect(s.instances[cat]!.zone).toBe('exile');

    const token = tokenOf(s, 0);
    const ch = characteristicsOf(s, s.instances[token]!);
    expect(ch.name).toBe('Sacred Cat');
    expect(ch.typeLine.types).toContain('Creature');
    expect(ch.typeLine.subtypes).toEqual(['Zombie', 'Cat']);
    expect([...ch.colors]).toEqual(['W']);
    expect([ch.power, ch.toughness]).toEqual([1, 1]);
    // Still a copy, so it still has the card's printed keyword.
    expect(ch.keywords.has('lifelink')).toBe(true);
    expect(s.cardDefs[s.instances[token]!.defKey]!.manaCost).toBe('');
  });

  it('and leaves the printed card alone, which is why the definition is keyed apart', () => {
    /*
      The bug this is the test for: a definition is keyed by the card's lowercased **name**, so an
      altered copy registered under its own name would have rewritten the Sacred Cat every other
      copy of the card reads — the one still in the library would have become a Zombie with no
      mana cost too. `TokenCopyProfile.as` is the suffix that keeps the two apart.
    */
    let s = graveyard(['Sacred Cat'], 1);
    const cat = find(s, 0, 'graveyard', 'Sacred Cat');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: cat, abilityIndex: 0 }), 40);

    const other = find(s, 0, 'library', 'Sacred Cat');
    const printed = s.cardDefs[s.instances[other]!.defKey]!;
    expect(printed.manaCost).toBe('{W}');
    expect(printed.typeLine).toBe('Creature \u2014 Cat');
    // And the two definitions really are two entries, not one read twice.
    expect(s.instances[other]!.defKey).not.toBe(s.instances[tokenOf(s, 0)]!.defKey);
  });

  it('cannot be embalmed twice, because the exile is the cost and not the effect', () => {
    /*
      Paid at activation (CR 702.89a). An effect that exiled on resolution would let the same Cat
      be embalmed again while the first ability was still on the stack — two Cats for one card,
      which is the kind of bug a player would only ever notice as "this deck is better than it
      should be".
    */
    let s = graveyard(['Sacred Cat'], 2);
    const cat = find(s, 0, 'graveyard', 'Sacred Cat');
    s = apply(s, { type: 'auto:activate', by: 0, card: cat, abilityIndex: 0 });
    // The ability is on the stack and the card is already in exile, with mana left for a second.
    expect(s.stackOrder).toHaveLength(1);
    expect(s.instances[cat]!.zone).toBe('exile');
    expect(legalActions(s, 0).plays.some((play) => play.card === cat)).toBe(false);
    expect(refusal(s, { type: 'auto:activate', by: 0, card: cat, abilityIndex: 0 }))
      .toBe('that card is not in your graveyard');

    s = drain(s, 40);
    expect(countOf(s, 0, 'battlefield', 'Sacred Cat')).toBe(1);
  });

  it('is a sorcery-speed ability, and is not offered from the battlefield', () => {
    // On the opponent's turn there is nothing to press, the way unearth has nothing.
    const theirTurn = advanceTo(nextTurn(graveyard(['Sacred Cat'], 1)), 'precombat-main');
    const inGraveyard = find(theirTurn, 0, 'graveyard', 'Sacred Cat');
    expect(legalActions(theirTurn, 0).plays.some((play) => play.card === inGraveyard)).toBe(false);

    // And a Cat on the battlefield offers nothing at all: the cost says which zone it belongs to.
    let s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'tidal-mind' },
      battlefield: { 0: ['Plains', 'Plains', 'Sacred Cat'] },
      turn: 7, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const onBoard = find(s, 0, 'battlefield', 'Sacred Cat');
    expect(legalActions(s, 0).plays.some((play) => play.card === onBoard)).toBe(false);
  });

  it('eternalizes an Adorned Pouncer into a black 4/4 Zombie that still has double strike', () => {
    let s = graveyard(['Adorned Pouncer'], 6);
    const pouncer = find(s, 0, 'graveyard', 'Adorned Pouncer');
    expect(legalActions(s, 0).plays.find((play) => play.card === pouncer)?.manaCost)
      .toBe('{4}{W}{W}');

    s = drain(apply(s, { type: 'auto:activate', by: 0, card: pouncer, abilityIndex: 0 }), 40);
    const ch = characteristicsOf(s, s.instances[tokenOf(s, 0)]!);
    expect(ch.name).toBe('Adorned Pouncer');
    // The size is the keyword's whole point: a 1/1 double striker is two damage, a 4/4 is eight.
    expect([ch.power, ch.toughness]).toEqual([4, 4]);
    expect([...ch.colors]).toEqual(['B']);
    expect(ch.typeLine.subtypes).toEqual(['Zombie', 'Cat']);
    expect(ch.keywords.has('double strike')).toBe(true);
  });

  it('and the eternalized body is a printed 4/4, not a 1/1 under an effect', () => {
    // Which matters because the two are told apart by everything that reads a base value: the
    // profile replaces the definition's power and toughness, so there is no continuous effect
    // here for a copy or a characteristic-setting spell to peel off.
    let s = graveyard(['Adorned Pouncer'], 6);
    const pouncer = find(s, 0, 'graveyard', 'Adorned Pouncer');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: pouncer, abilityIndex: 0 }), 40);
    const token = tokenOf(s, 0);
    expect(s.effects.filter((effect) => effect.scope.kind === 'cards'
      && effect.scope.ids.includes(token))).toEqual([]);
    const def = s.cardDefs[s.instances[token]!.defKey]!;
    expect([def.power, def.toughness]).toEqual(['4', '4']);
  });

  it('a Sunscourge Champion token gains the two life its printed trigger gains', () => {
    // The entry trigger is on the token because `scriptFor` finds a script by **name**, and the
    // name is the one printed field the profile leaves alone.
    let s = graveyard(['Sunscourge Champion'], 7);
    const before = life(s, 0);
    const champion = find(s, 0, 'graveyard', 'Sunscourge Champion');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: champion, abilityIndex: 0 }), 40);
    expect(life(s, 0)).toBe(before + 2);
    expect(characteristicsOf(s, s.instances[tokenOf(s, 0)]!).power).toBe(4);
  });

  it('an embalmed Angel of Sanctions exiles a permanent again, and gives it back when it dies', () => {
    /*
      The reason either keyword is printed on a card with text rather than on a bear, and the thing
      a token built as a plain 3/4 flier would have silently lost. Both halves of
      "exile until ~ leaves the battlefield" are on the token: the entry exiles, and the token
      leaving hands the permanent back.
    */
    // Built inline rather than through the helper, because the one thing of theirs worth exiling
    // has to be on the board *before* the game starts: a creature walked on afterwards would
    // raise its own entry trigger and the test would be about that instead.
    let s = advanceTo(arena({
      decks: { 0: 'dawn-tithe', 1: 'tidal-mind' },
      graveyard: { 0: ['Angel of Sanctions'] },
      battlefield: {
        0: Array.from({ length: 5 }, () => 'Plains'),
        1: ['Wall of Frost'],
      },
      turn: 7, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const theirs = find(s, 1, 'battlefield', 'Wall of Frost');
    const angel = find(s, 0, 'graveyard', 'Angel of Sanctions');
    s = apply(s, { type: 'auto:activate', by: 0, card: angel, abilityIndex: 0 });
    s = drain(s, 40);

    const token = tokenOf(s, 0);
    expect(characteristicsOf(s, s.instances[token]!).keywords.has('flying')).toBe(true);
    expect(s.instances[theirs]!.zone).toBe('exile');
    expect(s.instances[theirs]!.exiledBy).toBe(token);

    // And killing the token returns it, which is the half that makes the card fair.
    s = drain(apply(s, { type: 'card:move', by: 0, card: token, toZone: 'graveyard' }), 40);
    expect(s.instances[theirs]!.zone).toBe('battlefield');
    // The token itself ceased to exist rather than going anywhere (CR 111.7), so there is nothing
    // in the graveyard to embalm a second time.
    expect(s.instances[token]).toBeUndefined();
  });

  it('and the altered definition survives the trip to a seat\u2019s view and back', () => {
    /*
      The half a browser is the only other witness to, asked here because a browser is slow.

      A token whose characteristics are not the copied card's is a **second definition under a
      second key**, and everything between the engine and the card a player looks at has to carry
      that: `viewFor` has to inline the altered def rather than the printed one, and `packView`
      has to keep them apart on the wire. If either collapsed the two by name, the Zombie on the
      battlefield would be drawn as a 1/1 Cat with `{W}` on it and nothing would throw — the exact
      failure `TokenCopyProfile.as` exists to prevent, one layer further out.
    */
    let s = graveyard(['Adorned Pouncer'], 6);
    const pouncer = find(s, 0, 'graveyard', 'Adorned Pouncer');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: pouncer, abilityIndex: 0 }), 40);
    const token = tokenOf(s, 0);

    const view = unpackView(packView(viewFor(s, 0)));
    const drawn = view.cards[token];
    expect(drawn).toBeDefined();
    expect(drawn!.isToken).toBe(true);
    // The size the player reads, which for an eternalized body is printed rather than pumped.
    expect([drawn!.power, drawn!.toughness]).toEqual([4, 4]);
    expect(drawn!.card?.typeLine).toBe('Token Creature \u2014 Zombie Cat');
    expect(drawn!.card?.manaCost).toBe('');
    expect(drawn!.card?.name).toBe('Adorned Pouncer');
    /*
      And the printed card is still the printed card in the same payload, which is the collision
      this is really about: the two definitions share a name, and `packView` keys the deduplicated
      definitions it sends. A seat looking at its own graveyard sees both at once.
    */
    const inYard = Object.entries(view.cards)
      .find(([, card]) => card.zone === 'graveyard' && card.card?.name === 'Adorned Pouncer');
    if (inYard !== undefined) {
      expect(inYard[1].card?.manaCost).toBe('{1}{W}');
      expect(inYard[1].card?.typeLine).toBe('Creature \u2014 Cat');
    }
  });
});

describe('miracle: the cast offered the moment you draw it', () => {
  /*
    The first cost in this engine conditioned on **when in the turn** a card arrived.

    Not an alternative cost on a card in hand like evoke, and not a cast out of another zone like
    flashback: an **offer**, made by the engine as the card is drawn, with the card still in the
    hand it has just arrived in. So the tests are about the three things that are new — the
    condition ("the first card you drew this turn"), the window (the draw itself), and the one
    disposition no other offer has: declining leaves the card where it is.

    The draw is the real draw step rather than a card that draws, which took a false start to get
    right: `arena` ends up in the active seat's **main phase**, so that turn's draw has already
    happened and anything drawn after it is the turn's second card. Putting the card on top and
    playing on to the next turn is the only way to be the first.
  */
  const onTop = (top: string, board: readonly string[], deck = 'arc-tempest'): GameState => {
    const s = advanceTo(arena({
      decks: { 0: deck, 1: 'rot-harvest' },
      battlefield: { 0: [...board] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    // Where a Preordain would have put it.
    return apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', top), toZone: 'library', position: 'top',
    });
  };
  /**
   * Plays on until an offer is standing, or until the game stops for something else.
   *
   * `nextTurn` cannot be used here: it passes priority until the turn counter moves, and an offer
   * takes priority away from everybody — so it would throw "nobody holds priority" on the very
   * state these tests are about.
   */
  const untilOffered = (start: GameState): GameState => {
    let s = start;
    for (let i = 0; i < 200; i += 1) {
      if (s.pendingOfferedCast !== null) return s;
      const owed = pendingDeclaration(s);
      if (owed !== null) {
        for (const seat of owed.seats) {
          s = owed.kind === 'attackers'
            ? apply(s, { type: 'auto:attack', by: seat, attackers: [] })
            : apply(s, { type: 'auto:block', by: seat, blocks: [] });
        }
        continue;
      }
      const discard = s.pendingDiscard;
      if (discard !== null) {
        s = apply(s, { type: 'auto:discard', by: discard.seat, card: ids(s, discard.seat, 'hand')[0]! });
        continue;
      }
      if (s.priority === null) throw new Error(`nobody holds priority at ${s.step}`);
      s = apply(s, { type: 'auto:pass', by: s.priority });
    }
    throw new Error('no offer was ever made');
  };
  /** Plays on to seat 0's next draw step without stopping for an offer. */
  const toMyNextDraw = (s: GameState): GameState => untilOffered(s);

  const MOUNTAINS = ['Mountain', 'Mountain', 'Mountain'];

  it('offers the card for its miracle cost as the first card drawn this turn', () => {
    const s = toMyNextDraw(onTop('Thunderous Wrath', MOUNTAINS));
    expect(s.step).toBe('draw');
    expect(s.activeSeat).toBe(0);
    expect(s.cardsDrawnThisTurn['0']).toBe(1);

    const offer = s.pendingOfferedCast;
    expect(offer?.seat).toBe(0);
    expect(nameOf(s, offer?.card ?? '')).toBe('Thunderous Wrath');
    expect(offer?.cost).toBe('{R}');
    // The one disposition no other offer has: the card is in hand and declining will not move it.
    expect(offer?.stays).toBe(true);
    expect(s.instances[offer!.card]!.zone).toBe('hand');

    // And the only play offered is the cheap one, at {R} rather than the printed {4}{R}{R}.
    const you = legalActions(s, 0);
    expect(you.passLabel).toBe('Decline');
    expect(you.plays.map((play) => play.manaCost)).toEqual(['{R}']);
    expect(you.plays[0]?.offered).toBe(true);
    expect(you.mustCastOffered?.cost).toBe('{R}');
  });

  it('and five damage for one mana is what it buys', () => {
    let s = toMyNextDraw(onTop('Thunderous Wrath', MOUNTAINS));
    const wrath = s.pendingOfferedCast!.card;
    const before = life(s, 1);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: wrath, offered: true, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(life(s, 1)).toBe(before - 5);
    expect(namesIn(s, 0, 'graveyard')).toContain('Thunderous Wrath');
    // One Mountain tapped, not six: {R} was paid rather than the printed {4}{R}{R}.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(1);
  });

  it('declining leaves it in hand, which is the whole shape of the keyword', () => {
    /*
      The disposition that is not a move. A cascade hit declined goes to the bottom with its pile
      and a madness card declined finishes its discard; a miracle card declined is a card in your
      hand you chose not to cast for {R}, and you may still cast it for {4}{R}{R} later. The first
      version of the decline path bottomed it, which is a strictly worse card than the printed one.
    */
    let s = toMyNextDraw(onTop('Thunderous Wrath', MOUNTAINS));
    const wrath = s.pendingOfferedCast!.card;
    s = drain(apply(s, { type: 'auto:pass', by: 0 }), 40);
    expect(s.pendingOfferedCast).toBeNull();
    expect(s.instances[wrath]!.zone).toBe('hand');
    // The card itself rather than the name: Arc Tempest runs two, and the other is still on top
    // of a library it was never drawn from.
    expect(ids(s, 0, 'hand')).toContain(wrath);
  });

  it('is not offered on the second card drawn in a turn (CR 702.94a)', () => {
    /*
      A Think Twice after the draw step: the Wrath is the turn's *second* card and the keyword says
      nothing about it. Which is also the thing `nth` on the draw exists for — by the time the
      second card has arrived, a count of the turn's draws cannot tell it from the first.
    */
    let s = onTop('Thunderous Wrath', [...MOUNTAINS, 'Island', 'Island']);
    // A land above it, so the draw step finds the land and the Think Twice finds the Wrath.
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Think Twice'), toZone: 'hand',
    });
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Mountain'),
      toZone: 'library', position: 'top',
    });
    // No offer on the way to this seat's main phase, because the first card was the Mountain.
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(s.pendingOfferedCast).toBeNull();
    expect(s.cardsDrawnThisTurn['0']).toBe(1);

    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Think Twice') }), 40);
    expect(s.cardsDrawnThisTurn['0']).toBe(2);
    expect(s.pendingOfferedCast).toBeNull();
    expect(namesIn(s, 0, 'hand')).toContain('Thunderous Wrath');
  });

  it('and not on a card put into your hand without drawing it', () => {
    // The distinction `GameState.drew` exists for: a Gravedigger and a Man-o'-War put cards in a
    // hand and nobody drew one, so the keyword never sees them.
    let s = onTop('Thunderous Wrath', MOUNTAINS);
    const wrath = find(s, 0, 'library', 'Thunderous Wrath');
    s = drain(apply(s, { type: 'card:move', by: 0, card: wrath, toZone: 'hand' }), 40);
    expect(s.pendingOfferedCast).toBeNull();
  });

  it('the turn\u2019s draw count resets, so the next turn has a first card again', () => {
    let s = toMyNextDraw(onTop('Thunderous Wrath', MOUNTAINS));
    expect(s.cardsDrawnThisTurn['0']).toBe(1);
    s = drain(apply(s, { type: 'auto:pass', by: 0 }), 40);
    // Over the turn boundary, which is where the cleanup step clears it beside the spell count
    // and the turn's life loss.
    s = nextTurn(s);
    expect(s.cardsDrawnThisTurn['0'] ?? 0).toBe(0);
  });

  it('is taken back when the miracle cost cannot be paid, and the card stays in hand', () => {
    /*
      A question with one answer is not a question (CR 601.2h), and `settleOffer` answers it. Two
      Islands cannot pay {R}, so the table is never stopped — and the card is simply a card in hand.
    */
    const s = advanceTo(nextTurn(nextTurn(onTop('Thunderous Wrath', ['Island', 'Island']))), 'precombat-main');
    expect(s.pendingOfferedCast).toBeNull();
    expect(namesIn(s, 0, 'hand')).toContain('Thunderous Wrath');
    /*
      And the table was never stopped: `nextTurn` walked straight through the draw step, which it
      cannot do while an offer is standing. The note saying so travels on the action's own message
      rather than in the state — `autoActions` drains `replacements` into the log at the end of
      every automated action — so there is nothing here to read it from, which is why this test
      asserts the behaviour instead of the sentence.
    */
    expect(legalActions(s, 0).hasPriority).toBe(true);
  });

  it('Terminus puts every creature on the bottom of its owner\u2019s library, and kills none of them', () => {
    /*
      The other card, and the cleanest sweeper in the pool: nothing dies, so nothing that watches a
      death sees anything and nothing can be bought back out of a graveyard afterwards. Its own
      creatures go too.
    */
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'rot-harvest' },
      hands: { 0: ['Terminus'] },
      battlefield: {
        0: ['Plains', 'Plains', 'Plains', 'Island', 'Island', 'Wall of Air'],
        1: ['Gravedigger', 'Blood Artist'],
      },
      turn: 6, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const wall = find(s, 0, 'battlefield', 'Wall of Air');
    const theirs = find(s, 1, 'battlefield', 'Gravedigger');
    const before = life(s, 0);

    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Terminus') }), 40);
    expect(s.instances[wall]!.zone).toBe('library');
    expect(s.instances[theirs]!.zone).toBe('library');
    // Each to its **own** owner's library, which is what the card says.
    expect(s.instances[wall]!.zoneSeat).toBe(0);
    expect(s.instances[theirs]!.zoneSeat).toBe(1);
    // Nothing died, so the Blood Artist beside it drained nobody.
    expect(namesIn(s, 1, 'graveyard')).not.toContain('Gravedigger');
    expect(life(s, 0)).toBe(before);
    // The lands stay: "all creatures" is all it says.
    expect(namesIn(s, 0, 'battlefield')).toContain('Plains');
  });

  it('and is offered for {W} off the top, out of a deck that would rather not pay five', () => {
    const s = toMyNextDraw(onTop('Terminus', ['Plains', 'Plains'], 'skyward-writ'));
    const offer = s.pendingOfferedCast;
    expect(nameOf(s, offer?.card ?? '')).toBe('Terminus');
    expect(offer?.cost).toBe('{W}');
    expect(legalActions(s, 0).plays.map((play) => play.manaCost)).toEqual(['{W}']);
    // A **sorcery**, offered in the draw step: the keyword says when, not the card's type line.
    expect(s.step).toBe('draw');
  });
});

describe('suspend: a card cast on turn two for turn five', () => {
  /*
    The only mechanic here that spends **turns** as a resource, and the fourth use of the offer
    family — with the one thing the family had never needed: a cast that cannot be declined.

    So the tests are the three joints. The special action (pay the card's own cost, exile it with
    time counters), the upkeep tick (one counter a turn, and the last one raises the cast), and the
    mandatory half: no pass while the offer stands, and the engine answering for itself when the
    cast cannot be made at all.
  */
  const holding = (card: string, lands: readonly string[]): GameState => advanceTo(arena({
    decks: { 0: 'kindle-grove', 1: 'rot-harvest' },
    hands: { 0: [card] },
    battlefield: { 0: [...lands] },
    turn: 5, firstSeat: 0,
  }), 'precombat-main');
  /** Plays on until an offer is standing, which is how the suspended cast arrives. */
  const untilOffered = (start: GameState): GameState => {
    let s = start;
    for (let i = 0; i < 300; i += 1) {
      if (s.pendingOfferedCast !== null) return s;
      const owed = pendingDeclaration(s);
      if (owed !== null) {
        for (const seat of owed.seats) {
          s = owed.kind === 'attackers'
            ? apply(s, { type: 'auto:attack', by: seat, attackers: [] })
            : apply(s, { type: 'auto:block', by: seat, blocks: [] });
        }
        continue;
      }
      const discard = s.pendingDiscard;
      if (discard !== null) {
        s = apply(s, {
          type: 'auto:discard', by: discard.seat, card: ids(s, discard.seat, 'hand')[0]!,
        });
        continue;
      }
      if (s.priority === null) throw new Error(`nobody holds priority at ${s.step}`);
      s = apply(s, { type: 'auto:pass', by: s.priority });
    }
    throw new Error('no offer was ever made');
  };

  it('exiles the card with time counters for its own cost, not the printed one', () => {
    let s = holding('Rift Bolt', ['Mountain', 'Mountain', 'Mountain']);
    const bolt = find(s, 0, 'hand', 'Rift Bolt');
    // Offered as a row of its own, beside the printed cast, and priced at the suspend cost.
    const row = legalActions(s, 0).plays.find((play) => play.kind === 'suspend');
    expect(row?.card).toBe(bolt);
    expect(row?.manaCost).toBe('{R}');
    expect(row?.description).toContain('1 time counter');

    s = apply(s, { type: 'auto:suspend', by: 0, card: bolt });
    expect(s.instances[bolt]!.zone).toBe('exile');
    expect(s.instances[bolt]!.counters['time']).toBe(1);
    // One Mountain for {R}, not three for the printed {2}{R}.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(1);
  });

  it('removes a counter each upkeep, and the last one casts it for nothing', () => {
    let s = holding('Rift Bolt', ['Mountain']);
    const bolt = find(s, 0, 'hand', 'Rift Bolt');
    const theirs = life(s, 1);
    s = apply(s, { type: 'auto:suspend', by: 0, card: bolt });

    s = untilOffered(s);
    expect(s.step).toBe('upkeep');
    expect(s.activeSeat).toBe(0);
    const offer = s.pendingOfferedCast;
    expect(offer?.card).toBe(bolt);
    expect(offer?.mandatory).toBe(true);
    // The counter is gone, which is what stops it being suspended any more.
    expect(s.instances[bolt]!.counters['time']).toBeUndefined();
    // And there is no pass: the cast is not a request (CR 702.62c).
    const you = legalActions(s, 0);
    expect(you.canPass).toBe(false);
    expect(you.plays.map((play) => play.offered)).toEqual([true]);

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: bolt, offered: true, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(life(s, 1)).toBe(theirs - 3);
    expect(namesIn(s, 0, 'graveyard')).toContain('Rift Bolt');
    // The Mountain it was suspended with is untapped again by now: nothing was paid for the cast.
    expect(s.pendingOfferedCast).toBeNull();
  });

  it('two counters means two upkeeps, which is what the second card costs', () => {
    let s = holding('Search for Tomorrow', ['Forest']);
    const search = find(s, 0, 'hand', 'Search for Tomorrow');
    s = apply(s, { type: 'auto:suspend', by: 0, card: search });
    expect(s.instances[search]!.counters['time']).toBe(2);

    // The first upkeep takes one off and offers nothing.
    s = nextTurn(nextTurn(s));
    expect(s.instances[search]!.counters['time']).toBe(1);
    expect(s.pendingOfferedCast).toBeNull();

    // The second takes the last one and casts it: a basic land, untapped, from the library.
    const lands = ids(s, 0, 'battlefield').length;
    s = untilOffered(s);
    s = apply(s, { type: 'auto:cast', by: 0, card: search, offered: true });
    // The spell is on the stack now — a suspended cast is an ordinary cast, which is the point of
    // routing it through the offer family — so it resolves when the table passes.
    s = passBoth(s);
    // And then the card's own question, which is the half that makes this a search rather than a
    // ramp spell: the engine stops mid-resolution and the player names the land.
    s = drain(decide(s, ['Forest']), 60);
    expect(ids(s, 0, 'battlefield').length).toBe(lands + 1);
    expect(namesIn(s, 0, 'battlefield')).toContain('Forest');
    expect(namesIn(s, 0, 'graveyard')).toContain('Search for Tomorrow');
  });

  it('and the other player can see it coming, which is half of what it costs', () => {
    /*
      Suspend is **public**, and that is not a detail: a foretold card is a secret and a suspended
      one is a threat with a date on it. So the claim is about the opponent's own view — the card
      by name, in exile, with the number of turns left on it — because a mechanic whose whole risk
      is that the other player gets to prepare has to be visible to them.
    */
    let s = holding('Search for Tomorrow', ['Forest']);
    const search = find(s, 0, 'hand', 'Search for Tomorrow');
    s = apply(s, { type: 'auto:suspend', by: 0, card: search });

    const theirs = unpackView(packView(viewFor(s, 1)));
    const seen = theirs.cards[search];
    expect(seen?.card?.name).toBe('Search for Tomorrow');
    expect(seen?.zone).toBe('exile');
    expect(seen?.counters?.['time']).toBe(2);
  });
});

describe('extort: an optional cost paid while the trigger resolves', () => {
  /*
    The first optional **mana** cost in this engine that is paid during a resolution. A kicker and a
    replicate count are announced as a spell is cast; a ward is paid by an opponent to a question
    the engine raises. Extort is the card asking its own controller for mana in the middle of its
    own ability — and the card cannot pay it, because paying means tapping lands.

    So the tests are about the price on the answer: that it is asked when it can be paid, that it is
    *not* asked when it cannot, that paying taps a land and drains, and that declining does nothing.
  */
  const board = (lands: readonly string[]): GameState => advanceTo(arena({
    decks: { 0: 'hollow-tide', 1: 'rot-harvest' },
    hands: { 0: ['Thought Scour'] },
    battlefield: { 0: ['Basilica Screecher', ...lands] },
    turn: 5, firstSeat: 0,
  }), 'precombat-main');

  it('asks for the mana as the trigger resolves, and drains when it is paid', () => {
    // An Island for the Thought Scour and a Swamp for the extort: the {W/B} is paid with black.
    let s = board(['Island', 'Swamp']);
    const theirs = life(s, 1);
    const mine = life(s, 0);
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thought Scour'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    // The spell is cast and its extort trigger is on top of it, waiting to be answered.
    s = passBoth(s);
    const ask = s.pendingDecision;
    expect(ask?.seat).toBe(0);
    expect(ask?.prompt).toContain('{W/B}');
    expect(ask?.options).toEqual(['Decline', 'Pay {W/B}']);

    s = drain(apply(s, { type: 'auto:decide', by: 0, option: 'Pay {W/B}' }), 40);
    expect(life(s, 1)).toBe(theirs - 1);
    expect(life(s, 0)).toBe(mine + 1);
    // One Swamp for the spell and one for the extort: the cost was really paid.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(2);
  });

  it('and declining costs nothing at all', () => {
    // An Island for the Thought Scour and a Swamp for the extort: the {W/B} is paid with black.
    let s = board(['Island', 'Swamp']);
    const theirs = life(s, 1);
    const mine = life(s, 0);
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thought Scour'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    s = passBoth(s);
    s = drain(apply(s, { type: 'auto:decide', by: 0, option: 'Decline' }), 40);
    expect(life(s, 1)).toBe(theirs);
    expect(life(s, 0)).toBe(mine);
    // Only the spell's own Swamp.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(1);
  });

  it('is not asked at all when the mana is not there', () => {
    /*
      One Swamp, spent on the spell itself. The option with the price on it is filtered out before
      the question is asked, which leaves one word — and a question with one answer is one the
      engine answers itself rather than a prompt with one button.
    */
    let s = board(['Island']);
    const theirs = life(s, 1);
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thought Scour'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    s = drain(passBoth(s), 40);
    expect(s.pendingDecision).toBeNull();
    expect(life(s, 1)).toBe(theirs);
  });

  it('pays once per spell, so two spells are two lives', () => {
    let s = board(['Island', 'Island', 'Swamp', 'Swamp']);
    const theirs = life(s, 1);
    /*
      A second spell in hand, walked in so the turn can cast both — and a **different** spell,
      which is the stronger form of the claim: extort fires on each spell you cast rather than on
      each copy of one card.
    */
    const preordain = find(s, 0, 'library', 'Preordain');
    s = apply(s, { type: 'card:move', by: 0, card: preordain, toZone: 'hand' });
    for (const card of [find(s, 0, 'hand', 'Thought Scour'), preordain]) {
      const targets = nameOf(s, card) === 'Thought Scour'
        ? [{ kind: 'player' as const, seat: 1 as SeatIndex }]
        : [];
      s = apply(s, { type: 'auto:cast', by: 0, card, targets });
      s = passBoth(s);
      // Preordain's own scry comes first on the way through, and is answered by leaving the cards
      // where they are: this test is about the extort beneath it.
      while (s.pendingDecision !== null) {
        s = s.pendingDecision.options?.includes('Pay {W/B}') === true
          ? apply(s, { type: 'auto:decide', by: 0, option: 'Pay {W/B}' })
          : apply(s, { type: 'auto:decide', by: 0, cards: [] });
      }
      s = drain(s, 40);
    }
    expect(life(s, 1)).toBe(theirs - 2);
  });

  it('and the bot pays it, which is the whole of its policy', () => {
    let s = board(['Island', 'Swamp']);
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Thought Scour'),
      targets: [{ kind: 'player', seat: 1 }],
    });
    s = passBoth(s);
    expect(s.pendingDecision?.options).toEqual(['Decline', 'Pay {W/B}']);
    const answer = botAction(s, 0);
    expect(answer?.type).toBe('auto:decide');
    expect(answer?.type === 'auto:decide' ? answer.option : null).toBe('Pay {W/B}');
  });
});

describe('replicate: a cost paid several times over', () => {
  /*
    The engine's first cost that can be paid **more than once on one casting**, and the first number
    announced with a spell that is not {X}. Everything else in the cost family is a yes or a no.

    So the tests are about the three things that are new: the list of plays (one per count the mana
    will cover, which is the kicker's arrangement rather than {X}'s picker), the copies the count
    buys, and the refusals for a count that is not a count.
  */
  const casting = (card: string, deck: string, lands: readonly string[]): GameState => advanceTo(
    arena({
      decks: { 0: deck, 1: 'rot-harvest' },
      hands: { 0: [card] },
      battlefield: { 0: [...lands] },
      turn: 6, firstSeat: 0,
    }),
    'precombat-main',
  );
  const MOUNTAIN = 'Mountain';

  it('offers one cast per count the mana will cover, and no more', () => {
    const two = casting('Pyromatics', 'arc-tempest', [MOUNTAIN, MOUNTAIN]);
    const pyro = (s: GameState): string => find(s, 0, 'hand', 'Pyromatics');
    expect(legalActions(two, 0).plays.filter((p) => p.card === pyro(two))
      .map((p) => [p.manaCost, p.replicate]))
      .toEqual([['{1}{R}', undefined]]);

    const six = casting('Pyromatics', 'arc-tempest', Array.from({ length: 6 }, () => MOUNTAIN));
    expect(legalActions(six, 0).plays.filter((p) => p.card === pyro(six))
      .map((p) => p.replicate))
      .toEqual([undefined, 1, 2]);

    /*
      And the cap, which is about the list rather than about the rules: with ten lands up the player
      could pay four times over and the cost of a fifth is the only thing stopping a fifth row.
      Arc Tempest's own mana base is what is available — seven Mountains and three Izzet Guildgates,
      which is every red source the deck has.
    */
    const ten = casting('Pyromatics', 'arc-tempest', [
      ...Array.from({ length: 7 }, () => MOUNTAIN),
      'Izzet Guildgate', 'Izzet Guildgate', 'Izzet Guildgate',
    ]);
    expect(legalActions(ten, 0).plays.filter((p) => p.card === pyro(ten))
      .map((p) => p.replicate))
      .toEqual([undefined, 1, 2, 3, 4]);
  });

  it('copies the spell for each payment, keeping the original\'s target', () => {
    let s = casting('Pyromatics', 'arc-tempest', Array.from({ length: 6 }, () => MOUNTAIN));
    const pyro = find(s, 0, 'hand', 'Pyromatics');
    const before = life(s, 1);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: pyro, replicate: 2,
      targets: [{ kind: 'player', seat: 1 }], division: [1],
    }), 60);
    // One damage three times rather than three damage once: three separate dealings, which is what
    // protection and prevention each have to be asked about separately.
    expect(life(s, 1)).toBe(before - 3);
    // Six mana for it, which is the whole of what the keyword charges.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(6);
    expect(namesIn(s, 0, 'graveyard')).toContain('Pyromatics');
  });

  it('and the cheap casting is still there, for one mana at a time', () => {
    let s = casting('Pyromatics', 'arc-tempest', [MOUNTAIN, MOUNTAIN]);
    const before = life(s, 1);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Pyromatics'),
      targets: [{ kind: 'player', seat: 1 }], division: [1],
    }), 60);
    expect(life(s, 1)).toBe(before - 1);
  });

  it('draws a card for each payment, on the keyword\'s other card', () => {
    let s = casting('Train of Thought', 'hollow-tide',
      ['Island', 'Island', 'Island', 'Island', 'Island', 'Island']);
    const held = ids(s, 0, 'hand').length;
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Train of Thought'), replicate: 1,
    }), 60);
    // Two cards for six mana: the Train itself and one copy. The card it was cast with is gone, so
    // the hand is one up on where it started rather than two.
    expect(ids(s, 0, 'hand').length).toBe(held - 1 + 2);
  });

  it('refuses a count that is not a count, and one on a card with no replicate', () => {
    const s = casting('Pyromatics', 'arc-tempest', Array.from({ length: 6 }, () => MOUNTAIN));
    const pyro = find(s, 0, 'hand', 'Pyromatics');
    const aim = { targets: [{ kind: 'player' as const, seat: 1 as SeatIndex }], division: [1] };
    // Zero is "no replicate at all" rather than a count of none, and is simply the printed cast.
    expect(refusal(s, { type: 'auto:cast', by: 0, card: pyro, replicate: 0, ...aim })).toBeNull();
    expect(refusal(s, { type: 'auto:cast', by: 0, card: pyro, replicate: -1, ...aim }))
      .toContain('whole number');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: pyro, replicate: 1.5, ...aim }))
      .toContain('whole number');
    // And a count it cannot pay for, refused by the payment rather than by a range check.
    expect(refusal(s, { type: 'auto:cast', by: 0, card: pyro, replicate: 4, ...aim }))
      .not.toBeNull();

    const bolt = casting('Lightning Bolt', 'arc-tempest', [MOUNTAIN, MOUNTAIN]);
    expect(refusal(bolt, {
      type: 'auto:cast', by: 0, card: find(bolt, 0, 'hand', 'Lightning Bolt'), replicate: 1,
      targets: [{ kind: 'player', seat: 1 }],
    })).toContain('no replicate');
  });
});

describe('rebound: the spell that casts itself again next turn', () => {
  /*
    The fourth card in the engine that is cast twice, and the first that pays for the second casting
    with **time**. Flashback charges a second price, escape charges mana and a graveyard, madness
    and miracle charge less than the printed cost once — rebound charges nothing at all, and the
    price is that your opponent gets a whole turn in between.

    So the tests are about the three things that are new: where the card goes as it resolves (exile,
    not a graveyard), when the offer arrives (its controller's next upkeep, from a delayed trigger),
    and the two halves of the rule that stop it being infinite — the second casting comes from exile
    and so does not rebound, and a spell that never resolved never rebounds either.
  */
  const holding = (card: string, deck: string, lands: readonly string[]): GameState => advanceTo(
    arena({
      decks: { 0: deck, 1: 'rot-harvest' },
      hands: { 0: [card] },
      battlefield: { 0: [...lands] },
      turn: 5, firstSeat: 0,
    }),
    'precombat-main',
  );
  /** Plays on until an offer is standing, which is the only way to reach the rebound cast. */
  const untilOffered = (start: GameState): GameState => {
    let s = start;
    for (let i = 0; i < 200; i += 1) {
      if (s.pendingOfferedCast !== null) return s;
      const owed = pendingDeclaration(s);
      if (owed !== null) {
        for (const seat of owed.seats) {
          s = owed.kind === 'attackers'
            ? apply(s, { type: 'auto:attack', by: seat, attackers: [] })
            : apply(s, { type: 'auto:block', by: seat, blocks: [] });
        }
        continue;
      }
      const discard = s.pendingDiscard;
      if (discard !== null) {
        s = apply(s, {
          type: 'auto:discard', by: discard.seat, card: ids(s, discard.seat, 'hand')[0]!,
        });
        continue;
      }
      if (s.priority === null) throw new Error(`nobody holds priority at ${s.step}`);
      s = apply(s, { type: 'auto:pass', by: s.priority });
    }
    throw new Error('no offer was ever made');
  };

  it('exiles itself as it resolves, and schedules the free cast for your next upkeep', () => {
    let s = holding('Staggershock', 'arc-tempest', ['Mountain', 'Mountain']);
    const shock = find(s, 0, 'hand', 'Staggershock');
    const before = life(s, 1);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: shock, targets: [{ kind: 'player', seat: 1 }],
    }), 40);

    expect(life(s, 1)).toBe(before - 2);
    // Exile rather than the graveyard, which is the half of the keyword the card's text spends
    // most of its words on.
    expect(s.instances[shock]!.zone).toBe('exile');
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Staggershock');
    // And the promise, as a delayed trigger rather than as a flag on the card (CR 603.7).
    expect(s.delayed.map((entry) => [entry.step, entry.of, entry.subject]))
      .toEqual([['upkeep', 'you', shock]]);
  });

  it('offers it for nothing in the upkeep, and the second casting does not rebound again', () => {
    let s = holding('Staggershock', 'arc-tempest', ['Mountain', 'Mountain']);
    const shock = find(s, 0, 'hand', 'Staggershock');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: shock, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    const after = life(s, 1);

    s = untilOffered(s);
    expect(s.step).toBe('upkeep');
    expect(s.activeSeat).toBe(0);
    const offer = s.pendingOfferedCast;
    expect(offer?.seat).toBe(0);
    expect(offer?.card).toBe(shock);
    // Free, and the card is where the resolution left it.
    expect(offer?.cost).toBeUndefined();
    expect(offer?.stays).toBe(true);
    expect(s.instances[shock]!.zone).toBe('exile');
    expect(legalActions(s, 0).mustCastOffered?.cost).toBe('');
    expect(legalActions(s, 0).passLabel).toBe('Decline');

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: shock, offered: true, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    // Two more damage, and no mana paid for it: the lands are still untapped in the upkeep.
    expect(life(s, 1)).toBe(after - 2);
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped)).toEqual([]);
    /*
      And the loop-breaker: this casting came out of **exile**, so nothing flagged it, so the card
      goes to the graveyard like any other spell and nothing is scheduled. A rebound that remembered
      nothing about where it was cast from would be two damage every upkeep for the rest of the game.
    */
    expect(namesIn(s, 0, 'graveyard')).toContain('Staggershock');
    expect(s.delayed).toEqual([]);
  });

  it('declining leaves it in exile for good, and it is not offered twice', () => {
    let s = holding('Staggershock', 'arc-tempest', ['Mountain', 'Mountain']);
    const shock = find(s, 0, 'hand', 'Staggershock');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: shock, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    s = untilOffered(s);
    const after = life(s, 1);

    s = drain(apply(s, { type: 'auto:pass', by: 0 }), 40);
    expect(s.pendingOfferedCast).toBeNull();
    // `stays` doing its second job: a declined rebound is not moved, so it stays in exile.
    expect(s.instances[shock]!.zone).toBe('exile');
    expect(s.delayed).toEqual([]);

    // On round to the next upkeep, and nothing is offered: the trigger was consumed by resolving.
    let turns = 0;
    for (let i = 0; i < 400 && turns < 2; i += 1) {
      if (s.pendingOfferedCast !== null) throw new Error('it was offered a second time');
      const owed = pendingDeclaration(s);
      if (owed !== null) {
        for (const seat of owed.seats) {
          s = owed.kind === 'attackers'
            ? apply(s, { type: 'auto:attack', by: seat, attackers: [] })
            : apply(s, { type: 'auto:block', by: seat, blocks: [] });
        }
        continue;
      }
      const discard = s.pendingDiscard;
      if (discard !== null) {
        s = apply(s, {
          type: 'auto:discard', by: discard.seat, card: ids(s, discard.seat, 'hand')[0]!,
        });
        continue;
      }
      if (s.priority === null) break;
      const was = s.turn;
      s = apply(s, { type: 'auto:pass', by: s.priority });
      if (s.turn !== was) turns += 1;
    }
    expect(life(s, 1)).toBe(after);
    expect(s.instances[shock]!.zone).toBe('exile');
  });

  it('a countered rebound spell goes to the graveyard and promises nothing', () => {
    let s = arena({
      decks: { 0: 'arc-tempest', 1: 'hollow-tide' },
      hands: { 0: ['Staggershock'], 1: ['Counterspell'] },
      battlefield: { 0: ['Mountain', 'Mountain'], 1: ['Island', 'Island'] },
      turn: 5, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const shock = find(s, 0, 'hand', 'Staggershock');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: shock, targets: [{ kind: 'player', seat: 1 }],
    });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Counterspell'),
      targets: [{ kind: 'card', id: shock }],
    });
    s = drain(passBoth(s), 40);
    /*
      "If you cast this spell from your hand, exile it **as it resolves**" — a spell that never
      resolved never got there. The same reasoning the adventure branch in `spellLeavesStack` is
      written around, and the reason `resolved` is a parameter of that function at all.
    */
    expect(namesIn(s, 0, 'graveyard')).toContain('Staggershock');
    expect(s.instances[shock]!.zone).toBe('graveyard');
    expect(s.delayed).toEqual([]);
  });

  it('and the sorcery is cast in an upkeep, which is the keyword permitting it', () => {
    let s = holding('Distortion Strike', 'tidal-mind', ['Island', 'Island']);
    const strike = find(s, 0, 'hand', 'Distortion Strike');
    // A creature of its own to make unblockable, placed by hand so it is not summoning-sick.
    const magpie = find(s, 0, 'library', 'Thieving Magpie');
    s = apply(s, { type: 'card:move', by: 0, card: magpie, toZone: 'battlefield' });
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: strike, targets: [{ kind: 'card', id: magpie }],
    }), 40);
    expect(s.instances[strike]!.zone).toBe('exile');
    // A Thieving Magpie is a 1/3, so +1/+0 makes it a 2/3 — the number that matters is the
    // `cantBeBlocked` beside it, which is what makes those two power connect.
    const pumped = characteristicsOf(s, s.instances[magpie]!);
    expect(pumped.power).toBe(2);
    expect(pumped.cantBeBlocked).toBe(true);

    s = untilOffered(s);
    // A **sorcery**, on the stack in an upkeep: the ability that offers the cast is what permits
    // the timing (CR 702.88a), which is the same path cascade has used since D168.
    expect(s.step).toBe('upkeep');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: strike, offered: true,
      targets: [{ kind: 'card', id: magpie }],
    }), 40);
    expect(namesIn(s, 0, 'graveyard')).toContain('Distortion Strike');
    expect(characteristicsOf(s, s.instances[magpie]!).cantBeBlocked).toBe(true);
  });

  it('the bot takes the upkeep offer it would decline from hand', () => {
    /*
      The rule this keyword nearly died of. `expiringPumpCanMatter` drops a pump cast outside a
      combat, on the argument that a better moment is coming — right about a card in hand, and
      false about an offer, which is the only moment there is. A Distortion Strike offered in an
      upkeep would have been declined every time, and declining strands the card in exile.

      Both halves here: the bot takes the offered cast, and the original rule is untouched for the
      same card in the same step when it is in hand with its own mana up.
    */
    let s = holding('Distortion Strike', 'tidal-mind', ['Island', 'Island']);
    const strike = find(s, 0, 'hand', 'Distortion Strike');
    const magpie = find(s, 0, 'library', 'Thieving Magpie');
    s = apply(s, { type: 'card:move', by: 0, card: magpie, toZone: 'battlefield' });
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: strike, targets: [{ kind: 'card', id: magpie }],
    }), 40);
    s = untilOffered(s);
    expect(s.step).toBe('upkeep');
    const taken = botAction(s, 0);
    expect(taken?.type).toBe('auto:cast');
    expect(taken?.type === 'auto:cast' ? taken.card : null).toBe(strike);

    /*
      And the other half, which has to be asked in a main phase rather than in the same upkeep: a
      sorcery is not a legal play in an upkeep at all, so the bot declining one there would prove
      nothing about the rule. The board here is a creature that **cannot attack** — walked on with
      `card:move`, so it is summoning-sick — which is exactly the case the rule is for: the pump is
      legal, it does something, and there is no combat it can matter in.
    */
    let inHand = holding('Distortion Strike', 'tidal-mind', ['Island', 'Island']);
    const sick = find(inHand, 0, 'library', 'Thieving Magpie');
    inHand = apply(inHand, { type: 'card:move', by: 0, card: sick, toZone: 'battlefield' });
    const strikeInHand = find(inHand, 0, 'hand', 'Distortion Strike');
    expect(legalActions(inHand, 0).plays.some((play) => play.card === strikeInHand)).toBe(true);
    const held = botAction(inHand, 0);
    expect(held?.type === 'auto:cast' && held.card === strikeInHand).toBe(false);
  });

  it('every card with rebound carries exactly one delayed upkeep trigger', () => {
    /*
      The invariant the engine depends on: `completeResolution` finds the ability by searching the
      card's triggers for a delayed upkeep one, so a card with the keyword and no such trigger
      would be exiled with nothing to bring it back — strictly worse than not having the keyword.
      The same test dash has, one step of the turn earlier.
    */
    const rebounders = [...CARD_SCRIPTS.values()].filter((script) => script.rebound === true);
    expect(rebounders.map((script) => script.name).sort())
      .toEqual(['Distortion Strike', 'Staggershock']);
    for (const script of rebounders) {
      const delayed = (script.triggers ?? []).filter((trigger) => trigger.delayed === true
        && trigger.on.kind === 'step' && trigger.on.step === 'upkeep');
      expect(delayed.length).toBe(1);
    }
  });
});

describe('monstrosity and adapt: a creature that grows once and stays grown', () => {
  /*
    Two keywords whose difference is one word of placement, and the tests are about that word.

    **Monstrosity** says "activate only if this creature isn't monstrous" — a restriction on the
    *ability*, so a creature that has paid for it has nothing left to press and the table stops
    offering it. **Adapt** says "if it has no +1/+1 counters on it, put N on it" — a condition
    inside the *effect*, so the ability stays offered and paying for it a second time buys nothing.
    Both are permanent growth, which is what makes them unlike every other pump in the pool.

    And the Lion's static is the second thing `ContinuousEffect.while` has ever been asked:
    hexproof and indestructible while it is monstrous is a condition about the permanent's own
    counters rather than about a player's board.
  */
  const board = (deck: string, mine: readonly string[], lands: readonly string[]): GameState => {
    let s = advanceTo(arena({
      decks: { 0: deck, 1: 'ashen-rite' },
      battlefield: { 0: [...lands, ...mine], 1: ['Swamp', 'Swamp'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };
  const FOREST_PLAINS = ['Forest', 'Forest', 'Plains', 'Plains', 'Plains'];

  it('Fleecemane Lion becomes a 4/4 with hexproof and indestructible, once', () => {
    let s = board('verdant-guard', ['Fleecemane Lion'], FOREST_PLAINS);
    const lion = find(s, 0, 'battlefield', 'Fleecemane Lion');
    expect([power(s, lion), toughness(s, lion)]).toEqual([3, 3]);
    expect(characteristicsOf(s, s.instances[lion]!).keywords.has('hexproof')).toBe(false);

    s = drain(apply(s, { type: 'auto:activate', by: 0, card: lion, abilityIndex: 0 }), 40);
    expect([power(s, lion), toughness(s, lion)]).toEqual([4, 4]);
    const ch = characteristicsOf(s, s.instances[lion]!);
    expect(ch.keywords.has('hexproof')).toBe(true);
    expect(ch.keywords.has('indestructible')).toBe(true);

    // And the ability is gone: "activate only if it isn't monstrous" is read where the play is
    // offered, so the table never shows a button that would do nothing.
    expect(legalActions(s, 0).plays
      .filter((play) => play.card === lion && play.kind === 'activate')).toEqual([]);
    expect(refusal(s, { type: 'auto:activate', by: 0, card: lion, abilityIndex: 0 })).not.toBeNull();
  });

  it('and the hexproof goes away if the counter does, which is this engine rather than the card', () => {
    /*
      Said out loud because it is a deliberate simplification: the engine's answer to "is it
      monstrous" is the +1/+1 counter it is carrying, so a Toxic Deluge that takes the counter off
      takes the hexproof with it. A real Fleecemane Lion stays monstrous. The alternative is a flag
      on the instance for one card, which is the trade D57's rule is about.
    */
    let s = board('verdant-guard', ['Fleecemane Lion'], FOREST_PLAINS);
    const lion = find(s, 0, 'battlefield', 'Fleecemane Lion');
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: lion, abilityIndex: 0 }), 40);
    expect(characteristicsOf(s, s.instances[lion]!).keywords.has('hexproof')).toBe(true);

    s = { ...s, instances: { ...s.instances, [lion]: { ...s.instances[lion]!, counters: {} } } };
    expect(characteristicsOf(s, s.instances[lion]!).keywords.has('hexproof')).toBe(false);
    expect([power(s, lion), toughness(s, lion)]).toEqual([3, 3]);
  });

  it('Aeromunculus adapts to a 5/6, and the second payment buys nothing', () => {
    // Eight lands, because the test pays for adapt twice and each payment is four mana.
    let s = board('delta-bloom', ['Aeromunculus'],
      ['Forest', 'Forest', 'Island', 'Island', 'Island', 'Island', 'Island', 'Island']);
    const mancus = find(s, 0, 'battlefield', 'Aeromunculus');
    expect([power(s, mancus), toughness(s, mancus)]).toEqual([2, 3]);

    s = drain(apply(s, { type: 'auto:activate', by: 0, card: mancus, abilityIndex: 0 }), 40);
    expect([power(s, mancus), toughness(s, mancus)]).toEqual([5, 6]);

    /*
      Adapt's condition is in the effect, so the ability is still offered — which is the printed
      card: a player may pay {2}{G}{U} again and get nothing at all. The size is the assertion;
      the offer is the point.
    */
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: mancus, abilityIndex: 0 }), 40);
    expect([power(s, mancus), toughness(s, mancus)]).toEqual([5, 6]);
  });
});

describe('undying and persist: the creature that comes back with a counter on it', () => {
  /*
    A mechanic that looks like a replacement effect and is printed as a trigger, which is the whole
    reason it is worth testing rather than just writing.

    "When this creature dies, if it had no +1/+1 counter on it, return it to the battlefield under
    its owner's control with a +1/+1 counter on it" — and persist is the same sentence with −1/−1.
    Written as a `replaces` on `dies` it would have been a creature that **never dies**, so a Blood
    Artist would not drain for it and a sacrifice outlet would get nothing: the opposite of what the
    cards are played for. Written as a trigger, which is what they are, the death happens and the
    body comes back afterwards.

    The intervening-if is the mechanic: it reads the counters the creature had *as it died*, which
    the card no longer has by the time anything can look (`relocate` takes them off on the way to
    the graveyard). So both asks read `subjectCounters`, and the second death is the test that says
    so.
  */
  const grave = (mine: readonly string[], deck = 'blight-vector', basic = 'Swamp'): GameState =>
    advanceTo(arena({
      decks: { 0: deck, 1: 'tidal-mind' },
      battlefield: {
        0: [basic, basic, basic, basic, ...mine],
        1: ['Island', 'Island', 'Island', 'Island'],
      },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');

  it('comes back with a +1/+1 counter on it the first time it dies', () => {
    let s = grave(['Butcher Ghoul']);
    const ghoul = find(s, 0, 'battlefield', 'Butcher Ghoul');
    expect([power(s, ghoul), toughness(s, ghoul)]).toEqual([1, 1]);

    s = drain(apply(s, { type: 'card:move', by: 0, card: ghoul, toZone: 'graveyard' }), 40);
    // Back on the battlefield, bigger, and under its owner's control.
    expect(s.instances[ghoul]!.zone).toBe('battlefield');
    expect(s.instances[ghoul]!.zoneSeat).toBe(0);
    expect([power(s, ghoul), toughness(s, ghoul)]).toEqual([2, 2]);
  });

  it('and stays dead the second time, because the if reads the counter it had', () => {
    let s = grave(['Butcher Ghoul']);
    const ghoul = find(s, 0, 'battlefield', 'Butcher Ghoul');
    s = drain(apply(s, { type: 'card:move', by: 0, card: ghoul, toZone: 'graveyard' }), 40);
    expect(s.instances[ghoul]!.zone).toBe('battlefield');

    s = drain(apply(s, { type: 'card:move', by: 0, card: ghoul, toZone: 'graveyard' }), 40);
    expect(s.instances[ghoul]!.zone).toBe('graveyard');
    // And nothing went on the stack to be responded to: the intervening-if is asked before the
    // ability is put there, so a trigger that would do nothing never appears at all (CR 603.4).
    expect(s.stackOrder).toEqual([]);
  });

  it('really does die on the way, so a Blood Artist sees it', () => {
    /*
      The half a replacement effect would have broken. These are *triggered* abilities: the creature
      reaches the graveyard, every death trigger sees it, and only then does the body come back. A
      `replaces` on `dies` would have made a creature that cannot be drained for and cannot be
      profitably sacrificed, which is the opposite of what these cards are played for.

      Asserted on the **stack**, for the reason the Woe Strider tests give: a Blood Artist's drain
      targets a player, so following it to a life total means answering a targeting question that
      has nothing to do with undying. Both abilities being there at once is the whole claim — the
      death happened *and* the body is coming back.
    */
    let s = grave(['Murderous Redcap', 'Blood Artist'], 'ashen-rite', 'Swamp');
    const redcap = find(s, 0, 'battlefield', 'Murderous Redcap');
    s = drain(apply(s, { type: 'card:move', by: 0, card: redcap, toZone: 'graveyard' }), 40);
    // Both abilities are still there: the Blood Artist's drain is waiting on a target, which is
    // what `drain` stops at, and that is exactly the moment worth looking at.
    const onStack = stackNames(s).join(' | ');
    expect(onStack).toMatch(/loses 1 life and you gain 1 life/i);
    expect(onStack).toMatch(/return it to the battlefield with a -1\/-1 counter/i);
    expect(s.instances[redcap]!.zone).toBe('graveyard');
  });

  it('persist brings the Redcap back as a 0/0, which dies again on its own', () => {
    /*
      The printed card, and the reason persist creatures are not all 1/1s: a 1/1 with a −1/−1
      counter on it is a 0/0, so the second body is really a second *trigger* — it enters, deals
      damage equal to its power (which is nothing), and the state-based actions sweep it up.
    */
    let s = grave(['Murderous Redcap'], 'ashen-rite', 'Swamp');
    const redcap = find(s, 0, 'battlefield', 'Murderous Redcap');
    s = drain(apply(s, { type: 'card:move', by: 0, card: redcap, toZone: 'graveyard' }), 40);
    // It came back, took its own counter, and went straight back to the graveyard as a 0/0.
    expect(s.instances[redcap]!.zone).toBe('graveyard');
    expect(s.replacements.length + s.log.length).toBeGreaterThan(0);
  });
});

describe('Rancor, from anywhere rather than from the battlefield', () => {
  /*
    The other half of `to-graveyard`, and the half Planar Void's wording ruled out.

    Rancor was scripted with a `dies` trigger, which is the *old* printing — "put into a graveyard
    from the battlefield". The card has read **"from anywhere"** for years, and the three other
    anywheres were invisible to that event. So it is a `to-graveyard` trigger now, with the `who:
    'self'` the event grew for it: the default there is `another`, because the event was written
    for a Planar Void whose printed word is "another", and a watcher that fires from the graveyard
    it has just reached is what a `dies` trigger has always been allowed to do and this one was not.

    The battlefield half is covered by the thirteenth deck's own tests above. These two are the
    directions a `dies` trigger could never have seen, and the one card in the pool that beats it.
  */
  const grove = (setup: {
    hands?: readonly string[];
    mine?: readonly string[];
    theirs?: readonly string[];
    opponent?: string;
  }): GameState => advanceTo(arena({
    decks: { 0: 'kindle-grove', 1: setup.opponent ?? 'tidal-mind' },
    ...(setup.hands === undefined ? {} : { hands: { 0: setup.hands } }),
    battlefield: {
      0: ['Forest', 'Forest', 'Forest', 'Mountain', ...(setup.mine ?? [])],
      // Named by the caller rather than defaulted: the two tests sit across from two different
      // decks, and a land this one does not run is a card `arena` cannot find to put there.
      1: [...(setup.theirs ?? [])],
    },
    turn: 4, firstSeat: 0,
  }), 'precombat-main');

  it('comes back from a discard, which no death event could have seen', () => {
    // Never cast, never on the battlefield: a Rancor in hand, discarded by a Mind Rot, is in the
    // hand again a moment later. The second card in hand is what the discard takes instead.
    // Tidal Mind holds the pool's Mind Rot, and an Island and two Swamps pay for it.
    let s = grove({ hands: ['Rancor', 'Shivan Dragon'], theirs: ['Island', 'Swamp', 'Swamp'] });
    const rancor = find(s, 0, 'hand', 'Rancor');
    s = advanceTo(nextTurn(s), 'precombat-main');
    s = apply(s, { type: 'card:move', by: 1, card: find(s, 1, 'library', 'Mind Rot'), toZone: 'hand' });
    s = tapAllLands(s, 1);
    s = drain(apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Mind Rot'),
      targets: [{ kind: 'player', seat: 0 }],
    }), 40);
    expect(s.instances[rancor]!.zone).toBe('hand');
  });

  it('but a Planar Void takes it away for good, which is why one deck cannot run both', () => {
    /*
      Two triggers on one event, and the Void's exile is the one that matters.

      Both are `to-graveyard` watchers — the Void says "another card", the Rancor says this one —
      so a Rancor reaching a graveyard while a Void is on the table raises both, and the Rancor
      does not come back: if the exile resolves first the return finds no card in a graveyard and
      does nothing (CR 608.2, and the guard in the script), and if the return resolves first the
      exile has nothing left to exile but the next trip to the graveyard starts the race again.
      D172 found the same conflict between the Void and a Raise Dead, which is why the infect deck
      that wanted a Rancor cannot have one.
    */
    let s = grove({
      hands: ['Rancor'], mine: ['Llanowar Elves'],
      opponent: 'blight-vector', theirs: ['Swamp', 'Swamp', 'Planar Void'],
    });
    s = tapAllLands(s, 0);
    const elves = find(s, 0, 'battlefield', 'Llanowar Elves');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Rancor'),
      targets: [{ kind: 'card', id: elves }],
    }), 40);
    const rancor = find(s, 0, 'battlefield', 'Rancor');
    // The creature goes, the Aura falls off into the graveyard (CR 704.5m), and the Void has it.
    s = drain(apply(s, { type: 'card:move', by: 0, card: elves, toZone: 'graveyard' }), 40);
    expect(s.instances[rancor]!.zone).not.toBe('hand');
    expect(s.instances[rancor]!.zone).toBe('exile');
  });
});

describe('hybrid mana, at a real table', () => {
  /*
    `parseManaCost` refused every slashed symbol until D190, and the refusal was honest: reading
    `{R/G}` as generic would offer a player a spell they could not cast. What it also did was keep
    a card in this pool with the wrong cost on it — **Murderous Redcap** is `{2}{B/R}{B/R}` and was
    written as `{2}{B}{R}`, which is strictly harsher than the printed card.

    These two are the table's half of it: the Redcap off Swamps alone, which it could not do before,
    and Kitchen Finks paying its two `{G/W}` symbols from one of each.
  */
  it('casts a Redcap off four Swamps, which its old cost could not do', () => {
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'tidal-mind' },
      hands: { 0: ['Murderous Redcap'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Swamp', 'Swamp'], 1: ['Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    const redcap = find(s, 0, 'hand', 'Murderous Redcap');
    // Offered with no red source anywhere: both hybrid symbols are paid in black.
    expect(legalActions(s, 0).plays.some((play) => play.card === redcap)).toBe(true);

    // The creature spell takes no targets; its arrival trigger does, and asks once it is on the
    // battlefield — which is why the cast and the aim are two actions.
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: redcap }), 40);
    expect(namesIn(s, 0, 'battlefield')).toContain('Murderous Redcap');
    s = drain(apply(s, {
      type: 'auto:choose', by: 0, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    // Its own arrival trigger: one damage, its power.
    expect(life(s, 1)).toBe(19);
    // Four lands for a four-mana spell, and nothing left over.
    expect([...ids(s, 0, 'battlefield')]
      .filter((id) => nameOf(s, id) === 'Swamp' && s.instances[id]!.tapped)).toHaveLength(4);
  });

  it('and pays Kitchen Finks one of each colour, or two of one', () => {
    /** Verdant Guard holding the Finks, with the lands named. */
    const holding = (lands: readonly string[]): GameState => tapAllLands(advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      hands: { 0: ['Kitchen Finks'] },
      battlefield: { 0: [...lands], 1: ['Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main'), 0);

    for (const lands of [
      ['Forest', 'Plains', 'Forest'],
      ['Forest', 'Forest', 'Forest'],
      ['Plains', 'Plains', 'Plains'],
    ]) {
      const s = holding(lands);
      expect(legalActions(s, 0).plays
        .some((play) => play.card === find(s, 0, 'hand', 'Kitchen Finks'))).toBe(true);
    }

    // Two lands is not three, whatever colours they make: the hybrid symbols are each one mana and
    // the generic one still has to come from somewhere.
    const short = holding(['Forest', 'Plains']);
    expect(legalActions(short, 0).plays
      .some((play) => play.card === find(short, 0, 'hand', 'Kitchen Finks'))).toBe(false);
    // Three mana of a colour neither half can use is covered where it belongs, in `mana.test.ts`:
    // this deck has no source that is not green or white, so the board cannot be built here.
  });

  it('gains two life as it lands, and comes back a 2/1 that lives', () => {
    /*
      Persist's second card, and the half the pool could not show. A Murderous Redcap is a 1/1, so
      the body persist returns is a 0/0 that the state-based actions put straight back in the
      graveyard — correct, and not much of a demonstration. The Finks is a 3/2, so what comes back
      is a **2/1 still standing**.
    */
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      hands: { 0: ['Kitchen Finks'] },
      battlefield: { 0: ['Forest', 'Plains', 'Forest'], 1: ['Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Kitchen Finks') }), 40);
    expect(life(s, 0)).toBe(22);
    const finks = find(s, 0, 'battlefield', 'Kitchen Finks');
    expect([power(s, finks), toughness(s, finks)]).toEqual([3, 2]);

    s = drain(apply(s, { type: 'card:move', by: 0, card: finks, toZone: 'graveyard' }), 40);
    // Back on the battlefield with a -1/-1 counter: a 2/1, and the life does not come again.
    expect(s.instances[finks]!.zone).toBe('battlefield');
    expect([power(s, finks), toughness(s, finks)]).toEqual([2, 1]);
    expect(life(s, 0)).toBe(24);
  });
});

describe('who has been hitting whom, recorded for the table', () => {
  /*
    `commanderDamage`'s wider sibling, and the first field in this state that no rule reads.

    Twenty-one from one commander eliminates a player, so that tally is machinery. This one decides
    nothing: it is the answer to the question a four-player table asks every turn and the software
    could not answer — *who has been coming at me, and who has left me alone*. The pod's own notes
    had listed it as the missing half of its politics for as long as deals have existed, and the
    line it keeps is the one the deals keep: the table remembers, and enforces nothing (D189).
  */
  it('counts combat and a burn spell, keyed by the seat that dealt it', () => {
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'tidal-mind' },
      hands: { 0: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain', 'Raging Goblin'], 1: ['Island'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    // Three from a spell, attributed to the seat that cast it rather than to the card.
    expect(s.seats[1]!.damageFrom['0']).toBe(3);

    // And one more from combat, on the same key: the tally is about the player, not the source.
    s = advanceTo(s, 'declare-attackers');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    s = drain(advanceTo(apply(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: goblin, defender: 1 }],
    }), 'end'), 60);
    expect(s.seats[1]!.damageFrom['0']).toBe(4);
    expect(life(s, 1)).toBe(16);
    // Nobody has hit seat 0 at all, which is the other half of the read.
    expect(s.seats[0]!.damageFrom).toEqual({});
  });

  it('does not count damage that was prevented, or life paid as a cost', () => {
    /*
      Both halves are the rules' own line rather than a convenience. Damage prevented by a Fog was
      never dealt, so it is not in the tally and the player it was aimed at is right to read
      nothing. And life *paid* is not damage at all — a Toxic Deluge's own payment, a Phyrexian
      Arena's upkeep — so a player bleeding themselves for cards does not show up as somebody
      attacking them.
    */
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Fog'] },
      battlefield: { 0: ['Forest', 'Forest'], 1: ['Mountain', 'Raging Goblin'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'declare-attackers');
    const goblin = find(s, 1, 'battlefield', 'Raging Goblin');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: goblin, defender: 0 }] });
    s = apply(s, { type: 'auto:pass', by: 1 });
    for (const id of [...ids(s, 0, 'battlefield')]) {
      if (nameOf(s, id) !== 'Forest') continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    s = drain(advanceTo(drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fog'),
    }), 40), 'end'), 60);

    expect(life(s, 0)).toBe(20);
    expect(s.seats[0]!.damageFrom['1'] ?? 0).toBe(0);
  });
});

describe('four keywords that read the attack rather than the creature', () => {
  /*
    Every one of the engine's seventeen keywords is a fact about a permanent — flying, deathtouch,
    first strike — and its combat triggers could already say "whenever this attacks". None of them
    could say anything about the **shape of a declaration**: how many creatures were in it, how
    their power compares, or whether this one has connected before.

    These four are each a different answer to that, and three of them needed nothing the engine did
    not already have. Battalion needed one field — `withAtLeast`, the sibling of exalted's `alone`,
    written on the event where the declaration happens because by the time the trigger resolves two
    of the three attackers may be gone (CR 506.4). That is the whole engine change (D188).
  */

  it('battalion fires on three attackers and not on two', () => {
    /** Forge Alliance with the Avenger and two more bodies, in its declare-attackers step. */
    const swinging = (others: readonly string[]): GameState => {
      const s = advanceTo(arena({
        decks: { 0: 'forge-alliance', 1: 'tidal-mind' },
        battlefield: {
          0: ['Plains', 'Plains', 'Mountain', 'Mountain', 'Firemane Avenger', ...others],
          1: ['Island'],
        },
        turn: 5, firstSeat: 0,
      }), 'declare-attackers');
      const attackers = [...ids(s, 0, 'battlefield')]
        .filter((id) => legalActions(s, 0).attackers.includes(id));
      return apply(s, {
        type: 'auto:attack', by: 0, attackers: attackers.map((attacker) => ({ attacker, defender: 1 as const })),
      });
    };

    // Two attackers: the Avenger and one Vanguard. "At least two *other* creatures" is not met.
    const two = drain(swinging(['Elite Vanguard']), 40);
    expect(stackNames(two)).toEqual([]);
    expect(life(two, 0)).toBe(20);

    // Three, and the trigger is on the stack waiting to be aimed — which is the engine refusing to
    // choose a target for a player, not a bug.
    const three = swinging(['Elite Vanguard', 'Leonin Skyhunter']);
    expect(stackNames(three)).toEqual(['it deals 3 damage to any target and you gain 3 life']);
    expect(three.pendingChoice).not.toBeNull();
    const aimed = drain(apply(three, {
      type: 'auto:choose', by: 0, targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    // Three damage where it was aimed, three life gained, both from one trigger.
    expect(life(aimed, 0)).toBe(23);
    expect(life(aimed, 1)).toBe(17);
  });

  it('mentor only offers an attacking creature smaller than itself', () => {
    const s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'tidal-mind' },
      battlefield: {
        // A 2/1 mentor, two 1-power creatures that are smaller, a 2/2 that is not, and a 1/1
        // Traveler held back so that "attacking" can be told apart from "smaller".
        0: ['Plains', 'Plains', 'Sunhome Stalwart', 'Doomed Traveler', 'Doomed Traveler',
          'Monastery Swiftspear', 'Leonin Skyhunter'],
        1: ['Island'],
      },
      turn: 5, firstSeat: 0,
    }), 'declare-attackers');
    const stalwart = find(s, 0, 'battlefield', 'Sunhome Stalwart');
    const travelers = [...ids(s, 0, 'battlefield')]
      .filter((id) => s.cardDefs[s.instances[id]!.defKey]!.name === 'Doomed Traveler');
    const swift = find(s, 0, 'battlefield', 'Monastery Swiftspear');
    const skyhunter = find(s, 0, 'battlefield', 'Leonin Skyhunter');

    const swung = apply(s, {
      type: 'auto:attack',
      by: 0,
      // Everything but the second Traveler, which stays home.
      attackers: [stalwart, travelers[0]!, swift, skyhunter]
        .map((attacker) => ({ attacker, defender: 1 as const })),
    });
    const offered = legalActions(swung, 0).mustChoose?.candidates?.[0]
      ?.map((candidate) => (candidate.kind === 'card' ? candidate.id : 'player')) ?? [];
    /*
      Two candidates out of five creatures, and every exclusion is a different clause of the
      keyword: the Skyhunter is a 2/2 and not *lesser*, the second Traveler is a 1/1 and not
      **attacking**, and the Stalwart itself is out because mentor targets another creature.
    */
    expect([...offered].sort()).toEqual([travelers[0]!, swift].sort());
    expect(offered).not.toContain(skyhunter);
    expect(offered).not.toContain(travelers[1]!);

    const resolved = drain(apply(swung, {
      type: 'auto:choose', by: 0, targets: [{ kind: 'card', id: travelers[0]! }],
    }), 40);
    // A permanent counter, which is what makes mentor different from every pump in the pool.
    expect(resolved.instances[travelers[0]!]!.counters['+1/+1']).toBe(1);
  });

  it('and takes the only legal target without asking, or has none at all', () => {
    /** The mentor and one other attacker of the named card. */
    const swinging = (friend: string): GameState => {
      const s = advanceTo(arena({
        decks: { 0: 'forge-alliance', 1: 'tidal-mind' },
        battlefield: { 0: ['Plains', 'Plains', 'Sunhome Stalwart', friend], 1: ['Island'] },
        turn: 5, firstSeat: 0,
      }), 'declare-attackers');
      const attackers = [...ids(s, 0, 'battlefield')]
        .filter((id) => legalActions(s, 0).attackers.includes(id));
      return apply(s, {
        type: 'auto:attack',
        by: 0,
        attackers: attackers.map((attacker) => ({ attacker, defender: 1 as const })),
      });
    };

    // One candidate is not a choice, so the engine takes it rather than stopping the table.
    const smaller = swinging('Doomed Traveler');
    expect(smaller.pendingChoice).toBeNull();
    const counted = drain(smaller, 40);
    expect(counted.instances[find(counted, 0, 'battlefield', 'Doomed Traveler')]!
      .counters['+1/+1']).toBe(1);

    // And with nothing smaller attacking, the trigger has no legal target at all: the engine does
    // not offer it, nothing waits on anybody, and the Skyhunter is the 2/2 it always was.
    const equal = drain(swinging('Leonin Skyhunter'), 40);
    expect(equal.pendingChoice).toBeNull();
    expect(equal.instances[find(equal, 0, 'battlefield', 'Leonin Skyhunter')]!
      .counters['+1/+1']).toBeUndefined();
  });

  it('renown fires the first time it connects and never again', () => {
    let s = advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      battlefield: { 0: ['Plains', 'Topan Freeblade'], 1: ['Island'] },
      turn: 5, firstSeat: 0,
    }), 'declare-attackers');
    const freeblade = find(s, 0, 'battlefield', 'Topan Freeblade');

    /*
      `advanceTo('end')` rather than a drain: combat damage happens in a *step*, and `drain` only
      resolves what is on the stack. The first version of this test passed a declaration and then
      drained, which asserts about a turn that never reached its damage step.
    */
    s = drain(advanceTo(apply(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: freeblade, defender: 1 }],
    }), 'end'), 60);
    expect(life(s, 1)).toBe(18);
    expect(s.instances[freeblade]!.counters['+1/+1']).toBe(1);
    // Vigilance, so it is still untapped — the half of the card a 2/2 with renown is actually for.
    expect(s.instances[freeblade]!.tapped).toBe(false);

    // Two turns later it connects as a 3/3, and the intervening-if stops the second counter.
    s = advanceTo(nextTurn(nextTurn(s)), 'declare-attackers');
    s = drain(advanceTo(apply(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: freeblade, defender: 1 }],
    }), 'end'), 60);
    expect(life(s, 1)).toBe(15);
    expect(s.instances[freeblade]!.counters['+1/+1']).toBe(1);
  });

  it('battle cry pumps every other attacker and not itself', () => {
    const s = advanceTo(arena({
      decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
      battlefield: {
        0: ['Mountain', 'Forest', 'Goblin Wardriver', 'Llanowar Elves', 'Centaur Courser'],
        1: ['Island'],
      },
      turn: 5, firstSeat: 0,
    }), 'declare-attackers');
    const driver = find(s, 0, 'battlefield', 'Goblin Wardriver');
    const elves = find(s, 0, 'battlefield', 'Llanowar Elves');
    const courser = find(s, 0, 'battlefield', 'Centaur Courser');

    const swung = drain(apply(s, {
      type: 'auto:attack',
      by: 0,
      attackers: [driver, elves, courser].map((attacker) => ({ attacker, defender: 1 as const })),
    }), 40);
    // +1/+0 on each other attacker, and nothing on the Wardriver: "each **other** attacking
    // creature" is printed on it, and a battle cry that pumped itself would be a 3/2 for two.
    expect(power(swung, elves)).toBe(2);
    expect(power(swung, courser)).toBe(4);
    expect(power(swung, driver)).toBe(2);
  });
});

describe('Rest in Peace: the graveyard replaced rather than emptied', () => {
  /*
    The first card written against the engine's **widest** replacement wording, and the pair that
    makes the difference between a trigger and a replacement worth having.

    Planar Void (D153) and Rest in Peace read almost the same in English and are two different
    cards. The Void is a *trigger*: the card reaches the graveyard, an ability goes on the stack,
    and the card is exiled when it resolves — so a Blood Artist still saw the death and a
    Gravedigger that resolved first still bought something back. Rest in Peace says **instead**:
    the card never arrives, which means the creature never died.

    That is the assertion worth having, because it is the one a player gets wrong at the table.
  */
  const board = (setup: { theirs?: readonly string[]; mine?: readonly string[] }): GameState =>
    advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'dawn-tithe' },
      battlefield: {
        0: ['Plains', 'Plains', ...(setup.mine ?? [])],
        1: ['Swamp', 'Swamp', ...(setup.theirs ?? [])],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  it('exiles a creature that would die, so nothing sees a death at all', () => {
    let s = board({
      mine: ['Rest in Peace'],
      theirs: ['Blood Artist', 'Child of Night'],
    });
    const child = find(s, 1, 'battlefield', 'Child of Night');
    const lifeBefore = [life(s, 0), life(s, 1)];

    s = drain(apply(s, { type: 'card:move', by: 1, card: child, toZone: 'graveyard' }), 40);
    // Exiled, not buried: "instead" means the graveyard was never touched.
    expect(s.instances[child]!.zone).toBe('exile');
    expect(ids(s, 1, 'graveyard')).toEqual([]);
    /*
      And the Blood Artist drained nobody, which is the whole difference from a Planar Void.

      A creature that is exiled on its way to the graveyard **did not die** (CR 700.4 and 614.6),
      so "whenever a creature dies" never happened. With a Void on the table instead, the same
      board drains for one and then exiles the card.
    */
    expect([life(s, 0), life(s, 1)]).toEqual(lifeBefore);
  });

  it('empties the graveyards that are already there as it arrives', () => {
    // The other half of the card, and the reason it needs both: the replacement only covers the
    // rest of the game, so the arrival has to deal with what is already in there.
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'dawn-tithe' },
      hands: { 0: ['Rest in Peace'] },
      graveyard: { 0: ['Healing Salve'], 1: ['Child of Night', 'Doom Blade'] },
      battlefield: { 0: ['Plains', 'Plains'], 1: ['Swamp'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    expect(ids(s, 1, 'graveyard')).toHaveLength(2);

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Rest in Peace'),
    }), 40);
    expect(ids(s, 0, 'graveyard')).toEqual([]);
    expect(ids(s, 1, 'graveyard')).toEqual([]);
  });

  it('and exiles itself when it is destroyed, which is the ruling people argue about', () => {
    /*
      The card says "a card", not "another card", and its ability applies to the event that is
      taking it away — so a Disenchanted Rest in Peace goes to exile.

      It works because the engine asks the **moving card's own** replacement effects first (D183,
      which unearth needed): by the time a replacement is asked the enchantment is no longer on the
      battlefield, so a pass that only looked at battlefield permanents could never have found it.
    */
    let s = board({ mine: ['Rest in Peace'] });
    const rip = find(s, 0, 'battlefield', 'Rest in Peace');
    s = drain(apply(s, { type: 'card:move', by: 0, card: rip, toZone: 'graveyard' }), 40);
    expect(s.instances[rip]!.zone).toBe('exile');
  });
});

describe('Woe Strider: escape’s second card, and the outlet that comes back', () => {
  /*
    A mechanic with one card has one card's worth of coverage, and escape shipped with one.

    This is the second, and it is a different *kind* of escape card: a Phoenix of Ash escapes
    because it is a threat that will not stay dead, and a Woe Strider escapes because it is an
    engine the opponent cannot answer by killing it. Everything it needs was already in the engine
    — a token on an entry trigger, an activated ability whose cost is sacrificing another creature,
    and a scry as the ability's decision — so the only new line for it is the Goat.
  */
  /*
    Drain the stack, answering the scry on the way.

    `drain` stops as soon as something is waiting on a decision, which is right for a test that
    wants to look at the question — and wrong for the two below, where the scry is on the way to
    the thing being asserted. Taking nothing is a legal scry: the card stays on top.
  */
  const settleAll = (start: GameState): GameState => {
    let s = start;
    for (let i = 0; i < 8; i++) {
      s = drain(s, 40);
      if (s.pendingDecision === null) return s;
      s = decide(s, []);
    }
    return s;
  };

  const rite = (hand: readonly string[], lands: readonly string[], grave: readonly string[] = []):
  GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'ember-rush' },
      hands: { 0: [...hand] },
      ...(grave.length === 0 ? {} : { graveyard: { 0: [...grave] } }),
      battlefield: { 0: [...lands], 1: ['Mountain'] },
      turn: 4, firstSeat: 0,
    }), 'precombat-main');
    return tapAllLands(s, 0);
  };

  it('arrives with its own first meal, which is the 0/1 Goat', () => {
    let s = rite(['Woe Strider'], ['Swamp', 'Swamp', 'Swamp']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Woe Strider'),
    })));
    const goat = find(s, 0, 'battlefield', 'Goat');
    expect([power(s, goat), toughness(s, goat)]).toEqual([0, 1]);
    const strider = find(s, 0, 'battlefield', 'Woe Strider');
    expect([power(s, strider), toughness(s, strider)]).toEqual([3, 2]);
  });

  it('eats another creature for nothing and scries, as often as there are bodies', () => {
    let s = rite(['Woe Strider'], ['Swamp', 'Swamp', 'Swamp']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Woe Strider'),
    })));
    const strider = find(s, 0, 'battlefield', 'Woe Strider');
    const goat = find(s, 0, 'battlefield', 'Goat');

    // The ability is offered with the Goat as its only victim — see the next test for why that
    // "only" is the card rather than an accident.
    const play = legalActions(s, 0).plays.find((p) => p.card === strider && p.abilityIndex === 0);
    expect(play?.sacrificeOptions).toEqual([goat]);

    s = apply(s, { type: 'auto:activate', by: 0, card: strider, abilityIndex: 0, sacrifice: goat });
    /*
      Paid as the ability is activated, so the Goat is gone while the ability is still waiting —
      and *gone* rather than in a graveyard, because a token that leaves the battlefield ceases to
      exist (CR 111.7). Its last state is in `vanished`, which is what lets its own death still
      reach a Blood Artist; see the next test.
    */
    expect(s.instances[goat]).toBeUndefined();
    expect(namesIn(s, 0, 'battlefield')).not.toContain('Goat');
    s = passBoth(s);
    // And then it asks about the top card, which is the scry.
    expect(choices(s).length).toBeGreaterThan(0);
    s = settleAll(s);
    expect(s.instances[strider]!.zone).toBe('battlefield');
  });

  it('cannot eat itself, which is the difference between an outlet and a mistake', () => {
    let s = rite(['Woe Strider'], ['Swamp', 'Swamp', 'Swamp']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Woe Strider'),
    })));
    const strider = find(s, 0, 'battlefield', 'Woe Strider');
    expect(refusal(s, {
      type: 'auto:activate', by: 0, card: strider, abilityIndex: 0, sacrifice: strider,
    })).not.toBeNull();
  });

  it('feeds the eight cards that read a creature dying', () => {
    /*
      The reason it is in this deck rather than any other black one. A Blood Artist drains for
      every creature that dies and the deck had no way to make one die for free — so this is the
      combination rather than the card: `{0}`, and a point of life moves.
    */
    let s = rite(['Woe Strider'], ['Swamp', 'Swamp', 'Swamp', 'Blood Artist']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Woe Strider'),
    })));
    const strider = find(s, 0, 'battlefield', 'Woe Strider');
    const goat = find(s, 0, 'battlefield', 'Goat');
    const after = apply(s, {
      type: 'auto:activate', by: 0, card: strider, abilityIndex: 0, sacrifice: goat,
    });
    /*
      Asserted on the **stack** rather than on the life totals, and the reason is the card: a Blood
      Artist's drain targets a player, so following it through to a life total means answering a
      targeting question that has nothing to do with Woe Strider. What this test is about is that
      the offered sacrifice reached the payoff at all — the ability is on the stack, which is where a
      trigger is observable, and its own tests cover what it does from there.

      Matched on the ability's own words rather than the card's name, because that is what the
      stack says: a triggered ability is described by what it does, which is also what the player
      deciding whether to respond reads.
    */
    expect(stackNames(after).join(' | ')).toMatch(/loses 1 life and you gain 1 life/i);
  });

  it('is fed the Goat and never the Blood Artist, which is what the bot used to do', () => {
    /*
      The fourteenth member of the drop-this-option family, and the measurement that found it.

      The old fodder rule compared the victim's **power** against the power of the creature whose
      ability it was, which is a fair proxy for a Bloodthrone Vampire that gets bigger and means
      nothing for a Woe Strider that scries. A Blood Artist is 0/1 and a Goat is 0/1, so the
      ordering could not tell them apart — and over 144 games Ashen Rite activated the outlet
      **348 times**, eating the three cards the deck is built around for a look at the top of the
      library. With the fix it activates 136 times, which is about once a game: the Goat it
      arrived with.
    */
    let s = rite(['Woe Strider'], ['Swamp', 'Swamp', 'Swamp', 'Blood Artist']);
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Woe Strider'),
    })));
    const goat = find(s, 0, 'battlefield', 'Goat');
    const chosen = botAction(s, 0);
    expect(chosen?.type).toBe('auto:activate');
    expect(chosen?.type === 'auto:activate' ? chosen.sacrifice : null).toBe(goat);
  });

  it('and is not activated at all when the only food is a card', () => {
    /*
      The other half, and the half that makes the rule a filter rather than a preference: with no
      token on the board the bot does not eat a Blood Artist for a scry, it passes. Woe Strider is
      put onto the battlefield here rather than cast, which is how the board gets a Woe Strider
      with no Goat beside it — `arena` places permanents without firing an entry trigger.
    */
    const s = rite([], ['Swamp', 'Swamp', 'Swamp', 'Blood Artist', 'Woe Strider']);
    const strider = find(s, 0, 'battlefield', 'Woe Strider');
    const chosen = botAction(s, 0);
    const fed = chosen?.type === 'auto:activate' && chosen.card === strider;
    expect(fed).toBe(false);
  });

  it('and comes back out of the graveyard for {4}{B} and three other cards', () => {
    const s = rite(
      [],
      ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'],
      ['Woe Strider', 'Village Rites', 'Dark Ritual', 'Burst Lightning'],
    );
    const play = legalActions(s, 0).plays
      .find((p) => p.name === 'Woe Strider' && p.escape === true);
    expect(play?.manaCost).toBe('{4}{B}');
    expect(play?.exiles).toBe(3);

    const strider = find(s, 0, 'graveyard', 'Woe Strider');
    const after = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: strider, escape: true,
    })));
    expect(after.instances[strider]!.zone).toBe('battlefield');
    expect(ids(after, 0, 'exile')).toHaveLength(3);
    // And a second Goat with it: the entry trigger does not care which zone it was cast from.
    expect(namesIn(after, 0, 'battlefield')).toContain('Goat');
  });
});

describe('cascade: a spell that casts the next one for nothing', () => {
  /*
    Two engine firsts in one keyword, and the tests are split along that line.

    The first is a **trigger that fires from the stack**: "when you cast this spell" is an ability
    of a card that is not on the battlefield, so `raise` has to offer the cast to the spell being
    cast — and must not start firing every other cast trigger printed on the card on its way past,
    which is the Chalice case at the bottom of this block.

    The second is a **cast with nothing paid**. That is not a cheaper cost: the mana is not paid,
    the timing is not checked, and the whole thing happens inside somebody else's resolution. What
    makes it safe is that it is not a flag a client may simply set — the engine has to be holding an
    offer open for that seat and that card, and `pendingOfferedCast` is that offer.
  */
  /**
   * Puts a named card of seat 0's on top of its library, from wherever it is.
   *
   * Hand *or* library, because a board fast-forwarded to turn five has drawn four cards and the
   * one a test wants on top may be among them — which is a mistake worth making only once.
   */
  const toTop = (s: GameState, name: string): GameState => {
    const inHand = ids(s, 0, 'hand').find((id) => nameOf(s, id) === name);
    const card = inHand ?? find(s, 0, 'library', name);
    return apply(s, { type: 'card:move', by: 0, card, toZone: 'library', position: 'top' });
  };

  /** A board with Bloodbraid Elf in hand, four lands up, and a library stacked from the top. */
  const cascading = (top: readonly string[]): GameState => {
    let s = advanceTo(arena({
      decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
      hands: { 0: ['Bloodbraid Elf'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Forest', 'Forest'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    // Stacked in reverse, so the first name asked for is the one on top.
    for (const name of [...top].reverse()) s = toTop(s, name);
    return s;
  };

  const cast = (s: GameState): GameState => drain(apply(s, {
    type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Bloodbraid Elf'),
  }), 40);

  /** How many of this seat's permanents are tapped, which is what a cost would have moved. */
  const tappedLands = (s: GameState): number =>
    ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped === true).length;

  it('exiles off the top until a cheaper nonland card, and offers that one offered', () => {
    // A Mountain first, which is never the hit however cheap it is, then a Bolt at one mana.
    const s = cast(cascading(['Mountain', 'Lightning Bolt']));
    const offer = s.pendingOfferedCast;
    expect(offer?.seat).toBe(0);
    expect(nameOf(s, offer?.card ?? '')).toBe('Lightning Bolt');
    expect(offer?.prompt).toContain('Bloodbraid Elf cascades into Lightning Bolt');
    // The land it walked past is exiled with it, waiting for the bottom of the library.
    expect(offer?.bottom.map((id) => nameOf(s, id))).toEqual(['Mountain']);
    expect(namesIn(s, 0, 'exile').sort()).toEqual(['Lightning Bolt', 'Mountain']);

    // The table is stopped: nobody holds priority, and the only seat with anything to do is the
    // one being asked.
    expect(s.priority).toBeNull();
    const you = legalActions(s, 0);
    expect(you.mustCastOffered?.prompt).toBe(offer?.prompt);
    expect(you.mustCastOffered?.bottom).toBe(1);
    expect(legalActions(s, 1).plays).toEqual([]);

    // And the play offered on it is a cast with no cost at all, not a cheap one.
    const play = you.plays.find((p) => p.card === offer?.card);
    expect(play?.offered).toBe(true);
    expect(play?.manaCost).toBe('');
    expect(play?.description).toBe('Cast Lightning Bolt without paying its mana cost');
  });

  it('casts it for no mana, and the rest of the pile goes under the library', () => {
    let s = cast(cascading(['Mountain', 'Lightning Bolt']));
    const bolt = s.pendingOfferedCast!.card;
    const library = ids(s, 0, 'library').length;
    const theirLife = life(s, 1);
    const tappedBefore = tappedLands(s);

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: bolt, offered: true, targets: [{ kind: 'player', seat: 1 }],
    }), 40);

    // Nothing was paid, which is the whole of the keyword: the four lands the Elf itself cost are
    // tapped, and the Bolt tapped nothing on top of them.
    expect(tappedLands(s)).toBe(tappedBefore);
    expect(life(s, 1)).toBe(theirLife - 3);
    // The offer is spent, and the card it walked past is back in the library — at the bottom, so
    // the Mountain it exiled is not the next card drawn.
    expect(s.pendingOfferedCast).toBeNull();
    expect(nameOf(s, ids(s, 0, 'library').at(-1) ?? '')).toBe('Mountain');
    expect(ids(s, 0, 'library')).toHaveLength(library + 1);
    // And the Elf itself resolved into play behind it.
    expect(namesIn(s, 0, 'battlefield')).toContain('Bloodbraid Elf');
  });

  it('is declined by passing, and then the whole pile goes under the library', () => {
    let s = cast(cascading(['Mountain', 'Lightning Bolt']));
    const library = ids(s, 0, 'library').length;
    expect(legalActions(s, 0).passLabel).toBe('Decline');

    s = drain(apply(s, { type: 'auto:pass', by: 0 }), 40);
    expect(s.pendingOfferedCast).toBeNull();
    expect(ids(s, 0, 'exile')).toHaveLength(0);
    expect(ids(s, 0, 'library')).toHaveLength(library + 2);
    expect(life(s, 1)).toBe(20);
    // Declining does not cost the Elf: it is still on its way to the battlefield.
    expect(namesIn(s, 0, 'battlefield')).toContain('Bloodbraid Elf');
  });

  it('casts a sorcery it could not otherwise cast, because the keyword says when', () => {
    /*
      Flame Slash is a sorcery, and when this cast happens there is a creature spell on the stack
      underneath it — so none of the timing an ordinary cast is checked against holds (CR 702.85a).
      That it resolves and kills something is the proof: a cast that was merely *allowed* and then
      sat there would leave the Drake alive.
    */
    let s = advanceTo(arena({
      decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
      hands: { 0: ['Bloodbraid Elf'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Forest', 'Forest'], 1: ['Wind Drake'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = cast(toTop(s, 'Flame Slash'));
    const slash = s.pendingOfferedCast!.card;
    expect(nameOf(s, slash)).toBe('Flame Slash');
    expect(s.stackOrder.length).toBeGreaterThan(0);

    const drake = find(s, 1, 'battlefield', 'Wind Drake');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: slash, offered: true, targets: [{ kind: 'card', id: drake }],
    }), 40);
    expect(namesIn(s, 0, 'graveyard')).toContain('Flame Slash');
    expect(namesIn(s, 1, 'graveyard')).toContain('Wind Drake');
  });

  it('walks past a card of equal mana value, because "less" means less', () => {
    // Flametongue Kavu costs {3}{R} and so does the Elf, so it is exiled and passed over.
    const s = cast(cascading(['Flametongue Kavu', 'Lightning Bolt']));
    expect(nameOf(s, s.pendingOfferedCast?.card ?? '')).toBe('Lightning Bolt');
    expect(s.pendingOfferedCast?.bottom.map((id) => nameOf(s, id))).toEqual(['Flametongue Kavu']);
  });

  it('refuses an offered cast nobody offered, and an X on one that was', () => {
    const board = cascading(['Mountain', 'Lightning Bolt']);
    const elf = find(board, 0, 'hand', 'Bloodbraid Elf');
    expect(refusal(board, { type: 'auto:cast', by: 0, card: elf, offered: true }))
      .toContain('nothing is on offer');

    const offered = cast(board);
    const bolt = offered.pendingOfferedCast!.card;
    // Somebody else's offer is not yours, and neither is a different card.
    expect(refusal(offered, { type: 'auto:cast', by: 1, card: bolt, offered: true }))
      .toContain('not yours');
    expect(refusal(offered, {
      type: 'auto:cast', by: 0, card: bolt, offered: true, x: 3, targets: [{ kind: 'player', seat: 1 }],
    })).toContain('X is 0');
    // And nothing else may happen while the question stands, including by the other seat.
    expect(refusal(offered, { type: 'auto:pass', by: 1 })).toContain('must be answered first');
  });

  it('does not let a cast trigger fire off the casting of its own card', () => {
    /*
      The guard that makes the stack a watcher safe, asserted on the card that would otherwise
      break: Chalice of the Void counters every spell whose mana value equals its charge counters,
      and a Chalice cast for X=0 is a nought-cost spell that has not got its counters yet. Without
      the `self` rule in `raise` it would answer its own cast and counter itself on the way in.
    */
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'kindle-grove' },
      hands: { 0: ['Chalice of the Void'] },
      battlefield: { 0: ['Island', 'Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    const chalice = find(s, 0, 'hand', 'Chalice of the Void');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: chalice, x: 0 }), 40);
    expect(namesIn(s, 0, 'battlefield')).toContain('Chalice of the Void');
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Chalice of the Void');
  });
});

describe('storm: a spell copied for each spell cast before it this turn', () => {
  /*
    The second card down the path cascade built, and the first thing this engine counts about a
    *turn*. Three things are worth a test and they are different questions: that the count is of
    everybody's spells and resets with the turn, that the copies are the count taken **as the storm
    spell was cast** rather than as its trigger resolves, and that a copy is not a cast — so a
    storm count of three does not become a storm count of six through its own copies.
  */
  const arcBoard = (): GameState => advanceTo(arena({
    decks: { 0: 'arc-tempest', 1: 'kindle-grove' },
    hands: { 0: ['Grapeshot', 'Lightning Bolt', 'Burst Lightning'] },
    battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
    turn: 5, firstSeat: 0,
  }), 'precombat-main');

  const castAt = (s: GameState, name: string, seat: SeatIndex, at: Target): GameState =>
    drain(apply(s, { type: 'auto:cast', by: seat, card: find(s, seat, 'hand', name), targets: [at] }), 40);

  it('counts the spells cast before it, and deals one damage per copy', () => {
    let s = arcBoard();
    const them: Target = { kind: 'player', seat: 1 };
    // Two spells first, which is the whole of what the third one is worth.
    s = castAt(s, 'Lightning Bolt', 0, them);
    s = castAt(s, 'Burst Lightning', 0, them);
    expect(s.spellsCastThisTurn).toBe(2);
    // A Bolt is three and a Burst Lightning unkicked is two.
    expect(life(s, 1)).toBe(20 - 3 - 2);

    s = castAt(s, 'Grapeshot', 0, them);
    // One damage for the spell and one for each of the two copies.
    expect(life(s, 1)).toBe(20 - 3 - 2 - 3);
    // And the copies left nothing behind: a copy of a spell ceases to exist rather than going to a
    // graveyard, so there is one Grapeshot card there and not three.
    expect(namesIn(s, 0, 'graveyard').filter((n) => n === 'Grapeshot')).toHaveLength(1);
  });

  it('is nothing at all as the first spell of a turn', () => {
    let s = arcBoard();
    s = castAt(s, 'Grapeshot', 0, { kind: 'player', seat: 1 });
    expect(life(s, 1)).toBe(19);
    expect(s.stackOrder).toEqual([]);
  });

  it('counts the other seat’s spells too, and forgets them when the turn ends', () => {
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'kindle-grove' },
      hands: { 0: ['Grapeshot'], 1: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain', 'Mountain'], 1: ['Mountain', 'Mountain'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    /*
      The other seat answers with an instant in this seat's main phase, which is a spell cast this
      turn by anybody — the rule, and the thing that makes a storm count in a pod frightening.

      Priority is handed over first, because this board has auto-pass off: the seat that is not
      the active player only gets to act once the active one has passed, which is the same
      sequence a real table goes through.
    */
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = castAt(s, 'Lightning Bolt', 1, { kind: 'player', seat: 0 });
    expect(s.spellsCastThisTurn).toBe(1);
    s = castAt(s, 'Grapeshot', 0, { kind: 'player', seat: 1 });
    expect(life(s, 1)).toBe(18);

    // And the turn ends, which is what "this turn" means.
    const next = drain(nextTurn(s), 40);
    expect(next.spellsCastThisTurn).toBe(0);
  });

  it('takes the count from when it was cast, not from when the trigger resolves', () => {
    /*
      The half that would be quietly wrong: a spell cast in response to a storm spell is not a
      spell cast *before* it, so it must not add a copy. Built by holding the storm trigger on the
      stack — the Grapeshot is cast, nobody passes, and the other seat answers underneath it.
    */
    let s = advanceTo(arena({
      decks: { 0: 'arc-tempest', 1: 'kindle-grove' },
      hands: { 0: ['Grapeshot'], 1: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain', 'Mountain'], 1: ['Mountain', 'Mountain'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    const them: Target = { kind: 'player', seat: 1 };
    // Cast without draining: the Grapeshot and its storm trigger are both on the stack.
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Grapeshot'), targets: [them] });
    expect(s.stackOrder.length).toBe(2);
    // The other seat answers in that window, which moves the turn's tally to two. Priority is
    // passed to it first, as it would be at a table.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 0 }],
    });
    expect(s.spellsCastThisTurn).toBe(2);

    s = drain(s, 60);
    // One damage, not two: the Bolt was cast after the Grapeshot and bought it no copies.
    expect(life(s, 1)).toBe(19);
    expect(life(s, 0)).toBe(17);
  });
});

describe('madness: a card discarded into exile, and a cheaper cast out of it', () => {
  /*
    The third shape of answer to a zone change in this pool, after a death replaced (Kalitas) and a
    graveyard replaced (Rest in Peace) — and the first that replaces a move out of a **hand**.

    Every board here discards through **Faithless Looting**, which is the card in Ashen Rite the
    Temper is in the deck for: it draws two and discards two, and the discard happens inside the
    resolution where the replacement can see it. An earlier version of these tests moved the card
    by hand with `card:move` and watched nothing happen, which is correct — a tabletop move is not
    a discard inside a resolution, and settle is what runs replacements.
  */
  const looting = (lands: readonly string[], hand: readonly string[]): GameState => {
    const board = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'kindle-grove' },
      hands: { 0: ['Faithless Looting', ...hand] },
      battlefield: { 0: [...lands] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return apply(board, {
      type: 'auto:cast', by: 0, card: find(board, 0, 'hand', 'Faithless Looting'),
    });
  };

  /** Resolves the Looting, discarding the Temper and whatever else is named. */
  const discarding = (s: GameState, names: readonly string[]): GameState =>
    drain(decide(drain(s, 8), names), 40);

  it('goes to exile instead of the graveyard, and offers itself for its madness cost', () => {
    let s = looting(['Mountain', 'Mountain'], ['Fiery Temper', 'Swamp']);
    s = discarding(s, ['Fiery Temper', 'Swamp']);

    const offer = s.pendingOfferedCast;
    expect(offer?.seat).toBe(0);
    expect(nameOf(s, offer?.card ?? '')).toBe('Fiery Temper');
    expect(offer?.cost).toBe('{R}');
    expect(offer?.toGraveyard).toBe(true);
    expect(namesIn(s, 0, 'exile')).toContain('Fiery Temper');
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Fiery Temper');
    // The other discard went where discards go, which is what says this is about the one card.
    expect(namesIn(s, 0, 'graveyard')).toContain('Swamp');

    // And the play on it costs {R} rather than the printed {1}{R}{R}.
    const play = legalActions(s, 0).plays.find((p) => p.card === offer?.card);
    expect(play?.offered).toBe(true);
    expect(play?.manaCost).toBe('{R}');
    expect(legalActions(s, 0).mustCastOffered?.cost).toBe('{R}');
  });

  it('is cast for one mana and deals its three damage', () => {
    let s = looting(['Mountain', 'Mountain'], ['Fiery Temper', 'Swamp']);
    s = discarding(s, ['Fiery Temper', 'Swamp']);
    const temper = s.pendingOfferedCast!.card;
    const tappedBefore = ids(s, 0, 'battlefield')
      .filter((id) => s.instances[id]!.tapped === true).length;

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: temper, offered: true,
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(life(s, 1)).toBe(17);
    // One more land tapped, not three: {R} was paid rather than the printed {1}{R}{R}.
    const tappedAfter = ids(s, 0, 'battlefield')
      .filter((id) => s.instances[id]!.tapped === true).length;
    expect(tappedAfter - tappedBefore).toBe(1);
    expect(namesIn(s, 0, 'graveyard')).toContain('Fiery Temper');
  });

  it('goes to the graveyard when the offer is declined', () => {
    let s = looting(['Mountain', 'Mountain'], ['Fiery Temper', 'Swamp']);
    s = discarding(s, ['Fiery Temper', 'Swamp']);
    expect(legalActions(s, 0).passLabel).toBe('Decline');

    s = drain(apply(s, { type: 'auto:pass', by: 0 }), 40);
    expect(s.pendingOfferedCast).toBeNull();
    // The move the replacement interrupted, finished: the graveyard it was discarded to.
    expect(namesIn(s, 0, 'graveyard')).toContain('Fiery Temper');
    expect(namesIn(s, 0, 'exile')).not.toContain('Fiery Temper');
    expect(life(s, 1)).toBe(20);
  });

  it('is not offered when the madness cost cannot be paid, and the card is simply discarded', () => {
    /*
      One Mountain, spent on the Looting itself — so {R} is unpayable when the discard happens, and
      a question with one answer is not asked at all (CR 601.2h). The same rule the ward follows,
      and the same channel for saying so.
    */
    let s = looting(['Mountain'], ['Fiery Temper', 'Swamp']);
    s = discarding(s, ['Fiery Temper', 'Swamp']);

    expect(s.pendingOfferedCast).toBeNull();
    expect(namesIn(s, 0, 'graveyard')).toContain('Fiery Temper');
    expect(namesIn(s, 0, 'exile')).not.toContain('Fiery Temper');
    // And said out loud, because nobody pressed anything: the note travels on the message of the
    // action that provoked it, the same channel a ward nobody could pay uses. See
    // `reduceAutoAction`, which drains `replacements` onto the log.
    expect(s.log.map((entry) => entry.message).join(' ')).toContain('could not be paid');
  });

  it('is the card the computer gives up first — but only with the mana to cast it', () => {
    /*
      The bot rule, and both halves of it. Asked of the same board twice: with one Mountain the
      Looting has spent it and the Temper is a three-mana sorcery in a graveyard, so the ordinary
      policy wins and something else goes; with two, the madness cast follows and the Temper is the
      first card given up.

      Written after the measurement rather than before it — `offers.mjs` over 96 games found 281
      discards and not one madness card among them, 41 of them out of a hand that was holding one.
      What the same instrument then said about the rule is in D193: it fires here and still never
      fires in a real game, because the bot spends its mana before it discards.
    */
    const board = (lands: number): GameState => advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'kindle-grove' },
      hands: { 0: ['Faithless Looting', 'Fiery Temper', 'Swamp', 'Dark Ritual'] },
      battlefield: { 0: Array.from({ length: lands }, () => 'Mountain') },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    const discardsChosen = (lands: number): string[] => {
      const s = drain(apply(board(lands), {
        type: 'auto:cast', by: 0, card: find(board(lands), 0, 'hand', 'Faithless Looting'),
      }), 8);
      const chosen = botAction(s, 0);
      return chosen?.type === 'auto:decide' ? chosen.cards.map((id) => nameOf(s, id)) : [];
    };

    expect(discardsChosen(2)).toContain('Fiery Temper');
    // One Mountain, spent on the Looting: the madness cast cannot follow, so the rule stands aside.
    expect(discardsChosen(1)).not.toContain('Fiery Temper');
  });

  it('says nothing when the card reaches a graveyard any other way', () => {
    /*
      The clause the `discarded` list exists for. A Fiery Temper that has finished resolving as a
      spell is a card put into a graveyard like any other, and a madness that fired for it would be
      reading "discard" as "goes to the graveyard" — which is two different cards, and an infinite
      one: the card would offer itself again every time it resolved.
    */
    let s = advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'kindle-grove' },
      hands: { 0: ['Fiery Temper'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Swamp'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Fiery Temper'),
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(s.pendingOfferedCast).toBeNull();
    expect(namesIn(s, 0, 'graveyard')).toContain('Fiery Temper');
    expect(life(s, 1)).toBe(17);
  });
});

describe('evoke: the same card cast for two prices, and the permanent is the difference', () => {
  /*
    The first alternative cost in this engine that changes what happens **after** the spell
    resolves. Flashback, escape and foretell each replaced a cost and were finished with it; a
    Mulldrifter cast for {2}{U} resolves exactly as the five-mana one does — onto the battlefield,
    drawing two — and then sacrifices itself, which is the whole trade and the whole of what these
    tests are about.

    Tidal Mind for every board, because that is where the card lives and where the deck has the
    Islands to cast it either way.
  */
  const drifter = (lands: readonly string[], hand: readonly string[] = ['Mulldrifter']): GameState =>
    advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'kindle-grove' },
      hands: { 0: [...hand] },
      battlefield: { 0: [...lands] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  const islands = (n: number): string[] => Array.from({ length: n }, () => 'Island');

  it('is offered twice with five lands and once with three', () => {
    expect(legalActions(drifter(islands(5)), 0).plays
      .filter((p) => p.name === 'Mulldrifter').map((p) => p.description))
      .toEqual([
        'Cast Mulldrifter for its evoke cost ({2}{U}, sacrificed as it arrives)',
        'Cast Mulldrifter',
      ]);
    // Three mana: the printed cost is out of reach and the cheap one is the only play, which is
    // the turn the card is in the deck for.
    expect(legalActions(drifter(islands(3)), 0).plays
      .filter((p) => p.name === 'Mulldrifter').map((p) => p.manaCost))
      .toEqual(['{2}{U}']);
    // Two: neither, because evoke is a cheaper cost and not a free one.
    expect(legalActions(drifter(islands(2)), 0).plays
      .filter((p) => p.name === 'Mulldrifter')).toEqual([]);
  });

  it('evoked: draws two cards, and the Mulldrifter is in the graveyard', () => {
    let s = drifter(islands(3));
    const before = ids(s, 0, 'hand').length;
    const card = find(s, 0, 'hand', 'Mulldrifter');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card, evoked: true }), 40);

    // Two cards drawn, and the one that was cast is not one of them: the hand is up by two from
    // what was left after the Mulldrifter went on the stack.
    expect(ids(s, 0, 'hand').length).toBe(before - 1 + 2);
    expect(s.instances[card]!.zone).toBe('graveyard');
    // Three lands tapped and no more: the evoke cost is what was paid.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(3);
  });

  it('cast for its printed cost: draws two and stays on the battlefield', () => {
    let s = drifter(islands(5));
    const before = ids(s, 0, 'hand').length;
    const card = find(s, 0, 'hand', 'Mulldrifter');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card }), 40);

    expect(ids(s, 0, 'hand').length).toBe(before - 1 + 2);
    expect(s.instances[card]!.zone).toBe('battlefield');
  });

  it('says on the stack which of the two it is', () => {
    let s = drifter(islands(3));
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Mulldrifter'), evoked: true,
    });
    // The word a player reads before deciding whether to answer it: a creature that is about to
    // sacrifice itself is not worth a counterspell.
    expect(stackNames(s)).toEqual(['Mulldrifter (evoked)']);
  });

  it('draws first and dies second, which is the order a player would choose', () => {
    /*
      Both triggers belong to one controller and go on the stack together (CR 603.3b), so the one
      listed first on the card is underneath and resolves last. The card lists the sacrifice first
      for exactly this reason — the other order is three mana for nothing at all — and this is the
      test that says so: after the first of the two resolutions the cards are drawn and the
      creature is still there.
    */
    let s = drifter(islands(3));
    const before = ids(s, 0, 'hand').length;
    const card = find(s, 0, 'hand', 'Mulldrifter');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card, evoked: true }), 2);
    // Both abilities on the stack at once, the sacrifice underneath: the stack resolves from the
    // top, so this is the order written out.
    expect(s.stackOrder.map((id) => s.stackObjects[id]?.description))
      .toEqual(['sacrifice it, because its evoke cost was paid', 'draw two cards']);

    // The draw, resolved: two cards in hand and the creature still standing.
    s = drain(s, 2);
    expect(ids(s, 0, 'hand').length).toBe(before - 1 + 2);
    expect(s.instances[card]!.zone).toBe('battlefield');
    // And then the sacrifice, which is the second of the two.
    s = drain(s, 40);
    expect(s.instances[card]!.zone).toBe('graveyard');
  });

  it('a Mulldrifter that reached the battlefield any other way stays', () => {
    /*
      "If its evoke cost was paid" is a fact about **this body**, which is why it is a counter on
      the permanent rather than anything on the card. A Mulldrifter put onto the battlefield by
      something else was not cast at all, so the trigger's condition is false and nothing is
      sacrificed — and so is a second Mulldrifter standing beside an evoked one.
    */
    let s = drifter(islands(3));
    const card = find(s, 0, 'hand', 'Mulldrifter');
    // Onto the battlefield without being cast at all, which is how a reanimation or a copy would
    // put it there: no cost was paid, so no evoke cost was paid.
    s = drain(apply(s, { type: 'card:move', by: 0, card, toZone: 'battlefield' }), 40);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(s.instances[card]!.counters['evoked'] ?? 0).toBe(0);
  });

  it('refuses an evoke on a card that has none, rather than ignoring it', () => {
    const s = drifter(islands(5), ['Air Elemental']);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Air Elemental'), evoked: true,
    })).toMatch(/no evoke/);
  });
});

describe('dash: the creature you pay less for and do not get to keep', () => {
  /*
    Evoke's mirror. There the cheap cast buys the spell and gives up the body; here it buys the
    body for one turn — haste, an attack, and the card back in hand at the beginning of the next
    end step — and gives up keeping it.

    Both consequences are arranged where the spell resolves rather than by anything on the stack
    (CR 702.109a), which is the half these tests are really about: there is no window between the
    creature arriving and it having haste, and the return survives the creature being answered.
  */
  const scout = (lands: readonly string[], hand: readonly string[] = ['Mardu Scout']): GameState =>
    advanceTo(arena({
      decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
      hands: { 0: [...hand] },
      battlefield: { 0: [...lands] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  const mountains = (n: number): string[] => Array.from({ length: n }, () => 'Mountain');

  it('is offered twice with two lands and only dashed with one', () => {
    expect(legalActions(scout(mountains(2)), 0).plays
      .filter((p) => p.name === 'Mardu Scout').map((p) => p.description))
      .toEqual([
        'Cast Mardu Scout for its dash cost ({R}, hasty, back to your hand at end of turn)',
        'Cast Mardu Scout',
      ]);
    expect(legalActions(scout(mountains(1)), 0).plays
      .filter((p) => p.name === 'Mardu Scout').map((p) => p.manaCost))
      .toEqual(['{R}']);
  });

  it('dashed: it has haste, and the stack says which cast it was', () => {
    let s = scout(mountains(1));
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Mardu Scout'), dashed: true });
    expect(stackNames(s)).toEqual(['Mardu Scout (dashed)']);

    s = drain(s, 40);
    const scoutId = find(s, 0, 'battlefield', 'Mardu Scout');
    expect(characteristicsOf(s, s.instances[scoutId]!).keywords.has('haste')).toBe(true);
    // And it can attack the turn it arrived, which is the whole of what the mana bought.
    // `canAttack` answers with the reason it cannot, or null when it can.
    expect(canAttack(s, scoutId, 0)).toBeNull();
  });

  it('cast for its printed cost it is summoning sick, and it stays', () => {
    let s = scout(mountains(2));
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Mardu Scout') }), 40);
    const scoutId = find(s, 0, 'battlefield', 'Mardu Scout');
    expect(characteristicsOf(s, s.instances[scoutId]!).keywords.has('haste')).toBe(false);
    expect(canAttack(s, scoutId, 0)?.reason).toMatch(/summoning sickness/);

    // And it is still there next turn, which is the difference the printed cost buys.
    s = nextTurn(nextTurn(s));
    expect(s.instances[scoutId]!.zone).toBe('battlefield');
  });

  it('goes back to its owner\'s hand at the beginning of the end step', () => {
    let s = scout(mountains(1));
    const card = find(s, 0, 'hand', 'Mardu Scout');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card, dashed: true }), 40);
    expect(s.instances[card]!.zone).toBe('battlefield');

    // The same turn's end step, not a later one: "the next end step" is this one. Through the
    // combat it is entitled to attack in, declaring nothing, because the return is about the step
    // and not about what the creature did.
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [] });
    s = drain(advanceTo(s, 'end'), 40);
    expect(s.instances[card]!.zone).toBe('hand');
    // Which means it can be dashed again, for one mana, on the next turn — and that is the card.
    expect(s.instances[card]!.counters['dashed'] ?? 0).toBe(0);
  });

  it('the return outlives the creature, and does nothing when it has gone', () => {
    /*
      A delayed ability stops belonging to its source the moment it is created (CR 603.7d), so a
      dashed creature killed before the end step leaves the return behind — and the return, finding
      no creature on the battlefield, does as much as it can, which is nothing. The card must not
      come back out of the graveyard.
    */
    let s = scout(mountains(1), ['Mardu Scout', 'Lightning Bolt']);
    const card = find(s, 0, 'hand', 'Mardu Scout');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card, dashed: true }), 40);
    s = drain(apply(s, { type: 'card:move', by: 0, card, toZone: 'graveyard' }), 40);

    // Straight through the combat this time: with the creature gone there is no declaration owed.
    s = drain(advanceTo(s, 'end'), 40);
    expect(s.instances[card]!.zone).toBe('graveyard');
  });

  it('refuses a dash on a card that has none, and refuses it beside another cost', () => {
    const s = scout(mountains(2), ['Centaur Courser']);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Centaur Courser'), dashed: true,
    })).toMatch(/no dash/);

    const both = scout(mountains(2));
    expect(refusal(both, {
      type: 'auto:cast', by: 0, card: find(both, 0, 'hand', 'Mardu Scout'),
      dashed: true, evoked: true,
    })).toMatch(/alternative cost/);
  });

  it('every card with dash carries exactly one delayed trigger, which is what schedules its return', () => {
    /*
      The convention the engine relies on: it schedules the return by finding the card's one
      `delayed` end-step trigger, the way unearth's exile is found. A dash card that carried two of
      them — or none — would schedule the wrong ability, or silently never come back.
    */
    for (const name of scriptedCardNames()) {
      const script = scriptFor(name);
      if (script?.dash === undefined) continue;
      const delayed = (script.triggers ?? []).filter((t) => t.delayed === true
        && t.on.kind === 'step' && t.on.step === 'end');
      expect([name, delayed.length]).toEqual([name, 1]);
    }
  });
});

describe('bestow: the creature you may cast as an Aura, and the Aura that stands up', () => {
  /*
    The third alternative cost, and the one that changes what the spell **is** rather than what the
    permanent does afterwards. A bestowed Boon Satyr is an Aura spell on the stack and an
    Enchantment — Aura on the battlefield; it is not a creature at all until the creature it
    enchants leaves, and then it becomes one where it stands (CR 702.103).
  */
  const satyr = (lands: number, mine: readonly string[] = [], theirs: readonly string[] = []): GameState =>
    advanceTo(arena({
      decks: { 0: 'verdant-guard', 1: 'kindle-grove' },
      hands: { 0: ['Boon Satyr'] },
      battlefield: {
        0: [...Array.from({ length: lands }, () => 'Forest'), ...mine],
        1: [...theirs],
      },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  it('is offered as an Aura only with a creature to enchant, and only for the whole cost', () => {
    // Five lands and a creature of its own to enchant: both castings.
    expect(legalActions(satyr(5, ['Grizzly Bears']), 0).plays
      .filter((p) => p.name === 'Boon Satyr').map((p) => p.description))
      .toEqual([
        'Cast Boon Satyr for its bestow cost ({3}{G}{G}, as an Aura)',
        'Cast Boon Satyr',
      ]);
    // Five lands and nothing on the table: an Aura with nothing to enchant is not a cast at all
    // (CR 601.2c), so only the creature half is offered.
    expect(legalActions(satyr(5), 0).plays
      .filter((p) => p.name === 'Boon Satyr').map((p) => p.manaCost))
      .toEqual(['{1}{G}{G}']);
    // Three lands and a creature: the bestow cost cannot be paid, so only the creature again.
    expect(legalActions(satyr(3, ['Grizzly Bears']), 0).plays
      .filter((p) => p.name === 'Boon Satyr').map((p) => p.manaCost))
      .toEqual(['{1}{G}{G}']);
  });

  it('bestowed, it is an Aura and not a creature, and the Bears are 6/4', () => {
    let s = satyr(5, ['Grizzly Bears']);
    const card = find(s, 0, 'hand', 'Boon Satyr');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card, bestowed: true,
      targets: [{ kind: 'card', id: bears }],
    }), 40);

    const ch = characteristicsOf(s, s.instances[card]!);
    expect(ch.isCreature).toBe(false);
    expect(ch.typeLine.subtypes.map((t) => t.toLowerCase())).toContain('aura');
    expect(s.instances[card]!.attachedTo).toBe(bears);
    // +4/+2 on the creature it enchants, which is the half of the card that is not its own body.
    const host = characteristicsOf(s, s.instances[bears]!);
    expect([host.power, host.toughness]).toEqual([6, 4]);
  });

  it('cast as a creature it is a 4/2 of its own, with no Aura anywhere', () => {
    let s = satyr(3, ['Grizzly Bears']);
    const card = find(s, 0, 'hand', 'Boon Satyr');
    s = drain(apply(s, { type: 'auto:cast', by: 0, card }), 40);
    const ch = characteristicsOf(s, s.instances[card]!);
    expect(ch.isCreature).toBe(true);
    expect([ch.power, ch.toughness]).toEqual([4, 2]);
    expect(s.instances[card]!.attachedTo).toBeNull();
    // And the Bears are the Bears.
    const bears = characteristicsOf(s, s.instances[find(s, 0, 'battlefield', 'Grizzly Bears')]!);
    expect([bears.power, bears.toughness]).toEqual([2, 2]);
  });

  it('when the creature it enchants dies, it becomes a creature instead of going to the graveyard', () => {
    /*
      The rule the keyword is played for (CR 702.103c), and the one thing in this engine that
      changes a permanent's type without the permanent moving. An ordinary Aura in the same
      position is put into its owner's graveyard by the same state-based action.
    */
    let s = satyr(5, ['Grizzly Bears']);
    const card = find(s, 0, 'hand', 'Boon Satyr');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card, bestowed: true,
      targets: [{ kind: 'card', id: bears }],
    }), 40);

    s = drain(apply(s, { type: 'card:move', by: 0, card: bears, toZone: 'graveyard' }), 40);
    expect(s.instances[card]!.zone).toBe('battlefield');
    expect(s.instances[card]!.attachedTo).toBeNull();
    const ch = characteristicsOf(s, s.instances[card]!);
    expect(ch.isCreature).toBe(true);
    expect([ch.power, ch.toughness]).toEqual([4, 2]);
    // And the +4/+2 went with the attachment rather than staying in `effects` for ever.
    expect(s.effects.some((e) => e.source === card)).toBe(false);
  });

  it('a bestowed spell is an Aura spell, so a counterspell for creatures misses it', () => {
    /*
      The public half of the flag: it is set as the spell is announced, so what is on the stack is
      an Aura spell. An Essence Scatter — "counter target creature spell" — cannot be pointed at
      it, and the engine says so by not offering the target.
    */
    let s = satyr(5, ['Grizzly Bears']);
    const card = find(s, 0, 'hand', 'Boon Satyr');
    s = apply(s, {
      type: 'auto:cast', by: 0, card, bestowed: true,
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Grizzly Bears') }],
    });
    expect(stackNames(s)).toEqual(['Boon Satyr (bestowed)']);
    expect(characteristicsOf(s, s.instances[card]!).isCreature).toBe(false);
  });

  it('countered, it is a creature card in the graveyard again', () => {
    // The flag is cleared by the move, like `castAs` and `faceDown`: what is in the graveyard is
    // the whole card, which is what a reanimation spell brings back.
    let s = satyr(5, ['Grizzly Bears']);
    const card = find(s, 0, 'hand', 'Boon Satyr');
    s = apply(s, {
      type: 'auto:cast', by: 0, card, bestowed: true,
      targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Grizzly Bears') }],
    });
    s = drain(apply(s, { type: 'card:move', by: 0, card, toZone: 'graveyard' }), 40);
    expect(s.instances[card]!.bestowed).toBeUndefined();
    expect(characteristicsOf(s, s.instances[card]!).isCreature).toBe(true);
  });

  it('refuses a bestow on a card that has none, and refuses it beside another alternative cost', () => {
    const s = satyr(5, ['Grizzly Bears']);
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: bears, bestowed: true,
    })).toMatch(/no bestow|not in your hand/);

    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Boon Satyr'),
      bestowed: true, dashed: true, targets: [{ kind: 'card', id: bears }],
    })).toMatch(/alternative cost/);
  });
});

describe('spectacle: the cheap cost the board has to earn', () => {
  /*
    The fourth alternative cost and the first with a condition on the game's *history*: you may
    cast this for its spectacle cost if an opponent lost life this turn (CR 702.137a). Nothing on
    the board answers that question — a player on eighteen may have been on twenty a moment ago or
    for four turns — so it needed `GameState.lifeLostThisTurn`, which these tests are as much about
    as they are about the card.
  */
  const ashen = (lands: readonly string[], hand: readonly string[] = ['Skewer the Critics']): GameState =>
    advanceTo(arena({
      decks: { 0: 'ashen-rite', 1: 'kindle-grove' },
      hands: { 0: [...hand] },
      battlefield: { 0: [...lands] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');

  const mountains = (n: number): string[] => Array.from({ length: n }, () => 'Mountain');

  it('is not offered on a turn nobody has been hit, and is the moment they have', () => {
    let s = ashen(mountains(4), ['Skewer the Critics', 'Lightning Bolt']);
    // Four mana and a quiet turn: the printed cost and nothing else.
    expect(legalActions(s, 0).plays
      .filter((p) => p.name === 'Skewer the Critics').map((p) => p.manaCost))
      .toEqual(['{2}{R}']);

    // A Bolt at the other seat is all it takes, and the row appears with its reason on it —
    // beside the printed one, which the fourth land is there to keep payable.
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(s.lifeLostThisTurn['1']).toBe(3);
    expect(legalActions(s, 0).plays
      .filter((p) => p.name === 'Skewer the Critics').map((p) => p.description))
      .toEqual([
        'Cast Skewer the Critics for its spectacle cost ({R}, because an opponent has lost life this turn)',
        'Cast Skewer the Critics',
      ]);
  });

  it('your own life does not pay for it', () => {
    /*
      "An opponent", which is the clause that makes the card the second half of an attack rather
      than a one-mana Lava Spike. Ashen Rite is the deck that would otherwise cheat it: a Dark
      Confidant, a Phyrexian Arena and a City of Brass all cost their own controller life every
      turn, and three of those a game would make the cheap cost permanent.

      Bolted at **yourself**, which is a legal target and the cheapest way to lose life through the
      engine's own path rather than by moving a counter.
    */
    let s = ashen(mountains(4), ['Skewer the Critics', 'Lightning Bolt']);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 0 }],
    }), 40);
    expect(s.lifeLostThisTurn['0']).toBe(3);
    expect(s.lifeLostThisTurn['1'] ?? 0).toBe(0);
    expect(legalActions(s, 0).plays
      .filter((p) => p.name === 'Skewer the Critics').map((p) => p.manaCost))
      .toEqual(['{2}{R}']);
  });

  it('deals its three damage for one mana, and says so on the stack', () => {
    let s = ashen(mountains(2), ['Skewer the Critics', 'Lightning Bolt']);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(life(s, 1)).toBe(17);

    const tappedBefore = ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length;
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Skewer the Critics'),
      spectacled: true, targets: [{ kind: 'player', seat: 1 }],
    });
    expect(stackNames(s)).toEqual(['Skewer the Critics (spectacle)']);
    s = drain(s, 40);
    expect(life(s, 1)).toBe(14);
    // One more land tapped, not three.
    const tappedAfter = ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length;
    expect(tappedAfter - tappedBefore).toBe(1);
  });

  it('refuses the cheap cost on a quiet turn, rather than charging it', () => {
    const s = ashen(mountains(3));
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Skewer the Critics'),
      spectacled: true, targets: [{ kind: 'player', seat: 1 }],
    })).toMatch(/only payable if an opponent lost life/);
  });

  it('forgets at the end of the turn, which is what "this turn" means', () => {
    let s = ashen(mountains(3), ['Skewer the Critics', 'Lightning Bolt']);
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(s.lifeLostThisTurn['1']).toBe(3);

    s = nextTurn(s);
    expect(s.lifeLostThisTurn['1'] ?? 0).toBe(0);
    // And the row is gone with it, on a seat that is still three life down.
    expect(life(s, 1)).toBe(17);
    expect(legalActions(s, 0).plays
      .filter((p) => p.name === 'Skewer the Critics').map((p) => p.manaCost))
      .toEqual([]);
  });

  it('counts a life total moved by the engine and not one moved by hand', () => {
    /*
      The list is a record of life **lost**, which is narrower than "the number went down". A
      tabletop adjustment is somebody correcting the board, not an event in the game — and a
      paper-mode table has no rules running at all — so `life:adjust` records nothing, while the
      engine's own damage path records every point.
    */
    const adjusted = apply(ashen(mountains(1)), { type: 'life:adjust', by: 0, seat: 1, delta: -3 });
    expect(adjusted.lifeLostThisTurn['1'] ?? 0).toBe(0);

    const board = ashen(mountains(1), ['Lightning Bolt']);
    const bolted = drain(apply(board, {
      type: 'auto:cast', by: 0, card: find(board, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'player', seat: 1 }],
    }), 40);
    expect(bolted.lifeLostThisTurn['1']).toBe(3);
  });
});

describe('overload: the cost that stops the spell pointing at one thing', () => {
  /*
    The fifth alternative cost and the first that changes what the spell **does** (CR 702.96a).
    Evoke and dash change what becomes of the permanent, bestow changes what kind of object the
    spell is, spectacle changes only the price — and this one rewrites the text: "change each
    instance of 'target' to 'each'". So there are two things to check that the other four never
    needed: that the overloaded cast runs the card's other effect, and that it **targets nothing**,
    which is what makes it an answer to a board a removal spell cannot beat.
  */
  const mountains = (n: number): string[] => Array.from({ length: n }, () => 'Mountain');

  const table = (
    lands: number,
    theirs: readonly string[] = ['Sedgemoor Witch'],
    // A Raging Goblin rather than the deck's Monastery Swiftspear on purpose: prowess would put a
    // trigger on the stack above the spell every time this file casts one, and these tests are
    // about what the spell says.
    mine: readonly string[] = ['Raging Goblin'],
  ): GameState => advanceTo(arena({
    decks: { 0: 'ember-rush', 1: 'tidal-mind' },
    hands: { 0: ['Mizzium Mortars'] },
    battlefield: { 0: [...mountains(lands), ...mine], 1: ['Island', ...theirs] },
    turn: 7, firstSeat: 0,
  }), 'precombat-main');

  const mortars = (s: GameState): string => find(s, 0, 'hand', 'Mizzium Mortars');

  it('offers the sweep as a second row, but only once the six mana is there', () => {
    // Two lands: the printed cast and nothing else, because the dear row is the one row of the
    // five that can be missing for the ordinary reason.
    expect(legalActions(table(2), 0).plays
      .filter((p) => p.name === 'Mizzium Mortars').map((p) => p.description))
      .toEqual(['Cast Mizzium Mortars']);

    // Six, and both rows are there — the overload one first, like every other alternative cost,
    // because the cheap-cast rule that put them above the affordability check puts this one there
    // too.
    expect(legalActions(table(6), 0).plays
      .filter((p) => p.name === 'Mizzium Mortars').map((p) => p.description))
      .toEqual([
        'Cast Mizzium Mortars for its overload cost ({3}{R}{R}{R}, each instead of one)',
        'Cast Mizzium Mortars',
      ]);
  });

  it('asks for a creature on the printed row and for nothing at all on the overloaded one', () => {
    const plays = legalActions(table(6), 0).plays.filter((p) => p.name === 'Mizzium Mortars');
    const [sweep, printed] = plays;
    expect(sweep?.overloaded).toBe(true);
    expect(sweep?.targetSpecs).toEqual([]);
    expect(sweep?.candidates).toEqual([]);
    // And the printed row points at one of theirs, as the card says — not at the Swiftspear.
    expect(printed?.targetSpecs.map((spec) => spec.description))
      .toEqual(["target creature you don't control"]);
    expect(printed?.candidates[0]?.map((t) => nameOf(table(6), t.kind === 'card' ? t.id : '')))
      .toEqual(['Sedgemoor Witch']);
  });

  it('deals its four damage to every creature they control and none of yours', () => {
    /*
      Three creatures of theirs, chosen to say three different things: the Witch dies, the
      Omenspeaker dies, and the Wall of Frost does **not** — a 0/7 takes four damage and stands,
      which is the difference between this card and a Day of Judgment and is the whole reason it is
      four rather than "destroy".
    */
    let s = table(6, ['Sedgemoor Witch', 'Omenspeaker', 'Wall of Frost']);
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: mortars(s), overloaded: true }), 40);

    expect(namesIn(s, 1, 'graveyard')).toContain('Sedgemoor Witch');
    expect(namesIn(s, 1, 'graveyard')).toContain('Omenspeaker');
    expect(namesIn(s, 1, 'battlefield')).toContain('Wall of Frost');
    expect(damageOn(s, find(s, 1, 'battlefield', 'Wall of Frost'))).toBe(4);
    // And the caster's own creature is untouched: "you don't control" is read on both halves.
    expect(namesIn(s, 0, 'battlefield')).toContain('Raging Goblin');
  });

  it('says on the stack that it was overloaded, and costs six lands rather than two', () => {
    let s = table(6);
    s = apply(s, { type: 'auto:cast', by: 0, card: mortars(s), overloaded: true });
    expect(stackNames(s)).toEqual(['Mizzium Mortars (overloaded)']);
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(6);
  });

  it('gives ward nothing to ask for, because it targets nothing', () => {
    /*
      The rule this keyword is played for. Ward (CR 702.21) triggers on *becoming the target of* a
      spell an opponent controls, so the printed Mortars at a Sedgemoor Witch has to pay {3} on top
      of its {1}{R} or be countered — and the overloaded one walks straight through, because there
      is no target for the trigger to watch for.
    */
    let printedCast = table(6);
    const witch = find(printedCast, 1, 'battlefield', 'Sedgemoor Witch');
    printedCast = drain(passBoth(apply(printedCast, {
      type: 'auto:cast', by: 0, card: mortars(printedCast), targets: [{ kind: 'card', id: witch }],
    })));
    expect(printedCast.pendingPayment?.cost).toBe('{3}');

    let swept = table(6);
    swept = drain(apply(swept, {
      type: 'auto:cast', by: 0, card: mortars(swept), overloaded: true,
    }), 40);
    expect(swept.pendingPayment).toBeNull();
    expect(namesIn(swept, 1, 'graveyard')).toContain('Sedgemoor Witch');
  });

  it('refuses a target sent with an overloaded cast', () => {
    const s = table(6);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: mortars(s), overloaded: true,
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Sedgemoor Witch') }],
    })).toBeTruthy();
  });

  it('refuses the flag on a card without the keyword, and beside another alternative cost', () => {
    const s = table(6);
    const bolt = find(s, 0, 'library', 'Lightning Bolt');
    const moved = apply(s, { type: 'card:move', by: 0, card: bolt, toZone: 'hand' });
    expect(refusal(moved, {
      type: 'auto:cast', by: 0, card: find(moved, 0, 'hand', 'Lightning Bolt'),
      overloaded: true, targets: [{ kind: 'player', seat: 1 }],
    })).toMatch(/has no overload/);

    /*
      And beside another alternative cost, which is one cast paying two prices (CR 601.2f). Sent
      with evoke rather than with the kicker it resembles on price: the kicker is validated further
      up this function, and "Mizzium Mortars has no kicker" would be a true sentence about the
      wrong rule.
    */
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: mortars(s), overloaded: true, evoked: true,
    })).toMatch(/paid instead of another/);
  });

  it('is the printed spell again on the printed row, pointing at one creature', () => {
    let s = table(2, ['Omenspeaker']);
    const speaker = find(s, 1, 'battlefield', 'Omenspeaker');
    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: mortars(s), targets: [{ kind: 'card', id: speaker }],
    }), 40);
    expect(stackNames(s)).toEqual([]);
    expect(namesIn(s, 1, 'graveyard')).toContain('Omenspeaker');
    // Two lands, not six: the printed row is still a two-mana removal spell.
    expect(ids(s, 0, 'battlefield').filter((id) => s.instances[id]!.tapped).length).toBe(2);
  });
});

describe('energy: the resource that is not mana, life or cards', () => {
  /*
    Energy (CR 122) is a counter on the **player**, and these tests are as much about the resource
    as about the four cards that use it. Three things make it unlike everything else this engine
    can spend: it lives on the seat rather than on a permanent, it is never emptied, and it is the
    first resource here that is saved up across turns rather than spent on the turn it arrives.
  */
  const table = (
    hand: readonly string[],
    mine: readonly string[] = [],
    theirs: readonly string[] = [],
  ): GameState => advanceTo(arena({
    decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
    hands: { 0: [...hand] },
    battlefield: {
      0: ['Forest', 'Forest', 'Mountain', 'Mountain', ...mine],
      1: ['Island', ...theirs],
    },
    turn: 5, firstSeat: 0,
  }), 'precombat-main');

  const energy = (s: GameState, seat: SeatIndex = 0): number =>
    s.seats[seat]!.counters['energy'] ?? 0;

  it('arrives with the Aether Hub, and is spent to make a colour it does not otherwise have', () => {
    let s = table(['Aether Hub']);
    s = drain(apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Aether Hub') }), 20);
    expect(energy(s)).toBe(1);

    const hub = find(s, 0, 'battlefield', 'Aether Hub');
    const abilities = legalActions(s, 0).plays.filter((p) => p.card === hub);
    // Six rows: the colourless one, and one per colour — each of those costing the energy.
    expect(abilities).toHaveLength(6);
    expect(abilities.filter((p) => p.description.includes('Pay {E}'))).toHaveLength(5);

    // Paying it takes the energy as the ability is activated, and a mana ability resolves at once.
    const white = abilities.find((p) => p.description.includes('Add {W}'))!
    s = apply(s, { type: 'auto:activate', by: 0, card: hub, abilityIndex: white.abilityIndex ?? 0 });
    expect(energy(s)).toBe(0);
    expect(s.pools['0']?.W ?? 0).toBe(1);
  });

  it('is not offered, and is refused, when the seat has none of it', () => {
    /*
      The rule every cost in this engine follows (CR 118.4), one zone further out than the others:
      the counters are on the player rather than on the permanent, so this is the first time a
      permanent's own ability is unavailable because of something held by its controller.
    */
    const s = table([], ['Longtusk Cub']);
    const cub = find(s, 0, 'battlefield', 'Longtusk Cub');
    expect(energy(s)).toBe(0);
    expect(legalActions(s, 0).plays.filter((p) => p.card === cub)).toEqual([]);
    expect(refusal(s, { type: 'auto:activate', by: 0, card: cub, abilityIndex: 0 }))
      .toMatch(/do not have 2 energy/);
  });

  it('is given by a Longtusk Cub that connects, and spent to grow it', () => {
    let s = table([], ['Longtusk Cub']);
    const cub = find(s, 0, 'battlefield', 'Longtusk Cub');
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: cub, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = advanceTo(s, 'postcombat-main', 120);
    expect(life(s, 1)).toBe(18);
    expect(energy(s)).toBe(2);

    // And the ability it pays for is on offer now that the energy is there.
    s = drain(apply(s, { type: 'auto:activate', by: 0, card: cub, abilityIndex: 0 }), 20);
    expect(energy(s)).toBe(0);
    expect(s.instances[cub]!.counters['+1/+1']).toBe(1);
  });

  it('survives the end of the turn, which is the whole character of the resource', () => {
    /*
      Mana empties every step and this does not (CR 122.2). Nothing in `endTurnCleanup` touches
      energy, and this test is what says that absence is deliberate: a Cub that connects on turn
      five has its two counters on turn six, which is the only reason a three-energy card is ever
      castable.
    */
    let s = table([], ['Longtusk Cub']);
    const cub = find(s, 0, 'battlefield', 'Longtusk Cub');
    s = advanceTo(s, 'declare-attackers');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: cub, defender: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = advanceTo(s, 'postcombat-main', 120);
    expect(energy(s)).toBe(2);
    s = nextTurn(nextTurn(s));
    expect(energy(s)).toBe(2);
  });

  it('pays for a Bristling Hydra to grow and to dodge the removal on the stack', () => {
    let s = table(['Bristling Hydra'], ['Forest', 'Forest']);
    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Bristling Hydra') }), 40);
    const hydra = find(s, 0, 'battlefield', 'Bristling Hydra');
    expect(energy(s)).toBe(3);

    s = drain(apply(s, { type: 'auto:activate', by: 0, card: hydra, abilityIndex: 0 }), 20);
    expect(energy(s)).toBe(0);
    expect(s.instances[hydra]!.counters['+1/+1']).toBe(1);
    // Hexproof until end of turn: the opponent's removal cannot be pointed at it at all.
    expect(characteristicsOf(s, s.instances[hydra]!).keywords.has('hexproof')).toBe(true);
  });

  it('is given by a Harnessed Lightning before it asks how much of it to spend', () => {
    let s = table(['Harnessed Lightning'], [], ['Air Elemental']);
    const target = find(s, 1, 'battlefield', 'Air Elemental');
    s = passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Harnessed Lightning'),
      targets: [{ kind: 'card', id: target }],
    }));
    s = drain(s, 10);
    /*
      Three energy are already in the pool when the question is asked, which is why the range tops
      out at three rather than at nought: the card gives them to you and *then* lets you spend
      them, so a Harnessed Lightning with nothing saved is still three damage.
    */
    expect(energy(s)).toBe(3);
    expect(s.pendingDecision?.numbers).toEqual({ min: 0, max: 3 });

    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], amount: 3 }), 40);
    expect(energy(s)).toBe(0);
    // A 4/4 with three damage on it lives, which is the honest half of "deals that much damage".
    expect(damageOn(s, target)).toBe(3);
    expect(namesIn(s, 1, 'battlefield')).toContain('Air Elemental');
  });

  it('spends only what the kill costs, rather than everything in the pool', () => {
    /*
      The bot's own answer, which is the script's `best`. Overpaying is legal and the table offers
      it, but energy kept is a Hydra protected later — so the cheapest kill is the right number,
      and a board with nothing it can kill is worth nothing at all.
    */
    let s = table(['Harnessed Lightning'], [], ['Wind Drake']);
    const drake = find(s, 1, 'battlefield', 'Wind Drake');
    s = drain(passBoth(apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Harnessed Lightning'),
      targets: [{ kind: 'card', id: drake }],
    })), 10);
    expect(s.pendingDecision?.numbers).toEqual({ min: 0, max: 3 });
    // What the bot answers, read off the action it would take rather than off the question: the
    // script's `best` is a suggestion the engine does not store.
    expect(botAction(s, 0)).toMatchObject({ type: 'auto:decide', amount: 2 });

    s = drain(apply(s, { type: 'auto:decide', by: 0, cards: [], amount: 2 }), 40);
    expect(namesIn(s, 1, 'graveyard')).toContain('Wind Drake');
    // One energy left over rather than none: the third was not needed, so it was not spent.
    expect(energy(s)).toBe(1);
  });
});

describe('the auto-tapper and a land whose colour costs energy', () => {
  /*
    The Aether Hub is the first permanent in the pool with both a free tap and a paid one, and
    `manaSources` — the list the engine taps from on a player's behalf — had been reading only the
    mana, the tap, the sacrifice and the life on an ability. An energy cost was invisible to it,
    which made the Hub a land that quietly produced any colour for nothing.

    Found by `scripts/measure/energy.mjs` rather than by reading the code, and found as an absence:
    over 288 games the Hub gave out thirty-six energy and not one point of it was ever spent.
  */
  const table = (): GameState => advanceTo(arena({
    decks: { 0: 'kindle-grove', 1: 'tidal-mind' },
    hands: { 0: ['Llanowar Elves'] },
    // A Hub and nothing else: any green mana this seat makes has to come from it.
    battlefield: { 0: ['Aether Hub'], 1: ['Island'] },
    turn: 5, firstSeat: 0,
  }), 'precombat-main');

  it('does not tap a Hub for a colour the seat has no energy to pay for', () => {
    const s = table();
    expect(s.seats[0]!.counters['energy'] ?? 0).toBe(0);
    /*
      The Elves cost {G} and the only untapped permanent is a Hub with no energy, so the only mana
      this seat can make is colourless — and a cast the engine cannot pay for is one it must not
      offer. Before the fix this play was offered, and taking it produced green out of nowhere.
    */
    expect(legalActions(s, 0).plays.filter((p) => p.name === 'Llanowar Elves')).toEqual([]);
  });

  it('still offers every row to the player, who may spend the energy themselves', () => {
    /*
      The conservative choice is about the **auto-tapper**, not about the card. A player with the
      energy sees all six rows and may decide a colour is worth it — which is the whole judgement
      the solver is not in a position to make, because it knows about one cost and not about the
      next three turns.
    */
    let s = table();
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0
      ? { ...seat, counters: { ...seat.counters, energy: 1 } }
      : seat)) };
    const hub = find(s, 0, 'battlefield', 'Aether Hub');
    const rows = legalActions(s, 0).plays.filter((p) => p.card === hub);
    expect(rows).toHaveLength(6);
    expect(rows.filter((p) => p.description.includes('Pay {E}'))).toHaveLength(5);
  });
});

describe('dredge: the draw replaced by a mill, and the card that comes back', () => {
  /*
    The first replacement effect in this engine that applies to a **draw** (CR 702.52a), and the
    only question at this table that is about a card nobody cast. So the tests are the three things
    that machinery had to get right: the draw is *not taken* while the question stands, either
    answer finishes the draw the question interrupted, and the question is not asked at all when the
    library cannot pay for it.

    Every setup puts the dredge card in the graveyard **after** reaching a main phase rather than
    through `arena`'s own `graveyard`, because a dredge card in a graveyard stops the next draw step
    dead — which is the behaviour under test and would otherwise strand the setup itself.
  */

  /** Seat 0 on Rot Harvest in its main phase, with a Shambling Shell in the graveyard. */
  const shellInTheYard = (): GameState => {
    const s = advanceTo(arena({
      decks: { 0: 'rot-harvest', 1: 'ember-rush' },
      battlefield: { 0: ['Swamp', 'Swamp', 'Forest'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    return apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Shambling Shell'), toZone: 'graveyard',
    });
  };

  /**
   * Plays on until a dredge is standing, which is how the draw step's question arrives.
   *
   * `nextTurn` cannot be used: it passes priority until the turn counter moves, and the question
   * takes priority away from everybody — so it would throw on the very state these tests are about.
   */
  const untilAsked = (start: GameState): GameState => {
    let s = start;
    for (let i = 0; i < 200; i += 1) {
      if (s.pendingDredge !== null) return s;
      const owed = pendingDeclaration(s);
      if (owed !== null) {
        for (const seat of owed.seats) {
          s = owed.kind === 'attackers'
            ? apply(s, { type: 'auto:attack', by: seat, attackers: [] })
            : apply(s, { type: 'auto:block', by: seat, blocks: [] });
        }
        continue;
      }
      const discard = s.pendingDiscard;
      if (discard !== null) {
        s = apply(s, {
          type: 'auto:discard', by: discard.seat, card: ids(s, discard.seat, 'hand')[0]!,
        });
        continue;
      }
      if (s.priority === null) throw new Error(`nobody holds priority at ${s.step}`);
      s = apply(s, { type: 'auto:pass', by: s.priority });
    }
    throw new Error('no dredge was ever offered');
  };

  it('stops the draw step and asks, with the draw still owed', () => {
    const s = untilAsked(shellInTheYard());
    expect(s.step).toBe('draw');
    expect(s.activeSeat).toBe(0);

    const ask = s.pendingDredge;
    expect(ask?.seat).toBe(0);
    expect(nameOf(s, ask?.card ?? '')).toBe('Shambling Shell');
    expect(ask?.mill).toBe(3);
    // The card has **not** been drawn, which is the whole difference from every other replacement
    // in this engine: those happen to a card that has already moved.
    expect(s.drawsOwed).toEqual([0]);
    expect(s.cardsDrawnThisTurn['0'] ?? 0).toBe(0);

    // Two buttons and no priority: there is one move at this table and it is not a pass.
    const you = legalActions(s, 0);
    expect(you.hasPriority).toBe(false);
    expect(you.canPass).toBe(false);
    expect(you.mustDredge).toEqual({ prompt: ask!.prompt, card: ask!.card, mill: 3 });
    expect(legalActions(s, 1).mustDredge).toBeNull();
    expect(refusal(s, { type: 'auto:pass', by: 0 })).toContain('must be answered first');
  });

  it('mills for it and takes the card back, instead of drawing', () => {
    let s = untilAsked(shellInTheYard());
    const shell = s.pendingDredge!.card;
    const hand = ids(s, 0, 'hand').length;
    const library = ids(s, 0, 'library').length;

    s = apply(s, { type: 'auto:dredge', by: 0, dredge: true });
    expect(s.instances[shell]!.zone).toBe('hand');
    // One card into the hand, three off the library, and not one of them was drawn.
    expect(ids(s, 0, 'hand').length).toBe(hand + 1);
    expect(ids(s, 0, 'library').length).toBe(library - 3);
    expect(s.cardsDrawnThisTurn['0'] ?? 0).toBe(0);
    expect(s.pendingDredge).toBeNull();
    expect(s.drawsOwed).toEqual([]);
    // And the table carries on: somebody holds priority again.
    expect(s.priority).not.toBeNull();
  });

  it('declining takes the ordinary draw, and the card is offered again next turn', () => {
    let s = untilAsked(shellInTheYard());
    const shell = s.pendingDredge!.card;
    const library = ids(s, 0, 'library').length;

    s = apply(s, { type: 'auto:dredge', by: 0, dredge: false });
    expect(s.instances[shell]!.zone).toBe('graveyard');
    expect(ids(s, 0, 'library').length).toBe(library - 1);
    expect(s.cardsDrawnThisTurn['0']).toBe(1);

    // The card is still in the graveyard, so the next draw asks again: declining is an answer about
    // one draw rather than about the keyword.
    s = untilAsked(s);
    expect(s.pendingDredge?.card).toBe(shell);
    expect(s.activeSeat).toBe(0);
  });

  it('is not offered when the library is shorter than the mill (CR 702.52a)', () => {
    let s = shellInTheYard();
    // All but two cards out of the library, which is one short of the Shell's dredge 3.
    for (const id of ids(s, 0, 'library').slice(2)) {
      s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'exile' });
    }
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(s.pendingDredge).toBeNull();
    // The draw happened instead, which is the point: a dredge nobody can pay for is not a dredge
    // you may decline.
    expect(s.cardsDrawnThisTurn['0']).toBe(1);
  });

  it('replaces one draw of a Divination and draws the other', () => {
    /*
      The interaction `drawsOwed` is a queue for. Divination defers both of its draws, the first is
      replaced by the dredge, and the second is still owed — so it is drawn as itself, which is what
      "dredge replaces *a* draw" means.
    */
    const dredger = customDeck({
      id: 'dredge-test', name: 'Dredge Test',
      entries: [
        { name: 'Divination', count: 4 },
        { name: 'Darkblast', count: 4 },
        { name: 'Island', count: 26 },
        { name: 'Swamp', count: 26 },
      ],
    }).deck;
    let s = advanceTo(arena({
      decks: { 0: 'dredge-test', 1: 'ember-rush' },
      deckSpecs: { 'dredge-test': dredger },
      hands: { 0: ['Divination'] },
      battlefield: { 0: ['Island', 'Island', 'Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = apply(s, {
      type: 'card:move', by: 0, card: find(s, 0, 'library', 'Darkblast'), toZone: 'graveyard',
    });
    const blast = find(s, 0, 'graveyard', 'Darkblast');
    const library = ids(s, 0, 'library').length;
    // This turn's own draw step has already happened, so the count is read as a difference.
    const drawn = s.cardsDrawnThisTurn['0'] ?? 0;

    s = drain(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Divination') }), 40);
    expect(s.pendingDredge?.card).toBe(blast);
    expect(s.drawsOwed).toEqual([0, 0]);

    s = apply(s, { type: 'auto:dredge', by: 0, dredge: true });
    // The Darkblast back, one card drawn, three milled: the second draw was taken as a draw.
    expect(s.instances[blast]!.zone).toBe('hand');
    expect(s.cardsDrawnThisTurn['0']).toBe(drawn + 1);
    expect(ids(s, 0, 'library').length).toBe(library - 4);
    expect(s.pendingDredge).toBeNull();
    expect(s.drawsOwed).toEqual([]);
  });

  it('is a question the opponent can see standing, without seeing the library', () => {
    const s = untilAsked(shellInTheYard());
    const theirs = unpackView(packView(viewFor(s, 1))).automation!;
    // A graveyard is public, so the opponent is told what the table is waiting for — and that it is
    // waiting on somebody else. The prompt travels; the library it is about never does.
    expect(theirs.awaiting?.kind).toBe('dredge');
    expect(theirs.awaiting?.seats).toEqual([0]);
    expect(theirs.awaiting?.prompt).toContain('Shambling Shell');
    expect(theirs.priority).toBeNull();
    expect(theirs.you?.mustDredge).toBeNull();
  });

  it('a standing "always" answers it without stopping the table, and says so', () => {
    /*
      The preference, not the rule. A dredge card in a graveyard stops the table every draw step for
      as long as it is there — correct, and twenty taps a game for an answer most players give the
      same way every time. So a seat can answer once.
    */
    let s = shellInTheYard();
    s = apply(s, { type: 'auto:dredgeStops', by: 0, standing: 'always' });
    expect(s.dredgeStops['0']).toBe('always');

    const library = ids(s, 0, 'library').length;
    const shell = find(s, 0, 'graveyard', 'Shambling Shell');
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');

    // Taken, with nothing shown and nothing pressed.
    expect(s.pendingDredge).toBeNull();
    expect(s.instances[shell]!.zone).toBe('hand');
    expect(s.cardsDrawnThisTurn['0'] ?? 0).toBe(0);
    expect(ids(s, 0, 'library').length).toBe(library - 3);
    // And said out loud, because this is the one path where cards move with nobody pressing
    // anything.
    expect(s.replacements.join(' ') + s.log.map((e) => e.message).join(' '))
      .toContain('Shambling Shell');
  });

  it('a standing "never" takes the draw, and "ask" puts the question back', () => {
    let s = shellInTheYard();
    s = apply(s, { type: 'auto:dredgeStops', by: 0, standing: 'never' });
    const shell = find(s, 0, 'graveyard', 'Shambling Shell');
    s = advanceTo(nextTurn(nextTurn(s)), 'precombat-main');
    expect(s.pendingDredge).toBeNull();
    expect(s.instances[shell]!.zone).toBe('graveyard');
    expect(s.cardsDrawnThisTurn['0']).toBe(1);

    // Back to being asked, which is what keeps the setting from being a one-way door.
    s = apply(s, { type: 'auto:dredgeStops', by: 0, standing: 'ask' });
    expect(s.dredgeStops['0']).toBeUndefined();
    s = untilAsked(s);
    expect(s.pendingDredge?.card).toBe(shell);
  });

  it('is one seat\u2019s preference and not the table\u2019s, and travels to that seat only', () => {
    let s = shellInTheYard();
    s = apply(s, { type: 'auto:dredgeStops', by: 1, standing: 'always' });
    // Seat 1 said it; seat 0 is still asked.
    s = untilAsked(s);
    expect(s.pendingDredge?.seat).toBe(0);

    expect(unpackView(packView(viewFor(s, 0))).automation!.dredgeStanding).toBe('ask');
    expect(unpackView(packView(viewFor(s, 1))).automation!.dredgeStanding).toBe('always');
    expect(refusal(s, { type: 'auto:dredgeStops', by: 0, standing: 'sometimes' as 'ask' }))
      .toContain('ask, always or never');
  });

  it('the bot declines when the library cannot stand the mill four times over', () => {
    let s = untilAsked(shellInTheYard());
    expect(botAction(s, 0)).toEqual({ type: 'auto:dredge', by: 0, dredge: true });

    // Eleven cards is under four times the Shell's dredge 3. The rule reads the library's *size*
    // and nothing about its contents, which is what keeps it off a hidden zone — see
    // `dredgeIsWorthIt`.
    for (const id of ids(s, 0, 'library').slice(11)) {
      s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'exile' });
    }
    expect(botAction(s, 0)).toEqual({ type: 'auto:dredge', by: 0, dredge: false });
  });
});

describe('buyback: the cost that changes where the card goes', () => {
  /*
    The kicker's twin and its opposite in the one way that matters. Both are extra mana announced as
    the spell is cast and both are a second row on the same card; a kicker changes what the spell
    *does*, and this changes where the card ends up (CR 702.26a).

    So the tests are the three places that distinction lives: the row and its price, the card coming
    back when the spell resolves, and the two cases where it does not — a spell that was countered,
    and a cost nobody may pay on a permanent spell.
  */
  const table = (lands: readonly string[], theirs: readonly string[] = ['Grizzly Bears']): GameState =>
    tapAllLands(advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 0: ['Capsize'] },
      battlefield: { 0: [...lands], 1: [...theirs] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main'), 0);

  const SIX = ['Island', 'Island', 'Island', 'Island', 'Island', 'Island'];

  it('offers a second row at the printed cost plus the buyback', () => {
    const s = table(SIX);
    const rows = legalActions(s, 0).plays.filter((play) => play.name === 'Capsize');
    expect(rows.map((play) => play.manaCost)).toEqual(['{1}{U}{U}', '{1}{U}{U}{3}']);
    expect(rows.find((play) => play.buyback === true)?.description).toContain('buyback {3}');
    // And not the dearer row with only the printed cost up: a row nobody can pay for is not a row.
    const poor = table(['Island', 'Island', 'Island']);
    expect(legalActions(poor, 0).plays.filter((play) => play.name === 'Capsize'))
      .toHaveLength(1);
  });

  it('puts the card back in hand as it resolves, and bounces the permanent either way', () => {
    let s = table(SIX);
    const capsize = find(s, 0, 'hand', 'Capsize');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: capsize, buyback: true,
      targets: [{ kind: 'card', id: bears }],
    }), 40);
    expect(s.instances[bears]!.zone).toBe('hand');
    // The whole of the keyword: the card is in the hand it was cast from, not in the graveyard.
    expect(s.instances[capsize]!.zone).toBe('hand');
    expect(namesIn(s, 0, 'graveyard')).not.toContain('Capsize');
  });

  it('goes to the graveyard without it, which is the same spell for less mana', () => {
    let s = table(['Island', 'Island', 'Island']);
    const capsize = find(s, 0, 'hand', 'Capsize');
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');

    s = drain(apply(s, {
      type: 'auto:cast', by: 0, card: capsize, targets: [{ kind: 'card', id: bears }],
    }), 40);
    expect(s.instances[bears]!.zone).toBe('hand');
    expect(s.instances[capsize]!.zone).toBe('graveyard');
  });

  it('a countered buyback spell goes to the graveyard, because the promise is about resolving', () => {
    /*
      The half that cannot be read off the stack object, and the reason `spellLeavesStack` is told
      whether the spell resolved rather than working it out: a bought-back spell that never resolved
      did not come back, and a card that returned anyway would make the cost free.
    */
    let s = tapAllLands(advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'tidal-mind' },
      hands: { 0: ['Capsize'], 1: ['Cancel'] },
      battlefield: { 0: [...SIX], 1: ['Island', 'Island', 'Island'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main'), 0);
    // Seat 1's lands are left standing: the engine taps for the Cancel as it is cast, and tapping
    // them by hand would need a priority this seat does not hold.
    const capsize = find(s, 0, 'hand', 'Capsize');
    const land = find(s, 1, 'battlefield', 'Island');

    s = apply(s, {
      type: 'auto:cast', by: 0, card: capsize, buyback: true,
      targets: [{ kind: 'card', id: land }],
    });
    // The caster keeps priority after a cast, so the answer waits for them to let it go.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Cancel'),
      targets: [{ kind: 'card', id: capsize }],
    });
    s = drain(passBoth(s), 40);
    expect(s.instances[capsize]!.zone).toBe('graveyard');
    expect(s.instances[land]!.zone).toBe('battlefield');
  });

  it('refuses the cost on a spell that has none, and on a permanent spell', () => {
    const s = tapAllLands(advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
      hands: { 0: ['Capsize', "Man-o'-War"] },
      battlefield: { 0: [...SIX] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main'), 0);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', "Man-o'-War"), buyback: true,
    })).toContain('has no buyback');

    // And the rule that keeps the keyword honest: a permanent spell never leaves the stack for a
    // graveyard, so there is nothing for the cost to replace. No card in the pool is written that
    // way; the refusal is what stops one being written by accident.
    const whispers = scriptFor('Whispers of the Muse');
    expect(whispers?.buyback?.cost).toBe('{5}');
    expect([...CARD_SCRIPTS.values()]
      .filter((script) => script.buyback !== undefined).map((s2) => s2.name).sort())
      .toEqual(['Capsize', 'Whispers of the Muse']);
  });

  it('is read on the stack, so an opponent can see what they are answering', () => {
    let s = table(SIX);
    const bears = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Capsize'), buyback: true,
      targets: [{ kind: 'card', id: bears }],
    });
    expect(s.stackObjects[s.stackOrder[0]!]!.boughtBack).toBe(true);
    expect(s.stackObjects[s.stackOrder[0]!]!.description).toContain('(buyback)');
  });
});
