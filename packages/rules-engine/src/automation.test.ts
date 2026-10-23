/**
 * The automated turn: steps, priority, the stack, targeting and resolution.
 *
 * Every test here drives the engine with the actions a client sends and nothing else, because the
 * point is not that the functions work in isolation — it is that a real sequence of plays produces
 * a legal game. Where a rule is being asserted the CR reference is in the test name, so a failure
 * says which rule broke rather than which line did.
 */
import { describe, it, expect } from 'vitest';
import { legalActions, stackTop, viewFor } from './index.js';
import {
  advanceTo, apply, arena, countOf, find, ids, life, namesIn, nextTurn, passBoth, refusal, stackNames,
  tapAllLands,
} from './testkit.js';

describe('taking over a table', () => {
  it('starts the engine on the seat that is meant to go first', () => {
    const s = arena({ firstSeat: 1 });
    expect(s.activeSeat).toBe(1);
    expect(s.turn).toBe(1);
    expect(s.priority).toBe(1);
  });

  it('refuses to start twice', () => {
    const s = arena();
    expect(refusal(s, { type: 'auto:start', by: 0 })).toContain('already running');
  });

  it('refuses every automated action on a manual table', () => {
    const s = arena();
    const manual = { ...s, automated: false };
    expect(refusal(manual, { type: 'auto:pass', by: 0 })).toContain('not running the rules engine');
  });

  it('hands the table back to manual on a reset, so the engine can be restarted', () => {
    // Left automated, a reset would leave a board with no step, nobody holding priority, and
    // `auto:start` refusing to run again — a table nobody could play on.
    const s = apply(arena(), { type: 'game:reset', by: 0 });
    expect(s.automated).toBe(false);
    expect(s.started).toBe(false);
  });
});

describe('steps and turns', () => {
  it('walks the steps in order as priority is passed', () => {
    let s = arena({ battlefield: { 0: ['Mountain'] } });
    const seen: string[] = [s.step];
    for (let i = 0; i < 8 && s.step !== 'end'; i++) {
      s = passBoth(s);
      seen.push(s.step);
    }
    // No creatures on either side, so combat collapses to its end step (CR 508.1h).
    expect(seen).toEqual([
      'upkeep', 'draw', 'precombat-main', 'begin-combat', 'end-combat', 'postcombat-main', 'end',
    ]);
  });

  it('skips the first player’s first draw (CR 103.8a)', () => {
    let s = arena();
    const before = ids(s, 0, 'hand').length;
    s = advanceTo(s, 'precombat-main');
    expect(ids(s, 0, 'hand').length).toBe(before);
  });

  it('draws for every turn after the first', () => {
    let s = advanceTo(arena(), 'end');
    s = passBoth(s); // cleanup rolls into seat 1's turn
    expect(s.turn).toBe(2);
    expect(s.activeSeat).toBe(1);
    s = advanceTo(s, 'precombat-main');
    expect(ids(s, 1, 'hand').length).toBe(1);
  });

  it('passes the turn to the other seat and untaps its permanents', () => {
    let s = arena({ battlefield: { 1: ['Forest'] }, turn: 2, firstSeat: 0 });
    s = advanceTo(s, 'precombat-main');
    const forest = find(s, 1, 'battlefield', 'Forest');
    // Seat 1 taps its Forest while holding priority during seat 0's turn.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, { type: 'auto:activate', by: 1, card: forest, abilityIndex: 0 });
    expect(s.instances[forest]!.tapped).toBe(true);
    s = nextTurn(s);
    expect(s.activeSeat).toBe(1);
    expect(s.instances[forest]!.tapped).toBe(false);
  });

  it('empties mana pools when a step ends (CR 500.4)', () => {
    let s = arena({ battlefield: { 0: ['Mountain'] } });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    expect(s.pools['0']!.R).toBe(1);
    s = passBoth(s);
    expect(s.pools['0']?.R ?? 0).toBe(0);
  });

  it('makes a player discard down to seven at cleanup, and waits for them to choose', () => {
    const grip = ['Mountain', 'Mountain', 'Mountain', 'Shock', 'Shock', 'Lava Spike', 'Flame Slash', 'Hill Giant'];
    let s = arena({ hands: { 0: grip } });
    expect(ids(s, 0, 'hand').length).toBe(8);
    s = advanceTo(s, 'end');
    s = passBoth(s);
    // The engine stops rather than choosing a card for them.
    expect(s.step).toBe('cleanup');
    expect(s.pendingDiscard).toEqual({ seat: 0, count: 1 });
    expect(legalActions(s, 0).mustDiscard).toBe(1);
    expect(refusal(s, { type: 'auto:pass', by: 0 })).toContain('priority');

    s = apply(s, { type: 'auto:discard', by: 0, card: find(s, 0, 'hand', 'Hill Giant') });
    expect(s.pendingDiscard).toBeNull();
    expect(ids(s, 0, 'hand').length).toBe(7);
    expect(countOf(s, 0, 'graveyard', 'Hill Giant')).toBe(1);
    // And the turn has moved on.
    expect(s.turn).toBe(2);
    expect(s.activeSeat).toBe(1);
  });

  it('does not stop at cleanup with seven cards or fewer', () => {
    let s = arena({ hands: { 0: ['Mountain', 'Shock'] } });
    s = advanceTo(s, 'end');
    s = passBoth(s);
    expect(s.pendingDiscard).toBeNull();
    expect(s.turn).toBe(2);
  });

  it('refuses a discard from the wrong seat or with nothing owed', () => {
    const s = arena({ hands: { 1: ['Forest'] } });
    expect(refusal(s, { type: 'auto:discard', by: 1, card: find(s, 1, 'hand', 'Forest') }))
      .toContain('nothing to discard');
  });
});

