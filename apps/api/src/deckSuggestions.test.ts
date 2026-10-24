/**
 * GET /api/decks/:deckId/suggestions, against live Postgres.
 *
 * The route this replaces answered 500 to every request on this dialect, so there is no legacy
 * behaviour to pin — only the schema reality it got wrong. What is tested here is that: the pool
 * respects the commander's colour identity and the format's ban list, the deck's own cards are gone
 * before the limit is applied, the owned intersection fills the first bucket, and a deck with no
 * commander gets the 400 the page is written to display rather than a 500.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv, DeckSuggestionsResponse } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';
import { loadSuggestionPool, loadSuggestionTarget } from './lib/deckSuggestions.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

interface Category {
  header: string;
  tag: string;
  cards: { name: string; owned: boolean; price: number; type_line: string; scryfallId: string | null; image_uri: string }[];
}
const names = (categories: Category[]): string[] => categories.flatMap((c) => c.cards.map((card) => card.name));
const bucket = (categories: Category[], header: string): Category | undefined =>
  categories.find((c) => c.header === header);

describe.skipIf(!DATABASE_URL || !REDIS_URL)('deck suggestions (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_sugg_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: string;
  const GREEN_DECK = 'deck-sugg-green';
  const NO_CMD_DECK = 'deck-sugg-headless';
  const MODERN_DECK = 'deck-sugg-modern';

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

    // Colours and legalities are JSON in TEXT columns, which is how the sync writes them and the
    // shape that silently disabled the recommender's ban-list check.
    await ctx.pool.query(
      `INSERT INTO scryfall_cards
         (id, name, card_name, type_line, oracle_text, mana_cost, cmc, colors, color_identity, legalities, rarity, set_code, price, edhrec_rank, image_uri)
       VALUES
         ('22222222-0000-4000-8000-000000000001','Selvala','Selvala','Legendary Creature — Elf Scout','{T}: Add {G} for each creature you control.','{2}{G}',3,'["G"]','["G"]','{"commander":"legal","modern":"legal"}','rare','cmr',8,500,''),
         ('22222222-0000-4000-8000-000000000002','Cultivate','Cultivate','Sorcery','Search your library for up to two basic land cards.','{2}{G}',3,'["G"]','["G"]','{"commander":"legal","modern":"legal"}','uncommon','m21',0.5,10,''),
         ('22222222-0000-4000-8000-000000000003','Beast Within','Beast Within','Instant','Destroy target permanent.','{2}{G}',3,'["G"]','["G"]','{"commander":"legal","modern":"legal"}','uncommon','nph',4,20,''),
         ('22222222-0000-4000-8000-000000000004','Elvish Visionary','Elvish Visionary','Creature — Elf Shaman','When Elvish Visionary enters the battlefield, draw a card.','{1}{G}',2,'["G"]','["G"]','{"commander":"legal","modern":"legal"}','common','m12',0.2,30,''),
         ('22222222-0000-4000-8000-000000000005','Reliquary Tower','Reliquary Tower','Land','You have no maximum hand size.','',0,'[]','[]','{"commander":"legal","modern":"legal"}','uncommon','m19',1,40,''),
         ('22222222-0000-4000-8000-000000000006','Primeval Titan','Primeval Titan','Creature — Giant','Whenever Primeval Titan enters, search your library for up to two land cards.','{4}{G}{G}',6,'["G"]','["G"]','{"commander":"banned","modern":"legal"}','mythic','m11',25,5,''),
         ('22222222-0000-4000-8000-000000000007','Lightning Bolt','Lightning Bolt','Instant','Lightning Bolt deals 3 damage to any target.','{R}',1,'["R"]','["R"]','{"commander":"legal","modern":"legal"}','common','m10',1.5,1,''),
         ('22222222-0000-4000-8000-000000000008','Counterspell','Counterspell','Instant','Counter target spell.','{U}{U}',2,'["U"]','["U"]','{"commander":"legal","modern":"legal"}','common','mh2',1,2,''),
         ('22222222-0000-4000-8000-000000000009','Forest','Forest','Basic Land — Forest','{T}: Add {G}.','',0,'[]','["G"]','{"commander":"legal","modern":"legal"}','common','m21',0.1,900,''),
         ('22222222-0000-4000-8000-00000000000a','Goblin Token','Goblin Token','Token Creature — Goblin','','',0,'["R"]','["R"]','{"commander":"legal"}','common','tm13',0.05,901,''),
         ('22222222-0000-4000-8000-00000000000b','Eternal Witness','Eternal Witness','Creature — Human Shaman','When Eternal Witness enters, return target card from your graveyard to your hand.','{1}{G}{G}',3,'["G"]','["G"]','{"commander":"legal","modern":"legal"}','uncommon','8ed',3,25,'')`,
    );

    alice = request.agent(app);
    expect(
      (
        await alice.post('/api/auth/register').send({
          username: 'alice_sugg',
          password: PASSWORD,
          storeNickname: 'alice_sugg',
          email: 'alice_sugg@example.com',
        })
      ).status,
    ).toBe(201);
    aliceId = (await alice.post('/api/auth/login').send({ username: 'alice_sugg', password: PASSWORD })).body.user.id;

    bob = request.agent(app);
    await bob.post('/api/auth/register').send({
      username: 'bob_sugg',
      password: PASSWORD,
      storeNickname: 'bob_sugg',
      email: 'bob_sugg@example.com',
    });
    await bob.post('/api/auth/login').send({ username: 'bob_sugg', password: PASSWORD });

    // A mono-green commander deck that already runs Cultivate, so the exclusion has something to do.
    await ctx.pool.query(
      `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, is_public, format)
       VALUES ($1, $2, $3, 'Selvala Ramp', 0, 1, 'commander'),
              ($4, $2, $5, 'Headless', 0, 1, 'commander'),
              ($6, $2, $7, 'Modern Burn', 0, 1, 'modern')`,
      [GREEN_DECK, aliceId, `visual-${GREEN_DECK}`, NO_CMD_DECK, `visual-${NO_CMD_DECK}`, MODERN_DECK, `visual-${MODERN_DECK}`],
    );
    await ctx.pool.query(
      `INSERT INTO deck_cards (deck_id, card_name, quantity, is_commander)
       VALUES ($1, 'Selvala', 1, 1), ($1, 'Cultivate', 1, 0)`,
      [GREEN_DECK],
    );
    await ctx.pool.query(`INSERT INTO deck_cards (deck_id, card_name, quantity, is_commander) VALUES ($1, 'Forest', 20, 0)`, [
      NO_CMD_DECK,
    ]);
    await ctx.pool.query(
      `INSERT INTO deck_cards (deck_id, card_name, quantity, is_commander) VALUES ($1, 'Lightning Bolt', 4, 1)`,
      [MODERN_DECK],
    );

    // Alice owns Eternal Witness, so it should lead the functional list under Owned Suggestions.
    // `collections.id` is TEXT with no default since migration 0005, so the id is supplied.
    await ctx.pool.query(`INSERT INTO collections (id, player_id, name) VALUES ('c_sugg_1', $1, 'Binder')`, [aliceId]);
    await ctx.pool.query(
      `INSERT INTO collection_cards (collection_id, card_name, quantity) VALUES ('c_sugg_1', 'Eternal Witness', 1)`,
    );
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('answers at all — the legacy handler 500d here on every request', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.commanderName).toBe('Selvala');
    expect(r.body.suggestionSource).toBe('local-pool');
    expect(r.body.poolSize).toBeGreaterThan(0);
  });

  it('requires a session', async () => {
    const r = await request(app).get(`/api/decks/${GREEN_DECK}/suggestions`);
    expect(r.status).toBe(401);
  });

  it('refuses a deck the caller does not own, which legacy served to anyone signed in', async () => {
    const r = await bob.get(`/api/decks/${GREEN_DECK}/suggestions`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('404s an unknown deck', async () => {
    const r = await alice.get('/api/decks/no-such-deck/suggestions');
    expect(r.status).toBe(404);
  });

  it('answers 400 with a code when the deck has no commander tagged', async () => {
    const r = await alice.get(`/api/decks/${NO_CMD_DECK}/suggestions`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('NO_COMMANDER');
    expect(r.body.error.message).toMatch(/tag at least one card/);
  });

  it("keeps the pool inside the commander's colour identity", async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions`);
    const all = names(r.body.functionalCategories);
    expect(all).toContain('Elvish Visionary');
    // Colourless is inside every identity.
    expect(all).toContain('Reliquary Tower');
    expect(all).not.toContain('Lightning Bolt');
    expect(all).not.toContain('Counterspell');
    expect(r.body.colorIdentity).toEqual(['G']);
  });

  it('drops a card banned in the deck format even though its legalities arrive as JSON text', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions`);
    expect(names(r.body.functionalCategories)).not.toContain('Primeval Titan');
    // Legal in modern, and that deck's format is modern, so the ban is format-scoped not global.
    const modern = await alice.get(`/api/decks/${MODERN_DECK}/suggestions`);
    expect(modern.status).toBe(200);
    expect(names(modern.body.functionalCategories)).toContain('Primeval Titan');
  });

  it('applies no colour-identity filter outside commander', async () => {
    // The modern deck's "commander" is a red card; a non-commander format has no identity rule, so
    // blue and green cards stay in the pool.
    const r = await alice.get(`/api/decks/${MODERN_DECK}/suggestions`);
    const all = names(r.body.functionalCategories);
    expect(all).toContain('Counterspell');
    expect(all).toContain('Cultivate');
  });

  it('never suggests a token or a basic land', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=300`);
    const all = names(r.body.functionalCategories);
    expect(all).not.toContain('Forest');
    expect(all).not.toContain('Goblin Token');
  });

  it('excludes cards the deck already runs, which the client discarded anyway', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=300`);
    const all = names(r.body.functionalCategories);
    expect(all).not.toContain('Cultivate');
    expect(all).not.toContain('Selvala');
  });

  it('marks owned cards and gives them their own leading bucket', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions`);
    expect(r.body.functionalCategories[0].header).toBe('Owned Suggestions');
    expect(r.body.functionalCategories[0].tag).toBe('owned-suggestions');
    expect(names([r.body.functionalCategories[0]])).toEqual(['Eternal Witness']);
    const witness = names(r.body.functionalCategories).filter((n) => n === 'Eternal Witness');
    // Once under Owned Suggestions and once under its functional role, and no more.
    expect(witness.length).toBe(2);
    const unowned = r.body.functionalCategories
      .flatMap((c: Category) => c.cards)
      .filter((card: { name: string }) => card.name === 'Elvish Visionary');
    expect(unowned.every((card: { owned: boolean }) => card.owned === false)).toBe(true);
  });

  it('files cards by function, using the same engine as the autotag route', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=300`);
    expect(names([bucket(r.body.functionalCategories, 'Single Target Removal')!])).toContain('Beast Within');
    expect(names([bucket(r.body.functionalCategories, 'Card Advantage')!])).toContain('Elvish Visionary');
    expect(names([bucket(r.body.functionalCategories, 'Utility Lands')!])).toContain('Reliquary Tower');
    expect(names([bucket(r.body.functionalCategories, 'Recursion')!])).toContain('Eternal Witness');
    // Every bucket that survives is non-empty and carries its slug.
    for (const category of r.body.functionalCategories as Category[]) {
      expect(category.cards.length).toBeGreaterThan(0);
      expect(category.tag).toMatch(/^[a-z-]+$/);
    }
  });

  it('serves a parallel type-mode bucketing', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=300`);
    expect(names([bucket(r.body.typeCategories, 'Creatures')!])).toContain('Elvish Visionary');
    expect(names([bucket(r.body.typeCategories, 'Instants')!])).toContain('Beast Within');
    expect(names([bucket(r.body.typeCategories, 'Lands')!])).toContain('Reliquary Tower');
    expect(bucket(r.body.typeCategories, 'Lands')!.tag).toBe('lands-type');
    // A card lands in exactly one type bucket (plus Owned Suggestions when owned).
    const visionary = names(r.body.typeCategories).filter((n) => n === 'Elvish Visionary');
    expect(visionary.length).toBe(1);
  });

  it('aliases categories to functionalCategories without copying the array', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions`);
    expect(r.body.categories).toEqual(r.body.functionalCategories);
  });

  it('gives every suggestion a renderable image URL even when image_uri is empty', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=300`);
    const cards = (r.body.functionalCategories as Category[]).flatMap((c) => c.cards);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.image_uri).toMatch(/^https:\/\/cards\.scryfall\.io\//);
      expect(card.scryfallId).toMatch(/^[0-9a-f]{8}-/);
    }
  });

  it('clamps limit and tolerates a non-numeric one', async () => {
    const low = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=1`);
    expect(low.status).toBe(200);
    const junk = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=banana`);
    expect(junk.status).toBe(200);
    expect(junk.body.poolSize).toBeGreaterThan(0);
  });

  it('orders the pool by how played a card is, not alphabetically', async () => {
    // Direct call, because the route then re-buckets: the pool itself has to come out popular-first.
    const page = await loadSuggestionPool(ctx.pool, {
      format: 'commander',
      colorIdentity: ['G'],
      excludeKeys: [],
      limit: 4,
    });
    expect(page.map((c) => c.name)).toEqual(['Cultivate', 'Beast Within', 'Eternal Witness', 'Elvish Visionary']);
  });

  it('collapses a card with many printings to one pool entry', async () => {
    await ctx.pool.query(
      `INSERT INTO scryfall_cards (id, name, card_name, type_line, oracle_text, colors, color_identity, legalities, price, edhrec_rank)
       VALUES ('33333333-0000-4000-8000-000000000001','Elvish Visionary','Elvish Visionary','Creature — Elf Shaman','When Elvish Visionary enters the battlefield, draw a card.','["G"]','["G"]','{"commander":"legal"}',9,30),
              ('33333333-0000-4000-8000-000000000002','Elvish Visionary','Elvish Visionary','Creature — Elf Shaman','When Elvish Visionary enters the battlefield, draw a card.','["G"]','["G"]','{"commander":"legal"}',7,30)`,
    );
    const page = await loadSuggestionPool(ctx.pool, {
      format: 'commander',
      colorIdentity: ['G'],
      excludeKeys: [],
      limit: 300,
    });
    const hits = page.filter((c) => c.name === 'Elvish Visionary');
    expect(hits.length).toBe(1);
    // The cheapest printing wins, which is the price the deck builder would pay.
    expect(hits[0].price).toBeCloseTo(0.2, 5);
  });

  // Same reason as the recommendations contract test: a response contract nothing validates is only
  // documentation, and this one is what a client would be written against.
  it('returns a body its own contract accepts', async () => {
    const r = await alice.get(`/api/decks/${GREEN_DECK}/suggestions?limit=300`);
    expect(r.status).toBe(200);
    expect(() => DeckSuggestionsResponse.parse(r.body)).not.toThrow();
  });

  it('reads the deck target in one pass: format, commanders, and every card it runs', async () => {
    const target = await loadSuggestionTarget(ctx.pool, GREEN_DECK);
    expect(target.format).toBe('commander');
    expect(target.commanders.map((c) => c.cardName)).toEqual(['Selvala']);
    expect(target.commanders[0].scryfallId).toBe('22222222-0000-4000-8000-000000000001');
    expect(target.colorIdentity).toEqual(['G']);
    expect(target.deckCardKeys.sort()).toEqual(['cultivate', 'selvala']);
  });
});
