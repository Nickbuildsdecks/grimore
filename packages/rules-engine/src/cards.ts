/**
 * The card layer: definitions, instances and zones.
 *
 * ## Why a tabletop and not a scripted engine
 *
 * Nothing here knows what a card *does*. A scripted engine has to implement each card individually,
 * so it only works for the cards someone has written code for — a few dozen out of roughly thirty
 * thousand — and a Commander deck would mostly not function. This models the cardboard instead:
 * every zone is manipulable, every move is legal, and the players apply the rules exactly as they do
 * at a kitchen table. That is what makes an entire game playable with any deck on day one. The
 * action set is deliberately shaped so per-card automation can be layered on later without changing
 * the state model.
 *
 * ## Why definitions are separate from instances
 *
 * A two-player Commander game is around 200 physical cards. Carrying a name, type line, mana cost
 * and oracle text on each instance costs roughly 350 bytes a card, which is 70KB of state before
 * anything has happened — past the 64KB `STATE_MAX_BYTES` the realtime contract allows for a state
 * payload. So instances carry a `defKey` into a per-game dictionary of unique cards (about 50 entries
 * for two decks), and `viewFor` inlines a definition only onto the cards that seat may actually see.
 * A redacted view is a fraction of the full state, which is what travels over the socket.
 */
import type { SeatIndex } from './types.js';

/** `library` index 0 is the top of the deck. `stack` is shared and not owned by a seat. */
export type ZoneId = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'stack';

export const ZONE_IDS: readonly ZoneId[] = Object.freeze([
  'library', 'hand', 'battlefield', 'graveyard', 'exile', 'command', 'stack',
]);

export function isZoneId(value: unknown): value is ZoneId {
  return typeof value === 'string' && (ZONE_IDS as readonly string[]).includes(value);
}

/** Zones whose contents every seat may see in full. */
export const PUBLIC_ZONES: readonly ZoneId[] = Object.freeze(['battlefield', 'graveyard', 'exile', 'command', 'stack']);

/**
 * A printed card. `imageUri` is optional on purpose: this environment cannot reach Scryfall, and a
 * fresh Grimore database has no card images either, so every card face has to be fully legible from
 * text alone. The UI treats an image as an enhancement, never a requirement.
 */
export interface CardDef {
  readonly name: string;
  readonly typeLine: string;
  readonly manaCost: string;
  readonly cmc: number;
  readonly oracleText: string;
  readonly colors: readonly string[];
  /** Printed power/toughness as strings, because `*` and `1+*` are legal values. */
  readonly power?: string;
  readonly toughness?: string;
  /** Printed starting loyalty, for a planeswalker. A string for the same reason P/T are. */
  readonly loyalty?: string;
  readonly imageUri?: string;
  readonly scryfallId?: string;
  /**
   * The other faces this card can be cast as, for a card printed with more than one (CR 708).
   *
   * The nested definitions are ordinary `CardDef`s and are registered in `cardDefs` under their
   * own keys as the deck loads, which is what makes the rest of the engine need no changes: a
   * spell cast as one face reads that face's definition and that face's script, through the same
   * `defKey` lookups everything else already does. See `CardInstance.castAs`.
   */
  readonly faces?: CardFaces;
}

/**
 * A card with more than one castable face, and which kind of printing it is.
 *
 * Two kinds, because the rules differ in exactly two places and nowhere else:
 *
 * - `split`: the card is **only** castable as one of its halves, and the whole card's printed
 *   characteristics — the combined cost, the summed mana value — are what it has everywhere but
 *   the stack (CR 708.4). "Cast Fire // Ice" is not a play; "Cast Fire" and "Cast Ice" are.
 * - `adventure`: the card itself is castable (it is a creature card), and `cards` holds the one
 *   instant or sorcery it may instead be cast as. An adventure that resolves is exiled rather than
 *   put into a graveyard, and its owner may then cast the creature out of exile.
 *
 * Everything else about the two is the same, which is why they share a field: a face is a
 * definition, casting one is a cast, and the half on the stack is the half that resolves.
 */
export interface CardFaces {
  readonly kind: 'split' | 'adventure';
  readonly cards: readonly CardDef[];
}

/** The faces a card offers, or nothing. */
export const facesOf = (def: CardDef | undefined): readonly CardDef[] => def?.faces?.cards ?? [];

