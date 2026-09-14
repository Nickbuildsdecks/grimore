const ROLE_TARGETS = {
  Ramp: 10,
  "Card Advantage": 10,
  "Single Target Removal": 7,
  "Mass Removal": 3,
  Protection: 4,
  Tutors: 2,
  "Wincons / Finishers": 4,
  Recursion: 3,
};

const DIMENSION_WEIGHTS = {
  themes: 0.28,
  roles: 0.26,
  colors: 0.16,
  types: 0.12,
  manaValues: 0.10,
  priceBands: 0.08,
};

const GENERIC_SUBTYPES = new Set([
  "aura", "equipment", "vehicle", "food", "treasure", "clue", "blood",
  "saga", "class", "room", "background", "cartouche",
]);

const MAX_RECOMMENDATION_PAGE = 500;
const MAX_RECOMMENDATION_CYCLE = 100000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (_error) {
      return value.split(/[,;|]/).map(item => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function manaValueBucket(cmc) {
  const value = safeNumber(cmc);
  if (value <= 1) return "0–1";
  if (value <= 2) return "2";
  if (value <= 3) return "3";
  if (value <= 4) return "4";
  return "5+";
}

function priceBucket(price) {
  const value = safeNumber(price);
  if (value < 1) return "Under $1";
  if (value < 5) return "$1–5";
  if (value < 15) return "$5–15";
  if (value < 40) return "$15–40";
  return "$40+";
}

function mapCustomTag(tag) {
  const value = normalizeName(tag);
  if (!value) return null;
  if (/(ramp|mana rock|mana dork|ritual)/.test(value)) return { dimension: "roles", value: "Ramp" };
  if (/(card advantage|card draw|draw engine)/.test(value)) return { dimension: "roles", value: "Card Advantage" };
  if (/(card selection|filter|scry|surveil|loot|rummage)/.test(value)) return { dimension: "roles", value: "Card Selection" };
  if (/(single target removal|spot removal|interaction|counterspell)/.test(value)) return { dimension: "roles", value: "Single Target Removal" };
  if (/(mass removal|board wipe|sweeper)/.test(value)) return { dimension: "roles", value: "Mass Removal" };
  if (/(protection|protect)/.test(value)) return { dimension: "roles", value: "Protection" };
  if (/(tutor)/.test(value)) return { dimension: "roles", value: "Tutors" };
  if (/(wincon|finisher)/.test(value)) return { dimension: "roles", value: "Wincons / Finishers" };
  if (/(reanimation|reanimate)/.test(value)) return { dimension: "roles", value: "Reanimation" };
  if (/(recursion)/.test(value)) return { dimension: "roles", value: "Recursion" };
  if (/(stax|tax|hatebear)/.test(value)) return { dimension: "roles", value: "Stax" };
  if (/(graveyard filler|self.?mill)/.test(value)) return { dimension: "roles", value: "Graveyard Fillers" };
  if (/(sacrifice outlet)/.test(value)) return { dimension: "roles", value: "Sacrifice Outlets" };
  return { dimension: "themes", value: String(tag).trim() };
}

function extractCardFeatures(card = {}) {
  const typeLine = String(card.type_line || card.typeLine || "");
  const oracle = String(card.oracle_text || card.oracleText || "");
  const text = `${typeLine}\n${oracle}`.toLocaleLowerCase("en-US");
  const typeLower = typeLine.toLocaleLowerCase("en-US");
  const name = String(card.card_name || card.name || "");
  const roles = [];
  const themes = [];
  const types = [];

  [
    ["Creature", /\bcreature\b/],
    ["Instant", /\binstant\b/],
    ["Sorcery", /\bsorcery\b/],
    ["Artifact", /\bartifact\b/],
    ["Enchantment", /\benchantment\b/],
    ["Planeswalker", /\bplaneswalker\b/],
    ["Land", /\bland\b/],
    ["Battle", /\bbattle\b/],
  ].forEach(([label, rule]) => {
    if (rule.test(typeLower)) types.push(label);
  });

  const isLand = types.includes("Land");
  const isMassRemoval = /(destroy|exile|return) all|each creature gets|all creatures get|deals? \d+ damage to each creature/.test(text);
  // Spot removal per directive rule 5 = destroy/exile target or counter target spell.
  // Exclude graveyard recursion ("return target ... from your graveyard") and blink
  // ("exile target ... return it"), which are NOT removal.
  const isSpotRemoval = (/(destroy|exile) target|counter target spell|deals? \d+ damage to target/.test(text))
    && !/from (a|your) graveyard/.test(text)
    && !/exile target .+ return (it|that|them)/.test(text);

  if (!isLand && (
    /\badd \{?[wubrgc]\}?|add (one|two|three|an amount of) mana|treasure token/.test(text) ||
    /search your library for [^.\n]{0,55}(basic land|land card|forest card|plains card|island card|swamp card|mountain card)/.test(text) ||
    /you may play an additional land/.test(text)
  )) roles.push("Ramp");
  if (
    /draw (two|three|four|x|that many|a card for each)|whenever .+, draw a card|at the beginning of .+, draw/.test(text) ||
    /exile .+ you may play|look at the top .+ put .+ into your hand/.test(text)
  ) roles.push("Card Advantage");
  if (
    /\bscry\b|\bsurveil\b|look at the top \w+ cards|draw \w+ cards?, then discard|discard .+, then draw/.test(text)
  ) roles.push("Card Selection");
  if (isMassRemoval) roles.push("Mass Removal");
  else if (isSpotRemoval) roles.push("Single Target Removal");
  if (
    /gains? (hexproof|indestructible|protection from)|permanents? you control (gain|have)|phase out|counter target spell.*targets?/.test(text)
  ) roles.push("Protection");
  if (/search your library for (a|an|up to|any) (card|creature|artifact|enchantment|instant|sorcery)/.test(text)) roles.push("Tutors");
  if (/you win the game|opponent loses the game|take an extra turn|extra combat phase|life total becomes 0/.test(text)) roles.push("Wincons / Finishers");
  if (/return target .*card from (a|your) graveyard to (your hand|the top of your library)/.test(text)) roles.push("Recursion");
  if (/return target .*card from (a|your) graveyard to the battlefield|put target .*card from a graveyard onto the battlefield/.test(text)) roles.push("Reanimation");
  if (/mill \w+ cards|put the top \w+ cards? of your library into your graveyard/.test(text)) roles.push("Graveyard Fillers");
  if (/sacrifice (a|another|one or more) .+[:.,]|sacrifice .+:/.test(text)) roles.push("Sacrifice Outlets");
  if (/spells cost|can'?t cast|don'?t untap|can'?t untap|players can'?t|opponents can'?t|enters the battlefield tapped/.test(text)) roles.push("Stax");
  // A land is "Utility" only when it has a NON-mana ability. Every mana land has a
  // "{T}: Add ..." line, so the old `/:\s/` test mislabeled Command Tower/duals/fetches as
  // Utility Lands (directive rule 13 lists those under "Lands").
  if (isLand) {
    const landUtility = /can'?t be blocked|no maximum hand size|dredge|destroy target|exile target|add loyalty|:\s*(draw|scry|surveil|create|mill|sacrifice|deal|proliferate)/.test(text);
    roles.push(landUtility ? "Utility Lands" : "Lands");
  }

  if (/\bartifact\b|treasure|clue|food|vehicle|equipment/.test(text)) themes.push("Artifacts");
  if (/\benchantment\b|aura|constellation/.test(text)) themes.push("Enchantments");
  if (/\btoken\b|populate|create \w+ \d+\/\d+/.test(text)) themes.push("Tokens");
  if (/\+1\/\+1 counter|counter on|proliferate|double the number of counters/.test(text)) themes.push("Counters");
  if (/graveyard|mill|dredge|delirium|descend/.test(text)) themes.push("Graveyard");
  if (/sacrifice|dies|death trigger/.test(text)) themes.push("Sacrifice");
  if (/(instant|sorcery) spell|whenever you cast|copy target (instant|sorcery|spell)|magecraft|storm/.test(text)) themes.push("Spellslinger");
  if (/landfall|land enters|play an additional land|lands? you control/.test(text)) themes.push("Lands");
  if (/gain life|you gained life|lifelink/.test(text)) themes.push("Lifegain");
  if (/exile .+ then return|blink|flicker/.test(text)) themes.push("Blink / ETB");
  if (/equipment|equipped creature|aura attached|commander you control gets/.test(text)) themes.push("Voltron");
  if (/poison counter|toxic|infect|proliferate/.test(text)) themes.push("Poison");
  if (/mills?|library into (their|your) graveyard/.test(text)) themes.push("Mill");
  if (/gain control of|you control enchanted creature/.test(text)) themes.push("Theft");
  if (/energy counter|\{e\}/.test(text)) themes.push("Energy");
  if (/venture into the dungeon|take the initiative/.test(text)) themes.push("Dungeons");

  const subtypePart = typeLine.split(/[—-]/)[1] || "";
  const subtypes = subtypePart
    .split(/\s+/)
    .map(item => normalizeName(item.replace(/[^a-zA-Z'-]/g, "")))
    .filter(item => item.length > 2 && !GENERIC_SUBTYPES.has(item))
    .slice(0, 4);
  if (subtypes.length && types.includes("Creature")) {
    subtypes.forEach(subtype => themes.push(`Kindred: ${subtype[0].toUpperCase()}${subtype.slice(1)}`));
  }

  const customTags = [
    ...parseList(card.custom_tag || card.customTag),
    ...parseList(card.tags),
    ...parseList(card.deck_tags || card.deckTags),
  ];
  customTags.forEach(tag => {
    const mapped = mapCustomTag(tag);
    if (mapped?.dimension === "roles") roles.push(mapped.value);
    else if (mapped?.dimension === "themes") themes.push(mapped.value);
  });

  const rulesWithoutReminderText = oracle.replace(/\([^)]*\)/g, "");
  const rulesManaSymbols = [...rulesWithoutReminderText.matchAll(/\{([WUBRG])(?:\/[WUBRG])?\}/gi)]
    .map(match => match[1].toUpperCase());
  const colors = unique([...parseList(card.color_identity || card.colorIdentity || card.colors), ...rulesManaSymbols]
    .map(color => String(color).toUpperCase())
    .filter(color => ["W", "U", "B", "R", "G"].includes(color)));

  return {
    name,
    nameKey: normalizeName(name),
    colors,
    roles: unique(roles),
    themes: unique(themes),
    types: unique(types),
    manaValues: [manaValueBucket(card.cmc)],
    priceBands: [priceBucket(card.price ?? card.cheapest_card_price)],
    cmc: safeNumber(card.cmc),
    price: safeNumber(card.price ?? card.cheapest_card_price, 0.15),
    artist: String(card.artist || ""),
    isBasicLand: /\bbasic land\b/i.test(typeLine),
    isTokenLike: /\btoken\b/i.test(typeLine) || /\b(emblem|art series)\b/i.test(name),
  };
}

function emptyVector() {
  return {
    themes: new Map(),
    roles: new Map(),
    colors: new Map(),
    types: new Map(),
    manaValues: new Map(),
    priceBands: new Map(),
  };
}

function addToMap(map, key, value) {
  if (!key || !Number.isFinite(value) || value === 0) return;
  map.set(key, (map.get(key) || 0) + value);
}

function addFeatures(vector, features, amount) {
  Object.keys(DIMENSION_WEIGHTS).forEach(dimension => {
    const values = features[dimension] || [];
    const distributed = values.length > 0 ? amount / Math.sqrt(values.length) : 0;
    values.forEach(value => addToMap(vector[dimension], value, distributed));
  });
}

function finalizeVector(vector) {
  const result = {};
  Object.keys(DIMENSION_WEIGHTS).forEach(dimension => {
    const entries = [...vector[dimension].entries()].filter(([, value]) => value > 0);
    const max = Math.max(1, ...entries.map(([, value]) => value));
    result[dimension] = Object.fromEntries(entries.map(([key, value]) => [key, value / max]));
  });
  return result;
}

function topEntries(dimension, limit = 3) {
  return Object.entries(dimension || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, score]) => ({ name, score: Number(score.toFixed(3)) }));
}

function emptyDeckAccumulator(deck = {}) {
  return {
    id: deck.id || deck.deckId || "",
    name: deck.name || deck.deckName || "A deck",
    format: String(deck.format || "commander").toLocaleLowerCase("en-US"),
    positive: emptyVector(),
    negative: emptyVector(),
    roleCounts: new Map(),
    cardCount: 0,
    commanderColors: new Set(),
    allColors: new Set(),
    signals: 0,
  };
}

function createPreferenceProfile({
  playerId = "",
  signals = [],
  decks = [],
  followedArtists = [],
  searches = [],
} = {}) {
  const positive = emptyVector();
  const negative = emptyVector();
  const deckMap = new Map(decks.map(deck => {
    const accumulator = emptyDeckAccumulator(deck);
    return [accumulator.id, accumulator];
  }));
  const signalCounts = {};
  const deckCardNames = new Set();
  const ownedNames = new Set();
  const wishlistNames = new Set();
  const likedNames = new Set();
  const dislikedNames = new Set();
  const interactedNames = new Set();
  const artistScores = new Map();
  let explicitActions = 0;

  signals.forEach(signal => {
    const features = extractCardFeatures(signal.card || signal);
    const source = String(signal.source || "unknown");
    const polarity = safeNumber(signal.polarity, 1) >= 0 ? 1 : -1;
    const weight = Math.max(0, safeNumber(signal.weight, 1));
    const amount = weight * polarity;

    // Art votes compare printings of one card, so the card's type, colors and
    // mana value are identical across every option and carry no information.
    // They teach us about the illustrator and nothing else.
    if (signal.kind === "art") {
      const artistKey = normalizeName(signal.artist || features.artist);
      if (artistKey) {
        addToMap(artistScores, artistKey, amount);
        signalCounts[source] = (signalCounts[source] || 0) + 1;
      }
      return;
    }

    if (!features.nameKey) return;
    const destination = amount >= 0 ? positive : negative;
    addFeatures(destination, features, Math.abs(amount));
    signalCounts[source] = (signalCounts[source] || 0) + 1;
    interactedNames.add(features.nameKey);

    if (signal.explicit) {
      explicitActions += 1;
      if (polarity > 0) likedNames.add(features.nameKey);
      else if (source.includes("swipe")) dislikedNames.add(features.nameKey);
    }
    if (source === "own_deck") deckCardNames.add(features.nameKey);
    if (source === "collection") ownedNames.add(features.nameKey);
    if (source === "wishlist") wishlistNames.add(features.nameKey);

    if (signal.deckId) {
      if (!deckMap.has(signal.deckId)) {
        deckMap.set(signal.deckId, emptyDeckAccumulator({
          id: signal.deckId,
          name: signal.deckName,
          format: signal.format,
        }));
      }
      const deck = deckMap.get(signal.deckId);
      const deckDestination = amount >= 0 ? deck.positive : deck.negative;
      addFeatures(deckDestination, features, Math.abs(amount));
      deck.signals += 1;
      const quantity = clamp(safeNumber(signal.quantity, 1), 1, 4);
      deck.cardCount += quantity;
      features.roles.forEach(role => addToMap(deck.roleCounts, role, quantity));
      features.colors.forEach(color => deck.allColors.add(color));
      if (signal.isCommander) features.colors.forEach(color => deck.commanderColors.add(color));
    }
  });

  searches.forEach(search => {
    const query = String(search.query || search.entityKey || "");
    if (!query) return;
    const synthetic = {
      name: `Search: ${query}`,
      type_line: /\btype:(artifact|enchantment|creature|instant|sorcery|land)\b/i.exec(query)?.[1] || "",
      oracle_text: query.replace(/[:"]/g, " "),
      colors: (/\bid(?:=|<=|>=)([wubrg]+)/i.exec(query)?.[1] || "").toUpperCase().split(""),
      cmc: safeNumber(/\bmv(?:=|<=|>=|<|>)(\d+)/i.exec(query)?.[1], 3),
      price: safeNumber(/\busd(?:=|<=|>=|<|>)(\d+)/i.exec(query)?.[1], 5),
    };
    addFeatures(positive, extractCardFeatures(synthetic), 0.25 * clamp(safeNumber(search.occurrences, 1), 1, 4));
    signalCounts.search = (signalCounts.search || 0) + 1;
  });

  const finalizedDecks = [...deckMap.values()].filter(deck => deck.signals > 0).map(deck => {
    const colors = deck.commanderColors.size > 0 ? [...deck.commanderColors] : [...deck.allColors];
    const gaps = {};
    Object.entries(ROLE_TARGETS).forEach(([role, target]) => {
      const current = safeNumber(deck.roleCounts.get(role));
      gaps[role] = clamp((target - current) / target, 0, 1);
    });
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
    1 - Math.exp(-(
      distinctSignals * 0.055 +
      finalizedDecks.length * 0.30 +
      explicitActions * 0.10 +
      followedArtists.length * 0.12
    )),
    0,
    0.99
  );

  const artistPeak = Math.max(1, ...[...artistScores.values()].map(Math.abs));
  const artistAffinity = Object.fromEntries(
    [...artistScores.entries()].map(([artist, score]) => [artist, score / artistPeak])
  );

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

function dimensionMatch(vector, features) {
  let total = 0;
  Object.entries(DIMENSION_WEIGHTS).forEach(([dimension, dimensionWeight]) => {
    const values = features[dimension] || [];
    if (!values.length) return;
    const best = Math.max(0, ...values.map(value => safeNumber(vector?.[dimension]?.[value])));
    total += best * dimensionWeight;
  });
  return total;
}

function candidateFitsDeck(candidate, deck, rawCandidate = {}) {
  if (!deck) return true;
  const legalities = rawCandidate.legalities || {};
  const legality = legalities[deck.format];
  if (legality && !["legal", "restricted"].includes(legality)) return false;
  if (deck.format !== "commander" || deck.colors.length === 0) return true;
  return candidate.colors.every(color => deck.colors.includes(color));
}

function stableNoise(seed, value) {
  const input = `${seed}:${value}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function parseRecommendationCursor(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value || ""));
  if (!match) return { page: 1, cycle: 0 };
  return {
    page: clamp(Number.parseInt(match[1], 10) || 1, 1, MAX_RECOMMENDATION_PAGE),
    cycle: clamp(Number.parseInt(match[2], 10) || 0, 0, MAX_RECOMMENDATION_CYCLE),
  };
}

function formatRecommendationCursor({ page = 1, cycle = 0 } = {}) {
  return `${clamp(Math.floor(safeNumber(page, 1)), 1, MAX_RECOMMENDATION_PAGE)}:${clamp(Math.floor(safeNumber(cycle)), 0, MAX_RECOMMENDATION_CYCLE)}`;
}

function nextRecommendationCursor(cursor, hasMore) {
  const current = parseRecommendationCursor(formatRecommendationCursor(cursor));
  if (hasMore && current.page < MAX_RECOMMENDATION_PAGE) {
    return formatRecommendationCursor({ page: current.page + 1, cycle: current.cycle });
  }
  return formatRecommendationCursor({
    page: 1,
    cycle: current.cycle >= MAX_RECOMMENDATION_CYCLE ? 0 : current.cycle + 1,
  });
}

function profileReasonLabel(profile, features) {
  const theme = features.themes
    .map(value => ({ value, score: safeNumber(profile.positive.themes[value]) }))
    .sort((a, b) => b.score - a.score)[0];
  if (theme?.score > 0.15) return `Matches your ${theme.value.toLocaleLowerCase("en-US")} style`;
  const role = features.roles
    .map(value => ({ value, score: safeNumber(profile.positive.roles[value]) }))
    .sort((a, b) => b.score - a.score)[0];
  if (role?.score > 0.15) return `Matches your preference for ${role.value.toLocaleLowerCase("en-US")}`;
  return null;
}

function scoreRecommendations({
  profile,
  candidates = [],
  communityCounts = {},
  targetDeckId = "",
  limit = 24,
  offset = 0,
  seed = "grimore",
} = {}) {
  const normalizedLimit = clamp(Math.floor(safeNumber(limit, 24)), 1, 100);
  const normalizedOffset = Math.max(0, Math.floor(safeNumber(offset)));
  const selectionTarget = normalizedOffset + normalizedLimit;
  const targetDeck = targetDeckId ? profile.decks.find(deck => deck.id === targetDeckId) : null;
  const scored = [];

  candidates.forEach(candidate => {
    const features = extractCardFeatures(candidate);
    if (!features.nameKey || features.isTokenLike || features.isBasicLand) return;
    if (profile.dislikedNames.has(features.nameKey) && !profile.deckCardNames.has(features.nameKey)) return;

    const legalDecks = profile.decks.filter(deck => candidateFitsDeck(features, deck, candidate));
    if (targetDeck && !candidateFitsDeck(features, targetDeck, candidate)) return;
    if (!targetDeck && profile.decks.length > 0 && legalDecks.length === 0) return;

    const globalPositive = dimensionMatch(profile.positive, features);
    const globalNegative = dimensionMatch(profile.negative, features);
    const deckCandidates = targetDeck ? [targetDeck] : legalDecks;
    let bestDeck = null;
    let bestDeckFit = 0;
    deckCandidates.forEach(deck => {
      const fit = dimensionMatch(deck.positive, features) - dimensionMatch(deck.negative, features) * 0.6;
      if (fit > bestDeckFit || !bestDeck) {
        bestDeck = deck;
        bestDeckFit = fit;
      }
    });

    const gapMatches = bestDeck
      ? features.roles.map(role => ({ role, gap: safeNumber(bestDeck.gaps[role]) })).sort((a, b) => b.gap - a.gap)
      : [];
    const bestGap = gapMatches[0];
    const communityCount = safeNumber(communityCounts[features.nameKey]);
    const artistKey = features.artist ? normalizeName(features.artist) : "";
    const artistFollowed = artistKey && profile.followedArtists.has(artistKey);
    const artistTaste = artistKey ? safeNumber((profile.artistAffinity || {})[artistKey]) : 0;

    let rawScore =
      8 +
      globalPositive * 42 +
      bestDeckFit * 30 -
      globalNegative * 24 +
      (bestGap?.gap || 0) * 14 +
      Math.log1p(communityCount) * 2.5 +
      artistTaste * 9 +
      stableNoise(seed, features.nameKey) * 4;

    if (artistFollowed) rawScore += 11;
    if (profile.likedNames.has(features.nameKey)) rawScore += 12;
    if (profile.wishlistNames.has(features.nameKey)) rawScore += 14;
    if (profile.ownedNames.has(features.nameKey)) rawScore += 2;
    if (profile.deckCardNames.has(features.nameKey)) rawScore -= 7;

    const reasons = [];
    if (bestGap?.gap >= 0.25 && bestDeck) reasons.push(`Fills a ${bestGap.role.toLocaleLowerCase("en-US")} gap in ${bestDeck.name}`);
    if (bestDeck && bestDeckFit >= 0.12) reasons.push(`Fits ${bestDeck.name}`);
    const profileReason = profileReasonLabel(profile, features);
    if (profileReason) reasons.push(profileReason);
    if (artistFollowed) reasons.push(`Art from an illustrator you follow`);
    else if (artistTaste >= 0.35 && features.artist) reasons.push(`Artwork in a style you keep picking`);
    if (profile.wishlistNames.has(features.nameKey)) reasons.push("Already on your wishlist");
    else if (profile.ownedNames.has(features.nameKey)) reasons.push("You already own a copy");
    if (communityCount > 1) reasons.push(`Appears in ${communityCount} community decks`);
    if (reasons.length === 0) reasons.push(profile.coldStart ? "Popular starting point while Grimore learns your style" : "A discovery pick outside your usual pattern");

    scored.push({
      ...candidate,
      name: candidate.name || candidate.card_name,
      scryfallId: candidate.scryfallId || candidate.scryfall_id,
      type_line: candidate.type_line || "",
      oracle_text: candidate.oracle_text || "",
      mana_cost: candidate.mana_cost || "",
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
      _primaryTheme: features.themes[0] || "",
      _primaryRole: features.roles[0] || "",
      _primaryType: features.types[0] || "",
    });
  });

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = [];
  const dimensionCounts = { theme: new Map(), role: new Map(), type: new Map() };
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
    .map(({ _primaryTheme, _primaryRole, _primaryType, ...candidate }) => candidate);
}

function summarizeProfile(profile) {
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

module.exports = {
  ROLE_TARGETS,
  extractCardFeatures,
  createPreferenceProfile,
  parseRecommendationCursor,
  formatRecommendationCursor,
  nextRecommendationCursor,
  scoreRecommendations,
  summarizeProfile,
};
