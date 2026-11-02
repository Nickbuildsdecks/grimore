/**
 * Does a bot setting make the bot **passive**? Counts what it sends, not how long the game took.
 *
 * Written for a specific question the win rate could not answer (#262, D280). D275/D276 found the
 * clock term worth +1.5 points in a duel and −3.8 in a pod, and the pod arm's games ran 45% more
 * turns. The units were wrong too and fixing them cut the length (2.06x moves to 1.29x) **without
 * fixing the record** — so scaling was never the whole story, and "the games got longer" is a
 * symptom rather than a cause.
 *
 * The hypothesis worth testing: *the clock makes the seat afraid of the attack coming back, so it
 * holds its blockers, and in a pod holding back is losing.* In a duel, surviving the swing and
 * winning the attrition is the same thing. At four seats it is not: a seat that never pressures
 * anybody is a seat that never wins, however long it lives. That would make the term right in one
 * format and wrong in the other **for a reason about the format rather than the arithmetic**, which
 * is a different claim from D276's and the one that explains why both scalings lost.
 *
 * **An ablation, so there is no sampling argument.** The stock bot drives, and at every attack
 * declaration both arms are asked the *same* position: what would you send here? Counting the
 * shipping bot's own declarations across two separate runs would compare two different sets of
 * games — the error D264 withdrew a figure for, and the one `pod-pace`'s arm was built to avoid.
 *
 * What it reports per arm: how many creatures it sends per declaration, and how often it sends
 * **nothing at all**. The second number is the one the hypothesis is about.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     BOT='{"weights":{"clockRate":1}}' SEATS=4 SEEDS=2 node scripts/measure/aggression.mjs
 *     BOT='{"weights":{"clockRate":1}}' SEATS=2 SEEDS=2 node scripts/measure/aggression.mjs
 *
 * The duel run is the control that makes the pod run mean something: if the arm declines to attack
 * in a duel just as much, the finding is "this term is passive" rather than "this term is passive
 * in a pod", and the format explanation is dead.
 */
import {
  applyAction, createGame, botAction, seatsToAct, legalActions, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEATS = Number(process.env.SEATS ?? 4);
const SEEDS = Number(process.env.SEEDS ?? 2);
const SEED0 = Number(process.env.SEED0 ?? 8800);
const MOVES = Number(process.env.MOVES ?? (SEATS === 4 ? 8000 : 4000));
const BOT = JSON.parse(process.env.BOT ?? '{"weights":{"clockRate":1}}');
const PLAYERS = ['A', 'B', 'C', 'D'].slice(0, SEATS)
  .map((name, i) => ({ playerId: `p${i}`, name }));
const SEATING = [...Array(SEATS).keys()];
const FORMAT = SEATS === 4 ? 'pod' : 'modern';

/** arm -> { declarations, sent, empty, able } */
const arms = new Map([['shipping', fresh()], ['tested', fresh()]]);
function fresh() { return { declarations: 0, sent: 0, empty: 0, able: 0 }; }
function note(arm, action, able) {
  const row = arms.get(arm);
  row.declarations += 1;
  row.able += able;
  const n = action !== null && action.type === 'auto:attack' ? action.attackers.length : 0;
  row.sent += n;
  if (n === 0) row.empty += 1;
}

let games = 0;
const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let t = 0; t < ALL.length; t++) {
    const seed = SEED0 + i * ALL.length + t;
    const decks = SEATING.map((j) => ALL[(t * 3 + j * 4) % ALL.length]);
    let s = createGame({ id: `a${seed}`, format: FORMAT, players: PLAYERS, seed });
    for (const seat of SEATING) {
      s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
    }
    s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
    s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
    games += 1;
    for (let move = 0; move < MOVES && !s.finished; move++) {
      const seat = seatsToAct(s)[0];
      if (seat === undefined) break;
      const la = legalActions(s, seat);
      // Only the declarations, and only the ones where something could have been sent: a seat with
      // no able creature has no opinion to measure and would dilute both arms equally.
      if (la.mustDeclare === 'attackers' && la.attackers.length > 0) {
        note('shipping', botAction(s, seat, {}), la.attackers.length);
        note('tested', botAction(s, seat, BOT), la.attackers.length);
      }
      const action = botAction(s, seat, {});
      if (action === null) break;
      const before = s.stateVersion;
      try { s = applyAction(s, action); } catch { break; }
      if (s.stateVersion === before) break;
    }
  }
}

console.log(`${games} ${SEATS === 4 ? 'pods' : 'games'}, ${SEEDS} seeds from ${SEED0}`
  + `, arm ${JSON.stringify(BOT)}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log('both arms asked the same declaration, so this is an ablation');
console.log('');
console.log(`${'arm'.padEnd(10)}${'declarations'.padStart(14)}${'sent'.padStart(8)}`
  + `${'per decl'.padStart(10)}${'sent nothing'.padStart(14)}`);
for (const [name, r] of arms) {
  console.log(name.padEnd(10) + String(r.declarations).padStart(14) + String(r.sent).padStart(8)
    + (r.sent / Math.max(1, r.declarations)).toFixed(2).padStart(10)
    + `${r.empty} (${(100 * r.empty / Math.max(1, r.declarations)).toFixed(0)}%)`.padStart(14));
}
const ship = arms.get('shipping');
const test = arms.get('tested');
console.log('');
const dSent = test.sent - ship.sent;
const dEmpty = test.empty - ship.empty;
console.log(`the arm sends ${dSent >= 0 ? '+' : ''}${dSent} creatures`
  + ` (${(100 * dSent / Math.max(1, ship.sent)).toFixed(1)}%)`
  + ` and declines ${dEmpty >= 0 ? '+' : ''}${dEmpty} more declarations`
  + ` across ${ship.declarations} of them, out of ${ship.able} able creatures offered`);
