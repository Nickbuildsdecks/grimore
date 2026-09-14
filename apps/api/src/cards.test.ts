import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!DATABASE_URL || !REDIS_URL)('cards routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_cards_test_${Date.now()}`;

  /**
   * A miniature scryfall_cards table. Rows are written with the same shape the legacy bulk sync
   * produces, including the awkward parts the port has to survive: JSON stored as text, a row with
   * malformed JSON, a token, two printings of one card at different prices, and a NULL price.
   */
  const CARDS = [
    {
      id: '11111111-1111-4111-8111-111111111111', name: 'Sol Ring', set_code: 'c21', set_name: 'Commander 2021',
      collector_number: '263', rarity: 'uncommon', price: 1.25, type_line: 'Artifact', mana_cost: '{1}', cmc: 1,
      oracle_text: '{T}: Add {C}{C}.', colors: '[]', color_identity: '[]',
      legalities: '{"commander":"legal","modern":"banned","vintage":"restricted"}', image_uri: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222222', name: 'Sol Ring', set_code: 'lea', set_name: 'Limited Edition Alpha',
      collector_number: '270', rarity: 'uncommon', price: 3500, type_line: 'Artifact', mana_cost: '{1}', cmc: 1,
      oracle_text: '{T}: Add {C}{C}.', colors: '[]', color_identity: '[]',
      legalities: '{"commander":"legal"}', image_uri: null,
    },
    {
      id: '33333333-3333-4333-8333-333333333333', name: 'Lightning Bolt', set_code: 'lea', set_name: 'Limited Edition Alpha',
      collector_number: '161', rarity: 'common', price: 2.5, type_line: 'Instant', mana_cost: '{R}', cmc: 1,
      oracle_text: 'Lightning Bolt deals 3 damage to any target.', colors: '["R"]', color_identity: '["R"]',
      legalities: '{"commander":"legal","modern":"legal"}', image_uri: null,
    },
    {
      id: '44444444-4444-4444-8444-444444444444', name: 'Krenko, Mob Boss', set_code: 'm13', set_name: 'Magic 2013',
      collector_number: '138', rarity: 'rare', price: null, type_line: 'Legendary Creature — Goblin Warrior',
      mana_cost: '{2}{R}{R}', cmc: 4, oracle_text: 'Tap: Create X 1/1 red Goblin tokens.',
      colors: '["R"]', color_identity: '["R"]', legalities: '{"commander":"legal"}', image_uri: null,
    },
    {
      id: '55555555-5555-4555-8555-555555555555', name: 'Goblin Token', set_code: 'tm13', set_name: 'Magic 2013 Tokens',
      collector_number: '1', rarity: 'common', price: 0.05, type_line: 'Token Creature — Goblin', mana_cost: '',
      cmc: 0, oracle_text: '', colors: '["R"]', color_identity: '["R"]', legalities: '{}', image_uri: null,
    },
    {
      // Malformed JSON in every text-JSON column, and a rarity outside the contract's enum.
      id: '66666666-6666-4666-8666-666666666666', name: 'Corrupted Row', set_code: 'unk', set_name: null,
      collector_number: '1', rarity: 'super-duper-rare', price: 0.5, type_line: 'Enchantment', mana_cost: '{G}',
      cmc: 1, oracle_text: '', colors: 'not json', color_identity: '{oops', legalities: 'nope', image_uri: null,
    },
  ];

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: u.toString(),
      REDIS_URL,
      SESSION_SECRET: 'test-secret',
      LOG_LEVEL: 'silent',
    });
    ctx = await createContext(env);
    await runMigrations(ctx.pool);
    app = createApp(ctx);

    for (const c of CARDS) {
      await ctx.pool.query(
        `INSERT INTO scryfall_cards (id, name, card_name, set_code, set_name, collector_number, rarity, price,
           type_line, mana_cost, cmc, oracle_text, colors, color_identity, legalities, image_uri)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity, c.price, c.type_line, c.mana_cost,
         c.cmc, c.oracle_text, c.colors, c.color_identity, c.legalities, c.image_uri],
      );
    }
    // Two cache rows for one name: a plain LEFT JOIN here is what made legacy fan out its result rows.
    await ctx.pool.query(
      `INSERT INTO card_price_cache (card_name, price) VALUES ('Lightning Bolt', 1.75), ('Lightning Bolt', 9.99)`,
    );
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('rejects a search with no query term', async () => {
    const r = await request(app).get('/api/cards/search');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });

  it('matches case-insensitively (legacy LIKE was case-sensitive under Postgres)', async () => {
    const r = await request(app).get('/api/cards/search?q=lightning+bolt');
    expect(r.status).toBe(200);
    expect(r.body.cards.map((c: { name: string }) => c.name)).toContain('Lightning Bolt');
  });

  it('returns Scryfall-shaped cards with the legacy aliases alongside', async () => {
    const r = await request(app).get('/api/cards/search?q=Lightning Bolt');
    const card = r.body.cards[0];
    expect(card.name).toBe('Lightning Bolt');
    expect(card.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(card.type_line).toBe('Instant');
    expect(card.colors).toEqual(['R']);
    expect(card.legalities.modern).toBe('legal');
    // Legacy keys the existing UI still reads.
    expect(card.scryfallId).toBe(card.id);
    expect(typeof card.price).toBe('number');
    // image_uri is reconstructed from the id when the sync never wrote one.
    expect(card.image_uri).toBe('https://cards.scryfall.io/normal/front/3/3/33333333-3333-4333-8333-333333333333.jpg');
  });

  it('takes the cheapest price_cache row without fanning out result rows', async () => {
    const r = await request(app).get('/api/cards/search?q=Lightning Bolt');
    // Two card_price_cache rows exist for this name; legacy would have returned the card twice.
    expect(r.body.cards.filter((c: { name: string }) => c.name === 'Lightning Bolt')).toHaveLength(1);
    expect(r.body.totalCards).toBe(1);
    expect(r.body.cards[0].price).toBeCloseTo(1.75, 2);
  });

  it('falls back to the card row price, then to the 0.15 floor', async () => {
    const bolt = await request(app).get('/api/cards/search?q=Sol Ring&sort=price&dir=asc');
    expect(bolt.body.cards[0].price).toBeCloseTo(1.25, 2); // no cache row -> scryfall_cards.price
    const krenko = await request(app).get('/api/cards/search?q=Krenko');
    expect(krenko.body.cards[0].price).toBeCloseTo(0.15, 2); // no cache row and a NULL price -> floor
  });

  it('excludes tokens', async () => {
    // "Goblin Token" is the only row whose NAME contains "goblin", and it is a token, so the search
    // that would otherwise have surfaced it comes back empty.
    const r = await request(app).get('/api/cards/search?q=goblin');
    expect(r.status).toBe(200);
    expect(r.body.cards).toEqual([]);
    expect(r.body.totalCards).toBe(0);
    // The non-token Goblin card is still findable by its own name.
    const krenko = await request(app).get('/api/cards/search?q=Krenko');
    expect(krenko.body.cards.map((c: { name: string }) => c.name)).toEqual(['Krenko, Mob Boss']);
  });

  it('survives rows with malformed JSON and an out-of-contract rarity', async () => {
    const r = await request(app).get('/api/cards/search?q=Corrupted');
    expect(r.status).toBe(200);
    expect(r.body.cards).toHaveLength(1);
    expect(r.body.cards[0].colors).toEqual([]);
    expect(r.body.cards[0].legalities).toEqual({});
    expect(r.body.cards[0].rarity).toBeNull();
  });

  it('sorts exact name matches first, then by the secondary sort', async () => {
    const r = await request(app).get('/api/cards/search?q=Sol Ring&sort=price&dir=desc');
    expect(r.body.cards.map((c: { set: string }) => c.set)).toEqual(['lea', 'c21']);
    const asc = await request(app).get('/api/cards/search?q=Sol Ring&sort=price&dir=asc');
    expect(asc.body.cards.map((c: { set: string }) => c.set)).toEqual(['c21', 'lea']);
  });

  it('sorts by subtype using the Postgres em-dash split (legacy used SQLite INSTR)', async () => {
    const r = await request(app).get('/api/cards/search?q=o&sort=subtype&dir=asc');
    expect(r.status).toBe(200);
    // "Legendary Creature — Goblin Warrior" is the only row with a subtype; everything else sorts as ''.
    expect(r.body.cards.map((c: { name: string }) => c.name)).toContain('Krenko, Mob Boss');
  });

  it('filters by format legality, counting restricted as playable', async () => {
    const modern = await request(app).get('/api/cards/search?q=o&format=modern');
    expect(modern.body.cards.map((c: { name: string }) => c.name)).toEqual(['Lightning Bolt']);
    // Sol Ring is banned in modern and restricted in vintage.
    const vintage = await request(app).get('/api/cards/search?q=Sol Ring&format=vintage');
    expect(vintage.body.cards).toHaveLength(1);
  });

  it('filters by colour identity', async () => {
    const red = await request(app).get('/api/cards/search?q=o&colors=R');
    const names = red.body.cards.map((c: { name: string }) => c.name);
    expect(names).toContain('Krenko, Mob Boss');
    // Colourless cards fit inside any identity, so Sol Ring stays.
    expect(names).toContain('Sol Ring');
  });

  it('paginates with a count drawn from the same filtered query', async () => {
    const p1 = await request(app).get('/api/cards/search?q=Sol Ring&limit=1&page=1&sort=price&dir=asc');
    expect(p1.body.totalCards).toBe(2);
    expect(p1.body.hasMore).toBe(true);
    expect(p1.body.cards).toHaveLength(1);
    const p2 = await request(app).get('/api/cards/search?q=Sol Ring&limit=1&page=2&sort=price&dir=asc');
    expect(p2.body.hasMore).toBe(false);
    expect(p2.body.cards[0].set).toBe('lea');
  });

  it('autocomplete collapses printings and ranks prefix matches first', async () => {
    const r = await request(app).get('/api/cards/autocomplete?q=ol');
    expect(r.status).toBe(200);
    const names = r.body.map((c: { name: string }) => c.name);
    // One entry for Sol Ring despite two printings; no tokens.
    expect(names.filter((n: string) => n === 'Sol Ring')).toHaveLength(1);
    expect(names).not.toContain('Goblin Token');
    const prefixed = await request(app).get('/api/cards/autocomplete?q=sol');
    expect(prefixed.body[0].name).toBe('Sol Ring');
    expect(prefixed.body[0].card_name).toBe('Sol Ring'); // legacy key
  });

  it('autocomplete rejects an empty term', async () => {
    expect((await request(app).get('/api/cards/autocomplete?q=')).status).toBe(400);
  });

  it('details returns one card by exact name and 404s an unknown one', async () => {
    const r = await request(app).get('/api/cards/details?name=sol ring');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Sol Ring');
    expect(r.body.price).toBeCloseTo(1.25, 2); // cheapest printing
    const missing = await request(app).get('/api/cards/details?name=Black Lotus');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/api/cards/details')).status).toBe(400);
  });

  it('search is public (no session required)', async () => {
    expect((await request(app).get('/api/cards/search?q=Sol')).status).toBe(200);
  });
});

describe.skipIf(!DATABASE_URL || !REDIS_URL)('cards: batch, printings and taste (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_cards2_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: string;
  const SOL_CHEAP = '11111111-1111-4111-8111-111111111111';
  const SOL_ALPHA = '22222222-2222-4222-8222-222222222222';

  async function signup(username: string) {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/register').send({
      username, password: 'correct-horse-battery', storeNickname: username, email: `${username}@example.com`,
    })).status).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: 'correct-horse-battery' });
    return { agent, id: login.body.user.id as string };
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    ctx = await createContext(parseEnv({
      NODE_ENV: 'test', DATABASE_URL: u.toString(), REDIS_URL, SESSION_SECRET: 'test-secret', LOG_LEVEL: 'silent',
    }));
    await runMigrations(ctx.pool);
    app = createApp(ctx);
    await ctx.pool.query(
      `INSERT INTO scryfall_cards (id, name, card_name, set_code, set_name, collector_number, rarity, price, type_line) VALUES
        ($1,'Sol Ring','Sol Ring','c21','Commander 2021','263','uncommon',1.25,'Artifact'),
        ($2,'Sol Ring','Sol Ring','lea','Limited Edition Alpha','270','uncommon',3500,'Artifact'),
        ('33333333-3333-4333-8333-333333333333','Lightning Bolt','Lightning Bolt','lea','Limited Edition Alpha','161','common',2.5,'Instant'),
        ('55555555-5555-4555-8555-555555555555','Goblin Token','Goblin Token','tm13','Tokens','1','common',0.05,'Token Creature — Goblin')`,
      [SOL_CHEAP, SOL_ALPHA],
    );
    ({ agent: alice, id: aliceId } = await signup('alice_taste'));
    ({ agent: bob } = await signup('bob_taste'));
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('resolves a batch of names in one call and names the misses', async () => {
    const r = await request(app).post('/api/cards/details-batch').send({
      names: ['Sol Ring', 'lightning bolt', 'Some Unreleased Card'],
    });
    expect(r.status).toBe(200);
    expect(r.body.cards).toHaveLength(3);
    expect(r.body.byName['sol ring'].name).toBe('Sol Ring');
    // Cheapest printing wins, and one entry per name despite two Sol Ring rows.
    expect(r.body.byName['sol ring'].price).toBeCloseTo(1.25, 2);
    expect(r.body.byName['lightning bolt'].name).toBe('Lightning Bolt');
    // Misses are reported rather than silently dropped.
    expect(r.body.missing).toEqual(['Some Unreleased Card']);
    expect(r.body.cards[2]).toBeNull();
  });

  it('rejects an empty or oversized batch', async () => {
    expect((await request(app).post('/api/cards/details-batch').send({ names: [] })).status).toBe(400);
    const huge = Array.from({ length: 201 }, (_, i) => `Card ${i}`);
    expect((await request(app).post('/api/cards/details-batch').send({ names: huge })).status).toBe(400);
  });

  it('lists printings cheapest first, excluding tokens', async () => {
    const r = await request(app).get('/api/cards/versions?name=Sol Ring');
    expect(r.status).toBe(200);
    expect(r.body.map((p: { set: string }) => p.set)).toEqual(['C21', 'LEA']);
    expect(r.body[0].set_name).toBe('Commander 2021');
    expect(r.body[0].collector_number).toBe('263');
    expect(r.body[0].image_uri).toContain('cards.scryfall.io');
    expect((await request(app).get('/api/cards/versions?name=Goblin Token')).body).toEqual([]);
    expect((await request(app).get('/api/cards/versions')).status).toBe(400);
  });

  it('says rulings need Scryfall rather than pretending a card has none', async () => {
    const r = await request(app).get('/api/cards/rulings?name=Sol Ring');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('SCRYFALL_UNAVAILABLE');
  });

  it('records a card swipe and keeps it per brew context', async () => {
    expect((await request(app).post('/api/cards/swipes').send({ cardName: 'Sol Ring', vote: 1 })).status).toBe(401);

    expect((await alice.post('/api/cards/swipes').send({ cardName: 'Sol Ring', vote: 1, context: 'goblins' })).status).toBe(200);
    expect((await alice.post('/api/cards/swipes').send({ cardName: 'Sol Ring', vote: -1, context: 'control' })).status).toBe(200);
    const rows = await ctx.pool.query('SELECT context_key, vote FROM card_swipes WHERE player_id = $1 ORDER BY context_key', [aliceId]);
    // A Goblins phase must not poison the queue you get while brewing control.
    expect(rows.rows).toEqual([
      { context_key: 'control', vote: -1 },
      { context_key: 'goblins', vote: 1 },
    ]);
  });

  it('re-swiping the same card in one context replaces the vote', async () => {
    await alice.post('/api/cards/swipes').send({ cardName: 'SOL RING', vote: -1, context: 'goblins' });
    const rows = await ctx.pool.query(`SELECT vote FROM card_swipes WHERE player_id = $1 AND context_key = 'goblins'`, [aliceId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].vote).toBe(-1);
  });

  it('clears a swipe with vote 0, and rejects anything else', async () => {
    await alice.post('/api/cards/swipes').send({ cardName: 'Sol Ring', vote: 0, context: 'goblins' });
    const rows = await ctx.pool.query(`SELECT 1 FROM card_swipes WHERE player_id = $1 AND context_key = 'goblins'`, [aliceId]);
    expect(rows.rowCount).toBe(0);
    expect((await alice.post('/api/cards/swipes').send({ cardName: 'Sol Ring', vote: 7 })).status).toBe(400);
    expect((await alice.post('/api/cards/swipes').send({ cardName: '', vote: 1 })).status).toBe(400);
  });

  it('logs swipes to the preference event stream', async () => {
    const before = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM preference_events WHERE player_id = $1', [aliceId]);
    await alice.post('/api/cards/swipes').send({ cardName: 'Lightning Bolt', vote: 1, source: 'discover_swipe' });
    const after = await ctx.pool.query(
      `SELECT event_type, entity_key, source FROM preference_events WHERE player_id = $1 ORDER BY id DESC LIMIT 1`,
      [aliceId],
    );
    expect(after.rows[0]).toMatchObject({ event_type: 'swipe_like', entity_key: 'Lightning Bolt', source: 'discover_swipe' });
    expect(before.rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('votes on one printing\'s art and tallies it', async () => {
    const r = await alice.post(`/api/cards/versions/${SOL_ALPHA}/vote`).send({ cardName: 'Sol Ring', vote: 1, artist: 'Mark Tedin' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ likes: 1, dislikes: 0 });
    await bob.post(`/api/cards/versions/${SOL_ALPHA}/vote`).send({ cardName: 'Sol Ring', vote: -1 });

    const versions = await alice.get('/api/cards/versions?name=Sol Ring');
    const alpha = versions.body.find((p: { id: string }) => p.id === SOL_ALPHA);
    expect(alpha.likes).toBe(1);
    expect(alpha.dislikes).toBe(1);
    expect(alpha.myVote).toBe(1);
    // scryfall_cards has no artist column, so the illustrator is known only where a vote recorded it.
    expect(alpha.artist).toBe('Mark Tedin');
    // An anonymous viewer has no vote of their own.
    expect((await request(app).get('/api/cards/versions?name=Sol Ring')).body.find((p: { id: string }) => p.id === SOL_ALPHA).myVote).toBe(0);
  });

  it('keeps an artist name once recorded, even when a later vote omits it', async () => {
    await alice.post(`/api/cards/versions/${SOL_ALPHA}/vote`).send({ cardName: 'Sol Ring', vote: -1 });
    const rows = await ctx.pool.query('SELECT artist, vote FROM card_art_votes WHERE player_id = $1 AND scryfall_id = $2', [aliceId, SOL_ALPHA]);
    expect(rows.rows[0].artist).toBe('Mark Tedin');
    expect(rows.rows[0].vote).toBe(-1);
  });

  it('refuses swipe traffic posted to the art endpoint', async () => {
    // The two tables answer different questions; a stale client must not silently mix them.
    const r = await alice.post(`/api/cards/versions/${SOL_CHEAP}/vote`).send({
      cardName: 'Sol Ring', vote: 1, source: 'card_search_swipe',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('WRONG_ENDPOINT');
  });

  it('rejects a malformed printing id, and requires a session', async () => {
    expect((await alice.post('/api/cards/versions/nope/vote').send({ cardName: 'Sol Ring', vote: 1 })).status).toBe(400);
    expect((await request(app).post(`/api/cards/versions/${SOL_CHEAP}/vote`).send({ cardName: 'Sol Ring', vote: 1 })).status).toBe(401);
  });

  it('clears an art vote with vote 0', async () => {
    await alice.post(`/api/cards/versions/${SOL_ALPHA}/vote`).send({ cardName: 'Sol Ring', vote: 0 });
    const rows = await ctx.pool.query('SELECT 1 FROM card_art_votes WHERE player_id = $1 AND scryfall_id = $2', [aliceId, SOL_ALPHA]);
    expect(rows.rowCount).toBe(0);
  });
});
