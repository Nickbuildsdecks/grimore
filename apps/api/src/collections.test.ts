import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!DATABASE_URL || !REDIS_URL)('collections routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_collections_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;

  async function signup(username: string) {
    const agent = request.agent(app);
    const reg = await agent
      .post('/api/auth/register')
      .send({ username, password: 'correct-horse-battery', storeNickname: username, email: `${username}@example.com` });
    expect(reg.status).toBe(201);
    await agent.post('/api/auth/login').send({ username, password: 'correct-horse-battery' });
    return agent;
  }

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

    // Two printings of Sol Ring at different prices, so the LATERAL price lookup has something to choose
    // between, and two card_price_cache rows for Lightning Bolt, which is what made legacy's SUM overcount.
    await ctx.pool.query(
      `INSERT INTO scryfall_cards (id, name, card_name, price, type_line, oracle_text, cmc) VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001','Sol Ring','Sol Ring', 1.25,'Artifact','{T}: Add {C}{C}.',1),
        ('aaaaaaaa-0000-4000-8000-000000000002','Sol Ring','Sol Ring', 3500,'Artifact','{T}: Add {C}{C}.',1),
        ('bbbbbbbb-0000-4000-8000-000000000001','Lightning Bolt','Lightning Bolt', 2.5,'Instant','3 damage.',1)`,
    );
    await ctx.pool.query(
      `INSERT INTO card_price_cache (card_name, price, type_line) VALUES
        ('Lightning Bolt', 1.75, 'Instant'), ('Lightning Bolt', 9.99, 'Instant')`,
    );

    alice = await signup('alice_coll');
    bob = await signup('bob_coll');
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('rejects every route without a session', async () => {
    const anon = request(app);
    for (const r of [
      anon.get('/api/collections'),
      anon.post('/api/collections').send({ name: 'x' }),
      anon.put('/api/collections/col_1').send({ name: 'x' }),
      anon.delete('/api/collections/col_1'),
      anon.get('/api/collections/col_1/cards'),
      anon.post('/api/collections/col_1/cards').send({ card_name: 'Sol Ring' }),
      anon.put('/api/collections/col_1/cards').send({ key: { card_name: 'Sol Ring' }, changes: { quantity: 2 } }),
      anon.delete('/api/collections/col_1/cards').send({ card_name: 'Sol Ring' }),
    ]) {
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  let collectionId: string;

  it('creates a collection with a text id (legacy could not: the column was an integer serial)', async () => {
    const r = await alice.post('/api/collections').send({ name: 'Main Binder', description: 'The good stuff' });
    expect(r.status).toBe(201);
    collectionId = r.body.collectionId;
    expect(collectionId).toMatch(/^col_/);

    const row = await ctx.pool.query('SELECT id, name, description, is_public, settings FROM collections WHERE id = $1', [collectionId]);
    expect(row.rows[0].name).toBe('Main Binder');
    expect(row.rows[0].is_public).toBe(1);
    expect(row.rows[0].settings).toBe('{}');
  });

  it('rejects an unnamed collection', async () => {
    const r = await alice.post('/api/collections').send({ description: 'no name' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });

  it('adds a card, resolving the printing from the local card table', async () => {
    const r = await alice.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'Sol Ring', quantity: 2, purchase_price: 1.5 });
    expect(r.status).toBe(201);
    const row = await ctx.pool.query('SELECT * FROM collection_cards WHERE collection_id = $1', [collectionId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].quantity).toBe(2);
    // Cheapest printing is chosen when the client does not name one.
    expect(row.rows[0].scryfall_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    // Columns the baseline schema never had, added by migration 0005.
    expect(row.rows[0].condition).toBe('NM');
    expect(row.rows[0].language).toBe('EN');
    expect(row.rows[0].is_for_trade).toBe(0);
    expect(row.rows[0].foil).toBe(0);
  });

  it('increments the same variant rather than inserting a duplicate row', async () => {
    await alice.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'Sol Ring', quantity: 3 });
    const row = await ctx.pool.query('SELECT quantity FROM collection_cards WHERE collection_id = $1', [collectionId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].quantity).toBe(5);
  });

  it('treats a different foil / condition / language as a separate variant', async () => {
    await alice.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'Sol Ring', foil: true, quantity: 1 });
    await alice.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'Sol Ring', condition: 'LP', quantity: 1 });
    const rows = await ctx.pool.query('SELECT foil, condition FROM collection_cards WHERE collection_id = $1 ORDER BY id', [collectionId]);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((r) => `${r.foil}/${r.condition}`)).toEqual(['0/NM', '1/NM', '0/LP']);
  });

  it('matches an existing variant case-insensitively on the card name', async () => {
    await alice.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'sol ring', quantity: 1 });
    const rows = await ctx.pool.query(
      `SELECT quantity FROM collection_cards WHERE collection_id = $1 AND foil = 0 AND condition = 'NM'`,
      [collectionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].quantity).toBe(6);
  });

  it('lists cards with prices, and never double-counts a name with several cached prices', async () => {
    await alice.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'Lightning Bolt', quantity: 4 });
    const r = await alice.get(`/api/collections/${collectionId}/cards`);
    expect(r.status).toBe(200);
    const bolt = r.body.cards.filter((c: { card_name: string }) => c.card_name === 'Lightning Bolt');
    // Two card_price_cache rows exist for this name: legacy's LEFT JOIN returned the card twice.
    expect(bolt).toHaveLength(1);
    expect(bolt[0].price).toBeCloseTo(1.75, 2); // cheapest cache row wins
    expect(bolt[0].type_line).toBe('Instant');
    expect(bolt[0].oracle_text).toBe('3 damage.');
  });

  it('computes list aggregates without fanning out across printings', async () => {
    const r = await alice.get('/api/collections');
    expect(r.status).toBe(200);
    const c = r.body.collections.find((x: { id: string }) => x.id === collectionId);
    // 6 Sol Ring (NM) + 1 foil + 1 LP + 4 Bolt = 12 cards.
    expect(c.total_cards).toBe(12);
    // 8 Sol Ring @ 1.25 (no cache row, cheapest scryfall printing) + 4 Bolt @ 1.75 = 10 + 7 = 17.
    expect(c.total_value).toBeCloseTo(17, 2);
  });

  it('falls back to the 0.15 floor for a card with no price anywhere', async () => {
    const r = await alice.post('/api/collections').send({ name: 'Floor Test' });
    const id = r.body.collectionId;
    await alice.post(`/api/collections/${id}/cards`).send({ card_name: 'Totally Unknown Card', quantity: 2 });
    const list = await alice.get('/api/collections');
    const c = list.body.collections.find((x: { id: string }) => x.id === id);
    expect(c.total_value).toBeCloseTo(0.3, 2);
  });

  it('updates only the fields sent (legacy overwrote every column)', async () => {
    const key = { card_name: 'Lightning Bolt', scryfall_id: 'bbbbbbbb-0000-4000-8000-000000000001', foil: false, condition: 'NM', language: 'EN' };
    const r = await alice.put(`/api/collections/${collectionId}/cards`).send({ key, changes: { is_for_trade: true } });
    expect(r.status).toBe(200);
    const row = await ctx.pool.query(
      `SELECT quantity, is_for_trade, condition FROM collection_cards WHERE collection_id = $1 AND card_name = 'Lightning Bolt'`,
      [collectionId],
    );
    expect(row.rows[0].is_for_trade).toBe(1);
    // Quantity and condition were not in `changes`, so they are untouched.
    expect(row.rows[0].quantity).toBe(4);
    expect(row.rows[0].condition).toBe('NM');
  });

  it('rejects an empty change set and a key that matches nothing', async () => {
    const key = { card_name: 'Lightning Bolt', foil: false, condition: 'NM', language: 'EN' };
    const empty = await alice.put(`/api/collections/${collectionId}/cards`).send({ key, changes: {} });
    expect(empty.status).toBe(400);
    const missing = await alice
      .put(`/api/collections/${collectionId}/cards`)
      .send({ key: { ...key, card_name: 'Black Lotus' }, changes: { quantity: 1 } });
    expect(missing.status).toBe(404);
  });

  it('treats quantity 0 as a removal', async () => {
    const key = { card_name: 'Sol Ring', scryfall_id: 'aaaaaaaa-0000-4000-8000-000000000001', foil: true, condition: 'NM', language: 'EN' };
    const r = await alice.put(`/api/collections/${collectionId}/cards`).send({ key, changes: { quantity: 0 } });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
    const rows = await ctx.pool.query('SELECT foil FROM collection_cards WHERE collection_id = $1 AND foil = 1', [collectionId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('deletes a card and reports a key that matched nothing', async () => {
    const key = { card_name: 'Sol Ring', scryfall_id: 'aaaaaaaa-0000-4000-8000-000000000001', foil: false, condition: 'LP', language: 'EN' };
    const r = await alice.delete(`/api/collections/${collectionId}/cards`).send(key);
    expect(r.status).toBe(200);
    // Legacy answered success here even when nothing matched.
    const again = await alice.delete(`/api/collections/${collectionId}/cards`).send(key);
    expect(again.status).toBe(404);
  });

  it("hides another player's collection behind a 404", async () => {
    expect((await bob.get(`/api/collections/${collectionId}/cards`)).status).toBe(404);
    expect((await bob.put(`/api/collections/${collectionId}`).send({ name: 'Mine now' })).status).toBe(404);
    expect((await bob.delete(`/api/collections/${collectionId}`)).status).toBe(404);
    expect((await bob.post(`/api/collections/${collectionId}/cards`).send({ card_name: 'Sol Ring' })).status).toBe(404);
    expect((await bob.get('/api/collections')).body.collections).toEqual([]);
  });

  it('updates name, description, visibility and settings', async () => {
    const r = await alice
      .put(`/api/collections/${collectionId}`)
      .send({ name: 'Renamed', is_public: false, settings: { sortBy: 'price' } });
    expect(r.status).toBe(200);
    expect(r.body.collection.name).toBe('Renamed');
    expect(r.body.collection.is_public).toBe(false);
    expect(r.body.collection.settings).toEqual({ sortBy: 'price' });
    // description was not sent, so it survives.
    expect(r.body.collection.description).toBe('The good stuff');
  });

  it('archives a deleted collection into deleted_items, with its cards', async () => {
    const cardsBefore = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM collection_cards WHERE collection_id = $1', [collectionId]);
    expect(cardsBefore.rows[0].n).toBeGreaterThan(0);

    const r = await alice.delete(`/api/collections/${collectionId}`);
    expect(r.status).toBe(200);

    expect((await ctx.pool.query('SELECT 1 FROM collections WHERE id = $1', [collectionId])).rowCount).toBe(0);
    expect((await ctx.pool.query('SELECT 1 FROM collection_cards WHERE collection_id = $1', [collectionId])).rowCount).toBe(0);

    const archived = await ctx.pool.query(`SELECT name, data FROM deleted_items WHERE item_type = 'collection' AND item_id = $1`, [collectionId]);
    expect(archived.rows[0].name).toBe('Renamed');
    const payload = JSON.parse(archived.rows[0].data);
    expect(payload.cards).toHaveLength(cardsBefore.rows[0].n);
    expect((await alice.delete(`/api/collections/${collectionId}`)).status).toBe(404);
  });
});
