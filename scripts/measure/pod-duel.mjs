/**
 * Two bots against two, in a four-seat Commander pod.
 *
 * Every other harness in this directory is a duel, which makes a whole class of question
 * unmeasurable: goad, the deals, the threat read and "prefer attacking the player holding the
 * crown" are all about *which opponent*, and in a duel there is only one. Those changes have been
 * argued rather than priced, and this is the instrument that stops that.
 *
 * **Two on two, with the seats rotated.** Each pod seats two bots on `TESTED` and two on `CONTROL`,
 * and every table is played four times with the arms rotated one seat each time — so each arm
 * occupies every seat equally often, turn order cancels, and what is left is the setting.
 *
 * **Its negative control is arithmetic, not evidence, and that is worth knowing before trusting a
 * number out of here.** With both arms empty all four rotations of a table are the *same game* —
 * same seed, same decks, same bot — so the same seat wins all four, and the rotation credits that
 * seat to `TESTED` on exactly two of them. It printed 66-66 of 132 the day it was written and it
 * could not have printed anything else. So unlike `bot-duel`, a 50-50 control here says nothing
 * about how noisy a pod is.
 *
 * **The floor is ±16 of 104 at `SEEDS=2`, and it is measured rather than left as an instruction
 * (D281).** One unchanged arm on three disjoint seed sets read **60-44, 50-54, 44-60** — a range of
 * 32 for a setting that did not move. So a single reading here wobbles by about sixteen games, which
 * is **fifteen percentage points**, and anything smaller than that is not a result.
 *
 * That number is in this docblock because the instruction it replaces did not work. This file used
 * to say "get the floor by re-running a real arm on a different seed set instead", and the next
 * person to use it — reading that very paragraph, and quoting its *other* warning in a decision log
 * the same afternoon — did not do it, and published a −8/0/−4 as a negative result. Three readings
 * inside ±16 are three coin flips. **A precondition stated as homework gets skipped; a number in the
 * docblock does not.**
 *
 * A pod is noisier than a duel by construction — three opponents, three chances to be attacked, and
 * four rotations of a table that share a seed. To resolve a four-point effect here needs roughly ten
 * times the games: about **1000 pods an arm**, three disjoint sets.
 *
 * **What that costs is measured now and it is twice what this docblock used to say** (D289). One
 * pass — 52 pods, every deck, all four rotations — takes **503 seconds**, so `SEEDS=20` is about
 * **two hours fifty**, not the ninety minutes claimed here since D281, and three disjoint sets is
 * eight and a half hours of compute. The run prints a **checkpoint per pass** for that reason: a
 * reading killed at 83 minutes used to be worth zero pods, and is now worth whatever it had
 * played. So **a pod win rate from this file is only a result if it quotes
 * this floor** — and in fairness to what came before, the two measurements that could have fallen
 * into this both stepped around it: the myriad slot reading established its own spread by re-running
 * a real arm on disjoint seeds (4-48 and 2-50 over 52 pods each), and `offerPact` says outright that
 * `pod-duel` cannot price it and ships for a reason that is not a win rate. The counts here are
 * unaffected either way — offers, politics, the throw audit.
 *
 * Raise `SEEDS` and the floor narrows roughly as the square root: `SEEDS=8` is four times the games
 * for half the wobble, which is the cheapest honest way to ask a pod question.
 *
 * **Every pod figure taken from this file before #276 was taken on an engine that did not enforce
 * CR 800.4a**, and that includes D294/D295's 2434 pods. A seat eliminated mid-pod used to leave its
 * whole board on the table — creatures, hand, library, graveyard — and three seats leave in every
 * pod that reaches a winner, so the change touches the back half of every game this file has ever
 * played. It does not retract anything: D295 is a null, and a null measured on a different engine is
 * still a null about that engine. But a number from before that commit and a number from after it
 * are **not the same measurement**, and a comparison that spans it is not a paired one.
 *
 *   TESTED='{"chaseTheCrown":false}' SEEDS=3 node scripts/measure/pod-duel.mjs
 *   TESTED='{"chaseTheCrown":false}' SEEDS=3 SEED0=4100 node scripts/measure/pod-duel.mjs
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 3);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const TESTED = JSON.parse(process.env.TESTED ?? '{}');
const CONTROL = JSON.parse(process.env.CONTROL ?? '{}');
const PLAYERS = [
  { playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' },
  { playerId: 'p2', name: 'C' }, { playerId: 'p3', name: 'D' },
];
const MOVES = Number(process.env.MOVES ?? 8000);

/** `opts[seat]` is the bot that plays that seat. Returns the winning seat, or null. */
function pod(seed, decks, opts) {
  let s = createGame({ id: `pod${seed}`, format: 'pod', players: PLAYERS, seed });
  for (const seat of [0, 1, 2, 3]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  for (let move = 0; move < MOVES && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, opts[seat]);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  return s.finished ? s.winnerSeat : null;
}

/*
  Which four decks sit at each table, chosen from the seed rather than at random.

  Deterministic because a measurement nobody can re-run is not one, and spread out because four
  decks out of eleven is a small window: a stride that is coprime with the pool size walks through
  every deck rather than pairing the same four all night.
*/
const table = (n) => [0, 1, 2, 3].map((i) => ALL[(n * 3 + i * 4) % ALL.length]);

/*
  One deck seated at every table, when a setting only means something while a particular card is in
  the game.

  Without it a rule about the crown is measured mostly in pods with no crown in them: those tables
  play the same game in all four rotations and contribute exactly two wins to each arm, which is not
  a draw — it is dilution, and it drags any real effect towards the middle. `ALWAYS=dawn-tithe`
  seats the deck that can produce the thing being measured, and the seat it takes rotates with the
  table so turn order still cancels.
*/
const ALWAYS = process.env.ALWAYS ?? '';
const seated = (n) => {
  const decks = table(n);
  if (ALWAYS === '') return decks;
  if (decks.includes(ALWAYS)) return decks;
  const out = [...decks];
  out[n % 4] = ALWAYS;
  return out;
};

/*
  A seed per **table**, not per game. One seed for a whole pass meant every table in it shared a
  shuffle (D240); but the four rotations below are the arms — the same table with TESTED and
  CONTROL moved around the seats — and they have to keep sharing a seed or each arm stops playing
  the same table as the other.
*/
const seedFor = (pass, t) => SEED0 + (pass * ALL.length) + t;

let tested = 0; let control = 0; let unfinished = 0;
const started = Date.now();
/*
  A running tally, printed per pass, which this file learned the expensive way.

  `SEEDS=20` is 1040 pods and takes about an hour and a half; the first attempt at it was killed by
  a container restart at **83 minutes** and produced **nothing at all**, because every number lived
  in these three variables until the one `console.log` at the end. A reading of 988 pods would have
  been a perfectly good answer to the question; zero was not.

  So the line below is a checkpoint rather than progress chatter: each one is a complete, quotable
  result over the pods finished so far, on whole passes (every table, all four rotations) so it is
  never a half-rotated table. Anything that interrupts the run now leaves the last checkpoint
  standing, and the final line is just the last one with the whole sample in it.

  `process.stdout.write` with an explicit newline rather than `console.log` makes no difference to
  flushing here — Node writes to a pipe synchronously for small strings — but a redirect into a file
  is only visible to another process after the write, which is the case this exists for.
*/
for (let i = 0; i < SEEDS; i++) {
  for (let t = 0; t < ALL.length; t++) {
    const decks = seated(t);
    // Four rotations, so each arm plays each seat once per table.
    for (let shift = 0; shift < 4; shift++) {
      const opts = [0, 1, 2, 3].map((seat) => ((seat + shift) % 2 === 0 ? TESTED : CONTROL));
      const winner = pod(seedFor(i, t), decks, opts);
      if (winner === null) unfinished += 1;
      else if (opts[winner] === TESTED) tested += 1;
      else control += 1;
    }
  }
  process.stdout.write(`  after ${i + 1} of ${SEEDS} passes: ${tested}-${control}`
    + `${unfinished ? ` (${unfinished} unfinished)` : ''} of ${tested + control + unfinished} pods`
    + ` [${Math.round((Date.now() - started) / 1000)}s]\n`);
}
const games = tested + control + unfinished;
console.log(`${JSON.stringify(TESTED)} vs ${JSON.stringify(CONTROL)}: ${tested}-${control}`
  + `${unfinished ? ` (${unfinished} unfinished)` : ''} of ${games} pods`
  + ` [${Math.round((Date.now() - started) / 1000)}s]`);
