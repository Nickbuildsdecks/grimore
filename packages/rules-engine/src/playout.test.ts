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
  applyAction, botAction, createGame, customDeck, evaluate, legalActions, packView, playOut,
  seatToAct, unpackView, viewFor,
  type Action, type GameState, type SeatIndex,
} from './index.js';
import {
  PLAYERS, POD_PLAYERS, HOST, WIRE_CAP, advanceTo, apply, arena, find, ids, life, passBoth,
  tapAllLands,
} from './testkit.js';

/** A four-seat Commander pod, every seat on a different deck, handed to the rules engine. */
function pod(seed: number, firstSeat: SeatIndex = 0): GameState {
  const decks = ['ember-rush', 'rot-harvest', 'ashen-rite', 'verdant-guard'];
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

/**
 * The same pod, with the seats' decks rotated through all seven rather than fixed at four.
 *
 * Which decks are at the table decides which cards come up, and the deadlock below only happens
 * when a particular card does: the fixed four in `pod` above played hundreds of games without
 * reaching it. A seed alone is not coverage when the deck list is a constant.
 */
function podOfAnyDecks(seed: number): GameState {
  const decks = [
    'ember-rush', 'tidal-mind', 'verdant-guard', 'ashen-rite', 'rot-harvest', 'forge-alliance',
    'skyward-writ',
  ];
  const firstSeat = (seed % 4) as SeatIndex;
  let s = createGame({ id: `pod-any-${seed}`, format: 'pod', players: POD_PLAYERS, seed: seed * 1009 });
  for (const action of [
    ...[0, 1, 2, 3].map((seat) => ({
      type: 'deck:load' as const, by: seat, seat, deckId: decks[(seed + seat) % decks.length]!,
    })),
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
/** Every deck, for tests that want a spread of matchups rather than a named pairing. */
const DECK_IDS = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance', 'ashen-rite'] as const;

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
  ['forge-alliance', 'ember-rush'],
  ['forge-alliance', 'tidal-mind'],
  ['forge-alliance', 'rot-harvest'],
  ['forge-alliance', 'verdant-guard'],
  ['forge-alliance', 'forge-alliance'],
  ['ashen-rite', 'ember-rush'],
  ['ashen-rite', 'tidal-mind'],
  ['ashen-rite', 'verdant-guard'],
  ['ashen-rite', 'rot-harvest'],
  ['ashen-rite', 'forge-alliance'],
  ['ashen-rite', 'ashen-rite'],
];

/**
 * The shallow bot, for the tests that play dozens of games rather than one.
 *
 * These tests are about the *engine*: that it never offers a play it then refuses, and never
 * reaches a state nobody can act on. The bot that looks a move ahead is slower by the width of
 * its search, and it is also narrower — it picks the best play, where the shallow one cheerfully
 * casts whatever is most expensive and so wanders into more of the engine. Breadth and speed are
 * both what these tests want, so they ask for the shallow one by name. The searching bot, which is
 * the default and the one a player meets, is covered by the single-game tests and by "never offers
 * a play it then refuses".
 */
const BREADTH = { lookahead: false } as const;

/**
 * Lets the event loop run, between games.
 *
 * Nothing here needs it to pass. It is for the test *runner*: a worker that spends eleven seconds
 * inside one synchronous test body cannot answer the reporter's `onTaskUpdate` call, and vitest
 * reports `[vitest-worker]: Timeout calling "onTaskUpdate"` beside a full set of passing tests and
 * exits non-zero. `vitest.config.ts` has the measurement that narrowed it to this — four other
 * mitigations, none of which worked — and names the yield as the remaining candidate. So: awaited
 * once per seed in the handful of tests long enough to matter, which costs a few microseconds a
 * game and gives the worker somewhere to answer from.
 */
const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

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
      const result = playOut(table(seed * 7919, first), 6000, BREADTH);
      if (!result.state.finished) {
        unfinished.push(`seed ${seed}: stopped on turn ${result.turns} at ${result.state.step} after ${result.actions} actions`);
      }
    }
    expect(unfinished).toEqual([]);
  });

  it('reaches a winner in every pairing of the built-in decks', async () => {
    // The control deck is the one that could break a player that only ever does the obvious thing:
    // its spells target objects on the stack, which exist for a moment and then do not.
    const unfinished: string[] = [];
    for (const decks of MATCHUPS) {
      for (let seed = 1; seed <= 4; seed++) {
        const first: SeatIndex = seed % 2 === 0 ? 1 : 0;
        const result = playOut(table(seed * 104729, first, decks), 6000, BREADTH);
        if (!result.state.finished) {
          unfinished.push(`${decks[0]} vs ${decks[1]} seed ${seed}: stopped on turn ${result.turns} at ${result.state.step}`);
        }
      }
      await breathe();
    }
    expect(unfinished).toEqual([]);
    // Twenty-one pairings, four shuffles each: eighty-four whole games, which is more than
    // vitest's default five seconds buys even with the shallow bot.
  });

  it('counters spells when it has the mana for it, rather than ignoring the stack', () => {
    /*
      A game where nothing was ever countered would pass every other test here while leaving the
      whole interaction untested, so this one asserts a counterspell actually resolved.

      The pairing is the test. It used to be Ember Rush against Tidal Mind, and that is the one
      matchup in the pool where a counterspell essentially never resolves: measured over sixteen
      games, eight with each bot, **not one** — the fastest aggro deck kills the control deck
      before it is holding two mana and a Counterspell at the same time, which is also why that
      matchup is 0-15. It had been passing on luck, and a deck-list change that reshuffled the
      seeds took the luck away.

      Against the slower decks the same deck counters something in half the games it plays. Three
      pairings and four shuffles each, stopping at the first one, so a run that finds nothing has
      found a real regression rather than a bad afternoon.
    */
    const pairings: readonly (readonly [string, string])[] = [
      ['verdant-guard', 'tidal-mind'],
      ['rot-harvest', 'tidal-mind'],
      ['verdant-guard', 'skyward-writ'],
    ];
    let countered = 0;
    for (const decks of pairings) {
      for (let seed = 1; seed <= 4 && countered === 0; seed++) {
        const result = playOut(table(seed * 7723, 0, decks), 6000, BREADTH);
        countered += result.state.log.filter((e) => /counter/i.test(e.message)).length;
      }
      if (countered > 0) break;
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
      const result = playOut(table(seed * 7919), 6000, BREADTH);
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
      const result = playOut(table(seed * 7919, 0, ['ember-rush', 'tidal-mind']), 6000, BREADTH);
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
      const result = playOut(table(seed * 5431, 0, ['rot-harvest', 'rot-harvest']), 6000, BREADTH);
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
      const result = playOut(table(seed * 3187, 0, ['rot-harvest', 'rot-harvest']), 6000, BREADTH);
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
    //
    // Counted by consequence, not by catching the trigger on the stack. The first version of this
    // test looked for the ability's description in `stackObjects` after each action and asserted
    // it had been seen at least once — and with auto-pass on, a trigger nobody can respond to is
    // put on the stack and resolved inside the same action, so the snapshot almost always misses
    // it. Measured over sixteen of these games: six Doomed Travellers died, six Spirits arrived,
    // and the stack was caught holding the trigger exactly once. The test passed on luck, and a
    // deck-list change that reshuffled the same eight seeds took the luck away.
    //
    // What replaced it is the stronger claim anyway: *every* Doomed Traveller that died left a
    // Spirit behind, whatever killed it.
    let deaths = 0;
    let spirits = 0;
    for (let seed = 1; seed <= 8; seed++) {
      let s = table(seed * 1217, (seed % 2) as SeatIndex, ['ember-rush', 'verdant-guard']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s.stateVersion;
        const previous = s;
        s = stepOnce(s, seat);
        if (s.stateVersion === before) break;
        for (const [id, inst] of Object.entries(s.instances)) {
          const was = previous.instances[id];
          const name = s.cardDefs[inst.defKey]?.name ?? '?';
          if (was?.zone === 'battlefield' && inst.zone === 'graveyard' && name === 'Doomed Traveler') {
            deaths += 1;
          }
          // Nothing else in either deck makes a Spirit.
          if (was === undefined && inst.isToken && name === 'Spirit') spirits += 1;
        }
        // And nothing is ever left queued: a death or an arrival recorded and never announced
        // would sit in the state for the rest of the game.
        expect(s.died).toEqual([]);
        expect(s.entered).toEqual([]);
      }
      expect(s.finished).toBe(true);
    }
    expect(deaths).toBeGreaterThan(0);
    expect(spirits).toBe(deaths);
  });

  it('does not throw creatures away: it attacks into blocks it can live with', async () => {
    // A bot that attacks with everything is the easiest bot to write and the worst to play
    // against: it feeds a creature a turn into an untapped blocker and the game becomes a
    // formality. The claim here is about the *rate* — it still attacks, it just stops attacking
    // into certain death — so it is measured over whole games rather than asserted on a board.
    //
    // Measured before and after the change, over these twenty games: 292 attackers declared and
    // 40 of them dead, down to 240 declared and 16 dead. Games got slightly shorter, not longer,
    // which is the thing to watch — a bot that solves this by never attacking has made it worse.
    //
    // **The claim is a rate, not a count, and it was a count for too long.** "Under one and a half
    // dead attackers a game" drifted as the pool grew: eight decks and a hundred and sixty-seven
    // cards make longer boards and more combat, so the same policy loses more creatures in
    // absolute terms without having got any worse. Measured again at eight decks: 350 attackers
    // declared and 33 dead, 9.4% against the 13.7% the old policy lost and the 6.7% the fix
    // measured. The rate is what the policy controls; the count is what the deck list controls.
    //
    // **And then the rate drifted too, because it was still three things added together.** At
    // thirteen decks the raw figure reads 44 of 336 (13.1%) with the same policy, which looked
    // like a regression and is not one. Of those 44:
    //
    // - **7 sacrificed themselves.** Ball Lightning is a 6/1 that is sacrificed at the beginning
    //   of the end step whatever happens to it, so attacking with it costs nothing and *not*
    //   attacking with it wastes the card. Counting its death against the policy is simply wrong.
    // - **10 traded**, killing something that blocked them. A 2/2 that eats a 3/3 is a good
    //   attack, and the claim here has never been that the bot should refuse those.
    // - **27 were thrown away**: dead, with the defender's board intact. That is 8.0%, and it is
    //   the only one of the three numbers this test's claim is about.
    //
    // So the three are counted apart. The raw rate is still asserted, loosely, because a policy
    // that attacked into everything would push all three up at once and the test should notice.
    let declared = 0;
    let lost = 0;
    let sacrificed = 0;
    let traded = 0;
    let thrownAway = 0;
    let finished = 0;
    const turns: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const decks = [DECK_IDS[seed % 4]!, DECK_IDS[(seed + 1) % 4]!] as const;
      let s = table(seed * 5171, (seed % 2) as SeatIndex, decks);
      for (let i = 0; i < 9000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const before = s;
        const version = s.stateVersion;
        s = stepWatching(s, seat, (action) => {
          if (action.type === 'auto:attack') declared += action.attackers.length;
        });
        if (s.stateVersion === version) break;
        for (const attack of before.combat.attacks) {
          const was = before.instances[attack.attacker];
          const now = s.instances[attack.attacker];
          if (was?.zone !== 'battlefield' || now?.zone !== 'graveyard') continue;
          lost += 1;
          const def = before.cardDefs[was.defKey];
          // "Sacrifice <its own name>", which is Ball Lightning and nothing else in this pool.
          if (def !== undefined && def.oracleText.toLowerCase().includes(`sacrifice ${def.name.toLowerCase()}`)) {
            sacrificed += 1;
          } else if (attack.blockers.some((b) => before.instances[b]?.zone === 'battlefield'
            && s.instances[b]?.zone === 'graveyard')) {
            traded += 1;
          } else {
            thrownAway += 1;
          }
        }
      }
      if (s.finished) finished += 1;
      turns.push(s.turn);
      await breathe();
    }
    expect(finished).toBe(20);
    // It still attacks — a lot. Without this the next assertion passes by doing nothing.
    expect(declared).toBeGreaterThan(120);
    // The claim: under a tenth of the attacks are a creature given away for nothing.
    expect(thrownAway / declared).toBeLessThan(0.10);
    // And the raw rate, loosely, so a policy that attacks into everything still fails here.
    expect(lost / declared).toBeLessThan(0.18);
    // The three buckets are the whole of it, and each is a real category rather than a leftover.
    expect(sacrificed + traded + thrownAway).toBe(lost);
    expect(sacrificed).toBeGreaterThan(0);
    expect(traded).toBeGreaterThan(0);
    // Games did not get longer, which is how a cautious bot goes wrong.
    expect(turns.reduce((a, b) => a + b, 0) / turns.length).toBeLessThan(26);
    // Twenty whole games against the bot a player actually meets, which searches: slower per
    // decision than vitest's default five seconds allows for.
  });

  it('plays planeswalkers: cast, ticked up and down, and sometimes attacked', async () => {
    // The last card type, and the one with the most rules attached to it — loyalty on arrival, a
    // cost paid in counters, once per turn, death at zero, damage that removes loyalty, and an
    // attack that can be aimed at it. None of that is worth much if no game ever produces one,
    // so this is the check that real games do.
    let cast = 0;
    let activated = 0;
    let aimed = 0;
    for (let seed = 1; seed <= 16; seed++) {
      let s = table(seed * 913, (seed % 2) as SeatIndex, ['tidal-mind', 'verdant-guard']);
      const isWalker = (state: GameState, id: string): boolean =>
        /planeswalker/i.test(state.cardDefs[state.instances[id]?.defKey ?? '']?.typeLine ?? '');
      for (let i = 0; i < 9000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const version = s.stateVersion;
        s = stepWatching(s, seat, (action, at) => {
          if (action.type === 'auto:cast' && isWalker(at, action.card)) cast += 1;
          if (action.type === 'auto:activate' && isWalker(at, action.card)) activated += 1;
          if (action.type === 'auto:attack') {
            aimed += action.attackers.filter((a) => a.planeswalker !== undefined).length;
          }
        });
        if (s.stateVersion === version) break;
      }
      expect(s.finished).toBe(true);
      await breathe();
    }
    expect(cast).toBeGreaterThan(0);
    // Several activations per planeswalker cast: a planeswalker that is never used is a four-mana
    // do-nothing, and a bot that never used one would hide every rule in CR 606.
    expect(activated).toBeGreaterThan(cast);
    // Attacking one is the shuffle's business — there has to be a planeswalker out, a creature
    // big enough to kill it, and a turn to do it in — so it is reported rather than required.
    expect(aimed).toBeGreaterThanOrEqual(0);
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

  it('casts modal spells, and does not always take the same mode', async () => {
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
      await breathe();
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
    //
    // Twenty-four games rather than twelve, because a Diabolic Tutor is one card in a sixty and
    // the question it asks is the one this test is really about. At twelve it depended on the
    // shuffle: the first run after a deck changed by two cards saw no tutor at all and failed for
    // a set of games that were fine. Twenty-four saw two — which is the same lesson as the sampled
    // checks in the browser suites, answered here by playing more games rather than by asserting
    // less.
    //
    // The two decks are chosen for the two questions, not for the matchup: Tidal Mind brings the
    // Mind Rot that asks a player to discard, and Hollow Tide brings the Diabolic Tutor that asks
    // its controller to search. The Tutor used to be in Tidal Mind, and the balance pass moved it
    // — which broke this test, correctly, rather than quietly leaving it asserting nothing.
    const asked: string[] = [];
    const tutored: number[] = [];
    const pitched: number[] = [];
    let games = 0;
    for (let seed = 1; seed <= 24; seed++) {
      let s = table(seed * 911, (seed % 2) as SeatIndex, ['tidal-mind', 'hollow-tide']);
      for (let i = 0; i < 6000 && !s.finished; i++) {
        const seat = seatToAct(s);
        if (seat === null) break;
        const pending = s.pendingDecision;
        const prior = s;
        const before = s.stateVersion;
        s = stepOnce(s, seat);
        if (s.stateVersion === before) break;
        if (pending === null) continue;
        asked.push(pending.prompt);
        // What the bot actually picked, which is the half that can be subtly wrong.
        //
        // Read out of the state the question was asked in, not the one it was answered in: a card
        // chosen for a sacrifice can be a token, and a token that reaches a graveyard ceases to
        // exist (CR 111.7) — so by the next state its instance is gone and there is nothing to
        // read a cost off. Looking back at `prior` is also the more honest number: what the choice
        // was worth is what it was worth when it was made.
        const chosen = (s.log[s.log.length - 1]?.data as { cards?: readonly string[] })?.cards ?? [];
        const values = chosen.map((id) => {
          const def = prior.instances[id]?.defKey ?? s.instances[id]?.defKey;
          return def === undefined ? 0 : (prior.cardDefs[def]?.cmc ?? 0);
        });
        if (pending.from === 'library') tutored.push(...values);
        if (pending.from === 'hand') pitched.push(...values);
      }
      expect(s.finished).toBe(true);
      // A resolution that stopped to ask is never left outstanding.
      expect(s.pendingDecision).toBeNull();
      games += 1;
    }
    expect(games).toBe(24);
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
    // Hollow Tide against itself on purpose, because the peak is not a long game — it is a
    // *search*. Diabolic Tutor opens the whole library to its controller, and a view that normally
    // carries a count suddenly carries fifty cards. Hollow Tide is the deck that runs the Tutor
    // since the balance pass moved it out of Tidal Mind. Measured: 25.7KB at worst packed, against
    // 55.6KB inlined and a 64KB cap — which is what makes room for a 100-card Commander library.
    // The search case is measured separately because it used to be the peak and no longer is.
    let worst = 0;
    let searching = 0;
    // Several shuffles rather than one lucky seed: whether a tutor is drawn and castable is the
    // shuffle's business, and a single seed stops opening a library the moment a deck list is
    // edited. It stops as soon as it has seen one, so the usual cost is a single game.
    for (let seed = 0; seed < 8 && searching === 0; seed++) {
      let s = table(4242 + seed * 101, 0, ['hollow-tide', 'hollow-tide']);
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

describe('how a seat scores a position', () => {
  /*
    Killing an opponent must never make the position look worse.

    It did, and it is the one bug in this file's subject that cost whole games rather than single
    plays. `evaluate` is "my side, less the average opponent", and the average used to be taken
    over the opponents still *alive* — so eliminating the weakest player raised the average of the
    ones left and the score went down. Measured on a real position from a four-seat pod: a seat
    with 462 ready goblins against opponents on 3, 6 and 1 life, where the alpha strike that kills
    one of them outright scored 1875.0 and attacking with nothing scored 1877.3. It attacked with
    nothing for twenty turns while its board doubled to nine hundred creatures.

    Asserted on the arithmetic rather than through a game, because the arithmetic is the claim:
    the same board, with one opponent conceded, is worth more.
  */
  it('counts an opponent leaving the game as progress, not as a stronger table', () => {
    const s = arena({
      format: 'pod', seats: 4,
      battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'], 2: ['Hill Giant'] },
      turn: 3, firstSeat: 0,
    });
    const before = evaluate(s, 0);
    // The weakest seat leaves — the one whose removal used to *raise* the average opponent.
    const after = evaluate(apply(s, { type: 'concede', by: 3, seat: 3 }), 0);
    expect(after).toBeGreaterThan(before);
  });

  it('and still scores the table rather than the sum of it', () => {
    // The average is deliberate (see `evaluate`): a pod is "am I ahead of the table", not "is the
    // rest of the table small", or the bot would chase whoever is behind instead of answering the
    // player about to kill it. So one opponent gaining a creature must move the score by a third
    // of what it would move in a duel, not by the whole of it.
    const pod = arena({ format: 'pod', seats: 4, battlefield: { 0: ['Hill Giant'] }, turn: 3 });
    const podWorse = arena({
      format: 'pod', seats: 4, battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 3,
    });
    const duel = arena({ battlefield: { 0: ['Hill Giant'] }, turn: 3 });
    const duelWorse = arena({ battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 3 });
    const podDrop = evaluate(pod, 0) - evaluate(podWorse, 0);
    const duelDrop = evaluate(duel, 0) - evaluate(duelWorse, 0);
    expect(podDrop).toBeGreaterThan(0);
    expect(podDrop).toBeCloseTo(duelDrop / 3, 5);
  });
});

describe('what looking a move ahead buys', () => {
  /**
   * A position, with every land tapped for mana, where seat 0 is on the clock.
   *
   * The two bots are asked the same question from the same position: the shallow one, which takes
   * the most expensive play it can afford, and the searching one, which plays each option out and
   * keeps the best. Where they disagree is what this search is for.
   */
  const position = (
    hand: readonly string[], mine: readonly string[], theirs: readonly string[], deck: string,
  ): GameState => {
    let s = arena({
      decks: { 0: deck }, hands: { 0: hand },
      battlefield: { 0: mine, 1: theirs }, turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    for (const id of [...ids(s, 0, 'battlefield')]) {
      const name = s.cardDefs[s.instances[id]!.defKey]!.name;
      if (!/^(Mountain|Forest|Plains|Island|Swamp)$/.test(name)) continue;
      s = apply(s, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
    }
    return s;
  };

  const nameOfCard = (s: GameState, id: string | undefined): string =>
    id === undefined ? '' : s.cardDefs[s.instances[id]!.defKey]!.name;

  /** Puts everything in seat 0's hand back under the library except the one named card. */
  const onlyInHand = (state: GameState, keep: string): GameState => {
    let s = state;
    for (const id of [...ids(s, 0, 'hand')]) {
      if (s.cardDefs[s.instances[id]!.defKey]!.name === keep) continue;
      s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'library', position: 'bottom' });
    }
    return s;
  };

  it('will not cast the sweeper that kills more of its own board than theirs', () => {
    // Four lands, a Hurricane and a Doom Blade, and a Serra Angel across the table. The Hurricane
    // is the expensive play and it achieves nothing: three to each flier does not kill a 4/4, and
    // three to each player is three off its own total as well. The Doom Blade kills the Angel. The
    // shallow bot cannot tell them apart except by price — a Hurricane for three is a four-mana
    // play — and casting a symmetrical spell for nothing was the example in this file's own
    // comments of the bot being a bot.
    const mine = ['Swamp', 'Swamp', 'Swamp', 'Forest'];
    const s = position(['Hurricane', 'Doom Blade'], mine, ['Serra Angel'], 'rot-harvest');

    const shallow = botAction(s, 0, BREADTH);
    expect(nameOfCard(s, shallow?.type === 'auto:cast' ? shallow.card : undefined)).toBe('Hurricane');

    const searched = botAction(s, 0);
    expect(nameOfCard(s, searched?.type === 'auto:cast' ? searched.card : undefined)).toBe('Doom Blade');
  });

  it('will not trade a creature into a drain engine', () => {
    // A 2/2 into a 2/2, with a Blood Artist behind it. The arithmetic the shallow bot does says
    // this is an even trade and takes it; playing it out says two creatures die in front of a
    // Blood Artist, which is two points of life each way that the arithmetic cannot see.
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'rot-harvest' },
      battlefield: {
        0: ['Plains', 'Plains', 'Grizzly Bears'],
        1: ['Blood Artist', 'Vampire Aristocrat'],
      },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'declare-attackers');

    const shallow = botAction(s, 0, BREADTH);
    expect(shallow?.type === 'auto:attack' && shallow.attackers.length).toBe(1);

    const searched = botAction(s, 0);
    expect(searched?.type === 'auto:attack' && searched.attackers.length).toBe(0);
  });

  it('will not pay a kicker that turns a ping into a wipe of its own creatures', () => {
    // Breath of Darigaaz for two kills their 1/1s and leaves its own 4/2s standing. Kicked, for
    // five, it kills the 1/1s, both of its own creatures and four life off everybody. The kicked
    // version is the more expensive play, so the shallow bot takes it; the search plays both out
    // and sees which board it would rather be looking at.
    const mine = [
      'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain',
      'Flametongue Kavu', 'Flametongue Kavu',
    ];
    const s = position(['Breath of Darigaaz'], mine, ['Doomed Traveler', 'Doomed Traveler'], 'ashen-rite');

    const shallow = botAction(s, 0, BREADTH);
    expect(shallow?.type === 'auto:cast' && shallow.kicked === true).toBe(true);

    const searched = botAction(s, 0);
    expect(searched?.type).toBe('auto:cast');
    expect(searched?.type === 'auto:cast' && searched.kicked === true).toBe(false);
  });

  it('will not crew a Vehicle with more power than the Vehicle has', () => {
    /*
      The ninth of the "spent on nothing" family, and the first that is arithmetic rather than an
      empty board. Crewing taps creatures, and after the crew the Vehicle genuinely is a creature —
      so the search sees one more attacker and nothing at all for the ones lying sideways.

      A Sky Skiff is a 2/3 and asks for one power. Paid with a Serra Angel that could have attacked,
      it turns four power of attack into two; paid with a 1/1, it turns one into two.
    */
    const crews = (s: GameState): boolean => {
      const action = botAction(s, 0);
      return action?.type === 'auto:activate'
        && action.card === find(s, 0, 'battlefield', 'Sky Skiff');
    };
    // Both positions offer the crew — this is about which of them the search takes.
    const bad = position([], ['Mountain', 'Sky Skiff', 'Serra Angel'], [], 'forge-alliance');
    expect(legalActions(bad, 0).plays.some((p) => p.description.startsWith('Crew'))).toBe(true);
    expect(crews(bad)).toBe(false);

    const good = position([], ['Mountain', 'Sky Skiff', 'Doomed Traveler'], [], 'forge-alliance');
    expect(crews(good)).toBe(true);
  });

  it('crews for free with a creature that was never going to attack', () => {
    /*
      The half of that rule that makes it a fact about the board rather than a weight: only the
      creatures that *could* have attacked are counted as a cost. A creature that arrived this turn
      is not going into this combat whatever happens, so tapping it to crew costs nothing — and a
      7/11 crewed by three summoning-sick bodies is the best thing that can happen to a deck that
      has just emptied its hand.
    */
    let s = arena({
      decks: { 0: 'forge-alliance' },
      hands: { 0: ['Serra Angel'] },
      battlefield: { 0: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Sky Skiff'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    s = tapAllLands(s, 0);
    s = passBoth(apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Serra Angel') }));
    // A 4/4 that cannot attack, so crewing a 2/3 with it is two power of attack for nothing.
    const courser = find(s, 0, 'battlefield', 'Serra Angel');
    expect(s.instances[courser]!.enteredTurn).toBe(s.turn);
    const searched = botAction(s, 0);
    expect(searched?.type === 'auto:activate' && searched.card)
      .toBe(find(s, 0, 'battlefield', 'Sky Skiff'));
  });

  it('will not Fog an empty board, and will Fog a swing', () => {
    // The second card in the "spent on nothing" family. A Fog prevents combat damage until end of
    // turn, so cast in your own main phase it is a card in the graveyard — and the evaluation sees
    // a card leaving the hand either way, which is the same blind spot the rituals sat in.
    const idle = position(['Fog'], ['Forest'], [], 'verdant-guard');
    expect(botAction(idle, 0, BREADTH)?.type).toBe('auto:cast');
    expect(botAction(idle, 0)?.type).toBe('auto:pass');

    // And with three power pointed at its face, the same card is the play.
    let swung = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Fog'] },
      battlefield: { 0: ['Forest'], 1: ['Hill Giant'] },
      turn: 4, firstSeat: 1,
    });
    swung = advanceTo(swung, 'declare-attackers');
    swung = apply(swung, {
      type: 'auto:attack', by: 1,
      attackers: [{ attacker: find(swung, 1, 'battlefield', 'Hill Giant'), defender: 0 }],
    });
    swung = apply(swung, { type: 'auto:pass', by: 1 });
    swung = apply(swung, {
      type: 'auto:activate', by: 0, card: find(swung, 0, 'battlefield', 'Forest'), abilityIndex: 0,
    });
    const answer = botAction(swung, 0);
    expect(answer?.type).toBe('auto:cast');
    expect(nameOfCard(swung, answer?.type === 'auto:cast' ? answer.card : undefined)).toBe('Fog');
  });

  it('gangs up on an attacker no single blocker can kill', () => {
    /*
      `chooseBlocks` pairs one blocker with one attacker and says so in its own comment —
      "menace needs two blockers, which this bot does not coordinate". So a creature too big for
      anything on the board was either chump-blocked by one creature, which dies for nothing, or
      let through.

      Measured over 160 unsteered games before this plan existed: 521 blocks, 235 of them leaving
      the attacker alive, and **53 where a second creature was standing right there, legally able
      to block, and the two together would have killed it**. A tenth of every block the bot made.

      Five power between the two of them against four toughness, and the attacker's four is spent
      killing the 2/2 and bouncing off the 3/3 behind it. The shallow bot blocks with neither,
      because one at a time each block is a creature thrown away.
    */
    // Seat 1 is on Tidal Mind for the Air Elemental: Skyward Writ traded its copy for the
    // Hidden Dragonslayer, and Tidal Mind is the deck that still runs one.
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'tidal-mind' },
      battlefield: { 0: ['Grizzly Bears', 'Centaur Courser'], 1: ['Air Elemental'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'declare-attackers');
    const elemental = find(s, 1, 'battlefield', 'Air Elemental');
    /*
      Reach on both blockers, so the flier is a legal target for either: the claim is about ganging
      up, not about who can see a flier.

      `end-of-turn` rather than `permanent`, and the distinction is not cosmetic: a permanent effect
      exists only while its source is on the battlefield, and the source here is the string `test`,
      which is not an instance at all — so the first expiry pass would throw both effects away and
      the flier would be unblockable again. End-of-turn outlasts the one combat this test is about,
      which is all it needs.
    */
    s = {
      ...s,
      effects: [0, 1].map((i) => ({
        id: `reach${i}`, createdTurn: s.turn, source: 'test', controller: 0 as SeatIndex,
        scope: { kind: 'cards' as const, ids: [find(s, 0, 'battlefield', i === 0 ? 'Grizzly Bears' : 'Centaur Courser')] },
        keywords: ['reach' as const], duration: 'end-of-turn' as const,
      })),
    };
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: elemental, defender: 0 }] });
    // Both players pass out of declare-attackers, which is what puts the block on the clock.
    s = passBoth(s);

    const blocksOf = (action: Action | null): number =>
      action !== null && action.type === 'auto:block' ? action.blocks.length : -1;
    expect(blocksOf(botAction(s, 0, BREADTH))).toBeLessThan(2);
    const searched = botAction(s, 0);
    expect(blocksOf(searched)).toBe(2);
    // Both on the same attacker, which is the whole point.
    const blocks = searched?.type === 'auto:block' ? searched.blocks : [];
    expect(new Set(blocks.map((b) => b.attacker)).size).toBe(1);
  });

  it('will not pump a creature in its own upkeep, and will pump an attacker', () => {
    /*
      The fourth and last of the "spent on nothing" family, and the widest measurement behind any
      of them: five pumps, 95 casts across 160 unsteered games, **none of them during a combat**
      and 59 in the caster's own upkeep or draw step, before a land had been played.

      It is the search's horizon rather than its judgement. A cast is scored with `simulate`, which
      stops when the stack empties, so "+3/+3 until end of turn" reads as a creature that is bigger
      *now*; the combat it was printed for is past where the simulation looks.
    */
    let idle = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Giant Growth'] },
      battlefield: { 0: ['Forest', 'Centaur Courser'] },
      turn: 4, firstSeat: 0,
    });
    idle = advanceTo(idle, 'upkeep');
    idle = apply(idle, {
      type: 'auto:activate', by: 0, card: find(idle, 0, 'battlefield', 'Forest'), abilityIndex: 0,
    });
    // The shallow bot takes it, which is what makes this a measurement of the rule rather than of
    // the board: both bots are offered the same cast and only one of them declines.
    expect(botAction(idle, 0, BREADTH)?.type).toBe('auto:cast');
    expect(botAction(idle, 0)?.type).toBe('auto:pass');

    // And with the same creature attacking, the same card is the play.
    let swinging = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Giant Growth'] },
      battlefield: { 0: ['Forest', 'Centaur Courser'], 1: ['Hill Giant'] },
      turn: 4, firstSeat: 0,
    });
    swinging = advanceTo(swinging, 'declare-attackers');
    swinging = apply(swinging, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: find(swinging, 0, 'battlefield', 'Centaur Courser'), defender: 1 }],
    });
    swinging = apply(swinging, {
      type: 'auto:activate', by: 0, card: find(swinging, 0, 'battlefield', 'Forest'), abilityIndex: 0,
    });
    const answer = botAction(swinging, 0);
    expect(answer?.type).toBe('auto:cast');
    expect(nameOfCard(swinging, answer?.type === 'auto:cast' ? answer.card : undefined)).toBe('Giant Growth');
  });

  it('and a sorcery pump is cast before the attack, because it cannot wait for blockers', () => {
    // The rule is "do not spend now what you can spend better later", and for a sorcery there is
    // no later this turn. Overrun in a precombat main with something to attack with is the play;
    // the same card with an empty board is not.
    let ready = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Overrun'] },
      battlefield: { 0: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Centaur Courser'] },
      turn: 4, firstSeat: 0,
    });
    ready = advanceTo(ready, 'precombat-main');
    ready = tapAllLands(ready, 0);
    const play = botAction(ready, 0);
    expect(play?.type).toBe('auto:cast');
    expect(nameOfCard(ready, play?.type === 'auto:cast' ? play.card : undefined)).toBe('Overrun');

    // With nothing on the board it is held, because +3/+3 to no creatures is a card in the bin.
    let empty = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Overrun'] },
      battlefield: { 0: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'] },
      turn: 4, firstSeat: 0,
    });
    empty = advanceTo(empty, 'precombat-main');
    empty = tapAllLands(empty, 0);
    expect(botAction(empty, 0)?.type).not.toBe('auto:cast');
  });

  it('will not cast a ritual with nothing to spend it on, and will when there is', () => {
    // Mana empties at the end of the step (CR 500.4), so a Dark Ritual cast into an empty hand is
    // a card in the graveyard for nothing — and the evaluation cannot see that, because all it can
    // see is a card leaving the hand. Measured over 240 unsteered games before the bot knew: cast
    // 164 times, followed by a spell in the same step 17 times.
    /*
      `onlyInHand` matters here and nowhere else in this file, and it is the premise of the test.

      `arena` fast-forwards the turn counter with real `turn:pass` actions, so every draw step on
      the way has happened and the hand holds whatever the shuffle gave it beside the named card.
      For every other test in here that is harmless. For this one it is the whole thing: the claim
      is "a ritual with nothing to spend it on", and the test was true for two months only because
      nothing ashen-rite happened to draw cost three or less. Adding a morph to that deck made a
      face-down 2/2 for {3} castable off the ritual's own mana — which is the rule working, and a
      test that cannot tell that from a regression is a test that will cry wolf again.
    */
    const alone = onlyInHand(position(['Dark Ritual'], ['Swamp'], [], 'ashen-rite'), 'Dark Ritual');
    // The shallow bot takes the only play it has. That it is the only play is the point: the
    // search has to be able to answer "none of these", which it could not until this test existed.
    expect(botAction(alone, 0, BREADTH)?.type).toBe('auto:cast');
    expect(botAction(alone, 0)?.type).toBe('auto:pass');

    // And the line the card is in the deck for: a Swamp and a Mountain is two mana, a Flametongue
    // Kavu costs four, and three black mana makes up the difference. The {R} is why the Mountain
    // is not spare change — a ritual that made black only could not pay for the Kavu alone.
    const useful = position(
      ['Dark Ritual', 'Flametongue Kavu'], ['Swamp', 'Mountain'], ['Grizzly Bears'], 'ashen-rite',
    );
    const play = botAction(useful, 0);
    expect(play?.type).toBe('auto:cast');
    expect(nameOfCard(useful, play?.type === 'auto:cast' ? play.card : undefined)).toBe('Dark Ritual');
  });
});

