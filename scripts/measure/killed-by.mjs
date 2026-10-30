/**
 * How a deck's games actually end: what took the last of its life, on what turn, and what it was
 * still holding when it happened.
 *
 * A win-rate says a deck is 28% and nothing about why. `cast-counts` says which of its cards it
 * never casts. Neither says what killed it, and that is the question a deck list is fixed from: a
 * deck that dies on turn eight to a one-mana creature wants cheap blockers, and one that dies on
 * turn twenty to a 5/5 flier wants an answer to a 5/5 flier. Those are different cards, and three
 * balance passes on Tidal Mind had no way to tell them apart.
 *
 * What it records, per loss:
 *
 * - **what dealt the last damage** — combat, or the name of the spell or ability. Attributed by
 *   watching the subject's life move and reading the action that moved it, which is the only way
 *   available from outside the engine: `dealDamage` knows its source, the log does not keep it.
 * - **the turn it ended on**, because "it loses" and "it loses on turn six" are different problems.
 * - **what was still in hand**, because a deck that dies holding four cards is losing to its own
 *   curve rather than to the opponent's.
 *
 * And for a win, the same two numbers from the other side: the turn, and how much life was left.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=tidal-mind SEEDS=6 node scripts/measure/killed-by.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SUBJECT = process.env.SUBJECT ?? 'tidal-mind';
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stats = {
  games: 0, won: 0, lost: 0, unfinished: 0,
  byKiller: new Map(), lossTurns: [], winTurns: [], handAtDeath: [], lifeAtWin: [],
  reasons: new Map(),
};
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

function duel(seed, decks, subjectSeat) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;
  const lifeOf = (st) => st.seats[subjectSeat]?.life ?? 0;
  /*
    The last thing that moved the subject's life down, by name.

    Attributed to the action being applied rather than to the damage itself, which is a
    simplification with one honest reading: an action that drops the subject's life is either a
    spell or ability of the opponent's, or a step change that let combat damage happen. Those are
    exactly the two answers this instrument is for, so the imprecision inside each is affordable —
    "Lightning Bolt" and "combat" are the useful granularity, not "the second point of trample".
  */
  let killer = 'nothing';
  let handAtDeath = 0;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    const hadLife = lifeOf(s);
    const hand = (s.zones[`${subjectSeat}:hand`] ?? []).length;
    const named = action.card === undefined ? undefined : nameOf(s, action.card);
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;
    if (lifeOf(next) < hadLife) {
      /*
        A step change is combat: the engine deals combat damage as a turn-based action when the
        damage step is entered, so the action that caused it is a pass or a step advance with no
        card attached. Everything else is somebody's card, and the name is the useful answer.
      */
      killer = named === undefined ? 'combat' : named;
      handAtDeath = hand;
    }
    s = next;
  }
  stats.games += 1;
  const reason = s.seats[subjectSeat]?.eliminatedReason;
  if (!s.finished) stats.unfinished += 1;
  else if (s.winnerSeat === subjectSeat) {
    stats.won += 1;
    stats.winTurns.push(s.turn);
    stats.lifeAtWin.push(lifeOf(s));
  } else {
    stats.lost += 1;
    stats.lossTurns.push(s.turn);
    bump(stats.byKiller, killer);
    bump(stats.reasons, reason ?? 'unknown');
    stats.handAtDeath.push(handAtDeath);
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
const seedFor = (pass, j, order) => SEED0 + ((pass * FIELD.length + j) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (const [j, foe] of FIELD.entries()) {
    duel(seedFor(i, j, 0), [SUBJECT, foe], 0);
    duel(seedFor(i, j, 1), [foe, SUBJECT], 1);
  }
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${SUBJECT}: ${stats.won}-${stats.lost}`
  + `${stats.unfinished ? ` (${stats.unfinished} unfinished)` : ''} of ${stats.games}`
  + ` [${pct(stats.won, stats.won + stats.lost)}]\n`);
/*
  `state.turn` counts every player's turn, so a thirteen here is the subject's seventh — printed
  both ways because the deck list is built in the subject's own turns and the engine counts the
  table's.
*/
console.log(`it loses on turn ${mean(stats.lossTurns).toFixed(1)} of the table's`
  + ` (about its own turn ${(mean(stats.lossTurns) / 2).toFixed(1)}), holding`
  + ` ${mean(stats.handAtDeath).toFixed(1)} cards`);
console.log(`it wins on turn ${mean(stats.winTurns).toFixed(1)} with ${mean(stats.lifeAtWin).toFixed(1)} life left`);
console.log('\nhow it died:');
for (const [reason, n] of [...stats.reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} ${pct(n, stats.lost).padStart(4)}  ${reason}`);
}
console.log('\nwhat took the last of its life:');
for (const [killer, n] of [...stats.byKiller].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} ${pct(n, stats.lost).padStart(4)}  ${killer}`);
}
