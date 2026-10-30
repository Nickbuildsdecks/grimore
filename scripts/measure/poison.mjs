/**
 * Whether the second way to lose a game of Magic actually happens.
 *
 * Ten poison has been an elimination rule in this engine since it was written and nothing in the
 * pool could produce a point of it, so the question a win-rate cannot answer is not "is the infect
 * deck any good" but **does it ever win that way**. A deck that reaches ten poison once in fifty
 * games is a damage deck with a worse clock; one that reaches it half the time is a second
 * archetype.
 *
 * Counts the poison dealt, the games it was dealt in, how many of them ended in a poison
 * elimination, and the `-1/-1` counters that came with it — because the counters are the half of
 * infect that wins the ground war rather than the game.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/poison.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SUBJECT = process.env.SUBJECT ?? 'blight-vector';
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stats = {
  games: 0, won: 0, lost: 0, unfinished: 0,
  poisonGames: 0, poisonTotal: 0, poisonWins: 0, lifeWins: 0,
  counters: 0, mostPoison: 0,
  byOpponent: new Map(),
};

function duel(seed, decks, subjectSeat) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const foe = 1 - subjectSeat;
  let counters = 0;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;
    // `-1/-1` counters that arrived this move, anywhere: the other half of what infect does.
    for (const inst of Object.values(next.instances)) {
      const had = s.instances[inst.id]?.counters['-1/-1'] ?? 0;
      const has = inst.counters['-1/-1'] ?? 0;
      if (has > had) counters += has - had;
    }
    s = next;
  }
  const poison = s.seats[foe]?.poison ?? 0;
  stats.games += 1;
  stats.counters += counters;
  stats.mostPoison = Math.max(stats.mostPoison, poison);
  if (poison > 0) { stats.poisonGames += 1; stats.poisonTotal += poison; }
  if (!s.finished) stats.unfinished += 1;
  else if (s.winnerSeat === subjectSeat) {
    stats.won += 1;
    if (s.seats[foe]?.eliminatedReason === 'poison') stats.poisonWins += 1; else stats.lifeWins += 1;
  } else stats.lost += 1;
  const row = stats.byOpponent.get(decks[foe]) ?? { won: 0, lost: 0, poison: 0, poisonWins: 0 };
  if (s.finished && s.winnerSeat === subjectSeat) row.won += 1;
  else if (s.finished) row.lost += 1;
  row.poison += poison;
  if (s.seats[foe]?.eliminatedReason === 'poison') row.poisonWins += 1;
  stats.byOpponent.set(decks[foe], row);
}

/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles seat 0's deck
  and then seat 1's, and the same stream yields the same index permutation however different the
  deck list is — so a whole pass over the field on one seed was one shuffle wearing every pairing,
  and an absolute rate printed below had the error bars of its seed count rather than its game
  count. Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, j, order) => SEED0 + ((pass * FIELD.length + j) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (const [j, foe] of FIELD.entries()) {
    duel(seedFor(i, j, 0), [SUBJECT, foe], 0);
    duel(seedFor(i, j, 1), [foe, SUBJECT], 1);
  }
}

const pct = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${SUBJECT}: ${stats.won}-${stats.lost}`
  + `${stats.unfinished ? ` (${stats.unfinished} unfinished)` : ''} of ${stats.games}`
  + ` [${pct(stats.won, stats.won + stats.lost)}]\n`);
console.log(`poison was dealt in ${stats.poisonGames} games (${pct(stats.poisonGames, stats.games)})`);
console.log(`  ${stats.poisonTotal} counters in all, most in one game: ${stats.mostPoison}`);
console.log(`  wins by poison: ${stats.poisonWins}, wins by damage: ${stats.lifeWins}`);
console.log(`  -1/-1 counters put on creatures: ${stats.counters}`);
console.log('\nby opponent (won-lost, poison dealt, poison wins):');
for (const [foe, row] of [...stats.byOpponent].sort((a, b) => b[1].won - a[1].won)) {
  console.log(`  ${row.won}-${row.lost}  ${String(row.poison).padStart(3)} poison  ${row.poisonWins} by poison  v ${foe}`);
}