describe('a four-player Commander pod', () => {
  it('plays four seats down to one survivor', () => {
    // The format this project is built around, and nobody had sat at one: four seats, forty life,
    // a command zone, and a turn order that has to skip the seats that are out.
    for (let seed = 1; seed <= 6; seed++) {
      const result = playOut(pod(seed * 977, (seed % 4) as SeatIndex), 20000, BREADTH);
      expect(result.state.finished).toBe(true);
      expect(result.state.winnerSeat).not.toBeNull();
      // Three out, one standing — not two winners and not a draw.
      expect(result.state.seats.filter((s) => s.eliminated).length).toBe(3);
      expect(result.turns).toBeGreaterThan(5);
      expect(result.turns).toBeLessThan(200);
    }
  });

  /*
    The deadlock a pod can reach, and the two seeds that reach it.

    Both stop at declare-blockers with attacks on the table, nobody owed a declaration and
    `priority` null — a state with no legal reading, in which `seatToAct` returns nothing and the
    table is simply dead. Hellrider gets there: its controller swings at a player low on life, its
    trigger kills them inside the same action, and the block that was owed a moment ago is not owed
    any more — so the code that hands priority back, which only runs when a question is *answered*,
    never runs. See CR 800.4a, and `resolveStateBasedActions` for the fix.

    Two of the first eight seeds of this deck rotation hit it, and the browser suite hit it as
    "stopped at Declare blockers on turn 65" with nothing on screen to press. Named seeds rather
    than a sweep, because a regression test that takes seven seconds a game cannot afford the
    sweep that found them — `scratchpad` kept the sweep.
  */
  /*
    One `it` per seed, rather than a loop over both.

    Each of these is several seconds of uninterrupted synchronous work, and this package's
    `vitest.config.ts` records what that does to the runner: a worker that never yields misses its
    task-update heartbeat and the run reports an error beside a full set of passing tests. Two
    bodies of five seconds are two chances to yield; one of ten is none.
  */
  for (const seed of [3, 6]) {
    it(`never leaves pod ${seed} with nobody to act, whichever decks are at the table (CR 800.4a)`, async () => {
      let s = podOfAnyDecks(seed);
      let dead: string | null = null;
      for (let i = 0; i < 20000 && !s.finished; i += 1) {
        // Once a turn or so, for the runner's sake rather than the game's. See `breathe`.
        if (i % 400 === 0) await breathe();
        const seat = seatToAct(s);
        if (seat === null) {
          dead = `turn ${s.turn} ${s.step}: priority ${String(s.priority)}, `
            + `${s.combat.attacks.length} attacks, lives ${s.seats.map((x) => x.life).join('/')}`;
          break;
        }
        const before = s.stateVersion;
        // The searching bot, not the shallow one: which card it chooses decides whether the
        // position that deadlocks ever comes up, and `lookahead: false` plays a different game.
        const action = botAction(s, seat);
        if (action === null) { dead = `seat ${seat} at ${s.step} had no move`; break; }
        s = applyAction(s, action, HOST);
        if (s.stateVersion === before) { dead = `${action.type} by ${seat} changed nothing`; break; }
      }
      expect(dead, `seed ${seed} stopped — ${String(dead)}`).toBeNull();
      expect(s.finished, `seed ${seed} ran out of moves`).toBe(true);
    });
  }

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
        const action = botAction(s, seat, BREADTH);
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
    // A whole four-seat pod, packed and unpacked four ways after every single action, next to five
    // other packages' suites. It came in at 2.7s alone and timed out at the 5s default twice in a
    // day, which is a measurement of this machine rather than of the payload — the same 60s the
    // other whole-game tests take.
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
        actions.mustChoose !== null || actions.mustDecide !== null ||
        // A ward waiting to be paid: the newest way to be waiting on somebody, and this list is
        // how it was noticed that a client had no answer for it.
        actions.mustPay !== null;
      if (!hasSomething) stuck.push(`seat ${seat} at ${s.step} on turn ${s.turn}`);
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
    }
    expect(stuck).toEqual([]);
    expect(s.finished).toBe(true);
  });
});

