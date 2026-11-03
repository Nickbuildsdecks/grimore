#!/usr/bin/env node
/**
 * Does a per-seat view stay inside the wire cap for a **whole** game?
 *
 *   pnpm --filter @grimore/rules-engine build
 *   SEEDS=6 node scripts/measure/wire-growth.mjs
 *   SEEDS=4 SINGLETON=1 node scripts/measure/wire-growth.mjs   # a pasted Commander list
 *   SEEDS=4 LIMITS=1 node scripts/measure/wire-growth.mjs      # the biggest four-seat table there is
 *
 * ## The gap this fills
 *
 * `STATE_MAX_BYTES` (128 KiB) is enforced by `PodStateEvent` in `packages/shared`: a state larger
 * than that **fails validation**, so the broadcast does not go out. Two tests measure against it,
 * and both measure **one position**: `playout.test.ts` takes a view mid-game, and the singleton
 * test added in #308 takes one at turn 6 with a board dealt by hand.
 *
 * A position is not a game. What accumulates over forty turns is graveyards, exile, tokens and the
 * log — all of it visible to every seat, so all of it in the view — and nothing had ever watched
 * the size while a game ran. The worst realistic case is the one Nick will actually play: a
 * four-player Commander pod where every seat pasted a hundred different cards.
 *
 * So this plays whole games and records the **peak** view, per seat, across every move, with the
 * turn it happened on. A peak well inside the cap is the answer; a peak near it is a finding, and
 * one over it is a table that breaks mid-game.
 *
 * ## What it does not claim
 *
 * The bots play the game, so the boards are the boards a bot builds. A human who hoards tokens or
 * runs a deck built to fill a graveyard can reach positions these games do not. The number here is
 * therefore a floor on the peak rather than a bound on it, which is stated in the output.
 */
import {
  STARTER_DECKS, applyAction, botAction, createGame, customDeck, packView, seatsToAct, viewFor,
} from '../../packages/rules-engine/dist/index.js';
import { provenanceLine } from '../lib/provenance.mjs';

/** Restated from `packages/shared/src/realtime/events.ts`, which is where it is enforced. */
const STATE_MAX_BYTES = 128 * 1024;

const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 70000);
const MOVES = Number(process.env.MOVES ?? 8000);
const SINGLETON = process.env.SINGLETON === '1';
/*
  The largest **four-seat table the engine permits**, which is not the largest list the paste
  accepts — and finding that out is what this arm was for.

  `DECKLIST_LIMITS.maxCards` is 250 and `maxDistinct` is 150, so a player may paste 250 cards. The
  engine's `MAX_INSTANCES` is 600 for the whole table, and its docblock gives the same reason the
  wire cap exists: "so one action can never blow past STATE_MAX_BYTES". Four seats times 250 is
  1000, so a pod of four maximum lists is refused outright with
  `INVALID_DECK: a table may hold at most 600 cards` — two caps written for one purpose,
  set independently, disagreeing at four seats (see D352).

  So this arm measures 150 cards a seat, which is 600 exactly: the biggest four-player table that
  can be dealt at all.
*/
const LIMITS = process.env.LIMITS === '1';
const PLAYERS = [
  { playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' },
  { playerId: 'p2', name: 'C' }, { playerId: 'p3', name: 'D' },
];

const ALL = Object.keys(STARTER_DECKS);

/** Every distinct card name in the pool, which is what a pasted singleton list is drawn from. */
function poolNames() {
  const names = new Set();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) names.add(entry.card.name);
    if (deck.commander) names.add(deck.commander.name);
  }
  return [...names];
}

/**
 * Four singleton Commander decks, each a different hundred names out of the pool.
 *
 * Different slices on purpose: four seats holding the *same* hundred cards would share definitions
 * and understate exactly the thing being measured.
 */
function singletonDecks(names) {
  const distinct = LIMITS ? 150 : 100;
  const specs = {};
  for (let seat = 0; seat < 4; seat++) {
    const slice = [];
    for (let i = 0; i < distinct * 2; i++) slice.push(names[(seat * 97 + i * 7) % names.length]);
    const unique = [...new Set(slice)].slice(0, distinct);
    if (unique.length < distinct) throw new Error(`the pool has too few names for ${distinct} distinct`);
    // Singleton either way: 150 distinct names is already 150 cards, which is the four-seat bound.
    const entries = unique.slice(0, distinct - 1).map((name) => ({ name, count: 1 }));
    const { deck } = customDeck({
      id: `custom:${seat}`,
      name: `Pasted ${seat}`,
      commander: unique[distinct - 1],
      entries,
    });
    specs[`custom:${seat}`] = deck;
  }
  return specs;
}

