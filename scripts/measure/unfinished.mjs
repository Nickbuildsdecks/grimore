/**
 * Why does a measured game ever stop without a winner?
 *
 * Every game-playing instrument in this directory ends its move loop the same way:
 *
 *     try { s = applyAction(s, action); } catch { break; }
 *
 * Thirty-five files, and **not one of them reports that it caught anything**. So if the engine
 * throws during a bot's own legal action the game simply stops, the harness counts it as a game it
 * played, and whatever number it prints is computed from a truncated game with no signal anywhere
 * that something went wrong. `deck-probe` says `(1 unfinished)` and that is the whole of what the
 * project knows about it — and "unfinished" is four different things wearing one word:
 *
 *  - the **move cap**: a real game that was still going at 4000 moves;
 *  - **no action**: `botAction` returned null, so the seat had nothing legal to do;
 *  - **no progress**: the action applied and `stateVersion` did not move, which is a loop;
 *  - **a throw**: the engine refused an action the bot built out of `legalActions`.
 *
 * The last one is not a curiosity. `playout.test.ts` asserts that the engine never refuses what it
 * offered, so a throw here is a violation of an invariant the suite already claims to hold — which
 * makes this a bug hunt rather than bookkeeping. **A non-zero exit is the point**: a throw means
 * every number this directory has ever published is contaminated by exactly that fraction of games.
 *
 * Nothing here is swallowed. The message and the action type are kept and printed, deduplicated,
 * because one bad interaction tends to fire in many games and a list of four hundred identical
 * lines hides how many distinct faults there are.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     node scripts/measure/unfinished.mjs                 # the whole field, 2 seeds
 *     SEEDS=6 node scripts/measure/unfinished.mjs
 *     SUBJECT=tidal-mind SEEDS=12 node scripts/measure/unfinished.mjs
 *
 * `SCHEME=probe` replays **exactly the games `deck-probe` played** instead of the table's pairings,
 * because the unfinished games this file was written to explain were seen there: a probe run prints
 * `(1 unfinished)` and nothing else about it. The two harnesses derive their seeds differently, so
 * hunting for a probe's fault with the table's seeds is hunting in a different set of games — which
 * is the same mistake D258 found in comparing their *numbers*. With `SCHEME=probe` the subject's
 * 288 games are the subject's 288 games:
 *
 *     SCHEME=probe SUBJECT=verdant-guard SEEDS=12 SEED0=4400 node scripts/measure/unfinished.mjs
 *
 * `SEATS=4` audits the **pod** instead, which is the format this file was missing and the one with
 * more to go wrong in it. Three harnesses here play four-seat games — `pod-duel`, `pod-slot`,
 * `pod-pace` — each ending its move loop with the same `catch { break; }`, and none of them has
 * ever been asked whether it caught anything. The pod is also where the `nobody to act` end state
 * below stops being hypothetical: the engine's own pod tests exist because CR 800.4a lets a table
 * reach a state with no seat able to move, and a table that never ends is worse than a throw.
 *
 *     SEATS=4 SEEDS=6 node scripts/measure/unfinished.mjs
 *     SEATS=4 ALWAYS=dawn-tithe SEEDS=6 node scripts/measure/unfinished.mjs
 *
 * It reproduces `pod-duel`'s tables and seeds, with one deliberate difference: that harness plays
 * each table **four times**, rotating which seats carry `TESTED`, and with one bot in every seat —
 * which is what this file plays — all four rotations are the *same game* on the same seed. Its own
 * docblock says so. So the audit plays each table once: that is every **distinct** game `pod-duel`
 * plays, which is what a throw hides in, rather than every game it counts.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';
import { canonicalDecks } from './decks.mjs';

const ALL = Object.keys(STARTER_DECKS);
const SUBJECT = process.env.SUBJECT ?? '';
const SEEDS = Number(process.env.SEEDS ?? 2);
const SEED0 = Number(process.env.SEED0 ?? 4400);
const MOVES = Number(process.env.MOVES ?? (process.env.SEATS === '4' ? 8000 : 4000));
const SCHEME = process.env.SCHEME ?? 'table';
/*
  How many seats. Two is a duel and the default, because that is what the harnesses this file was
  written to certify were playing; four is a Commander pod, reproducing `pod-duel`'s tables.
*/
const SEATS = Number(process.env.SEATS ?? 2);
if (SEATS !== 2 && SEATS !== 4) {
  console.log(`SEATS must be 2 or 4, not ${SEATS}: the engine's formats are a duel and a four-seat pod.`);
  process.exit(1);
}
/** One deck seated at every table, as `pod-duel` means it: a fault may need a card to be in play. */
const ALWAYS = process.env.ALWAYS ?? '';
if (ALWAYS !== '' && !ALL.includes(ALWAYS)) {
  console.log(`no deck called ${ALWAYS}. One of: ${ALL.join(', ')}`);
  process.exit(1);
}
/*
  Whether the move loop passes the ActionContext, **off by default because that is what the
  harnesses do**.

  Every file in this directory hands `host` to `deck:load`, `game:start` and `auto:start` and then
  drops it:

      try { s = applyAction(s, action); } catch { break; }

  The first version of this file passed it, which made the audit unfaithful to the thing it audits —
  and it showed: replaying `deck-probe`'s own 288 games came back 288 clean where the probe itself
  had reported one unfinished. An instrument that does not reproduce the harness cannot certify it,
  so the default now matches the harnesses exactly and `CTX_IN_LOOP=1` is the comparison.
*/
const CTX_IN_LOOP = process.env.CTX_IN_LOOP === '1';
const PLAYERS = ['A', 'B', 'C', 'D'].slice(0, SEATS)
  .map((name, i) => ({ playerId: `p${i}`, name }));