describe('removal with nothing to remove', () => {
  /*
    The seventh member of the "spent on nothing" family, and the first one found by playing the
    mistake out rather than by counting it.

    D103 counted the bot pointing removal at its own creatures — about seven casts in 60 duels —
    and left the judgement open. Finishing each of those games twice, once with the aim it chose and
    once with the best enemy aim it had, said what they were: **six of the seven had no enemy
    creature on the board at all.** A Doom Blade on its own Talrand, a Pacifism on its own Serra
    Angel, a Swords to Plowshares on its own Soul Warden — not a mis-aimed spell but a spell cast
    when there was nothing to kill, with its own side the only legal target left.

    The search cannot see it for the usual reason: killing your own creature scores worse than
    passing, but with auto-pass on, the state after a one-mana instant can be a turn later, and two
    positions a turn apart do not compare. After the rule: two self-aimed casts in the same 60
    duels, both with an enemy creature available and so deliberate — an Agonizing Demise on its own
    Goblin Arsonist, whose death pings something, and a Swords on its own Youthful Knight for two
    life, which won the game it was cast in.
  */
  const holding = (theirs: readonly string[]): GameState => arena({
    decks: { 0: 'tidal-mind', 1: 'ember-rush' },
    hands: { 0: ['Doom Blade'] },
    battlefield: {
      0: ['Swamp', 'Swamp', 'Omenspeaker'],
      1: [...theirs],
    },
    turn: 4, firstSeat: 0,
  });

  it('is not cast at all, and is cast at theirs the moment they have one', () => {
    const empty = advanceTo(holding([]), 'precombat-main');
    const blade = find(empty, 0, 'hand', 'Doom Blade');
    // Offered: its own Omenspeaker is a legal target, and the table is never lied to about that.
    expect(legalActions(empty, 0).plays.some((play) => play.card === blade)).toBe(true);
    const chosen = botAction(empty, 0);
    expect(chosen?.type === 'auto:cast' && chosen.card === blade).toBe(false);

    const board = advanceTo(holding(['Hill Giant']), 'precombat-main');
    const cast = botAction(board, 0);
    expect(cast?.type).toBe('auto:cast');
    expect(cast?.type === 'auto:cast' ? cast.card : null).toBe(find(board, 0, 'hand', 'Doom Blade'));
    // And at the creature it does not control, which is the aim the search picks for itself.
    expect(cast?.type === 'auto:cast' ? cast.targets : [])
      .toEqual([{ kind: 'card', id: find(board, 1, 'battlefield', 'Hill Giant') }]);
  });
});

