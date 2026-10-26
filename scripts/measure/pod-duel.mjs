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
 * **Get the floor by re-running a real arm on a different seed set instead.** Two runs of the same
 * setting on disjoint seeds differ by however much this harness wobbles, and that spread is the
 * number to disbelieve smaller results than. A pod is noisier than a duel by construction — three
 * opponents, three chances to be attacked — so expect it to be wide.
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

let tested = 0; let control = 0; let unfinished = 0;
const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let t = 0; t < ALL.length; t++) {
    const decks = seated(t);
    // Four rotations, so each arm plays each seat once per table.
    for (let shift = 0; shift < 4; shift++) {
      const opts = [0, 1, 2, 3].map((seat) => ((seat + shift) % 2 === 0 ? TESTED : CONTROL));
      const winner = pod(SEED0 + i, decks, opts);
      if (winner === null) unfinished += 1;
      else if (opts[winner] === TESTED) tested += 1;
      else control += 1;
    }
  }
}
const games = tested + control + unfinished;
console.log(`${JSON.stringify(TESTED)} vs ${JSON.stringify(CONTROL)}: ${tested}-${control}`
  + `${unfinished ? ` (${unfinished} unfinished)` : ''} of ${games} pods`
  + ` [${Math.round((Date.now() - started) / 1000)}s]`);
