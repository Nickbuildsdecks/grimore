import { z } from "zod";

/** Legacy ids are opaque text (e.g. `p_<ts>_<rand>`, `col_...`, moxfield deck ids). */
export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

/** Numeric ids used by a few baseline tables (collections.id, deck_cards.id). */
export const NumericId = z.coerce.number().int().positive();
export type NumericId = z.infer<typeof NumericId>;

/** Legacy stores booleans as 0/1 integers; accept both and normalize to boolean. */
export const IntBool = z
  .union([z.boolean(), z.number(), z.string()])
  .transform((v) => v === true || v === 1 || v === "1" || v === "true");
export type IntBool = z.infer<typeof IntBool>;

/** Timestamps arrive as ISO strings (pg `timestamp without time zone` serialized). */
export const Timestamp = z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v));
export type Timestamp = z.infer<typeof Timestamp>;

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type Pagination = z.infer<typeof Pagination>;

export const PageMeta = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type PageMeta = z.infer<typeof PageMeta>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), meta: PageMeta });
export type Paginated<T> = { items: T[]; meta: PageMeta };

/**
 * Every error code `apps/api` can emit, and the only ones it may.
 *
 * This replaces a nine-value snake_case enum (`bad_request`, `validation_error`, ...) that nothing
 * ever imported. `apps/api` had always emitted its own uppercase codes with `ApiError.code` typed
 * as a bare `string`, and `apps/web` had its own error class taking a loose string, so the two ends
 * agreed with each other and neither agreed with the contract. Nothing broke at runtime — but a
 * typo in a route (`'VALIDATON'`) compiled cleanly and reached the client, and no reader could tell
 * from the contract which codes were real.
 *
 * Typed as a union, adding a code is a deliberate edit here and a typo is a compile error.
 *
 * Codes are part of the public API: clients branch on them. Rename one only as a breaking change.
 */
export const ApiErrorCode = z.enum([
  // Generic, roughly HTTP-shaped.
  "VALIDATION",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
  "INTERNAL",

  // Account and moderation.
  "USERNAME_TAKEN",
  "EMAIL_TAKEN",
  "PROFANITY",

  // Decks and collections.
  "DECK_LOCKED",
  "CORRUPT_ARCHIVE",
  "WRONG_ENDPOINT",

  // League and events.
  "NO_ACTIVE_SEASON",
  "LAST_ADMIN",
  "ROUND_EXISTS",
  "CHECKIN_CLOSED",
  "ALREADY_REPORTED",
  "TOO_FEW_PLAYERS",

  // Draft and sandbox.
  "DRAFT_COMPLETE",
  "EMPTY_CARD_POOL",

  // Upstream services this app depends on.
  "SCRYFALL_UNAVAILABLE",
  "MOXFIELD_UNAVAILABLE",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/**
 * Narrow an arbitrary wire value to a known code. A response body is whatever the other end sent,
 * so a client cannot assume the union holds — use this at the boundary rather than casting, or an
 * unrecognised code silently types as one of ours.
 */
export const isApiErrorCode = (value: unknown): value is ApiErrorCode =>
  ApiErrorCode.safeParse(value).success;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const ApiOk = <T extends z.ZodTypeAny>(data: T) => z.object({ ok: z.literal(true), data });
export type ApiOk<T> = { ok: true; data: T };

export type ApiResult<T> = ApiOk<T> | ApiError;

export const apiOk = <T>(data: T): ApiOk<T> => ({ ok: true, data });
export const apiError = (code: ApiErrorCode, message: string, details?: unknown): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});
