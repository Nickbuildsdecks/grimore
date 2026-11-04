/**
 * How many of the questions this table asks have only one possible answer?
 *
 * A drawer that opens, interrupts the game, and offers one button is pure friction: the engine
 * already knows the answer and is making a person press it. That is a premium-table question rather
 * than a rules one, and **the project already knows it matters one card at a time.**
 * `LegalActions.mustCastOffered.mandatory` exists for exactly this, and its comment says why:
 *
 *   > a button that cannot be pressed is worse than no button — which is what the first run of
 *   > `LIST=suspend` showed, with "Cast it Decline" on a question that has one answer.
 *
 * That insight is written **at a card**. Nothing has ever asked it of the whole set, which is D269's
 * shape: the answer existed in the codebase and no instrument could see it.
 *
 * So this replays bot games and, at every state, asks `legalActions` of every seat and classifies
 * whatever question is pending. Bots answer these silently; a person sees a modal. What is counted
 * is therefore **what a human would have been asked**, which is the thing nobody has measured.
 *
 * **It counts the interrupting questions, not the turn.** `plays` during your own priority is not a
 * prompt, it is the game; `canPass` with nothing to do is already handled by auto-pass (#20). What
 * opens a drawer is `mustDecide`, `mustChoose`, `mustPay`, `mustDredge`, `mustCastOffered`,
 * `mustDiscard`, `mustSettleHand`, `mustOrder` and the two declarations.
 *
 * **Forced is counted conservatively, so a high number is believable** — and the first run of this
 * file is why that sentence is here rather than implied. It reported 26 of 26 opening hands as
 * having one answer, 81% of everything it counted, on a test that read `bottomOwed === 0` as "there
 * is nothing left to decide". There was: the player could mulligan. The number was an artefact of
 * the classifier, not a fact about the table, and it would have been published as a finding
 * (D279).
 *
 * Where the number of answers is arguable the question is counted as a real choice, not as friction. A `mustDecide` with two
 * candidates and `min: 1, max: 1` is a genuine choice even if one is obviously right; only
 * `min === max === candidates.length` (take all of them, no latitude) or a single candidate the
 * player may not decline is forced. Declining always counts as an answer — that is the whole point
 * of the `mandatory` flag.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     node scripts/measure/one-answer.mjs
 *     SEEDS=6 node scripts/measure/one-answer.mjs
 *     SEATS=4 SEEDS=4 node scripts/measure/one-answer.mjs
 *
 * `DECKS` seats named decks at every table instead of the rotating pairings, which is how the
 * instrument is **shown able to find a forced question at all** — a zero from a classifier is worth
 * nothing until it has been seen to report something (D263's vacuous-assertion trap, which this
 * project has caught twice):
 *
 *     DECKS=kindle-grove,ember-rush SEEDS=6 node scripts/measure/one-answer.mjs
 *
 * Kindle Grove carries the pool's two suspend cards, and suspend's cast offer is the one question
 * the engine already marks `mandatory` — a cast that **must** be taken. If that row ever reports
 * 0 forced on a table holding Rift Bolt, this file is broken rather than the table being clean.
 */
import {
  applyAction, createGame, botAction, seatsToAct, legalActions, listAt, zoneKey, STARTER_DECKS,
} from '../lib/engine.mjs';

const ALL = Object.keys(STARTER_DECKS);
const SEATS = Number(process.env.SEATS ?? 2);
const SEEDS = Number(process.env.SEEDS ?? 3);
const SEED0 = Number(process.env.SEED0 ?? 7700);
const MOVES = Number(process.env.MOVES ?? (SEATS === 4 ? 8000 : 4000));
const PLAYERS = ['A', 'B', 'C', 'D'].slice(0, SEATS)
  .map((name, i) => ({ playerId: `p${i}`, name }));
