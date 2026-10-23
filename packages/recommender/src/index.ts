/**
 * `@grimore/recommender` — the personalised card recommendation engine.
 *
 * Pure functions only: no database, no network, no clock. The API passes in signals it has loaded
 * and a candidate pool, and gets back a ranked page. Keeping it a package of its own (the
 * `@grimore/auto-tagger` pattern) is what makes the scoring testable without Postgres, which is how
 * the legacy engine's classification rules are pinned in `index.test.ts`.
 *
 * Ported from legacy `execution/recommendation_engine.js`. Behaviour is preserved except where the
 * file headers call out a fix.
 */
export {
  DIMENSION_WEIGHTS,
  MAX_RECOMMENDATION_CYCLE,
  MAX_RECOMMENDATION_PAGE,
  ROLE_TARGETS,
  clamp,
  extractCardFeatures,
  manaValueBucket,
  mapCustomTag,
  normalizeName,
  parseList,
  priceBucket,
  safeNumber,
  unique,
  type CardFeatures,
  type CardLike,
  type Dimension,
} from './features.js';

export {
  addFeatures,
  addToMap,
  createPreferenceProfile,
  emptyVector,
  finalizeVector,
  summarizeProfile,
  topEntries,
  type CreateProfileInput,
  type DeckFingerprint,
  type DeckSeed,
  type FinalizedVector,
  type PreferenceProfile,
  type PreferenceSignal,
  type ProfileSummary,
  type SearchSignal,
  type Vector,
} from './profile.js';

export {
  candidateFitsDeck,
  formatRecommendationCursor,
  nextRecommendationCursor,
  parseRecommendationCursor,
  scoreRecommendations,
  stableNoise,
  type RecommendationCursor,
  type RecommendedCard,
  type ScoreInput,
} from './score.js';
