import { z } from "zod";
import { Format } from "../contracts/cards.js";
import { Id } from "../contracts/common.js";

/** Payload caps, in bytes of UTF-8. Enforced by the socket gateway before parsing. */
export const CHAT_MAX_BYTES = 500;
export const ACTION_MAX_BYTES = 2 * 1024;
/**
 * The largest redacted game state the gateway will broadcast.
 *
 * Derived rather than picked. The rules engine refuses to hold more than `MAX_INSTANCES` (600)
 * cards on one table, and a packed card costs about a hundred bytes — so a table at the engine's
 * own hard limit produces roughly 100KB of state once the log, the card definitions, the zone
 * lists and a large combat are counted. 128KB is larger than that, which is the property a safety
 * cap should have: **a legal game cannot reach it**, so what trips it is a bug rather than a
 * Commander board.
 *
 * It was 64KB, set when the Play Realm was two players and a view peaked at 22KB. A four-player
 * pod with 259 permanents measured 68KB, and that is an ordinary long game of Commander, not a
 * pathological one — the cap was refusing to send a state the engine was right to build. This is
 * our own check and nothing else: Socket.IO's `maxHttpBufferSize` governs what the server will
 * *receive*, which is what `ACTION_MAX_BYTES` is for.
 */
export const STATE_MAX_BYTES = 128 * 1024;

export const POD_NAME_MAX = 32;
export const POD_MAX_SEATS = 4;

/** Pod join codes look like `BRAVE-OTTER-42`. */
export const POD_CODE_REGEX = /^[A-Z]{3,12}-[A-Z]{3,12}-\d{2}$/;
export const PodCode = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(POD_CODE_REGEX, "Pod code must look like WORD-WORD-NN"));
export type PodCode = z.infer<typeof PodCode>;

export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

const maxBytes = (max: number, label: string) =>
  [(s: string) => byteLength(s) <= max, { message: `${label} exceeds ${max} bytes` }] as const;

export const PodVisibility = z.enum(["public", "private"]);
export type PodVisibility = z.infer<typeof PodVisibility>;

export const PodStatus = z.enum(["lobby", "in_progress", "finished"]);
export type PodStatus = z.infer<typeof PodStatus>;

export const PlayerName = z.string().trim().min(1).max(POD_NAME_MAX);

export const PodSeat = z.object({
  seat: z.number().int().min(0).max(POD_MAX_SEATS - 1),
  playerId: Id.nullable(),
  name: PlayerName,
  ready: z.boolean().default(false),
  connected: z.boolean().default(true),
  /** A seat the server plays. Shown to everyone, because knowing who is a bot is not a secret. */
  bot: z.boolean().default(false),
});
export type PodSeat = z.infer<typeof PodSeat>;

export const Pod = z.object({
  code: PodCode,
  name: z.string().max(POD_NAME_MAX),
  format: Format,
  visibility: PodVisibility,
  status: PodStatus,
  hostPlayerId: Id.nullable(),
  seats: z.array(PodSeat).max(POD_MAX_SEATS),
  createdAt: z.number().int(),
  /**
   * Whether the table is holding a move that could be taken back (see `pod:undo`).
   *
   * On the pod rather than inferred by the client, because the client cannot know: the server
   * records a step for the bots' replies as well as for people, and the host — who is the only one
   * who may press it — is often not the player who moved. Optional so a client built against the
   * older shape still parses a state from a newer server.
   */
  undoable: z.boolean().optional(),
});
export type Pod = z.infer<typeof Pod>;

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export const PodCreateInput = z.object({
  format: Format.default("commander"),
  visibility: PodVisibility.default("private"),
  /** The table's name, not the player's. */
  name: z.string().trim().min(1).max(POD_NAME_MAX),
  /**
   * Who is sitting down. Optional for compatibility; without it the host's seat is named from the
   * handshake, which is whatever the client knew when it opened the socket — so a player who typed
   * a name and then made a table was seated under their previous one. `pod:join` has always carried
   * the player's name; this is the same thing for the host.
   */
  playerName: PlayerName.optional(),
  /**
   * Seats for the server to play, so one person can start a table and play immediately rather
   * than waiting for somebody to join. Capped well below the seat limit: a table of four bots is
   * a demo, not a game.
   */
  bots: z.number().int().min(0).max(POD_MAX_SEATS - 1).default(0),
  /** Which built-in deck each bot plays. Defaults to one the rules engine ships. */
  botDeck: z.string().trim().min(1).max(64).optional(),
  /**
   * A deck per bot, in seat order, for a table where they should not all play the same one.
   *
   * A pod of three identical decks is one game played three times, which is the opposite of what
   * a Commander table is for. `botDeck` still covers the single-opponent case.
   */
  botDecks: z.array(z.string().trim().min(1).max(64)).max(POD_MAX_SEATS - 1).optional(),
});
export type PodCreateInput = z.infer<typeof PodCreateInput>;

