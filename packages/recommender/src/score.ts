/**
 * Scoring and selection — turns a candidate pool plus a profile into a ranked, diversified page.
 *
 * ## One fix relative to legacy
 *
 * `candidateFitsDeck` read `candidate.legalities[deck.format]` and assumed an object. Candidates
 * arriving from the Scryfall API are objects, so the format-legality filter worked there — but
 * `scryfall_cards.legalities` is a **TEXT** column holding JSON, and indexing a string by
 * `"commander"` yields `undefined`, which the check reads as "no legality recorded, allow it". So the
 * moment the local cache became the candidate source (which is the only source reachable from this
 * environment — see the route header), the ban list stopped being enforced and banned cards could be
 * recommended into a commander deck. `legalitiesOf` parses the string form, so both shapes work.
 */
import {
  type CardFeatures,
  type CardLike,
  type Dimension,
  DIMENSION_WEIGHTS,
  MAX_RECOMMENDATION_CYCLE,
  MAX_RECOMMENDATION_PAGE,
  clamp,
  extractCardFeatures,
  normalizeName,
  safeNumber,
  unique,
} from './features.js';
import { type DeckFingerprint, type FinalizedVector, type PreferenceProfile, addToMap } from './profile.js';

export interface RecommendationCursor {
  page: number;
  cycle: number;
}

export interface RecommendedCard {
  name: string;
  scryfallId?: string | null;
  type_line: string;
  oracle_text: string;
  mana_cost: string;
  cmc: number;
  colors: string[];
  price: number;
  roles: string[];
  themes: string[];
  score: number;
  reasons: string[];
  targetDeck: { id: string; name: string } | null;
  owned: boolean;
  alreadyInDeck: boolean;
  artistFollowed: boolean;
  [key: string]: unknown;
}

type ScoredCandidate = RecommendedCard & {
  _primaryTheme: string;
  _primaryRole: string;
  _primaryType: string;
};

const DIMENSION_ENTRIES = Object.entries(DIMENSION_WEIGHTS) as Array<[Dimension, number]>;

/** How closely a candidate's features land on a vector the player has shown they like. */
function dimensionMatch(vector: FinalizedVector | undefined, features: CardFeatures): number {
  let total = 0;
  for (const [dimension, dimensionWeight] of DIMENSION_ENTRIES) {
    const values = features[dimension] ?? [];
    if (!values.length) continue;
    const best = Math.max(0, ...values.map((value) => safeNumber(vector?.[dimension]?.[value])));
    total += best * dimensionWeight;
  }
  return total;
}

/** Accepts both the object form (Scryfall) and the JSON-text form (`scryfall_cards.legalities`). */
function legalitiesOf(candidate: CardLike): Record<string, string> {
  const raw = candidate.legalities;
  if (raw && typeof raw === 'object') return raw as Record<string, string>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }
  return {};
}

export function candidateFitsDeck(
  candidate: CardFeatures,
  deck: DeckFingerprint | null | undefined,
  rawCandidate: CardLike = {},
): boolean {
  if (!deck) return true;
  const legality = legalitiesOf(rawCandidate)[deck.format];
  if (legality && !['legal', 'restricted'].includes(legality)) return false;
  if (deck.format !== 'commander' || deck.colors.length === 0) return true;
  // Commander colour identity: every colour in the card must be in the commander's identity.
  return candidate.colors.every((color) => deck.colors.includes(color));
}

/**
 * Deterministic jitter, so two players with identical profiles do not see an identical list and a
 * reload does not reshuffle the page. Seeded per player per day by the caller.
 */
