/**
 * Is the evaluation worth searching with?
 *
 * The progress doc has named one open problem for a long time: *"what is missing is not depth, it is
 * an evaluation worth searching with."* Four terms have been deleted after measurement (D116), two
 * attempts at pricing an answer in hand failed (D68, D69), and the standing conclusion is about the
 * **shape** of the function rather than any weight in it.
 *
 * Nobody has measured the obvious thing. `evaluate` is a sum of life, hand, library, lands and
 * creature power-plus-toughness — that is a **theory about Magic**, and a theory that says who is
 * ahead is testable against who actually won.
 *
 * So this samples the position at the start of every seat's turn, keeps the evaluation and the
 * components it is made of, and reads them against the eventual winner.
 *
 *   SEEDS=2 node scripts/measure/eval-calibration.mjs
 *   SEEDS=6 node scripts/measure/eval-calibration.mjs   # the full field
 *
 * Three readings, and the second is the one that matters:
 *
 *  1. **Sign accuracy by turn band** — how often the seat the evaluation calls ahead is the seat
 *     that wins. Banded on purpose: a function that only works once the game is decided is useless,
 *     because a search can only change an outcome while it is still in doubt. 100% at turn 25 and
 *     55% at turn 6 is a *worse* result than a flat 70%, and an unbanded average hides it.
 *  2. **Win rate by margin**, in the band where a search can still act. A usable evaluation is a
 *     monotonic ladder crossing 50% near zero; a flat ladder is the finding, and a ladder that
 *     climbs and then falls back at the extremes is the harness.
 *  3. **The same for each component on its own.** If life margin alone predicts better than the
 *     total, the weights are wrong in a measurable direction, which is the first actionable thing
 *     this problem has had. Components are computed here from state rather than read out of the
 *     bot, so the harness's answer does not depend on the bot's internals.
 *
 * **It changes nothing.** The instrument comes first, and three entries' worth of evidence says
 * what guessing at weights costs here.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/eval-calibration.mjs
 */
import {
  applyAction, characteristicsOf, createGame, evaluate, seatsToAct, botAction, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  The turn bands, and why they are not even.

  `turn` counts every seat's turn, so a duel's turn 8 is a seat's fourth. The early bands are
  narrow because that is where the question lives: by turn 17 most of these games have a board one
  side cannot come back from, and an evaluation agreeing with that is not evidence of anything.
*/
const BANDS = [[1, 4], [5, 8], [9, 12], [13, 16], [17, 24], [25, 999]];
/** The band the margin ladder is read in: late enough to have a board, early enough to matter. */
const LADDER = [5, 12];
const BUCKETS = [-20, -10, -3, 3, 10, 20];

/*
  The components, computed here rather than imported.

  Deliberately a re-derivation of what `seatValue` sums rather than a call into it: if the harness
  read the bot's own breakdown, a component that is mispriced *and* mis-measured would agree with
  itself. These are the five quantities a player would name — and `board` uses power plus toughness
  because that is the measure the bot's own blocking logic trades on.
*/
const componentsFor = (state, seat) => {
  let board = 0;
  let lands = 0;
  for (const id of state.zones[`${seat}:battlefield`] ?? []) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (ch.isLand) lands += 1;
    else if (ch.isCreature) board += Math.max(0, ch.power) + Math.max(0, ch.toughness);
  }
  return {
    life: state.seats[seat]?.life ?? 0,
    board,
    lands,
    hand: (state.zones[`${seat}:hand`] ?? []).length,
    library: (state.zones[`${seat}:library`] ?? []).length,
  };
};

const KEYS = ['total', 'life', 'board', 'lands', 'hand', 'library'];

