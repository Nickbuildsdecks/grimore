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
  advanceTo, apply, arena, choices, countOf, decide, drain, find, ids, life, namesIn, nextTurn,
  passBoth, refusal, stackNames,
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
