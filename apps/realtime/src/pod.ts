/**
 * PodStore: every pod lives entirely in Redis so any realtime node can serve
 * any socket. A pod is one hash (podStateKey) with fields
 *
 *   state   JSON PodRecord { pod, seats (with seat tokens), game, lastActivity }
 *   version integer, bumped by every successful mutation
 *
 * and every mutation goes through the shared CAS_LUA compare-and-set on that
 * version, so concurrent writers from different nodes can never lose an
 * update. Auxiliary keys: a set of public lobby codes (publicPodsKey) and a
 * seatToken -> "CODE:seat" string (seatTokenKey) for reconnects.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { RedisClientType } from 'redis';
import {
  CAS_LUA,
  CAS_RESULT,
  casEvalArgs,
  POD_MAX_SEATS,
  POD_TTL_SECONDS,
  podStateKey,
  publicPodsKey,
  seatTokenKey,
  type Format,
  type Pod,
  type PodErrorCode,
  type PodListEntry,
  type PodSeat,
  type PodVisibility,
} from '@grimore/shared';
import {
  applyAction as engineApply,
  botAction,
  seatsToAct,
  packView,
  viewFor,
  type PackedView,
  createGame,
  EngineError,
  FORMATS,
  type Action,
  type FormatId,
  type GameState,
} from '@grimore/rules-engine';

export class PodError extends Error {
  constructor(
    public readonly code: PodErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PodError';
  }
}

export interface SeatRecord extends PodSeat {
  /** Reconnect token; never sent to other players. */
  token: string;
  /** Epoch ms of the disconnect that started the grace window, or null while connected. */
  disconnectedAt: number | null;
  /** Which built-in deck a bot seat plays. Only set on bot seats. */
  botDeck?: string;
}

export interface PodRecord {
  pod: Omit<Pod, 'seats'>;
  seats: SeatRecord[];
  game: GameState | null;
  lastActivity: number;
}

export interface PodSnapshot {
  pod: Pod;
  state: GameState | null;
  stateVersion: number;
}

export interface JoinResult extends PodSnapshot {
  seat: number;
  seatToken: string;
  playerId: string;
  reclaimed: boolean;
}

export interface Player {
  playerId: string;
  name: string;
}

export interface PodStoreOptions {
  /** Prepended to every key; lets tests isolate and flush their own keyspace. */
  keyPrefix?: string;
  ttlSeconds?: number;
  /** How long a disconnected seat is held for reclaim. */
  graceMs?: number;
  now?: () => number;
}

export const SEAT_GRACE_MS = 120_000;
/** Internal read-modify-write retries; a full 4-seat pod joining at once needs ~4 rounds. */
const CAS_ATTEMPTS = 8;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Word list carried over from the legacy multiplayer.js code generator. */
export const CODE_WORDS = [
  'FROG', 'DRAKE', 'GOBLIN', 'MOX', 'LOTUS', 'TITAN', 'HYDRA', 'SLIVER',
  'KRAKEN', 'ANGEL', 'DEMON', 'ELF', 'WURM', 'PHOENIX', 'GRIM', 'RUNE',
  'STAX', 'TUTOR', 'COMBO', 'MANA', 'SPIRE', 'VAULT', 'RELIC', 'OMEN',
] as const;

export function generateCode(): string {
  const a = CODE_WORDS[randomInt(CODE_WORDS.length)]!;
  const b = CODE_WORDS[randomInt(CODE_WORDS.length)]!;
  return `${a}-${b}-${randomInt(10, 100)}`;
}

