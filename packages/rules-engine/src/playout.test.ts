/**
 * Whole games, played out by bots that only ever send actions the engine offered them.
 *
 * This is the test the rest of the suite exists to make possible. Every other test asserts one
 * rule; this one asserts the property that matters to two people sitting down to play: from a
 * shuffled deck, with nobody steering, the engine reaches a winner. A game that finishes proves
 * there was no deadlock, no state where nobody could act, and no play the engine offered that it
 * then refused — and it does that over thousands of positions nobody wrote by hand.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction, botAction, canPay, createGame, legalActions, parseManaCost, playOut, poolOf,
  seatToAct, viewFor, type Action, type GameState, type SeatIndex,
} from './index.js';
import { PLAYERS, HOST } from './testkit.js';

/** A full table with both starter decks shuffled on `seed`, handed to the rules engine. */
function table(seed: number, firstSeat: SeatIndex = 0): GameState {
  let s = createGame({ id: `game-${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const action of [
    { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
    { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
    { type: 'game:start', by: 0, firstSeat },
    { type: 'auto:start', by: 0, firstSeat },
  ] as Action[]) {
    s = applyAction(s, action, HOST);
  }
  return s;
}

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
      // `auto:cast` and `auto:activate` need the mana floating first, which is the bot's job and
      // not a claim about legality, so those are checked through the bot's own step function.
      if (action.type === 'auto:cast' || action.type === 'auto:activate') {
        s = stepWithMana(s, seat, action);
        continue;
      }
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
        actions.mustDeclare !== null;
      if (!hasSomething) stuck.push(`seat ${seat} at ${s.step} on turn ${s.turn}`);
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
    }
    expect(stuck).toEqual([]);
    expect(s.finished).toBe(true);
  });
});

/** One bot action, with its mana tapped first. Mirrors `botStep` without importing its internals. */
function stepOnce(s: GameState, seat: SeatIndex): GameState {
  const action = botAction(s, seat);
  if (action === null) return s;
  if (action.type === 'auto:cast' || action.type === 'auto:activate') return stepWithMana(s, seat, action);
  return applyAction(s, action, HOST);
}

/**
 * Taps the mana a play needs and then sends it, letting any refusal escape.
 *
 * Deliberately has no try/catch around the action itself: swallowing a refusal here would make the
 * "never offers a play it then refuses" test above pass by looking away.
 */
function stepWithMana(s: GameState, seat: SeatIndex, action: Action): GameState {
  const card = (action as { card?: string }).card;
  const abilityIndex = (action as { abilityIndex?: number }).abilityIndex;
  const play = legalActions(s, seat).plays.find(
    (p) => p.card === card && (abilityIndex === undefined || p.abilityIndex === abilityIndex),
  );
  const cost = parseManaCost(play?.manaCost);
  let next = s;
  for (let guard = 0; guard < 24 && !canPay(poolOf(next, seat), cost); guard++) {
    const source = legalActions(next, seat).plays.find((p) => p.isManaAbility);
    if (source === undefined) break;
    next = applyAction(next, {
      type: 'auto:activate', by: seat, card: source.card, abilityIndex: source.abilityIndex ?? 0,
    }, HOST);
  }
  // The mana could not be produced after all: pass instead of sending something that will bounce.
  if (!canPay(poolOf(next, seat), cost)) {
    return applyAction(next, { type: 'auto:pass', by: seat }, HOST);
  }
  return applyAction(next, action, HOST);
}
