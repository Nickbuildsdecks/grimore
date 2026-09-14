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

export const ApiErrorCode = z.enum([
  "bad_request",
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "premium_required",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

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
