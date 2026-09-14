import { z } from "zod";
import { Pagination } from "./common.js";

export const Color = z.enum(["W", "U", "B", "R", "G"]);
export type Color = z.infer<typeof Color>;

export const Rarity = z.enum(["common", "uncommon", "rare", "mythic", "special", "bonus"]);
export type Rarity = z.infer<typeof Rarity>;

export const Legality = z.enum(["legal", "not_legal", "restricted", "banned"]);
export type Legality = z.infer<typeof Legality>;

/** Formats the app tracks (subset of Scryfall's legalities keys). */
export const Format = z.enum([
  "commander",
  "standard",
  "pioneer",
  "modern",
  "legacy",
  "vintage",
  "pauper",
  "brawl",
  "oathbreaker",
]);
export type Format = z.infer<typeof Format>;

export const ImageUris = z.object({
  small: z.string().url().optional(),
  normal: z.string().url().optional(),
  large: z.string().url().optional(),
  png: z.string().url().optional(),
  art_crop: z.string().url().optional(),
  border_crop: z.string().url().optional(),
});
export type ImageUris = z.infer<typeof ImageUris>;

/** Scryfall price strings ("1.23") or null. Legacy also folds in `ck`/`ck_foil`. */
const priceStr = z.string().nullable().optional();
export const Prices = z.object({
  usd: priceStr,
  usd_foil: priceStr,
  usd_etched: priceStr,
  eur: priceStr,
  eur_foil: priceStr,
  tix: priceStr,
});
export type Prices = z.infer<typeof Prices>;

/** Scryfall `legalities` map: format -> legality. Unknown formats are passed through. */
export const Legalities = z.record(z.string(), Legality);
export type Legalities = z.infer<typeof Legalities>;

/** Legacy stores colors / legalities / image_uris as JSON text; accept string and parse. */
const jsonOr = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => {
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  }, inner);

export const CardFace = z.object({
  name: z.string(),
  mana_cost: z.string().optional(),
  type_line: z.string().optional(),
  oracle_text: z.string().optional(),
  colors: z.array(Color).optional(),
  image_uris: ImageUris.optional(),
});
export type CardFace = z.infer<typeof CardFace>;

/** Subset of Scryfall card fields the app uses. `id` is the Scryfall id. */
export const Card = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mana_cost: z.string().nullable().default(null),
  cmc: z.coerce.number().default(0),
  type_line: z.string().default(""),
  oracle_text: z.string().nullable().default(null),
  colors: jsonOr(z.array(Color)).default([]),
  color_identity: jsonOr(z.array(Color)).default([]),
  set: z.string().default("unk"),
  set_name: z.string().nullable().default(null),
  collector_number: z.string().default("1"),
  rarity: Rarity.nullable().default(null),
  image_uris: jsonOr(ImageUris).nullable().default(null),
  prices: jsonOr(Prices).nullable().default(null),
  legalities: jsonOr(Legalities).default({}),
  card_faces: jsonOr(z.array(CardFace)).nullable().default(null),
  keywords: jsonOr(z.array(z.string())).default([]),
  edhrec_rank: z.number().int().nullable().default(null),
  scryfall_uri: z.string().nullable().default(null),
});
export type Card = z.infer<typeof Card>;

export const CardSort = z.enum(["relevance", "name", "price", "cmc", "rarity", "subtype"]);
export type CardSort = z.infer<typeof CardSort>;

/** GET /api/cards/search — legacy: q, sort, dir, page, limit (default 60). */
export const CardSearchQuery = Pagination.extend({
  q: z.string().trim().min(1).max(200),
  sort: CardSort.default("relevance"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(100).default(60),
  format: Format.optional(),
  colors: z
    .union([z.string(), z.array(Color)])
    .transform((v) => (Array.isArray(v) ? v : v.split("").filter((c): c is Color => "WUBRG".includes(c))))
    .optional(),
});
export type CardSearchQuery = z.infer<typeof CardSearchQuery>;

export const CardSearchResponse = z.object({
  cards: z.array(Card),
  totalCards: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type CardSearchResponse = z.infer<typeof CardSearchResponse>;

/** GET /api/cards/autocomplete?q= */
export const CardAutocompleteQuery = z.object({ q: z.string().trim().min(1).max(100) });
export type CardAutocompleteQuery = z.infer<typeof CardAutocompleteQuery>;