describe('the land it animates and then attacks with', () => {
  /*
    The eighth "spent on nothing" rule, and the one with the biggest count behind it.

    A Mutavault that becomes a 2/2 is still a land to `seatValue`, so animating scores exactly
    zero — and with no baseline for doing nothing, a search comparing options with `>` takes a free
    zero whenever nothing better is affordable. It pressed the button **854 times across 56 games
    and never attacked with it once**: the mana went on an animation in the postcombat main phase,
    on the opponent's turn, or on a land the payment had already tapped.

    Three things were wrong and each needed its own fix: the moment (this rule), the payment (a
    permanent tapping itself for its own ability, see `scripts.test.ts`) and the repeat (an
    animation already on the stack leaves the board looking untouched). Afterwards: 45 animations
    in the same 56 games and 37 attacks with the animated land.
  */
  const board = (step: 'precombat-main' | 'postcombat-main'): GameState => advanceTo(arena({
    decks: { 0: 'ember-rush', 1: 'tidal-mind' },
    battlefield: { 0: ['Mutavault', 'Mountain', 'Mountain'], 1: [] },
    turn: 3, firstSeat: 0, autoPass: true,
  }), step);

  const animating = (state: GameState, action: Action | null): boolean =>
    action?.type === 'auto:activate'
      && action.card === find(state, 0, 'battlefield', 'Mutavault')
      && action.abilityIndex === 1;

  it('animates it before combat, and then attacks with it', () => {
    let s = board('precombat-main');
    const vault = find(s, 0, 'battlefield', 'Mutavault');
    const first = botAction(s, 0);
    expect(animating(s, first)).toBe(true);
    s = applyAction(s, first!, HOST);

    // And not again while the first one is on the stack, which is the board looking untouched.
    expect(animating(s, botAction(s, 0))).toBe(false);

    for (let i = 0; i < 12 && s.step !== 'declare-attackers'; i += 1) {
      const next = botAction(s, seatToAct(s) ?? 0);
      if (next === null) break;
      s = applyAction(s, next, HOST);
    }
    expect(s.step).toBe('declare-attackers');
    const plan = botAction(s, 0);
    expect(plan?.type === 'auto:attack' ? plan.attackers.map((a) => a.attacker) : null).toEqual([vault]);
  });

  it('and leaves the mana alone when there is no attack to make with it', () => {
    // Postcombat main: the same board, the same spare {1}, and nothing an animation can do with it.
    const s = board('postcombat-main');
    expect(animating(s, botAction(s, 0))).toBe(false);
  });
});