const SEATING = [...Array(SEATS).keys()];
const FORMAT = SEATS === 4 ? 'pod' : 'modern';
const CTX = { isHost: true, ...canonicalDecks(STARTER_DECKS) };

/** How each game ended, counted. */
const ends = new Map();
/** Distinct faults: `${action type}: ${message}` -> { count, decks, example }. */
const faults = new Map();
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: FORMAT, players: PLAYERS, seed });
  for (const seat of SEATING) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, CTX);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, CTX);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, CTX);

  for (let move = 0; move < MOVES; move++) {
    if (s.finished) return 'won';
    const seat = seatsToAct(s)[0];
    // Nobody to act and the game not over is its own fault, and a worse one than a throw: the pod
    // tests (CR 800.4a) exist because a table with nobody to move is a table that never ends.
    if (seat === undefined) return 'nobody to act';
    const action = botAction(s, seat, {});
    if (action === null) return 'no action';
    const before = s.stateVersion;
    try {
      s = CTX_IN_LOOP ? applyAction(s, action, CTX) : applyAction(s, action);
    } catch (err) {
      /*
        The fault, kept rather than dropped — which is the whole reason this file exists.

        Keyed by action type and message so one bad interaction firing in two hundred games reads as
        one fault. The decks are recorded because a fault that only ever appears in one pairing is a
        card interaction, and one that appears in every pairing is a rule.
      */
      const key = `${action.type}: ${err?.message ?? String(err)}`;
      const found = faults.get(key) ?? { count: 0, decks: new Set(), example: null };
      found.count += 1;
      found.decks.add(decks.join(' v '));
      found.example ??= { seed, move, turn: s.turn, step: s.step };
      faults.set(key, found);
      return 'threw';
    }
    if (s.stateVersion === before) return 'no progress';
  }
  return 'move cap';
}

let games = 0;
// A seed per game, derived from the loop indices rather than a counter (D240). Both formulas are
// copied from the harness they belong to rather than shared, because the point is to reproduce
// *that* harness's games: a shared helper that drifted would quietly hunt in the wrong set.
const tableSeed = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;
const probeSeed = (pass, j, order, field) => SEED0 + ((pass * field + j) * 2) + order;

