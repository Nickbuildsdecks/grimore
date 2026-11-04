/**
 * Why does a **pod** ever stop without a winner? The four causes, told apart.
 *
 *   pnpm --filter @grimore/rules-engine build
 *   SEED0=7830 SEEDS=3 node scripts/measure/pod-unfinished.mjs
 *
 * `unfinished.mjs` asked this question of duels and found the answer worth a file of its own:
 * thirty-five harnesses end their move loop with `try { … } catch { break; }` and **not one
 * reports that it caught anything**, so a game that stops is counted as a game that was played.
 * "Unfinished" is four different things wearing one word — the move cap, no seat to act, a bot
 * with no legal action, a loop that makes no progress, and a **throw**, which is the engine
 * refusing an action it built out of its own `legalActions`.
 *
 * **`pod-duel` was never given that treatment, and it is the harness a real answer now rests on.**
 * #268 spent 2442 pods on the clock's pod win rate and **8 of them ended without a winner** (D294,
 * D295). Those eight were excluded from the denominator, which is the right arithmetic and says
 * nothing about why they happened. If any of them is a throw it is a violation of an invariant
 * `playout.test.ts` asserts — the engine never refuses what it offered — and the conclusion drawn
 * from the other 2434 would be resting on a harness quietly hiding a bug.
 *
 * So this replays the pods `pod-duel` plays, at the same seeds with the same arms, and classifies
 * every one that does not reach a winner. It is deliberately a separate file rather than a flag on
 * `pod-duel`: that file is a win rate and this is a bug hunt, and giving the win rate a second job
 * is how a measurement acquires a branch nobody reads.
 *
 * **A non-zero exit is the point.** A throw contaminates every pod figure in this directory by
 * exactly the fraction of games it occurs in; the move cap does not, and neither does a seat with
 * nothing legal to do at the end of a game that was going to be a draw anyway.
 *
 * The seeds, arms and seating are copied from `pod-duel` rather than imported, because that file
 * exports nothing and reaching into it would couple a bug hunt to a win rate. They must stay in
 * step: `seedFor(pass, t) = SEED0 + pass * decks + t`, four rotations a table.
 *
 * **A replay is only a replay of the build the figures were taken on.** The eight pods this file was
 * written for were played before CR 800.4a was enforced (#276), when a seat eliminated mid-pod left
 * its whole board on the table. Running this on a later build replays the same *seeds* and not the
 * same *games*: which pods fail to finish, and why, are both properties of the engine. So a reading
 * meant to explain a particular pod figure has to be taken on the build that produced it — which is
 * why the result below is quoted with the commit it was taken at rather than as a standing fact.
 */
import {
  STARTER_DECKS, applyAction, botAction, createGame, seatsToAct,
} from '../lib/engine.mjs';
import { provenanceLine } from '../lib/provenance.mjs';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 3);
const SEED0 = Number(process.env.SEED0 ?? 7830);
const TESTED = JSON.parse(process.env.TESTED ?? '{"weights":{"clockRate":1}}');
const CONTROL = JSON.parse(process.env.CONTROL ?? '{}');
const MOVES = Number(process.env.MOVES ?? 8000);
const PLAYERS = [
  { playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' },
  { playerId: 'p2', name: 'C' }, { playerId: 'p3', name: 'D' },
];

const table = (n) => [0, 1, 2, 3].map((i) => ALL[(n * 3 + i * 4) % ALL.length]);
const seedFor = (pass, t) => SEED0 + (pass * ALL.length) + t;

/** Returns `{ winner }` or `{ why, detail, move, turn }` — never both. */
function pod(seed, decks, opts) {
  let s = createGame({ id: `pod${seed}`, format: 'pod', players: PLAYERS, seed });
  for (const seat of [0, 1, 2, 3]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  for (let move = 0; move < MOVES && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) return { why: 'no seat to act', detail: '', move, turn: s.turn };
    const action = botAction(s, seat, opts[seat]);
    if (action === null) return { why: 'bot had no action', detail: '', move, turn: s.turn };
    const before = s.stateVersion;
    try {
      s = applyAction(s, action);
    } catch (err) {
      // The one that matters: the engine refused an action the bot built from legalActions.
      return { why: 'THREW', detail: `${action.type}: ${err?.message ?? err}`, move, turn: s.turn };
    }
    if (s.stateVersion === before) {
      return { why: 'no progress', detail: action.type, move, turn: s.turn };
    }
  }
  if (s.finished) return { winner: s.winnerSeat };
  return { why: 'move cap', detail: `${MOVES} moves`, move: MOVES, turn: s.turn };
}

/*
  The build this replay is of, printed first — which for this file is the result's precondition
  rather than a footnote (#278).

  The docblock above says a replay is only a replay of the build the figures came from. That is a
  claim nobody can check against a run that did not say which build it was, so the run says.
*/
process.stdout.write(`${provenanceLine({ SEED0, SEEDS, MOVES, TESTED, CONTROL })}\n`);

const causes = new Map();
let played = 0; let decided = 0;
for (let i = 0; i < SEEDS; i++) {
  for (let t = 0; t < ALL.length; t++) {
    const decks = table(t);
    for (let shift = 0; shift < 4; shift++) {
      const opts = [0, 1, 2, 3].map((seat) => ((seat + shift) % 2 === 0 ? TESTED : CONTROL));
      const seed = seedFor(i, t);
      const out = pod(seed, decks, opts);
      played += 1;
      if (out.winner !== undefined) { decided += 1; continue; }
      const key = `${out.why}${out.detail ? ` — ${out.detail}` : ''}`;
      const seen = causes.get(key) ?? { n: 0, where: [] };
      seen.n += 1;
      if (seen.where.length < 4) seen.where.push(`seed ${seed} shift ${shift} turn ${out.turn} move ${out.move}`);
      causes.set(key, seen);
    }
  }
  process.stdout.write(`  after ${i + 1} of ${SEEDS} passes: ${decided} decided of ${played}\n`);
}

console.log(`\n${played} pods, ${decided} decided, ${played - decided} not`);
if (causes.size === 0) console.log('every pod reached a winner');
const threw = [...causes.keys()].some((k) => k.startsWith('THREW'));
for (const [key, { n, where }] of [...causes].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(n).padStart(3)}x  ${key}`);
  for (const w of where) console.log(`        ${w}`);
}
if (threw) {
  console.log('\nA throw is the engine refusing an action it offered, which playout.test.ts');
  console.log('asserts never happens. Every pod figure is contaminated by this fraction.');
  process.exitCode = 1;
}
