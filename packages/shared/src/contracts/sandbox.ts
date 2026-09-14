import { z } from "zod";
import { Id } from "./common.js";

export const DRAFT_SEATS = 8;
export const DRAFT_PACK_SIZE = 15;
export const DRAFT_PACKS = 3;

/** A card as the draft and the Arena playtest engine see it. */
export const SandboxCard = z.object({
  name: z.string().min(1),
  scryfallId: z.string().nullable().default(null),
  type_line: z.string().default("Card"),
  mana_cost: z.string().default(""),
  cmc: z.coerce.number().default(0),
  colors: z.array(z.string()).default([]),
  rarity: z.string().default("common"),
  price: z.coerce.number().default(0.15),
});
export type SandboxCard = z.infer<typeof SandboxCard>;

/** POST /api/sandbox/parse-deck — a pasted decklist. */
export const ParseDeckInput = z.object({
  deckText: z.string().min(1).max(100_000),
  format: z.string().trim().max(40).optional(),
});
export type ParseDeckInput = z.infer<typeof ParseDeckInput>;

export const ParsedDeckCard = SandboxCard.extend({
  qty: z.coerce.number().int().min(1).default(1),
  isCommander: z.boolean().default(false),
  oracleText: z.string().default(""),
  /** True when the name matched no row in the local card table. */
  unresolved: z.boolean().default(false),
});
export type ParsedDeckCard = z.infer<typeof ParsedDeckCard>;

export const DraftStatus = z.enum(["active", "completed"]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const CreateDraftInput = z.object({
  format: z.string().trim().max(40).default("draft"),
  setName: z.string().trim().max(40).default("CMR"),
  packSize: z.coerce.number().int().min(1).max(30).default(DRAFT_PACK_SIZE),
});
export type CreateDraftInput = z.infer<typeof CreateDraftInput>;

export const DraftPickInput = z.object({
  cardIndex: z.coerce.number().int().min(0).max(29),
});
export type DraftPickInput = z.infer<typeof DraftPickInput>;

/** The human seat's view. Other seats' packs are never sent — that would be reading the table. */
export const DraftView = z.object({
  id: Id,
  format: z.string(),
  setName: z.string(),
  status: DraftStatus,
  packNumber: z.coerce.number().int().min(1),
  pickNumber: z.coerce.number().int().min(1),
  currentPack: z.array(SandboxCard).default([]),
  draftedPool: z.array(SandboxCard).default([]),
  seats: z.array(z.object({ seatId: z.number().int(), name: z.string(), isBot: z.boolean(), picked: z.number().int() })).default([]),
});
export type DraftView = z.infer<typeof DraftView>;
