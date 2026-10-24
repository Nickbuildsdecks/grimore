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
  STARTER_DECKS, characteristicsOf, legalActions, scriptFor, scriptedCardNames, viewFor,
} from './index.js';
import {
  advanceTo, apply, arena, choices, countOf, damageOn, decide, drain, find, ids, life, nameOf,
  namesIn, nextTurn, passBoth, refusal, stackNames,
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
      decks: { 1: 'tidal-mind' },
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
      decks: { 1: 'tidal-mind' },
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
      decks: { 1: 'tidal-mind' },
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

  it('Divination draws two', () => {
    let s = control(['Divination'], ['Island', 'Island', 'Island']);
    const before = ids(s, 1, 'hand').length;
    s = cast(s, 1, 'Divination');
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 2);
  });

  it('Sign in Blood draws two and costs two life', () => {
    let s = control(['Sign in Blood'], ['Swamp', 'Swamp']);
    const before = ids(s, 1, 'hand').length;
    s = cast(s, 1, 'Sign in Blood', [{ kind: 'player', seat: 1 }]);
    expect(ids(s, 1, 'hand').length).toBe(before - 1 + 2);
    expect(life(s, 1)).toBe(18);
  });

  it('Sign in Blood can be aimed at an opponent, which is what makes it removal', () => {
    let s = control(['Sign in Blood'], ['Swamp', 'Swamp']);
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 2 } : seat)) };
    s = cast(s, 1, 'Sign in Blood', [{ kind: 'player', seat: 0 }]);
    expect(s.seats[0]!.eliminated).toBe(true);
  });

  it('Tome Scour mills five', () => {
    let s = control(['Tome Scour'], ['Island']);
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
    let s = control(['Tome Scour', 'Child of Night'], ['Island', 'Island', 'Swamp'], ['Talrand, Sky Summoner']);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Tome Scour'), targets: [{ kind: 'player', seat: 0 }] });
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
      decks: { 1: 'tidal-mind' }, hands: { 0: ['Shivan Dragon', 'Lightning Bolt'], 1: ['Essence Scatter'] },
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
      decks: { 1: 'tidal-mind' }, hands: { 0: ['Lightning Bolt'], 1: ['Essence Scatter'] },
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

  it('registers each script under the name of a real card', () => {
    const printed = new Set(
      Object.values(STARTER_DECKS).flatMap((deck) =>
        [...deck.cards.map((c) => c.card), deck.commander!].map((c) => c.name),
      ),
    );
    // A script registered under a name no deck contains can never fire, and nothing would say so.
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
