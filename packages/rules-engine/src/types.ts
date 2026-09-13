import type { FormatId } from './formats.js';

/** Zero-based seat index at the table. */
export type SeatIndex = number;

export type EliminatedReason = 'life' | 'poison' | 'commanderDamage' | 'concede';

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

export interface GameState {
  readonly id: string;
  readonly format: FormatId;
  readonly seats: readonly Seat[];
  /** 1-based turn counter. 0 until the game starts. */
  readonly turn: number;
  readonly activeSeat: SeatIndex;
  readonly monarch: SeatIndex | null;
  readonly initiative: SeatIndex | null;
  readonly started: boolean;
  readonly finished: boolean;
  readonly winnerSeat: SeatIndex | null;
  /** Monotonic counter, bumped by every successfully applied action. */
  readonly stateVersion: number;
  /** Bounded (most recent MAX_LOG_ENTRIES) history. */
  readonly log: readonly LogEntry[];
  readonly rngSeed: number;
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

export type Action =
  | LifeAdjustAction
  | PoisonAdjustAction
  | CommanderDamageAdjustAction
  | CounterAdjustAction
  | CommanderTaxAdjustAction
  | MonarchSetAction
  | InitiativeSetAction
  | TurnPassAction
  | DiceRollAction
  | CoinFlipAction
  | ConcedeAction
  | GameStartAction
  | GameResetAction;

export type ActionType = Action['type'];

export interface ActionContext {
  /** When true, the issuing seat may act on behalf of any seat (table host). */
  readonly isHost?: boolean;
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
  | 'RULE_NOT_APPLICABLE';

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
