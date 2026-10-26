/**
 * One bot against another, with a different setting each.
 *
 * The other half of the instrument. `deck-table` and `deck-probe` measure a *deck* against a field,
 * which is the wrong shape for a change to the opponent: a term in the evaluation has to be
 * measured against the bot without it. So both bots play every deck pairing, in both seats, on
 * identical seeds — the deck matchup and the seat both cancel, and what is left is the setting.
 *
 * `TESTED` and `CONTROL` are JSON `BotOptions`, handed to `botAction` for the seat that bot is
 * playing. With both empty this is a negative control, and it is worth running first every time:
 * two identical bots scored exactly 56-56 of 112 the day this was written, which is what makes any
 * movement in a real arm readable rather than arguable. See D116.
 *
 *   TESTED='{"lookahead":false}' SEEDS=3 node scripts/measure/bot-duel.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct,
} from '../../packages/rules-engine/dist/index.js';

const ALL = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance',
  'skyward-writ', 'hollow-tide', 'ashen-rite',
  'arc-tempest', 'dawn-tithe', 'delta-bloom'];
const SEEDS = Number(process.env.SEEDS ?? 3);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const TESTED = JSON.parse(process.env.TESTED ?? '{}');
const CONTROL = JSON.parse(process.env.CONTROL ?? '{}');
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/** `opts[seat]` is the bot that plays that seat. */
function duel(seed, decks, opts) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  for (let move = 0; move < 4000 && !s.finished; move++) {
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

let won = 0; let lost = 0; let draw = 0;
const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = 0; b < ALL.length; b++) {
      if (a === b) continue;
      // The same pairing twice with only the bots swapped, so the decks stay put: whatever the
      // matchup is worth, both arms get it exactly once.
      const first = duel(SEED0 + i, [ALL[a], ALL[b]], [TESTED, CONTROL]);
      if (first === 0) won += 1; else if (first === 1) lost += 1; else draw += 1;
      const second = duel(SEED0 + i, [ALL[a], ALL[b]], [CONTROL, TESTED]);
      if (second === 1) won += 1; else if (second === 0) lost += 1; else draw += 1;
    }
  }
}
const games = won + lost + draw;
console.log(`${JSON.stringify(TESTED)} vs ${JSON.stringify(CONTROL)}: ${won}-${lost}`
  + `${draw ? ` (${draw} unfinished)` : ''} of ${games} [${Math.round((Date.now() - started) / 1000)}s]`);