export const PodJoinInput = z.object({
  code: PodCode,
  name: PlayerName,
  /** Reconnect token issued on first join; lets a dropped socket reclaim its seat. */
  seatToken: z.string().min(16).max(128).optional(),
});
export type PodJoinInput = z.infer<typeof PodJoinInput>;

/**
 * Watching a table without taking a seat.
 *
 * No seat token: a watcher is not a player, holds nothing and is owed nothing. The only thing it
 * *needs* is the code, and the only thing it gets back is the spectator view — which the server
 * has been able to build since redaction went in, and nothing could ask for.
 *
 * The name is optional and is not about the view. A watcher has been able to **talk** in the
 * table's chat since the day watching was built — `pod:chat` asks only that the socket is in a pod
 * — and with no name the server fell back to "Player", so every spectator's line arrived looking
 * exactly like one of the two people playing. At a table where chat is how somebody says "I'm
 * responding to that", that is a line you can act on wrongly. Sending the name the lobby already
 * has asks nothing new of anybody and lets the table say who is talking.
 */
export const PodWatchInput = z.object({ code: PodCode, name: PlayerName.optional() });
export type PodWatchInput = z.infer<typeof PodWatchInput>;

export const PodLeaveInput = z.object({}).strict();
export type PodLeaveInput = z.infer<typeof PodLeaveInput>;

export const PodReadyInput = z.object({ ready: z.boolean() });
export type PodReadyInput = z.infer<typeof PodReadyInput>;

export const PodChatInput = z.object({
  text: z.string().trim().min(1).max(CHAT_MAX_BYTES).refine(...maxBytes(CHAT_MAX_BYTES, "chat text")),
});
export type PodChatInput = z.infer<typeof PodChatInput>;

/**
 * Game actions are opaque to the gateway; the rules engine validates `action`.
 * `expectedVersion` drives optimistic concurrency against the Redis CAS script.
 */
export const PodActionInput = z
  .object({
    action: z.unknown(),
    expectedVersion: z.number().int().min(0),
  })
  .refine((v) => byteLength(JSON.stringify(v.action ?? null)) <= ACTION_MAX_BYTES, {
    message: `action exceeds ${ACTION_MAX_BYTES} bytes`,
    path: ["action"],
  });
export type PodActionInput = z.infer<typeof PodActionInput>;

/**
 * Taking back the last thing that happened at the table.
 *
 * No payload at all: the server knows which table this socket is at and holds exactly one step of
 * history, so there is nothing for the client to name — and nothing it could name that would let
 * it reach further back than one action.
 */
export const PodUndoInput = z.object({}).strict();
export type PodUndoInput = z.infer<typeof PodUndoInput>;

export const PodListInput = z.object({ format: Format.optional() }).default({});
export type PodListInput = z.infer<typeof PodListInput>;

