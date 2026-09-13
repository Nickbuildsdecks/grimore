import { z } from "zod";
import { Format } from "../contracts/cards.js";
import { Id } from "../contracts/common.js";

/** Payload caps, in bytes of UTF-8. Enforced by the socket gateway before parsing. */
export const CHAT_MAX_BYTES = 500;
export const ACTION_MAX_BYTES = 2 * 1024;
export const STATE_MAX_BYTES = 64 * 1024;

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
});
export type Pod = z.infer<typeof Pod>;

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export const PodCreateInput = z.object({
  format: Format.default("commander"),
  visibility: PodVisibility.default("private"),
  name: z.string().trim().min(1).max(POD_NAME_MAX),
});
export type PodCreateInput = z.infer<typeof PodCreateInput>;

export const PodJoinInput = z.object({
  code: PodCode,
  name: PlayerName,
  /** Reconnect token issued on first join; lets a dropped socket reclaim its seat. */
  seatToken: z.string().min(16).max(128).optional(),
});
export type PodJoinInput = z.infer<typeof PodJoinInput>;

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

export const PodListInput = z.object({ format: Format.optional() }).default({});
export type PodListInput = z.infer<typeof PodListInput>;

export const ClientEvents = {
  "pod:create": PodCreateInput,
  "pod:join": PodJoinInput,
  "pod:leave": PodLeaveInput,
  "pod:ready": PodReadyInput,
  "pod:chat": PodChatInput,
  "pod:action": PodActionInput,
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
  "rate_limited",
  "internal",
]);
export type PodErrorCode = z.infer<typeof PodErrorCode>;

export const PodErrorEvent = z.object({
  code: PodErrorCode,
  message: z.string().max(500),
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
