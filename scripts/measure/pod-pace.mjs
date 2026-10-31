/**
 * How fast can the engine play a game, with nothing watching it?
 *
 * Every other harness here measures *what* the bot decides. This one measures how long it takes to
 * decide, and it exists because a browser suite claimed a cost that was not the engine's. The solo
 * suite's `SOLO_POD=1` run read about 3.3 seconds a move, which reads like three searching bots
 * being expensive at four seats (#250). It is not: the same shape of game played straight through
 * the engine comes back in **7-10 ms a move**, finishing in seconds. Whatever the browser suite was
 * paying for, the bots were about 0.3% of it.
 *
 * That is the whole point of keeping this. "The bots are slow" is the obvious explanation for any
 * slow table and it is cheap to believe; this is one command that refuses it, and names the engine's
 * actual pace so the rest of the cost has to be accounted for somewhere else.
 *
 *   node scripts/measure/pod-pace.mjs                 # four seats, three games
 *   SEATS=2 node scripts/measure/pod-pace.mjs         # the duel, for comparison
 *   SEATS=4 GAMES=8 node scripts/measure/pod-pace.mjs # a wider sample
 *
 * It prints the share of wall time spent inside `botAction`, which is the number that says whether
 * a future slowdown is the search or the reducer. It has been 67-70% at four seats.
 *
 * **It is a pace, not a win rate.** Seats all play the same bot and the decks rotate by game index,
 * so nothing here is an arm against an arm — do not read anything about a deck or a rule off it. For
 * that, use `pod-duel.mjs`, which rotates the arms around the seats.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEATS = Number(process.env.SEATS ?? 4);
const GAMES = Number(process.env.GAMES ?? 3);
const SEED0 = Number(process.env.SEED0 ?? 9100);
// Generous on purpose: the question is how long a whole game takes, so a cap that cuts one short
// turns a pace into a fraction of a pace. A four-seat pod has wanted up to ~650.
const MOVES = Number(process.env.MOVES ?? 4000);

for (let g = 0; g < GAMES; g += 1) {
  const seed = SEED0 + g;
  const players = Array.from({ length: SEATS }, (_, i) => ({ playerId: `p${i}`, name: `S${i}` }));
  const decks = Array.from({ length: SEATS }, (_, i) => ALL[(g * SEATS + i) % ALL.length]);
  let s = createGame({
    id: `pace${seed}`,
    // 'pod' at four seats and 'modern' at two, matching pod-duel.mjs and bot-duel.mjs so a pace
    // taken here is comparable with the arms those two measure.
    format: SEATS > 2 ? 'pod' : 'modern',
    players,
    seed,
  });
  for (let i = 0; i < SEATS; i += 1) {
    s = applyAction(s, { type: 'deck:load', by: i, seat: i, deckId: decks[i] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });

  const t0 = process.hrtime.bigint();
  let moves = 0;
  let botNs = 0n;
  while (moves < MOVES && !s.finished) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const b0 = process.hrtime.bigint();
    const action = botAction(s, seat);
    botNs += process.hrtime.bigint() - b0;
    if (action === null) break;
    try { s = applyAction(s, action); } catch { break; }
    moves += 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const botMs = Number(botNs) / 1e6;
  console.log(
    `${SEATS} seats, seed ${seed}: ${moves} moves in ${(ms / 1000).toFixed(1)}s`
    + ` = ${(ms / Math.max(1, moves)).toFixed(1)} ms/move`
    + ` (${(botMs / ms * 100).toFixed(0)}% in botAction)`
    + `, turn ${s.turn ?? '?'}, ${s.finished ? 'finished' : 'UNFINISHED'}`,
  );
}
