import {
  COMMANDER_DAMAGE_THRESHOLD,
  FORMATS,
  POISON_THRESHOLD,
  isFormatId,
} from './formats.js';
import {
  EngineError,
  MAX_LOG_ENTRIES,
  type Action,
  type ActionContext,
  type CreateGameOptions,
  type EliminatedReason,
  type GameState,
  type LogEntry,
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
 * replaying the same action log obtains identical dice and coin results.
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

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new EngineError('INVALID_NUMBER', `${label} must be a finite integer`);
  }
}

function assertIntegerInRange(value: unknown, min: number, max: number, label: string): asserts value is number {
  assertInteger(value, label);
  if (value < min || value > max) {
    throw new EngineError('INVALID_NUMBER', `${label} must be between ${min} and ${max}`);
  }
}

function assertDelta(value: unknown, label = 'delta'): asserts value is number {
  assertIntegerInRange(value, -MAX_DELTA, MAX_DELTA, label);
}

function assertSeatIndex(state: GameState, value: unknown, label = 'seat'): asserts value is SeatIndex {
  assertInteger(value, label);
  if (value < 0 || value >= state.seats.length) {
    throw new EngineError('INVALID_SEAT', `${label} ${value} does not exist at this table`);
  }
}

function assertNotEliminated(state: GameState, seat: SeatIndex): void {
  const s = state.seats[seat];
  if (s !== undefined && s.eliminated) {
    throw new EngineError('SEAT_ELIMINATED', `seat ${seat} has been eliminated`);
  }
}

function assertMayActFor(action: Action, target: SeatIndex, ctx: ActionContext): void {
  if (action.by === target || ctx.isHost === true) return;
  throw new EngineError('FORBIDDEN', `seat ${action.by} may not modify seat ${target}`);
}

function assertHost(action: Action, ctx: ActionContext): void {
  if (ctx.isHost === true) return;
  throw new EngineError('FORBIDDEN', `${action.type} requires the table host`);
}

function clampValue(value: number): number {
  if (value > MAX_ABS_VALUE) return MAX_ABS_VALUE;
  if (value < -MAX_ABS_VALUE) return -MAX_ABS_VALUE;
  return value;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function makeSeat(index: number, playerId: string, name: string, life: number): Seat {
  return {
    index,
    playerId,
    name,
    life,
    poison: 0,
    commanderDamage: {},
    counters: {},
    eliminated: false,
    eliminatedReason: null,
    commanderTax: 0,
  };
}

export function createGame(options: CreateGameOptions): GameState {
  const { id, format, players } = options;
  if (typeof id !== 'string' || id.length === 0) {
    throw new EngineError('INVALID_ACTION', 'game id must be a non-empty string');
  }
  if (!isFormatId(format)) {
    throw new EngineError('INVALID_FORMAT', `unknown format: ${String(format)}`);
  }
  const def = FORMATS[format];
  if (!Array.isArray(players) || players.length < def.minPlayers || players.length > def.maxPlayers) {
    throw new EngineError(
      'INVALID_PLAYERS',
      `${def.label} requires ${def.minPlayers}-${def.maxPlayers} players`,
    );
  }
  const seen = new Set<string>();
  for (const p of players) {
    if (!p || typeof p.playerId !== 'string' || p.playerId.length === 0 || typeof p.name !== 'string') {
      throw new EngineError('INVALID_PLAYERS', 'each player needs a playerId and a name');
    }
    if (seen.has(p.playerId)) {
      throw new EngineError('INVALID_PLAYERS', `duplicate playerId: ${p.playerId}`);
    }
    seen.add(p.playerId);
  }
  let seed: number;
  if (options.seed === undefined) {
    seed = hashString(id);
  } else {
    assertInteger(options.seed, 'seed');
    seed = options.seed >>> 0;
  }
  return {
    id,
    format,
    seats: players.map((p, i) => makeSeat(i, p.playerId, p.name, def.startingLife)),
    turn: 0,
    activeSeat: 0,
    monarch: null,
    initiative: null,
    started: false,
    finished: false,
    winnerSeat: null,
    stateVersion: 0,
    log: [],
    rngSeed: seed,
  };
}

// ---------------------------------------------------------------------------
// Internal state helpers (all return new objects)
// ---------------------------------------------------------------------------

function replaceSeat(state: GameState, index: SeatIndex, patch: Partial<Seat>): GameState {
  const seats = state.seats.map((s) => (s.index === index ? { ...s, ...patch } : s));
  return { ...state, seats };
}

function aliveSeats(state: GameState): Seat[] {
  return state.seats.filter((s) => !s.eliminated);
}

function nextAliveSeat(state: GameState, from: SeatIndex): SeatIndex {
  const n = state.seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    const seat = state.seats[idx];
    if (seat !== undefined && !seat.eliminated) return idx;
  }
  return from;
}

