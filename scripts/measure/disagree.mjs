/**
 * How often do two bot settings actually choose differently?
 *
 * **Run this before calling a flat `bot-duel` result a wash.** A setting that changes no decisions
 * cannot win or lose games, so a level scoreboard means one of two completely different things, and
 * only this tells them apart: "it changes the choices and they are worth nothing" against "it
 * changes nothing". D117's result needed it — 1% of decisions overall, but 10% of attack
 * declarations — and without it the entry would have said "a wash" about something that was not.
 *
 * Asked of the same positions: play the game with the control, and at every decision ask both.
 */
import { applyAction, createGame, botAction, seatsToAct, STARTER_DECKS } from '../../packages/rules-engine/dist/index.js';

/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 2);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const TESTED = JSON.parse(process.env.TESTED ?? '{}');
const CONTROL = JSON.parse(process.env.CONTROL ?? '{}');
/*
  One deck's own decisions, rather than the field's.

  The same reason `term-leverage` has one, and D248 is the question that needed it: the deep search
  is worth **+11 points to Ember Rush and −11 to Tidal Mind**, so "how often do the two pilots
  disagree" averaged over thirteen decks is two opposite findings added together. With a `SUBJECT`
  only that deck's seat is counted, and the opponent's decisions — which are the field average
  wearing a filter — are not.

    TESTED='{"lookahead":false}' SUBJECT=tidal-mind SEEDS=4 node scripts/measure/disagree.mjs
*/
const SUBJECT = process.env.SUBJECT ?? '';
if (SUBJECT !== '' && STARTER_DECKS[SUBJECT] === undefined) {
  console.log(`no deck called ${SUBJECT}. Known: ${ALL.join(', ')}`);
  process.exit(1);
}
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const byKind = new Map();
/*
  What the two pilots actually played, when they differed, named by card.

  A kind breakdown says *where* to look and nothing about *what* to look at: "they differ on 8% of
  casts" is the same number whether the disagreement is about a Counterspell or about a land. So
  every disagreement is recorded as the pair of plays, and the commonest pairs are printed under the
  table — which is the list a person reads positions from.
*/
const byPlay = new Map();

function note(kind, same) {
  const row = byKind.get(kind) ?? { n: 0, differed: 0 };
  row.n += 1;
  if (!same) row.differed += 1;
  byKind.set(kind, row);
}

/** A play as a phrase: the action, and the card it is about when there is one. */
function describe(state, action) {
  if (action === null || action === undefined) return 'nothing';
  const name = (id) => state.cardDefs[state.instances[id]?.defKey ?? '']?.name ?? '?';
  const kind = action.type.replace('auto:', '');
  if (action.card !== undefined) return `${kind} ${name(action.card)}`;
  if (action.type === 'auto:attack') {
    return action.attackers.length === 0
      ? 'attack with nothing'
      : `attack with ${action.attackers.map((a) => name(a.attacker)).sort().join(' + ')}`;
  }
  if (action.type === 'auto:block') {
    return action.blocks.length === 0
      ? 'block with nothing'
      : `block with ${action.blocks.map((b) => name(b.blocker)).sort().join(' + ')}`;
  }
  return kind;
}

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const control = botAction(s, seat, CONTROL);
    if (control === null) break;
    if (SUBJECT === '' || decks[seat] === SUBJECT) {
      const tested = botAction(s, seat, TESTED);
      const same = JSON.stringify(control) === JSON.stringify(tested);
      note(control.type, same);
      if (!same) {
        const key = `${describe(s, control)}   ->   ${describe(s, tested)}`;
        byPlay.set(key, (byPlay.get(key) ?? 0) + 1);
      }
    }
    const before = s.stateVersion;
    try { s = applyAction(s, control); } catch { break; }
    if (s.stateVersion === before) break;
  }
}

/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles seat 0's deck
  and then seat 1's, and the same stream yields the same index permutation however different the
  deck list is — so a whole pass over the field on one seed was one shuffle wearing every pairing,
  and an absolute rate printed below had the error bars of its seed count rather than its game
  count. Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      // With a SUBJECT, only its own pairings are worth playing at all.
      if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
      duel(seedFor(i, a, b, 0), [ALL[a], ALL[b]]);
      duel(seedFor(i, a, b, 1), [ALL[b], ALL[a]]);
    }
  }
}

const rows = [...byKind.entries()].sort((x, y) => y[1].n - x[1].n);
let n = 0; let differed = 0;
console.log(SUBJECT === '' ? 'the whole field' : `${SUBJECT}'s own decisions, in its own pairings`);
console.log('action            decisions   differed');
for (const [kind, r] of rows) {
  n += r.n; differed += r.differed;
  console.log(`${kind.padEnd(16)} ${String(r.n).padStart(9)}   ${String(r.differed).padStart(6)}  ${Math.round((100 * r.differed) / r.n)}%`);
}
console.log(`${'all'.padEnd(16)} ${String(n).padStart(9)}   ${String(differed).padStart(6)}  ${Math.round((100 * differed) / n)}%`);

const plays = [...byPlay.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30);
if (plays.length > 0) {
  console.log('');
  console.log('what they played instead, commonest first (CONTROL -> TESTED)');
  for (const [key, count] of plays) console.log(`${String(count).padStart(5)}  ${key}`);
}
