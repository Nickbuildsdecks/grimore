/**
 * Does the **order** a deck's entries were written in change the games it plays?
 *
 * It does, and that is the whole finding (D257). `deck:load` builds the library in entry order and
 * then shuffles it, and a shuffle is a permutation of *indices*: the same seed applied to two
 * arrays holding the same sixty cards in a different order gives two different libraries. So a
 * deck's identity, as far as a measured game is concerned, used to be its *list* rather than its
 * sixty cards.
 *
 * This is the experiment that settled it. One deck, its own list with the first entry moved to the
 * end, nothing else changed, forty seeds — and it reports how often the two lists reach a different
 * winner. Nine of forty when the lists are handed over as written; none at all when they go through
 * `canonicalDecks`, which is what every arm-comparing harness here now does.
 *
 * **Why it is worth a file of its own rather than a note.** Every instrument in this directory that
 * prices a slot does it by running the same field twice and reading the difference, and the two
 * arms were getting their lists by different routes: `CHANGE` appends a card the deck did not hold
 * at the end of the list, where the same change typed into `starterDecks.ts` sits beside the cards
 * it is like. Same sixty cards, different order, different games — a variance of about six games in
 * 288, which is the same size as most of the effects this project has published. So this is both
 * the measurement of the problem and the regression check on the fix: run it after touching
 * `deck:load`, `shuffled`, or `canonicalDecks` and it should read `0` on the canonical arm.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     node scripts/measure/deck-order.mjs
 *     SUBJECT=skyward-writ AGAINST=ember-rush SEEDS=40 node scripts/measure/deck-order.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';
import { canonicalDecks } from './decks.mjs';

const SUBJECT = process.env.SUBJECT ?? 'forge-alliance';
const AGAINST = process.env.AGAINST ?? 'ember-rush';
const SEEDS = Number(process.env.SEEDS ?? 40);
const SEED0 = Number(process.env.SEED0 ?? 5000);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stock = STARTER_DECKS[SUBJECT];
if (stock === undefined) {
  console.log(`no deck called ${SUBJECT}. Known: ${Object.keys(STARTER_DECKS).join(', ')}`);
  process.exit(1);
}
/*
  The same sixty cards with the first entry moved to the end.

  A rotation rather than a shuffle of the entries, so the change is as small as a change of order
  can be: one entry moves, every other entry keeps its neighbours, and the multiset is identical.
  If even this moves the games then nothing about the order can be trusted.
*/
const moved = { ...stock, cards: [...stock.cards.slice(1), stock.cards[0]] };
const size = (deck) => deck.cards.reduce((n, entry) => n + entry.count, 0);
if (size(moved) !== size(stock)) {
  console.log('!! the rotation changed the deck size, which would measure two things at once');
  process.exit(1);
}

function duel(seed, ctx) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, {
      type: 'deck:load', by: seat, seat, deckId: seat === 0 ? SUBJECT : AGAINST,
    }, ctx);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, ctx);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, ctx);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, {});
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  return s.finished ? s.winnerSeat : null;
}

/** How often two lists of the same sixty cards reach a different winner. */
function compare(listFor) {
  let differ = 0;
  for (let i = 0; i < SEEDS; i++) {
    const seed = SEED0 + i;
    if (duel(seed, listFor(stock)) !== duel(seed, listFor(moved))) differ += 1;
  }
  return differ;
}

const asWritten = compare((deck) => ({ isHost: true, decks: { [SUBJECT]: deck } }));
const canonical = compare((deck) => ({
  isHost: true, ...canonicalDecks(STARTER_DECKS, { [SUBJECT]: deck }),
}));

console.log(`${SUBJECT} v ${AGAINST}, ${SEEDS} seeds from ${SEED0}`);
console.log(`${size(stock)} cards either way; moved entry: ${stock.cards[0].card.name} x${stock.cards[0].count}`);
console.log('');
console.log(`as written:  ${asWritten} of ${SEEDS} games reached a different winner`);
console.log(`canonical:   ${canonical} of ${SEEDS} games reached a different winner`);
console.log('');
if (canonical > 0) {
  console.log('!! the canonical arm is supposed to be identical. Something between `canonicalDecks`');
  console.log('!! and `deck:load` has stopped making the pre-shuffle order a fact about the cards,');
  console.log('!! which means every arm-comparing instrument here is measuring a reshuffle as well');
  console.log('!! as its change.');
  process.exit(1);
}
if (asWritten === 0) {
  console.log('(the as-written arm found nothing, which would mean the engine had started sorting');
  console.log(' the library itself — in which case `canonicalDecks` is redundant rather than wrong)');
}
