/**
 * What does cascade actually hit?
 *
 * The keyword reads like a free spell and is not one: it is a free spell *drawn off the top of a
 * sixty-card deck*, and twenty-three of those cards are lands that it walks straight past. So the
 * value of the card depends on a distribution nobody in this project had looked at — how deep it
 * digs, what it finds, and whether what it finds is a card the bot then wants to cast at all.
 *
 * Three questions, in the order a player would ask them:
 *
 * 1. **How often does it fire, and how deep does it go?** Every cascade is one trigger; the depth
 *    is how many cards came off the library before one of them was cheap enough and not a land.
 * 2. **What did it hit?** By name, so the answer is a list of cards rather than an average.
 * 3. **What was done with it?** A free spell can be declined, and the bot declines whenever
 *    `candidateActions` finds no legal way to cast the card — a Prey Upon with nothing to fight,
 *    a Flame Slash with nothing to burn. That number is the gap between what the keyword offers
 *    and what it is worth.
 *
 * It watches `pendingOfferedCast` rather than the log, which keeps it honest about one thing in
 * particular: the offer is in the *state*, so a cascade that fired and was answered inside the same
 * settle cannot hide from it. The pile that goes to the bottom is counted off the same field.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=kindle-grove SEEDS=4 node scripts/measure/cascade.mjs
 */
import {
  applyAction, createGame, botAction, scriptFor, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'kindle-grove';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

let games = 0;
/** Cascades that fired at all, by the card whose keyword did it. */
const byCascader = new Map();
/** What was exiled as the hit, by name. */
const hits = new Map();
/** How many cards came off the library per cascade, including the hit. */
const depths = [];
let cast = 0;
let declined = 0;
/**
 * Casts of a card with cascade, which is how the ones that found nothing get counted.
 *
 * Every cast of a cascade card puts exactly one cascade trigger on the stack, and that trigger
 * either offers a card or exiles the whole library and offers none — so "fired and found nothing"
 * is this number minus the offers seen. The one case it over-counts is a game that ends while the
 * trigger is still on the stack, which is rare and named rather than corrected.
 */
let cascadeCasts = 0;

/** Whether a card's script carries the keyword, asked of the script rather than of a list here. */
const hasCascade = (name) => (scriptFor(name)?.triggers ?? [])
  .some((t) => t.on?.kind === 'spell-cast' && t.on?.self === true);

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name ?? '?';

function duel(seed, decks) {
  const host = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);

  let offer = null;

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    if (action.type === 'auto:cast' && hasCascade(nameOf(s, action.card))) cascadeCasts += 1;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;

    const now = s.pendingOfferedCast;
    /*
      A new offer: record what it found and how far it dug for it.

      Compared by card id rather than by truthiness, because two cascades in a row — a cascade hit
      that cascades again — are two offers and the second must not be read as the first still
      standing.
    */
    if (now !== null && now.card !== offer?.card) {
      bump(byCascader, nameOf(s, now.source));
      bump(hits, nameOf(s, now.card));
      depths.push(now.bottom.length + 1);
      offer = now;
    } else if (now === null && offer !== null) {
      // The offer is gone, so it was answered: cast when the card left exile, declined when it
      // went back into the library. The pile goes to the bottom either way.
      const where = s.instances[offer.card]?.zone;
      if (where === 'library') declined += 1;
      else cast += 1;
      offer = null;
    }

  }
  games += 1;
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other]);
    duel(SEED0 + i, [other, SUBJECT]);
  }
}

const total = [...byCascader.values()].reduce((n, v) => n + v, 0);
const mean = depths.length === 0
  ? '—'
  : (depths.reduce((n, d) => n + d, 0) / depths.length).toFixed(2);
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log(`${total} cascades fired, ${mean} cards exiled each (the hit included)`);
console.log(`of them: ${cast} cast, ${declined} declined`);
console.log(`${cascadeCasts} cascade cards were cast, so ${cascadeCasts - total} found nothing at`
  + ' all (or were still on the stack when the game ended)');
console.log('');
for (const [name, n] of [...byCascader].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  cascaded off ${name}`);
}
console.log('');
console.log('what it hit:');
for (const [name, n] of [...hits].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}
