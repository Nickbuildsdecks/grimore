const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractCardFeatures,
  createPreferenceProfile,
  parseRecommendationCursor,
  nextRecommendationCursor,
  scoreRecommendations,
  summarizeProfile,
} = require("../execution/recommendation_engine");

test("classifies functional roles without treating normal lands as ramp", () => {
  const ramp = extractCardFeatures({
    name: "Cultivate",
    type_line: "Sorcery",
    oracle_text: "Search your library for up to two basic land cards, put one onto the battlefield tapped and the other into your hand.",
    colors: ["G"],
    cmc: 3,
  });
  const land = extractCardFeatures({
    name: "Command Tower",
    type_line: "Land",
    oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
    colors: [],
    cmc: 0,
  });

  assert.ok(ramp.roles.includes("Ramp"));
  assert.ok(!land.roles.includes("Ramp"));
  assert.ok(land.roles.includes("Utility Lands"));
});

test("keeps separate deck fingerprints instead of blending incompatible decks", () => {
  const profile = createPreferenceProfile({
    playerId: "player-1",
    decks: [
      { id: "lands", name: "Worldsoul Lands", format: "commander" },
      { id: "artifacts", name: "Etherium Engine", format: "commander" },
    ],
    signals: [
      {
        source: "own_deck",
        deckId: "lands",
        deckName: "Worldsoul Lands",
        isCommander: true,
        weight: 5,
        card: { name: "Green Commander", type_line: "Legendary Creature", oracle_text: "Landfall — create a token.", colors: ["G"], cmc: 4 },
      },
      {
        source: "own_deck",
        deckId: "lands",
        deckName: "Worldsoul Lands",
        weight: 2,
        card: { name: "Cultivate", type_line: "Sorcery", oracle_text: "Search your library for two basic land cards.", colors: ["G"], cmc: 3 },
      },
      {
        source: "own_deck",
        deckId: "artifacts",
        deckName: "Etherium Engine",
        isCommander: true,
        weight: 5,
        card: { name: "Blue Commander", type_line: "Legendary Artifact Creature", oracle_text: "Whenever you cast an artifact spell, draw a card.", colors: ["U"], cmc: 4 },
      },
      {
        source: "own_deck",
        deckId: "artifacts",
        deckName: "Etherium Engine",
        weight: 2,
        card: { name: "Thought Monitor", type_line: "Artifact Creature", oracle_text: "When this enters, draw two cards.", colors: ["U"], cmc: 7 },
      },
    ],
  });

  assert.equal(profile.decks.length, 2);
  assert.deepEqual(profile.decks.find(deck => deck.id === "lands").colors, ["G"]);
  assert.deepEqual(profile.decks.find(deck => deck.id === "artifacts").colors, ["U"]);
  assert.ok(profile.decks.find(deck => deck.id === "lands").positive.themes.Lands > 0);
  assert.ok(profile.decks.find(deck => deck.id === "artifacts").positive.themes.Artifacts > 0);
});

test("respects target-deck color identity, fills gaps, and honors swipe passes", () => {
  const profile = createPreferenceProfile({
    playerId: "player-2",
    decks: [{ id: "green", name: "Green Value", format: "commander" }],
    followedArtists: ["Favorite Artist"],
    signals: [
      {
        source: "own_deck",
        deckId: "green",
        deckName: "Green Value",
        isCommander: true,
        weight: 5,
        card: { name: "Green Commander", type_line: "Legendary Creature", oracle_text: "Landfall — draw a card.", colors: ["G"], cmc: 4 },
      },
      {
        source: "discover_swipe",
        explicit: true,
        polarity: -1,
        weight: 3.5,
        card: { name: "Passed Ramp", type_line: "Sorcery", oracle_text: "Search your library for a basic land card.", colors: ["G"], cmc: 2 },
      },
    ],
  });

  const cards = scoreRecommendations({
    profile,
    targetDeckId: "green",
    limit: 8,
    seed: "test",
    candidates: [
      { name: "Nature's Lore", type_line: "Sorcery", oracle_text: "Search your library for a Forest card and put it onto the battlefield.", colors: ["G"], cmc: 2, price: 2, artist: "Favorite Artist" },
      { name: "Passed Ramp", type_line: "Sorcery", oracle_text: "Search your library for a basic land card.", colors: ["G"], cmc: 2, price: 1 },
      { name: "Lightning Bolt", type_line: "Instant", oracle_text: "Lightning Bolt deals 3 damage to any target.", colors: ["R"], cmc: 1, price: 1 },
      { name: "Banned Green Card", type_line: "Sorcery", oracle_text: "Search your library for a Forest card.", colors: ["G"], cmc: 2, price: 1, legalities: { commander: "banned" } },
    ],
  });

  assert.deepEqual(cards.map(card => card.name), ["Nature's Lore"]);
  assert.ok(cards[0].reasons.some(reason => reason.includes("ramp gap")));
  assert.ok(cards[0].reasons.some(reason => reason.includes("illustrator")));
  assert.equal(cards[0].targetDeck.id, "green");
});

test("reports a transparent cold-start profile", () => {
  const profile = createPreferenceProfile({ playerId: "new-player" });
  const summary = summarizeProfile(profile);

  assert.equal(summary.coldStart, true);
  assert.equal(summary.decksLearned, 0);
  assert.equal(summary.confidence, 0);
});

test("advances recommendation cursors and starts a new cycle after exhaustion", () => {
  assert.deepEqual(parseRecommendationCursor("not-a-cursor"), { page: 1, cycle: 0 });
  assert.deepEqual(parseRecommendationCursor("7:3"), { page: 7, cycle: 3 });
  assert.equal(nextRecommendationCursor({ page: 7, cycle: 3 }, true), "8:3");
  assert.equal(nextRecommendationCursor({ page: 7, cycle: 3 }, false), "1:4");
});

test("returns non-overlapping scored pages from the local fallback pool", () => {
  const profile = createPreferenceProfile({ playerId: "endless-player" });
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    name: `Discovery Card ${index + 1}`,
    type_line: index % 2 === 0 ? "Creature — Wizard" : "Instant",
    oracle_text: index % 2 === 0 ? "When this enters, draw two cards." : "Destroy target creature.",
    colors: index % 3 === 0 ? ["U"] : ["B"],
    cmc: (index % 5) + 1,
    price: index + 1,
  }));

  const firstPage = scoreRecommendations({
    profile,
    candidates,
    limit: 8,
    offset: 0,
    seed: "endless-test",
  });
  const secondPage = scoreRecommendations({
    profile,
    candidates,
    limit: 8,
    offset: 8,
    seed: "endless-test",
  });

  assert.equal(firstPage.length, 8);
  assert.equal(secondPage.length, 8);
  assert.deepEqual(
    firstPage.map(card => card.name).filter(name => secondPage.some(card => card.name === name)),
    []
  );
});