/**
 * Whether this card can be cast as itself.
 *
 * False for a split card and true for everything else, the adventurer included: an adventurer is a
 * creature card that happens to have a spell on it, and a split card is two spells with no card of
 * their own.
 */
export const castableAsPrinted = (def: CardDef | undefined): boolean => def?.faces?.kind !== 'split';

/**
 * One physical card at the table.
 *
 * `owner` never changes — it decides where a card returns to when it leaves the battlefield.
 * `zoneSeat` is whose side of the table the card is physically on right now. On the battlefield that
 * is its controller, so stealing a creature moves it to the thief's battlefield while `owner` still
 * sends it to its owner's graveyard when it dies. A separate `controller` field would be the same
 * information twice, and two copies can disagree.
 */
export interface CardInstance {
  readonly id: string;
  readonly defKey: string;
  readonly owner: SeatIndex;
  /** Whose zone the card is in. Always equals `zoneKey(zoneSeat, zone)`'s seat. */
  readonly zoneSeat: SeatIndex;
  readonly zone: ZoneId;
  readonly tapped: boolean;
  /** Face-down cards are visible to their controller and to nobody else. */
  readonly faceDown: boolean;
  /** Deliberately shown to the whole table, which beats a face-up card in a hidden zone. */
  readonly revealed: boolean;
  readonly counters: Readonly<Record<string, number>>;
  /** Equipment, auras and anything else physically on another card. */
  readonly attachedTo: string | null;
  /**
   * The permanent that exiled this card "until it leaves the battlefield" (CR 400.7e).
   *
   * Set on the *exiled* card rather than on the exiler, for the same reason `attachedTo` is set on
   * the Aura: one card in exile is exiled by at most one thing, while one Banisher Priest could
   * in principle be holding several. The exiler's leave trigger looks up whatever points at it.
   */
  readonly exiledBy?: string;
  /**
   * The turn this card was foretold, which is the only reason the engine has to remember it
   * (CR 702.143b: a foretold card cannot be cast on the turn it was foretold).
   *
   * On the instance rather than in a list somewhere, because it is a fact about this card and it
   * has to survive the card sitting in exile across several turns. Absent on everything else,
   * which is also how `legalActions` tells a foretold card in exile from a card exiled by a
   * Banisher Priest — both are face down in exile and only one of them is castable.
   */
  readonly foretoldTurn?: number;
  /**
   * The face this card was cast as, while it is on the stack: a def key, into `cardDefs`.
   *
   * A spell on the stack has the characteristics of **only** the face being cast (CR 708.4), so
   * this is read in preference to `defKey` by `characteristicsOf` — which is what makes "counter
   * target creature spell" miss an adventure's instant half and catch the creature, off one line
   * rather than off a special case in every reader.
   *
   * On the instance rather than only on the stack object because the *card* is what gets targeted:
   * a counterspell's filter is handed a card id and looks up its characteristics, and a stack
   * object it never saw cannot help it. Cleared by `relocate` on the way off the stack, like
   * `tapped` and `frozen` — the card in the graveyard afterwards is the whole card again.
   */
  readonly castAs?: string;
  /**
   * Set on a card in exile that went there as an adventure resolved, which is the whole of what
   * makes the creature castable later.
   *
   * The same shape as `foretoldTurn`: a fact about this card that has to survive it sitting in
   * exile for several turns, and the thing that tells `legalActions` this exiled card is a play
   * while the one a Banisher Priest took is not. No turn is recorded because, unlike foretell,
   * there is no wait — the adventure resolved, and the creature is castable from then on.
   */
  readonly onAdventure?: true;
  readonly isToken: boolean;
  readonly isCommander: boolean;
  /**
   * The card this instance is printed as, when a copy effect has made it something else.
   *
   * A copy effect is layer 1 (CR 613.1a), and the engine applies it by pointing `defKey` at the
   * copied card: everything downstream — characteristics, the script that gives it abilities, the
   * definition the table draws — then reads the copy without a single one of them having to know
   * that copying exists. This is what makes that honest rather than permanent. A copy effect from
   * "enters as a copy" lasts as long as the permanent does, so `relocate` — the one place a card
   * changes zone — puts `defKey` back when it leaves the battlefield. A Clone that copied a Shivan
   * Dragon is a Clone again in the graveyard, which is what can be reanimated.
   */
  readonly printedDefKey?: string;
  /**
   * How many times this card has changed zones: the same card, a different **object** (CR 400.7).
   *
   * The engine keeps one id per physical card, which is what lets the table animate a card from a
   * hand to a graveyard and a test follow it. But the rules say a card that changes zones becomes
   * a new object, and one rule depends on it: a spell that targeted a creature does not resolve
   * against the creature that comes *back* (CR 608.2b). A Cloudshift in response to a Doom Blade
   * is the whole point of the card and it cannot work without this counter. Absent means zero.
   */
  readonly objectSeq?: number;
  /**
   * Damage marked on this permanent, which is wiped in the cleanup step. Separate from toughness
   * because toughness is computed and damage is not: a creature with 3 damage that gets +3/+3 stops
   * being dead, and that only works if the damage is remembered rather than subtracted at the time.
   */
  readonly damage: number;
  /**
   * The turn this permanent came under its controller's control. A creature is summoning sick while
   * `enteredTurn >= state.turn`: anything that entered on an earlier turn has, by definition, been
   * there since the start of the current turn.
   */
  readonly enteredTurn: number;
  /**
   * The turn a loyalty ability of this planeswalker was activated, or absent for never.
   *
   * One loyalty ability per planeswalker per turn (CR 606.3), and "per turn" is the whole
   * restriction — it is not a tap, and the ability is not used up, so there is nothing else on
   * the instance that could record it.
   */
  readonly loyaltyUsedTurn?: number;
  /**
   * This permanent does not untap during its controller's next untap step (CR 502.2).
   *
   * A flag on the instance rather than a continuous effect, because it is not one: nothing about
   * the permanent is different while it is set — it has the same power, the same abilities and the
   * same keywords — and the only thing in the game that reads it is the untap step, which clears
   * it as it declines to untap. One use, then gone, which is what "next untap step" means.
   *
   * Keyed to the permanent rather than to a seat, so a creature that changes controller stays
   * frozen: that is the rule for the effects that read "its controller's next untap step", because
   * the controller is read when the step comes round rather than when the effect was created.
   */
  readonly frozen?: boolean;
}