describe('priority', () => {
  it('only lets the seat holding priority act', () => {
    const s = arena({ hands: { 1: ['Forest'] } });
    expect(s.priority).toBe(0);
    expect(refusal(s, { type: 'auto:pass', by: 1 })).toContain('do not have priority');
  });

  it('hands priority to the next seat on a pass, and back again when something happens', () => {
    let s = advanceTo(arena({
      battlefield: { 0: ['Mountain', 'Hill Giant'], 1: ['Plains'] },
      hands: { 1: ['Swords to Plowshares'] }, turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = apply(s, { type: 'auto:pass', by: 0 });
    expect(s.priority).toBe(1);
    expect(s.passed).toEqual([0]);
    // Seat 1 does something, so seat 0's pass is forgotten and the active player holds priority.
    s = tapAllLands(s, 1);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Swords to Plowshares'), targets: [{ kind: 'card', id: find(s, 0, 'battlefield', 'Hill Giant') }] });
    expect(s.passed).toEqual([]);
    // CR 117.3c: the player who cast the spell receives priority again, not the active player.
    expect(s.priority).toBe(1);
    // And once it resolves, priority goes back to the active player (CR 117.3b).
    s = passBoth(s);
    expect(s.stackOrder).toEqual([]);
    expect(s.priority).toBe(0);
  });
});

describe('playing lands', () => {
  it('plays one land per turn, at sorcery speed', () => {
    let s = advanceTo(arena({ hands: { 0: ['Mountain', 'Mountain'] } }), 'precombat-main');
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') });
    expect(countOf(s, 0, 'battlefield', 'Mountain')).toBe(1);
    expect(refusal(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') }))
      .toContain('already played a land');
  });

  it('refuses a land outside the main phase', () => {
    const s = arena({ hands: { 0: ['Mountain'] } }); // upkeep
    expect(refusal(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') }))
      .toContain('main phase');
  });

  it('refuses to cast a land, and to play a non-land as one', () => {
    let s = advanceTo(arena({ hands: { 0: ['Mountain', 'Shock'] } }), 'precombat-main');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Mountain') }))
      .toContain('auto:playLand');
    expect(refusal(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Shock') }))
      .toContain('is not a land');
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') });
    expect(s.landsPlayed['0']).toBe(1);
  });

  it('resets the land allowance on the next turn', () => {
    let s = advanceTo(arena({ hands: { 0: ['Mountain', 'Mountain'] }, firstSeat: 0 }), 'precombat-main');
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') });
    s = nextTurn(nextTurn(s)); // round the table and back to seat 0
    expect(s.activeSeat).toBe(0);
    expect(s.landsPlayed['0']).toBe(0);
  });
});

describe('mana abilities', () => {
  it('taps a land for mana without using the stack (CR 605.3a)', () => {
    let s = advanceTo(arena({ battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = apply(s, { type: 'auto:activate', by: 0, card: find(s, 0, 'battlefield', 'Mountain'), abilityIndex: 0 });
    expect(s.pools['0']!.R).toBe(1);
    expect(s.stackOrder).toEqual([]);
    // And it does not cost the player priority.
    expect(s.priority).toBe(0);
  });

  it('refuses to tap the same land twice', () => {
    let s = advanceTo(arena({ battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    const mountain = find(s, 0, 'battlefield', 'Mountain');
    s = apply(s, { type: 'auto:activate', by: 0, card: mountain, abilityIndex: 0 });
    expect(refusal(s, { type: 'auto:activate', by: 0, card: mountain, abilityIndex: 0 }))
      .toContain('already tapped');
  });

  it('refuses to tap a land somebody else controls', () => {
    const s = advanceTo(arena({ battlefield: { 1: ['Forest'] } }), 'precombat-main');
    expect(refusal(s, { type: 'auto:activate', by: 0, card: find(s, 1, 'battlefield', 'Forest'), abilityIndex: 0 }))
      .toContain('do not control');
  });

  it('will not tap a creature for mana on the turn it arrived (CR 302.6)', () => {
    let s = advanceTo(arena({ hands: { 1: ['Llanowar Elves'] }, battlefield: { 1: ['Forest'] }, turn: 2, firstSeat: 1 }), 'precombat-main');
    s = tapAllLands(s, 1);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Llanowar Elves') });
    s = passBoth(s);
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    expect(refusal(s, { type: 'auto:activate', by: 1, card: elves, abilityIndex: 0 }))
      .toContain('summoning sickness');
  });
});

describe('casting and the stack', () => {
  it('puts a spell on the stack, pays for it, and resolves it when everyone passes', () => {
    let s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });

    expect(stackNames(s)).toEqual(['Shock']);
    expect(ids(s, 0, 'stack').length).toBe(1);
    expect(s.pools['0']!.R).toBe(0);
    expect(s.priority).toBe(0);

    s = passBoth(s);
    expect(s.stackOrder).toEqual([]);
    expect(life(s, 1)).toBe(18);
    expect(countOf(s, 0, 'graveyard', 'Shock')).toBe(1);
  });

  it('refuses a spell with no mana to pay for it', () => {
    const s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] }))
      .toContain('cannot pay');
  });

  it('refuses a sorcery outside the main phase but allows an instant', () => {
    let s = arena({ hands: { 0: ['Lava Spike', 'Lightning Bolt'] }, battlefield: { 0: ['Mountain', 'Mountain'] } });
    s = advanceTo(s, 'draw');
    s = tapAllLands(s, 0);
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lava Spike'), targets: [{ kind: 'player', seat: 1 }] }))
      .toContain('main phase');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'player', seat: 1 }] });
    expect(stackNames(s)).toEqual(['Lightning Bolt']);
  });

  it('refuses a sorcery while something is on the stack', () => {
    let s = advanceTo(arena({ hands: { 0: ['Lava Spike', 'Lightning Bolt'] }, battlefield: { 0: ['Mountain', 'Mountain'] } }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'player', seat: 1 }] });
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lava Spike'), targets: [{ kind: 'player', seat: 1 }] }))
      .toContain('main phase');
  });

  it('resolves the stack last in, first out', () => {
    let s = advanceTo(arena({ hands: { 0: ['Shock', 'Lightning Bolt'] }, battlefield: { 0: ['Mountain', 'Mountain'] } }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'player', seat: 1 }] });
    expect(stackNames(s)).toEqual(['Shock', 'Lightning Bolt']);
    expect(stackTop(s)!.description).toBe('Lightning Bolt');

    s = passBoth(s);
    expect(life(s, 1)).toBe(17); // the Bolt resolved first
    expect(stackNames(s)).toEqual(['Shock']);
    s = passBoth(s);
    expect(life(s, 1)).toBe(15);
  });

  it('lets the other player respond before a spell resolves', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lightning Bolt'], 1: ['Giant Growth'] },
      battlefield: { 0: ['Mountain'], 1: ['Forest', 'Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'card', id: bear }] });
    s = apply(s, { type: 'auto:pass', by: 0 });

    // Seat 1 holds priority with the Bolt still on the stack, and saves the bear.
    expect(s.priority).toBe(1);
    s = tapAllLands(s, 1);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'), targets: [{ kind: 'card', id: bear }] });
    expect(stackNames(s)).toEqual(['Lightning Bolt', 'Giant Growth']);

    s = passBoth(s); // Giant Growth resolves: 5/5
    s = passBoth(s); // Bolt resolves: 3 damage marked
    expect(namesIn(s, 1, 'battlefield')).toContain('Grizzly Bears');
    expect(s.instances[bear]!.damage).toBe(3);
  });

  it('puts a permanent onto the battlefield and a spell into the graveyard', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Hill Giant'] }, battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hill Giant') });
    s = passBoth(s);
    expect(namesIn(s, 0, 'battlefield')).toContain('Hill Giant');
    expect(ids(s, 0, 'stack').length).toBe(0);
  });

  it('refuses to cast a card that is not in hand', () => {
    const s = advanceTo(arena({ battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'battlefield', 'Mountain') }))
      .toContain('not in your hand');
  });
});

