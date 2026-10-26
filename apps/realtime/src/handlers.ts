/**
 * Socket event wiring. Every inbound payload is size-capped, rate-limited and
 * validated with the shared Zod schemas before it reaches the PodStore.
 * Failures are reported as `pod:error` (and via the optional ack); every
 * successful mutation broadcasts `pod:state` to the pod's room.
 */
import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  ACTION_MAX_BYTES,
  byteLength,
  CHAT_MAX_BYTES,
  ClientEvents,
  type ClientEventName,
  PlayerName,
  type PodErrorEvent,
  type ServerToClientEvents,
} from '@grimore/shared';
import { makePlayerId, PodError, toSeatSnapshot, type PodSnapshot, type PodStore } from './pod.js';
import { TokenBucket, type RateLimitOptions, DEFAULT_RATE_LIMIT } from './ratelimit.js';

export type AckResult =
  | { ok: true; code?: string; seat?: number; seatToken?: string; playerId?: string; stateVersion?: number }
  | { ok: false; error: PodErrorEvent };
export type Ack = (result: AckResult) => void;

/** Inbound payloads are `unknown` until validated; every event accepts an optional ack. */
export type ClientToServer = { [E in ClientEventName]: (payload: unknown, ack?: Ack) => void };
export type SocketData = {
  playerId: string;
  name?: string;
  podCode?: string;
  seat?: number;
  seatToken?: string;
};
export type RealtimeServer = Server<ClientToServer, ServerToClientEvents, Record<never, never>, SocketData>;
export type RealtimeSocket = Socket<ClientToServer, ServerToClientEvents, Record<never, never>, SocketData>;

export const podRoom = (code: string): string => `pod:${code}`;

/** Raw (pre-parse) byte caps per event, slightly above the schema caps to allow JSON framing. */
const RAW_CAPS: Record<ClientEventName, number> = {
  'pod:create': 512,
  'pod:join': 512,
  'pod:watch': 128,
  'pod:leave': 64,
  'pod:ready': 64,
  'pod:chat': CHAT_MAX_BYTES + 64,
  'pod:action': ACTION_MAX_BYTES + 128,
  'pod:undo': 64,
  'pod:list': 128,
};

export interface HandlerOptions {
  rateLimit?: RateLimitOptions;
}