export const makeSeatToken = (): string => randomBytes(16).toString('hex');
export const makePlayerId = (): string => `p_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;

/** Shared `Format` (Scryfall-style) -> rules-engine table format. */
export function toEngineFormat(format: Format): FormatId {
  switch (format) {
    case 'commander':
    case 'brawl':
    case 'oathbreaker':
      return 'pod';
    default:
      return 'modern';
  }
}

export function maxSeatsFor(format: Format): number {
  return Math.min(POD_MAX_SEATS, FORMATS[toEngineFormat(format)].maxPlayers);
}

const publicSeat = (s: SeatRecord): PodSeat => ({
  seat: s.seat,
  playerId: s.playerId,
  name: s.name,
  ready: s.ready,
  connected: s.connected,
  // Which seats the server plays is not a secret, and a player should be able to see it.
  bot: s.bot === true,
});

export function toSnapshot(record: PodRecord, version: number): PodSnapshot {
  return {
    pod: { ...record.pod, seats: record.seats.map(publicSeat) },
    state: record.game,
    stateVersion: version,
  };
}

/**
 * A snapshot carrying one seat's redacted view instead of the whole game state.
 *
 * `PackedView` rather than `GameView`: the same thing in its wire form. See `toSeatSnapshot`.
 */
export interface PodViewSnapshot {
  pod: Pod;
  state: PackedView | null;
  stateVersion: number;
}

/**
 * Narrows a snapshot to what one seat may see. `seat` is null for a spectator.
 *
 * This is the only shape that may leave the server for a card game. `PodSnapshot.state` is the full
 * `GameState`, which contains both hands and the order of both libraries — broadcasting it to the
 * room would hand every player their opponent's grip, and no amount of client-side discipline fixes
 * data the client already has. See the header of `packages/rules-engine/src/view.ts`.
 *
 * `packView` is the wire form of the same view: each card definition said once instead of once per
 * copy, and the fields that are false on almost every card left out. It changes nothing about what
 * a seat may see — the client unpacks it back to the identical `GameView` — and it is what keeps a
 * library search inside `STATE_MAX_BYTES`: 45.8KB inlined, 25.3KB packed, against a 64KB cap.
 */
export function toSeatSnapshot(snapshot: PodSnapshot, seat: number | null): PodViewSnapshot {
  return {
    pod: snapshot.pod,
    state: snapshot.state === null ? null : packView(viewFor(snapshot.state, seat)),
    stateVersion: snapshot.stateVersion,
  };
}

interface Stored {
  record: PodRecord;
  version: number;
}

export class PodStore {
  private readonly prefix: string;
  private readonly ttl: number;
  readonly graceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly redis: RedisClientType,
    opts: PodStoreOptions = {},
  ) {
    this.prefix = opts.keyPrefix ? `${opts.keyPrefix}:` : '';
    this.ttl = opts.ttlSeconds ?? POD_TTL_SECONDS;
    this.graceMs = opts.graceMs ?? SEAT_GRACE_MS;
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  private stateKey(code: string): string {
    return this.prefix + podStateKey(code);
  }
  private publicKey(): string {
    return this.prefix + publicPodsKey();
  }
  private tokenKey(token: string): string {
    return this.prefix + seatTokenKey(token);
  }

  /** Deletes every key under this store's prefix. Intended for test teardown. */
  async flushPrefix(): Promise<number> {
    if (!this.prefix) throw new Error('refusing to flush without a key prefix');
    let n = 0;
    for await (const key of this.redis.scanIterator({ MATCH: `${this.prefix}*`, COUNT: 200 })) {
      await this.redis.del(key);
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // low-level read / CAS
  // -------------------------------------------------------------------------

  private async read(code: string): Promise<Stored | null> {
    const h = await this.redis.hGetAll(this.stateKey(code));
    if (!h['state'] || h['version'] === undefined) return null;
    return { record: JSON.parse(h['state']) as PodRecord, version: Number(h['version']) };
  }

  private async cas(code: string, expected: number, record: PodRecord, create = false): Promise<number> {
    const [, key, ...argv] = casEvalArgs({
      key: this.stateKey(code),
      expectedVersion: expected,
      newStateJson: JSON.stringify(record),
      newVersion: expected + 1,
      ttlSeconds: this.ttl,
      create,
    });
    const res = await this.redis.eval(CAS_LUA, { keys: [key], arguments: argv });
    return Number(res);
  }

  async get(code: string): Promise<PodSnapshot | null> {
    const s = await this.read(code);
    return s ? toSnapshot(s.record, s.version) : null;
  }

  /**
   * Read-modify-write with compare-and-set. `fn` receives the current record
   * and version and returns the next record (or null to delete the pod). On a
   * version race the record is re-read and `fn` re-run, a bounded number of
   * times. `fn` may throw PodError to abort.
   */
  private async mutate<T>(
    code: string,
    fn: (record: PodRecord, version: number) => { record: PodRecord | null; result: T },
  ): Promise<{ snapshot: PodSnapshot | null; result: T }> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(randomInt(1, 4 * attempt)); // jittered backoff on a lost race
      const stored = await this.read(code);
      if (!stored) throw new PodError('not_found', `pod ${code} does not exist`);
      const before = stored.record;
      const { record, result } = fn(structuredClone(before), stored.version);
      if (record === null) {
        // Deletion: only safe if nobody has advanced the version since we read it.
        const ok = await this.cas(code, stored.version, before);
        if (ok === CAS_RESULT.OK) {
          await this.destroy(code, before);
          return { snapshot: null, result };
        }
        continue;
      }
      record.lastActivity = this.now();
      const res = await this.cas(code, stored.version, record);
      if (res === CAS_RESULT.OK) {
        await this.syncIndexes(code, before, record);
        return { snapshot: toSnapshot(record, stored.version + 1), result };
      }
      if (res === CAS_RESULT.MISSING) throw new PodError('not_found', `pod ${code} does not exist`);
    }
    throw new PodError('version_conflict', `pod ${code} was modified concurrently; retry`);
  }

  private async syncIndexes(code: string, before: PodRecord, after: PodRecord): Promise<void> {
    const wasListed = before.pod.visibility === 'public' && before.pod.status === 'lobby';
    const listed = after.pod.visibility === 'public' && after.pod.status === 'lobby';
    if (listed && !wasListed) await this.redis.sAdd(this.publicKey(), code);
    if (!listed && wasListed) await this.redis.sRem(this.publicKey(), code);
    const oldTokens = new Set(before.seats.map((s) => s.token));
    for (const s of after.seats) {
      if (!oldTokens.has(s.token)) {
        await this.redis.set(this.tokenKey(s.token), `${code}:${s.seat}`, { EX: this.ttl });
      }
      oldTokens.delete(s.token);
    }
    for (const gone of oldTokens) await this.redis.del(this.tokenKey(gone));
  }

  private async destroy(code: string, record: PodRecord): Promise<void> {
    await this.redis.del(this.stateKey(code));
    await this.redis.sRem(this.publicKey(), code);
    for (const s of record.seats) await this.redis.del(this.tokenKey(s.token));
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  async create(
    input: { format: Format; visibility: PodVisibility; name: string; bots?: number; botDeck?: string },
    host: Player,
  ): Promise<JoinResult> {
    const token = makeSeatToken();
    const bots = Math.max(0, Math.min(input.bots ?? 0, POD_MAX_SEATS - 1));
    const record: PodRecord = {
      pod: {
        code: '',
        name: input.name,
        format: input.format,
        visibility: input.visibility,
        status: 'lobby',
        hostPlayerId: host.playerId,
        createdAt: this.now(),
      },
      seats: [
        { seat: 0, playerId: host.playerId, name: host.name, ready: false, connected: true, bot: false, token, disconnectedAt: null },
        // Bot seats are ready from the moment they sit down: there is nobody to wait for.
        ...Array.from({ length: bots }, (_, i) => ({
          seat: i + 1,
          playerId: `bot_${i + 1}_${makeSeatToken().slice(0, 12)}`,
          name: BOT_NAMES[i] ?? `Opponent ${i + 1}`,
          ready: true,
          connected: true,
          bot: true,
          botDeck: input.botDeck ?? DEFAULT_BOT_DECK,
          token: makeSeatToken(),
          disconnectedAt: null,
        })),
      ],
      game: null,
      lastActivity: this.now(),
    };
    for (let attempt = 0; attempt < 25; attempt++) {
      const code = generateCode();
      record.pod.code = code;
      // expected -1 never matches an existing version, so an existing key yields VERSION_MISMATCH.
      const res = await this.cas(code, -1, record, true);
      if (res === CAS_RESULT.OK) {
        if (input.visibility === 'public') await this.redis.sAdd(this.publicKey(), code);
        await this.redis.set(this.tokenKey(token), `${code}:0`, { EX: this.ttl });
        return { ...toSnapshot(record, 0), seat: 0, seatToken: token, playerId: host.playerId, reclaimed: false };
      }
    }
    throw new PodError('internal', 'could not allocate a pod code');
  }

  /**
   * Seats a player. With a valid `seatToken` the player reclaims the seat that
   * token was issued for (host status and game seat included), even mid-game.
   */
  async join(code: string, player: Player, seatToken?: string): Promise<JoinResult> {
    const { snapshot, result } = await this.mutate(code, (record) => {
      if (seatToken) {
        const seat = record.seats.find((s) => s.token === seatToken);
        if (seat) {
          seat.connected = true;
          seat.disconnectedAt = null;
          seat.name = player.name;
          return { record, result: { seat: seat.seat, seatToken, playerId: seat.playerId!, reclaimed: true } };
        }
      }
      if (record.seats.some((s) => s.playerId === player.playerId)) {
        throw new PodError('already_in_pod', 'you are already seated in this pod');
      }
      if (record.pod.status !== 'lobby') {
        throw new PodError('illegal_action', 'this pod is no longer accepting players');
      }
      const max = maxSeatsFor(record.pod.format);
      const used = new Set(record.seats.map((s) => s.seat));
      let seatIndex = -1;
      for (let i = 0; i < max; i++) {
        if (!used.has(i)) {
          seatIndex = i;
          break;
        }
      }
      if (seatIndex < 0) throw new PodError('pod_full', `this pod is full (${max} seats)`);
      const token = makeSeatToken();
      record.seats.push({
        seat: seatIndex,
        playerId: player.playerId,
        name: player.name,
        ready: false,
        connected: true,
        bot: false,
        token,
        disconnectedAt: null,
      });
      record.seats.sort((a, b) => a.seat - b.seat);
      if (record.pod.hostPlayerId === null) record.pod.hostPlayerId = player.playerId;
      return { record, result: { seat: seatIndex, seatToken: token, playerId: player.playerId, reclaimed: false } };
    });
    return { ...snapshot!, ...result };
  }

  /** Removes the player's seat, migrating host to the longest-seated player and conceding mid-game. */
  async leave(code: string, playerId: string): Promise<PodSnapshot | null> {
    const { snapshot } = await this.mutate(code, (record) => {
      const seat = record.seats.find((s) => s.playerId === playerId);
      if (!seat) throw new PodError('not_in_pod', 'you are not seated in this pod');
      record.seats = record.seats.filter((s) => s !== seat);
      // A table of nothing but bots is nobody's game: the last person out closes it.
      if (record.seats.every((s) => s.bot)) return { record: null, result: undefined };
      if (record.pod.hostPlayerId === playerId) {
        record.pod.hostPlayerId = record.seats.find((s) => !s.bot)?.playerId ?? null;
      }
      if (record.game && !record.game.finished) {
        const gameSeat = record.game.seats[seat.seat];
        if (gameSeat && !gameSeat.eliminated) {
          record.game = engineApply(
            record.game,
            { type: 'concede', by: seat.seat, seat: seat.seat },
            { isHost: true },
          );
          if (record.game.finished) record.pod.status = 'finished';
        }
      }
      return { record, result: undefined };
    });
    return snapshot;
  }

  /** Flags the seat as disconnected and starts its reclaim grace window. Returns the timestamp used. */
  async markDisconnected(code: string, playerId: string): Promise<{ snapshot: PodSnapshot; at: number } | null> {
    try {
      const { snapshot, result } = await this.mutate(code, (record) => {
        const seat = record.seats.find((s) => s.playerId === playerId);
        if (!seat) throw new PodError('not_in_pod', 'not seated');
        const at = this.now();
        seat.connected = false;
        seat.disconnectedAt = at;
        return { record, result: at };
      });
      return snapshot ? { snapshot, at: result } : null;
    } catch (err) {
      if (err instanceof PodError && (err.code === 'not_found' || err.code === 'not_in_pod')) return null;
      throw err;
    }
  }

  /** Re-marks a seat connected (socket.io connection-state recovery). */
  async markConnected(code: string, playerId: string): Promise<PodSnapshot | null> {
    try {
      const { snapshot } = await this.mutate(code, (record) => {
        const seat = record.seats.find((s) => s.playerId === playerId);
        if (!seat) throw new PodError('not_in_pod', 'not seated');
        seat.connected = true;
        seat.disconnectedAt = null;
        return { record, result: undefined };
      });
      return snapshot;
    } catch (err) {
      if (err instanceof PodError && (err.code === 'not_found' || err.code === 'not_in_pod')) return null;
      throw err;
    }
  }

  /**
   * Called when a grace window expires. Removes the seat only if it is still
   * disconnected from the same disconnect (`at`) — a reclaim resets it.
   * Returns the new snapshot when something changed, null otherwise.
   */
  async reapDisconnected(code: string, playerId: string, at: number): Promise<{ changed: boolean; snapshot: PodSnapshot | null }> {
    try {
      const seatStillDead = await this.read(code).then((s) =>
        s?.record.seats.some((x) => x.playerId === playerId && !x.connected && x.disconnectedAt === at),
      );
      if (!seatStillDead) return { changed: false, snapshot: null };
      const snapshot = await this.leave(code, playerId);
      return { changed: true, snapshot };
    } catch (err) {
      if (err instanceof PodError && (err.code === 'not_found' || err.code === 'not_in_pod')) {
        return { changed: false, snapshot: null };
      }
      throw err;
    }
  }

  /** Sets readiness; when every seated player is ready (and enough are seated) the table is dealt. */
  async ready(code: string, playerId: string, ready: boolean): Promise<PodSnapshot> {
    const { snapshot } = await this.mutate(code, (record) => {
      const seat = record.seats.find((s) => s.playerId === playerId);
      if (!seat) throw new PodError('not_in_pod', 'you are not seated in this pod');
      if (record.pod.status !== 'lobby') throw new PodError('illegal_action', 'the game has already started');
      seat.ready = ready;
      const min = FORMATS[toEngineFormat(record.pod.format)].minPlayers;
      if (record.seats.length >= min && record.seats.every((s) => s.ready)) {
        dealTable(record);
      }
      return { record, result: undefined };
    });
    return snapshot!;
  }

  /**
   * Applies a rules-engine action. `expectedVersion` is the pod version the
   * client last saw; a mismatch is reported as version_conflict without
   * touching the pod. The CAS in `mutate` additionally guards the write itself.
   */
  async applyAction(code: string, playerId: string, action: unknown, expectedVersion: number): Promise<PodSnapshot> {
    const { snapshot } = await this.mutate(code, (record, version) => {
      if (version !== expectedVersion) {
        throw new PodError('version_conflict', `expected version ${expectedVersion} but pod is at ${version}`);
      }
      const seat = record.seats.find((s) => s.playerId === playerId);
      if (!seat) throw new PodError('not_in_pod', 'you are not seated in this pod');
      if (typeof action !== 'object' || action === null || typeof (action as { type?: unknown }).type !== 'string') {
        throw new PodError('illegal_action', 'action must be an object with a type');
      }
      const isHost = record.pod.hostPlayerId === playerId;
      if (record.game === null) {
        // The host may deal the table early from the lobby with game:start.
        if ((action as Action).type !== 'game:start') {
          throw new PodError('illegal_action', 'the game has not been dealt yet; ready up first');
        }
        if (!isHost) throw new PodError('not_host', 'only the host can start the game');
        const min = FORMATS[toEngineFormat(record.pod.format)].minPlayers;
        if (record.seats.length < min) throw new PodError('illegal_action', `need at least ${min} players to start`);
        dealTable(record);
      }
      // Seat index may have been compacted when the table was dealt; re-resolve.
      const mySeat = record.seats.find((s) => s.playerId === playerId)!.seat;
      const stamped = { ...(action as Action), by: mySeat } as Action;
      try {
        record.game = engineApply(record.game!, stamped, { isHost });
      } catch (err) {
        if (err instanceof EngineError) throw new PodError('illegal_action', `${err.code}: ${err.message}`);
        throw err;
      }
      runBots(record);
      if (record.game.finished) record.pod.status = 'finished';
      else if (record.pod.status === 'finished') record.pod.status = 'in_progress';
      return { record, result: undefined };
    });
    return snapshot!;
  }

  async listPublic(format?: Format): Promise<PodListEntry[]> {
    const codes = await this.redis.sMembers(this.publicKey());
    const out: PodListEntry[] = [];
    for (const code of codes) {
      const stored = await this.read(code);
      const listed = stored && stored.record.pod.visibility === 'public' && stored.record.pod.status === 'lobby';
      if (!listed) {
        await this.redis.sRem(this.publicKey(), code);
        continue;
      }
      const { pod, seats } = stored.record;
      if (format && pod.format !== format) continue;
      out.push({ code, name: pod.name, format: pod.format, status: pod.status, seatCount: seats.length });
    }
    out.sort((a, b) => a.code.localeCompare(b.code));
    return out.slice(0, 100);
  }
}

/** Names for the seats the server plays. Plain and obviously not a person. */
const BOT_NAMES = ['Opponent', 'Opponent II', 'Opponent III'];
const DEFAULT_BOT_DECK = 'verdant-guard';

/**
 * Lets the server's seats take their turns until a person is on the clock again.
 *
 * Run inside the same mutation as the action that provoked it, so a bot's whole reply lands in
 * one pod version and one broadcast. Doing it as a separate write would show the player their own
 * move, then a gap, then the answer — and would race another node applying the next human action
 * against a state the bot had not finished moving in.
 *
 * The bot decides with `botAction`, which only ever returns a move the engine offered it, so a
 * refusal here would mean the two disagree. It is caught rather than thrown anyway: a bot that
 * cannot find a move should stall its own seat, not fail the human's action.
 */
function runBots(record: PodRecord, log?: (err: unknown) => void): void {
  const botSeats = new Set(record.seats.filter((s) => s.bot).map((s) => s.seat));
  if (botSeats.size === 0) return;
  for (let guard = 0; guard < 500; guard += 1) {
    const game = record.game;
    if (game === null || game.finished) return;
    // Any seat the engine is waiting on, not just the first: opening hands are settled
    // simultaneously, so a bot whose human opponent is still deciding is behind them in the queue
    // and would never be reached.
    const seat = seatsToAct(game).find((s) => botSeats.has(s));
    if (seat === undefined) return;
    const action = botAction(game, seat);
    if (action === null) return;
    try {
      const next = engineApply(game, action, { isHost: false });
      // No progress means a move the engine accepted but that changed nothing, which would spin.
      if (next.stateVersion === game.stateVersion) return;
      record.game = next;
    } catch (err) {
      log?.(err);
      return;
    }
  }
}

/** Gives every bot seat a deck, so a solo table needs no second person to pick one. */
function loadBotDecks(record: PodRecord): void {
  for (const seat of record.seats) {
    if (!seat.bot || record.game === null) continue;
    try {
      record.game = engineApply(
        record.game,
        { type: 'deck:load', by: seat.seat, seat: seat.seat, deckId: seat.botDeck ?? DEFAULT_BOT_DECK },
        { isHost: true },
      );
    } catch {
      // An unknown deck id leaves the seat empty rather than stopping the table being dealt.
    }
  }
}

/** Compacts seat indices to 0..n-1 and creates the rules-engine game. */
function dealTable(record: PodRecord): void {
  record.seats.sort((a, b) => a.seat - b.seat);
  record.seats.forEach((s, i) => {
    s.seat = i;
  });
  record.game = createGame({
    id: `${record.pod.code}:${record.pod.createdAt}`,
    format: toEngineFormat(record.pod.format),
    players: record.seats.map((s) => ({ playerId: s.playerId ?? `seat-${s.seat}`, name: s.name })),
  });
  record.pod.status = 'in_progress';
  loadBotDecks(record);
}
