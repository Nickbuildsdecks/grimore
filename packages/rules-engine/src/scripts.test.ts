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
  STARTER_DECKS, characteristicsOf, legalActions, scriptFor, scriptedCardNames,
} from './index.js';
import {
  advanceTo, apply, arena, choices, countOf, decide, find, ids, life, namesIn, nextTurn,
  passBoth, refusal,
} from './testkit.js';
import type { GameState, SeatIndex } from './types.js';
import type { Target } from './turnTypes.js';

const BASICS = new Set(['Mountain', 'Forest', 'Plains']);

/**
 * Sets a seat up in its main phase with every land tapped for mana and `hand` in hand.
 *
 * `lands` is either a count of the seat's own basic, or an explicit list when the spell needs more
 * than one colour — seat 1 plays green-white, so a Sigarda test has to ask for a Plains by name.
 */
function withMana(
  seat: SeatIndex, hand: readonly string[], lands: number | readonly string[], extra: readonly string[] = [],
): GameState {
  const names = typeof lands === 'number'
    ? Array.from({ length: lands }, () => (seat === 0 ? 'Mountain' : 'Forest'))
    : lands;
  let s = arena({
    hands: { [seat]: hand }, battlefield: { [seat]: [...names, ...extra] },
    turn: 2, firstSeat: seat,
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
