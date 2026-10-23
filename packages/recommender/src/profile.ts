/**
 * Preference profile — accumulates every signal we hold about a player into one global taste vector
 * plus one fingerprint per deck.
 *
 * The per-deck split is the point. Blending a mono-green landfall deck and a mono-blue artifact deck
 * into a single vector produces a profile that matches neither, and legacy learned that the hard way:
 * the engine keeps the decks apart so a recommendation can be scored "does this fit THAT deck", and
 * a card illegal in the target deck's colour identity is dropped rather than ranked.
 *
 * Art votes are deliberately excluded from the gameplay dimensions. Every printing of one card has
 * the same type, colour and mana value, so a vote between two Sol Rings says nothing about whether
 * the player likes artifacts — only about the illustrator. Folding them in is what let an aesthetic
 * judgement masquerade as a gameplay preference.
 */
import {
  type CardFeatures,
  type CardLike,
  type Dimension,
  DIMENSION_WEIGHTS,
  ROLE_TARGETS,
  clamp,
  extractCardFeatures,
  normalizeName,
  safeNumber,
} from './features.js';

export type Vector = Record<Dimension, Map<string, number>>;
export type FinalizedVector = Record<Dimension, Record<string, number>>;

const DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as Dimension[];

/**
 * One thing we know the player did. `card` carries the card it was about; when absent the signal
 * itself is read as the card, which is how legacy passed flat rows straight through.
 */
export interface PreferenceSignal extends CardLike {
  /** `art` routes the signal to the illustrator affinity instead of the gameplay dimensions. */
  kind?: 'art' | 'card';
  /** Where it came from — `own_deck`, `collection`, `wishlist`, `discover_swipe`, ... */
  source?: string;
  /** Negative for a pass / downvote. */
  polarity?: number;
  weight?: number;
  /** True for a deliberate action (a swipe, a vote) rather than an inferred one. */
  explicit?: boolean;
  deckId?: string;
  deckName?: string;
  quantity?: number;
  isCommander?: boolean;
  card?: CardLike;
}

export interface SearchSignal {
  query?: string;
  entityKey?: string;
  occurrences?: number;
}

export interface DeckSeed {
  id?: string;
  deckId?: string;
  name?: string;
  deckName?: string;
  format?: string;
}

export interface DeckFingerprint {
  id: string;
  name: string;
  format: string;
  colors: string[];
  cardCount: number;
  positive: FinalizedVector;
  negative: FinalizedVector;
  /** Role -> how far short of `ROLE_TARGETS` the deck is, 0..1. */
  gaps: Record<string, number>;
}

export interface PreferenceProfile {
  playerId: string;
  positive: FinalizedVector;
  negative: FinalizedVector;
  decks: DeckFingerprint[];
  artistAffinity: Record<string, number>;
  followedArtists: Set<string>;
  deckCardNames: Set<string>;
  ownedNames: Set<string>;
  wishlistNames: Set<string>;
  likedNames: Set<string>;
  dislikedNames: Set<string>;
  signalCounts: Record<string, number>;
  confidence: number;
  coldStart: boolean;
}

export interface ProfileSummary {
  confidence: number;
  coldStart: boolean;
  decksLearned: number;
  topColors: Array<{ name: string; score: number }>;
  topRoles: Array<{ name: string; score: number }>;
  topThemes: Array<{ name: string; score: number }>;
  typicalManaValues: Array<{ name: string; score: number }>;
  typicalPriceBands: Array<{ name: string; score: number }>;
  followedArtists: number;
  signalCounts: Record<string, number>;
}

export function emptyVector(): Vector {
  return {
    themes: new Map(),
    roles: new Map(),
    colors: new Map(),
    types: new Map(),
    manaValues: new Map(),
    priceBands: new Map(),
  };
}

