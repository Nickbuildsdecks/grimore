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
 *    casts it and attacks with it — but its oracle text promises something no script implements, so
 *    that text silently does not happen. **Not detected yet**, and that is stated rather than
 *    glossed: `scripts/measure/card-promises.mjs` measures this for the hand-written pool, and the
 *    oracle-text compiler is what will be able to answer it per card. The reason code exists in the
 *    type so that the day it can be answered, nothing else has to change shape.
 *
 * So a game this module calls fully automated may still contain a card whose text is not running.
 * Saying "every card is automated" would be a claim this cannot support, and the wording in the UI
 * and the log follows from that: it names what it found, and does not promise about the rest.
 */
import type { GameState } from './types.js';

/** Why a card is not being played by the engine. */
export type ManualReason =
  /**
   * The engine has no printed data for this card at all — `customDeck` fell through to cardboard.
   * It cannot be cast or played, only moved by hand.
   */
  | 'no-printed-data'
  /**
   * The card is dealt and castable, but its oracle text is not implemented, so resolving it does
   * nothing the text describes.
   *
   * Reserved: nothing emits this yet. See the docblock above — the compiler is what will.
   */
  | 'text-not-automated';

export interface ManualCard {
  readonly name: string;
  readonly reason: ManualReason;
  /** One line a player can act on, written for the person holding the card. */
  readonly detail: string;
}

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
    // The one certain signal. `cardboard` builds a def with a name and empty everything else, so an
    // empty type line means the name never resolved to a real card (see `customDeck`).
    if (def.typeLine.trim().length !== 0) continue;
    if (byName.has(def.name)) continue;
    byName.set(def.name, {
      name: def.name,
      reason: 'no-printed-data',
      detail: 'the engine has no card data under this name, so it cannot be cast or played —'
        + ' move it by hand, as you would at a table',
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
  return `The rules engine is running, but it cannot play ${these}: ${names}${more}.`
    + ' Move them by hand — every other card, and the turn itself, is automated.';
}
