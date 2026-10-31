/**
 * The crown, in real games: who takes it, how often it changes hands, and what it drew.
 *
 * The monarch is the first designation in this engine that is worth something every turn and can
 * be taken away, so the two numbers that matter are not "was the card cast" but **how long anybody
 * holds it** and **how many extra cards it was worth**. A crown that never changes hands is a
 * four-mana Howling Mine for its owner; a crown that changes every turn is a card that reads the
 * board rather than the deck.
 *
 * Also counts the crown going to a creature its holder could not block — which is the argument for
 * Thorn of the Black Rose being in the deck with an unblockable creature in it.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/monarch.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stats = {
  games: 0, gamesWithACrown: 0, crowned: 0, stolen: 0, draws: 0,
  heldTurns: 0, longestHold: 0, wonWithCrown: 0, finished: 0,
  byCard: new Map(),
};

const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name;

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  let sawCrown = false;
  let hold = 0;
  let lastTurn = s.turn;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;

    // A crown that moved, and which of the two ways it moved: a card gave it, or a creature took
    // it. Told apart by what the action was — combat damage is the only thing that steals it.
    if (next.monarch !== s.monarch && next.monarch !== null) {
      sawCrown = true;
      if (s.monarch === null) {
        stats.crowned += 1;
        // Which card did it, read off the board: the arrival that is resolving.
        const culprit = [...next.stackOrder, ...Object.keys(next.instances)]
          .map((id) => nameOf(next, id))
          .find((name) => name === 'Palace Sentinels' || name === 'Thorn of the Black Rose');
        if (culprit !== undefined) {
          stats.byCard.set(culprit, (stats.byCard.get(culprit) ?? 0) + 1);
        }
      } else {
        stats.stolen += 1;
        stats.longestHold = Math.max(stats.longestHold, hold);
        hold = 0;
      }
    }
    // How many cards the crown actually drew: one per end step its holder was the active player.
    if (next.step === 'end' && s.step !== 'end' && next.monarch === next.activeSeat) {
      stats.draws += 1;
    }
    if (next.turn !== lastTurn) {
      lastTurn = next.turn;
      if (next.monarch !== null) { hold += 1; stats.heldTurns += 1; }
    }
    s = next;
  }
  stats.games += 1;
  if (s.finished) stats.finished += 1;
  if (sawCrown) stats.gamesWithACrown += 1;
  stats.longestHold = Math.max(stats.longestHold, hold);
  if (s.finished && s.winnerSeat !== null && s.monarch === s.winnerSeat) stats.wonWithCrown += 1;
}

/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles seat 0's deck
  and then seat 1's, and the same stream yields the same index permutation however different the
  deck list is — so a whole pass over the field on one seed was one shuffle wearing every pairing,
  and an absolute rate printed below had the error bars of its seed count rather than its game
  count. Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      duel(seedFor(i, a, b, 0), [ALL[a], ALL[b]]);
      duel(seedFor(i, a, b, 1), [ALL[b], ALL[a]]);
    }
  }
}

const pct = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${stats.games} games, seeds ${SEEDS} from ${SEED0}\n`);
console.log(`a crown existed in ${stats.gamesWithACrown} games (${pct(stats.gamesWithACrown, stats.games)})`);
console.log(`  crowned by a card ${stats.crowned}, stolen in combat ${stats.stolen}`);
for (const [card, n] of [...stats.byCard].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${card}: ${n}`);
}
console.log(`  turns somebody held it: ${stats.heldTurns}, longest unbroken hold: ${stats.longestHold}`);
console.log(`  extra cards it drew: ${stats.draws}`);
console.log(`  games whose winner held it at the end: ${stats.wonWithCrown} of ${stats.finished} finished`);