const SEATING = [...Array(SEATS).keys()];
const FORMAT = SEATS === 4 ? 'pod' : 'modern';
/** Decks to seat at every table, for reaching a question the rotating pairings rarely produce. */
const NAMED = (process.env.DECKS ?? '').split(',').map((d) => d.trim()).filter(Boolean);
for (const d of NAMED) {
  if (!ALL.includes(d)) {
    console.log(`no deck called ${d}. One of: ${ALL.join(', ')}`);
    process.exit(1);
  }
}

/** kind -> { asked, forced, prompts: Map<string, {asked, forced}> } */
const tally = new Map();
const note = (kind, prompt, forced) => {
  const row = tally.get(kind) ?? { asked: 0, forced: 0, prompts: new Map() };
  row.asked += 1;
  if (forced) row.forced += 1;
  const p = row.prompts.get(prompt) ?? { asked: 0, forced: 0 };
  p.asked += 1;
  if (forced) p.forced += 1;
  row.prompts.set(prompt, p);
  tally.set(kind, row);
};

/**
 * Every question pending for this seat, and whether it has one answer.
 *
 * One `legalActions` call can carry several — a seat can owe a discard and hold a dredge offer — so
 * each is reported separately rather than picking the first.
 */
function questions(state, seat, la) {
  const out = [];
  if (la.mustDecide !== null) {
    const d = la.mustDecide;
    let forced = false;
    if (d.options !== undefined) forced = d.options.length <= 1;
    else if (d.numbers !== undefined) forced = d.numbers.min >= d.numbers.max;
    // Declining is an answer, so a target choice is forced only with nothing to point at.
    else if (d.targetChoices !== undefined) forced = d.targetChoices.length === 0;
    // Taking all of them with no latitude, or one candidate that cannot be declined.
    else forced = d.candidates.length <= d.min || (d.candidates.length === 1 && d.min === 1);
    out.push(['mustDecide', d.prompt, forced]);
  }
  if (la.mustChoose !== null) {
    const c = la.mustChoose;
    // Forced when every spec has exactly as many candidates as it needs and none may be declined.
    const forced = c.specs.length > 0 && c.specs.every((spec, i) => {
      const want = Math.max(1, spec.count ?? 1);
      return spec.optional !== true && (c.candidates[i]?.length ?? 0) <= want;
    });
    out.push(['mustChoose', c.description, forced]);
  }
  // Paying or declining is always two answers; `canPay` is guaranteed by settlePayment.
  if (la.mustPay !== null) out.push(['mustPay', la.mustPay.prompt, false]);
  if (la.mustDredge !== null) out.push(['mustDredge', la.mustDredge.prompt, false]);
  if (la.mustCastOffered !== null) {
    // The one case the engine already flags, now counted with the rest.
    out.push(['mustCastOffered', la.mustCastOffered.prompt, la.mustCastOffered.mandatory === true]);
  }
  if (la.mustDiscard > 0) {
    const held = listAt(state, zoneKey(seat, 'hand')).length;
    out.push(['mustDiscard', `discard ${la.mustDiscard} to hand size`, held <= la.mustDiscard]);
  }
  if (la.mustSettleHand) {
    /*
      Keep or draw again, and **whether a mulligan is still legal is asked of the engine rather than
      assumed** — which is the correction this file needed on its first run (D279).

      The first version called this forced whenever `bottomOwed` was zero, read 26 of 26 and 81% of
      the whole report, and was wrong: zero owed means *nothing goes under if you keep*, not that
      keeping is the only move. The player may mulligan instead, so the question has two answers.

      And the reason the mistake was available at all is that `LegalActions` has no "may mulligan"
      field: the mulligan is an ordinary card action rather than an `auto:` one, so nothing in the
      shape this file reads says whether it is on offer. Guessing from `bottomOwed` was guessing.
      Asking the engine is not: `applyAction` is pure, so offering it a mulligan on a throwaway state
      costs one call and answers exactly the question. One answer per rule, from the thing that owns
      the rule (D260).
    */
    let mayMulligan = true;
    try { applyAction(state, { type: 'mulligan', by: seat, seat }); }
    catch { mayMulligan = false; }
    out.push(['mustSettleHand', `settle the opening hand, ${la.bottomOwed} to the bottom`,
      !mayMulligan && la.bottomOwed === 0]);
  }
  if (la.mustDeclare === 'attackers') {
    // Forced when every creature that may attack must, and there is only one seat to aim at.
    const mayNot = la.attackers.filter((id) => !la.mustAttack.includes(id));
    out.push(['declare attackers', `declare attackers (${la.attackers.length} able)`,
      la.attackers.length > 0 && mayNot.length === 0 && SEATS === 2]);
  }
  if (la.mustDeclare === 'blockers') {
    out.push(['declare blockers', `declare blockers (${la.blockers.length} able)`,
      la.blockers.length === 0]);
  }
  if (la.mustDeclare === 'order') {
    const real = la.mustOrder.filter((o) => o.blockers.length > 1);
    out.push(['damage order', `order blockers for ${la.mustOrder.length} attacker(s)`,
      real.length === 0]);
  }
  return out;
}

