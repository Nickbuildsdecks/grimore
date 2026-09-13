import { z } from "zod";
import { Id, IntBool, Pagination, Timestamp } from "./common.js";
import { Format, ImageUris } from "./cards.js";

export const DECK_NAME_MAX = 100;
export const CUSTOM_TAG_MAX = 40;
export const DECK_FORMAT_DEFAULT: Format = "commander";

/** Which pile a card lives in. Legacy has no sideboard column; commander is `is_commander=1`. */
export const DeckBoard = z.enum(["main", "commander", "sideboard", "maybeboard"]);
export type DeckBoard = z.infer<typeof DeckBoard>;

const jsonImageUris = z.preprocess((v) => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}, ImageUris.nullable());

/** Mirrors `deck_cards` columns. */
export const DeckCard = z.object({
  id: z.number().int().optional(),
  deck_id: Id,
  card_name: z.string().min(1),
  quantity: z.coerce.number().int().min(1).default(1),
  board: DeckBoard.default("main"),
  is_commander: IntBool.default(false),
  is_partner: IntBool.default(false),
  scryfall_id: z.string().nullable().default(null),
  set_code: z.string().nullable().default(null),
  collector_number: z.string().nullable().default(null),
  custom_tag: z.string().max(CUSTOM_TAG_MAX).nullable().default(null),
  purchase_price: z.coerce.number().default(0),
  cheapest_price: z.coerce.number().default(0),
  cheapest_card_price: z.coerce.number().default(0),
  manual_target_price: z.coerce.number().nullable().default(null),
  keep_cheapest: IntBool.default(false),
  mana_cost: z.string().nullable().default(null),
  cmc: z.coerce.number().default(0),
  type_line: z.string().nullable().default(null),
  oracle_text: z.string().nullable().default(null),
  rarity: z.string().nullable().default(null),
  image_uris: jsonImageUris.default(null),
  created_at: Timestamp.optional(),
});
export type DeckCard = z.infer<typeof DeckCard>;

export const DeckStats = z.object({
  total_wins: z.number().int().default(0),
  total_kills: z.number().int().default(0),
  total_points: z.number().int().default(0),
  total_matches: z.number().int().default(0),
  games_played: z.number().int().default(0),
  win_rate: z.number().default(0),
});
export type DeckStats = z.infer<typeof DeckStats>;

const tagList = z.preprocess((v) => {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : v.split(",").map((s) => s.trim()).filter(Boolean);
    } catch {
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return v ?? [];
}, z.array(z.string().max(CUSTOM_TAG_MAX)));

/** Lightweight row for lists (my-decks, discover). Mirrors `decks` columns. */
export const DeckSummary = z.object({
  id: Id,
  player_id: Id,
  deck_name: z.string(),
  format: Format.catch("commander"),
  moxfield_url: z.string().default(""),
  is_public: IntBool.default(false),
  is_legal: IntBool.default(true),
  legality_reason: z.string().nullable().default(null),
  keep_cheapest: IntBool.default(false),
  cheapest_total_price: z.coerce.number().default(0),
  custom_tags: tagList.default([]),
  featured_card_name: z.string().nullable().default(null),
  cloned_from_deck_id: Id.nullable().default(null),
  original_creator_name: z.string().nullable().default(null),
  likes_count: z.coerce.number().int().default(0),
  last_checked: Timestamp.nullable().default(null),
  /** Derived in the legacy list queries. */
  commander_name: z.string().nullable().default(null),
  commander_scryfall_id: z.string().nullable().default(null),
  featured_scryfall_id: z.string().nullable().default(null),
  card_count: z.coerce.number().int().default(0),
  creator_name: z.string().nullable().default(null),
  creator_avatar_url: z.string().nullable().default(null),
});
export type DeckSummary = z.infer<typeof DeckSummary>;

/** Full deck: GET /api/decks/:deckId (legacy embeds cards, commander and stats). */
export const Deck = DeckSummary.extend({
  cards: z.array(DeckCard).default([]),
  commander: z.object({ name: z.string(), scryfallId: z.string().nullable() }).nullable().default(null),
  stats: DeckStats.default({}),
  has_liked: z.boolean().default(false),
  clones_count: z.number().int().default(0),
});
export type Deck = z.infer<typeof Deck>;

export const DeckCardInput = z.object({
  card_name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(999).default(1),
  board: DeckBoard.default("main"),
  is_commander: z.boolean().default(false),
  is_partner: z.boolean().default(false),
  scryfall_id: z.string().max(64).nullable().optional(),
  set_code: z.string().max(10).nullable().optional(),
  collector_number: z.string().max(20).nullable().optional(),
  custom_tag: z.string().trim().max(CUSTOM_TAG_MAX).nullable().optional(),
  manual_target_price: z.number().min(0).nullable().optional(),
  keep_cheapest: z.boolean().optional(),
});
export type DeckCardInput = z.infer<typeof DeckCardInput>;

/** POST /api/decks (v2 replacement for legacy /api/decks/builder-save without deckId). */
export const CreateDeckInput = z.object({
  deck_name: z.string().trim().min(1).max(DECK_NAME_MAX),
  format: Format.default(DECK_FORMAT_DEFAULT),
  is_public: z.boolean().default(true),
  keep_cheapest: z.boolean().default(false),
  featured_card_name: z.string().trim().max(200).nullable().optional(),
  custom_tags: z.array(z.string().trim().min(1).max(CUSTOM_TAG_MAX)).max(20).default([]),
  moxfield_url: z.string().url().optional(),
  cards: z.array(DeckCardInput).max(600).default([]),
});
export type CreateDeckInput = z.infer<typeof CreateDeckInput>;

/** PUT/PATCH /api/decks/:deckId — all fields optional; `cards` replaces the whole list when present. */
export const UpdateDeckInput = CreateDeckInput.partial().refine((v) => Object.keys(v).length > 0, {
  message: "At least one field must be provided",
});
export type UpdateDeckInput = z.infer<typeof UpdateDeckInput>;

export const DeckSort = z.enum(["updated", "name", "price", "likes"]);
export type DeckSort = z.infer<typeof DeckSort>;

/** GET /api/decks (own decks). */
export const DeckListQuery = Pagination.extend({
  format: Format.optional(),
  sort: DeckSort.default("updated"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().trim().max(100).optional(),
});
export type DeckListQuery = z.infer<typeof DeckListQuery>;

/** GET /api/decks/discover (public feed). */
export const DiscoverQuery = Pagination.extend({
  format: Format.optional(),
  sort: z.enum(["recent", "popular", "price"]).default("recent"),
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(CUSTOM_TAG_MAX).optional(),
  commander: z.string().trim().max(200).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
});
export type DiscoverQuery = z.infer<typeof DiscoverQuery>;