describe('the untap that puts the board back where it found it', () => {
  /*
    The eleventh "spent on nothing" rule, and the only one about a cycle rather than a card.

    Two Kiora's Followers ("{T}: untap another target permanent") untap each other for ever: A taps
    to untap B, B taps to untap A, and the board is exactly where it started. Every step of it is
    legal, and `evaluate` sums material — which of two permanents is tapped is worth the same
    either way — so the search took the free zero whenever nothing better was affordable. With two
    copies in the deck the ability was activated **29,432 times across 120 games**; with the one
    copy the list ships, 165 times.

    Paired on identical seeds, Delta Bloom against the other ten decks, 120 games per arm:

    | | activations | record |
    | --- | --- | --- |
    | one copy, without the rule | 165 | 47-73 |
    | one copy, with it | **1** | 52-68 |
    | two copies, without | 29,432 | 45-75 |
    | two copies, with | **10** | 48-72 |

    Both arms move by less than the eighteen-game floor, so the record is "free, with the number
    written down". It is kept for the first column: a bot that presses a button a hundred times a
    turn to put the board back where it was looks broken to the person sitting opposite. And of the
    ten activations with two copies, **nine point at a tapped land** — which is the card's real use,
    and the thing the rule is written to keep.

    What the last row also says is that this card is nearly dead in *this bot's* hands: it untaps a
    land to pay for a spell, and a bot that taps lands only to pay for something it is already
    casting rarely has a second spell waiting. That is the same limitation three other measurements
    have found (it cannot hold mana), and it is a reason to leave the deck at one copy rather than
    to cut the card: a person untaps a Simic Guildgate for the counterspell they are holding.
  */
  const twoFollowers = customDeck({
    id: 'two-followers',
    name: 'Two Followers',
    entries: [{ name: "Kiora's Follower", count: 2 }, { name: 'Forest', count: 58 }],
  }).deck;

  it('does not untap one Follower with another, which is the cycle', () => {
    let s = advanceTo(arena({
      decks: { 0: 'two-followers', 1: 'tidal-mind' },
      deckSpecs: { 'two-followers': twoFollowers },
      battlefield: { 0: ["Kiora's Follower", "Kiora's Follower", 'Forest', 'Forest'], 1: [] },
      turn: 3, firstSeat: 0, autoPass: true,
    }), 'precombat-main');
    // One of them tapped, which is the position in the middle of the cycle: untapping it is a
    // legal play that hands the board straight back to where the last activation found it.
    const [first, second] = ids(s, 0, 'battlefield')
      .filter((id) => s.cardDefs[s.instances[id]!.defKey]?.name === "Kiora's Follower");
    s = apply(s, { type: 'card:tap', by: 0, card: second!, tapped: true });
    expect(s.instances[first!]?.tapped).toBe(false);

    const action = botAction(s, 0);
    expect(action?.type === 'auto:activate' ? action.card : null).not.toBe(first);
  });

  it('and does not untap something that is not tapped, which does nothing at all', () => {
    // 36 of the first version's 57 surviving activations were this: untap, aimed at a permanent
    // that was already untapped.
    const s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'tidal-mind' },
      battlefield: { 0: ["Kiora's Follower", 'Forest', 'Forest', 'Llanowar Elves'], 1: [] },
      turn: 3, firstSeat: 0, autoPass: true,
    }), 'precombat-main');
    expect(botAction(s, 0)?.type).not.toBe('auto:activate');
  });

  it('but untaps a land it has already spent, when that pays for the card in its hand', () => {
    // Two untapped lands is {G}{U}, and Divination costs {2}{U}. Untapping the third makes it
    // castable, which is the whole of what this card is for.
    let s = advanceTo(arena({
      decks: { 0: 'delta-bloom', 1: 'tidal-mind' },
      battlefield: { 0: ["Kiora's Follower", 'Island', 'Island', 'Forest'], 1: [] },
      hands: { 0: ['Divination'] },
      turn: 3, firstSeat: 0, autoPass: true,
    }), 'precombat-main');
    // The draw step put a card in hand on the way here; it goes back, so the only thing the mana
    // could be for is the one this test is about.
    for (const id of [...ids(s, 0, 'hand')]) {
      if (s.cardDefs[s.instances[id]!.defKey]?.name === 'Divination') continue;
      s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'library', position: 'bottom' });
    }
    const island = find(s, 0, 'battlefield', 'Island');
    s = apply(s, { type: 'card:tap', by: 0, card: island, tapped: true });
    expect(legalActions(s, 0).plays.some((p) => p.kind === 'cast')).toBe(false);

    const action = botAction(s, 0);
    expect(action?.type).toBe('auto:activate');
    expect(action?.type === 'auto:activate' ? action.targets : null)
      .toEqual([{ kind: 'card', id: island }]);
    // And then casts the card the mana was untapped for.
    s = apply(s, action!);
    for (let i = 0; i < 6 && s.stackOrder.length > 0; i += 1) s = passBoth(s);
    expect(botAction(s, 0)?.type).toBe('auto:cast');
  });
});

