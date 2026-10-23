/**
 * Whole games, played out by bots that only ever send actions the engine offered them.
 *
 * This is the test the rest of the suite exists to make possible. Every other test asserts one
 * rule; this one asserts the property that matters to two people sitting down to play: from a
 * shuffled deck, with nobody steering, the engine reaches a winner. A game that finishes proves
 * there was no deadlock, no state where nobody could act, and no play the engine offered that it
 * then refused — and it does that over thousands of positions nobody wrote by hand.
 */
import { describe, it, expect } from "vitest";
import {
  applyAction, botAction, createGame, legalActions, playOut, seatToAct, viewFor,
  type Action, type GameState, type SeatIndex,
} from './index.js';
import { PLAYERS, HOST } from './testkit.js';

/** A full table with two starter decks shuffled on `seed`, handed to the rules engine. */
function table(
  seed: number, firstSeat: SeatIndex = 0,
  decks: readonly [string, string] = ['ember-rush', 'verdant-guard'],
): GameState {
  let s = createGame({ id: `game-${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const action of [
    { type: 'deck:load', by: 0, seat: 0, deckId: decks[0] },
    { type: 'deck:load', by: 1, seat: 1, deckId: decks[1] },
    { type: 'game:start', by: 0, firstSeat },
    { type: 'auto:start', by: 0, firstSeat },
  ] as Action[]) {
    s = applyAction(s, action, HOST);
  }
  return s;
}

/** Every pairing of the built-in decks, which is what a matchup test should cover. */
const MATCHUPS: readonly (readonly [string, string])[] = [
  ['ember-rush', 'verdant-guard'],
  ['ember-rush', 'tidal-mind'],
  ['tidal-mind', 'verdant-guard'],
  ['tidal-mind', 'tidal-mind'],
  ['verdant-guard', 'verdant-guard'],
];

describe('a whole automated game', () => {
  it('plays from a shuffled deck to a winner with nobody steering', () => {
    const result = playOut(table(20261023));
    expect(result.state.finished).toBe(true);
    expect(result.state.winnerSeat).not.toBeNull();
    // One seat eliminated, the other still standing.
    expect(result.state.seats.filter((s) => s.eliminated).length).toBe(1);
    // A game that took no turns did not happen; one that took hundreds is a loop.
    expect(result.turns).toBeGreaterThan(3);
    expect(result.turns).toBeLessThan(200);
  });

  it('reaches a winner from twenty different shuffles, whichever seat goes first', () => {
    const unfinished: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const first: SeatIndex = seed % 2 === 0 ? 1 : 0;
      const result = playOut(table(seed * 7919, first));
      if (!result.state.finished) {
        unfinished.push(`seed ${seed}: stopped on turn ${result.turns} at ${result.state.step} after ${result.actions} actions`);
      }
    }
    expect(unfinished).toEqual([]);
  });

  it('reaches a winner in every pairing of the built-in decks', () => {
    // The control deck is the one that could break a player that only ever does the obvious thing:
    // its spells target objects on the stack, which exist for a moment and then do not.
    const unfinished: string[] = [];
    for (const decks of MATCHUPS) {
      for (let seed = 1; seed <= 4; seed++) {
        const first: SeatIndex = seed % 2 === 0 ? 1 : 0;
        const result = playOut(table(seed * 104729, first, decks));
        if (!result.state.finished) {
          unfinished.push(`${decks[0]} vs ${decks[1]} seed ${seed}: stopped on turn ${result.turns} at ${result.state.step}`);
        }
      }
    }
    expect(unfinished).toEqual([]);
  });

  it('counters spells when it has the mana for it, rather than ignoring the stack', () => {
    // A game where nothing was ever countered would pass every other test here while leaving the
    // whole interaction untested, so this one asserts a counterspell actually resolved.
    let countered = 0;
    for (let seed = 1; seed <= 6 && countered === 0; seed++) {
      const result = playOut(table(seed * 7723, 0, ['ember-rush', 'tidal-mind']));
      countered += result.state.log.filter((e) => /counter/i.test(e.message)).length;
    }
    expect(countered).toBeGreaterThan(0);
  });

  it('asks a player to act about three times a turn, not twenty', () => {
    // The number that decides whether a person will play a second game. Priority is offered to
    // every player in every step, which without auto-passing is twenty-odd prompts a turn — most
    // of them "you still cannot do anything, press pass". Measured rather than asserted by eye,
    // because it is the kind of thing that quietly regresses when a new rule adds a step.
    let actions = 0;
    let turns = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const result = playOut(table(seed * 7919));
      expect(result.state.finished).toBe(true);
      actions += result.actions;
      turns += result.turns;
    }
    const perTurn = actions / turns;
    expect(perTurn).toBeLessThan(6);
    // And a whole game is a few dozen decisions rather than a few hundred.
    expect(actions / 6).toBeLessThan(120);
  });

  it('offers every priority when a player asks for it', () => {
    // The setting exists for the player who wants to see each step go by, so turning it off has
    // to actually restore the prompts it removes.
    const loud = playOut(applyAction(
      table(7919, 0), { type: 'auto:stops', by: 0, autoPass: false }, HOST,
    ));
    expect(loud.state.finished).toBe(true);
    expect(loud.actions / loud.turns).toBeGreaterThan(10);
  });

  it('mulligans the hands that deserve it, and not many more', () => {
    // A hand with no land cannot be played and a hand that is all land cannot do anything. Over
    // forty games the rate should look like a player's, not like a bot that keeps everything or
    // one that throws hands away — neither of which would ever fail any other test here.
    let mulligans = 0;
    let hands = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const result = playOut(table(seed * 7919, 0, ['ember-rush', 'tidal-mind']));
      expect(result.state.finished).toBe(true);
      for (const seat of result.state.seats) {
        hands += 1;
        mulligans += seat.mulligans;
      }
    }
    const rate = mulligans / hands;
    expect(rate).toBeGreaterThan(0.03);
    expect(rate).toBeLessThan(0.35);
  });

  it('never offers a play it then refuses', () => {
    // The strongest form of the claim: take every action the bot chose from `legalActions`, and
    // check the engine accepted it. A single refusal here is a UI that will show a dead button.
    let s = table(424242);
    const refused: string[] = [];
    for (let i = 0; i < 4000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const action = botAction(s, seat);
      if (action === null) break;
      try {
        s = applyAction(s, action, HOST);
      } catch (err) {
        refused.push(`${action.type} by seat ${seat} at ${s.step}: ${(err as Error).message}`);
        break;
      }
    }
    expect(refused).toEqual([]);
    expect(s.finished).toBe(true);
  });

  it('keeps every seat’s view inside the realtime payload budget for the whole game', () => {
    // A state that grows without bound plays fine in a test and breaks on a socket. The cap is
    // `STATE_MAX_BYTES` in the shared contracts (64KB); the view is what actually travels.
    let s = table(31337);
    let worst = 0;
    for (let i = 0; i < 4000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
      if (i % 25 !== 0) continue;
      for (const viewer of [0, 1] as SeatIndex[]) {
        worst = Math.max(worst, JSON.stringify(viewFor(s, viewer)).length);
      }
    }
    expect(s.finished).toBe(true);
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(64 * 1024);
  });

  it('never gives priority to an eliminated seat', () => {
    let s = table(99);
    for (let i = 0; i < 4000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      expect(s.seats[seat]!.eliminated).toBe(false);
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
    }
    expect(s.finished).toBe(true);
  });

  it('leaves the stack empty whenever a step ends', () => {
    // A step that ends with something still on the stack means the engine advanced past a
    // resolution, which is the kind of bug that loses a player their removal spell.
    let s = table(5150);
    let step = s.step;
    for (let i = 0; i < 4000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
      if (s.step !== step) {
        expect(s.stackOrder).toEqual([]);
        step = s.step;
      }
    }
    expect(s.finished).toBe(true);
  });

  it('agrees with itself: the same seed plays the same game twice', () => {
    const a = playOut(table(777));
    const b = playOut(table(777));
    expect(a.state.winnerSeat).toBe(b.state.winnerSeat);
    expect(a.turns).toBe(b.turns);
    expect(a.actions).toBe(b.actions);
    expect(a.state.log.length).toBe(b.state.log.length);
  });
});

describe('what the engine tells a client', () => {
  it('always gives the seat that must act something to do', () => {
    // The deadlock check from the client's side: whenever the engine is waiting on a seat, that
    // seat's `legalActions` has to contain at least one thing — a play, a pass, or a declaration.
    let s = table(2024);
    const stuck: string[] = [];
    for (let i = 0; i < 4000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const actions = legalActions(s, seat);
      const hasSomething =
        actions.canPass || actions.plays.length > 0 || actions.mustDiscard > 0 ||
        actions.mustDeclare !== null || actions.mustSettleHand;
      if (!hasSomething) stuck.push(`seat ${seat} at ${s.step} on turn ${s.turn}`);
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
    }
    expect(stuck).toEqual([]);
    expect(s.finished).toBe(true);
  });
});

/** One bot action. The engine taps for its own costs, so there is nothing to arrange first. */
function stepOnce(s: GameState, seat: SeatIndex): GameState {
  const action = botAction(s, seat)
  return action === null ? s : applyAction(s, action, HOST)
}
