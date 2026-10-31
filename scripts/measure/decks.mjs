/**
 * One deck list in a **canonical order**, so the order somebody typed it in cannot change the game.
 *
 * `deck:load` builds the library in the order a deck's entries are written and then shuffles it,
 * and a shuffle is a permutation of *indices*: the same seed applied to two arrays holding the same
 * sixty cards in a different order gives two different libraries. So the written order is
 * observable, and not faintly — moving Forge Alliance's first entry to the end of its own list,
 * changing nothing else, **changed the winner in 9 of 40 played games** (D257).
 *
 * That is a fact about the engine and it is harmless at a real table, where a player's list order
 * is arbitrary and every game is shuffled anyway. Where it is **not** harmless is here. Every
 * instrument in this directory that prices a slot does it by running the same field twice and
 * reading the difference, and the two arms have been getting their lists by different routes:
 *
 *  - `deck-table`'s and `deck-probe`'s `CHANGE` builds a variant and hands it over as
 *    `ActionContext.decks`, **appending** a card the deck did not already hold at the end of the
 *    list;
 *  - the same change written into `starterDecks.ts` by hand sits wherever it was typed, which for a
 *    readable list is beside the cards it is like.
 *
 * Same sixty cards, different order, different games. Two arms that were supposed to differ by one
 * card differed by one card *and* a reshuffle of the other fifty-nine, which is a variance of about
 * six games in 288 — the same size as most of the effects this project has been reading. D251's
 * eighteen games survive that; D255's ten do not comfortably, and the "one game apart" that entry
 * reports between two cut sets was inside it.
 *
 * So: every harness that compares arms sorts **every** deck the same way before handing it to the
 * engine. Sorting by card name needs no new convention and is unique per printed card. It does not
 * make any arm more correct on its own — it makes the arms comparable, which is the only thing a
 * difference between them can mean.
 *
 * Fixed here rather than in `deck:load` for two reasons. A deck's pre-shuffle order is arbitrary
 * either way, so the engine is not wrong; and sorting in the engine re-shuffles every seed in the
 * project at once, which broke twelve tests pinned to boards they were written against. The
 * instrument is the thing that needs the guarantee, so the instrument is where it goes.
 *
 *     import { canonicalDecks } from './decks.mjs';
 *     const CTX = { ...canonicalDecks(STARTER_DECKS), isHost: true };
 */

/** One deck with its entries in a canonical order. */
export function canonicalDeck(deck) {
  return {
    ...deck,
    cards: [...deck.cards].sort((a, b) => a.card.name.localeCompare(b.card.name)),
  };
}

/**
 * Every deck in the registry, canonically ordered, as an `ActionContext.decks` map.
 *
 * `overrides` is for the harness that is also changing a list: pass the variant and it is sorted
 * with the rest, so the arm with the change and the arm without differ by the change alone.
 */
export function canonicalDecks(registry, overrides = {}) {
  const decks = {};
  for (const [id, deck] of Object.entries(registry)) decks[id] = canonicalDeck(deck);
  for (const [id, deck] of Object.entries(overrides)) decks[id] = canonicalDeck(deck);
  return { decks };
}
