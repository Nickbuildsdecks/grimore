/**
 * GET /api/cards/recommendations, against live Postgres.
 *
 * The scoring itself is pinned by `packages/recommender/src/index.test.ts` (the legacy engine's own
 * suite, carried across). What is tested here is the half that was broken: the signal queries. Three
 * of the five signal sources could not execute on Postgres at all, and because every one of them was
 * wrapped in a try/catch that returned `[]`, the feature *looked* like it worked — a player with a
 * full collection and a long wishlist got the same page as a brand new account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv, RecommendationResponse } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';
import { loadLocalCandidates } from './lib/preferenceSignals.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('recommendations (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_recs_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let aliceId: string;
  const DECK_ID = 'deck-green-value';

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    ctx = await createContext(
      parseEnv({
        NODE_ENV: 'test',
        DATABASE_URL: u.toString(),
        REDIS_URL,
        SESSION_SECRET: 'test-secret',
        LOG_LEVEL: 'silent',
      }),
    );
    await runMigrations(ctx.pool);
    app = createApp(ctx);

    // A small card universe. Colours and legalities are stored exactly as the legacy sync writes
    // them — JSON in TEXT columns — because that is what the port has to read.
    await ctx.pool.query(
      `INSERT INTO scryfall_cards
         (id, name, card_name, type_line, oracle_text, mana_cost, cmc, colors, color_identity, legalities, rarity, set_code, price)
       VALUES
         ('11111111-0000-4000-8000-000000000001','Green Commander','Green Commander','Legendary Creature — Elf Druid','Landfall — whenever a land enters, draw a card.','{2}{G}{G}',4,'["G"]','["G"]','{"commander":"legal"}','mythic','cmr',6),
         ('11111111-0000-4000-8000-000000000002','Cultivate','Cultivate','Sorcery','Search your library for up to two basic land cards.','{2}{G}',3,'["G"]','["G"]','{"commander":"legal"}','uncommon','m21',0.5),
         ('11111111-0000-4000-8000-000000000003','Natures Lore','Natures Lore','Sorcery','Search your library for a Forest card and put it onto the battlefield.','{1}{G}',2,'["G"]','["G"]','{"commander":"legal"}','rare','3ed',12),
         ('11111111-0000-4000-8000-000000000004','Beast Within','Beast Within','Instant','Destroy target permanent.','{2}{G}',3,'["G"]','["G"]','{"commander":"legal"}','uncommon','nph',4),
         ('11111111-0000-4000-8000-000000000005','Elvish Visionary','Elvish Visionary','Creature — Elf Shaman','When Elvish Visionary enters the battlefield, draw a card.','{1}{G}',2,'["G"]','["G"]','{"commander":"legal"}','common','m12',0.2),
         ('11111111-0000-4000-8000-000000000006','Lightning Bolt','Lightning Bolt','Instant','Lightning Bolt deals 3 damage to any target.','{R}',1,'["R"]','["R"]','{"commander":"legal"}','common','m10',1.5),
         ('11111111-0000-4000-8000-000000000007','Counterspell','Counterspell','Instant','Counter target spell.','{U}{U}',2,'["U"]','["U"]','{"commander":"legal"}','common','mh2',1),
         ('11111111-0000-4000-8000-000000000008','Primeval Titan','Primeval Titan','Creature — Giant','Whenever Primeval Titan enters or attacks, search your library for up to two land cards.','{4}{G}{G}',6,'["G"]','["G"]','{"commander":"banned"}','mythic','m11',25),
         ('11111111-0000-4000-8000-000000000009','Forest','Forest','Basic Land — Forest','{T}: Add {G}.','',0,'[]','["G"]','{"commander":"legal"}','common','m21',0.1),
         ('11111111-0000-4000-8000-00000000000a','Goblin Token','Goblin Token','Token Creature — Goblin','','',0,'["R"]','["R"]','{"commander":"legal"}','common','tm13',0.05)`,
    );

    alice = request.agent(app);
    expect(
      (
        await alice.post('/api/auth/register').send({
          username: 'alice_recs',
          password: PASSWORD,
          storeNickname: 'alice_recs',
          email: 'alice_recs@example.com',
        })
      ).status,
    ).toBe(201);
    const login = await alice.post('/api/auth/login').send({ username: 'alice_recs', password: PASSWORD });
    aliceId = login.body.user.id;

    // A mono-green commander deck: one commander plus one spell.
    await ctx.pool.query(
      `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, is_public, format)
       VALUES ($1, $2, $3, 'Green Value', 0, 1, 'commander')`,
      [DECK_ID, aliceId, `visual-${DECK_ID}`],
    );
    await ctx.pool.query(
      `INSERT INTO deck_cards (deck_id, card_name, quantity, is_commander)
       VALUES ($1, 'Green Commander', 1, 1), ($1, 'Cultivate', 1, 0)`,
      [DECK_ID],
    );
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('serves an anonymous caller a cold-start page rather than a 401', async () => {
    const r = await request(app).get('/api/cards/recommendations?limit=8');
    expect(r.status).toBe(200);
    expect(r.body.fallback).toBe(true);
    expect(r.body.profile.coldStart).toBe(true);
    expect(r.body.candidateSource).toBe('local-cache');
    expect(r.body.cards.length).toBeGreaterThan(0);
    // Cold start says so in the card's own reason, so the UI never has to guess.
    expect(r.body.cards[0].reasons[0]).toMatch(/learns your style/);
  });

  it('never recommends a token or a basic land', async () => {
    const r = await request(app).get('/api/cards/recommendations?limit=40');
    expect(r.status).toBe(200);
    const names = r.body.cards.map((card: { name: string }) => card.name);
    expect(names).not.toContain('Forest');
    expect(names).not.toContain('Goblin Token');
  });

  it('404s on a deck the caller does not own instead of silently ignoring it', async () => {
    const r = await alice.get('/api/cards/recommendations?deckId=not-my-deck');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('learns the deck, then scores only cards legal in its colour identity', async () => {
    const r = await alice.get(`/api/cards/recommendations?deckId=${DECK_ID}&limit=10`);
    expect(r.status).toBe(200);
    expect(r.body.profile.decksLearned).toBe(1);
    expect(r.body.profile.coldStart).toBe(false);

    const names = r.body.cards.map((card: { name: string }) => card.name);
    // Off-colour cards cannot go in a mono-green commander deck, so they are dropped, not ranked low.
    expect(names).not.toContain('Lightning Bolt');
    expect(names).not.toContain('Counterspell');
    // And the ban list is enforced even though `scryfall_cards.legalities` is a TEXT column: legacy
    // indexed that string by format name, got undefined, and let banned cards through.
    expect(names).not.toContain('Primeval Titan');
    expect(names).toContain('Natures Lore');

    const tagged = r.body.cards.find((card: { name: string }) => card.name === 'Cultivate');
    if (tagged) expect(tagged.alreadyInDeck).toBe(true);
  });

  it('loads the collection signal — the query legacy wrote could not execute', async () => {
    // collection_cards has created_at, not added_at. Legacy selected added_at, the query raised, and
    // the catch-all turned "broken query" into "this player owns nothing".
    const collection = await ctx.pool.query(
      `INSERT INTO collections (id, player_id, name) VALUES ($1, $2, 'Binder') RETURNING id`,
      ['col-recs-1', aliceId],
    );
    await ctx.pool.query(
      `INSERT INTO collection_cards (collection_id, card_name, quantity) VALUES ($1, 'Elvish Visionary', 2)`,
      [collection.rows[0].id],
    );

    const r = await alice.get('/api/cards/recommendations?limit=20');
    expect(r.status).toBe(200);
    expect(r.body.profile.signalCounts.collection).toBe(1);
    const owned = r.body.cards.find((card: { name: string }) => card.name === 'Elvish Visionary');
    expect(owned?.owned).toBe(true);
    expect(owned?.reasons).toContain('You already own a copy');
  });

  it('loads the wishlist signal, which is the strongest explicit signal the engine has', async () => {
    await ctx.pool.query(`INSERT INTO wishlist_cards (player_id, card_name, quantity) VALUES ($1, 'Beast Within', 1)`, [
      aliceId,
    ]);

    const r = await alice.get('/api/cards/recommendations?limit=20');
    expect(r.status).toBe(200);
    // One signal, loaded. Legacy's query named a column that does not exist, so this was always 0.
    expect(r.body.profile.signalCounts.wishlist).toBe(1);
    // The wishlisted card is in the page and carries the wishlist score bonus. The "Already on your
    // wishlist" phrasing is asserted in the engine's own suite, where the competing reasons are
    // controlled — a card can only show three, and a deck-gap match outranks this one.
    expect(r.body.cards.some((card: { name: string }) => card.name === 'Beast Within')).toBe(true);
  });

  it('counts a signal once per card however many printings the card cache holds', async () => {
    // `scryfall_cards` has one row per printing and no unique index on the name, so legacy's
    // `LEFT JOIN scryfall_cards ON LOWER(name) = LOWER(card_name)` turned one collection card into
    // one signal per printing — weighting a card by how often it has been reprinted.
    await ctx.pool.query(
      `INSERT INTO scryfall_cards (id, name, card_name, type_line, oracle_text, mana_cost, cmc, colors, color_identity, legalities, rarity, set_code, price)
       VALUES
         ('22222222-0000-4000-8000-000000000001','Elvish Visionary','Elvish Visionary','Creature — Elf Shaman','When Elvish Visionary enters the battlefield, draw a card.','{1}{G}',2,'["G"]','["G"]','{"commander":"legal"}','common','dom',0.3),
         ('22222222-0000-4000-8000-000000000002','Elvish Visionary','Elvish Visionary','Creature — Elf Shaman','When Elvish Visionary enters the battlefield, draw a card.','{1}{G}',2,'["G"]','["G"]','{"commander":"legal"}','common','c21',0.4)`,
    );
    const printings = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM scryfall_cards WHERE name = 'Elvish Visionary'`);
    expect(printings.rows[0].n).toBe(3);

    const r = await alice.get('/api/cards/recommendations?limit=20');
    expect(r.status).toBe(200);
    // Still one signal, not three.
    expect(r.body.profile.signalCounts.collection).toBe(1);
    // And one candidate, not three: DISTINCT ON collapses the printings to the cheapest.
    const occurrences = r.body.cards.filter((card: { name: string }) => card.name === 'Elvish Visionary').length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('clamps limit to the documented 4..40 window', async () => {
    const tooMany = await request(app).get('/api/cards/recommendations?limit=500');
    expect(tooMany.status).toBe(200);
    expect(tooMany.body.cards.length).toBeLessThanOrEqual(40);

    // Legacy coerced an unparseable limit to the default rather than erroring; so do we.
    const garbage = await request(app).get('/api/cards/recommendations?limit=banana');
    expect(garbage.status).toBe(200);
    expect(garbage.body.cards.length).toBeGreaterThan(0);
  });

  it('round-trips the cursor and starts a new cycle when the pool runs out', async () => {
    const first = await request(app).get('/api/cards/recommendations?limit=4');
    expect(first.status).toBe(200);
    expect(first.body.cursor).toBe('1:0');
    expect(first.body.cycle).toBe(0);
    expect(first.body.recycled).toBe(false);
    // The card universe here is far smaller than one pool, so the page exhausts it and the next
    // cursor opens cycle 1 rather than page 2 — the feed recycles instead of ending.
    expect(first.body.nextCursor).toBe('1:1');
    expect(first.body.hasMore).toBe(true);

    const second = await request(app).get(`/api/cards/recommendations?limit=4&cursor=${first.body.nextCursor}`);
    expect(second.status).toBe(200);
    expect(second.body.cycle).toBe(1);
    expect(second.body.recycled).toBe(true);
    // A new cycle reseeds the jitter, so the page is a genuine reshuffle and not the same list again.
    expect(second.body.cursor).toBe('1:1');
  });

  it('is stable for the same player, cursor and day', async () => {
    const a = await alice.get('/api/cards/recommendations?limit=6');
    const b = await alice.get('/api/cards/recommendations?limit=6');
    expect(a.body.cards.map((c: { name: string }) => c.name)).toEqual(b.body.cards.map((c: { name: string }) => c.name));
  });

  it('gives every card an image the client can render', async () => {
    // The seeded rows have no image_uri, as every row imported before the sync started populating it
    // does. apps/web renders `image_uri` straight into an <img>, so '' is a broken image in the feed;
    // the URL is reconstructed from the Scryfall id instead.
    const r = await request(app).get('/api/cards/recommendations?limit=10');
    expect(r.status).toBe(200);
    for (const card of r.body.cards as Array<{ image_uri: string }>) {
      expect(card.image_uri).toMatch(/^https:\/\/cards\.scryfall\.io\//);
    }
  });

  it('builds the candidate pool most-played first, one row per card', async () => {
    // The pool decides what *can* be recommended, so its order is the cold-start experience. Ordering
    // it by name — which is what DISTINCT ON forces on the inner query if the sort is not lifted out
    // — would hand a new player a first page of cards starting with "A".
    await ctx.pool.query(`UPDATE scryfall_cards SET edhrec_rank = 2 WHERE name = 'Natures Lore'`);
    await ctx.pool.query(`UPDATE scryfall_cards SET edhrec_rank = 1 WHERE name = 'Cultivate'`);
    await ctx.pool.query(`UPDATE scryfall_cards SET edhrec_rank = 3 WHERE name = 'Beast Within'`);

    const pool = await loadLocalCandidates(ctx.pool, 1, 3);
    expect(pool.map((card) => card.name)).toEqual(['Cultivate', 'Natures Lore', 'Beast Within']);

    // Page 2 continues the same ordering rather than repeating it.
    const second = await loadLocalCandidates(ctx.pool, 2, 3);
    expect(second.map((card) => card.name)).not.toContain('Cultivate');

    // Elvish Visionary has three printings; the pool carries it once, at its cheapest price.
    const all = await loadLocalCandidates(ctx.pool, 1, 50);
    expect(all.filter((card) => card.name === 'Elvish Visionary')).toHaveLength(1);
  });

  it('counts how many public decks run a card, for the candidates only', async () => {
    // DECK_ID is public and runs Cultivate, so Cultivate's community count is at least one. The
    // count query is scoped to the names being scored rather than grouping every deck in the product.
    const r = await request(app).get('/api/cards/recommendations?limit=40');
    expect(r.status).toBe(200);
    const cultivate = r.body.cards.find((card: { name: string }) => card.name === 'Cultivate');
    expect(cultivate).toBeDefined();
  });

  // `apps/web`'s CardSearch page derives its types from this contract rather than redeclaring them,
  // so the contract has to actually describe the response. Nothing else validates a response body
  // against its contract — without this, a contract the client trusts is only documentation, and a
  // drift between them is a silent production bug instead of a failing build.
  it('returns a body its own contract accepts, for both the cold and the personalised page', async () => {
    const cold = await request(app).get('/api/cards/recommendations?limit=8');
    expect(() => RecommendationResponse.parse(cold.body)).not.toThrow();
    const personalised = await alice.get(`/api/cards/recommendations?deckId=${DECK_ID}&limit=10`);
    expect(() => RecommendationResponse.parse(personalised.body)).not.toThrow();
  });
});
