import type { CardDef, CardInstance, ZoneId } from './cards.js';
import type { FormatId } from './formats.js';
import type { AutoAction, AutomationState } from './turnTypes.js';

/** Zero-based seat index at the table. */
export type SeatIndex = number;

/**
 * Why a seat is out. `library` is a player who tried to draw from an empty library (CR 704.5b).
 *
 * That one was missing until a deck was built to cause it: the state-based action has enforced the
 * loss since it was written, and recorded it as `life` — so a table that decked somebody out said
 * they died at zero life while their life total sat at nineteen. Nobody noticed because nothing in
 * the pool had ever tried to win that way.
 */
/**
 * The deals a table can offer, as fixed wordings rather than free text.
 *
 * Presets because the point is an agreement both players can read the same way, and because free
 * text at a table is what the chat panel is already for. Each one carries its own expiry, which is
 * the only part of a deal the engine needs to understand:
 *
 *  - `no-attack-this-turn` — until the end of the current turn.
 *  - `no-attack-next-turn` — until the end of the offering player's next turn.
 *  - `truce-until-your-turn` — both ways, until the receiving player's next turn begins.
 *
 * `truce` is the only one that binds both seats, and it is the one players actually make.
 */
export type PactKind = 'no-attack-this-turn' | 'no-attack-next-turn' | 'truce-until-your-turn';

export interface Pact {
  readonly id: string;
  /** Who offered it. */
  readonly from: SeatIndex;
  /** Who was offered it, and who answers. */
  readonly to: SeatIndex;
  readonly kind: PactKind;
  readonly offeredTurn: number;
  readonly status: 'offered' | 'accepted' | 'declined';
  /**
   * The last turn this pact covers, set when it is accepted.
   *
   * Null while it is only an offer, because an offer nobody has taken covers nothing. An accepted
   * pact stays in the list after it expires rather than being swept: the table's memory of who
   * agreed to what is the point, and a pact that vanished would take the record with it.
   */
  readonly throughTurn: number | null;
  /** Set when somebody attacked in the face of it. The engine notices; it does not refuse. */
  readonly broken?: true;
}

export type EliminatedReason = 'life' | 'poison' | 'commanderDamage' | 'concede' | 'library';

export interface Seat {
  readonly index: SeatIndex;
  readonly playerId: string;
  readonly name: string;
  readonly life: number;
  readonly poison: number;
  /** Damage dealt to this seat by each other seat's commander, keyed by seat index. */
  readonly commanderDamage: Readonly<Record<string, number>>;
  /** Arbitrary named counters (energy, experience, rad, tickets, ...). */
  readonly counters: Readonly<Record<string, number>>;
  readonly eliminated: boolean;
  readonly eliminatedReason: EliminatedReason | null;
  /** Additional mana this seat pays to cast its commander (typically 0, 2, 4, ...). */
  readonly commanderTax: number;
  /**
   * True while this seat is searching its own library, which is the only time its own library
   * contents appear in its view. Without this a player would permanently know their next draw.
   * Shuffling clears it, which is also the rule at a real table.
   */
  readonly searching: boolean;
  /** How many times this seat has mulliganed, so the London bottoming count is derivable. */
  readonly mulligans: number;
  /** Deck this seat loaded, for display. */
  readonly deckId: string | null;
}