const pool = poolNames();

/** Plays one pod, returning the peak view size seen on any seat at any point. */
function play(seed) {
  const deckSpecs = SINGLETON || LIMITS ? singletonDecks(pool) : null;
  const deckIds = SINGLETON || LIMITS
    ? [0, 1, 2, 3].map((i) => `custom:${i}`)
    : [0, 1, 2, 3].map((i) => ALL[(seed + i) % ALL.length]);

  let s = createGame({ id: `wire${seed}`, format: 'pod', players: PLAYERS, seed });
  for (let seat = 0; seat < 4; seat++) {
    s = applyAction(
      s,
      { type: 'deck:load', by: seat, seat, deckId: deckIds[seat] },
      deckSpecs === null ? { isHost: true } : { isHost: true, decks: deckSpecs },
    );
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });

  let peak = { bytes: 0, seat: 0, turn: 0, move: 0 };
  const sample = (move) => {
    for (let seat = 0; seat < 4; seat++) {
      // The seat may have been eliminated; a view is still produced for it, which is the point of
      // measuring every seat rather than seat zero.
      const bytes = JSON.stringify(packView(viewFor(s, seat))).length;
      if (bytes > peak.bytes) peak = { bytes, seat, turn: s.turn, move };
    }
  };
  sample(0);

  let moves = 0;
  for (; moves < MOVES && !s.finished; moves++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try {
      s = applyAction(s, action);
    } catch {
      break;
    }
    if (s.stateVersion === before) break;
    /*
      Every tenth move rather than every move. The view is rebuilt for four seats each sample and
      that dominates the run otherwise; the thing being measured grows over turns, not within a
      move, so a tenth of the samples finds the same peak for a tenth of the time.
    */
    if (moves % 10 === 0) sample(moves);
  }
  sample(moves);
  return { peak, turns: s.turn, moves, finished: s.finished };
}

const shape = LIMITS ? 'AT THE ENGINE BOUND (150 cards a seat, 600 at the table)'
  : SINGLETON ? 'SINGLETON (100 distinct)' : 'starter-deck';
console.log(`\nPeak per-seat view over a whole four-player ${shape} pod`);
console.log(provenanceLine({
  SEED0, SEEDS, MOVES, SINGLETON: SINGLETON ? '1' : '', LIMITS: LIMITS ? '1' : '',
}));

let worst = { bytes: 0 };
let worstSeed = 0;
const rows = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = SEED0 + i;
  const r = play(seed);
  rows.push({ seed, ...r });
  if (r.peak.bytes > worst.bytes) { worst = r.peak; worstSeed = seed; }
  const pct = ((r.peak.bytes / STATE_MAX_BYTES) * 100).toFixed(1);
  console.log(
    `  seed ${seed}: peak ${String(r.peak.bytes).padStart(7)} bytes (${pct.padStart(5)}% of cap)`
    + ` on seat ${r.peak.seat} at turn ${r.peak.turn}`
    + ` — ${r.turns} turns, ${r.moves} moves${r.finished ? '' : ', UNFINISHED'}`,
  );
}

const pct = (worst.bytes / STATE_MAX_BYTES) * 100;
console.log(`\nworst peak: ${worst.bytes} bytes of ${STATE_MAX_BYTES} (${pct.toFixed(1)}%),`
  + ` seed ${worstSeed}, seat ${worst.seat}, turn ${worst.turn}`);
console.log(`turns played: ${Math.min(...rows.map((r) => r.turns))}-${Math.max(...rows.map((r) => r.turns))}`
  + `, unfinished: ${rows.filter((r) => !r.finished).length} of ${rows.length}`);
console.log('\nThe bots play these games, so the boards are the boards a bot builds. A player who');
console.log('hoards tokens or fills a graveyard on purpose can reach positions these do not, so read');
console.log('the peak as a floor on the peak rather than a bound on it.');

/*
  Exit non-zero when a view would have been refused. `PodStateEvent` rejects a state over the cap,
  so a peak above it is not a slow table: it is a broadcast that never goes out.
*/
if (worst.bytes > STATE_MAX_BYTES) {
  console.log(`\nFAIL: a view exceeded ${STATE_MAX_BYTES} bytes, which PodStateEvent refuses.`);
  process.exit(1);
}
