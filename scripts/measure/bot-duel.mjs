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
 * **Before any games are played the arm is checked for being connected at all**: both arms are
 * asked the same few thousand positions, and if no decision ever differs the run stops with a
 * non-zero exit instead of spending fifteen minutes to report an arithmetic tie. See the block
 * above `started` for why that is worth a pre-flight, and `ALLOW_INERT=1` for running anyway.
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
/*
  A seed per **pairing**, deliberately not per game — which is the opposite of what the absolute
  harnesses needed and for the same underlying reason.

  One seed was being used for a whole pass over the field, so the 156 games in it were one shuffle
  wearing 156 pairings (D240). That had to go. But the two calls below are not two games, they are
  the two **arms**: the same decks with the bots swapped, so that whatever the matchup is worth,
  both arms get it exactly once. They must keep sharing a seed or the pairing this file is built on
  is gone, and the tell would be the negative control — the same bot in both arms reads exactly
  468-468, and it reads exactly that *because* the games are the same games.
*/
const seedFor = (pass, a, b) => SEED0 + (pass * ALL.length + a) * ALL.length + b;

/*
  Does the arm under test change anything at all? Asked before 936 games are spent on it.

  `TESTED` is parsed straight out of the environment and handed to `botAction` as `BotOptions`, and
  `botAction` ignores a key it does not know. That is the correct behaviour for an options bag and a
  trap for a measuring harness: `TESTED='{"castable":1}'` is a plausible-looking typo for
  `{"weights":{"castable":1}}`, it sets a field no one reads, **both arms are then the stock bot**,
  and the run comes back 467-467. Which is this file's own negative control — the two arms are the
  same game played twice, so the tie is arithmetic rather than evidence. It cost three seed sets and
  fifteen minutes, and the only reason it was caught is that the tie was *perfect* three times over;
  a term that happened to land on 470-464 would have been written up as a real result.

  So the check is not a list of the keys `BotOptions` has — that would be a second reader of a type
  that already has one, and it would go quiet rather than wrong the next time the type grows (D260).
  It is empirical: play a few games with the shipping bot, and at every decision ask *both* arms the
  position. If no decision ever comes back different, the arm is inert, and whatever the score says
  afterwards is a statement about this harness and not about the setting.

  The probe is the same ablation `term-leverage` runs, which is why the budget is set where it is:
  that instrument saw the thinnest real term so far move 157 of 17451 decisions, 0.9%, so ~3000
  decisions is around twenty expected differences and a long way from a coin flip. It stops at the
  first one.

  It cannot tell a typo from a rule whose window never opens, and it does not pretend to: both
  read as "no decision differed", and the message says so and names the knob for each. That is not
  a weakness of the check so much as a real fact about the measurement — `holdsNinjas` is a field
  that exists and is read, and it trips this guard, because the ninja-in-hand-with-an-unblocked-
  attacker window opened 0 times in 95 declare-blockers steps (see the README). Its 467-467 was a
  true reading of a rule that almost never fires, and this guard would have said that up front for
  the price of twenty seconds instead of fifteen minutes.

  Two ways past it, both deliberate:
    - identical arms are skipped outright, because the negative control is a thing you run on purpose;
    - `ALLOW_INERT=1` runs anyway, for measuring that a term which changes no decision also changes
      no games.
*/
const stable = (v) => JSON.stringify(v, (_k, x) =>
  (x !== null && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x));
const PROBE = Number(process.env.PROBE_DECISIONS ?? 3000);
const ALLOW_INERT = process.env.ALLOW_INERT === '1';