/** One sample: the turn it was taken on, each margin from seat 0's view, and who won. */
const samples = [];

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });

  const taken = [];
  let lastRound = -1;
  /*
    One position per round, at the start of **seat 0's** turn, recorded from **both** seats' points
    of view. Each clause was forced by a reading that could not be true, and the order matters.

    Not one sample per action: a turn with twenty actions would weigh twenty times a turn with one,
    and the turns with twenty actions are the ones where somebody is already winning.

    Not one per *turn*, which the first draft did. `turn` counts both seats, so alternate samples
    landed at the start of seat 1's turn — by which point seat 0 has had one more land drop than
    seat 1, every time, whoever is winning. The land row read **38% in every band**, stably worse
    than a coin. That is not a fact about Magic, it is turn parity, and it biased `hand` the same way
    and `total` with them since the evaluation sums both.

    Nor one per seat on its own turn, which was the second draft and has the **same bug wearing
    different clothes**: on its own turn a seat has had one more land drop than its opponent, so
    every sample carried a +1 that had nothing to do with who was winning. The land row came back at
    41%. A parity bug fixed by changing which parity is not fixed.

    So: one moment, chosen because it is the only one where both seats have had the same number of
    turns — the start of seat 0's — and both seats' views of it. The margins are exact negations of
    each other and so is the outcome, which does two things. The base rate becomes **exactly 50%**,
    so a bucket can be read against a coin without knowing what the field or the seed did. And the
    ladder becomes symmetric, so a lopsided one is a bug rather than a finding.
  */
  const sample = (st) => {
    if (st.finished || st.activeSeat !== 0 || st.turn === lastRound) return;
    lastRound = st.turn;
    const mine = componentsFor(st, 0);
    const theirs = componentsFor(st, 1);
    const row = {
      turn: st.turn,
      total: evaluate(st, 0),
      life: mine.life - theirs.life,
      board: mine.board - theirs.board,
      lands: mine.lands - theirs.lands,
      hand: mine.hand - theirs.hand,
      library: mine.library - theirs.library,
    };
    taken.push({ seat: 0, ...row });
    taken.push({
      seat: 1,
      turn: row.turn,
      ...Object.fromEntries(KEYS.map((k) => [k, -row[k]])),
    });
  };

  sample(s);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
    sample(s);
  }

  /*
    A game with no winner contributes nothing, and that is not the same as discarding it quietly:
    the count is printed, because a field where a third of the games stall would make every number
    above it a statement about the games that happened to finish.
  */
  if (!s.finished || s.winnerSeat === null) return { finished: false, won: false };
  // Each sample carries the outcome for the seat it was taken from, which is what makes the base
  // rate 50% rather than whatever seat 0 managed at this seed.
  for (const row of taken) samples.push({ ...row, won: s.winnerSeat === row.seat });
  return { finished: true, won: s.winnerSeat === 0 };
}

let games = 0;
let unfinished = 0;
let finished = 0;
let wonAsSeat0 = 0;
/*
  **A seed of its own for every game, which is not what the other harnesses here do**, and the
  reason is a measured property of the engine rather than a preference.

  One `seed` is one RNG stream, and the stream shuffles seat 0's deck and then seat 1's. The same
  stream produces the same *index* permutation however different the deck is, and every starter deck
  is built the same way — so at a fixed seed the opening hand holds the same number of lands in
  every pairing in the field. Measured directly, 156 pairings per seed:

    seed 3300: seat 0 opens on 4.00 lands, mean over 156 pairings, and the variance is ZERO
    seed 3302: 3.00, again zero
    seed 3303: 1.15, with 144 of the 156 opening on one land or none

  So 156 games at one seed are not 156 independent games: they are one shuffle wearing 156 deck
  pairings. The consequence is visible at the field level — seat 0's share of the whole field by
  seed came out **42-114, 63-93, 108-47, 115-41**, a swing from 27% to 74%, settling at 53% over the
  four of them, which is the play/draw advantage and is what a balanced field should give.

  **Paired designs are immune and that is why nothing in this directory has broken on it.**
  `deck-probe` and `bot-duel` run both arms over the same seeds, so the shared shuffle cancels in the
  difference they report — which is also exactly why their negative control (identical arms,
  identical score) comes out identical rather than merely close. What is *not* immune is an absolute
  rate, and an absolute rate is all this file produces.

  Hence a per-game seed, and hence the per-pass line in the output: with each game shuffled
  independently, each pass over the field should land near the same seat-0 share instead of ranging
  over forty points. A wide spread there now would mean this changed nothing and the correlation is
  somewhere else.
*/
const perPass = [];
let gameIndex = 0;
for (let i = 0; i < SEEDS; i++) {
  let passW0 = 0;
  let passW1 = 0;
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      // Both orders, so every deck plays each side.
      for (const order of [[ALL[a], ALL[b]], [ALL[b], ALL[a]]]) {
        // A seed of its own per game. See the block comment above.
        const out = duel(SEED0 + gameIndex, order);
        gameIndex += 1;
        games += 1;
        if (!out.finished) { unfinished += 1; continue; }
        finished += 1;
        if (out.won) { wonAsSeat0 += 1; passW0 += 1; } else passW1 += 1;
      }
    }
  }
  perPass.push(`${passW0}-${passW1}`);
}

