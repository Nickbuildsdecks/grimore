/**
 * The legacy engine's own test suite (`test/recommendation-engine.test.js`), carried across to the
 * port, plus the cases the port adds. Keeping the legacy assertions verbatim is deliberate: they are
 * the only oracle that says the TypeScript rewrite classifies cards the same way the shipped engine
 * does, and every one of them pins a classification rule that was got wrong at least once.
 */
import { describe, it, expect } from 'vitest';
import {
  createPreferenceProfile,
  extractCardFeatures,
  nextRecommendationCursor,
  parseRecommendationCursor,
  scoreRecommendations,
  summarizeProfile,
} from './index.js';

describe('feature extraction', () => {
  it('classifies functional roles without treating normal lands as ramp', () => {
    const ramp = extractCardFeatures({
      name: 'Cultivate',
      type_line: 'Sorcery',
      oracle_text:
        'Search your library for up to two basic land cards, put one onto the battlefield tapped and the other into your hand.',
      colors: ['G'],
      cmc: 3,
    });
    const land = extractCardFeatures({
      name: 'Command Tower',
      type_line: 'Land',
      oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
      colors: [],
      cmc: 0,
    });

    expect(ramp.roles).toContain('Ramp');
    expect(land.roles).not.toContain('Ramp');
    // Command Tower is a pure mana land, so it belongs in "Lands" and not "Utility Lands".
    expect(land.roles).toContain('Lands');
    expect(land.roles).not.toContain('Utility Lands');
  });

  it('spot removal excludes graveyard recursion and blink', () => {
    const removal = extractCardFeatures({
      name: 'Swords to Plowshares',
      type_line: 'Instant',
      oracle_text: 'Exile target creature. Its controller gains life equal to its power.',
      colors: ['W'],
      cmc: 1,
    });
    const recursion = extractCardFeatures({
      name: 'Eternal Witness',
      type_line: 'Creature — Human Shaman',
      oracle_text:
        'When Eternal Witness enters the battlefield, return target card from your graveyard to your hand.',
      colors: ['G'],
      cmc: 3,
    });
    const blink = extractCardFeatures({
      name: 'Ephemerate',
      type_line: 'Instant',
      oracle_text: "Exile target creature you control, then return it to the battlefield under its owner's control.",
      colors: ['W'],
      cmc: 1,
    });

    expect(removal.roles).toContain('Single Target Removal');
    expect(recursion.roles).not.toContain('Single Target Removal');
    expect(recursion.roles).toContain('Recursion');
    expect(blink.roles).not.toContain('Single Target Removal');
  });

  it('utility land requires a non-mana ability', () => {
    const utility = extractCardFeatures({
      name: 'Bojuka Bog',
      type_line: 'Land',
      oracle_text:
        "Bojuka Bog enters the battlefield tapped. When Bojuka Bog enters, exile target player's graveyard. {T}: Add {B}.",
      colors: [],
      cmc: 0,
    });
    const dual = extractCardFeatures({
      name: 'Watery Grave',
      type_line: 'Land — Island Swamp',
      oracle_text:
        "({T}: Add {U} or {B}.) As Watery Grave enters, you may pay 2 life. If you don't, it enters tapped.",
      colors: [],
      cmc: 0,
    });
    expect(utility.roles).toContain('Utility Lands');
    expect(dual.roles).toContain('Lands');
    expect(dual.roles).not.toContain('Utility Lands');
  });

  it('reads colour from rules text but ignores reminder text', () => {
    // The parenthesised reminder on a dual land names {U} and {B}, which are not the card's identity.
    const dual = extractCardFeatures({
      name: 'Watery Grave',
      type_line: 'Land — Island Swamp',
      oracle_text: '({T}: Add {U} or {B}.)',
      colors: [],
      cmc: 0,
    });
    expect(dual.colors).toEqual([]);

    const activated = extractCardFeatures({
      name: 'Some Sink',
      type_line: 'Artifact',
      oracle_text: 'Pay {U}: Draw a card.',
      colors: [],
      cmc: 2,
    });
    expect(activated.colors).toEqual(['U']);
  });

  it('accepts list columns as JSON text or as a delimited string', () => {
    const json = extractCardFeatures({ name: 'A', type_line: 'Creature — Elf', colors: '["G"]', cmc: 1 });
    const delimited = extractCardFeatures({ name: 'B', type_line: 'Creature — Elf', colors: 'G,U', cmc: 1 });
    expect(json.colors).toEqual(['G']);
    expect(delimited.colors).toEqual(['G', 'U']);
  });
});