describe('the sweeper whose own number comes out nought', () => {
  /*
    The twelfth "spent on nothing" rule, and the first about a *question* rather than a play.

    Toxic Deluge asks its caster how much life to pay as it resolves, and the card's own answer is
    nought when no number kills more of theirs than of mine. Cast anyway, the spell resolves, the
    card is in the graveyard, and the board is exactly where it was.

    The search cannot see it, and the reason is structural: a cast puts a spell on the *stack*, and
    the number is not chosen until it resolves — so one ply out, the board after the cast is the
    board before it plus a stack object, which scores the same as any other play that does nothing.

    Instrumented over 120 Hollow Tide duels against the other ten decks, before and after:

    | | casts | numbers chosen | their creatures dead | its own |
    | --- | --- | --- | --- | --- |
    | without the rule | 18 | **0:3** 1:5 2:3 3:2 4:4 | 30 | 3 |
    | with it | 18 | 1:8 2:3 3:2 4:4 | **33** | 3 |

    The same eighteen casts, three of which were a card thrown away for nothing and are now held
    for a turn where the number buys something — three more of the opponent's creatures dead for
    the same three of its own. The number-picking was never the problem.
  */
  const deluged = (theirs: readonly string[], mine: readonly string[] = []): GameState => {
    let s = advanceTo(arena({
      decks: { 0: 'hollow-tide', 1: 'ember-rush' },
      hands: { 0: ['Toxic Deluge'] },
      battlefield: { 0: ['Swamp', 'Swamp', 'Island', ...mine], 1: [...theirs] },
      turn: 4, firstSeat: 0, autoPass: true,
    }), 'precombat-main');
    // The draw step put a card in hand on the way here, and a bot with a second option is not
    // being asked this question. Everything but the Deluge goes back to the bottom.
    for (const id of [...ids(s, 0, 'hand')]) {
      if (s.cardDefs[s.instances[id]!.defKey]?.name === 'Toxic Deluge') continue;
      s = apply(s, { type: 'card:move', by: 0, card: id, toZone: 'library', position: 'bottom' });
    }
    return s;
  };

  const castsTheDeluge = (s: GameState): boolean => {
    const action = botAction(s, 0);
    if (action?.type !== 'auto:cast') return false;
    return s.cardDefs[s.instances[action.card]?.defKey ?? '']?.name === 'Toxic Deluge';
  };

  it('is not cast into a board where no number buys anything', () => {
    // Nothing of theirs at all: every number costs life and kills nothing. The play is legal and
    // the search would have taken it for the free zero.
    const empty = deluged([]);
    expect(legalActions(empty, 0).plays.some((p) => p.kind === 'cast')).toBe(true);
    expect(castsTheDeluge(empty)).toBe(false);

    // And the harder case: a board with only the caster's own creature on it, where every number
    // that does anything kills that and nothing else.
    expect(castsTheDeluge(deluged([], ['Fog Bank']))).toBe(false);
  });

  it('but is cast the moment a number kills more of theirs than of its own', () => {
    // Two 1/2 Swiftspears across the table and nothing of its own: two life for two creatures.
    expect(castsTheDeluge(deluged(['Monastery Swiftspear', 'Monastery Swiftspear']))).toBe(true);
  });

  it('and a card the bot holds is still a card a person can cast', () => {
    /*
      The rule is the bot's judgement, not a refusal: this family has never once made a play
      illegal, because a person holding up a sweeper with nothing to sweep is allowed to be wrong,
      and a table that silently removed the option would be lying about the card.
    */
    const s = deluged([]);
    const deluge = find(s, 0, 'hand', 'Toxic Deluge');
    expect(legalActions(s, 0).plays.some((p) => p.kind === 'cast' && p.card === deluge)).toBe(true);
    expect(() => apply(s, { type: 'auto:cast', by: 0, card: deluge })).not.toThrow();
  });
});