export function addToMap(map: Map<string, number>, key: string, value: number): void {
  if (!key || !Number.isFinite(value) || value === 0) return;
  map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Spreads one signal's weight over the dimensions it touches, divided by sqrt(count) so a card that
 * matches eight themes does not out-shout a card that matches one.
 */
export function addFeatures(vector: Vector, features: CardFeatures, amount: number): void {
  for (const dimension of DIMENSIONS) {
    const values = features[dimension] ?? [];
    const distributed = values.length > 0 ? amount / Math.sqrt(values.length) : 0;
    for (const value of values) addToMap(vector[dimension], value, distributed);
  }
}

/** Normalises each dimension to 0..1 against its own peak, so dimensions stay comparable. */
export function finalizeVector(vector: Vector): FinalizedVector {
  const result = {} as FinalizedVector;
  for (const dimension of DIMENSIONS) {
    const entries = [...vector[dimension].entries()].filter(([, value]) => value > 0);
    const max = Math.max(1, ...entries.map(([, value]) => value));
    result[dimension] = Object.fromEntries(entries.map(([key, value]) => [key, value / max]));
  }
  return result;
}

export function topEntries(
  dimension: Record<string, number> | undefined,
  limit = 3,
): Array<{ name: string; score: number }> {
  return Object.entries(dimension ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, score]) => ({ name, score: Number(score.toFixed(3)) }));
}

interface DeckAccumulator {
  id: string;
  name: string;
  format: string;
  positive: Vector;
  negative: Vector;
  roleCounts: Map<string, number>;
  cardCount: number;
  commanderColors: Set<string>;
  allColors: Set<string>;
  signals: number;
}

function emptyDeckAccumulator(deck: DeckSeed = {}): DeckAccumulator {
  return {
    id: deck.id ?? deck.deckId ?? '',
    name: deck.name ?? deck.deckName ?? 'A deck',
    format: String(deck.format ?? 'commander').toLocaleLowerCase('en-US'),
    positive: emptyVector(),
    negative: emptyVector(),
    roleCounts: new Map(),
    cardCount: 0,
    commanderColors: new Set(),
    allColors: new Set(),
    signals: 0,
  };
}

export interface CreateProfileInput {
  playerId?: string;
  signals?: PreferenceSignal[];
  decks?: DeckSeed[];
  followedArtists?: string[];
  searches?: SearchSignal[];
}