describe('preference profile', () => {
  it('keeps separate deck fingerprints instead of blending incompatible decks', () => {
    const profile = createPreferenceProfile({
      playerId: 'player-1',
      decks: [
        { id: 'lands', name: 'Worldsoul Lands', format: 'commander' },
        { id: 'artifacts', name: 'Etherium Engine', format: 'commander' },
      ],
      signals: [
        {
          source: 'own_deck',
          deckId: 'lands',
          deckName: 'Worldsoul Lands',
          isCommander: true,
          weight: 5,
          card: {
            name: 'Green Commander',
            type_line: 'Legendary Creature',
            oracle_text: 'Landfall — create a token.',
            colors: ['G'],
            cmc: 4,
          },
        },
        {
          source: 'own_deck',
          deckId: 'lands',
          deckName: 'Worldsoul Lands',
          weight: 2,
          card: {
            name: 'Cultivate',
            type_line: 'Sorcery',
            oracle_text: 'Search your library for two basic land cards.',
            colors: ['G'],
            cmc: 3,
          },
        },
        {
          source: 'own_deck',
          deckId: 'artifacts',
          deckName: 'Etherium Engine',
          isCommander: true,
          weight: 5,
          card: {
            name: 'Blue Commander',
            type_line: 'Legendary Artifact Creature',
            oracle_text: 'Whenever you cast an artifact spell, draw a card.',
            colors: ['U'],
            cmc: 4,
          },
        },
        {
          source: 'own_deck',
          deckId: 'artifacts',
          deckName: 'Etherium Engine',
          weight: 2,
          card: {
            name: 'Thought Monitor',
            type_line: 'Artifact Creature',
            oracle_text: 'When this enters, draw two cards.',
            colors: ['U'],
            cmc: 7,
          },
        },
      ],
    });

    expect(profile.decks).toHaveLength(2);
    expect(profile.decks.find((deck) => deck.id === 'lands')!.colors).toEqual(['G']);
    expect(profile.decks.find((deck) => deck.id === 'artifacts')!.colors).toEqual(['U']);
    expect(profile.decks.find((deck) => deck.id === 'lands')!.positive.themes.Lands).toBeGreaterThan(0);
    expect(profile.decks.find((deck) => deck.id === 'artifacts')!.positive.themes.Artifacts).toBeGreaterThan(0);
  });

  it('reports a transparent cold-start profile', () => {
    const profile = createPreferenceProfile({ playerId: 'new-player' });
    const summary = summarizeProfile(profile);

    expect(summary.coldStart).toBe(true);
    expect(summary.decksLearned).toBe(0);
    expect(summary.confidence).toBe(0);
  });

  it('routes an art vote to the illustrator and not to the gameplay dimensions', () => {
    const profile = createPreferenceProfile({
      playerId: 'voter',
      signals: [
        {
          kind: 'art',
          source: 'art_swipe',
          explicit: true,
          weight: 2,
          artist: 'Rebecca Guay',
          card: { name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', cmc: 1 },
        },
      ],
    });

    // The vote was between printings of one card, so it says nothing about artifacts.
    expect(profile.positive.themes.Artifacts).toBeUndefined();
    expect(profile.artistAffinity['rebecca guay']).toBeGreaterThan(0);
  });
});

describe('scoring', () => {
  it('respects target-deck color identity, fills gaps, and honors swipe passes', () => {
    const profile = createPreferenceProfile({
      playerId: 'player-2',
      decks: [{ id: 'green', name: 'Green Value', format: 'commander' }],
      followedArtists: ['Favorite Artist'],
      signals: [
        {
          source: 'own_deck',
          deckId: 'green',
          deckName: 'Green Value',
          isCommander: true,
          weight: 5,
          card: {
            name: 'Green Commander',
            type_line: 'Legendary Creature',
            oracle_text: 'Landfall — draw a card.',
            colors: ['G'],
            cmc: 4,
          },
        },
        {
          source: 'discover_swipe',
          explicit: true,
          polarity: -1,
          weight: 3.5,
          card: {
            name: 'Passed Ramp',
            type_line: 'Sorcery',
            oracle_text: 'Search your library for a basic land card.',
            colors: ['G'],
            cmc: 2,
          },
        },
      ],
    });

    const cards = scoreRecommendations({
      profile,
      targetDeckId: 'green',
      limit: 8,
      seed: 'test',
      candidates: [
        {
          name: "Nature's Lore",
          type_line: 'Sorcery',
          oracle_text: 'Search your library for a Forest card and put it onto the battlefield.',
          colors: ['G'],
          cmc: 2,
          price: 2,
          artist: 'Favorite Artist',
        },
        {
          name: 'Passed Ramp',
          type_line: 'Sorcery',
          oracle_text: 'Search your library for a basic land card.',
          colors: ['G'],
          cmc: 2,
          price: 1,
        },
        {
          name: 'Lightning Bolt',
          type_line: 'Instant',
          oracle_text: 'Lightning Bolt deals 3 damage to any target.',
          colors: ['R'],
          cmc: 1,
          price: 1,
        },
        {
          name: 'Banned Green Card',
          type_line: 'Sorcery',
          oracle_text: 'Search your library for a Forest card.',
          colors: ['G'],
          cmc: 2,
          price: 1,
          legalities: { commander: 'banned' },
        },
      ],
    });

    expect(cards.map((card) => card.name)).toEqual(["Nature's Lore"]);
    expect(cards[0].reasons.some((reason) => reason.includes('ramp gap'))).toBe(true);
    expect(cards[0].reasons.some((reason) => reason.includes('illustrator'))).toBe(true);
    expect(cards[0].targetDeck!.id).toBe('green');
  });

  it('enforces the ban list when legalities arrive as JSON text, as the local cache stores them', () => {
    // scryfall_cards.legalities is a TEXT column. Legacy indexed the string by format name, got
    // undefined, and read that as "no legality recorded" — so a banned card passed the filter the
    // moment candidates came from the local cache rather than the Scryfall API.
    const profile = createPreferenceProfile({
      playerId: 'player-3',
      decks: [{ id: 'green', name: 'Green Value', format: 'commander' }],
      signals: [
        {
          source: 'own_deck',
          deckId: 'green',
          deckName: 'Green Value',
          isCommander: true,
          weight: 5,
          card: { name: 'Green Commander', type_line: 'Legendary Creature', oracle_text: 'Landfall.', colors: ['G'], cmc: 4 },
        },
      ],
    });

    const cards = scoreRecommendations({
      profile,
      targetDeckId: 'green',
      limit: 8,
      seed: 'ban-test',
      candidates: [
        {
          name: 'Legal Green Card',
          type_line: 'Sorcery',
          oracle_text: 'Search your library for a Forest card.',
          colors: ['G'],
          cmc: 2,
          price: 1,
          legalities: JSON.stringify({ commander: 'legal' }),
        },
        {
          name: 'Banned Green Card',
          type_line: 'Sorcery',
          oracle_text: 'Search your library for a Forest card.',
          colors: ['G'],
          cmc: 2,
          price: 1,
          legalities: JSON.stringify({ commander: 'banned' }),
        },
      ],
    });

    expect(cards.map((card) => card.name)).toEqual(['Legal Green Card']);
  });

  it('says a card is already wished for, and scores it above an identical card that is not', () => {
    const profile = createPreferenceProfile({
      playerId: 'wisher',
      signals: [
        {
          source: 'wishlist',
          weight: 1.8,
          explicit: true,
          card: { name: 'Wished Card', type_line: 'Instant', oracle_text: 'Counter target spell.', colors: ['U'], cmc: 2 },
        },
      ],
    });

    const cards = scoreRecommendations({
      profile,
      limit: 4,
      seed: 'wishlist-test',
      candidates: [
        { name: 'Wished Card', type_line: 'Instant', oracle_text: 'Counter target spell.', colors: ['U'], cmc: 2, price: 1 },
        { name: 'Other Card', type_line: 'Instant', oracle_text: 'Counter target spell.', colors: ['U'], cmc: 2, price: 1 },
      ],
    });

    const wished = cards.find((card) => card.name === 'Wished Card')!;
    const other = cards.find((card) => card.name === 'Other Card')!;
    expect(wished.reasons).toContain('Already on your wishlist');
    expect(wished.score).toBeGreaterThan(other.score);
  });

  it('caps the reasons at three, most specific first', () => {
    // A card can match a gap, a deck, a style, an illustrator and a wishlist at once. Showing all of
    // them is noise, so the list is truncated — which is why the route tests assert the score rather
    // than a particular phrase.
    const profile = createPreferenceProfile({
      playerId: 'many-reasons',
      decks: [{ id: 'd1', name: 'Value Deck', format: 'commander' }],
      followedArtists: ['Favorite Artist'],
      signals: [
        {
          source: 'own_deck',
          deckId: 'd1',
          deckName: 'Value Deck',
          isCommander: true,
          weight: 5,
          card: { name: 'Blue Commander', type_line: 'Legendary Creature', oracle_text: 'Whenever you cast an artifact spell, draw a card.', colors: ['U'], cmc: 4 },
        },
        {
          source: 'wishlist',
          weight: 1.8,
          explicit: true,
          card: { name: 'Everything Card', type_line: 'Artifact', oracle_text: 'Search your library for a card. Draw two cards.', colors: ['U'], cmc: 3 },
        },
      ],
    });

    const [card] = scoreRecommendations({
      profile,
      limit: 1,
      seed: 'reasons-test',
      candidates: [
        {
          name: 'Everything Card',
          type_line: 'Artifact',
          oracle_text: 'Search your library for a card. Draw two cards.',
          colors: ['U'],
          cmc: 3,
          price: 2,
          artist: 'Favorite Artist',
        },
      ],
    });

    expect(card.reasons.length).toBeLessThanOrEqual(3);
    expect(new Set(card.reasons).size).toBe(card.reasons.length);
  });

  it('advances recommendation cursors and starts a new cycle after exhaustion', () => {
    expect(parseRecommendationCursor('not-a-cursor')).toEqual({ page: 1, cycle: 0 });
    expect(parseRecommendationCursor('7:3')).toEqual({ page: 7, cycle: 3 });
    expect(nextRecommendationCursor({ page: 7, cycle: 3 }, true)).toBe('8:3');
    expect(nextRecommendationCursor({ page: 7, cycle: 3 }, false)).toBe('1:4');
  });

  it('returns non-overlapping scored pages from the local fallback pool', () => {
    const profile = createPreferenceProfile({ playerId: 'endless-player' });
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      name: `Discovery Card ${index + 1}`,
      type_line: index % 2 === 0 ? 'Creature — Wizard' : 'Instant',
      oracle_text: index % 2 === 0 ? 'When this enters, draw two cards.' : 'Destroy target creature.',
      colors: index % 3 === 0 ? ['U'] : ['B'],
      cmc: (index % 5) + 1,
      price: index + 1,
    }));

    const firstPage = scoreRecommendations({ profile, candidates, limit: 8, offset: 0, seed: 'endless-test' });
    const secondPage = scoreRecommendations({ profile, candidates, limit: 8, offset: 8, seed: 'endless-test' });

    expect(firstPage).toHaveLength(8);
    expect(secondPage).toHaveLength(8);
    expect(firstPage.map((card) => card.name).filter((name) => secondPage.some((card) => card.name === name))).toEqual(
      [],
    );
  });

  it('drops tokens and basic lands from the candidate pool', () => {
    const profile = createPreferenceProfile({ playerId: 'filter-player' });
    const cards = scoreRecommendations({
      profile,
      limit: 8,
      seed: 'filter',
      candidates: [
        { name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.', cmc: 0, price: 0.1 },
        { name: 'Goblin', type_line: 'Token Creature — Goblin', oracle_text: '', cmc: 0, price: 0.05 },
        { name: 'Real Card', type_line: 'Instant', oracle_text: 'Destroy target creature.', cmc: 2, price: 1 },
      ],
    });
    expect(cards.map((card) => card.name)).toEqual(['Real Card']);
  });
});