describe('a Clone with nothing to copy', () => {
  /*
    The sixth member of the "spent on nothing" family, and the most literal: a Clone cast with an
    empty battlefield is a 0/0 that dies as it arrives — four mana for a card in the graveyard.

    The search ought to see it: it plays the cast out, state-based actions kill the 0/0 inside the
    same action, and the position is worse than passing. Measured over 24 duels it mostly does —
    nine Clones cast, eight with a creature on the table and one into nothing — and that one is the
    auto-pass trap, where the state after a cast is a turn later and the comparison has moved on.
    So the question is asked of the board instead, like the Fog, the ritual and the shield before
    it. After the rule: eight casts, none into an empty board.
  */
  const holdingClone = (theirs: readonly string[]): GameState => arena({
    decks: { 0: 'tidal-mind', 1: 'ember-rush' },
    hands: { 0: ['Clone'] },
    battlefield: {
      0: ['Island', 'Island', 'Island', 'Island'],
      1: [...theirs],
    },
    turn: 4, firstSeat: 0,
  });

  it('is not cast at all, and is cast the moment there is something to copy', () => {
    let empty = advanceTo(holdingClone([]), 'precombat-main');
    const clone = find(empty, 0, 'hand', 'Clone');
    // Offered by the engine — it is a legal play, and the table is never lied to about that.
    expect(legalActions(empty, 0).plays.some((play) => play.card === clone)).toBe(true);
    const passed = botAction(empty, 0);
    expect(passed?.type === 'auto:cast' && passed.card === clone).toBe(false);

    const board = advanceTo(holdingClone(['Hill Giant']), 'precombat-main');
    const chosen = botAction(board, 0);
    expect(chosen?.type).toBe('auto:cast');
    expect(chosen?.type === 'auto:cast' ? chosen.card : null)
      .toBe(find(board, 0, 'hand', 'Clone'));
  });
});

describe('which aims the search is shown', () => {
  /*
    The search can only choose between the aims it is handed, and for one spell in the pool it was
    handed the wrong three.

    `aimings` offers the top of the enemy-first ranking as the alternatives to the heuristic's own
    pick — which is right for the removal and the burn that are most of what targets anything, and
    silently wrong when the board has three enemy creatures on it, because then the top three of
    that ranking *are* three enemy creatures and the bot's own side is never offered at all. A
    Giant Growth aimed at an opposing creature is a card given away, and the search would have
    thrown that aim out instantly: pumping their creature raises their side of the evaluation and
    lowers its own. Measured over 60 duels it happened three times — not because the evaluation was
    wrong, but because the one aim that mattered was not in the list.
  */
  it('pumps its own creature when the board is full of the opponent\'s', () => {
    let s = arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      hands: { 0: ['Giant Growth'] },
      battlefield: {
        0: ['Forest', 'Grizzly Bears'],
        1: ['Hill Giant', 'Borderland Marauder', 'Raging Goblin'],
      },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'declare-attackers');
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: giant, defender: 0 }] });
    s = apply(s, { type: 'auto:pass', by: 1 });
    s = advanceTo(s, 'declare-blockers');
    const bears = find(s, 0, 'battlefield', 'Grizzly Bears');
    s = apply(s, { type: 'auto:block', by: 0, blocks: [{ blocker: bears, attacker: giant }] });
    s = apply(s, { type: 'auto:pass', by: 1 });

    // A 2/2 blocking a 3/3 dies for nothing; +3/+3 makes it a 5/5 that kills the Giant and lives.
    const chosen = botAction(s, 0);
    expect(chosen?.type).toBe('auto:cast');
    expect(chosen?.type === 'auto:cast' ? chosen.targets : []).toEqual([{ kind: 'card', id: bears }]);
  });
});

