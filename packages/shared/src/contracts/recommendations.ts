import { z } from "zod";

/**
 * GET /api/cards/recommendations — the personalised discovery feed.
 *
 * Legacy clamped `limit` to 4..40 with a default of 16 and truncated `deckId` to 100 characters;
 * both are kept so the existing client keeps working unchanged.
 */
export const RecommendationQuery = z.object({
  limit: z.coerce.number().int().min(4).max(40).catch(16).default(16),
  /** Score for one deck specifically. A deck the caller does not own is a 404, not a silent ignore. */
  deckId: z.string().trim().max(100).optional(),
  /** Opaque `page:cycle` token. Anything unparseable restarts at the first page, as legacy did. */
  cursor: z.string().trim().max(32).optional(),
});
export type RecommendationQuery = z.infer<typeof RecommendationQuery>;

/** Why a card is in the list. Three at most, most specific first. */
export const RecommendationReason = z.string();

export const RecommendedCard = z
  .object({
    name: z.string(),
    scryfallId: z.string().nullable().optional(),
    type_line: z.string().default(""),
    oracle_text: z.string().default(""),
    mana_cost: z.string().default(""),
    cmc: z.number().default(0),
    colors: z.array(z.string()).default([]),
    price: z.number().default(0),
    roles: z.array(z.string()).default([]),
    themes: z.array(z.string()).default([]),
    score: z.number().int().min(1).max(99),
    reasons: z.array(RecommendationReason).max(3),
    targetDeck: z.object({ id: z.string(), name: z.string() }).nullable(),
    owned: z.boolean(),
    alreadyInDeck: z.boolean(),
    artistFollowed: z.boolean(),
  })
  // The engine passes the candidate row through, so image_uri / set_name / rarity ride along.
  .passthrough();
export type RecommendedCard = z.infer<typeof RecommendedCard>;

export const ProfileDimensionEntry = z.object({ name: z.string(), score: z.number() });
export type ProfileDimensionEntry = z.infer<typeof ProfileDimensionEntry>;

/** What the client may show the player about why these cards: the feed explains itself. */
export const RecommendationProfileSummary = z.object({
  confidence: z.number().min(0).max(1),
  coldStart: z.boolean(),
  decksLearned: z.number().int().min(0),
  topColors: z.array(ProfileDimensionEntry),
  topRoles: z.array(ProfileDimensionEntry),
  topThemes: z.array(ProfileDimensionEntry),
  typicalManaValues: z.array(ProfileDimensionEntry),
  typicalPriceBands: z.array(ProfileDimensionEntry),
  followedArtists: z.number().int().min(0),
  signalCounts: z.record(z.string(), z.number()),
});
export type RecommendationProfileSummary = z.infer<typeof RecommendationProfileSummary>;

/** Which pool produced the page. `scryfall-legal-pool` is unreachable here — see the route header. */
export const CandidateSource = z.enum(["local-cache", "scryfall-legal-pool"]);
export type CandidateSource = z.infer<typeof CandidateSource>;

export const RecommendationResponse = z.object({
  algorithmVersion: z.string(),
  /** True when the profile is cold and the page is popularity-led rather than personalised. */
  fallback: z.boolean(),
  candidateSource: CandidateSource,
  cursor: z.string(),
  nextCursor: z.string(),
  /** Always true: the feed recycles rather than ending, which is what `cycle` counts. */
  hasMore: z.boolean(),
  cycle: z.number().int().min(0),
  recycled: z.boolean(),
  profile: RecommendationProfileSummary,
  cards: z.array(RecommendedCard),
});
export type RecommendationResponse = z.infer<typeof RecommendationResponse>;
