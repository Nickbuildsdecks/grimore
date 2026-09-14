import { z } from "zod";
import { Id, IntBool, Timestamp } from "./common.js";

export const COLLECTION_NAME_MAX = 80;

export const CardCondition = z.enum(["NM", "LP", "MP", "HP", "DMG"]);
export type CardCondition = z.infer<typeof CardCondition>;

/**
 * Mirrors `collections` columns. Migration 0005 reconciled the schema with the code: `id` is now TEXT
 * (the baseline had an integer serial while every handler wrote `col_<ts>_<rand>`), and the `settings`
 * column exists. `id` stays a loose union because rows created before that migration carry the decimal
 * string of their old integer id.
 */
export const Collection = z.object({
  id: z.union([Id, z.number().int()]).transform(String),
  player_id: Id,
  name: z.string(),
  description: z.string().nullable().default(null),
  is_public: IntBool.default(true),
  settings: z
    .preprocess((v) => {
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return {};
        }
      }
      return v ?? {};
    }, z.record(z.string(), z.unknown()))
    .default({}),
  created_at: Timestamp,
  /** Aggregates computed by GET /api/collections. */
  total_cards: z.coerce.number().int().default(0),
  total_value: z.coerce.number().default(0),
});
export type Collection = z.infer<typeof Collection>;

/** Mirrors `collection_cards` columns plus the joined price/type fields from GET /api/collections/:id/cards. */
export const CollectionCard = z.object({
  id: z.number().int().optional(),
  collection_id: z.union([Id, z.number().int()]).transform(String),
  card_name: z.string().min(1),
  quantity: z.coerce.number().int().min(0).default(1),
  set_code: z.string().nullable().default(null),
  collector_number: z.string().nullable().default(null),
  scryfall_id: z.string().nullable().default(null),
  foil: IntBool.default(false),
  purchase_price: z.coerce.number().default(0),
  /** Added by migration 0005; the baseline lacked them although the handlers read and wrote them. */
  condition: CardCondition.catch("NM"),
  language: z.string().max(5).default("EN"),
  is_for_trade: IntBool.default(false),
  created_at: Timestamp.optional(),
  /** Joined from scryfall_cards / card_price_cache. */
  price: z.coerce.number().default(0),
  type_line: z.string().default("Card"),
  oracle_text: z.string().default(""),
  cmc: z.coerce.number().default(0),
});
export type CollectionCard = z.infer<typeof CollectionCard>;

export const CreateCollectionInput = z.object({
  name: z.string().trim().min(1).max(COLLECTION_NAME_MAX),
  description: z.string().trim().max(500).nullable().optional(),
  is_public: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type CreateCollectionInput = z.infer<typeof CreateCollectionInput>;

export const UpdateCollectionInput = CreateCollectionInput.partial().refine((v) => Object.keys(v).length > 0, {
  message: "At least one field must be provided",
});
export type UpdateCollectionInput = z.infer<typeof UpdateCollectionInput>;

/** Identifies one printing/variant row inside a collection. */
export const CollectionCardKey = z.object({
  card_name: z.string().trim().min(1).max(200),
  scryfall_id: z.string().max(64).nullable().optional(),
  foil: z.boolean().default(false),
  condition: CardCondition.default("NM"),
  language: z.string().max(5).default("EN"),
});
export type CollectionCardKey = z.infer<typeof CollectionCardKey>;

/** POST /api/collections/:id/cards — add or increment. */
export const AddCollectionCardInput = CollectionCardKey.extend({
  quantity: z.number().int().min(1).max(9999).default(1),
  purchase_price: z.number().min(0).default(0),
  is_for_trade: z.boolean().default(false),
  set_code: z.string().max(10).nullable().optional(),
  collector_number: z.string().max(20).nullable().optional(),
});
export type AddCollectionCardInput = z.infer<typeof AddCollectionCardInput>;

/** PUT /api/collections/:id/cards — locate by key, apply `changes`. */
export const UpdateCollectionCardInput = z.object({
  key: CollectionCardKey,
  changes: z
    .object({
      quantity: z.number().int().min(0).max(9999),
      foil: z.boolean(),
      condition: CardCondition,
      language: z.string().max(5),
      purchase_price: z.number().min(0),
      is_for_trade: z.boolean(),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: "At least one change must be provided" }),
});
export type UpdateCollectionCardInput = z.infer<typeof UpdateCollectionCardInput>;

/** DELETE /api/collections/:id/cards */
export const RemoveCollectionCardInput = CollectionCardKey;
export type RemoveCollectionCardInput = z.infer<typeof RemoveCollectionCardInput>;
