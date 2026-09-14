import { z } from "zod";
import { Username } from "./auth.js";
import { Id, IntBool, Timestamp } from "./common.js";

export const MESSAGE_SUBJECT_MAX = 120;
export const MESSAGE_BODY_MAX = 5000;
export const NOTIFICATION_PAGE_DEFAULT = 10;

export const FriendStatus = z.enum(["pending", "accepted", "declined"]);
export type FriendStatus = z.infer<typeof FriendStatus>;

/** GET /api/friends — one accepted friend, resolved to "the other person" from the caller's side. */
export const Friend = z.object({
  friend_id: Id,
  friend_name: z.string(),
  friend_username: z.string(),
  friend_avatar: z.string().nullable().default(null),
  friends_since: Timestamp,
});
export type Friend = z.infer<typeof Friend>;

/** GET /api/friends/requests — a pending request addressed to the caller. */
export const FriendRequest = z.object({
  id: Id,
  sender_id: Id,
  sender_name: z.string(),
  sender_username: z.string(),
  sender_avatar: z.string().nullable().default(null),
  created_at: Timestamp,
});
export type FriendRequest = z.infer<typeof FriendRequest>;

/** GET /api/friends/status/:playerId */
export const FriendshipState = z.object({
  status: z.union([FriendStatus, z.literal("none")]),
  isSender: z.boolean().default(false),
  requestId: Id.nullable().default(null),
});
export type FriendshipState = z.infer<typeof FriendshipState>;

/** A row of the `messages` table with the counterpart's display fields joined in. */
export const DirectMessage = z.object({
  id: Id,
  sender_id: Id.nullable().default(null),
  recipient_id: Id.nullable().default(null),
  subject: z.string(),
  body: z.string(),
  is_read: IntBool.default(false),
  created_at: Timestamp,
  counterpart_id: Id.nullable().default(null),
  counterpart_name: z.string().nullable().default(null),
  counterpart_username: z.string().nullable().default(null),
});
export type DirectMessage = z.infer<typeof DirectMessage>;

/** POST /api/messages/send — legacy body keys kept so the existing UI keeps working. */
export const SendMessageInput = z.object({
  recipientUsername: Username,
  subject: z.string().trim().max(MESSAGE_SUBJECT_MAX).optional(),
  body: z.string().trim().min(1).max(MESSAGE_BODY_MAX),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** POST /api/messages/feedback */
export const FeedbackInput = z.object({
  body: z.string().trim().min(1).max(MESSAGE_BODY_MAX),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

export const NotificationType = z
  .enum(["general", "message", "feedback", "friend_request", "friend_accepted", "follow"])
  .catch("general");
export type NotificationType = z.infer<typeof NotificationType>;

/** `notifications.id` is the integer serial from the schema; legacy tried to insert text ids. */
export const Notification = z.object({
  id: z.coerce.number().int(),
  player_id: Id,
  type: NotificationType,
  title: z.string(),
  message: z.string(),
  link_url: z.string().nullable().default(null),
  is_read: IntBool.default(false),
  created_at: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

/** POST /api/notifications/read — one id, or `all` to clear the bell. */
export const MarkNotificationReadInput = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.id !== undefined || v.all === true, { message: "Provide an id, or all: true" });
export type MarkNotificationReadInput = z.infer<typeof MarkNotificationReadInput>;

export const NotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(NOTIFICATION_PAGE_DEFAULT),
  unreadOnly: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;