/*
  Which four decks sit at each table, and the deck seated at all of them. Both copied from
  `pod-duel` rather than shared with it, for the reason the seed formulas above are: the point is to
  reproduce *that* harness's games, and a shared helper that drifted would hunt in the wrong set.
*/
const podTable = (n) => SEATING.map((i) => ALL[(n * 3 + i * 4) % ALL.length]);
const podSeated = (n) => {
  const decks = podTable(n);
  if (ALWAYS === '' || decks.includes(ALWAYS)) return decks;
  const out = [...decks];
  out[n % 4] = ALWAYS;
  return out;
};
const podSeed = (pass, t) => SEED0 + (pass * ALL.length) + t;

if (SEATS === 4) {
  for (let i = 0; i < SEEDS; i++) {
    for (let t = 0; t < ALL.length; t++) {
      bump(ends, duel(podSeed(i, t), podSeated(t)));
      games += 1;
    }
  }
} else if (SCHEME === 'probe') {
  if (SUBJECT === '') {
    console.log('SCHEME=probe needs a SUBJECT: a probe run is one deck against the rest.');
    process.exit(1);
  }
  const field = ALL.filter((id) => id !== SUBJECT);
  for (let i = 0; i < SEEDS; i++) {
    for (const [j, other] of field.entries()) {
      bump(ends, duel(probeSeed(i, j, 0, field.length), [SUBJECT, other]));
      bump(ends, duel(probeSeed(i, j, 1, field.length), [other, SUBJECT]));
      games += 2;
    }
  }
} else {
  for (let i = 0; i < SEEDS; i++) {
    for (let a = 0; a < ALL.length; a++) {
      for (let b = a + 1; b < ALL.length; b++) {
        if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
        for (const [o, decks] of [[ALL[a], ALL[b]], [ALL[b], ALL[a]]].entries()) {
          bump(ends, duel(tableSeed(i, a, b, o), decks));
          games += 1;
        }
      }
    }
  }
}

console.log(`${games} ${SEATS === 4 ? 'pods' : 'games'}, ${SEEDS} seeds from ${SEED0}, ${
  SEATS === 4 ? `pod-duel tables${ALWAYS === '' ? '' : `, ${ALWAYS} at every one`}` : `${SCHEME} pairings`}${
  SEATS === 4 || SUBJECT === '' ? '' : `, ${SUBJECT} only`}, ctx in loop: ${
  CTX_IN_LOOP ? 'yes' : 'no (as the harnesses do)'}`);
console.log('');
for (const [end, n] of [...ends].sort((x, y) => y[1] - x[1])) {
  console.log(`${String(n).padStart(5)}  ${(100 * n / games).toFixed(1).padStart(5)}%  ${end}`);
}
console.log('');

if (faults.size === 0) {
  /*
    A clean sheet, and worth printing as one: it says the `catch { break; }` in thirty-five
    harnesses is swallowing nothing, so every number they print was computed from games that ran to
    their own end rather than to an error. That is a claim about all of them, which is why this
    file plays the whole field rather than one deck.
  */
  console.log('no game ended in an engine throw. The catch in every other harness here caught');
  console.log('nothing, so their numbers are not truncated by faults they never reported.');
} else {
  console.log(`!! ${faults.size} distinct fault(s). The engine refused an action its own bot built`);
  console.log('!! out of legalActions, which playout.test.ts asserts cannot happen — so this is a');
  console.log('!! bug, and every number in this directory is short by the games it ate:');
  console.log('');
  for (const [key, f] of [...faults].sort((a, b) => b[1].count - a[1].count)) {
    const where = f.example === null ? '' : ` first at seed ${f.example.seed} move ${f.example.move}, turn ${f.example.turn} ${f.example.step}`;
    console.log(`  ${f.count}x  ${key}`);
    console.log(`      ${[...f.decks].slice(0, 4).join(', ')}${f.decks.size > 4 ? ` +${f.decks.size - 4} more` : ''}${where}`);
  }
  process.exit(1);
}