export function stableNoise(seed: string, value: string): number {
  const input = `${seed}:${value}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

export function parseRecommendationCursor(value: unknown): RecommendationCursor {
  const match = /^(\d+):(\d+)$/.exec(String(value ?? ''));
  if (!match) return { page: 1, cycle: 0 };
  return {
    page: clamp(Number.parseInt(match[1], 10) || 1, 1, MAX_RECOMMENDATION_PAGE),
    cycle: clamp(Number.parseInt(match[2], 10) || 0, 0, MAX_RECOMMENDATION_CYCLE),
  };
}

export function formatRecommendationCursor({ page = 1, cycle = 0 }: Partial<RecommendationCursor> = {}): string {
  return `${clamp(Math.floor(safeNumber(page, 1)), 1, MAX_RECOMMENDATION_PAGE)}:${clamp(
    Math.floor(safeNumber(cycle)),
    0,
    MAX_RECOMMENDATION_CYCLE,
  )}`;
}

/** Advances the page while the source has more, then starts a fresh cycle so the feed never ends. */
export function nextRecommendationCursor(cursor: Partial<RecommendationCursor>, hasMore: boolean): string {
  const current = parseRecommendationCursor(formatRecommendationCursor(cursor));
  if (hasMore && current.page < MAX_RECOMMENDATION_PAGE) {
    return formatRecommendationCursor({ page: current.page + 1, cycle: current.cycle });
  }
  return formatRecommendationCursor({
    page: 1,
    cycle: current.cycle >= MAX_RECOMMENDATION_CYCLE ? 0 : current.cycle + 1,
  });
}

function profileReasonLabel(profile: PreferenceProfile, features: CardFeatures): string | null {
  const theme = features.themes
    .map((value) => ({ value, score: safeNumber(profile.positive.themes[value]) }))
    .sort((a, b) => b.score - a.score)[0];
  if (theme && theme.score > 0.15) return `Matches your ${theme.value.toLocaleLowerCase('en-US')} style`;
  const role = features.roles
    .map((value) => ({ value, score: safeNumber(profile.positive.roles[value]) }))
    .sort((a, b) => b.score - a.score)[0];
  if (role && role.score > 0.15) return `Matches your preference for ${role.value.toLocaleLowerCase('en-US')}`;
  return null;
}

export interface ScoreInput {
  profile: PreferenceProfile;
  candidates?: CardLike[];
  /** card key -> number of public decks running it. */
  communityCounts?: Record<string, number>;
  targetDeckId?: string;
  limit?: number;
  offset?: number;
  seed?: string;
}

export function scoreRecommendations({
  profile,
  candidates = [],
  communityCounts = {},
  targetDeckId = '',
  limit = 24,
  offset = 0,
  seed = 'grimore',
}: ScoreInput): RecommendedCard[] {
  const normalizedLimit = clamp(Math.floor(safeNumber(limit, 24)), 1, 100);
  const normalizedOffset = Math.max(0, Math.floor(safeNumber(offset)));
  const selectionTarget = normalizedOffset + normalizedLimit;
  const targetDeck = targetDeckId ? (profile.decks.find((deck) => deck.id === targetDeckId) ?? null) : null;
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const features = extractCardFeatures(candidate);
    if (!features.nameKey || features.isTokenLike || features.isBasicLand) continue;
    // A pass stays passed — unless the card is already in one of the player's decks, in which case
    // the pass was about a printing or a mood, not the card.
    if (profile.dislikedNames.has(features.nameKey) && !profile.deckCardNames.has(features.nameKey)) continue;

    const legalDecks = profile.decks.filter((deck) => candidateFitsDeck(features, deck, candidate));
    if (targetDeck && !candidateFitsDeck(features, targetDeck, candidate)) continue;
    if (!targetDeck && profile.decks.length > 0 && legalDecks.length === 0) continue;

    const globalPositive = dimensionMatch(profile.positive, features);
    const globalNegative = dimensionMatch(profile.negative, features);
    const deckCandidates = targetDeck ? [targetDeck] : legalDecks;
    let bestDeck: DeckFingerprint | null = null;
    let bestDeckFit = 0;
    for (const deck of deckCandidates) {
      const fit = dimensionMatch(deck.positive, features) - dimensionMatch(deck.negative, features) * 0.6;
      if (fit > bestDeckFit || bestDeck === null) {
        bestDeck = deck;
        bestDeckFit = fit;
      }
    }

    const gapMatches = bestDeck
      ? features.roles.map((role) => ({ role, gap: safeNumber(bestDeck!.gaps[role]) })).sort((a, b) => b.gap - a.gap)
      : [];
    const bestGap = gapMatches[0];
    const communityCount = safeNumber(communityCounts[features.nameKey]);
    const artistKey = features.artist ? normalizeName(features.artist) : '';
    const artistFollowed = Boolean(artistKey) && profile.followedArtists.has(artistKey);
    const artistTaste = artistKey ? safeNumber(profile.artistAffinity?.[artistKey]) : 0;

    let rawScore =
      8 +
      globalPositive * 42 +
      bestDeckFit * 30 -
      globalNegative * 24 +
      (bestGap?.gap ?? 0) * 14 +
      Math.log1p(communityCount) * 2.5 +
      artistTaste * 9 +
      stableNoise(seed, features.nameKey) * 4;

    if (artistFollowed) rawScore += 11;
    if (profile.likedNames.has(features.nameKey)) rawScore += 12;
    if (profile.wishlistNames.has(features.nameKey)) rawScore += 14;
    if (profile.ownedNames.has(features.nameKey)) rawScore += 2;
    if (profile.deckCardNames.has(features.nameKey)) rawScore -= 7;

    const reasons: string[] = [];
    if (bestDeck && (bestGap?.gap ?? 0) >= 0.25 && bestGap) {
      reasons.push(`Fills a ${bestGap.role.toLocaleLowerCase('en-US')} gap in ${bestDeck.name}`);
    }
    if (bestDeck && bestDeckFit >= 0.12) reasons.push(`Fits ${bestDeck.name}`);
    const profileReason = profileReasonLabel(profile, features);
    if (profileReason) reasons.push(profileReason);
    if (artistFollowed) reasons.push('Art from an illustrator you follow');
    else if (artistTaste >= 0.35 && features.artist) reasons.push('Artwork in a style you keep picking');
    if (profile.wishlistNames.has(features.nameKey)) reasons.push('Already on your wishlist');
    else if (profile.ownedNames.has(features.nameKey)) reasons.push('You already own a copy');
    if (communityCount > 1) reasons.push(`Appears in ${communityCount} community decks`);
    if (reasons.length === 0) {
      reasons.push(
        profile.coldStart
          ? 'Popular starting point while Grimore learns your style'
          : 'A discovery pick outside your usual pattern',
      );
    }

    scored.push({
      ...candidate,
      name: String(candidate.name ?? candidate.card_name ?? ''),
      scryfallId: (candidate.scryfallId as string | undefined) ?? (candidate.scryfall_id as string | undefined) ?? null,
      type_line: String(candidate.type_line ?? ''),
      oracle_text: String(candidate.oracle_text ?? ''),
      mana_cost: String(candidate.mana_cost ?? ''),
      cmc: features.cmc,
      colors: features.colors,
      price: features.price,
      roles: features.roles,
      themes: features.themes,
      score: Math.round(clamp(rawScore, 1, 99)),
      reasons: unique(reasons).slice(0, 3),
      targetDeck: bestDeck ? { id: bestDeck.id, name: bestDeck.name } : null,
      owned: profile.ownedNames.has(features.nameKey),
      alreadyInDeck: profile.deckCardNames.has(features.nameKey),
      artistFollowed: Boolean(artistFollowed || candidate.artistFollowed),
      _primaryTheme: features.themes[0] ?? '',
      _primaryRole: features.roles[0] ?? '',
      _primaryType: features.types[0] ?? '',
    });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Diversification: repeatedly take the highest-scoring card after penalising whatever theme, role
  // and type the page is already full of. Without this a landfall profile returns 24 ramp spells.
  const selected: ScoredCandidate[] = [];
  const dimensionCounts = {
    theme: new Map<string, number>(),
    role: new Map<string, number>(),
    type: new Map<string, number>(),
  };
  const pool = scored.slice(0, Math.max(selectionTarget * 12, 120));

  while (selected.length < selectionTarget && pool.length > 0) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    pool.forEach((candidate, index) => {
      const penalty =
        safeNumber(dimensionCounts.theme.get(candidate._primaryTheme)) * 5 +
        safeNumber(dimensionCounts.role.get(candidate._primaryRole)) * 3 +
        safeNumber(dimensionCounts.type.get(candidate._primaryType)) * 1.5;
      const adjusted = candidate.score - penalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    });
    const [chosen] = pool.splice(bestIndex, 1);
    selected.push(chosen);
    addToMap(dimensionCounts.theme, chosen._primaryTheme, 1);
    addToMap(dimensionCounts.role, chosen._primaryRole, 1);
    addToMap(dimensionCounts.type, chosen._primaryType, 1);
  }

  return selected
    .slice(normalizedOffset, normalizedOffset + normalizedLimit)
    .map(({ _primaryTheme: _t, _primaryRole: _r, _primaryType: _y, ...candidate }) => candidate);
}