interface Elimination {
  readonly seat: SeatIndex;
  readonly reason: EliminatedReason;
}

/** Applies elimination and win-condition checks. Returns new state plus what changed. */
function resolveStateBasedActions(state: GameState): { state: GameState; eliminations: Elimination[] } {
  const def = FORMATS[state.format];
  const eliminations: Elimination[] = [];
  let next = state;

  for (const seat of state.seats) {
    if (seat.eliminated) continue;
    let reason: EliminatedReason | null = null;
    if (seat.life <= 0) {
      reason = 'life';
    } else if (def.poisonRule && seat.poison >= POISON_THRESHOLD) {
      reason = 'poison';
    } else if (
      def.commanderDamageRule &&
      Object.values(seat.commanderDamage).some((d) => d >= COMMANDER_DAMAGE_THRESHOLD)
    ) {
      reason = 'commanderDamage';
    }
    if (reason !== null) {
      next = replaceSeat(next, seat.index, { eliminated: true, eliminatedReason: reason });
      eliminations.push({ seat: seat.index, reason });
    }
  }

  // Eliminated seats (including concessions) cannot hold the crown or the initiative.
  if (next.monarch !== null && next.seats[next.monarch]?.eliminated) next = { ...next, monarch: null };
  if (next.initiative !== null && next.seats[next.initiative]?.eliminated) next = { ...next, initiative: null };

  const activeSeat = next.seats[next.activeSeat];
  if (next.started && activeSeat !== undefined && activeSeat.eliminated) {
    next = { ...next, activeSeat: nextAliveSeat(next, next.activeSeat) };
  }

  const alive = aliveSeats(next);
  if (!next.finished && alive.length <= 1) {
    const winner = alive[0];
    next = { ...next, finished: true, winnerSeat: winner === undefined ? null : winner.index };
  }

  return { state: next, eliminations };
}

function appendLog(state: GameState, entry: Omit<LogEntry, 'version' | 'turn'>): GameState {
  const full: LogEntry = { version: state.stateVersion, turn: state.turn, ...entry };
  const log = state.log.length >= MAX_LOG_ENTRIES
    ? [...state.log.slice(state.log.length - MAX_LOG_ENTRIES + 1), full]
    : [...state.log, full];
  return { ...state, log };
}