console.log(`${games} games, ${SEEDS} passes over the field, one seed each from ${SEED0}, `
  + `${samples.length} samples`);
if (unfinished > 0) console.log(`${unfinished} games reached no winner and were dropped`);
console.log('turns count every seat\'s turn, so a duel\'s turn 8 is a seat\'s fourth');
console.log('one position per round, both seats\' views of it — see `sample`');
/*
  The control line, and the ladder below is unreadable without it. Every duel here is played with
  seat 0 on the play, so if seat 0 wins 40% of the field the whole ladder is shifted by that and
  "crosses 50% near zero" is the wrong thing to look for. Printed first so it cannot be skipped.
*/
console.log(`seat 0 (always on the play) won ${((wonAsSeat0 / Math.max(1, finished)) * 100).toFixed(0)}% `
  + `of ${finished} finished games`);
console.log(`per pass over the field, seat0-seat1: ${perPass.join('  ')}`);
console.log('each game has its own seed, so those should agree — a wide spread is a finding, not noise');

if (samples.length === 0) {
  console.log('');
  console.log('No samples at all, which is a broken harness rather than a finding — check that');
  console.log('`evaluate` is exported and that the duel loop reaches a winner.');
  process.exit(1);
}

/*
  Sign accuracy, which has one honest complication worth printing rather than hiding: a margin of
  **exactly zero** has no sign, and at turn 1 most of them are zero because the two seats are
  identical. Counted as half right, which is what a coin is worth, and the count of them is shown
  so a band that is mostly ties cannot masquerade as a band the evaluation read well.
*/
const accuracy = (rows, key) => {
  let right = 0;
  let ties = 0;
  for (const row of rows) {
    const margin = row[key];
    if (margin === 0) { ties += 1; right += 0.5; continue; }
    if ((margin > 0) === row.won) right += 1;
  }
  return { pct: rows.length === 0 ? 0 : (right / rows.length) * 100, ties };
};

console.log('');
console.log('sign accuracy — does the seat this says is ahead actually win?');
console.log(`${'turn'.padEnd(8)}${'samples'.padStart(8)}${KEYS.map((k) => k.padStart(9)).join('')}   ties`);
// Both seats contribute, so a band's base rate is 50% by construction and 50% is the coin to beat.

for (const [lo, hi] of BANDS) {
  const rows = samples.filter((r) => r.turn >= lo && r.turn <= hi);
  if (rows.length === 0) continue;
  const label = hi === 999 ? `${lo}+` : `${lo}-${hi}`;
  const cells = KEYS.map((k) => `${accuracy(rows, k).pct.toFixed(0)}%`.padStart(9)).join('');
  console.log(`${label.padEnd(8)}${String(rows.length).padStart(8)}${cells}`
    + `   ${accuracy(rows, 'total').ties}`);
}

console.log('');
const ladderBase = samples.filter((r) => r.turn >= LADDER[0] && r.turn <= LADDER[1]);
const baseRate = (ladderBase.filter((r) => r.won).length / Math.max(1, ladderBase.length)) * 100;
console.log(`win rate by evaluation margin, turns ${LADDER[0]}-${LADDER[1]}`);
console.log(`(base rate across these samples is ${baseRate.toFixed(0)}%, which a usable evaluation's`);
console.log(' ladder climbs through monotonically, crossing it near a margin of zero)');
const ladderRows = samples.filter((r) => r.turn >= LADDER[0] && r.turn <= LADDER[1]);
const edges = [-Infinity, ...BUCKETS, Infinity];
for (let i = 0; i < edges.length - 1; i++) {
  const [lo, hi] = [edges[i], edges[i + 1]];
  const rows = ladderRows.filter((r) => r.total >= lo && r.total < hi);
  if (rows.length === 0) continue;
  const won = rows.filter((r) => r.won).length;
  const label = lo === -Infinity ? `< ${hi}` : hi === Infinity ? `>= ${lo}` : `${lo} .. ${hi}`;
  console.log(`${label.padStart(12)}  ${String(rows.length).padStart(7)} samples`
    + `  ${((won / rows.length) * 100).toFixed(0).padStart(4)}% seat-0 wins`);
}