let games = 0;
let moves = 0;
const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let t = 0; t < ALL.length; t++) {
    const seed = SEED0 + i * ALL.length + t;
    const decks = NAMED.length > 0
      ? SEATING.map((j) => NAMED[j % NAMED.length])
      : SEATING.map((j) => ALL[(t * 3 + j * 4) % ALL.length]);
    let s = createGame({ id: `q${seed}`, format: FORMAT, players: PLAYERS, seed });
    for (const seat of SEATING) {
      s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
    }
    s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
    s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
    games += 1;
    for (let move = 0; move < MOVES && !s.finished; move++) {
      const seat = seatsToAct(s)[0];
      if (seat === undefined) break;
      // Asked of the seat about to act, which is the seat a person would be sitting in.
      for (const [kind, prompt, forced] of questions(s, seat, legalActions(s, seat))) {
        note(kind, prompt, forced);
      }
      const action = botAction(s, seat, {});
      if (action === null) break;
      const before = s.stateVersion;
      try { s = applyAction(s, action); } catch { break; }
      if (s.stateVersion === before) break;
      moves += 1;
    }
  }
}

const rows = [...tally.entries()].sort((a, b) => b[1].forced - a[1].forced || b[1].asked - a[1].asked);
const asked = rows.reduce((t, r) => t + r[1].asked, 0);
const forced = rows.reduce((t, r) => t + r[1].forced, 0);

console.log(`${games} ${SEATS === 4 ? 'pods' : 'games'}, ${moves} moves, ${SEEDS} seeds from ${SEED0}`
  + `, ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log('counted at the seat about to act, so this is what a person would have been asked');
console.log('');
console.log(`${'question'.padEnd(20)}${'asked'.padStart(8)}${'one answer'.padStart(12)}${'  per game'}`);
for (const [kind, row] of rows) {
  console.log(kind.padEnd(20) + String(row.asked).padStart(8)
    + `${row.forced} (${(100 * row.forced / Math.max(1, row.asked)).toFixed(0)}%)`.padStart(12)
    + `  ${(row.asked / Math.max(1, games)).toFixed(1)}`);
}
console.log('');
console.log(`${asked} questions in ${games} games, ${(asked / Math.max(1, games)).toFixed(1)} a game;`
  + ` ${forced} of them (${(100 * forced / Math.max(1, asked)).toFixed(0)}%) had one answer`);

/*
  The prompts worth naming, which is the actionable half: a question asked often AND usually forced
  is a drawer the engine could answer itself with a line in the log.
*/
const culprits = [];
for (const [kind, row] of rows) {
  for (const [prompt, p] of row.prompts) {
    if (p.forced > 0) culprits.push({ kind, prompt, ...p });
  }
}
culprits.sort((a, b) => b.forced - a.forced);
if (culprits.length > 0) {
  console.log('');
  console.log('the ones to answer without asking, most forced first:');
  for (const c of culprits.slice(0, 15)) {
    console.log(`  ${String(c.forced).padStart(5)} of ${String(c.asked).padEnd(5)} ${c.kind}: ${c.prompt}`);
  }
}
