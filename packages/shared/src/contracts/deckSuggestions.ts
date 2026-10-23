import { z } from "zod";

/**
 * GET /api/decks/:deckId/suggestions — commander-led card suggestions for one deck.
 *
 * Legacy took no query parameters: the pool was whatever EDHREC's commander page returned. The
 * pool is local and bounded here (see the route header), so its size is a parameter with a default
 * that matches the size of an EDHREC page.
 */
export const DeckSuggestionsQuery = z.object({
  /** How many candidates to consider. Lenient like the rest of the query contracts. */
  limit: z.coerce.number().int().min(20).max(300).catch(120).default(120),
});
export type DeckSuggestionsQuery = z.infer<typeof DeckSuggestionsQuery>;

export const SuggestedCard = z
  .object({
    name: z.string(),
    /** The client builds the Scryfall art URL from this, so null means it renders its own fallback. */
    scryfallId: z.string().nullable(),
    price: z.number(),
    type_line: z.string(),
    owned: z.boolean(),
    colors: z.array(z.string()).default([]),
    rarity: z.string().default("common"),
    image_uri: z.string().default(""),
  })
  .passthrough();
export type SuggestedCard = z.infer<typeof SuggestedCard>;

export const SuggestionCategory = z.object({
  header: z.string(),
  /** Stable slug the client keys its selected-category state on. */
  tag: z.string(),
  cards: z.array(SuggestedCard),
});
export type SuggestionCategory = z.infer<typeof SuggestionCategory>;

/** Which pool produced the suggestions. `edhrec` is unreachable here — see the route header. */
export const SuggestionSource = z.enum(["local-pool", "edhrec"]);
export type SuggestionSource = z.infer<typeof SuggestionSource>;

export const DeckSuggestionsResponse = z.object({
  success: z.literal(true),
  /** Commander names joined with ` // `, as legacy rendered them. */
  commanderName: z.string(),
  commanderScryfallId: z.string().nullable(),
  /** Alias of `functionalCategories`; the client reads whichever is present. */
  categories: z.array(SuggestionCategory),
  functionalCategories: z.array(SuggestionCategory),
  typeCategories: z.array(SuggestionCategory),
  suggestionSource: SuggestionSource,
  /** Colour identity the pool was filtered to. Empty when no commander resolved to a known card. */
  colorIdentity: z.array(z.string()),
  poolSize: z.number().int().min(0),
});
export type DeckSuggestionsResponse = z.infer<typeof DeckSuggestionsResponse>;