export interface LogEntry {
  /** stateVersion of the state produced by this entry. */
  readonly version: number;
  readonly turn: number;
  readonly by: SeatIndex;
  readonly type: ActionType;
  /** Human-readable summary of what happened. */
  readonly message: string;
  /** Structured details (dice results, eliminations, ...). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * The whole table.
 *
 * Extends `AutomationState` rather than nesting it: the automated engine reads `state.step` and
 * `state.effects` on nearly every call, and a table in manual mode simply leaves those at their
 * empty values. One state means the manual moves stay available as the escape hatch for a card
 * nobody has scripted, which is the point of building the automation on top of the tabletop rather
 * than beside it.
 */
export interface GameState extends AutomationState {
  readonly id: string;
  readonly format: FormatId;
  readonly seats: readonly Seat[];
  /** 1-based turn counter. 0 until the game starts. */
  readonly turn: number;
  readonly activeSeat: SeatIndex;
  readonly monarch: SeatIndex | null;
  readonly initiative: SeatIndex | null;
  /**
   * Deals between players, which the engine records and does not enforce.
   *
   * The half of Commander a screen has been worst at. A pod has had threat reads and goad for a
   * while — both of them facts about the board — and no way to say the thing players actually say
   * to each other: *leave me alone this turn and I will leave you alone*. Chat could carry the
   * words, and did, but a sentence that scrolls away is not an agreement anybody can point at
   * three turns later.
   *
   * **Recorded, shown, and never enforced.** A pact is not a rule: nothing here refuses an attack
   * that breaks one, because a table where the software stops you breaking your word is a table
   * where your word costs nothing. What the engine does instead is notice — an attack against
   * somebody you promised not to attack marks the pact broken and says so in the log, so the
   * table remembers who kept their word and who did not. That is the social half of Commander
   * modelled honestly: the pressure is other players, and all the software owes them is a record.
   *
   * On `GameState` rather than in the chat stream because a live pact has to survive a reload and
   * be the same for everybody, which is exactly what state is for and messages are not.
   */
  readonly pacts: readonly Pact[];
  readonly started: boolean;
  readonly finished: boolean;
  readonly winnerSeat: SeatIndex | null;
  /** Monotonic counter, bumped by every successfully applied action. */
  readonly stateVersion: number;
  /** Bounded (most recent MAX_LOG_ENTRIES) history. */
  readonly log: readonly LogEntry[];
  readonly rngSeed: number;

