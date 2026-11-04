/**
 * Which cards in this game the engine is **not** playing for you, and why.
 *
 * ## Why this exists
 *
 * Until now a card the engine could not read was a refusal: `auto:start` threw
 * `the engine does not know X: a pasted list plays on the tabletop, not with the rules engine`,
 * and the whole table dropped to tabletop mode. That is the right call when the pool is 348 cards
 * somebody scripted by hand, because a deck either is in the pool or is not.
 *
 * It is the wrong call for the pool this is becoming. A hundred-card Commander deck drawn from
 * every card ever printed will, for a long time, contain one or two the engine cannot play — and
 * refusing the engine for those one or two costs the other ninety-eight their turn structure,
 * priority, combat, triggers and state-based actions. Nick chose the other way round: **automate
 * everything that can be automated, and let the rest be moved by hand inside that game.**
 *
 * The engine was already built for this. `card:move`, `card:tap` and the rest of the tabletop
 * actions work while `automated` is true — and more than work: they record the zone changes, so a
 * creature a player moves to the graveyard by hand still raises the death event that other cards
 * trigger on. The tabletop half and the automated half were designed to coexist. The only thing
 * standing between them was one `throw`.
 *
 * ## What this module is careful not to claim
 *
 * It reports what it **knows**, which today is narrower than what a player wants to know. There are
 * two different ways a card can fail to be automated and only the first is detectable from here:
 *
 * 1. **No printed data.** `customDeck` resolved the name to `cardboard` — a name and nothing else,
 *    no type line, no cost. The engine cannot cast it, play it or attack with it, because it does
 *    not know what it is. Detectable with certainty: the type line is empty.
 * 2. **Printed data, unimplemented text.** A real type line, cost and P/T, so the engine deals it,
 *    casts it and attacks with it — but part of its oracle text promises something no script
 *    implements, so that text silently does not happen.
 *
 * **(2) is now detected**, which it was not when this file was written. The oracle-text compiler
 * reads a card's printed lines one at a time and names the ones it could not (`unreadLines`), so a
 * card with a real type line and an unread *sentence* is reported here rather than passing for
 * automated. That is the half of the hybrid story D362 left for later, and it is what makes turning
 * the compiler on in the engine's live path honest: without it, a card that does three of its four
 * printed things would look exactly like a card that does all four.
 *
 * ## What it still does not claim
 *
 * A card the compiler reads **completely** is reported as automated, and that is a claim about this
 * engine's readers rather than about Magic: a line this module compiles is a line it believes it
 * has understood. `scripts/measure/card-promises.mjs` is the instrument that argues the other side
 * for the hand-written pool, and the compiler's ground-truth tests are the argument for the derived
 * half. Neither is a proof, and the wording in the UI and the log follows from that: it names what
 * it found and does not promise about the rest.
 *
 * An **unimplemented keyword** — a `Miracle {R}` or an `Equip {1}` the compiler recognises but has
 * no builder for — is deliberately *not* reported. The card plays; what is missing is one way to
 * cast or use it, which is a different thing from a sentence that does nothing, and D370 is why the
 * two are tagged apart in the first place. Reporting them together would tell a player to move a
 * card by hand that the engine is running.
 */
import { unreadLines } from './derive.js';
import type { GameState } from './types.js';

/** Why a card is not being played by the engine. */
export type ManualReason =
  /**
   * The engine has no printed data for this card at all — `customDeck` fell through to cardboard.
   * It cannot be cast or played, only moved by hand.
   */
  | 'no-printed-data'
  /**
   * The card is dealt and castable, and some printed line of it is not implemented, so that line
   * silently does nothing.
   *
   * Emitted from `unreadLines`: a sentence the compiler could not read. Not emitted for an
   * unimplemented keyword — see the docblock above.
   */
  | 'text-not-automated';

export interface ManualCard {
  readonly name: string;
  readonly reason: ManualReason;
  /** One line a player can act on, written for the person holding the card. */
  readonly detail: string;
}