describe('targeting', () => {
  it('requires the right number of targets', () => {
    let s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = tapAllLands(s, 0);
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock') }))
      .toMatch(/target/i);
  });

  it('refuses a creature target for a player-only spell', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lava Spike'] }, battlefield: { 0: ['Mountain'], 1: ['Grizzly Bears'] },
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lava Spike'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }],
    })).toMatch(/target/i);
  });

  it('refuses a hexproof creature as a target for an opponent (CR 702.11b)', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['Mountain'], 1: ['Sigarda, Host of Herons'] },
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    expect(refusal(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Sigarda, Host of Herons') }],
    })).toMatch(/target/i);
  });

  it('lets a hexproof creature’s own controller target it', () => {
    let s = advanceTo(arena({
      hands: { 1: ['Giant Growth'] }, battlefield: { 1: ['Forest', 'Sigarda, Host of Herons'] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    const sigarda = find(s, 1, 'battlefield', 'Sigarda, Host of Herons');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'), targets: [{ kind: 'card', id: sigarda }] });
    s = passBoth(s);
    expect(legalActions(s, 1).plays).toBeDefined();
    expect(s.effects.some((e) => e.scope.kind === 'cards' && e.scope.ids.includes(sigarda))).toBe(true);
  });

  it('counters a spell whose only target has gone (CR 608.2b)', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lightning Bolt', 'Shock'] },
      battlefield: { 0: ['Mountain', 'Mountain'], 1: ['Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    // Both aimed at a 2/2: the Shock on top resolves and kills it, so the Bolt beneath fizzles.
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'card', id: bear }] });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'card', id: bear }] });

    s = passBoth(s); // Shock resolves, bear dies to a state-based action
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
    const lifeBefore = life(s, 1);
    s = passBoth(s); // Bolt is countered on resolution
    expect(life(s, 1)).toBe(lifeBefore);
    expect(countOf(s, 0, 'graveyard', 'Lightning Bolt')).toBe(1);
    expect(s.log.at(-1)!.message).toContain('countered');
  });
});