  // ── Card layer ────────────────────────────────────────────────────────────────────────────────
  /** Unique printed cards in play, keyed by `defKeyFor`. Instances point in here — see cards.ts. */
  readonly cardDefs: Readonly<Record<string, CardDef>>;
  readonly instances: Readonly<Record<string, CardInstance>>;
  /** `"<seat>:<zone>"`, plus `"stack"` for the shared stack. Ordered; library index 0 is the top. */
  readonly zones: Readonly<Record<string, readonly string[]>>;
  /** Source of instance ids, so an id is never reused within a game. */
  readonly instanceSeq: number;
}

export const MAX_LOG_ENTRIES = 200;

interface BaseAction {
  /** Seat index issuing the action. */
  readonly by: SeatIndex;
}

export interface LifeAdjustAction extends BaseAction {
  readonly type: 'life:adjust';
  readonly seat: SeatIndex;
  readonly delta: number;
}
export interface PoisonAdjustAction extends BaseAction {
  readonly type: 'poison:adjust';
  readonly seat: SeatIndex;
  readonly delta: number;
}
export interface CommanderDamageAdjustAction extends BaseAction {
  readonly type: 'commanderDamage:adjust';
  /** Seat receiving the damage. */
  readonly seat: SeatIndex;
  /** Seat whose commander dealt the damage. */
  readonly fromSeat: SeatIndex;
  readonly delta: number;
}
export interface CounterAdjustAction extends BaseAction {
  readonly type: 'counter:adjust';
  readonly seat: SeatIndex;
  readonly key: string;
  readonly delta: number;
}
export interface CommanderTaxAdjustAction extends BaseAction {
  readonly type: 'commanderTax:adjust';
  readonly seat: SeatIndex;
  readonly delta: number;
}
export interface MonarchSetAction extends BaseAction {
  readonly type: 'monarch:set';
  /** Seat that becomes the monarch, or null to clear. */
  readonly seat: SeatIndex | null;
}
export interface InitiativeSetAction extends BaseAction {
  readonly type: 'initiative:set';
  readonly seat: SeatIndex | null;
}
/** Offering another seat a deal. See `GameState.pacts`. */
export interface PactOfferAction extends BaseAction {
  readonly type: 'pact:offer';
  readonly seat: SeatIndex;
  readonly kind: PactKind;
}
/** Answering one. Only the seat it was offered to may, which is the whole of its authority. */
export interface PactRespondAction extends BaseAction {
  readonly type: 'pact:respond';
  readonly pact: string;
  readonly accept: boolean;
}
export interface TurnPassAction extends BaseAction {
  readonly type: 'turn:pass';
}
export interface DiceRollAction extends BaseAction {
  readonly type: 'dice:roll';
  readonly sides: number;
  readonly count: number;
}
export interface CoinFlipAction extends BaseAction {
  readonly type: 'coin:flip';
}
export interface ConcedeAction extends BaseAction {
  readonly type: 'concede';
  /** Seat conceding. Defaults to `by`. */
  readonly seat?: SeatIndex;
}
export interface GameStartAction extends BaseAction {
  readonly type: 'game:start';
  /** Seat that takes the first turn. Defaults to seat 0. */
  readonly firstSeat?: SeatIndex;
}
export interface GameResetAction extends BaseAction {
  readonly type: 'game:reset';
}
/**
 * Another game at the same table: same seats, same decks, engine still running.
 *
 * `game:reset` empties the table back to an unstarted tabletop, which is what you want when the
 * players are changing decks or walking away. It is not what you want when two people have just
 * finished a game and said "again" — that took four more actions and a deck picker, and in a
 * product whose whole point is playing Magic with a friend, "again" is one tap.
 */
export interface GameRematchAction extends BaseAction {
  readonly type: 'game:rematch';
}

// ── Card actions ────────────────────────────────────────────────────────────────────────────────
// Every one of these is a physical move, not a game rule: the engine never asks whether a play is
// legal, only whether it is physically coherent (the card exists, the zone exists, the seat may
// touch it). See the header of cards.ts for why.

export interface DeckLoadAction extends BaseAction {
  readonly type: 'deck:load';
  readonly seat: SeatIndex;
  /** Id of a built-in deck, or a key into `ActionContext.decks`. */
  readonly deckId: string;
}
export interface ZoneDrawAction extends BaseAction {
  readonly type: 'zone:draw';
  readonly seat: SeatIndex;
  readonly count: number;
}
export interface ZoneShuffleAction extends BaseAction {
  readonly type: 'zone:shuffle';
  readonly seat: SeatIndex;
  readonly zone: ZoneId;
}
/** Opens this seat's own library to this seat only, until it shuffles. */
export interface ZoneSearchAction extends BaseAction {
  readonly type: 'zone:search';
  readonly seat: SeatIndex;
  readonly searching: boolean;
}
export interface CardMoveAction extends BaseAction {
  readonly type: 'card:move';
  readonly card: string;
  readonly toZone: ZoneId;
  /** Defaults to the card's owner, which is what sends a stolen creature home when it dies. */
  readonly toSeat?: SeatIndex;
  /** Only meaningful for an ordered zone; anything else appends. */
  readonly position?: 'top' | 'bottom';
}
export interface CardTapAction extends BaseAction {
  readonly type: 'card:tap';
  readonly card: string;
  /** Omitted toggles. */
  readonly tapped?: boolean;
}
export interface CardFaceDownAction extends BaseAction {
  readonly type: 'card:faceDown';
  readonly card: string;
  readonly faceDown?: boolean;
}
export interface CardRevealAction extends BaseAction {
  readonly type: 'card:reveal';
  readonly card: string;
  readonly revealed?: boolean;
}
export interface CardCounterAction extends BaseAction {
  readonly type: 'card:counter';
  readonly card: string;
  readonly key: string;
  readonly delta: number;
}
export interface CardAttachAction extends BaseAction {
  readonly type: 'card:attach';
  readonly card: string;
  /** null detaches. */
  readonly to: string | null;
}
/** Stealing a permanent: physically a move to the new controller's battlefield, logged as control. */
export interface CardControlAction extends BaseAction {
  readonly type: 'card:control';
  readonly card: string;
  readonly toSeat: SeatIndex;
}
export interface TurnUntapAllAction extends BaseAction {
  readonly type: 'turn:untapAll';
  readonly seat: SeatIndex;
}
export interface TokenCreateAction extends BaseAction {
  readonly type: 'token:create';
  readonly seat: SeatIndex;
  readonly card: CardDef;
  readonly count?: number;
}
/** London mulligan: hand back, shuffle, draw a full grip. Bottoming is then ordinary card moves. */
export interface MulliganAction extends BaseAction {
  readonly type: 'mulligan';
  readonly seat: SeatIndex;
}

export type Action =
  | LifeAdjustAction
  | PoisonAdjustAction
  | CommanderDamageAdjustAction
  | CounterAdjustAction
  | CommanderTaxAdjustAction
  | MonarchSetAction
  | InitiativeSetAction
  | PactOfferAction
  | PactRespondAction
  | TurnPassAction
  | DiceRollAction
  | CoinFlipAction
  | ConcedeAction
  | GameStartAction
  | GameResetAction
  | GameRematchAction
  | DeckLoadAction
  | ZoneDrawAction
  | ZoneShuffleAction
  | ZoneSearchAction
  | CardMoveAction
  | CardTapAction
  | CardFaceDownAction
  | CardRevealAction
  | CardCounterAction
  | CardAttachAction
  | CardControlAction
  | TurnUntapAllAction
  | TokenCreateAction
  | MulliganAction
  | AutoAction;

export type ActionType = Action['type'];

/**
 * The card half of the union. Having it named is what lets each reducer keep a real exhaustiveness
 * check: `engine.ts` delegates anything it does not handle, and `cardActions.ts` narrows to this
 * first, so adding an action to either half without handling it is a type error rather than a
 * runtime surprise.
 */
export type CardAction =
  | DeckLoadAction
  | ZoneDrawAction
  | ZoneShuffleAction
  | ZoneSearchAction
  | CardMoveAction
  | CardTapAction
  | CardFaceDownAction
  | CardRevealAction
  | CardCounterAction
  | CardAttachAction
  | CardControlAction
  | TurnUntapAllAction
  | TokenCreateAction
  | MulliganAction;

export const CARD_ACTION_TYPES: readonly CardAction['type'][] = Object.freeze([
  'deck:load', 'zone:draw', 'zone:shuffle', 'zone:search', 'card:move', 'card:tap', 'card:faceDown',
  'card:reveal', 'card:counter', 'card:attach', 'card:control', 'turn:untapAll', 'token:create',
  'mulligan',
]);

export function isCardAction(action: Action): action is CardAction {
  return (CARD_ACTION_TYPES as readonly string[]).includes(action.type);
}

export interface ActionContext {
  /** When true, the issuing seat may act on behalf of any seat (table host). */
  readonly isHost?: boolean;
  /** Decks resolvable by `deck:load`, merged over the built-in ones. */
  readonly decks?: Readonly<Record<string, import('./cards.js').DeckSpec>>;
}

/** What a reducer case returns: the new state plus what to write in the log. */
export interface Outcome {
  readonly state: GameState;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export type EngineErrorCode =
  | 'INVALID_ACTION'
  | 'INVALID_SEAT'
  | 'INVALID_NUMBER'
  | 'INVALID_FORMAT'
  | 'INVALID_PLAYERS'
  | 'NOT_STARTED'
  | 'ALREADY_STARTED'
  | 'GAME_FINISHED'
  | 'NOT_ACTIVE_SEAT'
  | 'FORBIDDEN'
  | 'SEAT_ELIMINATED'
  | 'RULE_NOT_APPLICABLE'
  | 'INVALID_CARD'
  | 'INVALID_ZONE'
  | 'INVALID_DECK'
  | 'EMPTY_LIBRARY';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export interface CreateGameOptions {
  readonly id: string;
  readonly format: FormatId;
  readonly players: readonly { readonly playerId: string; readonly name: string }[];
  /** Integer seed. Defaults to a hash of the game id so creation is deterministic. */
  readonly seed?: number;
}

/** Re-exported so callers need one import for the whole engine surface. */
export type { CardDef, CardInstance, ZoneId };