function seatName(state: GameState, index: SeatIndex): string {
  const s = state.seats[index];
  return s === undefined ? `seat ${index}` : s.name;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface Outcome {
  readonly state: GameState;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

function reduce(state: GameState, action: Action, ctx: ActionContext): Outcome {
  switch (action.type) {
    case 'life:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const life = clampValue(seat.life + action.delta);
      return {
        state: replaceSeat(state, action.seat, { life }),
        message: `${seatName(state, action.seat)} life ${seat.life} -> ${life}`,
        data: { seat: action.seat, delta: action.delta, life },
      };
    }

    case 'poison:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const poison = Math.max(0, clampValue(seat.poison + action.delta));
      return {
        state: replaceSeat(state, action.seat, { poison }),
        message: `${seatName(state, action.seat)} poison ${seat.poison} -> ${poison}`,
        data: { seat: action.seat, delta: action.delta, poison },
      };
    }

    case 'commanderDamage:adjust': {
      if (!FORMATS[state.format].commanderDamageRule) {
        throw new EngineError('RULE_NOT_APPLICABLE', `commander damage is not tracked in ${state.format}`);
      }
      assertSeatIndex(state, action.seat);
      assertSeatIndex(state, action.fromSeat, 'fromSeat');
      assertDelta(action.delta);
      if (action.seat === action.fromSeat) {
        throw new EngineError('INVALID_SEAT', 'a commander cannot deal commander damage to its own seat');
      }
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const key = String(action.fromSeat);
      const prev = seat.commanderDamage[key] ?? 0;
      const value = Math.max(0, clampValue(prev + action.delta));
      const commanderDamage = { ...seat.commanderDamage, [key]: value };
      return {
        state: replaceSeat(state, action.seat, { commanderDamage }),
        message: `${seatName(state, action.seat)} commander damage from ${seatName(state, action.fromSeat)} ${prev} -> ${value}`,
        data: { seat: action.seat, fromSeat: action.fromSeat, delta: action.delta, value },
      };
    }

    case 'counter:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      if (
        typeof action.key !== 'string' ||
        action.key.length === 0 ||
        action.key.length > MAX_COUNTER_KEY_LENGTH ||
        !/^[a-z0-9_-]+$/i.test(action.key)
      ) {
        throw new EngineError('INVALID_ACTION', 'counter key must be 1-32 alphanumeric characters');
      }
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const prev = seat.counters[action.key] ?? 0;
      const value = Math.max(0, clampValue(prev + action.delta));
      const counters: Record<string, number> = { ...seat.counters };
      if (value === 0) {
        delete counters[action.key];
      } else {
        counters[action.key] = value;
      }
      return {
        state: replaceSeat(state, action.seat, { counters }),
        message: `${seatName(state, action.seat)} ${action.key} ${prev} -> ${value}`,
        data: { seat: action.seat, key: action.key, delta: action.delta, value },
      };
    }

    case 'commanderTax:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const commanderTax = Math.max(0, clampValue(seat.commanderTax + action.delta));
      return {
        state: replaceSeat(state, action.seat, { commanderTax }),
        message: `${seatName(state, action.seat)} commander tax ${seat.commanderTax} -> ${commanderTax}`,
        data: { seat: action.seat, delta: action.delta, commanderTax },
      };
    }

    case 'monarch:set': {
      if (action.seat === null) {
        // Only the current monarch (or host) may clear the crown.
        if (state.monarch !== null) assertMayActFor(action, state.monarch, ctx);
        return { state: { ...state, monarch: null }, message: 'monarch cleared', data: { seat: null } };
      }
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      return {
        state: { ...state, monarch: action.seat },
        message: `${seatName(state, action.seat)} is the monarch`,
        data: { seat: action.seat },
      };
    }

    case 'initiative:set': {
      if (action.seat === null) {
        if (state.initiative !== null) assertMayActFor(action, state.initiative, ctx);
        return { state: { ...state, initiative: null }, message: 'initiative cleared', data: { seat: null } };
      }
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      return {
        state: { ...state, initiative: action.seat },
        message: `${seatName(state, action.seat)} takes the initiative`,
        data: { seat: action.seat },
      };
    }

    case 'turn:pass': {
      if (!state.started) throw new EngineError('NOT_STARTED', 'the game has not started');
      if (action.by !== state.activeSeat && ctx.isHost !== true) {
        throw new EngineError('NOT_ACTIVE_SEAT', `seat ${action.by} is not the active seat`);
      }
      const next = nextAliveSeat(state, state.activeSeat);
      return {
        state: { ...state, activeSeat: next, turn: state.turn + 1 },
        message: `turn passes to ${seatName(state, next)}`,
        data: { from: state.activeSeat, to: next, turn: state.turn + 1 },
      };
    }

    case 'dice:roll': {
      assertIntegerInRange(action.sides, MIN_DICE_SIDES, MAX_DICE_SIDES, 'sides');
      assertIntegerInRange(action.count, MIN_DICE_COUNT, MAX_DICE_COUNT, 'count');
      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      const results: number[] = [];
      for (let i = 0; i < action.count; i++) {
        results.push(Math.floor(rng() * action.sides) + 1);
      }
      const total = results.reduce((a, b) => a + b, 0);
      return {
        state,
        message: `${seatName(state, action.by)} rolled ${action.count}d${action.sides}: ${results.join(', ')} (total ${total})`,
        data: { sides: action.sides, count: action.count, results, total },
      };
    }

    case 'coin:flip': {
      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      const result = rng() < 0.5 ? 'heads' : 'tails';
      return {
        state,
        message: `${seatName(state, action.by)} flipped a coin: ${result}`,
        data: { result },
      };
    }

    case 'concede': {
      const target = action.seat === undefined ? action.by : action.seat;
      assertSeatIndex(state, target);
      assertMayActFor(action, target, ctx);
      assertNotEliminated(state, target);
      return {
        state: replaceSeat(state, target, { eliminated: true, eliminatedReason: 'concede' }),
        message: `${seatName(state, target)} conceded`,
        data: { seat: target },
      };
    }

    case 'game:start': {
      if (state.started) throw new EngineError('ALREADY_STARTED', 'the game has already started');
      assertSeatIndex(state, action.by, 'by');
      const first = action.firstSeat === undefined ? 0 : action.firstSeat;
      assertSeatIndex(state, first, 'firstSeat');
      assertNotEliminated(state, first);
      return {
        state: { ...state, started: true, turn: 1, activeSeat: first },
        message: `game started; ${seatName(state, first)} goes first`,
        data: { firstSeat: first },
      };
    }

    case 'game:reset': {
      assertHost(action, ctx);
      const def = FORMATS[state.format];
      const fresh: GameState = {
        ...state,
        seats: state.seats.map((s) => makeSeat(s.index, s.playerId, s.name, def.startingLife)),
        turn: 0,
        activeSeat: 0,
        monarch: null,
        initiative: null,
        started: false,
        finished: false,
        winnerSeat: null,
        rngSeed: deriveNextSeed(state.rngSeed),
      };
      return { state: fresh, message: 'game reset', data: { rngSeed: fresh.rngSeed } };
    }

    default: {
      const unknown: never = action;
      throw new EngineError('INVALID_ACTION', `unknown action type: ${String((unknown as { type?: unknown }).type)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies one action and returns the resulting state. The input state is never
 * mutated. Throws an EngineError when the action is invalid or not permitted.
 */
export function applyAction(state: GameState, action: Action, ctx: ActionContext = {}): GameState {
  if (typeof action !== 'object' || action === null || typeof action.type !== 'string') {
    throw new EngineError('INVALID_ACTION', 'action must be an object with a type');
  }
  assertSeatIndex(state, action.by, 'by');
  if (state.finished && action.type !== 'game:reset') {
    throw new EngineError('GAME_FINISHED', 'the game is finished');
  }

  const outcome = reduce(state, action, ctx);
  const isReset = action.type === 'game:reset';
  const resolved = isReset
    ? { state: outcome.state, eliminations: [] as Elimination[] }
    : resolveStateBasedActions(outcome.state);

  let next: GameState = { ...resolved.state, stateVersion: state.stateVersion + 1 };

  const data: Record<string, unknown> = { ...(outcome.data ?? {}) };
  let message = outcome.message;
  if (resolved.eliminations.length > 0) {
    data['eliminations'] = resolved.eliminations;
    message += '; ' + resolved.eliminations
      .map((e) => `${seatName(next, e.seat)} eliminated (${e.reason})`)
      .join(', ');
  }
  if (next.finished && !state.finished) {
    data['winnerSeat'] = next.winnerSeat;
    message += next.winnerSeat === null
      ? '; game over with no winner'
      : `; ${seatName(next, next.winnerSeat)} wins`;
  }

  next = appendLog(next, { by: action.by, type: action.type, message, data });
  return next;
}

/** Applies a sequence of actions in order; useful for deterministic replay. */
export function applyMany(
  state: GameState,
  actions: readonly (Action | { action: Action; ctx?: ActionContext })[],
  ctx: ActionContext = {},
): GameState {
  let current = state;
  for (const item of actions) {
    if ('action' in item) {
      current = applyAction(current, item.action, item.ctx ?? ctx);
    } else {
      current = applyAction(current, item, ctx);
    }
  }
  return current;
}

/** Convenience: the most recent log entry, if any. */
export function lastLogEntry(state: GameState): LogEntry | undefined {
  return state.log[state.log.length - 1];
}