export const ClientEvents = {
  "pod:create": PodCreateInput,
  "pod:join": PodJoinInput,
  "pod:watch": PodWatchInput,
  "pod:leave": PodLeaveInput,
  "pod:ready": PodReadyInput,
  "pod:chat": PodChatInput,
  "pod:action": PodActionInput,
  "pod:undo": PodUndoInput,
  "pod:list": PodListInput,
} as const;
export type ClientEventName = keyof typeof ClientEvents;
export type ClientEventPayload<E extends ClientEventName> = z.infer<(typeof ClientEvents)[E]>;

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export const PodStateEvent = z
  .object({
    pod: Pod,
    /** Rules-engine state; opaque here. */
    state: z.unknown(),
    stateVersion: z.number().int().min(0),
  })
  .refine((v) => byteLength(JSON.stringify(v.state ?? null)) <= STATE_MAX_BYTES, {
    message: `state exceeds ${STATE_MAX_BYTES} bytes`,
    path: ["state"],
  });
export type PodStateEvent = z.infer<typeof PodStateEvent>;

export const PodErrorCode = z.enum([
  "bad_payload",
  "not_found",
  "pod_full",
  "not_in_pod",
  "already_in_pod",
  "not_host",
  "version_conflict",
  "illegal_action",
  /**
   * The game has a winner, so nothing is legal any more.
   *
   * Its own code rather than an `illegal_action` because it is not one: the action was fine, the
   * game ended under it. A client that sent the last pass of a game and the pass queued behind it
   * gets this for the second, and the right thing to do with it is nothing — the game-over panel
   * has already said what happened.
   */
  "game_finished",
  /**
   * There is nothing to take back.
   *
   * One step of history is kept, and only for actions that changed the game — so this is the
   * answer at the start of a game, and the answer to a second press of Undo. Its own code because
   * the table hides the button on it rather than showing the player an error.
   */
  "nothing_to_undo",
  "rate_limited",
  "internal",
]);
export type PodErrorCode = z.infer<typeof PodErrorCode>;

export const PodErrorEvent = z.object({
  code: PodErrorCode,
  message: z.string().max(500),
  /**
   * The pod's version when the refusal happened, for the refusals that depend on it.
   *
   * Without it a client cannot tell "the table moved under you" from "the table and the engine
   * disagree". Both arrive as `illegal_action`; the first is nobody's fault and must not be shown,
   * the second is a bug and must be. The client's own last-seen version is not enough to tell
   * them apart — it may be behind the server's, which is exactly the case this exists for.
   */
  stateVersion: z.number().int().min(0).optional(),
});
export type PodErrorEvent = z.infer<typeof PodErrorEvent>;

export const PodChatEvent = z.object({
  id: z.string(),
  seat: z.number().int().min(0).max(POD_MAX_SEATS - 1).nullable(),
  name: PlayerName,
  text: z.string().max(CHAT_MAX_BYTES),
  at: z.number().int(),
});
export type PodChatEvent = z.infer<typeof PodChatEvent>;

export const PodListEntry = Pod.pick({ code: true, name: true, format: true, status: true }).extend({
  seatCount: z.number().int().min(0).max(POD_MAX_SEATS),
});
export type PodListEntry = z.infer<typeof PodListEntry>;

export const PodListEvent = z.object({ pods: z.array(PodListEntry).max(100) });
export type PodListEvent = z.infer<typeof PodListEvent>;

export const ServerEvents = {
  "pod:state": PodStateEvent,
  "pod:error": PodErrorEvent,
  "pod:chat": PodChatEvent,
  "pod:list": PodListEvent,
} as const;
export type ServerEventName = keyof typeof ServerEvents;
export type ServerEventPayload<E extends ServerEventName> = z.infer<(typeof ServerEvents)[E]>;

/** socket.io typed-event maps. */
export type ClientToServerEvents = { [E in ClientEventName]: (payload: ClientEventPayload<E>) => void };
export type ServerToClientEvents = { [E in ServerEventName]: (payload: ServerEventPayload<E>) => void };
