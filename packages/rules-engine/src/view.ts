/**
 * Per-seat redaction. `GameState` holds every card identity; this decides what one seat may see.
 *
 * It exists because the realtime layer used to broadcast one state payload to the whole room, which
 * for a card game would hand each player their opponent's hand and the order of both libraries. The
 * fix has to be server-side: a client cannot be trusted to refuse to look at data it already holds.
 * So the socket layer never sends `GameState` — it sends `viewFor(state, seat)`, and a card's
 * identity is simply absent from a view that must not know it.
 *
 * ## The rules, and why each one
 *
 *  - **Your hand** is yours. Other hands appear as cards with no identity, so the count and the
 *    layout are right and the contents are not there to leak.
 *  - **Libraries are a count**, including your own. A player who could read their own library would
 *    know every draw for the rest of the game. The one exception is while that seat is searching,
 *    which is the same moment a real player is allowed to look — and shuffling ends it.
 *  - **Face-down cards** are visible to the seat they sit with and to nobody else, which is what
 *    makes a face-down permanent or an exiled-face-down card work at all.
 *  - **Everything else** — battlefield, graveyard, exile, command zone, the stack — is public, as it
 *    is on a table.
 *
 * Redacting also keeps the payload small: a definition is inlined only onto the cards this seat can
 * see, so there is no separate dictionary for a client to cache and no risk of the full card list
 * travelling. Together with a trimmed log that leaves a view far inside `STATE_MAX_BYTES`.
 */
import { zoneKey, type CardDef, type CardInstance, type ZoneId } from './cards.js';
import type { FormatId } from './formats.js';
import type { EliminatedReason, GameState, LogEntry, SeatIndex } from './types.js';

/**
 * How much history a view carries. The engine keeps 200 entries; a table needs far fewer on screen,
 * and the log is otherwise the largest thing in the payload.
 */
export const VIEW_LOG_ENTRIES = 60;

/** A card as one seat sees it. `card` is absent exactly when that seat may not know what it is. */
export interface VisibleCard {
  readonly id: string;
  readonly owner: SeatIndex;
  readonly zoneSeat: SeatIndex;
  readonly zone: ZoneId;
  readonly tapped: boolean;
  readonly faceDown: boolean;
  readonly revealed: boolean;
  readonly counters: Readonly<Record<string, number>>;
  readonly attachedTo: string | null;
  readonly isToken: boolean;
  readonly isCommander: boolean;
  readonly card?: CardDef;
}

export interface SeatView {
  readonly index: SeatIndex;
  readonly playerId: string;
  readonly name: string;
  readonly life: number;
  readonly poison: number;
  readonly commanderDamage: Readonly<Record<string, number>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly eliminated: boolean;
  readonly eliminatedReason: EliminatedReason | null;
  readonly commanderTax: number;
  readonly mulligans: number;
  readonly deckId: string | null;
  readonly searching: boolean;
  readonly handCount: number;
  readonly libraryCount: number;
  readonly graveyardCount: number;
  readonly exileCount: number;
  readonly battlefieldCount: number;
}

export interface GameView {
  readonly id: string;
  readonly format: FormatId;
  readonly turn: number;
  readonly activeSeat: SeatIndex;
  readonly monarch: SeatIndex | null;
  readonly initiative: SeatIndex | null;
  readonly started: boolean;
  readonly finished: boolean;
  readonly winnerSeat: SeatIndex | null;
  readonly stateVersion: number;
  readonly log: readonly LogEntry[];
  /** The seat this view was built for, or null for a spectator. */
  readonly seat: SeatIndex | null;
  readonly seats: readonly SeatView[];
  /** Every card this seat may see or must be able to count, keyed by instance id. */
  readonly cards: Readonly<Record<string, VisibleCard>>;
  /**
   * Ordered contents per zone key. A library is absent unless that seat is searching its own, so a
   * missing key means "you may know the size but not the order" — `libraryCount` carries the size.
   */
  readonly zones: Readonly<Record<string, readonly string[]>>;
}

const listAt = (state: GameState, key: string): readonly string[] => state.zones[key] ?? [];

