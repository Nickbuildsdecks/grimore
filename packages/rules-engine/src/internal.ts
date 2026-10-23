/**
 * Primitives shared by both halves of the reducer — the tracker actions in `engine.ts` and the card
 * actions in `cardActions.ts`.
 *
 * Extracted rather than duplicated or re-exported from `engine.ts`: `engine.ts` has to import the
 * card reducer to dispatch to it, so if the card reducer imported its helpers back from `engine.ts`
 * the two modules would form a cycle. One module they both depend on has no cycle.
 */
import {
  EngineError,
  type Action,
  type ActionContext,
  type GameState,
  type Seat,
  type SeatIndex,
} from './types.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_DELTA = 999;
export const MIN_DICE_SIDES = 2;
export const MAX_DICE_SIDES = 1000;
export const MIN_DICE_COUNT = 1;
export const MAX_DICE_COUNT = 20;
export const MAX_COUNTER_KEY_LENGTH = 32;
/** Absolute bound on any tracked value so state can never overflow. */
export const MAX_ABS_VALUE = 1_000_000;

/** Caps on the card layer, so one action can never blow past STATE_MAX_BYTES. */
export const MAX_DRAW_COUNT = 20;
export const MAX_TOKEN_COUNT = 20;
export const MAX_INSTANCES = 600;
export const MAX_CARD_TEXT_LENGTH = 1000;
export const MAX_CARD_NAME_LENGTH = 150;

// ---------------------------------------------------------------------------
// PRNG (mulberry32) — small, fast, deterministic.
// ---------------------------------------------------------------------------

/** Returns a function producing floats in [0, 1) from a 32-bit integer seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string, used to derive seeds from ids. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The seed for the RNG used by a particular action is derived from the game's
 * seed and the version of the state the action is applied to, so any client
 * replaying the same action log obtains identical dice, coins and shuffles.
 */
export function actionSeed(rngSeed: number, stateVersion: number): number {
  const mixed = (rngSeed ^ Math.imul(stateVersion + 1, 0x9e3779b9)) >>> 0;
  // Run one mulberry32 step so adjacent versions are decorrelated.
  return Math.floor(mulberry32(mixed)() * 4294967296) >>> 0;
}

/** Derives the seed for the next game after a reset. */
export function deriveNextSeed(rngSeed: number): number {
  return Math.floor(mulberry32((rngSeed + 0x51ed270b) >>> 0)() * 4294967296) >>> 0;
}

/** Fisher-Yates against a supplied RNG, so a shuffle is reproducible from the action log. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function assertInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new EngineError('INVALID_NUMBER', `${label} must be a finite integer`);
  }
}

export function assertIntegerInRange(
  value: unknown, min: number, max: number, label: string,
): asserts value is number {
  assertInteger(value, label);
  if (value < min || value > max) {
    throw new EngineError('INVALID_NUMBER', `${label} must be between ${min} and ${max}`);
  }
}

export function assertDelta(value: unknown, label = 'delta'): asserts value is number {
  assertIntegerInRange(value, -MAX_DELTA, MAX_DELTA, label);
}

export function assertSeatIndex(
  state: GameState, value: unknown, label = 'seat',
): asserts value is SeatIndex {
  assertInteger(value, label);
  if (value < 0 || value >= state.seats.length) {
    throw new EngineError('INVALID_SEAT', `${label} ${value} does not exist at this table`);
  }
}

export function assertNotEliminated(state: GameState, seat: SeatIndex): void {
  const s = state.seats[seat];
  if (s !== undefined && s.eliminated) {
    throw new EngineError('SEAT_ELIMINATED', `seat ${seat} has been eliminated`);
  }
}

export function assertMayActFor(action: Action, target: SeatIndex, ctx: ActionContext): void {
  if (action.by === target || ctx.isHost === true) return;
  throw new EngineError('FORBIDDEN', `seat ${action.by} may not modify seat ${target}`);
}

export function assertHost(action: Action, ctx: ActionContext): void {
  if (ctx.isHost === true) return;
  throw new EngineError('FORBIDDEN', `${action.type} requires the table host`);
}

export function assertCounterKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_COUNTER_KEY_LENGTH) {
    throw new EngineError('INVALID_ACTION', `counter key must be 1-${MAX_COUNTER_KEY_LENGTH} characters`);
  }
}

export function clampValue(value: number): number {
  if (value > MAX_ABS_VALUE) return MAX_ABS_VALUE;
  if (value < -MAX_ABS_VALUE) return -MAX_ABS_VALUE;
  return value;
}

export function replaceSeat(state: GameState, index: SeatIndex, patch: Partial<Seat>): GameState {
  const seats = state.seats.map((s) => (s.index === index ? { ...s, ...patch } : s));
  return { ...state, seats };
}

export function seatName(state: GameState, index: SeatIndex): string {
  const s = state.seats[index];
  return s === undefined ? `seat ${index}` : s.name;
}