/**
 * A permanent that is face down, and so has none of its card's abilities (CR 707.2).
 *
 * One predicate rather than the condition written out at each of the places that has to respect
 * it — a trigger loop, a mana source, an activated ability, a continuous effect, the characteristics
 * themselves — because a list of five places is a list somebody adds a sixth to without noticing.
 *
 * Only on the battlefield: a face-down card in exile is a card nobody may read, which is a question
 * for `viewFor` rather than for the rules.
 */
export const isFaceDownPermanent = (inst: CardInstance): boolean =>
  inst.faceDown && inst.zone === 'battlefield';

/**
 * A face-down *object*: a permanent, or a spell waiting on the stack (CR 707.2, 707.4).
 *
 * The wider of the two predicates, and the one `characteristicsOf` uses, because what a face-down
 * thing *is* has the same answer in both places — a 2/2 creature with no name. The narrower
 * `isFaceDownPermanent` is about abilities not applying, and every one of those questions is
 * asked about the battlefield.
 *
 * The stack is here for morph: a face-down creature spell is anonymous on the way down as well as
 * once it lands, so an opponent holding Essence Scatter can see a creature spell to counter and
 * cannot see which one.
 */
export const isFaceDownObject = (inst: CardInstance): boolean =>
  inst.faceDown && (inst.zone === 'battlefield' || inst.zone === 'stack');

/** Key into `GameState.zones`. The stack is shared, so it is not seat-scoped. */
export function zoneKey(seat: SeatIndex, zone: ZoneId): string {
  return zone === 'stack' ? 'stack' : `${seat}:${zone}`;
}

/** A deck as content rather than as 60 repeated objects. */
export interface DeckEntry {
  readonly card: CardDef;
  readonly count: number;
}

export interface DeckSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Goes to the command zone when the table format uses one; otherwise joins the library. */
  readonly commander?: CardDef;
  readonly cards: readonly DeckEntry[];
}

/** Lowercased name. Two printings of one card share a definition, which is what we want here. */
export function defKeyFor(card: CardDef): string {
  return card.name.trim().toLowerCase();
}

export function deckSize(spec: DeckSpec): number {
  return spec.cards.reduce((n, e) => n + e.count, 0) + (spec.commander ? 1 : 0);
}