/** Whether `viewer` is allowed to know what `inst` is. */
function canIdentify(state: GameState, inst: CardInstance, viewer: SeatIndex | null): boolean {
  // Deliberately shown to the table beats every other rule.
  if (inst.revealed) return true;
  const isOwnSide = viewer !== null && inst.zoneSeat === viewer;
  switch (inst.zone) {
    case 'hand':
      return isOwnSide;
    case 'library':
      // Only while this seat is actually searching, and only its own.
      return isOwnSide && state.seats[inst.zoneSeat]?.searching === true;
    case 'battlefield':
    case 'exile':
      // Face down hides a card from everyone except the seat it sits with.
      return !inst.faceDown || isOwnSide;
    case 'graveyard':
    case 'command':
    case 'stack':
      return true;
    default:
      return false;
  }
}

function redact(state: GameState, inst: CardInstance, viewer: SeatIndex | null): VisibleCard {
  const base: VisibleCard = {
    id: inst.id,
    owner: inst.owner,
    zoneSeat: inst.zoneSeat,
    zone: inst.zone,
    tapped: inst.tapped,
    faceDown: inst.faceDown,
    revealed: inst.revealed,
    counters: inst.counters,
    attachedTo: inst.attachedTo,
    isToken: inst.isToken,
    isCommander: inst.isCommander,
  };
  if (!canIdentify(state, inst, viewer)) return base;
  const card = state.cardDefs[inst.defKey];
  return card === undefined ? base : { ...base, card };
}

/**
 * Builds the state as one seat may see it. Pass `null` for a spectator, who sees the public zones
 * and nothing hidden.
 */
export function viewFor(state: GameState, viewer: SeatIndex | null): GameView {
  const cards: Record<string, VisibleCard> = {};
  const zones: Record<string, readonly string[]> = {};

  const include = (key: string): void => {
    const ids = listAt(state, key);
    if (ids.length === 0) return;
    zones[key] = [...ids];
    for (const id of ids) {
      const inst = state.instances[id];
      if (inst !== undefined) cards[id] = redact(state, inst, viewer);
    }
  };

  for (const seat of state.seats) {
    // The hand's ids travel so the opponent's grip can be drawn and counted; the identities do not.
    include(zoneKey(seat.index, 'hand'));
    include(zoneKey(seat.index, 'battlefield'));
    include(zoneKey(seat.index, 'graveyard'));
    include(zoneKey(seat.index, 'exile'));
    include(zoneKey(seat.index, 'command'));
    // A library's order is withheld from everyone, including its owner, except while searching.
    if (viewer !== null && seat.index === viewer && seat.searching) {
      include(zoneKey(seat.index, 'library'));
    }
  }
  include('stack');

  const seats: SeatView[] = state.seats.map((seat) => ({
    index: seat.index,
    playerId: seat.playerId,
    name: seat.name,
    life: seat.life,
    poison: seat.poison,
    commanderDamage: seat.commanderDamage,
    counters: seat.counters,
    eliminated: seat.eliminated,
    eliminatedReason: seat.eliminatedReason,
    commanderTax: seat.commanderTax,
    mulligans: seat.mulligans,
    deckId: seat.deckId,
    searching: seat.searching,
    handCount: listAt(state, zoneKey(seat.index, 'hand')).length,
    libraryCount: listAt(state, zoneKey(seat.index, 'library')).length,
    graveyardCount: listAt(state, zoneKey(seat.index, 'graveyard')).length,
    exileCount: listAt(state, zoneKey(seat.index, 'exile')).length,
    battlefieldCount: listAt(state, zoneKey(seat.index, 'battlefield')).length,
  }));

  return {
    id: state.id,
    format: state.format,
    turn: state.turn,
    activeSeat: state.activeSeat,
    monarch: state.monarch,
    initiative: state.initiative,
    started: state.started,
    finished: state.finished,
    winnerSeat: state.winnerSeat,
    stateVersion: state.stateVersion,
    log: state.log.slice(-VIEW_LOG_ENTRIES),
    seat: viewer,
    seats,
    cards,
    zones,
  };
}