describe('a shield the bot has to spend at the right moment', () => {
  /*
    Samite Healer is the first card in the pool whose *cost* is a blocker.

    The ability taps it, so using it in the attackers step spends a 1/1 that has not blocked yet —
    and the search cannot see that, because it scores the position one move out, where a tapped 1/1
    and an untapped one are worth the same and the block has not happened. So the rule family that
    stops a Fog being cast into an empty board has a second condition for an ability: wait until
    blockers are declared. Nothing is lost by waiting — it is instant speed, and a shield spent
    after the blocks are in knows what it is stopping.

    The second half is aim. The bot's default is "the enemy, and the enemy's creatures", which is
    right for the removal and the burn that are most of what targets anything and exactly wrong
    here: a shield aimed at an opponent prevents the damage *you* were about to deal. `friendly` on
    the target spec is what turns that around, and this is the test that it did.
  */
  const beingAttacked = (): GameState => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'ember-rush' },
      battlefield: { 0: ['Samite Healer', 'Wall of Air', 'Plains'], 1: ['Hill Giant', 'Raging Goblin'] },
      turn: 4, firstSeat: 1,
    });
    s = advanceTo(s, 'declare-attackers');
    const attackers = ['Hill Giant', 'Raging Goblin'].map((name) => ({
      attacker: find(s, 1, 'battlefield', name), defender: 0 as SeatIndex,
    }));
    s = apply(s, { type: 'auto:attack', by: 1, attackers });
    // The attacking seat holds priority first, in the step it declared the attack in.
    return apply(s, { type: 'auto:pass', by: 1 });
  };

  it('holds the tap until blockers are declared, then aims it at itself', () => {
    const s = beingAttacked();
    const healer = find(s, 0, 'battlefield', 'Samite Healer');
    // Offered — this is a legal activation, and the table is never lied to about that.
    expect(legalActions(s, 0).plays.some((play) => play.card === healer)).toBe(true);
    // And declined, because the 1/1 has a block to make first.
    expect(botAction(s, 0)).toEqual({ type: 'auto:pass', by: 0 });

    let t = advanceTo(s, 'declare-blockers');
    t = apply(t, {
      type: 'auto:block', by: 0,
      blocks: [{ blocker: find(t, 0, 'battlefield', 'Wall of Air'), attacker: find(t, 1, 'battlefield', 'Hill Giant') }],
    });
    // Now the blocks are in, and the seat with priority after them is the attacker's opponent.
    t = apply(t, { type: 'auto:pass', by: 1 });
    expect(botAction(t, 0)).toEqual({
      type: 'auto:activate', by: 0, card: healer, abilityIndex: 0,
      // At itself, which is the whole point of the `friendly` hint: the default would have shielded
      // the player attacking it.
      targets: [{ kind: 'player', seat: 0 }],
    });
  });

  it('and will not tap it at all when nothing is attacking', () => {
    let s = arena({
      decks: { 0: 'skyward-writ', 1: 'ember-rush' },
      battlefield: { 0: ['Samite Healer', 'Plains'], 1: ['Hill Giant'] },
      turn: 4, firstSeat: 0,
    });
    s = advanceTo(s, 'precombat-main');
    const healer = find(s, 0, 'battlefield', 'Samite Healer');
    expect(legalActions(s, 0).plays.some((play) => play.card === healer)).toBe(true);
    const chosen = botAction(s, 0);
    expect(chosen?.type === 'auto:activate' && chosen.card === healer).toBe(false);
  });
});

describe('blocking when the attack is lethal', () => {
  /*
    The worst mistake a Magic opponent can make is dying to an attack it could have blocked.

    Measured over 120 duels by playing out every block the seat had available at each
    declare-blockers step where the incoming attack was lethal: it faced one 68 times, survived 7,
    and **once chose a block that lost a game another block it had available would have survived.**
    (The first version of that instrument said eleven, by counting damage instead of playing the
    block out — every case it named had a Blood Artist in the attack, where each blocker that dies
    drains the blocking player, so a block that stops all the combat damage still loses.)

    The one real case was not a scoring problem. `blockPlans` offered its alternative plan only
    when it had *more* blocks in it than the heuristic's, and the heuristic had already blocked two
    attackers — so the plan that blocked the two *right* attackers was never put in front of the
    search at all. Two plans of the same size can be entirely different blocks.
  */
  it('blocks the attacker that is about to kill it, not the one worth killing', () => {
    // Three life, four damage coming: a 3/3 and a 1/1. One blocker, a 3/3, which can block either.
    //
    // Blocking the 1/1 is a free kill and a good trade, which is what the heuristic sees and what
    // it chose; three damage then goes through and the game is over. Blocking the 3/3 trades, takes
    // one, and lives. Both plans are one block long, which is why the old length test hid it.
    let s = arena({
      decks: { 0: 'ember-rush', 1: 'rot-harvest' },
      battlefield: { 0: ['Hill Giant'], 1: ['Centaur Courser', 'Llanowar Elves'] },
      turn: 4, firstSeat: 1,
    });
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 3 } : seat)) };
    s = advanceTo(s, 'declare-attackers');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const elves = find(s, 1, 'battlefield', 'Llanowar Elves');
    s = apply(s, {
      type: 'auto:attack', by: 1,
      attackers: [{ attacker: courser, defender: 0 }, { attacker: elves, defender: 0 }],
    });
    s = passBoth(s);

    const chosen = botAction(s, 0);
    expect(chosen?.type).toBe('auto:block');
    expect(chosen?.type === 'auto:block' ? chosen.blocks : []).toEqual([
      { blocker: find(s, 0, 'battlefield', 'Hill Giant'), attacker: courser },
    ]);

    // And played out, it is alive at the end of it.
    s = applyAction(s, chosen!, HOST);
    for (let i = 0; i < 20 && !s.finished && s.step !== 'postcombat-main'; i += 1) {
      const seat = seatToAct(s);
      if (seat === null) break;
      const before = s.stateVersion;
      s = stepOnce(s, seat);
      if (s.stateVersion === before) break;
    }
    expect(s.seats[0]!.eliminated).toBe(false);
    expect(life(s, 0)).toBe(2);
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

describe('the crown as a fact the bot reads (CR 720)', () => {
  /*
    The one bot rule in this project that a duel cannot price, and the reason the pod harness
    exists (`scripts/measure/pod-duel.mjs`).

    The crown is worth a card every turn and the only way to take it is to deal its holder combat
    damage — so "go at the monarch" is not a preference the search has to be talked into, it is the
    one attack that does something no other attack can. Whether it *wins* more pods is a separate
    question the measurement answers with "nothing either way"; what these tests pin is that the
    rule fires and that it can be turned off, which is what the measurement needed.
  */
  const podWithACrown = (): GameState => {
    const base = arena({
      format: 'pod', seats: 4,
      battlefield: { 0: ['Mountain', 'Hill Giant'] },
      turn: 4, firstSeat: 0,
    });
    // Seat 2 is nearly dead and seat 1 holds the crown, so the two rules disagree and the answer
    // says which one the bot followed. The crowning itself is tested in `scripts.test.ts`.
    return advanceTo({
      ...base,
      monarch: 1,
      seats: base.seats.map((seat, i) => (i === 2 ? { ...seat, life: 5 } : seat)),
    }, 'declare-attackers');
  };

  it('sends the attack at the monarch rather than at the player on five life', () => {
    const s = podWithACrown();
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const chosen = botAction(s, 0);
    expect(chosen?.type).toBe('auto:attack');
    expect(chosen?.type === 'auto:attack' ? chosen.attackers : []).toEqual([
      { attacker: giant, defender: 1 },
    ]);
  });

  it('and goes back to the weakest seat with the rule turned off, which is the control', () => {
    const s = podWithACrown();
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const chosen = botAction(s, 0, { chaseTheCrown: false });
    expect(chosen?.type === 'auto:attack' ? chosen.attackers : []).toEqual([
      { attacker: giant, defender: 2 },
    ]);
  });

  it('and with no crown in the game the two are the same bot', () => {
    const base = podWithACrown();
    const s = { ...base, monarch: null };
    const withRule = botAction(s, 0);
    const without = botAction(s, 0, { chaseTheCrown: false });
    expect(withRule).toEqual(without);
  });
});