export function createPreferenceProfile({
  playerId = '',
  signals = [],
  decks = [],
  followedArtists = [],
  searches = [],
}: CreateProfileInput = {}): PreferenceProfile {
  const positive = emptyVector();
  const negative = emptyVector();
  const deckMap = new Map<string, DeckAccumulator>(
    decks.map((deck) => {
      const accumulator = emptyDeckAccumulator(deck);
      return [accumulator.id, accumulator];
    }),
  );
  const signalCounts: Record<string, number> = {};
  const deckCardNames = new Set<string>();
  const ownedNames = new Set<string>();
  const wishlistNames = new Set<string>();
  const likedNames = new Set<string>();
  const dislikedNames = new Set<string>();
  const interactedNames = new Set<string>();
  const artistScores = new Map<string, number>();
  let explicitActions = 0;

  for (const signal of signals) {
    const features = extractCardFeatures(signal.card ?? signal);
    const source = String(signal.source ?? 'unknown');
    const polarity = safeNumber(signal.polarity, 1) >= 0 ? 1 : -1;
    const weight = Math.max(0, safeNumber(signal.weight, 1));
    const amount = weight * polarity;

    // An art vote teaches us about the illustrator and nothing else — see the file header.
    if (signal.kind === 'art') {
      const artistKey = normalizeName(signal.artist ?? features.artist);
      if (artistKey) {
        addToMap(artistScores, artistKey, amount);
        signalCounts[source] = (signalCounts[source] ?? 0) + 1;
      }
      continue;
    }

    if (!features.nameKey) continue;
    const destination = amount >= 0 ? positive : negative;
    addFeatures(destination, features, Math.abs(amount));
    signalCounts[source] = (signalCounts[source] ?? 0) + 1;
    interactedNames.add(features.nameKey);

    if (signal.explicit) {
      explicitActions += 1;
      if (polarity > 0) likedNames.add(features.nameKey);
      else if (source.includes('swipe')) dislikedNames.add(features.nameKey);
    }
    if (source === 'own_deck') deckCardNames.add(features.nameKey);
    if (source === 'collection') ownedNames.add(features.nameKey);
    if (source === 'wishlist') wishlistNames.add(features.nameKey);

    if (signal.deckId) {
      if (!deckMap.has(signal.deckId)) {
        deckMap.set(
          signal.deckId,
          emptyDeckAccumulator({ id: signal.deckId, name: signal.deckName, format: signal.format as string }),
        );
      }
      const deck = deckMap.get(signal.deckId)!;
      const deckDestination = amount >= 0 ? deck.positive : deck.negative;
      addFeatures(deckDestination, features, Math.abs(amount));
      deck.signals += 1;
      const quantity = clamp(safeNumber(signal.quantity, 1), 1, 4);
      deck.cardCount += quantity;
      for (const role of features.roles) addToMap(deck.roleCounts, role, quantity);
      for (const color of features.colors) deck.allColors.add(color);
      if (signal.isCommander) for (const color of features.colors) deck.commanderColors.add(color);
    }
  }

  // A search is a stated intent, so it moves the profile — but weakly, and only through the
  // features its own syntax names. `id<=wubrg`, `mv<=3` and `usd<5` are mined; the rest of the query
  // becomes synthetic rules text.
  for (const search of searches) {
    const query = String(search.query ?? search.entityKey ?? '');
    if (!query) continue;
    const synthetic: CardLike = {
      name: `Search: ${query}`,
      type_line: /\btype:(artifact|enchantment|creature|instant|sorcery|land)\b/i.exec(query)?.[1] ?? '',
      oracle_text: query.replace(/[:"]/g, ' '),
      colors: (/\bid(?:=|<=|>=)([wubrg]+)/i.exec(query)?.[1] ?? '').toUpperCase().split(''),
      cmc: safeNumber(/\bmv(?:=|<=|>=|<|>)(\d+)/i.exec(query)?.[1], 3),
      price: safeNumber(/\busd(?:=|<=|>=|<|>)(\d+)/i.exec(query)?.[1], 5),
    };
    addFeatures(positive, extractCardFeatures(synthetic), 0.25 * clamp(safeNumber(search.occurrences, 1), 1, 4));
    signalCounts.search = (signalCounts.search ?? 0) + 1;
  }

  const finalizedDecks: DeckFingerprint[] = [...deckMap.values()]
    .filter((deck) => deck.signals > 0)
    .map((deck) => {
      // The commander defines a commander deck's colour identity. Fall back to every colour seen in
      // the deck when no card is tagged as the commander.
      const colors = deck.commanderColors.size > 0 ? [...deck.commanderColors] : [...deck.allColors];
      const gaps: Record<string, number> = {};
      for (const [role, target] of Object.entries(ROLE_TARGETS)) {
        const current = safeNumber(deck.roleCounts.get(role));
        gaps[role] = clamp((target - current) / target, 0, 1);
      }
      return {
        id: deck.id,
        name: deck.name,
        format: deck.format,
        colors,
        cardCount: deck.cardCount,
        positive: finalizeVector(deck.positive),
        negative: finalizeVector(deck.negative),
        gaps,
      };
    });

  const distinctSignals = interactedNames.size + searches.length;
  const confidence = clamp(
    1 -
      Math.exp(
        -(
          distinctSignals * 0.055 +
          finalizedDecks.length * 0.3 +
          explicitActions * 0.1 +
          followedArtists.length * 0.12
        ),
      ),
    0,
    0.99,
  );

  const artistPeak = Math.max(1, ...[...artistScores.values()].map(Math.abs));
  const artistAffinity = Object.fromEntries([...artistScores.entries()].map(([artist, score]) => [artist, score / artistPeak]));

  return {
    playerId,
    positive: finalizeVector(positive),
    negative: finalizeVector(negative),
    decks: finalizedDecks,
    artistAffinity,
    followedArtists: new Set(followedArtists.map(normalizeName)),
    deckCardNames,
    ownedNames,
    wishlistNames,
    likedNames,
    dislikedNames,
    signalCounts,
    confidence,
    coldStart: distinctSignals < 3 && finalizedDecks.length === 0 && followedArtists.length === 0,
  };
}

/** What the client is told about why it is being shown these cards. */
export function summarizeProfile(profile: PreferenceProfile): ProfileSummary {
  return {
    confidence: Number(profile.confidence.toFixed(2)),
    coldStart: profile.coldStart,
    decksLearned: profile.decks.length,
    topColors: topEntries(profile.positive.colors),
    topRoles: topEntries(profile.positive.roles),
    topThemes: topEntries(profile.positive.themes),
    typicalManaValues: topEntries(profile.positive.manaValues),
    typicalPriceBands: topEntries(profile.positive.priceBands),
    followedArtists: profile.followedArtists.size,
    signalCounts: profile.signalCounts,
  };
}
