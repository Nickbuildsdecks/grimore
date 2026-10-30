/**
 * Whether the mill deck wins the way it is built to.
 *
 * Drawing from an empty library has been an elimination in this engine since it was written
 * (CR 104.3c), and Hollow Tide is thirteen cards' worth of trying to cause it: three Mind Sculpts, a
 * Tome Scour, two Thought Scours, two Compelling Arguments, a Returned Centaur, a Nemesis of Reason,
 * a Jace, Memory Adept and a Mirko Vosk. Nobody had ever measured whether it happens. The same
 * question `poison.mjs` was written to answer, for the other alternative win condition, and the same
 * shape of answer: a deck that decks somebody once in fifty games is a damage deck with a worse
 * clock, and one that does it half the time is a second archetype.
 *
 * What it counts, per game: **how it actually ended** (a life total at nought, an empty library, ten
 * poison, or nothing), how many cards the subject milled off its opponent, and how far down the
 * opponent's library got. The last of those is the number a win-rate cannot give: a deck that leaves
 * the library at thirty every game is not close, and one that leaves it at four is losing a race it
 * nearly wins.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/mill.mjs
 *     SUBJECT=tidal-mind SEEDS=6 node scripts/measure/mill.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SUBJECT = process.env.SUBJECT ?? 'hollow-tide';
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stats = {
  games: 0, won: 0, lost: 0, unfinished: 0,
  milled: 0, mostMilled: 0, lowest: [], deckedThem: 0, deckedMe: 0,
  winsByLibrary: 0, winsByLife: 0,
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
  const libraryOf = (st, seat) => (st.zones[`${seat}:library`] ?? []).length;
  /*
    Milling counted as **cards that left the opponent's library without being drawn**, which is the
    only honest way to separate the two: a library shrinks by one every upkeep whatever anybody
    does, and a measurement that counted that would read "milled 40" on a deck with no mill in it.
  */
  let milled = 0;
  let lowest = libraryOf(s, foe);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    const hadLibrary = libraryOf(s, foe);
    const hadHand = (s.zones[`${foe}:hand`] ?? []).length;
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;
    const lost = hadLibrary - libraryOf(next, foe);
    const drawn = (next.zones[`${foe}:hand`] ?? []).length - hadHand;
    if (lost > 0) milled += Math.max(0, lost - Math.max(0, drawn));
    lowest = Math.min(lowest, libraryOf(next, foe));
    s = next;
  }
  stats.games += 1;
  stats.milled += milled;
  stats.mostMilled = Math.max(stats.mostMilled, milled);
  stats.lowest.push(lowest);
  if (s.seats[foe]?.eliminatedReason === 'library') stats.deckedThem += 1;
  if (s.seats[subjectSeat]?.eliminatedReason === 'library') stats.deckedMe += 1;
  if (!s.finished) stats.unfinished += 1;
  else if (s.winnerSeat === subjectSeat) {
    stats.won += 1;
    if (s.seats[foe]?.eliminatedReason === 'library') stats.winsByLibrary += 1;
    else stats.winsByLife += 1;
  } else stats.lost += 1;
  const row = stats.byOpponent.get(decks[foe]) ?? { won: 0, lost: 0, milled: 0, decked: 0, lowest: 60 };
  if (s.finished && s.winnerSeat === subjectSeat) row.won += 1;
  else if (s.finished) row.lost += 1;
  row.milled += milled;
  row.lowest = Math.min(row.lowest, lowest);
  if (s.seats[foe]?.eliminatedReason === 'library') row.decked += 1;
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
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(`${SUBJECT}: ${stats.won}-${stats.lost}`
  + `${stats.unfinished ? ` (${stats.unfinished} unfinished)` : ''} of ${stats.games}`
  + ` [${pct(stats.won, stats.won + stats.lost)}]\n`);
console.log(`milled ${stats.milled} cards off its opponents`
  + ` (${(stats.milled / Math.max(1, stats.games)).toFixed(1)} a game, most in one: ${stats.mostMilled})`);
console.log(`  the opponent's library got down to ${mean(stats.lowest).toFixed(1)} on average,`
  + ` ${Math.min(...stats.lowest)} at its lowest`);
console.log(`  games it decked somebody: ${stats.deckedThem} (${pct(stats.deckedThem, stats.games)})`);
console.log(`  games it decked itself: ${stats.deckedMe}`);
console.log(`  wins by empty library: ${stats.winsByLibrary}, wins by damage: ${stats.winsByLife}`);
console.log('\nby opponent (won-lost, cards milled, lowest library, wins by decking):');
for (const [foe, row] of [...stats.byOpponent].sort((a, b) => b[1].won - a[1].won)) {
  console.log(`  ${row.won}-${row.lost}  ${String(row.milled).padStart(4)} milled`
    + `  low ${String(row.lowest).padStart(2)}  ${row.decked} decked  v ${foe}`);
}
