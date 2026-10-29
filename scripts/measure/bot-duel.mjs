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
 *   SUBJECT=skyward-writ TESTED='{"blinksWell":false}' SEEDS=6 node scripts/measure/bot-duel.mjs
 *
 * `SUBJECT` narrows the field to the pairings **one deck** is in: that deck against each of the
 * others, in both seats, with the bots swapped, so a seed set is 48 games rather than 312.
 *
 * **It buys time, not signal, and reaching for it to sharpen a reading is a mistake this file
 * already warned about.** A pairing where the setting is inactive for both arms is the *same game
 * twice* on the same seed — one win credited to each arm — so it adds exactly nothing to the
 * difference and exactly nothing to its variance. The full field is not diluted; only the
 * percentage is, and the difference is what is read. So `TESTED` against `CONTROL` comes out the
 * same number either way, and the subject run simply gets there six times faster. Quote the
 * difference rather than the ratio when you use it, because the denominator has changed.
 *
 * And the thing it really does cost: a rule that fires off cards in **more than one** deck loses
 * the pairings of the decks it did not name. `blinksWell` is the example — Soulherder is in
 * Skyward Writ and Cloudshift is in Verdant Guard, so `SUBJECT=skyward-writ` prices three quarters
 * of the rule and a full run prices all of it. Run the subject first for the fast answer, then the
 * field to be sure what was measured was the whole rule.
 *
 * The negative control costs nothing to reason about and is worth saying out loud: with `TESTED`
 * and `CONTROL` identical the two arms are the *same game* played twice, so the score is exactly
 * even by construction rather than approximately even by luck — 156-156 of 312 on the day `SUBJECT`
 * was added. What that proves is this harness's symmetry, not that a setting is connected; for
 * that, see D216 and run a rule known to matter (`lookahead: false`) through the same filter.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
/** One deck's pairings only, for a rule that can only fire off a card in it. */
const SUBJECT = process.env.SUBJECT ?? '';
if (SUBJECT !== '' && !ALL.includes(SUBJECT)) {
  console.error(`no such deck: ${SUBJECT}. One of: ${ALL.join(', ')}`);
  process.exit(1);
}
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
      if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
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
console.log(`${SUBJECT === '' ? 'the whole field' : `${SUBJECT}'s pairings`}: `
  + `${JSON.stringify(TESTED)} vs ${JSON.stringify(CONTROL)}: ${won}-${lost}`
  + `${draw ? ` (${draw} unfinished)` : ''} of ${games} [${Math.round((Date.now() - started) / 1000)}s]`);