/** The first decision the two arms disagree about, or null if they never do. */
function firstDisagreement(budget) {
  let seen = 0;
  let pairings = 0;
  for (let a = 0; a < ALL.length && seen < budget; a++) {
    const b = (a + 1) % ALL.length;
    if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
    const seed = seedFor(0, a, b);
    pairings += 1;
    let s = createGame({ id: `probe${seed}`, format: 'modern', players: PLAYERS, seed });
    for (const seat of [0, 1]) {
      s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: [ALL[a], ALL[b]][seat] }, { isHost: true });
    }
    s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
    s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
    for (let move = 0; move < 4000 && !s.finished && seen < budget; move++) {
      const seat = seatsToAct(s)[0];
      if (seat === undefined) break;
      // Driven by CONTROL, which is the shipping line, so the positions are the ones the bot
      // actually reaches rather than ones only the tested arm would walk into.
      const control = botAction(s, seat, CONTROL);
      const tested = botAction(s, seat, TESTED);
      seen += 1;
      if (stable(tested) !== stable(control)) {
        return { decisions: seen, pairings, turn: s.turn, step: s.step, tested, control };
      }
      if (control === null) break;
      const before = s.stateVersion;
      try { s = applyAction(s, control); } catch { break; }
      if (s.stateVersion === before) break;
    }
  }
  return { decisions: seen, pairings, none: true };
}

if (stable(TESTED) === stable(CONTROL)) {
  console.log(`negative control: both arms ${stable(TESTED)}, so an exact tie is the expected result`);
} else {
  const diff = firstDisagreement(PROBE);
  if (diff.none === true) {
    console.log('');
    console.log(`!! the arm under test changes no decision in ${diff.decisions} positions across`);
    console.log(`!! ${diff.pairings} pairing(s): botAction answered ${stable(CONTROL)} and`);
    console.log(`!! ${stable(TESTED)} identically every time. Whatever the score below says, it is`);
    console.log('!! a statement about this harness and not about the setting — two bots that never');
    console.log('!! disagree are the same game played twice, which ties exactly by construction.');
    console.log('!!');
    console.log('!! Two things look like this and they need opposite fixes:');
    console.log('!!');
    console.log('!!  1. a key BotOptions does not have, which botAction ignores in silence. A');
    console.log('!!     weight belongs at {"weights":{"<name>":1}}, not {"<name>":1} — check the');
    console.log('!!     name against BotOptions in packages/rules-engine/src/bot.ts.');
    console.log('!!  2. a rule whose situation never came up in the games probed. A rule that can');
    console.log('!!     only fire off a card in one deck wants SUBJECT=<that deck>, which narrows');
    console.log('!!     the probe as well as the run; a rule that fires late wants a bigger');
    console.log('!!     PROBE_DECISIONS. If neither finds a disagreement, 936 games will not');
    console.log('!!     either, and the thing to measure is how often the window exists at all.');
    console.log('!!');
    console.log('!! ALLOW_INERT=1 runs anyway, to price a term that genuinely moves no decision.');
    process.exit(1);
  }
  // Both actions printed rather than just their types: the interesting disagreements are two
  // `auto:cast`s naming different cards, and "auto:cast vs auto:cast" says nothing.
  const short = (a) => { const t = stable(a); return t.length > 110 ? `${t.slice(0, 107)}...` : t; };
  console.log(`arm is connected: differs by decision ${diff.decisions}, turn ${diff.turn} ${diff.step}`);
  console.log(`  tested:  ${short(diff.tested)}`);
  console.log(`  control: ${short(diff.control)}`);
}

const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = 0; b < ALL.length; b++) {
      if (a === b) continue;
      if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
      // The same pairing twice with only the bots swapped, so the decks stay put: whatever the
      // matchup is worth, both arms get it exactly once.
      const seed = seedFor(i, a, b);
      const first = duel(seed, [ALL[a], ALL[b]], [TESTED, CONTROL]);
      if (first === 0) won += 1; else if (first === 1) lost += 1; else draw += 1;
      const second = duel(seed, [ALL[a], ALL[b]], [CONTROL, TESTED]);
      if (second === 1) won += 1; else if (second === 0) lost += 1; else draw += 1;
    }
  }
}
const games = won + lost + draw;
console.log(`${SUBJECT === '' ? 'the whole field' : `${SUBJECT}'s pairings`}: `
  + `${JSON.stringify(TESTED)} vs ${JSON.stringify(CONTROL)}: ${won}-${lost}`
  + `${draw ? ` (${draw} unfinished)` : ''} of ${games} [${Math.round((Date.now() - started) / 1000)}s]`);
