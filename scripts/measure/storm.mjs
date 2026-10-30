/**
 * How many spells does a turn of Magic actually hold?
 *
 * Storm multiplies by a number nobody in this project had ever counted. A Grapeshot is one damage
 * or it is six, and which depends on a fact about how the game is played rather than about the
 * card: how many spells a turn tends to see. So this reports two distributions, and the second one
 * is the one worth keeping.
 *
 * 1. **Every storm spell cast**, with the count it had — which is `StackObject.castNumber`, the
 *    snapshot taken as the spell was cast. That is the card's own number, and the honest measure of
 *    what the keyword bought: a storm card cast as the first spell of a turn is a blank.
 * 2. **Every turn in the game**, by how many spells were cast in it. Not only the subject's turns
 *    and not only the subject's spells: the count is of everybody's, which is the rule, and in a
 *    duel a turn with an answer in it holds two spells rather than one.
 *
 * The second is read at the end of each turn, off `spellsCastThisTurn` before the cleanup resets
 * it — so it counts exactly what a storm spell cast at the end of that turn would have seen.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=arc-tempest SEEDS=4 node scripts/measure/storm.mjs
 */
import {
  applyAction, createGame, botAction, scriptFor, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'arc-tempest';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

let games = 0;
let turns = 0;
/** How many turns held n spells, by n. */
const perTurn = new Map();
/** Storm spells cast, by the count they had. */
const stormCounts = new Map();
/** And by card, so a second storm card can be told from the first. */
const byCard = new Map();

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name ?? '?';

/** Whether a card's script carries storm, asked of the script rather than of a list here. */
const hasStorm = (name) => (scriptFor(name)?.triggers ?? [])
  .some((t) => t.on?.kind === 'spell-cast' && t.on?.self === true
    && /storm/i.test(t.description ?? ''));

function duel(seed, decks) {
  const host = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);

  let turn = s.turn;
  let spells = 0;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const casting = action.type === 'auto:cast' ? nameOf(s, action.card) : null;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;

    /*
      The storm count, read off the spell's own object rather than off the state.

      `castNumber` is what the keyword multiplies by, and reading `spellsCastThisTurn` here instead
      would be one too many: the cast has already been counted by the time this runs.
    */
    if (casting !== null && hasStorm(casting)) {
      const object = s.stackObjects[action.card];
      const count = object?.castNumber ?? 0;
      bump(stormCounts, count);
      bump(byCard, casting);
    }
    /*
      And the turn's total, kept as a running maximum rather than read at one moment.

      `spellsCastThisTurn` is reset by the cleanup step, and a loop that only looks after each
      action can step straight over that reset — one `applyAction` carries the end of a turn and
      the start of the next. So the count is remembered as it grows and banked when the turn
      number changes.
    */
    spells = Math.max(spells, s.spellsCastThisTurn);
    if (s.turn !== turn) {
      bump(perTurn, spells);
      turns += 1;
      turn = s.turn;
      spells = s.spellsCastThisTurn;
    }
  }
  games += 1;
}

/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles seat 0's deck
  and then seat 1's, and the same stream yields the same index permutation however different the
  deck list is — so a whole pass over the field on one seed was one shuffle wearing every pairing,
  and an absolute rate printed below had the error bars of its seed count rather than its game
  count. Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, j, order) => SEED0 + ((pass * FIELD.length + j) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (const [j, other] of FIELD.entries()) {
    duel(seedFor(i, j, 0), [SUBJECT, other]);
    duel(seedFor(i, j, 1), [other, SUBJECT]);
  }
}

const pc = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
const cast = [...stormCounts.values()].reduce((n, v) => n + v, 0);
const weighted = [...stormCounts].reduce((n, [count, times]) => n + count * times, 0);

console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log(`${turns} turns played, ${cast} storm spells cast`);
console.log('');
console.log('spells cast per turn, by anybody:');
for (const [n, times] of [...perTurn].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(n).padStart(2)} spells  ${String(times).padStart(5)} turns  ${pc(times, turns)}`);
}
console.log('');
console.log('what the storm count was when a storm spell was cast:');
for (const [n, times] of [...stormCounts].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(n).padStart(2)} copies  ${String(times).padStart(5)}  ${pc(times, cast)}`);
}
console.log(`  (${(weighted / Math.max(1, cast)).toFixed(2)} copies on average)`);
console.log('');
for (const [name, n] of [...byCard].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}