/** Returns a dispose function that clears pending grace timers. */
export function registerHandlers(io: RealtimeServer, store: PodStore, log: Logger, opts: HandlerOptions = {}): () => void {
  const graceTimers = new Set<NodeJS.Timeout>();
  const rateOpts = opts.rateLimit ?? DEFAULT_RATE_LIMIT;

  /**
   * Sends every socket in the pod the state *as its own seat may see it*, never the raw game state.
   *
   * One payload per socket rather than one per room: `dealTable` compacts seat indices when the
   * table is dealt, so a seat-numbered room joined at sit-down time can be the wrong room by the
   * time the game starts. Resolving each socket's seat from the authoritative snapshot by playerId
   * cannot go stale that way. A socket with no seat (a watcher) gets the spectator view.
   */
  const broadcast = async (code: string, snapshot: PodSnapshot | null): Promise<void> => {
    if (!snapshot) return;
    const sockets = await io.in(podRoom(code)).fetchSockets();
    for (const member of sockets) {
      const seat = snapshot.pod.seats.find((s) => s.playerId === member.data.playerId)?.seat ?? null;
      member.emit('pod:state', toSeatSnapshot(snapshot, seat));
    }
  };

  const fail = (
    socket: RealtimeSocket, ack: Ack | undefined, code: PodErrorEvent['code'], message: string,
    stateVersion?: number,
  ): void => {
    const error: PodErrorEvent = {
      code, message: message.slice(0, 500),
      ...(stateVersion === undefined ? {} : { stateVersion }),
    };
    socket.emit('pod:error', error);
    if (typeof ack === 'function') ack({ ok: false, error });
  };

  const reportError = (socket: RealtimeSocket, ack: Ack | undefined, event: string, err: unknown): void => {
    if (err instanceof PodError) return fail(socket, ack, err.code, err.message, err.stateVersion);
    if (err instanceof z.ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ');
      return fail(socket, ack, 'bad_payload', msg);
    }
    log.error({ err, event, socketId: socket.id }, 'unhandled realtime error');
    fail(socket, ack, 'internal', 'internal error');
  };

  io.on('connection', (socket) => {
    const bucket = new TokenBucket(rateOpts);
    if (!socket.data.playerId) socket.data.playerId = makePlayerId();
    if (!socket.data.name) {
      // Player display name for pod:create comes from handshake auth ({ auth: { name } }).
      const authName = PlayerName.safeParse((socket.handshake.auth as Record<string, unknown> | undefined)?.['name']);
      socket.data.name = authName.success ? authName.data : 'Host';
    }
    log.debug({ socketId: socket.id, recovered: socket.recovered }, 'socket connected');

    // connectionStateRecovery restored socket.data and rooms: flip the seat back to connected.
    if (socket.recovered && socket.data.podCode) {
      void store
        .markConnected(socket.data.podCode, socket.data.playerId)
        .then((snap) => broadcast(socket.data.podCode!, snap))
        .catch((err) => log.warn({ err }, 'recovery reconnect failed'));
    }

    /**
     * Wraps a handler with rate limiting, raw size cap and schema validation.
     * `ack` is optional: browsers may call with or without one.
     */
    // Every client event shares one (payload, ack?) shape; bypass socket.io's per-event generic here.
    const rawOn = socket.on.bind(socket) as unknown as (
      event: ClientEventName,
      listener: (raw: unknown, maybeAck?: unknown) => void,
    ) => void;
    const on = <E extends ClientEventName>(
      event: E,
      handler: (payload: z.infer<(typeof ClientEvents)[E]>, ack: Ack | undefined) => Promise<void>,
    ): void => {
      rawOn(event, (raw: unknown, maybeAck?: unknown) => {
        const ack = typeof maybeAck === 'function' ? (maybeAck as Ack) : undefined;
        if (!bucket.take()) return fail(socket, ack, 'rate_limited', 'too many events; slow down');
        try {
          const rawBytes = raw === undefined ? 0 : byteLength(JSON.stringify(raw) ?? '');
          if (rawBytes > RAW_CAPS[event]) {
            return fail(socket, ack, 'bad_payload', `${event} payload exceeds ${RAW_CAPS[event]} bytes`);
          }
          const schema: z.ZodTypeAny = ClientEvents[event];
          const payload = schema.parse(raw ?? {}) as z.infer<(typeof ClientEvents)[E]>;
          handler(payload, ack).catch((err) => reportError(socket, ack, event, err));
        } catch (err) {
          reportError(socket, ack, event, err);
        }
      });
    };

    const requireSeat = (): { code: string; playerId: string } => {
      if (!socket.data.podCode) throw new PodError('not_in_pod', 'you are not in a pod');
      return { code: socket.data.podCode, playerId: socket.data.playerId };
    };

    const seatSocket = (r: { pod: { code: string }; seat: number; seatToken: string; playerId: string }): void => {
      socket.data.podCode = r.pod.code;
      socket.data.seat = r.seat;
      socket.data.seatToken = r.seatToken;
      socket.data.playerId = r.playerId;
      void socket.join(podRoom(r.pod.code));
    };

    on('pod:create', async (input, ack) => {
      if (socket.data.podCode) throw new PodError('already_in_pod', 'leave your current pod first');
      // The create payload may name the player; the handshake name is only a fallback for a client
      // that does not send one.
      if (input.playerName) socket.data.name = input.playerName;
      const result = await store.create(input, { playerId: socket.data.playerId, name: socket.data.name ?? 'Host' });
      seatSocket(result);
      ack?.({ ok: true, code: result.pod.code, seat: 0, seatToken: result.seatToken, playerId: result.playerId, stateVersion: result.stateVersion });
      await broadcast(result.pod.code, result);
      log.info({ code: result.pod.code, playerId: result.playerId }, 'pod created');
    });

    on('pod:join', async (input, ack) => {
      if (socket.data.podCode && socket.data.podCode !== input.code) {
        throw new PodError('already_in_pod', 'leave your current pod first');
      }
      const result = await store.join(input.code, { playerId: socket.data.playerId, name: input.name }, input.seatToken);
      socket.data.name = input.name;
      seatSocket(result);
      ack?.({ ok: true, code: input.code, seat: result.seat, seatToken: result.seatToken, playerId: result.playerId, stateVersion: result.stateVersion });
      await broadcast(input.code, result);
      log.info({ code: input.code, seat: result.seat, reclaimed: result.reclaimed }, 'player joined');
    });

    /*
      Watching: in the room, out of the game.

      No seat, so `broadcast` sends this socket the spectator view — both hands hidden, no legal
      moves — and every handler that calls `requireSeat` refuses it, which is every handler that
      changes anything. The pod's status is not checked: a watcher arriving mid-game is the usual
      case, and a table that only admitted watchers in the lobby would be useless for the thing
      people actually want to watch.
    */
    on('pod:watch', async (input, ack) => {
      if (socket.data.podCode && socket.data.podCode !== input.code) {
        throw new PodError('already_in_pod', 'leave your current pod first');
      }
      if (socket.data.seat !== undefined) {
        throw new PodError('already_in_pod', 'you are seated at this table; leave your seat to watch');
      }
      const snapshot = await store.get(input.code);
      if (!snapshot) throw new PodError('not_found', 'no table with that code');
      socket.data.podCode = input.code;
      // Kept for the chat and for nothing else: a watcher with no name talked as "Player", which
      // is what one of the two people playing is called. See `pod:chat`.
      if (input.name !== undefined) socket.data.name = input.name;
      void socket.join(podRoom(input.code));
      ack?.({ ok: true, code: input.code, stateVersion: snapshot.stateVersion });
      // Only this socket needs the state: nobody at the table has to be told somebody is watching,
      // and a broadcast would be one view per seat for no reason.
      socket.emit('pod:state', toSeatSnapshot(snapshot, null));
      log.info({ code: input.code, playerId: socket.data.playerId }, 'watcher joined');
    });

    const leavePod = async (): Promise<void> => {
      const { code, playerId } = requireSeat();
      socket.data.podCode = undefined;
      socket.data.seat = undefined;
      socket.data.seatToken = undefined;
      await socket.leave(podRoom(code));
      const snap = await store.leave(code, playerId);
      await broadcast(code, snap);
    };

    on('pod:leave', async (_input, ack) => {
      await leavePod();
      ack?.({ ok: true });
    });

    on('pod:ready', async (input, ack) => {
      const { code, playerId } = requireSeat();
      const snap = await store.ready(code, playerId, input.ready);
      ack?.({ ok: true, stateVersion: snap.stateVersion });
      await broadcast(code, snap);
    });

    on('pod:action', async (input, ack) => {
      const { code, playerId } = requireSeat();
      const snap = await store.applyAction(code, playerId, input.action, input.expectedVersion);
      ack?.({ ok: true, stateVersion: snap.stateVersion });
      await broadcast(code, snap);
    });

    /*
      Taking back the last thing that happened at the table.

      The host's call and nobody else's: it is the one affordance here that rewrites what has
      already happened, and in a hidden-information game that is not a power to hand round. The
      store holds exactly one step, so there is nothing to say in the payload — and `nothing_to_undo`
      comes back when there is nothing there, which the table reads as "hide the button" rather
      than as an error worth showing anybody.

      Announced in the table's chat rather than written into the game's log, because the log is the
      engine's and the restored state carries the log it had — the undone move's own line is gone
      from it, which is correct, since it did not happen. What everybody at the table does need to
      see is that somebody took something back, and that is a message, not a rule.
    */
    on('pod:undo', async (_input, ack) => {
      const { code, playerId } = requireSeat();
      const snap = await store.undo(code, playerId);
      ack?.({ ok: true, stateVersion: snap.stateVersion });
      io.to(podRoom(code)).emit('pod:chat', {
        id: randomUUID(),
        seat: null,
        name: 'Table',
        text: `${socket.data.name ?? 'The host'} took back the last move.`,
        at: Date.now(),
      });
      await broadcast(code, snap);
    });

    /*
      Table talk, and the one thing the server has to say about it that the client cannot.

      A watcher may talk — `requireSeat` asks only that the socket is *in* a pod, and it has been
      that way since watching was built. What it may not do is look like a player: with no seat and
      no name the line used to read "Player", which is exactly what somebody at the table is
      called, and a spectator's "I'm responding to that" acted on as an opponent's is a wrong move
      made in good faith.

      So `watching` is set here from the socket's own seat rather than inferred downstream from
      `seat === null`. The client's idea of who is a spectator is not the guarantee; this is — the
      same rule the privacy default in D132 follows.
    */
    on('pod:chat', async (input, ack) => {
      const { code } = requireSeat();
      const watching = socket.data.seat === undefined;
      io.to(podRoom(code)).emit('pod:chat', {
        id: randomUUID(),
        seat: socket.data.seat ?? null,
        name: socket.data.name ?? (watching ? 'Watcher' : 'Player'),
        text: input.text,
        at: Date.now(),
        ...(watching ? { watching: true } : {}),
      });
      ack?.({ ok: true });
    });

    on('pod:list', async (input, ack) => {
      const pods = await store.listPublic(input.format);
      socket.emit('pod:list', { pods });
      ack?.({ ok: true });
    });

    socket.on('disconnect', (reason) => {
      const code = socket.data.podCode;
      const playerId = socket.data.playerId;
      if (!code) return;
      log.debug({ socketId: socket.id, code, reason }, 'seated socket disconnected');
      void store
        .markDisconnected(code, playerId)
        .then((res) => {
          if (!res) return;
          void broadcast(code, res.snapshot);
          const timer = setTimeout(() => {
            graceTimers.delete(timer);
            void store
              .reapDisconnected(code, playerId, res.at)
              .then((r) => {
                if (r.changed) {
                  void broadcast(code, r.snapshot);
                  log.info({ code, playerId }, 'seat reaped after grace window');
                }
              })
              .catch((err) => log.warn({ err, code }, 'reap failed'));
          }, store.graceMs);
          timer.unref();
          graceTimers.add(timer);
        })
        .catch((err) => log.warn({ err, code }, 'disconnect bookkeeping failed'));
    });
  });

  return () => {
    for (const t of graceTimers) clearTimeout(t);
    graceTimers.clear();
  };
}
