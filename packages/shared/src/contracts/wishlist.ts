import { z } from "zod";
import { Id, Timestamp } from "./common.js";

/** One `wishlist_cards` row, with price/type joined from the card tables. */
export const WishlistCard = z.object({
  id: z.coerce.number().int(),
  player_id: Id,
  card_name: z.string().min(1),
  scryfall_id: z.string().nullable().default(null),
  quantity: z.coerce.number().int().min(1).default(1),
  created_at: Timestamp,
  /** Joined from card_price_cache / scryfall_cards. */
  price: z.coerce.number().default(0),
  type_line: z.string().default("Card"),
  oracle_text: z.string().default(""),
});
export type WishlistCard = z.infer<typeof WishlistCard>;

/** POST /api/wishlist — legacy body keys kept so the existing UI keeps working. */
export const AddWishlistCardInput = z.object({
  cardName: z.string().trim().min(1).max(200),
  scryfallId: z.string().max(64).nullable().optional(),
  quantity: z.coerce.number().int().min(1).max(9999).default(1),
});
export type AddWishlistCardInput = z.infer<typeof AddWishlistCardInput>;

/** PUT /api/wishlist — set an exact quantity; 0 removes the row. */
export const UpdateWishlistCardInput = z.object({
  cardName: z.string().trim().min(1).max(200),
  scryfallId: z.string().max(64).nullable().optional(),
  quantity: z.coerce.number().int().min(0).max(9999),
});
export type UpdateWishlistCardInput = z.infer<typeof UpdateWishlistCardInput>;

export const DeletedItemType = z.enum(["deck", "collection"]);
export type DeletedItemType = z.infer<typeof DeletedItemType>;

/** A recycle-bin entry. `data` is the archived payload and is not sent in the list response. */
export const DeletedItem = z.object({
  id: Id,
  item_type: DeletedItemType,
  item_id: Id,
  player_id: Id,
  name: z.string(),
  deleted_at: Timestamp,
});
export type DeletedItem = z.infer<typeof DeletedItem>;
