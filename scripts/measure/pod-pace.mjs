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
/*
  An arm to price, as JSON `BotOptions`. Unset, this file does what it always did: time the shipping
  bot playing whole games.

  **It changes what `ms/move` on the line above means, and that number must not be read as a pace.**
  Two searches run at every position instead of one, so it lands around 1.7x a plain run's figure and
  would read as a regression against the ones in the README. The per-decision numbers below it are
  the readings; the pace comes from a run with `BOT` unset.

  Set, it answers "what does this setting cost in milliseconds", and the shape of that question is
  an **ablation rather than a race**. The tempting version — run the whole file twice, once per
  setting, and compare the two ms/move — compares two *different sets of games*, because the moment
  the arms disagree about one move the positions diverge and everything after it is a different
  game with a different mix of decisions. That is precisely the error D264 had to withdraw a figure
  for, and a term that makes the bot play longer games would read as a term that is slower per
  decision, or hide being one.

  So the stock bot drives, and at every position **both** arms are asked the same question and both
  are timed. The difference is then a per-decision cost on an identical position mix, with no
  sampling argument to make.

  The order alternates by move, because the first of two calls on one position pays for whatever
  the second then finds warm — memoised affordability, a JIT that has just specialised the path.
  Fixing the order would hand that subsidy to the same arm every time.
*/
const BOT = process.env.BOT === undefined ? null : JSON.parse(process.env.BOT);

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
  let armNs = 0n;
  let differed = 0;
  while (moves < MOVES && !s.finished) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    let action;
    if (BOT === null) {
      const b0 = process.hrtime.bigint();
      action = botAction(s, seat);
      botNs += process.hrtime.bigint() - b0;
    } else {
      // Alternating order, per the note on BOT: whichever call runs first pays the warm-up.
      const stockFirst = moves % 2 === 0;
      const timed = (opts) => {
        const b0 = process.hrtime.bigint();
        const out = botAction(s, seat, opts);
        return [out, process.hrtime.bigint() - b0];
      };
      let stock; let arm;
      if (stockFirst) { stock = timed(undefined); arm = timed(BOT); }
      else { arm = timed(BOT); stock = timed(undefined); }
      botNs += stock[1];
      armNs += arm[1];
      if (JSON.stringify(stock[0]) !== JSON.stringify(arm[0])) differed += 1;
      // The stock bot drives, so both arms keep being asked the same positions.
      [action] = stock;
    }
    if (action === null) break;
    try { s = applyAction(s, action); } catch { break; }
    moves += 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const botMs = Number(botNs) / 1e6;
  const per = (n) => (Number(n) / 1e6 / Math.max(1, moves)).toFixed(2);
  console.log(
    `${SEATS} seats, seed ${seed}: ${moves} moves in ${(ms / 1000).toFixed(1)}s`
    + ` = ${(ms / Math.max(1, moves)).toFixed(1)} ms/move`
    + ` (${(botMs / ms * 100).toFixed(0)}% in botAction)`
    + `, turn ${s.turn ?? '?'}, ${s.finished ? 'finished' : 'UNFINISHED'}`
    // Said on the line itself, because the number looks like a pace and is not one. With BOT set,
    // every move pays for TWO botAction calls, so ms/move runs ~1.7x a plain run's and would read
    // as a regression against the figures in the README if anyone compared them. It nearly did
    // here: 13.0 against a recorded 8.4 on the same seed, which is 8.4 plus a second search.
    + (BOT === null ? '' : ' [both arms timed: NOT a pace, see below]'),
  );
  if (BOT !== null) {
    /*
      A disagreement count, because a cost with no effect behind it is a different finding from a
      cost that buys something -- and an arm that changes nothing is the inert-arm trap bot-duel
      now refuses outright (D270). Here it is printed rather than fatal: pricing a term that moves
      no decision is a legitimate thing to want to know, and this file cannot tell a typo from a
      window that never opens either.
    */
    console.log(
      `    shipping ${per(botNs)} ms/decision, ${JSON.stringify(BOT)} ${per(armNs)} ms/decision`
      + ` -> the setting is worth ${(Number(botNs - armNs) / 1e6 / Math.max(1, moves)).toFixed(2)}`
      + ` ms/decision, and changed ${differed} of ${moves} decisions`,
    );
  }
}
