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
  applyAction, botAction, createGame, legalActions, packView, playOut, seatToAct, unpackView,
  viewFor,
  type Action, type GameState, type SeatIndex,
} from './index.js';
import { PLAYERS, POD_PLAYERS, HOST, WIRE_CAP } from './testkit.js';

/** A four-seat Commander pod, every seat on a different deck, handed to the rules engine. */
function pod(seed: number, firstSeat: SeatIndex = 0): GameState {
  const decks = ['ember-rush', 'rot-harvest', 'tidal-mind', 'verdant-guard'];
  let s = createGame({ id: `pod-${seed}`, format: 'pod', players: POD_PLAYERS, seed });
  for (const action of [
    ...decks.map((deckId, seat) => ({ type: 'deck:load' as const, by: seat, seat, deckId })),
    { type: 'game:start', by: 0, firstSeat },
    { type: 'auto:start', by: 0, firstSeat },
  ] as Action[]) {
    s = applyAction(s, action, HOST);
  }
  return s;
}

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
  ['ember-rush', 'rot-harvest'],
  ['tidal-mind', 'verdant-guard'],
  ['rot-harvest', 'verdant-guard'],
  ['rot-harvest', 'tidal-mind'],
  ['tidal-mind', 'tidal-mind'],
  ['rot-harvest', 'rot-harvest'],
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

  it('brings creatures back out of a graveyard, rather than leaving the deck half-played', () => {
    // A deck whose point is recursion would pass every other test here while never once casting
    // the spell it is built around — the graveyard targets are in a zone nothing else points at.
    let returned = 0;
    for (let seed = 1; seed <= 8 && returned === 0; seed++) {
      const result = playOut(table(seed * 5431, 0, ['rot-harvest', 'rot-harvest']));
      returned += result.state.log.filter((e) => /Raise Dead|Zombify|Gravedigger/.test(e.message)).length;
    }
    expect(returned).toBeGreaterThan(0);
  });

  it('feeds a sacrifice outlet, and feeds it the right end of the board', () => {
    // A bot that never activated an outlet and one that ate its best creature every turn would
    // both finish every game in this file, so the behaviour is asserted directly: it happens, and
    // what goes in is never bigger than what is being fed.
    let sacrifices = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const result = playOut(table(seed * 3187, 0, ['rot-harvest', 'rot-harvest']));
      expect(result.state.finished).toBe(true);
      sacrifices += result.state.log.filter((e) => /sacrifices/.test(e.message)).length;
    }
    expect(sacrifices).toBeGreaterThan(0);
  });

  it('fires entry triggers for a token and for a creature that was reanimated', () => {
    // The companion to the death-trigger test, and the same bug: `etb` was announced at one call
    // site, so only a permanent *spell* finishing its resolution ever triggered. Asserted from
    // real games because the question is whether an arrival reaches its trigger from every
    // direction a game puts something on the battlefield.
    let tokens = 0;
    let reanimated = 0;
    for (let seed = 1; seed <= 10; seed++) {
      let s = table(seed * 1493, (seed % 2) as SeatIndex, ['rot-harvest', 'verdant-guard']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s.stateVersion;
        const previous = s;
        s = stepOnce(s, seat);
        if (s.stateVersion === before) break;
        // A token that arrived this action, and a card that went from a graveyard straight to a
        // battlefield — the two routes that used to be silent.
        for (const [id, inst] of Object.entries(s.instances)) {
          if (inst.zone !== 'battlefield') continue;
          const was = previous.instances[id];
          if (was === undefined && inst.isToken) tokens += 1;
          if (was?.zone === 'graveyard') reanimated += 1;
        }
        expect(s.died).toEqual([]);
        expect(s.entered).toEqual([]);
      }
      expect(s.finished).toBe(true);
    }
    // Both routes come up in a Rot Harvest game: Izoni and Lotleth make tokens, Zombify
    // reanimates. If either stopped happening the claim above would be about nothing.
    expect(tokens + reanimated).toBeGreaterThan(0);
  });

  it('fires death triggers in real games, whatever did the killing', () => {
    // The bug this guards was silent for the whole life of the engine: "dies" meant "noticed by
    // state-based actions", so lethal damage triggered and a destroy spell did not. A playout
    // test is the right place for it because the question is not whether one card works — it is
    // whether a death reaches its trigger from every direction a game kills things.
    let fired = 0;
    for (let seed = 1; seed <= 8; seed++) {
      let s = table(seed * 1217, (seed % 2) as SeatIndex, ['ember-rush', 'verdant-guard']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s.stateVersion;
        s = stepOnce(s, seat);
        if (s.stateVersion === before) break;
        for (const object of Object.values(s.stackObjects)) {
          if (/create a 1\/1 white Spirit|deals 1 damage to any target/.test(object.description)) fired += 1;
        }
        // And nothing is ever left queued: a death or an arrival recorded and never announced
        // would sit in the state for the rest of the game.
        expect(s.died).toEqual([]);
        expect(s.entered).toEqual([]);
      }
      expect(s.finished).toBe(true);
    }
    expect(fired).toBeGreaterThan(0);
  });

  it('casts spells with {X} in the cost, and for more than nothing', () => {
    // An X spell is the one card shape that can be cast *wrongly* while every other test passes:
    // X=0 is a legal cast, so a bot that never chose an X would cast Fireball for no damage and
    // Mind Spring for no cards, and the game would still finish. So what is watched is the value
    // on the stack object, not that the spell was cast.
    const sizes: number[] = [];
    const names = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      let s = table(seed * 821, (seed % 2) as SeatIndex, ['ember-rush', 'tidal-mind']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s.stateVersion;
        s = stepWatching(s, seat, (action, at) => {
          if (action.type !== 'auto:cast' || action.x === undefined) return;
          names.add(at.cardDefs[at.instances[action.card]?.defKey ?? '']?.name ?? '?');
          sizes.push(action.x);
        });
        if (s.stateVersion === before) break;
      }
      expect(s.finished).toBe(true);
    }
    expect(sizes.length).toBeGreaterThan(0);
    // Greater than one, not greater than zero: X=0 is a legal cast, so a bot that always chose
    // zero would pass the first assertion while casting Fireball for no damage all game.
    expect(Math.max(...sizes)).toBeGreaterThan(1);
    expect(names.size).toBeGreaterThan(0);
  });

  it('casts modal spells, and does not always take the same mode', () => {
    // A modal card could sit in a deck and never be cast while every other test in this file
    // passed, and a bot that always took mode one would look identical to a bot that could not
    // see the others. So: the modes get cast, and not always the same one.
    //
    // Watched on the bot's own action rather than on the stack or the log: the log is a 200-entry
    // window on a game of several hundred actions, and a spell nobody can respond to is cast and
    // resolved inside one action, so the stack is empty again by the next line.
    const taken = new Set<string>();
    let casts = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let s = table(seed * 613, (seed % 2) as SeatIndex, ['verdant-guard', 'rot-harvest']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s.stateVersion;
        s = stepWatching(s, seat, (action, at) => {
          if (action.type !== 'auto:cast' || action.modes === undefined) return;
          const name = at.cardDefs[at.instances[action.card]?.defKey ?? '']?.name ?? '?';
          casts += 1;
          taken.add(`${name}:${[...action.modes].join(',')}`);
        });
        if (s.stateVersion === before) break;
      }
      expect(s.finished).toBe(true);
    }
    expect(casts).toBeGreaterThan(0);
    // More than one distinct combination over twelve games, which is the claim that a bot taking
    // mode one every time would fail.
    expect(taken.size).toBeGreaterThan(1);
  });

  it('answers the questions cards ask mid-resolution, and answers them the right way round', () => {
    // Every one of these cards could sit in a deck and never be drawn, cast or answered while
    // every other test in this file passed, so the behaviour is asserted from real games: the
    // questions get asked, they get answered, and the bot answers them in the direction that
    // helps it. One that tutored up a basic land while discarding its dragon would finish every
    // game in this file without complaint.
    //
    // Watched as the game runs rather than read off `state.log` afterwards, because the log is a
    // 200-entry window and a game is several hundred actions — a question answered on turn three
    // has scrolled off by the time the game ends.
    const asked: string[] = [];
    const tutored: number[] = [];
    const pitched: number[] = [];
    let games = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let s = table(seed * 911, (seed % 2) as SeatIndex, ['tidal-mind', 'ember-rush']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const pending = s.pendingDecision;
        const before = s.stateVersion;
        s = stepOnce(s, seat);
        if (s.stateVersion === before) break;
        if (pending === null) continue;
        asked.push(pending.prompt);
        // What the bot actually picked, which is the half that can be subtly wrong.
        const chosen = (s.log[s.log.length - 1]?.data as { cards?: readonly string[] })?.cards ?? [];
        const values = chosen.map((id) => s.cardDefs[s.instances[id]!.defKey]?.cmc ?? 0);
        if (pending.from === 'library') tutored.push(...values);
        if (pending.from === 'hand') pitched.push(...values);
      }
      expect(s.finished).toBe(true);
      // A resolution that stopped to ask is never left outstanding.
      expect(s.pendingDecision).toBeNull();
      games += 1;
    }
    expect(games).toBe(12);
    expect(asked.filter((p) => /Search your library/.test(p)).length).toBeGreaterThan(0);
    expect(asked.filter((p) => /Discard two cards/.test(p)).length).toBeGreaterThan(0);
    if (tutored.length > 0 && pitched.length > 0) {
      const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      // It fetches the expensive card and pitches the one it is least likely to cast. The two are
      // one ranking read in opposite directions, so getting it backwards shows up right here.
      expect(mean(tutored)).toBeGreaterThan(mean(pitched));
    }
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
    //
    // Measured on the **wire** form, which is what actually travels: `packView` says each card
    // definition once instead of once per copy and leaves out the fields that are false on almost
    // every card. See `view.ts`.
    //
    // Tidal Mind against itself on purpose, because the peak is not a long game — it is a *search*.
    // Diabolic Tutor opens the whole library to its controller, and a view that normally carries a
    // count suddenly carries fifty cards. Measured: 25.3KB at worst packed, against 45.8KB inlined
    // and a 64KB cap — which is what makes room for a 100-card Commander library. The search case
    // is measured separately because it used to be the peak and no longer is.
    let worst = 0;
    let searching = 0;
    // Several shuffles rather than one lucky seed: whether a tutor is drawn and castable is the
    // shuffle's business, and a single seed stops opening a library the moment a deck list is
    // edited. It stops as soon as it has seen one, so the usual cost is a single game.
    for (let seed = 0; seed < 8 && searching === 0; seed++) {
      let s = table(4242 + seed * 101, 0, ['tidal-mind', 'tidal-mind']);
      for (let i = 0; i < 4000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s.stateVersion;
        s = stepOnce(s, seat);
        if (s.stateVersion === before) break;
        // Every action, not a sample. The peak is one action wide: a library search opens that
        // seat's whole library — sixty cards the view normally never carries — and the very next
        // action shuffles and closes it. Sampling every twenty-fifth action would miss the only
        // moment the payload is anywhere near the cap.
        for (const viewer of [0, 1] as SeatIndex[]) {
          const view = viewFor(s, viewer);
          const packed = packView(view);
          // Packing has to be invisible: the client unpacks it and must hold the identical view.
          // Asserted here rather than only in a unit test, across every state of a whole game.
          expect(unpackView(packed)).toEqual(view);
          const size = JSON.stringify(packed).length;
          worst = Math.max(worst, size);
          if (s.seats[viewer]!.searching) searching = Math.max(searching, size);
        }
      }
      expect(s.finished).toBe(true);
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(WIRE_CAP);
    // Measured, not assumed: without this the claim above is about a game in which no library was
    // ever opened, which is the one case that matters.
    expect(searching).toBeGreaterThan(0);
    expect(searching).toBeLessThan(WIRE_CAP);
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

  it('never advances a step past something already waiting to resolve', () => {
    // A step that ends with something still on the stack means the engine walked past a
    // resolution, which is the kind of bug that loses a player their removal spell.
    //
    // "Already waiting" is the precise claim, and the looser version was wrong rather than strict.
    // *Entering* a step runs its turn-based actions: the combat damage step deals damage, a
    // creature dies, and its `dies` trigger goes on the stack — inside the same action that
    // changed the step, and entirely correctly. An assertion that the stack is empty the instant
    // the step changes only held while no card in any deck had a `dies` trigger.
    let s = table(5150);
    let step = s.step;
    for (let i = 0; i < 4000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const previous = s;
      s = stepOnce(s, seat);
      if (s.stateVersion === previous.stateVersion) break;
      if (s.step !== step) {
        const carried = s.stackOrder.filter((id) => previous.stackObjects[id] !== undefined);
        expect(carried).toEqual([]);
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

describe('a four-player Commander pod', () => {
  it('plays four seats down to one survivor', () => {
    // The format this project is built around, and nobody had sat at one: four seats, forty life,
    // a command zone, and a turn order that has to skip the seats that are out.
    for (let seed = 1; seed <= 6; seed++) {
      const result = playOut(pod(seed * 977, (seed % 4) as SeatIndex), 20000);
      expect(result.state.finished).toBe(true);
      expect(result.state.winnerSeat).not.toBeNull();
      // Three out, one standing — not two winners and not a draw.
      expect(result.state.seats.filter((s) => s.eliminated).length).toBe(3);
      expect(result.turns).toBeGreaterThan(5);
      expect(result.turns).toBeLessThan(200);
    }
  });

  it('casts commanders, taxes them, and tracks the damage they deal', () => {
    // Every one of these was impossible a commit ago: `legalActions` only looked at the hand, so
    // the engine never offered a commander at all, the tax was a number only a human could move,
    // and combat never recorded commander damage. In a Commander-first product.
    let casts = 0;
    let maxTax = 0;
    let maxCommanderDamage = 0;
    let returnedToCommandZone = 0;
    for (let seed = 1; seed <= 8; seed++) {
      let s = pod(seed * 1409, (seed % 4) as SeatIndex);
      for (let i = 0; i < 20000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const previous = s;
        const action = botAction(s, seat);
        if (action === null) break;
        s = applyAction(s, action, HOST);
        if (s.stateVersion === previous.stateVersion) break;
        if (action.type === 'auto:cast' && previous.instances[action.card]?.zone === 'command') casts += 1;
        for (const [id, inst] of Object.entries(s.instances)) {
          if (!inst.isCommander) continue;
          if (inst.zone === 'command' && previous.instances[id]?.zone === 'battlefield') {
            returnedToCommandZone += 1;
          }
        }
        for (const x of s.seats) {
          maxTax = Math.max(maxTax, x.commanderTax);
          for (const d of Object.values(x.commanderDamage)) maxCommanderDamage = Math.max(maxCommanderDamage, d);
        }
      }
      expect(s.finished).toBe(true);
    }
    expect(casts).toBeGreaterThan(0);
    // Cast more than once, which only happens if it came back and the tax went up.
    expect(maxTax).toBeGreaterThanOrEqual(4);
    expect(returnedToCommandZone).toBeGreaterThan(0);
    // Commander damage actually accrues in a real game, rather than only on a built board.
    expect(maxCommanderDamage).toBeGreaterThan(0);
  });

  it('keeps a four-seat view inside the realtime payload budget', () => {
    // Four seats is three opponents' boards and graveyards, which is the largest a view gets.
    let worst = 0;
    let s = pod(31337);
    for (let i = 0; i < 20000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
      for (const viewer of [0, 1, 2, 3] as SeatIndex[]) {
        const view = viewFor(s, viewer);
        const packed = packView(view);
        expect(unpackView(packed)).toEqual(view);
        worst = Math.max(worst, JSON.stringify(packed).length);
      }
    }
    expect(s.finished).toBe(true);
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(WIRE_CAP);
  });

  it('never offers a play it then refuses, with four seats in the game', () => {
    // The same claim the two-player games make, re-made where turn order has to skip eliminated
    // seats and several defenders can owe a block at once.
    let s = pod(8675309, 2);
    for (let i = 0; i < 20000 && !s.finished; i++) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const action = botAction(s, seat);
      if (action === null) break;
      const before = s.stateVersion;
      let threw: string | null = null;
      try {
        s = applyAction(s, action, HOST);
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      expect(threw).toBeNull();
      if (s.stateVersion === before) break;
      // And an eliminated seat is never given priority or asked for anything.
      const next = seatToAct(s);
      if (next !== null) expect(s.seats[next]!.eliminated).toBe(false);
    }
    expect(s.finished).toBe(true);
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
      // Every way the engine can be waiting on somebody. A new one that is not listed here is a
      // deadlock as far as a client is concerned, which is why the list is exhaustive rather than
      // just the common cases.
      const hasSomething =
        actions.canPass || actions.plays.length > 0 || actions.mustDiscard > 0 ||
        actions.mustDeclare !== null || actions.mustSettleHand ||
        actions.mustChoose !== null || actions.mustDecide !== null;
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

/**
 * One bot move, with the action itself handed to a watcher before it is applied.
 *
 * For the tests that assert *what the bot chose* rather than what the game became. Reading those
 * choices off the stack afterwards does not work: with auto-pass on, a spell nobody can respond to
 * is cast and resolved inside the same action, so the stack is already empty by the time the next
 * line runs. Measured, not assumed — of fifteen X spells cast across ten games, exactly one was
 * still on the stack to be seen.
 */
function stepWatching(
  s: GameState, seat: SeatIndex, watch: (action: Action, state: GameState) => void,
): GameState {
  const action = botAction(s, seat)
  if (action === null) return s;
  watch(action, s);
  return applyAction(s, action, HOST);
}