/**
 * How much of a printed line this is willing to quote, and the arithmetic behind the number.
 *
 * This list travels inside the per-seat view, which has a hard 128 KiB cap: `PodStateEvent` in
 * `packages/shared` **fails validation** above it, so an over-sized state is not broadcast at all.
 *
 * `wire-growth.mjs` measures the peak view across whole games, and its worst four-player singleton
 * pod is 47 KiB — 36% of the cap. **That measurement cannot see this list**, and the reason is
 * worth stating rather than leaving as an assumption: every deck the instrument can build comes
 * from the pool, every pool card has a hand-written script, so `unreadLines` returns nothing and
 * `manual` is empty in every game it plays. The arm that would exercise it needs the imported
 * corpus (#318).
 *
 * So the bound here is arithmetic instead of measured. The worst case is a hundred distinct cards
 * in one seat's deck, all of them reported: an oracle line can be a paragraph, and a hundred
 * entries quoting one unabridged paragraph each is roughly 47 KiB **added** to a 47 KiB peak — 94
 * KiB of 128, on a figure the instrument itself calls a floor rather than a bound. Capping the
 * quote holds an entry to 227 bytes — measured, not estimated: the fixed prose is 107 and the quote
 * is the rest — so the same worst case adds about 23 KiB, for 70 of 128. A player does not need the
 * whole paragraph to recognise which line of their own card is not running.
 */
const QUOTE_CAP = 120;

const quoted = (line: string): string =>
  (line.length <= QUOTE_CAP ? line : `${line.slice(0, QUOTE_CAP - 1).trimEnd()}\u2026`);

/**
 * The cards in this game that the engine is not playing, by name, sorted and deduplicated.
 *
 * Derived rather than stored, deliberately. This is a statement about **coverage** — about what the
 * engine can do — and not about the game, so putting it in `GameState` would mean a field that can
 * disagree with the truth after a card is added mid-game, and a migration every time the compiler
 * learns a new pattern. Computed from `cardDefs`, it cannot be stale.
 *
 * By name rather than by instance because that is what a player needs: four copies of one card the
 * engine cannot read is one thing to know, not four.
 */
export function manualCards(state: GameState): readonly ManualCard[] {
  const byName = new Map<string, ManualCard>();
  for (const def of Object.values(state.cardDefs)) {
    if (byName.has(def.name)) continue;

    // The one certain signal, and the more serious of the two. `cardboard` builds a def with a name
    // and empty everything else, so an empty type line means the name never resolved to a real card
    // (see `customDeck`).
    if (def.typeLine.trim().length === 0) {
      byName.set(def.name, {
        name: def.name,
        reason: 'no-printed-data',
        detail: 'the engine has no card data under this name, so it cannot be cast or played —'
          + ' move it by hand, as you would at a table',
      });
      continue;
    }

    /*
      A real card with a printed line nothing is running.

      `unreadLines` is empty for every card with a hand-written script — the script is the authority
      and the compiler is not asked — so this only ever reaches a card the compiler derived, which
      is what keeps the thirteen built-in decks reporting exactly nothing.

      Keywords are filtered out rather than counted: the card plays, and what is missing is one way
      to cast or use it. See `ManualReason` and D370.
    */
    const unread = unreadLines(def).filter((line) => line.why !== 'unimplemented-keyword');
    if (unread.length === 0) continue;
    const lines = unread.length === 1 ? 'this line' : `${unread.length} of its lines`;
    byName.set(def.name, {
      name: def.name,
      reason: 'text-not-automated',
      detail: `the engine casts and plays this card, but ${lines} of printed text does nothing:`
        + ` “${quoted(unread[0]!.line)}” — do that part by hand`,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One line for the log when an automated game starts, or `null` when there is nothing to say.
 *
 * Phrased as what the engine will **not** do rather than as a warning about the deck, because the
 * deck is fine — it is the engine's coverage that is short, and a player reading this is about to
 * play a game rather than about to fix a list.
 *
 * Caps the names it prints. A pathological paste could make this line longer than the rest of the
 * log put together, and the count is the part that matters; the full list is in the view, which the
 * UI shows beside the cards themselves.
 */
export function manualNote(manual: readonly ManualCard[], cap = 6): string | null {
  if (manual.length === 0) return null;
  const names = manual.slice(0, cap).map((m) => m.name).join(', ');
  const more = manual.length > cap ? `, and ${manual.length - cap} more` : '';
  const these = manual.length === 1 ? 'this card' : 'these cards';
  /*
    "cannot fully play", because the list now holds two different things: a card the engine has no
    data for at all, and a card it plays with one printed line missing. "Cannot play" was true of
    the first and would be a lie about the second — and a player who reads it as a lie once stops
    reading the line. The per-card `detail` says which it is; this line is the count and the names.
  */
  return `The rules engine is running, but it cannot fully play ${these}: ${names}${more}.`
    + ' Check each one and move that part by hand — the turn itself, and every other card, is'
    + ' automated.';
}
