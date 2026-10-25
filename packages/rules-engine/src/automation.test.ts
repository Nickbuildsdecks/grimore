/**
 * The automated turn: steps, priority, the stack, targeting and resolution.
 *
 * Every test here drives the engine with the actions a client sends and nothing else, because the
 * point is not that the functions work in isolation — it is that a real sequence of plays produces
 * a legal game. Where a rule is being asserted the CR reference is in the test name, so a failure
 * says which rule broke rather than which line did.
 */
import { describe, it, expect } from 'vitest';
import {
  autoPassFor, bottomOwed, createGame, legalActions, packView, pendingDeclaration, seatsToAct,
  stackTop, stillDeciding, unpackView, viewFor,
} from './index.js';
import {
  advanceTo, apply, applyAll, arena, countOf, find, ids, life, namesIn, nextTurn, passBoth, refusal,
  stackNames, tapAllLands, PLAYERS, WIRE_CAP,
} from './testkit.js';
import type { GameState } from './types.js';

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

describe('opening hands', () => {
  /** A dealt table that has not yet been handed to the engine. */
  const dealt = (): GameState =>
    applyAll(createGame({ id: 'g-mull', format: 'modern', players: PLAYERS, seed: 4242 }), [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
      { type: 'game:start', by: 0, firstSeat: 0 },
    ]);

  it('settles opening hands before the first turn, and nobody holds priority meanwhile', () => {
    let s = apply(dealt(), { type: 'auto:start', by: 0 });
    expect(s.automated).toBe(true);
    expect(s.openingHands).toBe(true);
    expect(s.priority).toBeNull();
    expect(stillDeciding(s)).toEqual([0, 1]);
    expect(legalActions(s, 0).mustSettleHand).toBe(true);

    s = apply(s, { type: 'auto:keep', by: 0 });
    expect(s.openingHands).toBe(true); // still waiting on the other seat
    s = apply(s, { type: 'auto:keep', by: 1 });
    // The last keep begins the game.
    expect(s.openingHands).toBe(false);
    expect(s.turn).toBe(1);
    expect(s.priority).toBe(0);
    expect(s.log.at(-1)!.message).toContain('begins turn 1');
  });

  it('will not begin a turn while somebody is still deciding', () => {
    const s = apply(dealt(), { type: 'auto:start', by: 0 });
    // Nothing a player can do advances the game until both hands are settled: no priority means
    // there is nobody to pass.
    expect(refusal(s, { type: 'auto:pass', by: 0 })).toContain('priority');
  });

  it('draws a fresh seven on a mulligan and remembers the debt (CR 103.4c)', () => {
    let s = apply(dealt(), { type: 'mulligan', by: 0, seat: 0 });
    expect(ids(s, 0, 'hand').length).toBe(7);
    expect(s.seats[0]!.mulligans).toBe(1);
    expect(bottomOwed(s, 0)).toBe(1);
    s = apply(s, { type: 'mulligan', by: 0, seat: 0 });
    expect(ids(s, 0, 'hand').length).toBe(7);
    expect(bottomOwed(s, 0)).toBe(2);
  });

  it('holds the game while a seat that mulliganed still owes cards to the bottom', () => {
    let s = apply(dealt(), { type: 'auto:start', by: 0 });
    s = apply(s, { type: 'mulligan', by: 0, seat: 0 });
    s = apply(s, { type: 'auto:keep', by: 1 });
    expect(bottomOwed(s, 0)).toBe(1);
    expect(refusal(s, { type: 'auto:keep', by: 0 })).toContain('exactly 1');
    expect(s.openingHands).toBe(true);
  });

  it('puts back exactly as many as were mulliganed, and no more', () => {
    let s = apply(apply(dealt(), { type: 'auto:start', by: 0 }), { type: 'mulligan', by: 0, seat: 0 });
    const hand = [...ids(s, 0, 'hand')];
    expect(refusal(s, { type: 'auto:keep', by: 0 })).toContain('exactly 1');
    expect(refusal(s, { type: 'auto:keep', by: 0, bottom: [hand[0]!, hand[1]!] })).toContain('exactly 1');
    expect(refusal(s, { type: 'auto:keep', by: 0, bottom: [hand[0]!, hand[0]!] })).toContain('exactly 1');

    s = apply(s, { type: 'auto:keep', by: 0, bottom: [hand[0]!] });
    expect(ids(s, 0, 'hand').length).toBe(6);
    expect(ids(s, 0, 'library').at(-1)).toBe(hand[0]);
    s = apply(s, { type: 'auto:keep', by: 1 });
    expect(s.openingHands).toBe(false);
  });

  it('refuses to put back a card that is not in your hand', () => {
    const s = apply(apply(dealt(), { type: 'auto:start', by: 0 }), { type: 'mulligan', by: 0, seat: 0 });
    const theirs = ids(s, 1, 'hand')[0]!;
    expect(refusal(s, { type: 'auto:keep', by: 0, bottom: [theirs] })).toContain('not in your hand');
  });

  it('un-keeps a hand that is mulliganed again, so the new debt has to be paid too', () => {
    let s = apply(dealt(), { type: 'auto:start', by: 0 });
    s = apply(s, { type: 'mulligan', by: 0, seat: 0 });
    s = apply(s, { type: 'auto:keep', by: 0, bottom: [ids(s, 0, 'hand')[0]!] });
    expect(s.kept).toEqual([0]);
    s = apply(s, { type: 'mulligan', by: 0, seat: 0 });
    expect(s.kept).toEqual([]);
    expect(bottomOwed(s, 0)).toBe(2);
    expect(s.openingHands).toBe(true);
  });

  it('lets a seat that never mulliganed simply say it is ready', () => {
    // Nothing goes back, but saying so is how the table tells "ready" from "still deciding".
    const s = apply(apply(dealt(), { type: 'auto:start', by: 0 }), { type: 'auto:keep', by: 1 });
    expect(s.kept).toEqual([1]);
    expect(s.log.at(-1)!.message).toContain('keeps');
  });

  it('refuses a keep once the game is under way', () => {
    const s = arena();
    expect(s.openingHands).toBe(false);
    expect(refusal(s, { type: 'auto:keep', by: 0 })).toContain('already begun');
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

  it('taps for a spell the player has not paid for yet', () => {
    // `legalActions` offers a spell when the player *could* make its mana, so the engine has to be
    // able to make it: without this it would refuse a play it had just offered.
    let s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    const mountain = find(s, 0, 'battlefield', 'Mountain');
    expect(s.instances[mountain]!.tapped).toBe(false);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    expect(s.instances[mountain]!.tapped).toBe(true);
    expect(stackNames(s)).toEqual(['Shock']);
    expect(s.log.at(-1)!.message).toContain('taps 1');
  });

  it('taps only as much as the spell needs', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain', 'Mountain', 'Mountain'] },
    }), 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    const tapped = [...ids(s, 0, 'battlefield')].filter((id) => s.instances[id]!.tapped);
    expect(tapped.length).toBe(1);
  });

  it('spends mana the player chose to float before tapping anything else', () => {
    // A player who tapped particular lands on purpose gets what they intended.
    let s = advanceTo(arena({
      hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain', 'Mountain'] },
    }), 'precombat-main');
    const first = find(s, 0, 'battlefield', 'Mountain');
    s = apply(s, { type: 'auto:activate', by: 0, card: first, abilityIndex: 0 });
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    const tapped = [...ids(s, 0, 'battlefield')].filter((id) => s.instances[id]!.tapped);
    expect(tapped).toEqual([first]);
  });

  it('refuses a spell when there is no mana and nothing left to tap', () => {
    let s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(s); // the step ends, so the floating mana is gone and the land is still tapped
    s = advanceTo(s, 'postcombat-main');
    expect(refusal(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] }))
      .toContain('cannot pay');
  });

  it('refuses a spell whose colour nothing on the battlefield can make', () => {
    // Four Mountains do not cast a white spell, however many there are.
    const s = advanceTo(arena({
      hands: { 1: ['Serra Angel'] }, battlefield: { 1: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    expect(refusal(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Serra Angel') }))
      .toContain('cannot pay');
    // And nothing was tapped in the attempt.
    expect([...ids(s, 1, 'battlefield')].every((id) => !s.instances[id]!.tapped)).toBe(true);
  });

  it('picks the right lands for a two-colour cost', () => {
    let s = advanceTo(arena({
      hands: { 1: ['Sigarda, Host of Herons'] },
      battlefield: { 1: ['Forest', 'Forest', 'Forest', 'Forest', 'Plains'] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    // {3}{G}{W} from four Forests and one Plains has exactly one solution, and the Plains is in it.
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Sigarda, Host of Herons') });
    expect(stackNames(s)).toEqual(['Sigarda, Host of Herons']);
    expect(s.instances[find(s, 1, 'battlefield', 'Plains')]!.tapped).toBe(true);
    expect([...ids(s, 1, 'battlefield')].filter((id) => s.instances[id]!.tapped).length).toBe(5);
  });

  it('taps for an activated ability’s cost too', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Shivan Dragon'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] },
    }), 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shivan Dragon') });
    s = passBoth(s);
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    // Six Mountains paid for the Dragon; the seventh pays for firebreathing.
    s = apply(s, { type: 'auto:activate', by: 0, card: dragon, abilityIndex: 0 });
    expect(s.stackOrder.length).toBe(1);
  });

  it('does not tap a creature that only just arrived to pay for something (CR 302.6)', () => {
    let s = advanceTo(arena({
      hands: { 1: ['Llanowar Elves', 'Grizzly Bears'] }, battlefield: { 1: ['Forest', 'Forest'] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Llanowar Elves') });
    s = passBoth(s);
    // One Forest paid for the Elves. {1}{G} for the Bears needs two more sources and there is only
    // one Forest left, because a summoning-sick Elf is not one.
    expect(refusal(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Grizzly Bears') }))
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

  /*
    A permanent gets its printed static abilities however it arrived.

    They used to be installed where a permanent *spell* resolved, which is one of several ways onto
    the battlefield: a reanimated Fog Bank prevented no damage, a Juggernaut put there by an effect
    did not have to attack, and a board laid out by hand — which is how the tabletop half of this
    app works, and how every test here builds a board — had no abilities at all. It was read as a
    quirk of the test helper three cards in a row before it was read as a bug.

    Arrivals are *detected* rather than announced (see `AutomationState.entered`), which makes that
    detection the one place that sees every way onto the battlefield; and the engine taking over a
    table computes the statics of whatever is already in play.
  */
  it('gives a permanent its statics however it got onto the battlefield', () => {
    let s = advanceTo(arena({
      decks: { 0: 'tidal-mind', 1: 'tidal-mind' },
      hands: { 0: ['Fog Bank'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    // Moved onto the battlefield rather than cast, which is the path that had no statics.
    const bank = find(s, 0, 'hand', 'Fog Bank');
    s = apply(s, { type: 'card:move', by: 0, card: bank, toZone: 'battlefield' });
    expect(s.entered).toContain(bank);
    // Any automated action drains the arrival, and the static is installed before anything could
    // have read the board without it.
    s = passBoth(s);
    expect(s.effects.some((effect) => effect.source === bank && effect.preventsCombatDamage === true))
      .toBe(true);
  });

  /*
    APNAP (CR 101.4, CR 603.3b): the active player's simultaneous triggers go on the stack first,
    so they resolve *last*.

    Before this the engine walked seats by index, which gets the rule right only when the active
    player happens to hold the lowest seat number. Measured over 60 four-seat pods: 34 batches of
    simultaneous triggers belonged to more than one player, and 2 of them went on in the wrong
    order. Not a dramatic bug — but it is the kind that decides one game in thirty and leaves no
    trace, and the fix is an ordering rather than a special case.
  */
  it('puts the active player\'s simultaneous triggers on the stack first (CR 603.3b)', () => {
    let s = advanceTo(arena({
      decks: { 0: 'skyward-writ', 1: 'skyward-writ' },
      battlefield: { 0: ['Soul Warden'], 1: ['Soul Warden', 'Plains'] },
      hands: { 1: ["Healer's Hawk"] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', "Healer's Hawk") });
    s = passBoth(s);
    // One trigger each, from the two Soul Wardens, raised by the same arrival.
    expect(s.stackOrder.length).toBe(2);
    const order = s.stackOrder.map((id) => s.stackObjects[id]!.controller);
    // Seat 1 is the active player, so theirs is at the bottom and seat 0's resolves first.
    expect(order).toEqual([1, 0]);
    expect(stackTop(s)!.controller).toBe(0);
  });

  /*
    "Until your next turn", which is the first duration here anchored to a seat rather than to a
    moment in the current turn.

    Goad is why it exists: cast on somebody else's turn, it has to survive the end of that turn and
    every turn in between, and end when the goading player's own turn begins. `end-of-turn` would
    have expired it before the combat it exists to force, which is no card at all.
  */
  it('keeps an until-your-next-turn effect until that seat untaps again', () => {
    let s = advanceTo(arena({
      format: 'pod', seats: 4,
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      hands: { 0: ['Disrupt Decorum'] },
      // A Wall, so the turns in between can be walked through without declaring its attack: a
      // goaded creature that cannot attack is not required to, which is the restriction beating
      // the requirement and is asserted on its own in `combat.test.ts`.
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], 1: ['Wall of Air'] },
      turn: 5, firstSeat: 0,
    }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Disrupt Decorum') });
    s = passBoth(s);
    expect(s.effects.length).toBe(1);
    expect(s.effects[0]!.duration).toBe('until-controllers-next-turn');

    // Through the goader's own cleanup, and through all three other turns.
    for (const seat of [1, 2, 3]) {
      s = nextTurn(s);
      expect(s.activeSeat).toBe(seat);
      expect(s.effects.length).toBe(1);
    }
    // And gone the moment the turn it was keyed to begins.
    s = nextTurn(s);
    expect(s.activeSeat).toBe(0);
    expect(s.effects.length).toBe(0);
  });

  /*
    A player who leaves the game takes the attacks aimed at them with them (CR 800.4a) — and
    somebody holds priority afterwards.

    Found by playing four-seat pods against themselves: two games in eight stopped dead at
    declare-blockers on turn forty-odd, with attacks on the table, nobody owed a declaration and
    `priority` null, which is a state the engine has no reading of at all. Hellrider is the card
    that gets there. Its controller declares a swing at a player low on life, its trigger — one
    damage per attacking creature — kills them while the attack is still on the table, and the
    block that was owed a moment ago is no longer owed; the code that hands priority back only
    runs when a question is *answered*, so nothing ran it. `playout.test.ts` holds the two seeds
    that reproduce the whole deadlock; this is the rule on a board of four cards.
  */
  it('removes attacks on a player who has left from combat (CR 800.4a)', () => {
    let s = arena({
      format: 'pod', seats: 4,
      battlefield: { 0: ['Hellrider', 'Monastery Swiftspear', 'Raging Goblin', 'Firebrand Archer'] },
      turn: 3, firstSeat: 0,
    });
    // One damage per attacker is four, which is one more than this seat has.
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 1 ? { ...seat, life: 3 } : seat)) };
    s = advanceTo(s, 'declare-attackers');
    const attackers = [...ids(s, 0, 'battlefield')].map((attacker) => ({ attacker, defender: 1 as const }));
    expect(attackers.length).toBe(4);
    s = apply(s, { type: 'auto:attack', by: 0, attackers });
    // Four triggers on the stack, one per attacking creature, and the attack still on the table.
    expect(s.stackOrder.length).toBe(4);
    expect(s.combat.attacks.length).toBe(4);

    // Resolved one at a time, which is how a real table gets here: the fourth is the one that
    // kills, and it does it with the combat it was triggered by still standing.
    for (let i = 0; i < 4; i += 1) s = passBoth(s);
    expect(s.seats[1]!.eliminated).toBe(true);
    expect(life(s, 1)).toBeLessThanOrEqual(0);

    // The attacks go with the player. Leaving them would leave an attack nobody can block, and a
    // declare-blockers step nobody is owed.
    expect(s.combat.attacks.filter((a) => a.defender === 1)).toEqual([]);
    // And the table is still a table: somebody is on the clock, and it is not the seat that left.
    expect(pendingDeclaration(s)).toBeNull();
    expect(s.priority).not.toBeNull();
    expect(s.seats[s.priority!]!.eliminated).toBe(false);
    expect(seatsToAct(s).length).toBeGreaterThan(0);
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

describe('passing for a player with nothing to do', () => {
  it('is on at a real table, and off for the lock-step tests in this file', () => {
    // Off for everybody is what a test that walks a game step by step asks for, and on for
    // everybody is what a real table starts as. Both are the same list, full or empty.
    expect(arena().autoPassOff).toEqual([0, 1]);
    expect(arena({ autoPass: true }).autoPassOff).toEqual([]);
  });

  it('hands control over at the first moment there is something to do', () => {
    // Nobody can act in the untap, upkeep or draw steps of turn one with an empty board, so the
    // game opens where the game actually starts: the first main phase, with a land to play.
    const s = arena({ autoPass: true, hands: { 0: ['Mountain'] }, battlefield: { 0: ['Mountain'] } });
    expect(s.step).toBe('precombat-main');
    expect(s.priority).toBe(0);
    expect(legalActions(s, 0).plays.map((p) => p.name)).toContain('Mountain');
  });

  it('asks the player who can act, even when it is not their turn', () => {
    // Seat 0 has nothing in its upkeep; seat 1 is holding an instant, so seat 1 is the one asked.
    const s = arena({
      autoPass: true,
      hands: { 0: ['Mountain'], 1: ['Giant Growth'] },
      battlefield: { 1: ['Forest', 'Grizzly Bears'] },
    });
    expect(s.activeSeat).toBe(0);
    expect(s.priority).toBe(1);
    expect(legalActions(s, 1).plays.map((p) => p.name)).toContain('Giant Growth');
  });

  it('does not count a mana ability as something to do', () => {
    // Floating mana you have nothing to spend on is not a reason to hold priority — and counting
    // it would mean a player with an untapped land never auto-passed at all. Seat 1 has only a
    // Forest, so it is passed over and play reaches seat 0's main phase.
    const s = arena({ autoPass: true, hands: { 0: ['Mountain'] }, battlefield: { 1: ['Forest'] } });
    expect(s.step).toBe('precombat-main');
    expect(s.priority).toBe(0);
  });

  it('never carries play past the start of somebody’s turn', () => {
    // With nothing on either side there is nothing to do all game, so the only thing that stops
    // the engine is the turn boundary. A player always sees their own turn begin.
    const s = arena({ autoPass: true });
    expect(s.turn).toBe(2);
    expect(s.step).toBe('upkeep');
  });

  it('stops for a combat declaration, which is not a priority decision', () => {
    const s = arena({ autoPass: true, battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 });
    expect(s.step).toBe('declare-attackers');
    expect(pendingDeclaration(s)).toEqual({ kind: 'attackers', seats: [0] });
    expect(s.priority).toBeNull();
  });

  it('stops for a discard to hand size', () => {
    // Nine lands and nothing else: one is playable, and after that there is genuinely nothing to
    // do for the rest of the turn — so the next thing the player is asked is the discard.
    const grip = Array.from({ length: 9 }, () => 'Mountain');
    let s = arena({ autoPass: true, hands: { 0: grip } });
    const land = legalActions(s, 0).plays.find((p) => p.kind === 'land')!;
    s = apply(s, { type: 'auto:playLand', by: 0, card: land.card });
    expect(s.pendingDiscard).toEqual({ seat: 0, count: 1 });
    expect(s.step).toBe('cleanup');
  });

  it('resolves a spell nobody can respond to without asking anybody', () => {
    let s = arena({ autoPass: true, hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } });
    // Shock is an instant, so the very first priority of the game is one the player can use —
    // the engine stops in the upkeep rather than walking past a step they could act in.
    expect(s.step).toBe('upkeep');
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    // Neither player has anything left, so the Shock resolved inside the action that cast it.
    expect(s.stackOrder).toEqual([]);
    expect(life(s, 1)).toBe(18);
  });

  it('still offers a response to a player who has one', () => {
    let s = arena({
      autoPass: true,
      hands: { 0: ['Lightning Bolt'], 1: ['Giant Growth'] },
      battlefield: { 0: ['Mountain'], 1: ['Forest', 'Grizzly Bears'] },
      turn: 2, firstSeat: 0,
    });
    s = apply(s, {
      type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Lightning Bolt'),
      targets: [{ kind: 'card', id: find(s, 1, 'battlefield', 'Grizzly Bears') }],
    });
    // The Bolt is still on the stack, because seat 1 can save the bear and must be asked.
    expect(stackNames(s)).toEqual(['Lightning Bolt']);
    expect(s.priority).toBe(1);
  });

  it('can be turned off mid-game, and back on', () => {
    let s = arena({ autoPass: true, hands: { 0: ['Mountain'] } });
    s = apply(s, { type: 'auto:stops', by: 0, autoPass: false });
    expect(s.autoPassOff).toEqual([0]);
    const step = s.step;
    // With it off for seat 0, seat 0 is asked again at the next step — and seat 1, who did not
    // ask for anything, is still passed for, so play comes straight back round.
    s = apply(s, { type: 'auto:pass', by: 0 });
    expect(s.step).not.toBe(step);
    expect(s.priority).toBe(0);
    // Back on, and play runs to the next thing seat 0 could actually do.
    s = apply(s, { type: 'auto:stops', by: 0, autoPass: true });
    expect(s.autoPassOff).toEqual([]);
  });

  /*
    Stops are one player's preference, and the list is what makes that expressible.

    It was a single boolean, so the seat that asked to see every step turned auto-pass off for the
    *other* player too — who was then asked twenty-five times a turn to confirm they still had
    nothing to do, for a setting they never touched. Two people at one table can reasonably want
    different answers to "how do you want to be asked".
  */
  it('passes for the player who wants it while stopping for the one who does not', () => {
    // Seat 1 wants every priority. Seat 0 does not, and holds the only thing worth doing.
    let s = arena({ autoPass: true, hands: { 0: ['Mountain'] } });
    s = apply(s, { type: 'auto:stops', by: 1, autoPass: false });
    expect(autoPassFor(s, 0)).toBe(true);
    expect(autoPassFor(s, 1)).toBe(false);

    const step = s.step;
    const land = legalActions(s, 0).plays.find((p) => p.kind === 'land')!;
    s = apply(s, { type: 'auto:playLand', by: 0, card: land.card });
    // Play stops on seat 1 in the same step, because seat 1 asked for it.
    expect(s.step).toBe(step);
    expect(s.priority).toBe(1);
    expect(legalActions(s, 1).plays).toEqual([]);

    // And seat 1 passing walks the rest of the turn without ever asking seat 0 again, because
    // seat 0 never asked to be. Before the list this was impossible to express either way round.
    s = apply(s, { type: 'auto:pass', by: 1 });
    expect(s.priority).toBe(1);
    expect(s.step).not.toBe(step);
  });

  it('tells each seat about its own setting and nobody else\'s', () => {
    // The table's toggle reads this, so it has to be the viewer's own answer: a shared boolean is
    // how one player's press used to move the other player's switch.
    let s = arena({ autoPass: true });
    s = apply(s, { type: 'auto:stops', by: 1, autoPass: false });
    expect(viewFor(s, 0).automation!.autoPass).toBe(true);
    expect(viewFor(s, 1).automation!.autoPass).toBe(false);
    // A spectator is never asked for anything, so they see the default rather than somebody's.
    expect(viewFor(s, null).automation!.autoPass).toBe(true);
  });

  it('keeps each seat\'s setting across a rematch', () => {
    // Carried as a list for the same reason it is stored as one: a boolean would have handed one
    // player's preference to the other on the way into the next game.
    let s = arena({ autoPass: true });
    s = apply(s, { type: 'auto:stops', by: 1, autoPass: false });
    s = { ...s, finished: true, winnerSeat: 0 };
    s = apply(s, { type: 'game:rematch', by: 0 });
    expect(s.autoPassOff).toEqual([1]);
  });

  it('says in the log where play ended up, so a skipped step is not a mystery', () => {
    const s = arena({ autoPass: true, hands: { 0: ['Mountain'] } });
    const entry = s.log.at(-1)!;
    expect(entry.message).toMatch(/—/);
    expect(entry.data?.['autoPassed']).toBeGreaterThan(0);
  });
});

describe('what the view carries', () => {
  it('has no automation block on a manual table, which is how a client picks its interface', () => {
    const s = arena();
    expect(viewFor({ ...s, automated: false }, 0).automation).toBeNull();
  });

  it('carries the step, priority, stack and this seat’s own legal moves', () => {
    let s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = tapAllLands(s, 0);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Shock'), targets: [{ kind: 'player', seat: 1 }] });
    const view = viewFor(s, 0);
    const auto = view.automation!;
    expect(auto.step).toBe('precombat-main');
    expect(auto.stepLabel).toBe('Main phase 1');
    expect(auto.priority).toBe(0);
    expect(auto.stack.map((o) => o.description)).toEqual(['Shock']);
    // A spell's stack object points at its card instance, so the client can draw the actual card.
    expect(view.cards[auto.stack[0]!.card!]!.card!.name).toBe('Shock');
    expect(auto.you!.seat).toBe(0);
    expect(auto.you!.hasPriority).toBe(true);
  });

  it('gives each seat only its own legal moves', () => {
    const s = advanceTo(arena({ hands: { 0: ['Shock'] }, battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    expect(viewFor(s, 0).automation!.you!.hasPriority).toBe(true);
    expect(viewFor(s, 1).automation!.you!.hasPriority).toBe(false);
    // A spectator gets the public state and nobody's moves.
    expect(viewFor(s, null).automation!.you).toBeNull();
  });

  it('sends no power or toughness for a land, which would otherwise draw as a 0/0', () => {
    const s = arena({ battlefield: { 0: ['Mountain'] } });
    const land = viewFor(s, 0).cards[find(s, 0, 'battlefield', 'Mountain')]!;
    expect(land.power).toBeUndefined();
    expect(land.toughness).toBeUndefined();
    expect(land.damage).toBeUndefined();
  });

  it('sends the computed power and toughness, not the printed ones', () => {
    // A client reading power off the card would draw a 2/2 the engine knows is a 5/5.
    let s = advanceTo(arena({
      hands: { 1: ['Giant Growth'] }, battlefield: { 1: ['Forest', 'Grizzly Bears'] },
      turn: 2, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'), targets: [{ kind: 'card', id: bear }] });
    s = passBoth(s);
    const card = viewFor(s, 0).cards[bear]!;
    expect(card.card!.power).toBe('2');
    expect([card.power, card.toughness]).toEqual([5, 5]);
    expect(card.damage).toBe(0);
  });

  it('says who the engine is waiting on, and for what', () => {
    let s = advanceTo(arena({ battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0 }), 'declare-attackers');
    expect(viewFor(s, 0).automation!.awaiting).toEqual({ kind: 'attackers', seats: [0] });
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: find(s, 0, 'battlefield', 'Hill Giant'), defender: 1 }] });
    s = passBoth(s);
    expect(viewFor(s, 1).automation!.awaiting).toEqual({ kind: 'blockers', seats: [1] });
    expect(viewFor(s, 1).automation!.you!.mustDeclare).toBe('blockers');
  });

  it('shows a card in hand only to the seat holding it, even with the engine running', () => {
    const s = arena({ hands: { 0: ['Shock'], 1: ['Giant Growth'] } });
    const theirs = ids(s, 1, 'hand')[0]!;
    expect(viewFor(s, 0).cards[theirs]!.card).toBeUndefined();
    expect(viewFor(s, 1).cards[theirs]!.card!.name).toBe('Giant Growth');
  });
});

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

  it('says each card definition once on the wire, and puts them back on arrival', () => {
    // The property worth asserting is that packing is invisible: a consumer that reads the
    // unpacked view cannot tell. The size claim is the point of doing it, and it is checked on a
    // board where it actually bites — a library open, which is fifty cards and fifteen printings.
    let s = advanceTo(arena({
      hands: { 1: ['Rampant Growth'] }, battlefield: { 1: ['Forest', 'Forest'] }, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));
    expect(s.seats[1]!.searching).toBe(true);

    const view = viewFor(s, 1);
    const packed = packView(view);
    expect(unpackView(packed)).toEqual(view);
    // Fewer definitions than cards, which is the entire mechanism: a library of twenty-two
    // Forests says "Forest" once.
    expect(Object.keys(packed.defs).length).toBeLessThan(Object.keys(view.cards).length);
    // `viewFor` names every field it sends, so a new field on the state does not travel by
    // accident — but `died` is engine bookkeeping about what has just been put into a graveyard,
    // and a seat reading it would learn the order of deaths it is not entitled to reason about.
    // Asserted rather than assumed, because the cost of being wrong is a leak.
    expect(JSON.stringify(view)).not.toContain('"died"');
    expect(JSON.stringify(packed)).not.toContain('"died"');
    // And the same for `vanished`, which is the newest piece of engine bookkeeping on the state:
    // a map of tokens that have stopped existing, kept only long enough to raise their triggers.
    expect(JSON.stringify(view)).not.toContain('"vanished"');
    expect(JSON.stringify(packed)).not.toContain('"vanished"');

    const inline = JSON.stringify(view).length;
    const wire = JSON.stringify(packed).length;
    /*
      Roughly two thirds, measured rather than pinned: the exact ratio moves with how repetitive
      the deck is, and an assertion tight enough to break when a deck list is edited is noise.

      It moved from 0.6 when the pool gained cards with long oracle text that every deck runs one
      of. Dedup saves nothing on a singleton — its definition is sent once either way — so each
      one-of with a paragraph of rules text pushes this ratio towards 1 while changing nothing
      about whether the mechanism works. The two assertions either side of it are the ones that
      do: fewer definitions than cards, and twice this payload still inside the cap.
    */
    expect(wire).toBeLessThan(inline * 0.7);
    // And the headroom this was for: a 100-card Commander library is roughly twice this one, and
    // the cap is WIRE_CAP. Asserted on the measurement rather than on faith.
    expect(wire * 2).toBeLessThan(WIRE_CAP);
  });

  it('opens a searcher’s own library to them, and to nobody else', () => {
    // Searching a library is the one moment a player may read their own, and the moment where a
    // leak would be worst: the whole remaining deck, in order, for the rest of the game.
    let s = advanceTo(arena({
      hands: { 1: ['Rampant Growth'] }, battlefield: { 1: ['Forest', 'Forest'] }, firstSeat: 1,
    }), 'precombat-main');
    s = tapAllLands(s, 1);
    s = passBoth(apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Rampant Growth') }));
    expect(s.pendingDecision).not.toBeNull();

    const mine = viewFor(s, 1);
    const theirs = viewFor(s, 0);
    const libraryKey = `1:library`;
    expect(mine.zones[libraryKey]!.length).toBeGreaterThan(0);
    expect(theirs.zones[libraryKey]).toBeUndefined();

    // The candidates are instance ids of cards in a hidden zone, so they travel only inside the
    // searcher's own `you` block — never in the public part of the view that both seats receive.
    expect(mine.automation!.you!.mustDecide!.candidates.length).toBeGreaterThan(0);
    expect(theirs.automation!.you!.mustDecide).toBeNull();
    // The other seat is told that somebody is deciding, and what about, but not the answer.
    expect(theirs.automation!.awaiting).toEqual({
      kind: 'decide', seats: [1], prompt: 'Search your library for a basic land card',
    });
    // Not one card in that library reaches the other seat's view, by id or by identity. The spell
    // itself is on the stack and public, which is the point of checking the library rather than
    // the page: a name can be there legitimately, a library card cannot.
    for (const id of ids(s, 1, 'library')) expect(theirs.cards[id]).toBeUndefined();

    // And once answered, the library closes again.
    const chosen = s.pendingDecision!.candidates[0]!;
    s = apply(s, { type: 'auto:decide', by: 1, cards: [chosen] });
    expect(viewFor(s, 1).zones[libraryKey]).toBeUndefined();
  });
});