describe('state-based actions', () => {
  it('moves a creature with lethal damage to the graveyard (CR 704.5g)', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['Mountain'], 1: ['Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }],
    });
    s = passBoth(s);
    expect(namesIn(s, 1, 'battlefield')).not.toContain('Grizzly Bears');
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
  });

  it('leaves a creature alive with damage below its toughness', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'card', id: courser }] });
    s = passBoth(s);
    expect(namesIn(s, 1, 'battlefield')).toContain('Centaur Courser');
    expect(s.instances[courser]!.damage).toBe(2);
  });

  it('clears marked damage at end of turn (CR 514.2)', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'], 1: ['Centaur Courser'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'card', id: courser }] });
    s = passBoth(s);
    expect(s.instances[courser]!.damage).toBe(2);
    s = nextTurn(s);
    expect(s.instances[courser]!.damage).toBe(0);
  });

  it('eliminates a player taken to zero life', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['Mountain'] },
    }), 'precombat-main');
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 1 ? { ...seat, life: 2 } : seat)) };
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'player', seat: 1 }] });
    s = passBoth(s);
    expect(s.seats[1]!.eliminated).toBe(true);
    expect(s.finished).toBe(true);
    expect(s.winnerSeat).toBe(0);
  });

  it('ends an until-end-of-turn effect when the turn does', () => {
    let s = advanceTo(arena({
      hands: { 1: ['Giant Growth'] }, battlefield: { 1: ['Forest', 'Grizzly Bears'] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'), targets: [{ kind: 'card', id: bear }] });
    s = passBoth(s);
    expect(s.effects.length).toBe(1);
    s = nextTurn(s);
    expect(s.effects.length).toBe(0);
  });
});

describe('legalActions', () => {
  it('offers the lands and spells a seat can actually play', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Mountain', 'Shivan Dragon', 'Shock'] }, battlefield: { 0: ['Mountain'] },
    }), 'precombat-main');
    const actions = legalActions(s, 0);
    expect(actions.hasPriority).toBe(true);
    expect(actions.isActivePlayer).toBe(true);
    const offered = actions.plays.map((p) => `${p.kind}:${p.name}`).sort();
    // Shock is affordable off the untapped Mountain; the six-mana Dragon is not.
    expect(offered).toEqual(['activate:Mountain', 'cast:Shock', 'land:Mountain']);
    s = apply(s, { type: 'auto:playLand', by: 0, card: find(s, 0, 'hand', 'Mountain') });
    // With the land played it is no longer on offer.
    expect(legalActions(s, 0).plays.filter((p) => p.kind === 'land')).toEqual([]);
  });

  it('judges affordability against mana that could still be made, not mana already floating', () => {
    // Nobody taps five lands and then decides what to cast, so an untapped land counts.
    const s = advanceTo(arena({
      hands: { 0: ['Hill Giant'] }, battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
    }), 'precombat-main');
    const actions = legalActions(s, 0);
    expect(actions.pool.R).toBe(0);
    expect(actions.potential.R).toBe(4);
    expect(actions.plays.some((p) => p.name === 'Hill Giant')).toBe(true);
  });

  it('offers nothing to the seat without priority', () => {
    const s = arena({ hands: { 1: ['Forest'] } });
    const actions = legalActions(s, 1);
    expect(actions.hasPriority).toBe(false);
    expect(actions.canPass).toBe(false);
    expect(actions.plays).toEqual([]);
  });

  it('says what passing will do', () => {
    let s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    expect(legalActions(s, 0).passLabel).toBe('Pass');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    s = apply(s, { type: 'auto:pass', by: 0 });
    expect(legalActions(s, 1).passLabel).toBe('Resolve Shock');
  });

  it('lists the legal targets for each play so the UI never has to work one out', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Lightning Bolt'] },
      battlefield: { 0: ['Mountain'], 1: ['Grizzly Bears', 'Sigarda, Host of Herons'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    const bolt = legalActions(s, 0).plays.find((p) => p.name === 'Lightning Bolt')!;
    expect(bolt.targetSpecs.length).toBe(1);
    const keys = bolt.candidates[0]!.map((t) => (t.kind === 'card' ? nameFor(s, t.id) : `player ${t.seat}`)).sort();
    // Both players and the 2/2 — but not hexproof Sigarda.
    expect(keys).toEqual(['Grizzly Bears', 'player 0', 'player 1']);
    s = apply(s, { type: 'auto:pass', by: 0 });
    expect(legalActions(s, 0).plays).toEqual([]);
  });

  it('offers no plays once the game is finished', () => {
    let s = advanceTo(arena({ hands: { 0: ['Lightning Bolt'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 1 ? { ...seat, life: 1 } : seat)) };
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'), targets: [{ kind: 'player', seat: 1 }] });
    s = passBoth(s);
    expect(s.finished).toBe(true);
    expect(legalActions(s, 0).plays).toEqual([]);
  });
});

const nameFor = (s: Parameters<typeof legalActions>[0], id: string): string =>
  s.cardDefs[s.instances[id]!.defKey]!.name;

describe('redaction still holds with the engine running', () => {
  it('shows a seat the stack but not the opponent’s hand', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Shock'], 1: ['Giant Growth'] }, battlefield: { 0: ['Mountain'] },
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    const view = viewFor(s, 0);
    const onStack = ids(s, 0, 'stack')[0]!;
    expect(view.cards[onStack]!.card!.name).toBe('Shock');
    const theirCard = ids(s, 1, 'hand')[0]!;
    expect(view.cards[theirCard]!.card).toBeUndefined();
  });
});
